//! Golden parity for the read-only argv flag policy.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).
//!
//! The corpus carries each case's inputs WITH its expected verdict, so this test never
//! re-declares a fixture: a second copy of the inputs could drift from the capture and the
//! test would still pass against a stale expectation.

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::argvpolicy::{is_argv_allowed_by_policy, policy_from_json};

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/argv-flag-policy-golden.json");
    path
}

#[test]
fn flag_policy_matches_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> =
        serde_json::from_str(&raw).expect("valid JSON");
    assert!(!corpus.is_empty(), "argv flag policy corpus is empty");

    let mut failures = Vec::new();
    let mut allowed = 0usize;
    for (name, entry) in &corpus {
        let expected = entry["allowed"].as_bool().expect("verdict is a boolean");
        let argv: Vec<String> = serde_json::from_value(entry["case"]["argv"].clone())
            .unwrap_or_else(|error| panic!("[{name}] argv: {error}"));
        let command_name = entry["case"]["commandName"]
            .as_str()
            .unwrap_or_else(|| panic!("[{name}] commandName"));
        let start_index = entry["case"]["startIndex"].as_u64().unwrap_or(1) as usize;
        let policy = policy_from_json(&entry["policy"])
            .unwrap_or_else(|| panic!("[{name}] policy could not be read"));

        let actual = is_argv_allowed_by_policy(&argv, &policy, command_name, start_index);
        if expected {
            allowed += 1;
        }
        if actual != expected {
            failures.push(format!("[{name}] rust={actual} ts={expected} argv={argv:?}"));
        }
    }
    assert!(failures.is_empty(), "flag policy diverged:\n{}", failures.join("\n"));
    // A corpus where everything is allowed, or everything rejected, would prove nothing.
    assert!(allowed > 0 && allowed < corpus.len(), "corpus is one-sided: {allowed} allowed");
}

/// The permissive direction is the dangerous one, so the write-flag cases are asserted by
/// name: if a future change opens one of these, the failure says which flag slipped.
#[test]
fn write_flags_stay_rejected() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    for name in [
        "git_log_unknown_flag_rejected",
        "git_log_unknown_flag_at_command",
        "git_log_none_flag_with_inline_value",
        "xargs_dangerous_target",
        "compact_count_not_declared",
        "kind_char_too_long",
    ] {
        let entry = corpus
            .get(name)
            .unwrap_or_else(|| panic!("corpus is missing {name}"));
        assert_eq!(
            entry["allowed"].as_bool(),
            Some(false),
            "{name} must stay rejected; the corpus says otherwise"
        );
    }
}
