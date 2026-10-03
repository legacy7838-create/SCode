//! Golden parity for the read-only policy evaluator.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).
//!
//! The corpus carries a THREE-way verdict (read-only / not / no-opinion) because collapsing
//! `None` into either `true` or `false` is a real behavioural change: `None` is how a command
//! says "I have no opinion", and the caller keeps evaluating the rest of the line.

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::readonlypolicy::{evaluate_bash_readonly_policy, Invocation, Redirect};

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/readonly-policy-golden.json");
    path
}

fn build(case: &Value) -> Invocation {
    Invocation {
        argv: case["argv"].as_array().expect("argv")
            .iter().filter_map(|v| v.as_str()).map(str::to_string).collect(),
        command_text: case["commandText"].as_str().unwrap_or("").to_string(),
        env_assignments: case["envAssignments"].as_array().map(|items| {
            items.iter().map(|item| item.get("name").and_then(|n| n.as_str()).map(str::to_string)).collect()
        }).unwrap_or_default(),
        redirects: case["redirects"].as_array().map(|items| {
            items.iter().map(|item| Redirect {
                operator: item["operator"].as_str().unwrap_or("").to_string(),
                target: item["target"].as_str().unwrap_or("").to_string(),
            }).collect()
        }).unwrap_or_default(),
    }
}

#[test]
fn readonly_policy_matches_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    let cases = corpus["cases"].as_array().expect("cases array");
    let verdicts = &corpus["verdicts"];

    let mut failures = Vec::new();
    let (mut yes, mut no, mut none) = (0usize, 0usize, 0usize);
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let expected = verdicts[name].as_bool(); // `null` reads as None
        let actual = evaluate_bash_readonly_policy(&build(&case["input"]));
        match expected {
            Some(true) => yes += 1,
            Some(false) => no += 1,
            None => none += 1,
        }
        if actual != expected {
            failures.push(format!("[{name}] rust={actual:?} ts={expected:?}"));
        }
    }
    assert!(failures.is_empty(), "read-only policy diverged:\n{}", failures.join("\n"));
    // The three-way contract needs all three present to be a real test.
    assert!(yes > 0 && no > 0 && none > 0, "corpus is one-sided: {yes}/{no}/{none}");
}

/// The vectors that decide permission, asserted by intent.
#[test]
fn the_decision_boundary_holds() {
    let inv = |argv: &[&str]| -> Invocation {
        Invocation { argv: argv.iter().map(|w| w.to_string()).collect(),
            command_text: argv.join(" "), env_assignments: vec![], redirects: vec![] }
    };
    // Reads.
    assert_eq!(evaluate_bash_readonly_policy(&inv(&["git", "status"])), Some(true));
    assert_eq!(evaluate_bash_readonly_policy(&inv(&["cat", "f"])), Some(true));
    assert_eq!(evaluate_bash_readonly_policy(&inv(&["gh", "auth", "status"])), Some(true));
    // Writes.
    assert_eq!(evaluate_bash_readonly_policy(&inv(&["git", "push"])), Some(false));
    assert_eq!(evaluate_bash_readonly_policy(&inv(&["git", "commit", "-m", "x"])), Some(false));
    assert_eq!(evaluate_bash_readonly_policy(&inv(&["find", ".", "-delete"])), Some(false));
    // `gh auth login` is on no read-only list: no opinion, not a denial.
    assert_eq!(evaluate_bash_readonly_policy(&inv(&["gh", "auth", "login"])), None);
    assert_eq!(evaluate_bash_readonly_policy(&inv(&["zzz-unknown"])), None);
    // An empty argv is a definite no.
    assert_eq!(evaluate_bash_readonly_policy(&inv(&[])), Some(false));
    // A dangerous git global option is a definite no.
    assert_eq!(evaluate_bash_readonly_policy(&inv(&["git", "-c", "core.pager=sh", "log"])), Some(false));
}
