//! Golden parity for the tool-result byte budget.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 4).
//!
//! The corpus is the cases that break a naive Rust translation: emoji (surrogate pairs), CJK
//! (3-byte code points), combining marks, and ZWJ sequences — plus byte budgets chosen to land
//! mid-code-point.

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::resultbudget::{fit_content_with_suffix, fit_string_to_bytes, Direction};

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/result-budget-golden.json");
    path
}

#[test]
fn byte_budget_matches_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    assert!(corpus.len() > 200, "budget corpus is unexpectedly small: {}", corpus.len());

    // Rebuild the same values the capture used, so the test owns the inputs explicitly.
    let values: [(&str, &str); 9] = [
        ("ascii", "abcdefghij"),
        ("emoji", "👋🏽👋🏽👋🏽👋🏽"),
        ("cjk", "日本語テキスト日本語テキスト日本語テキスト"),
        ("combining", "éééééé"),
        ("zwj_family", "👨‍👩‍👧👨‍👩‍👧"),
        ("mixed", "start 👋🏽 日本語テキスト é end"),
        ("empty", ""),
        ("single_ascii", "x"),
        ("long_ascii", &"a".repeat(500)),
    ];

    let mut failures = Vec::new();
    for (name, value) in values {
        for max_bytes in [0usize, 1, 2, 3, 4, 5, 8, 11, 16, 32, 64, 1000] {
            for direction in [("head", Direction::Head), ("tail", Direction::Tail)] {
                let key = format!("fit/{name}/{max_bytes}/{}", direction.0);
                let expected = corpus.get(&key).and_then(|v| v.as_str()).unwrap_or_else(|| panic!("missing {key}"));
                let actual = fit_string_to_bytes(value, max_bytes, direction.1);
                if actual != expected {
                    failures.push(format!("{key}: rust={actual:?} ts={expected:?}"));
                }
            }
        }
        for max_bytes in [0usize, 4, 12, 40, 200] {
            for direction in [("head", Direction::Head), ("tail", Direction::Tail)] {
                let key = format!("suffix/{name}/{max_bytes}/{}", direction.0);
                let expected = corpus.get(&key).and_then(|v| v.as_str()).unwrap_or_else(|| panic!("missing {key}"));
                let actual = fit_content_with_suffix(value, max_bytes, "\n\n[truncated]", direction.1);
                if actual != expected {
                    failures.push(format!("{key}: rust={actual:?} ts={expected:?}"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "byte budget diverged:\n{}", failures.join("\n"));
}

/// The properties that make the budget correct, stated directly so a regression names itself.
#[test]
fn the_budget_never_splits_a_code_point_and_never_exceeds() {
    let emoji = "👋🏽"; // 11 UTF-8 bytes, 4 code points
    for max_bytes in 0..40usize {
        for direction in [Direction::Head, Direction::Tail] {
            let fitted = fit_string_to_bytes(emoji, max_bytes, direction);
            assert!(
                fitted.len() <= max_bytes,
                "{direction:?} produced {fitted:?} ({} bytes) over budget {max_bytes}",
                fitted.len()
            );
            // Fitting an already-fitted value is idempotent: it fits, so it comes back
            // unchanged. This is what proves no code point was cut in half — a split
            // code point would be invalid UTF-8 and would not round-trip.
            assert_eq!(
                fit_string_to_bytes(&fitted, max_bytes, direction),
                fitted,
                "not idempotent at {max_bytes} ({direction:?})"
            );
        }
    }
    // A budget that lands mid-sequence keeps the WHOLE leading code points or none of them.
    // `emoji` is 8 UTF-8 bytes: U+1F44B (4) + U+1F3FD (4).
    assert_eq!(emoji.len(), 8, "the fixture's byte length is load-bearing for these cases");
    assert_eq!(fit_string_to_bytes(emoji, 1, Direction::Head), "");
    assert_eq!(fit_string_to_bytes(emoji, 3, Direction::Head), "");
    // 4 is exactly the first code point's width, so it survives whole.
    assert_eq!(fit_string_to_bytes(emoji, 4, Direction::Head), "\u{1F44B}");
    // 5..8 cannot hold the second code point, so it is dropped entirely rather than split.
    assert_eq!(fit_string_to_bytes(emoji, 5, Direction::Head), "\u{1F44B}");
    assert_eq!(fit_string_to_bytes(emoji, 7, Direction::Head), "\u{1F44B}");
    assert_eq!(fit_string_to_bytes(emoji, 8, Direction::Head), emoji);
    // The tail keeps the last code point instead.
    assert_eq!(fit_string_to_bytes(emoji, 4, Direction::Tail), "\u{1F3FD}");
}

/// The truncation notice is reserved first, so it survives even a tiny budget.
#[test]
fn the_suffix_is_never_truncated_away() {
    let content = "some tool output that is long";
    let suffix = "\n\n[truncated]";
    for max_bytes in [suffix.len(), suffix.len() + 1, suffix.len() + 5] {
        let fitted = fit_content_with_suffix(content, max_bytes, suffix, Direction::Head);
        assert!(fitted.ends_with(suffix) || fitted == suffix, "suffix lost at {max_bytes}: {fitted:?}");
        assert!(fitted.len() <= max_bytes, "over budget at {max_bytes}: {fitted:?}");
    }
}
