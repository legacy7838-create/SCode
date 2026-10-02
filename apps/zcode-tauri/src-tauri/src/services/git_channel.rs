//! `git` channel — repository read + write surface over the git binary.
//!
//! Replaces the `@zcode/server` `git` channel (`IGitService`). The TS service
//! runs the git CLI for every operation (writes via `git commit`/`push`/`add`,
//! reads via `git status`/`for-each-ref`/`log`); this port does the same through
//! `std::process::Command`, matching the command shapes and parsing the TS
//! `gitCliRepo` consumes. `generateCommitMessage` needs the agent (rung 6) and
//! returns a loud error, never a canned message.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

/// One `git` invocation. `cwd` is the repository root; `args` are passed
/// verbatim. Returns (stdout, stderr, exit_code).
fn run_git(cwd: &Path, args: &[&str]) -> Result<(String, String, i32), HandlerError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| HandlerError::message(format!("git {args:?} failed to spawn: {error}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let code = output.status.code().unwrap_or(-1);
    Ok((stdout, stderr, code))
}

/// Run a git command and require exit 0; stderr becomes the error message.
fn run_git_ok(cwd: &Path, args: &[&str]) -> Result<String, HandlerError> {
    let (stdout, stderr, code) = run_git(cwd, args)?;
    if code != 0 {
        return Err(HandlerError::message(format!(
            "git {args:?} failed (exit {code}): {}",
            stderr.trim()
        )));
    }
    Ok(stdout)
}

/// Resolve the repository root for a workspace path.
fn resolve_repo_root(workspace: &str) -> Result<PathBuf, HandlerError> {
    let dir = PathBuf::from(workspace);
    let stdout = run_git_ok(&dir, &["rev-parse", "--show-toplevel"])
        .map_err(|error| HandlerError::message(format!("{error}")))?;
    Ok(PathBuf::from(stdout.trim().to_string()))
}

/// Is git present and is this a repository?
fn is_repository(workspace: &str) -> bool {
    let dir = PathBuf::from(workspace);
    matches!(run_git(&dir, &["rev-parse", "--is-inside-work-tree"]), Ok((_, _, 0)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitIdentityView {
    user_name: Option<String>,
    user_email: Option<String>,
    name_source: Option<String>,
    email_source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitLocalBranchView {
    name: String,
    is_current: bool,
    upstream_name: Option<String>,
    commit_hash: Option<String>,
    commit_timestamp_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranchListResult {
    head_ref_type: String,
    current_branch_name: Option<String>,
    branches: Vec<GitLocalBranchView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitGraphEntry {
    commit_hash: String,
    parent_hashes: Vec<String>,
    author_name: String,
    committed_at_ms: u64,
    subject: String,
    refs: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitGraphResult {
    commits: Vec<GitCommitGraphEntry>,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileChangeView {
    path: String,
    repo_relative_path: String,
    workspace_relative_path: String,
    x: Option<String>,
    y: Option<String>,
    kind: String,
    section: String,
    added: i64,
    removed: i64,
    is_staged: bool,
    is_untracked: bool,
    is_conflicted: bool,
}

pub struct GitService;

impl GitService {
    pub fn new() -> Self {
        Self
    }

    fn config_get(root: &Path, key: &str) -> Option<String> {
        run_git(root, &["config", "--get", key])
            .ok()
            .and_then(|(out, _, code)| (code == 0).then(|| out.trim().to_string()))
            .filter(|value| !value.is_empty())
    }

    fn identity(root: &Path) -> GitIdentityView {
        let user_name = Self::config_get(root, "user.name");
        let user_email = Self::config_get(root, "user.email");
        GitIdentityView {
            name_source: user_name.as_ref().map(|_| "config".into()),
            email_source: user_email.as_ref().map(|_| "config".into()),
            user_name,
            user_email,
        }
    }

    /// `git status --porcelain=v2 -z` → GitFileChange[].
    ///
    /// Porcelain v2 `-z`: each entry is NUL-terminated; the header fields are
    /// space-separated and the pathname is the remainder (it may contain spaces,
    /// so the header is split off with a bounded `splitn`). Renames append the
    /// original path after a TAB inside the same NUL-terminated entry.
    fn status_changes(root: &Path, workspace: &Path) -> Result<Vec<GitFileChangeView>, HandlerError> {
        let (stdout, _, code) = run_git(root, &["status", "--porcelain=v2", "-z", "--untracked-files=all"])?;
        if code != 0 {
            return Err(HandlerError::message(format!("git status failed: {stdout}")));
        }
        let mut changes = Vec::new();
        for record in stdout.split('\0') {
            if record.is_empty() {
                continue;
            }
            let mut parts = record.splitn(2, ' ');
            let kind_char = parts.next().unwrap_or("").chars().next().unwrap_or(' ');
            let rest = parts.next().unwrap_or("");
            let (path, original, x, y, is_untracked, is_conflicted) = match kind_char {
                '?' => (rest.to_string(), None, None, None, true, false),
                '1' => {
                    let mut f = rest.splitn(8, ' ');
                    let xy = f.next().unwrap_or("").to_string();
                    // skip sub, mH, mI, mW, hH, hI
                    for _ in 0..5 {
                        f.next();
                    }
                    let path = f.next().unwrap_or("").to_string();
                    let x = xy.chars().next().map(|c| c.to_string());
                    let y = xy.chars().nth(1).map(|c| c.to_string());
                    (path, None, x, y, false, false)
                }
                '2' => {
                    let mut f = rest.splitn(9, ' ');
                    let xy = f.next().unwrap_or("").to_string();
                    for _ in 0..6 {
                        f.next();
                    }
                    let path_orig = f.next().unwrap_or("");
                    let mut pp = path_orig.splitn(2, '\t');
                    let path = pp.next().unwrap_or("").to_string();
                    let original = pp.next().map(str::to_string);
                    let x = xy.chars().next().map(|c| c.to_string());
                    let y = xy.chars().nth(1).map(|c| c.to_string());
                    (path, original, x, y, false, false)
                }
                'u' => {
                    let mut f = rest.splitn(9, ' ');
                    let xy = f.next().unwrap_or("").to_string();
                    for _ in 0..8 {
                        f.next();
                    }
                    let path = f.next().unwrap_or("").to_string();
                    let x = xy.chars().next().map(|c| c.to_string());
                    let y = xy.chars().nth(1).map(|c| c.to_string());
                    (path, None, x, y, false, true)
                }
                _ => continue,
            };
            let is_staged = x.as_deref().is_some_and(|c| c != "." && c != " ");
            let kind = if is_untracked {
                "added"
            } else if is_conflicted {
                "modified"
            } else if original.is_some() {
                "renamed"
            } else {
                match x.as_deref() {
                    Some("A") => "added",
                    Some("D") => "deleted",
                    Some("R") | Some("C") => "renamed",
                    _ => "modified",
                }
            }
            .to_string();
            changes.push(GitFileChangeView {
                path: workspace.join(&path).to_string_lossy().into_owned(),
                repo_relative_path: path.clone(),
                workspace_relative_path: workspace.join(&path).to_string_lossy().into_owned(),
                x,
                y,
                kind,
                section: if is_staged {
                    "staged"
                } else if is_untracked {
                    "untracked"
                } else {
                    "unstaged"
                }
                .to_string(),
                added: 0,
                removed: 0,
                is_staged,
                is_untracked,
                is_conflicted,
            });
        }
        Ok(changes)
    }

    fn head_ref_type(root: &Path) -> (String, Option<String>) {
        // Detached HEAD → "detached"; else a branch.
        let (head, _, code) = run_git(root, &["symbolic-ref", "--short", "-q", "HEAD"]).unwrap_or_default();
        if code == 0 {
            ("branch".into(), Some(head.trim().to_string()))
        } else {
            ("detached".into(), None)
        }
    }
}

impl Default for GitService {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelHandler for GitService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        let params = args.first().cloned().unwrap_or(JsonValue::Null);
        let workspace = params
            .get("workspacePath")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message(format!("git.{method} requires a `workspacePath`")))?;
        if !is_repository(workspace) {
            return Err(HandlerError::message(format!(
                "git.{method}: not a git repository (or git is unavailable): {workspace}"
            )));
        }
        let root = resolve_repo_root(workspace)?;

        match method {
            "getIdentity" => serde_json::to_value(Self::identity(&root)).map_err(handler_error),
            "getLocalBranches" => {
                let stdout = run_git_ok(&root, &[
                    "for-each-ref",
                    "refs/heads",
                    "--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)",
                ])?;
                let (head_ref_type, current) = Self::head_ref_type(&root);
                let mut branches = Vec::new();
                for line in stdout.lines() {
                    if line.is_empty() {
                        continue;
                    }
                    let mut parts = line.split('\0');
                    let name = parts.next().unwrap_or("").to_string();
                    let upstream = parts.next().unwrap_or("").to_string();
                    let hash = parts.next().unwrap_or("").to_string();
                    let ts = parts.next().unwrap_or("").parse::<u64>().ok();
                    branches.push(GitLocalBranchView {
                        is_current: current.as_deref() == Some(name.as_str()),
                        upstream_name: (!upstream.is_empty()).then_some(upstream),
                        commit_hash: (!hash.is_empty()).then_some(hash),
                        commit_timestamp_ms: ts.map(|s| s * 1000),
                        name,
                    });
                }
                serde_json::to_value(GitBranchListResult {
                    head_ref_type,
                    current_branch_name: current,
                    branches,
                })
                .map_err(handler_error)
            }
            "getCommitGraph" => {
                let max_count = params.get("maxCount").and_then(JsonValue::as_u64).unwrap_or(50) as i64;
                let skip = params.get("skip").and_then(JsonValue::as_u64).unwrap_or(0) as i64;
                let stdout = run_git(&root, &[
                    "log",
                    "HEAD",
                    "--branches",
                    "--tags",
                    "--remotes",
                    "--date-order",
                    "--topo-order",
                    &format!("--skip={skip}"),
                    &format!("--max-count={}", max_count + 1),
                    "--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D%x1e",
                ]);
                let (stdout, _, code) = stdout.unwrap_or_default();
                if code != 0 {
                    // No commits yet is a legitimate empty graph.
                    return Ok(serde_json::json!({ "commits": [], "hasMore": false }));
                }
                let mut commits = Vec::new();
                for record in stdout.split('\u{1e}') {
                    if record.trim().is_empty() {
                        continue;
                    }
                    let mut parts = record.split('\0');
                    let hash = parts.next().unwrap_or("").to_string();
                    let parents: Vec<String> = parts
                        .next()
                        .unwrap_or("")
                        .split_whitespace()
                        .map(str::to_string)
                        .collect();
                    let author = parts.next().unwrap_or("").to_string();
                    let at: u64 = parts.next().unwrap_or("0").parse().unwrap_or(0);
                    let subject = parts.next().unwrap_or("").to_string();
                    let refs_raw = parts.next().unwrap_or("");
                    let refs: Vec<String> = refs_raw
                        .split(", ")
                        .map(|r| r.trim().trim_start_matches("HEAD -> ").to_string())
                        .filter(|r| !r.is_empty())
                        .collect();
                    commits.push(GitCommitGraphEntry {
                        commit_hash: hash,
                        parent_hashes: parents,
                        author_name: author,
                        committed_at_ms: at * 1000,
                        subject,
                        refs,
                    });
                }
                let has_more = commits.len() as i64 > max_count;
                if has_more {
                    commits.truncate(max_count as usize);
                }
                serde_json::to_value(GitCommitGraphResult { commits, has_more })
                    .map_err(handler_error)
            }
            "getChanges" => {
                let changes = Self::status_changes(&root, Path::new(workspace))?;
                serde_json::to_value(&changes).map_err(handler_error)
            }
            "refresh" => {
                let (head_ref_type, current) = Self::head_ref_type(&root);
                let dirty = !Self::status_changes(&root, Path::new(workspace))?.is_empty();
                let summary = serde_json::json!({
                    "workspacePath": workspace,
                    "repoRoot": root.to_string_lossy(),
                    "branchName": current,
                    "headRefType": head_ref_type,
                    "isDirty": dirty,
                    "isGitAvailable": true,
                    "isRepository": true,
                });
                Ok(summary)
            }
            "getRepositorySummary" => {
                let (head_ref_type, current) = Self::head_ref_type(&root);
                let tracking = Self::config_get(&root, "branch.merge")
                    .map(|m| m.trim_start_matches("refs/heads/").to_string());
                let (ahead, behind) = match &tracking {
                    Some(t) => {
                        let out = run_git(&root, &["rev-list", "--left-right", "--count", &format!("HEAD...{t}")])
                            .unwrap_or_default();
                        let mut nums = out.0.split_whitespace();
                        let a = nums.next().unwrap_or("0").parse().unwrap_or(0);
                        let b = nums.next().unwrap_or("0").parse().unwrap_or(0);
                        (a, b)
                    }
                    None => (0, 0),
                };
                let dirty = !Self::status_changes(&root, Path::new(workspace))?.is_empty();
                serde_json::to_value(serde_json::json!({
                    "workspacePath": workspace,
                    "repoRoot": root.to_string_lossy(),
                    "workspaceInRepoPath": "",
                    "autoRefreshWatchPaths": [],
                    "branchName": current,
                    "trackingBranchName": tracking,
                    "headRefType": head_ref_type,
                    "ahead": ahead,
                    "behind": behind,
                    "isDirty": dirty,
                    "isGitAvailable": true,
                    "isRepository": true,
                }))
                .map_err(handler_error)
            }
            "stagePaths" => {
                let paths = str_array(&params, "paths")?;
                let mut argv = vec!["add", "--"];
                argv.extend(paths.iter().map(String::as_str));
                run_git_ok(&root, &argv)?;
                Ok(JsonValue::Null)
            }
            "unstagePaths" => {
                let paths = str_array(&params, "paths")?;
                let mut argv = vec!["restore", "--staged", "--"];
                argv.extend(paths.iter().map(String::as_str));
                run_git_ok(&root, &argv)?;
                Ok(JsonValue::Null)
            }
            "commit" => {
                let message = params
                    .get("message")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("git.commit requires a `message`"))?;
                run_git_ok(&root, &["commit", "-m", message])?;
                let hash = run_git_ok(&root, &["rev-parse", "HEAD"])?.trim().to_string();
                Ok(serde_json::json!({ "commitHash": hash }))
            }
            "push" => {
                let remote = params.get("remote").and_then(JsonValue::as_str).unwrap_or("origin");
                let branch = params
                    .get("branch")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string)
                    .or_else(|| Self::head_ref_type(&root).1);
                let target = branch.ok_or_else(|| HandlerError::message("git.push: no current branch"))?;
                run_git_ok(&root, &["push", remote, &target])?;
                Ok(serde_json::json!({ "ok": true }))
            }
            "switchBranch" => {
                let name = params
                    .get("branchName")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("git.switchBranch requires a `branchName`"))?;
                run_git_ok(&root, &["switch", "--no-guess", name])?;
                Ok(serde_json::json!({ "ok": true, "branchName": name, "didChange": true, "created": false }))
            }
            "createBranchAndSwitch" => {
                let name = params
                    .get("branchName")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("git.createBranchAndSwitch requires a `branchName`"))?;
                let start = params.get("startPoint").and_then(JsonValue::as_str);
                let mut argv = vec!["switch", "--no-guess", "-c", name];
                if let Some(start) = start {
                    argv.push("--");
                    argv.push(start);
                }
                run_git_ok(&root, &argv)?;
                Ok(serde_json::json!({ "ok": true, "branchName": name, "didChange": true, "created": true }))
            }
            "generateCommitMessage" => Err(HandlerError::message(
                "git.generateCommitMessage runs the agent to draft a commit message; \
                 that is not yet available on the native host",
            )),
            other => Err(HandlerError::message(format!(
                "git.{other} is not implemented by the Rust host"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        _event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        None
    }
}

fn str_array(params: &JsonValue, field: &str) -> Result<Vec<String>, HandlerError> {
    params
        .get(field)
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .ok_or_else(|| HandlerError::message(format!("git requires a `{field}` array")))
}

fn handler_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::message(error.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(name: &str) -> Option<PathBuf> {
        // git may be unavailable in some environments; skip then.
        if Command::new("git").arg("--version").output().is_err() {
            return None;
        }
        let dir = std::env::temp_dir().join(format!("zcode-git-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for args in [
            ["init", "-b", "main"],
            ["config", "user.name", "ZCoder"],
            ["config", "user.email", "z@example.com"],
        ] {
            run_git_ok(&dir, &args).expect("git setup");
        }
        Some(dir)
    }

    #[test]
    fn a_repository_round_trips_identity_branches_and_changes() {
        let Some(repo) = temp_repo("round") else { return };
        let service = GitService::new();
        let ctx = "";
        let ws = repo.to_string_lossy().into_owned();
        let params = serde_json::json!({ "workspacePath": ws });

        // Identity from git config.
        let identity = service
            .call(ctx, "getIdentity", &[params.clone()])
            .expect("identity");
        assert_eq!(identity["userName"], serde_json::json!("ZCoder"));

        // A dirty file shows up in getChanges.
        std::fs::write(repo.join("a.txt"), b"hello").unwrap();
        let changes = service.call(ctx, "getChanges", &[params.clone()]).expect("changes");
        assert_eq!(changes.as_array().map(Vec::len), Some(1), "one untracked change: {changes}");

        // Commit it, then the commit graph has one entry.
        run_git_ok(&repo, &["add", "--", "a.txt"]).expect("add");
        service
            .call(ctx, "commit", &[serde_json::json!({ "workspacePath": ws, "message": "init" })])
            .expect("commit");
        let graph = service.call(ctx, "getCommitGraph", &[params.clone()]).expect("graph");
        assert_eq!(graph["commits"].as_array().map(Vec::len), Some(1), "one commit: {graph}");
        assert_eq!(graph["commits"][0]["subject"], serde_json::json!("init"));

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_non_repository_is_a_loud_error() {
        let dir = std::env::temp_dir().join(format!("zcode-git-norepo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let service = GitService::new();
        let ws = dir.to_string_lossy().into_owned();
        let error = service
            .call("", "getIdentity", &[serde_json::json!({ "workspacePath": ws })])
            .expect_err("non-repository must error");
        assert!(format!("{error:?}").contains("not a git repository"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
