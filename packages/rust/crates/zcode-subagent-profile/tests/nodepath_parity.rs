//! Golden parity for Node-compatible path joining.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 2). The corpus is Node's own output,
//! captured by `node` itself — not a hand-written expectation.

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::nodepath::{node_dirname, node_join};

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/nodepath-golden.json");
    path
}

fn corpus() -> serde_json::Map<String, Value> {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    serde_json::from_str(&raw).expect("golden corpus is valid JSON")
}

#[test]
fn join_matches_node() {
    let cases = corpus();
    let entries = cases["join"].as_array().expect("join cases");
    assert!(!entries.is_empty(), "join corpus is empty");

    let mut failures = Vec::new();
    for entry in entries {
        let input: Vec<&str> = entry["input"]
            .as_array()
            .expect("input array")
            .iter()
            .map(|v| v.as_str().expect("input segment is a string"))
            .collect();
        let expected = entry["output"].as_str().expect("output string");
        let actual = node_join(&input);
        if actual != expected {
            failures.push(format!("join({input:?}) = {actual:?}, node = {expected:?}"));
        }
    }
    assert!(failures.is_empty(), "path.join diverged:\n{}", failures.join("\n"));
}

#[test]
fn dirname_matches_node() {
    let cases = corpus();
    let entries = cases["dirname"].as_array().expect("dirname cases");

    let mut failures = Vec::new();
    for entry in entries {
        let input = entry["input"].as_str().expect("input string");
        let expected = entry["output"].as_str().expect("output string");
        let actual = node_dirname(input);
        if actual != expected {
            failures.push(format!("dirname({input:?}) = {actual:?}, node = {expected:?}"));
        }
    }
    assert!(failures.is_empty(), "path.dirname diverged:\n{}", failures.join("\n"));
}
