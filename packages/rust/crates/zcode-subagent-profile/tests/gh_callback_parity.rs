//! Golden parity for the `gh` danger callback.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::callbacks::gh_command_is_dangerous;

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/gh-callback-golden.json");
    path
}

#[test]
fn gh_callback_matches_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    assert!(!corpus.is_empty(), "gh golden corpus is empty");

    let mut failures = Vec::new();
    let mut dangerous = 0usize;
    for (name, entry) in &corpus {
        let expected = entry["dangerous"].as_bool().expect("verdict");
        let args: Vec<String> = serde_json::from_value(entry["args"].clone()).expect("args");
        let actual = gh_command_is_dangerous(&args);
        if expected { dangerous += 1; }
        if actual != expected {
            failures.push(format!("[{name}] rust={actual} ts={expected} args={args:?}"));
        }
    }
    assert!(failures.is_empty(), "gh callback diverged:\n{}", failures.join("\n"));
    assert!(dangerous > 0 && dangerous < corpus.len(), "corpus is one-sided: {dangerous}");
}

/// The vectors that matter, and the near-misses that must stay clean.
#[test]
fn gh_targets_and_near_misses() {
    let args = |words: &[&str]| -> Vec<String> { words.iter().map(|w| w.to_string()).collect() };
    // Reaching another host.
    assert!(gh_command_is_dangerous(&args(&["user@evil.example.com"])));
    assert!(gh_command_is_dangerous(&args(&["--repo=https://evil"])));
    // `owner/repo/…` is a target; a single slash is not.
    assert!(gh_command_is_dangerous(&args(&["a/b/c"])));
    assert!(!gh_command_is_dangerous(&args(&["cli/cli"])));
    assert!(!gh_command_is_dangerous(&args(&["status"])));
    // A bare flag is not a target.
    assert!(!gh_command_is_dangerous(&args(&["--json"])));
    assert!(!gh_command_is_dangerous(&args(&["auth", "status"])));
}
