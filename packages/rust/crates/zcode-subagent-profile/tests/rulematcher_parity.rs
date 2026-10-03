//! Golden parity for the bash permission rule matcher.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::rulematcher::{evaluate_bash_rules, BashRuleEvaluationInput};

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/bash-rules-golden.json");
    path
}

fn str_lists(value: &Value) -> Vec<Vec<String>> {
    value
        .as_array()
        .expect("array of groups")
        .iter()
        .map(|group| {
            group
                .as_array()
                .expect("array of subjects")
                .iter()
                .map(|subject| subject.as_str().expect("subject string").to_string())
                .collect()
        })
        .collect()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("array of strings")
        .iter()
        .map(|item| item.as_str().expect("string").to_string())
        .collect()
}

#[test]
fn rule_matcher_matches_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    let cases = &corpus["cases"];
    let verdicts = &corpus["verdicts"];
    let entries = cases.as_array().expect("cases array");
    assert!(!entries.is_empty(), "bash rules corpus is empty");

    let mut failures = Vec::new();
    let mut accepted = 0usize;
    for case in entries {
        let name = case["name"].as_str().expect("case name");
        let expected = verdicts[name].as_bool().expect("verdict boolean");
        // `ruleContent ?? ""` — the original reads the fallback in every branch.
        let rules = case["rules"]
            .as_array()
            .expect("rules array")
            .iter()
            .map(|rule| rule.get("ruleContent").and_then(Value::as_str).unwrap_or("").to_string())
            .collect();

        let input = BashRuleEvaluationInput {
            all_subject_groups: str_lists(&case["allSubjectGroups"]),
            behavior: case["behavior"].as_str().expect("behavior").to_string(),
            exact_commands: strings(&case["exactCommands"]),
            required_subject_groups: str_lists(&case["requiredSubjectGroups"]),
            rules,
            safe: case["safe"].as_bool().expect("safe boolean"),
        };
        let actual = evaluate_bash_rules(&input);
        if expected {
            accepted += 1;
        }
        if actual != expected {
            failures.push(format!("[{name}] rust={actual} ts={expected}"));
        }
    }
    assert!(failures.is_empty(), "rule matcher diverged:\n{}", failures.join("\n"));
    // A corpus that is all-true or all-false would prove nothing about the branches.
    assert!(accepted > 0 && accepted < entries.len(), "corpus is one-sided: {accepted} true");
}

/// The wildcard grammar, asserted directly: `*` is the only metacharacter and `?` is not.
#[test]
fn wildcard_shape_is_anchored_and_star_only() {
    use zcode_subagent_profile::rulematcher::matches_invocation_rule;
    assert!(matches_invocation_rule("npm run build", Some("npm run *")));
    assert!(!matches_invocation_rule("npm publish", Some("npm run *")));
    // A rule with no `*` is an EXACT string, so `a?` matches `a?` and nothing else —
    // it is never a wildcard. Where it does matter is a pattern that also has a `*`:
    // the original escapes `?` before joining, so `a?*` means "a", then "?", then anything.
    assert!(matches_invocation_rule("a?", Some("a?")));
    assert!(!matches_invocation_rule("ab", Some("a?")));
    assert!(matches_invocation_rule("a?b", Some("a?*")));
    assert!(!matches_invocation_rule("axb", Some("a?*")));
    // `+` is escaped too.
    assert!(matches_invocation_rule("cat a+b.txt", Some("cat a+b.txt")));
    assert!(!matches_invocation_rule("cat axb.txt", Some("cat a+b.txt")));
    // Prefix rules stop at a word boundary.
    assert!(matches_invocation_rule("git status", Some("git:*")));
    assert!(!matches_invocation_rule("gitx status", Some("git:*")));
    // No content is a catch-all.
    assert!(matches_invocation_rule("anything", Some("")));
}
