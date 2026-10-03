//! Golden parity for the post-parse bash permission policy.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 4).
//!
//! The corpus holds analyses produced by the REAL grammar (`&&` chains, pipelines, redirects,
//! subshells, command substitution, unbalanced quotes), so it covers shapes a hand-written
//! fixture would miss. The grammar itself stays in TypeScript; this is everything after it.

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::gitruntimesafety::{
    is_bash_command_permission_safe, is_runtime_read_only_bash_command, is_silent_bash_command,
    Analysis, ParsedCommand,
};
use zcode_subagent_profile::readonlypolicy::Redirect;

fn golden_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/bash-semantics-golden.json");
    path
}

fn build_analysis(entry: &Value) -> Analysis {
    let strings = |key: &str| -> Vec<String> {
        entry[key].as_array().map(|items| {
            items.iter().filter_map(|v| v.as_str()).map(str::to_string).collect()
        }).unwrap_or_default()
    };
    let commands = entry["commands"].as_array().map(|items| {
        items
            .iter()
            .map(|item| ParsedCommand {
                name: item["name"].as_str().unwrap_or("").to_string(),
                argv: strings_from(&item["argv"]),
                command_text: item["commandText"].as_str().unwrap_or("").to_string(),
                env_assignments: item["envAssignments"]
                    .as_array()
                    .map(|assignments| {
                        // Entries are { name, value } objects, not strings.
                        assignments
                            .iter()
                            .map(|a| a.get("name").and_then(|n| n.as_str()).map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                redirects: item["redirects"]
                    .as_array()
                    .map(|redirects| {
                        redirects
                            .iter()
                            .map(|r| Redirect {
                                operator: r["operator"].as_str().unwrap_or("").to_string(),
                                target: r["target"].as_str().unwrap_or("").to_string(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                operator_before: item["operatorBefore"].as_str().map(str::to_string),
            })
            .collect::<Vec<_>>()
    }).unwrap_or_default();
    let _ = strings;
    Analysis {
        commands,
        has_parse_errors: entry["hasParseErrors"].as_bool().unwrap_or(false),
        has_redirects: entry["hasRedirects"].as_bool().unwrap_or(false),
        has_dynamic_words: entry["hasDynamicWords"].as_bool().unwrap_or(false),
        has_unsupported_syntax: entry["hasUnsupportedSyntax"].as_bool().unwrap_or(false),
    }
}

fn strings_from(value: &Value) -> Vec<String> {
    value.as_array().map(|items| {
        items.iter().filter_map(|v| v.as_str()).map(str::to_string).collect()
    }).unwrap_or_default()
}

#[test]
fn post_parse_policy_matches_typescript() {
    let raw = std::fs::read_to_string(golden_path()).expect("golden corpus is present");
    let corpus: serde_json::Map<String, Value> = serde_json::from_str(&raw).expect("valid JSON");
    assert!(!corpus.is_empty(), "bash semantics corpus is empty");

    let mut failures = Vec::new();
    let (mut safe, mut read_only) = (0usize, 0usize);
    for (name, entry) in &corpus {
        let analysis = build_analysis(entry);

        let expected_safe = entry["permissionSafe"].as_bool().expect("permissionSafe");
        let expected_read_only = entry["readOnly"].as_bool().expect("readOnly");
        let expected_silent = entry["silent"].as_bool().expect("silent");
        if expected_safe { safe += 1; }
        if expected_read_only { read_only += 1; }

        if is_bash_command_permission_safe(&analysis) != expected_safe {
            failures.push(format!("[{name}] permissionSafe: rust={} ts={expected_safe}",
                is_bash_command_permission_safe(&analysis)));
        }
        // No context here: the git-context gate only fires for a real working directory, and
        // the golden was captured without one (the same way the TypeScript helper is called).
        if is_runtime_read_only_bash_command(&analysis, None) != expected_read_only {
            failures.push(format!("[{name}] readOnly: rust={} ts={expected_read_only}",
                is_runtime_read_only_bash_command(&analysis, None)));
        }
        if is_silent_bash_command(&analysis) != expected_silent {
            failures.push(format!("[{name}] silent: rust={} ts={expected_silent}",
                is_silent_bash_command(&analysis)));
        }
    }
    assert!(failures.is_empty(), "post-parse policy diverged:\n{}", failures.join("\n"));
    // The corpus has to contain both outcomes, or it proves nothing.
    assert!(read_only > 0 && safe > 0, "corpus is one-sided: {safe} safe / {read_only} read-only");
}

/// The boundary that decides whether a whole line is read-only.
#[test]
fn the_line_level_boundary_holds() {
    let part = |name: &str, argv: &[&str]| -> ParsedCommand {
        ParsedCommand {
            name: name.to_string(),
            argv: argv.iter().map(|w| w.to_string()).collect(),
            command_text: argv.join(" "),
            ..Default::default()
        }
    };
    let line = |commands: Vec<ParsedCommand>| -> Analysis {
        Analysis { commands, ..Default::default() }
    };

    // One read-only command.
    assert!(is_runtime_read_only_bash_command(&line(vec![part("ls", &["ls"])]), None));
    // A read chained with a write is not read-only.
    assert!(!is_runtime_read_only_bash_command(
        &line(vec![part("ls", &["ls"]), part("rm", &["rm", "-rf", "/"])]), None));
    // An unlisted command gives no opinion, and no opinion ends the line.
    assert!(!is_runtime_read_only_bash_command(&line(vec![part("zzz", &["zzz"])]), None));
    // An empty line is never read-only.
    assert!(!is_runtime_read_only_bash_command(&line(vec![]), None));
    // A parse error makes the whole analysis unusable.
    assert!(!is_runtime_read_only_bash_command(
        &Analysis { commands: vec![part("ls", &["ls"])], has_parse_errors: true, ..Default::default() },
        None));
    // `cd && git` is not read-only: git loads hooks from the target directory.
    assert!(!is_runtime_read_only_bash_command(
        &line(vec![part("git", &["git", "status"]), part("cd", &["cd", "/tmp"])]), None));
}
