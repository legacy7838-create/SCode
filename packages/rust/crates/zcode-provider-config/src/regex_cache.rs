//! Compiled-regex memoisation for the two pattern-matching paths.
//!
//! `valid_pattern` (schema validation) and `matches_rule` (rule resolution)
//! both build `^(?:{pattern})$` from scratch on every call — the builtin
//! release carries 209 `modelMatch` patterns and every registry resolve walks
//! ~479 rules, so a fresh `Regex::new` per rule costs milliseconds per decode
//! and per refresh. The TypeScript reference builds a `RegExp` per call too,
//! but V8's compile is an order of magnitude cheaper than the `regex` crate's,
//! so without this cache the native decode measured *slower* than the zod one
//! (spec: docs/specs/rust-native-provider-node.md §7.1).
//!
//! Memoising a pure function changes no observable output — the same judgement
//! `compiler.ts` made when it kept `programCache` for CEL. The cache is keyed
//! by `(pattern, case-insensitive)` and bounded: past the bound a compile
//! still happens, it is just not retained (correctness never depends on a hit).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;

const MAX_CACHED_PATTERNS: usize = 8_192;

type PatternCache = Mutex<HashMap<(bool, String), Option<Arc<Regex>>>>;

/// The compiled form of `^(?:{pattern})$`, or `None` when the pattern is
/// invalid. The same entry serves schema validation and rule resolution.
pub fn compiled(pattern: &str, ignore_case: bool) -> Option<Arc<Regex>> {
    static CACHE: OnceLock<PatternCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (ignore_case, pattern.to_string());
    // One lock across the build: a pattern is compiled once for the process,
    // and holding the lock for a compile keeps the double-checked variant's
    // duplicate work out of the hot path.
    let mut guard = cache.lock().unwrap();
    if let Some(hit) = guard.get(&key) {
        return hit.clone();
    }
    let built = build(pattern, ignore_case).ok().map(Arc::new);
    if guard.len() < MAX_CACHED_PATTERNS {
        guard.insert(key, built.clone());
    }
    built
}

fn build(pattern: &str, ignore_case: bool) -> Result<Regex, regex::Error> {
    if ignore_case {
        regex::RegexBuilder::new(&format!("^(?:{pattern})$"))
            .case_insensitive(true)
            .build()
    } else {
        Regex::new(&format!("^(?:{pattern})$"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_pattern_compiles_once_and_matches_the_same_way() {
        assert!(compiled(".*glm-5.*", true).unwrap().is_match("GLM-5.1"));
        assert!(compiled(".*glm-5.*", true).unwrap().is_match("glm-5"));
        assert!(!compiled(".*glm-5.*", true).unwrap().is_match("gpt-4"));
        // Case sensitivity is part of the key: the non-CI entry must differ.
        assert!(!compiled(".*glm-5.*", false).unwrap().is_match("GLM-5"));
    }

    #[test]
    fn an_invalid_pattern_reports_none_and_stays_invalid() {
        assert!(compiled("(", false).is_none());
        assert!(compiled("(", false).is_none(), "the verdict is stable");
    }
}
