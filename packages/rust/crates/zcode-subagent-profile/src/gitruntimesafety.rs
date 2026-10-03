//! Git runtime-context safety.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3), ported from
//! `tool/handlers/bash-git-runtime-safety.ts`.
//!
//! This answers "is the directory we are about to run git in safe?" by inspecting `.git`:
//! a symlinked `.git`, a `gitdir:` file pointing outside the workspace, a `.git` without
//! `objects/`+`refs/`, or a bare layout. Wrong here means git runs somewhere the policy did not
//! expect, so the fixtures are real directories rather than mocks.
//!
//! The filesystem access is the point of this living in Rust: the checks are `lstat` (not
//! `stat`, so a symlink is seen AS a symlink), a bounded read of `HEAD`, and an executability
//! probe on `objects/` and `refs/`.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitDirectoryState {
    None,
    Trusted,
    Unsafe,
}

/// `MAX_GITDIR_FILE_BYTES` — a `.git` FILE larger than this is not a gitdir pointer.
const MAX_GITDIR_FILE_BYTES: u64 = 32 * 1024;

/// `isGitRuntimeContextUnsafe`: true when the working directory must not be trusted for a
/// read-only git command.
pub fn is_git_runtime_context_unsafe(working_directory: Option<&str>) -> bool {
    let Some(cwd) = working_directory else {
        return false;
    };
    let Some(cwd_canonical) = canonical_path(Path::new(cwd)) else {
        // A path that cannot be resolved is not something to run git in.
        return true;
    };

    match classify_dot_git_directory(Path::new(cwd), &cwd_canonical) {
        GitDirectoryState::Trusted => return false,
        GitDirectoryState::Unsafe => return true,
        GitDirectoryState::None => {}
    }

    let mut current = PathBuf::from(cwd);
    loop {
        if has_bare_git_indicators(&current) {
            return true;
        }
        let Some(parent) = current.parent().map(Path::to_path_buf) else {
            return false;
        };
        if parent == current {
            return false;
        }
        match classify_dot_git_directory(&parent, &cwd_canonical) {
            GitDirectoryState::Trusted => return false,
            GitDirectoryState::Unsafe => return true,
            GitDirectoryState::None => {}
        }
        current = parent;
    }
}

fn classify_dot_git_directory(directory: &Path, cwd_canonical: &str) -> GitDirectoryState {
    let dot_git = directory.join(".git");
    let Ok(metadata) = std::fs::symlink_metadata(&dot_git) else {
        return GitDirectoryState::None;
    };
    let file_type = metadata.file_type();

    if file_type.is_symlink() {
        return match read_link_target(&dot_git, directory) {
            Some(target) => classify_git_dir_target(Path::new(&target), cwd_canonical),
            None => GitDirectoryState::Unsafe,
        };
    }

    if file_type.is_file() {
        if metadata.len() > MAX_GITDIR_FILE_BYTES {
            return GitDirectoryState::Unsafe;
        }
        let Ok(content) = std::fs::read_to_string(&dot_git) else {
            return GitDirectoryState::Unsafe;
        };
        if content.contains('\0') {
            return GitDirectoryState::Unsafe;
        }
        let Some(rest) = content.strip_prefix("gitdir: ") else {
            return GitDirectoryState::None;
        };
        let target_text = rest.trim_end_matches(['\r', '\n']);
        let target = if Path::new(target_text).is_absolute() {
            PathBuf::from(target_text)
        } else {
            directory.join(target_text)
        };
        return classify_git_dir_target(&target, cwd_canonical);
    }

    if file_type.is_dir() && has_trusted_git_directory(&dot_git) {
        return GitDirectoryState::Trusted;
    }
    GitDirectoryState::None
}

fn classify_git_dir_target(target: &Path, cwd_canonical: &str) -> GitDirectoryState {
    let Some(target_canonical) = canonical_path(target) else {
        return GitDirectoryState::Unsafe;
    };
    // A gitdir inside the workspace is the escape this check exists to catch.
    if path_is_same_or_inside(&target_canonical, cwd_canonical) {
        return GitDirectoryState::Unsafe;
    }
    if !path_has_git_segment(&target_canonical) {
        return GitDirectoryState::Unsafe;
    }
    if has_valid_git_head(Path::new(&target_canonical)) {
        GitDirectoryState::Trusted
    } else {
        GitDirectoryState::None
    }
}

fn read_link_target(path: &Path, directory: &Path) -> Option<PathBuf> {
    let target = std::fs::read_link(path).ok()?;
    Some(if target.is_absolute() { target } else { directory.join(target) })
}

