//! Golden parity for the remaining read-only danger callbacks.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::callbacks::*;

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/readonly-callbacks2-golden.json");
    path
}

fn evaluate(name: &str, args: &[String]) -> bool {
    match name {
        n if n.starts_with("man_") => man_command_is_dangerous(args),
        n if n.starts_with("tput_") => tput_command_is_dangerous(args),
        n if n.starts_with("ss_") => ss_command_is_dangerous(args),
        n if n.starts_with("xargs_") => xargs_command_is_dangerous(args),
        other => panic!("no callback for case {other}"),
    }
}

#[test]
fn remaining_callbacks_match_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    assert!(!corpus.is_empty(), "callbacks2 golden corpus is empty");

    let mut failures = Vec::new();
    for (name, entry) in &corpus {
        let expected = entry["dangerous"].as_bool().expect("verdict");
        let args: Vec<String> = serde_json::from_value(entry["args"].clone()).expect("args");
        let actual = evaluate(name, &args);
        if actual != expected {
            failures.push(format!("[{name}] rust={actual} ts={expected} args={args:?}"));
        }
    }
    assert!(failures.is_empty(), "callbacks diverged:\n{}", failures.join("\n"));
}

/// `ss -t tcp` is rejected by the original — `c` is in `a-f` and there is no `:`. That
/// bluntness is the behaviour, so it is asserted rather than quietly improved.
#[test]
fn ss_blunt_mask_rule_is_preserved() {
    assert!(ss_command_is_dangerous(&args(&["-t", "tcp"])));
    assert!(ss_command_is_dangerous(&args(&["dst", "0100007F"])));
    // A keyword, and its value, are both skipped.
    assert!(!ss_command_is_dangerous(&args(&["state", "listening"])));
}

fn args(words: &[&str]) -> Vec<String> {
    words.iter().map(|word| word.to_string()).collect()
}
