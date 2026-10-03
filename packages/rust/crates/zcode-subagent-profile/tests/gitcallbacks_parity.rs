//! Golden parity for the git subcommand danger callbacks.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::gitcallbacks::*;

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/git-callbacks-golden.json");
    path
}

fn evaluate(name: &str, args: &[String]) -> bool {
    match name {
        n if n.starts_with("revision_format_") => git_revision_format_command_is_dangerous(args),
        n if n.starts_with("reflog_") => git_reflog_command_is_dangerous(args),
        n if n.starts_with("ls_remote_") => git_ls_remote_command_is_dangerous(args),
        n if n.starts_with("remote_show_") => git_remote_show_command_is_dangerous(args),
        n if n.starts_with("tag_") => git_tag_command_is_dangerous(args),
        n if n.starts_with("branch_") => git_branch_command_is_dangerous(args),
        other => panic!("no callback for {other}"),
    }
}

#[test]
fn git_callbacks_match_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    assert!(!corpus.is_empty(), "git callbacks golden corpus is empty");

    let mut failures = Vec::new();
    let mut dangerous = 0usize;
    for (name, entry) in &corpus {
        let expected = entry["dangerous"].as_bool().expect("verdict");
        let args: Vec<String> = serde_json::from_value(entry["args"].clone()).expect("args");
        let actual = evaluate(name, &args);
        if expected { dangerous += 1; }
        if actual != expected {
            failures.push(format!("[{name}] rust={actual} ts={expected} args={args:?}"));
        }
    }
    assert!(failures.is_empty(), "git callbacks diverged:\n{}", failures.join("\n"));
    assert!(dangerous > 0 && dangerous < corpus.len(), "corpus is one-sided: {dangerous}");
}

/// The vectors that matter, asserted by name so a regression says which one opened.
#[test]
fn destructive_git_verbs_stay_closed() {
    let args = |words: &[&str]| -> Vec<String> { words.iter().map(|w| w.to_string()).collect() };
    // `git tag v1.0` without `--list` MOVES a tag.
    assert!(git_tag_command_is_dangerous(&args(&["v1.0"])));
    assert!(!git_tag_command_is_dangerous(&args(&["--list"])));
    // `git branch main` without a listing flag MOVES a branch.
    assert!(git_branch_command_is_dangerous(&args(&["main"])));
    assert!(!git_branch_command_is_dangerous(&args(&["--list"])));
    // `git reflog expire` destroys history.
    assert!(git_reflog_command_is_dangerous(&args(&["expire"])));
    assert!(!git_reflog_command_is_dangerous(&args(&["show", "HEAD"])));
    // `%G` runs a signature verification.
    assert!(git_revision_format_command_is_dangerous(&args(&["--format=%G", "HEAD"])));
    assert!(!git_revision_format_command_is_dangerous(&args(&["--format=%h %s", "HEAD"])));
    // `git ls-remote origin` reaches the network.
    assert!(git_ls_remote_command_is_dangerous(&args(&["origin"])));
    assert!(!git_ls_remote_command_is_dangerous(&args(&["--heads"])));
    // `git remote show` without `-n` can run `less`/exec.
    assert!(git_remote_show_command_is_dangerous(&args(&["origin"])));
    assert!(!git_remote_show_command_is_dangerous(&args(&["-n", "origin"])));
}