fn has_trusted_git_directory(directory: &Path) -> bool {
    if !has_valid_git_head(directory) {
        return false;
    }
    for child in ["objects", "refs"] {
        let child_path = directory.join(child);
        let Ok(metadata) = std::fs::metadata(&child_path) else {
            return false;
        };
        if !metadata.is_dir() {
            return false;
        }
        // Executable, i.e. searchable — the check the original makes with `accessSync(X_OK)`.
        if !is_searchable(&child_path) {
            return false;
        }
    }
    // `commondir` means this is a linked worktree sharing another repository's object store.
    !directory.join("commondir").exists()
}

/// A directory is searchable when *some* execute bit is set. The original asks for `X_OK` on the
/// directory, which on a POSIX system means the same thing.
fn is_searchable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn has_valid_git_head(directory: &Path) -> bool {
    let head_path = directory.join("HEAD");
    let Ok(metadata) = std::fs::symlink_metadata(&head_path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() > 4096 {
        return false;
    }
    let Ok(head) = std::fs::read_to_string(&head_path) else {
        return false;
    };
    let head: String = head.chars().take(255).collect();
    if is_ref_head(&head) || is_object_id_head(&head) {
        return true;
    }
    false
}

/// `/^ref:[ \t]*refs\//`
fn is_ref_head(head: &str) -> bool {
    let Some(rest) = head.strip_prefix("ref:") else {
        return false;
    };
    let trimmed = rest.trim_start_matches([' ', '\t']);
    trimmed.starts_with("refs/")
}

/// `/^[0-9a-f]{40}([0-9a-f]{24})?[ \t\n\r]*$/`
fn is_object_id_head(head: &str) -> bool {
    let trimmed = head.trim_end_matches([' ', '\t', '\n', '\r']);
    let hex_len = trimmed.len();
    if hex_len != 40 && hex_len != 64 {
        return false;
    }
    trimmed.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn has_bare_git_indicators(directory: &Path) -> bool {
    let head_path = directory.join("HEAD");
    if let Ok(metadata) = std::fs::symlink_metadata(&head_path) {
        if metadata.is_file() || metadata.file_type().is_symlink() {
            return true;
        }
    }
    ["objects", "refs"]
        .iter()
        .any(|child| directory.join(child).exists())
}

fn canonical_path(path: &Path) -> Option<String> {
    let resolved = std::fs::canonicalize(path).ok()?;
    Some(normalize_canonical_path(&resolved))
}

/// `replace(/\\/g, "/").normalize("NFC").toLowerCase()`
fn normalize_canonical_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn path_is_same_or_inside(path: &str, base: &str) -> bool {
    let normalized_base = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
    path == base || path.starts_with(&normalized_base)
}

fn path_has_git_segment(path: &str) -> bool {
    path.split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .any(|segment| segment.to_lowercase() == ".git")
}

/// `analysisContainsGitCommand`
pub fn analysis_contains_git_command(names: &[Option<String>]) -> bool {
    names.iter().any(|name| name.as_deref() == Some("git"))
}

/// `analysisContainsGitAndDirectoryChange` — git loads hooks and config from the directory it
/// runs in, so `cd <dir> && git …` is not read-only even though `cd` is.
pub fn analysis_contains_git_and_directory_change(names: &[Option<String>]) -> bool {
    let has_git = names.iter().any(|name| name.as_deref() == Some("git"));
    let has_directory_change = names
        .iter()
        .any(|name| name.as_deref().is_some_and(|name| matches!(name, "cd" | "pushd" | "popd")));
    has_git && has_directory_change
}

/// `normalizedSimpleCommandName`: strip `command` / `builtin` / `noglob` to find the real name.
pub fn normalized_simple_command_name(argv: &[String]) -> Option<String> {
    let mut words = argv.to_vec();
    loop {
        match words.first().map(String::as_str) {
            Some("command") => {
                let mut index = 1usize;
                while words.get(index).is_some_and(|word| {
                    word.starts_with('-')
                        && word.len() > 1
                        && word[1..].bytes().all(|byte| byte == b'p')
                }) {
                    index += 1;
                }
                if words.get(index).map(String::as_str) == Some("--") {
                    index += 1;
                }
                match words.get(index) {
                    None => return words.first().cloned(),
                    Some(next) if next.starts_with('-') => return words.first().cloned(),
                    Some(_) => {
                        words = words[index..].to_vec();
                    }
                }
            }
            Some("builtin") => {
                let index = if words.get(1).map(String::as_str) == Some("--") { 2 } else { 1 };
                match words.get(index) {
                    None => return words.first().cloned(),
                    Some(_) => words = words[index..].to_vec(),
                }
            }
            Some("noglob") => {
                if words.len() <= 1 {
                    return words.first().cloned();
                }
                words = words[1..].to_vec();
            }
            _ => return words.first().cloned(),
        }
    }
}

// ============================================================
// Post-parse bash permission policy
// ============================================================

/// One parsed command, as the grammar produced it.
#[derive(Debug, Clone, Default)]
pub struct ParsedCommand {
    pub name: String,
    pub argv: Vec<String>,
    pub command_text: String,
    /// `None` is a name the grammar could not read, which the policy treats as unsafe.
    pub env_assignments: Vec<Option<String>>,
    pub redirects: Vec<crate::readonlypolicy::Redirect>,
    /// `&&` / `||` / `|` / `|&` / sequence.
    pub operator_before: Option<String>,
}

/// The grammar's findings about a whole command line.
#[derive(Debug, Clone, Default)]
pub struct Analysis {
    pub commands: Vec<ParsedCommand>,
    pub has_parse_errors: bool,
    pub has_redirects: bool,
    pub has_dynamic_words: bool,
    pub has_unsupported_syntax: bool,
}

/// `isBashCommandPermissionSafe`: dynamic words and unparsable syntax make an analysis
/// unusable, and an unusable analysis must never be treated as read-only.
pub fn is_bash_command_permission_safe(analysis: &Analysis) -> bool {
    !analysis.has_parse_errors && !analysis.has_unsupported_syntax && !analysis.has_dynamic_words
}

/// `isRuntimeReadOnlyBashCommand` — the top-level decision the permission flow asks.
///
/// EVERY command in the line must be read-only. A line that mixes a read with a write is not
/// read-only, which is why this returns false on the first non-read-only command rather than
/// tracking the best result.
pub fn is_runtime_read_only_bash_command(
    analysis: &Analysis,
    working_directory: Option<&str>,
) -> bool {
    if !is_bash_command_permission_safe(analysis) {
        return false;
    }
    if analysis.commands.is_empty() {
        return false;
    }

    // Git loads hooks and config from the directory it runs in, so `cd <dir> && git …` is not
    // read-only — and a git in an untrusted directory is not either.
    let unwrapped: Vec<Option<String>> = analysis
        .commands
        .iter()
        .map(|part| normalized_simple_command_name(&part.argv).or(Some(part.name.clone())))
        .collect();
    if analysis_contains_git_and_directory_change(&unwrapped) {
        return false;
    }
    if analysis_contains_git_command(&unwrapped)
        && crate::gitruntimesafety::is_git_runtime_context_unsafe(working_directory)
    {
        return false;
    }

    let mut has_read_only_command = false;
    for part in &analysis.commands {
        if crate::readonlypolicy::has_known_bash_write_option(&part.argv) {
            return false;
        }
        let verdict = crate::readonlypolicy::evaluate_bash_readonly_policy(&crate::readonlypolicy::Invocation {
            argv: part.argv.clone(),
            command_text: part.command_text.clone(),
            env_assignments: part.env_assignments.clone(),
            redirects: part.redirects.clone(),
        });
        match verdict {
            Some(true) => has_read_only_command = true,
            // `false` AND `None` both end the line: an unlisted command gives no opinion, and
            // a line with an unclassified command is not something to call read-only.
            Some(false) | None => return false,
        }
    }
    has_read_only_command
}

/// Commands that write state without producing output, so a line of only these is "silent".
/// Copied verbatim: this list was first written from a guess (`true`/`sleep`/`wait`), which
/// would have made the check wrong in both directions.
const BASH_SILENT_COMMANDS: &[&str] = &[
    "cd", "chgrp", "chmod", "chown", "cp", "export", "ln", "mkdir", "mv", "rm", "rmdir",
    "touch", "unset", "wait",
];

/// Commands that make a `||` branch irrelevant: `x || echo` is silent when `x` is silent.
const BASH_SEMANTIC_NEUTRAL_COMMANDS: [&str; 6] = ["", ":", "echo", "false", "printf", "true"];

/// `isSilentBashCommand`.
pub fn is_silent_bash_command(analysis: &Analysis) -> bool {
    if analysis.has_parse_errors || analysis.has_unsupported_syntax || analysis.has_dynamic_words {
        return false;
    }
    if analysis.commands.is_empty() {
        return false;
    }
    let mut has_non_fallback_command = false;
    for part in &analysis.commands {
        let name = normalized_simple_command_name(&part.argv).unwrap_or_else(|| part.name.clone());
        if name.is_empty() {
            continue;
        }
        if part.operator_before.as_deref() == Some("||")
            && BASH_SEMANTIC_NEUTRAL_COMMANDS.contains(&name.as_str())
        {
            continue;
        }
        has_non_fallback_command = true;
        if !BASH_SILENT_COMMANDS.contains(&name.as_str()) {
            return false;
        }
    }
    has_non_fallback_command
}
