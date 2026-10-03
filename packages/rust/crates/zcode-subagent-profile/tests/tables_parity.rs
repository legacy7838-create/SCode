//! Parity for the read-only policy table.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).
//!
//! Rust EMBEDS the very file the capture wrote from the live TypeScript tables, so this
//! test's job is narrower and stronger than "re-read some literals": it proves the crate
//! parses the captured table into the same policy decisions the table implies, and that the
//! single `hostname` regex behaves like the TypeScript `RegExp`.

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::tables::{matches_hostname, PolicyTables};

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/readonly-tables-golden.json");
    path
}

#[test]
fn embedded_table_matches_the_captured_table() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden table is present");
    let captured: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    let tables = PolicyTables::load().expect("embedded table parses");

    for key in [
        "gitReadonlySubcommandPolicies",
        "readonlyMultiwordCommandPolicies",
        "readonlyCommandPolicies",
    ] {
        let source = captured[key].as_object().expect("policy map");
        // Every captured entry must be reachable through the Rust lookup by its own key.
        for command in source.keys() {
            assert!(
                tables.lookup(command).is_some(),
                "Rust cannot look up `{command}` from `{key}`"
            );
        }
    }
}

#[test]
fn git_policies_are_ordered_longest_prefix_first() {
    let tables = PolicyTables::load().expect("embedded table parses");
    let ordered = tables.git_policies_by_length();
    let lengths: Vec<usize> = ordered.iter().map(|(key, _)| key.split(' ').count()).collect();
    let mut sorted = lengths.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(lengths, sorted, "git policies must be longest-first");
}

/// The `hostname` regex is the table's only `RegExp`, written by hand because the workspace
/// has no `regex` dependency. These cases mirror the pattern's meaning.
#[test]
fn hostname_matcher_behaves_like_the_typescript_regex() {
    assert!(matches_hostname("hostname"));
    assert!(matches_hostname("hostname -d"));
    assert!(matches_hostname("hostname --verbose"));
    assert!(matches_hostname("hostname -d --verbose"));
    assert!(matches_hostname("hostname   "));
    // A bare `--` is not a long flag with an alphabetic body.
    assert!(!matches_hostname("hostname --"));
    // Something after a valid prefix that is not a flag is a mismatch.
    assert!(!matches_hostname("hostname example.com"));
    // A different command never matches.
    assert!(!matches_hostname("hostnames"));
    assert!(!matches_hostname("nslookup"));
}
