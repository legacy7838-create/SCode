//! Golden parity for the read-only command danger callbacks.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::callbacks::*;

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/readonly-callbacks-golden.json");
    path
}

/// Dispatch by the case-name prefix, the same way the policy table selects a callback.
fn evaluate(name: &str, args: &[String]) -> bool {
    match name {
        n if n.starts_with("sed_") => sed_command_is_dangerous(args),
        n if n.starts_with("jq_") => jq_command_is_dangerous(args),
        n if n.starts_with("date_") => date_command_is_dangerous(args),
        n if n.starts_with("lsof_") => lsof_command_is_dangerous(args),
        n if n.starts_with("ps_") => ps_command_is_dangerous(args),
        n if n.starts_with("pyright_") => pyright_command_is_dangerous(args),
        n if n.starts_with("test_") => test_command_is_dangerous(args),
        other => panic!("no callback for case {other}"),
    }
}

#[test]
fn callbacks_match_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    assert!(!corpus.is_empty(), "callbacks golden corpus is empty");

    let mut failures = Vec::new();
    let mut dangerous = 0usize;
    for (name, entry) in &corpus {
        let expected = entry["dangerous"].as_bool().expect("verdict is a boolean");
        let args: Vec<String> = serde_json::from_value(entry["args"].clone())
            .unwrap_or_else(|error| panic!("[{name}] args: {error}"));
        let actual = evaluate(name, &args);
        if expected {
            dangerous += 1;
        }
        if actual != expected {
            failures.push(format!("[{name}] rust={actual} ts={expected} args={args:?}"));
        }
    }
    assert!(failures.is_empty(), "callbacks diverged:\n{}", failures.join("\n"));
    assert!(dangerous > 0, "no dangerous cases: the corpus proves nothing");
}

/// The vectors that matter, asserted by name so a regression says which one opened.
#[test]
fn write_vectors_stay_closed() {
    // sed rewrites the file in place, or writes it with the `w` command.
    assert!(sed_command_is_dangerous(&args(&["-i", "s/a/b/", "f.txt"])));
    assert!(sed_command_is_dangerous(&args(&["s/a/b/; w out.txt", "f.txt"])));
    // `w` inside a word is not a write command.
    assert!(!sed_command_is_dangerous(&args(&["s/w/word/", "f.txt"])));
    // jq reaches a path or executes.
    assert!(jq_command_is_dangerous(&args(&["--rawfile", "x", "/etc/shadow"])));
    assert!(jq_command_is_dangerous(&args(&["$ENV.PATH"])));
    // `.environment` is not `env`.
    assert!(!jq_command_is_dangerous(&args(&[".environment"])));
    // date writes the file named by a non-`+` operand.
    assert!(date_command_is_dangerous(&args(&["/tmp/out.txt"])));
    assert!(!date_command_is_dangerous(&args(&["+%Y-%m-%d"])));
    // lsof reaches a remote host.
    assert!(lsof_command_is_dangerous(&args(&["-i@evil.example.com:22"])));
    assert!(!lsof_command_is_dangerous(&args(&["-i", ":80"])));
    // A command substitution as a numeric operand.
    assert!(test_command_is_dangerous(&args(&["5", "-gt", "$(rm -rf /)"])));
    assert!(!test_command_is_dangerous(&args(&["5", "-gt", "3"])));
}

fn args(words: &[&str]) -> Vec<String> {
    words.iter().map(|word| word.to_string()).collect()
}
