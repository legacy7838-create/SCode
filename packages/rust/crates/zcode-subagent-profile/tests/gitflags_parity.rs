//! Golden parity for the git global-option safety gate.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::gitflags::has_dangerous_git_global_option;

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/git-global-flag-golden.json");
    path
}

#[test]
fn git_global_flag_gate_matches_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> =
        serde_json::from_str(&raw).expect("valid JSON");
    assert!(!corpus.is_empty(), "git global flag corpus is empty");

    let mut failures = Vec::new();
    let mut dangerous = 0usize;
    for (argv_json, expected) in &corpus {
        let argv: Vec<String> = serde_json::from_str(argv_json)
            .unwrap_or_else(|error| panic!("argv key {argv_json} is not an array: {error}"));
        let actual = has_dangerous_git_global_option(&argv);
        let expected = expected.as_bool().expect("expected is a boolean");
        if expected {
            dangerous += 1;
        }
        if actual != expected {
            failures.push(format!("{argv_json}: rust={actual} ts={expected}"));
        }
    }
    assert!(failures.is_empty(), "git global flag gate diverged:\n{}", failures.join("\n"));
    // A corpus where nothing is dangerous would make the test vacuous.
    assert!(dangerous > 0, "no dangerous cases in the corpus");
}

/// The `-c` / `-C` asymmetry: preserved deliberately, so it is asserted rather than left
/// to a future reader to "fix".
#[test]
fn short_flag_asymmetry_is_preserved() {
    let argv = |words: &[&str]| -> Vec<String> { words.iter().map(|w| w.to_string()).collect() };

    assert!(has_dangerous_git_global_option(&argv(&["git", "-C/tmp", "status"])));
    assert!(has_dangerous_git_global_option(&argv(&["git", "-cfoo=bar", "log"])));
    // `-C` does not inspect the following character...
    assert!(has_dangerous_git_global_option(&argv(&["git", "-C--x", "status"])));
    // ...while `-c` rejects another `-` after it.
    assert!(!has_dangerous_git_global_option(&argv(&["git", "-c--x", "log"])));
    // A short flag that is not in the dangerous set stays clean.
    assert!(!has_dangerous_git_global_option(&argv(&["git", "-fsomething", "log"])));
    // The `=` form is as dangerous as the spaced form.
    assert!(has_dangerous_git_global_option(&argv(&["git", "--exec-path=/tmp/evil", "log"])));
}
