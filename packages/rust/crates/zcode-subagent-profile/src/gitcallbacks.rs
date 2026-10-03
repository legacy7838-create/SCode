//! Git subcommand danger callbacks.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3), ported from
//! `tool/handlers/bash-readonly-policy-git-callbacks.ts`.
//!
//! These are the `additionalCommandIsDangerousCallback` values in the read-only git policy
//! table. They close the gap between "this subcommand is on the read-only list" and "these
//! particular arguments still do something": `git tag v1.0` (without `--list`) **moves or
//! deletes a tag**, `git reflog expire` destroys history, `git log --format=%G` runs a
//! signature check, `git ls-remote origin` reaches the network.

/// `gitRevisionFormatCommandIsDangerous`: `%G`, `%(-signature)` and friends run a signature
/// verification, which executes code from the repo's hooks/config.
pub fn git_revision_format_command_is_dangerous(args: &[String]) -> bool {
    for (index, arg) in args.iter().enumerate() {
        // `--format X`, `--format=X`, and the `--pretty` spelling all route here.
        let value: Option<&str> = match arg.find('=') {
            Some(at) => Some(&arg[at + 1..]),
            None => {
                if arg == "--format" || arg == "--pretty" {
                    args.get(index + 1).map(String::as_str)
                } else {
                    None
                }
            }
        };
        let Some(value) = value.filter(|value| !value.is_empty()) else {
            continue;
        };
        let is_format_flag = arg == "--format"
            || arg == "--pretty"
            || arg.starts_with("--format=")
            || arg.starts_with("--pretty=");
        if !is_format_flag {
            continue;
        }
        if format_runs_a_signature(value) {
            return true;
        }
    }
    false
}

/// `/%[-+ ]?G|%\(\*?signature/`
fn format_runs_a_signature(value: &str) -> bool {
    let bytes = value.as_bytes();
    for index in 0..bytes.len() {
        if bytes[index] != b'%' {
            continue;
        }
        let mut cursor = index + 1;
        // Optional `-`, `+` or space.
        if cursor < bytes.len() && matches!(bytes[cursor], b'-' | b'+' | b' ') {
            cursor += 1;
        }
        if cursor < bytes.len() && bytes[cursor] == b'G' {
            return true;
        }
        // `%(signature` or `%(*signature`
        if cursor < bytes.len() && bytes[cursor] == b'(' {
            cursor += 1;
            if cursor < bytes.len() && bytes[cursor] == b'*' {
                cursor += 1;
            }
            if value[cursor..].starts_with("signature") {
                return true;
            }
        }
    }
    false
}

/// `gitReflogCommandIsDangerous`: only `show` and `list` read; the rest rewrite history.
pub fn git_reflog_command_is_dangerous(args: &[String]) -> bool {
    const ALLOWED: [&str; 2] = ["show", "list"];
    const DANGEROUS: [&str; 5] = ["expire", "delete", "exists", "drop", "write"];
    let first_positional = args.iter().find(|arg| !arg.is_empty() && !arg.starts_with('-'));
    if let Some(first) = first_positional {
        if !ALLOWED.contains(&first.as_str()) {
            return true;
        }
    }
    args.iter().any(|arg| DANGEROUS.contains(&arg.as_str()))
}

/// `gitLsRemoteCommandIsDangerous`: any pattern argument makes it reach the remote.
pub fn git_ls_remote_command_is_dangerous(args: &[String]) -> bool {
    let mut after_double_dash = false;
    let mut index = 0usize;
    while index < args.len() {
        let arg = args.get(index).map(String::as_str).unwrap_or("");
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            index += 1;
            continue;
        }
        if !after_double_dash && (arg.starts_with('-') || arg.is_empty()) {
            if arg == "--sort" {
                index += 1;
            }
            index += 1;
            continue;
        }
        // A bare positional: the remote or a ref pattern. Reaching out is not read-only.
        return true;
    }
    false
}

/// `gitRemoteShowCommandIsDangerous`: exactly one ref, named `-n`, and a plain name.
pub fn git_remote_show_command_is_dangerous(args: &[String]) -> bool {
    let double_dash = args.iter().position(|arg| arg == "--");
    let option_args: Vec<&String> = match double_dash {
        Some(index) => args[..index].iter().collect(),
        None => args.iter().collect(),
    };
    let mut positional: Vec<&String> = match double_dash {
        Some(index) => args[index + 1..].iter().collect(),
        None => Vec::new(),
    };
    positional.extend(
        option_args
            .iter()
            .filter(|arg| arg.as_str() != "-n")
            .copied(),
    );

    if !option_args.iter().any(|arg| arg.as_str() == "-n") {
        return true;
    }
    if positional.len() != 1 {
        return true;
    }
    !is_plain_ref_name(positional[0])
}

/// `^[a-zA-Z0-9_][a-zA-Z0-9_-]*$`
fn is_plain_ref_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// `gitTagCommandIsDangerous`.
pub fn git_tag_command_is_dangerous(args: &[String]) -> bool {
    const VALUE_FLAGS: [&str; 8] = [
        "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort",
        "--format", "-n",
    ];
    git_list_like_command_is_dangerous(args, &VALUE_FLAGS)
}

/// `gitBranchCommandIsDangerous`.
pub fn git_branch_command_is_dangerous(args: &[String]) -> bool {
    const VALUE_FLAGS: [&str; 4] = ["--contains", "--no-contains", "--points-at", "--sort"];
    git_list_like_command_is_dangerous(args, &VALUE_FLAGS)
}

/// Shared shape for `git tag` and `git branch`: without a listing flag and without one of
/// `--merged`/`--no-merged`, a bare argument names something to modify.
fn git_list_like_command_is_dangerous(args: &[String], value_flags: &[&str]) -> bool {
    let mut has_list = false;
    let mut after_double_dash = false;
    let mut previous_flag = String::new();
    let mut index = 0usize;
    while index < args.len() {
        let arg = args.get(index).map(String::as_str).unwrap_or("");
        if arg.is_empty() {
            index += 1;
            continue;
        }
        if arg == "--" && !after_double_dash {
            after_double_dash = true;
            previous_flag.clear();
            index += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') {
            let is_list = arg == "--list"
                || arg == "-l"
                // A short cluster that contains `l`, e.g. `-al`.
                || (arg.starts_with('-')
                    && !arg.starts_with("--")
                    && arg[1..].contains('l'));
            if is_list {
                has_list = true;
            }
            previous_flag = match arg.find('=') {
                Some(at) => arg[..at].to_string(),
                None => arg.to_string(),
            };
            if !arg.contains('=') && value_flags.contains(&previous_flag.as_str()) {
                index += 1;
            }
            index += 1;
            continue;
        }
        if !has_list && previous_flag != "--merged" && previous_flag != "--no-merged" {
            return true;
        }
        index += 1;
    }
    false
}

/// `git remote`'s inline table callback: `-v` / `--verbose` only lists; anything else
/// (`add`, `remove`, `set-url`, `rename`) rewrites the configuration.
pub fn git_remote_command_is_dangerous(args: &[String]) -> bool {
    args.iter().any(|arg| arg != "-v" && arg != "--verbose")
}
