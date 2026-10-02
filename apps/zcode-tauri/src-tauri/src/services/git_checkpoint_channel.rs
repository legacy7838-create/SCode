//! `git-checkpoint` channel — snapshot/restore checkpoints of the workspace.
//!
//! Replaces the `@zcode/server` `git-checkpoint` channel. A checkpoint is a
//! hidden git commit built with a temporary `GIT_INDEX_FILE` (so the user's
//! real index/staged state is untouched): `git add -A` → `write-tree` →
//! `commit-tree` → `update-ref refs/zcode/checkpoints/<id>`. Metadata lives
//! beside it under the app config dir. Matches the TS
//! `gitCheckpointRepo`/`gitCheckpointStore` command shapes.
//!
//! `restoreBetweenCheckpoints` (the three-way-merge restore) is not yet ported
//! and returns a loud error — it is intricate conflict-sensitive plumbing and a
//! wrong restore silently corrupts the worktree, so it is refused rather than
//! approximated.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

use crate::services::paths;

/// `refs/zcode/checkpoints/<id>` — the hidden ref anchoring a checkpoint.
fn ref_name(checkpoint_id: &str) -> String {
    format!("refs/zcode/checkpoints/{checkpoint_id}")
}

/// sha256(workspacePath) truncated to 12 — matches `getWorkspaceHash`.
fn workspace_hash(workspace_path: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(workspace_path.as_bytes());
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// `GitCheckpointMeta`, matching the shared wire shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCheckpointMeta {
    checkpoint_id: String,
    workspace_path: String,
    repo_root: String,
    workspace_in_repo_path: String,
    created_at: u64,
    ref_name: String,
    commit_oid: String,
    scope: String,
}

fn checkpoints_dir(workspace_path: &str) -> PathBuf {
    paths::app_config_dir()
        .join("checkpoints")
        .join(workspace_hash(workspace_path))
}

fn meta_path(workspace_path: &str, checkpoint_id: &str) -> PathBuf {
    checkpoints_dir(workspace_path).join(format!("{checkpoint_id}.json"))
}

fn save_meta(meta: &GitCheckpointMeta) -> Result<(), HandlerError> {
    let dir = checkpoints_dir(&meta.workspace_path);
    std::fs::create_dir_all(&dir)
        .map_err(|error| HandlerError::message(format!("cannot create checkpoint dir: {error}")))?;
    let path = meta_path(&meta.workspace_path, &meta.checkpoint_id);
    let bytes = serde_json::to_vec_pretty(meta).map_err(handler_error)?;
    zcode_private_file::atomic_write_private_text_file(
        &path,
        std::str::from_utf8(&bytes).map_err(handler_error)?,
    )
    .map_err(handler_error)
}

fn run_git(
    cwd: &Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<(String, String, i32), HandlerError> {
    let mut command = Command::new("git");
    command.args(args).current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0");
    for (key, value) in env {
        command.env(key, value);
    }
    let output = command
        .output()
        .map_err(|error| HandlerError::message(format!("git {args:?} failed to spawn: {error}")))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status.code().unwrap_or(-1),
    ))
}

fn run_git_ok(cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<String, HandlerError> {
    let (stdout, stderr, code) = run_git(cwd, args, env)?;
    if code != 0 {
        return Err(HandlerError::message(format!(
            "git {args:?} failed (exit {code}): {}",
            stderr.trim()
        )));
    }
    Ok(stdout)
}

fn resolve_repo_root(workspace: &str) -> Result<PathBuf, HandlerError> {
    let dir = PathBuf::from(workspace);
    let stdout = run_git_ok(&dir, &["rev-parse", "--show-toplevel"], &[])?;
    Ok(PathBuf::from(stdout.trim().to_string()))
}

pub struct GitCheckpointService;

impl GitCheckpointService {
    pub fn new() -> Self {
        Self
    }

    /// Build a checkpoint commit of the current workspace via a temp index.
    fn create(&self, workspace_path: &str, checkpoint_id: &str) -> Result<GitCheckpointMeta, HandlerError> {
        let root = resolve_repo_root(workspace_path)?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default();
        let temp_index_dir = std::env::temp_dir().join(format!(
            "zcode-checkpoint-{}-{now_ms}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp_index_dir)
            .map_err(|error| HandlerError::message(format!("cannot create temp index dir: {error}")))?;
        let temp_index = temp_index_dir.join("index");
        let temp_index_str = temp_index.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", temp_index_str.as_str())];

        let result = (|| -> Result<GitCheckpointMeta, HandlerError> {
            // Snapshot the whole workspace scope into the temp index.
            run_git_ok(&root, &["add", "-A", "--", "."], &env)?;
            let tree = run_git_ok(&root, &["write-tree"], &env)?.trim().to_string();
            let commit = run_git_ok(
                &root,
                &["commit-tree", &tree, "-m", &format!("zcode checkpoint {checkpoint_id}")],
                &[],
            )?
            .trim()
            .to_string();
            run_git_ok(&root, &["update-ref", &ref_name(checkpoint_id), &commit], &[])?;
            Ok(GitCheckpointMeta {
                checkpoint_id: checkpoint_id.to_string(),
                workspace_path: workspace_path.to_string(),
                repo_root: root.to_string_lossy().into_owned(),
                workspace_in_repo_path: String::new(),
                created_at: now_ms,
                ref_name: ref_name(checkpoint_id),
                commit_oid: commit,
                scope: "workspace".to_string(),
            })
        })();
        // The temp index serves only this build; clear it so it never leaks.
        let _ = std::fs::remove_dir_all(&temp_index_dir);
        let meta = result?;
        save_meta(&meta)?;
        Ok(meta)
    }

    fn diff(&self, from: &GitCheckpointMeta, to: &GitCheckpointMeta) -> Result<JsonValue, HandlerError> {
        let root = resolve_repo_root(&from.workspace_path)?;
        let range = format!("{}..{}", from.commit_oid, to.commit_oid);
        // name-status gives the change kind per path; numstat gives +/− counts.
        // Non-`-z` format: newline-terminated records, tab-separated fields. For a
        // rename the extra fields are the old and new paths ("R100\told\tnew").
        let name_status = run_git_ok(&root, &["diff", "--name-status", &range], &[])?;
        let numstat = run_git_ok(&root, &["diff", "--numstat", &range], &[])?;

        // numstat: "added\tremoved\tpath" (renames append a second path field).
        let mut stats: Vec<(String, i64, i64)> = Vec::new();
        for line in numstat.lines() {
            if line.is_empty() {
                continue;
            }
            let mut f = line.splitn(3, '\t');
            let added = f.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
            let removed = f.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
            let path_field = f.next().unwrap_or("");
            // For a rename the path field is "old\tnew"; the new path is last.
            let path = path_field.rsplit('\t').next().unwrap_or(path_field).to_string();
            stats.push((path, added, removed));
        }

        // name-status: "kind\t<path>[\t<old>]".
        let mut files = Vec::new();
        for line in name_status.lines() {
            if line.is_empty() {
                continue;
            }
            let mut f = line.split('\t');
            let kind_code = f.next().unwrap_or("");
            let fields: Vec<&str> = f.collect();
            // The new/current path is the last field; a rename adds an old path before it.
            let (path, original) = match fields.len() {
                0 => continue,
                1 => (fields[0].to_string(), None),
                _ => (
                    fields[fields.len() - 1].to_string(),
                    Some(fields[fields.len() - 2].to_string()),
                ),
            };
            let (added, removed) = stats
                .iter()
                .find(|(p, _, _)| p == &path)
                .map(|(_, a, r)| (*a, *r))
                .unwrap_or((0, 0));
            let kind = match kind_code.chars().next().unwrap_or('M') {
                'A' => "added",
                'D' => "deleted",
                'R' | 'C' => "renamed",
                _ => "modified",
            };
            files.push(serde_json::json!({
                "path": path,
                "repoRelativePath": path,
                "workspaceRelativePath": path,
                "originalPath": original,
                "kind": kind,
                "added": added,
                "removed": removed,
            }));
        }
        Ok(serde_json::json!({
            "fromCheckpointId": from.checkpoint_id,
            "toCheckpointId": to.checkpoint_id,
            "files": files,
        }))
    }

    fn delete(&self, meta: &GitCheckpointMeta) -> Result<(), HandlerError> {
        let root = resolve_repo_root(&meta.workspace_path)?;
        // Tolerate exit 1 (ref already gone) — deleting an absent ref is a no-op.
        let (_, _, code) = run_git(&root, &["update-ref", "-d", &meta.ref_name], &[])?;
        if code != 0 && code != 1 {
            return Err(HandlerError::message(format!(
                "git update-ref -d failed (exit {code})"
            )));
        }
        let path = meta_path(&meta.workspace_path, &meta.checkpoint_id);
        let _ = std::fs::remove_file(path);
        Ok(())
    }
}

impl Default for GitCheckpointService {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelHandler for GitCheckpointService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        let params = args.first().cloned().unwrap_or(JsonValue::Null);
        let workspace = params
            .get("workspacePath")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message(format!("git-checkpoint.{method} requires `workspacePath`")))?;

        match method {
            "createCheckpoint" => {
                let id = params
                    .get("checkpointId")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("createCheckpoint requires a `checkpointId`"))?;
                let meta = self.create(workspace, id)?;
                serde_json::to_value(&meta).map_err(handler_error)
            }
            "diffCheckpoints" => {
                let from = load_meta_from(&params, "from")?;
                let to = load_meta_from(&params, "to")?;
                self.diff(&from, &to)
            }
            "restoreBetweenCheckpoints" => Err(HandlerError::message(
                "git-checkpoint.restoreBetweenCheckpoints is the three-way-merge restore and is \
                 not yet ported to the Rust host; a wrong restore would silently corrupt the \
                 worktree, so it is refused rather than approximated",
            )),
            "deleteCheckpoint" => {
                let meta = load_meta_from(&params, "checkpoint")?;
                self.delete(&meta)?;
                Ok(JsonValue::Null)
            }
            other => Err(HandlerError::message(format!(
                "git-checkpoint.{other} is not implemented by the Rust host"
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

fn load_meta_from(params: &JsonValue, field: &str) -> Result<GitCheckpointMeta, HandlerError> {
    let value = params
        .get(field)
        .ok_or_else(|| HandlerError::message(format!("missing `{field}` object")))?;
    serde_json::from_value(value.clone()).map_err(handler_error)
}

fn handler_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::message(error.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(name: &str) -> Option<PathBuf> {
        if Command::new("git").arg("--version").output().is_err() {
            return None;
        }
        let dir = std::env::temp_dir().join(format!("zcode-gcp-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for args in [
            ["init", "-b", "main"],
            ["config", "user.name", "ZCoder"],
            ["config", "user.email", "z@example.com"],
        ] {
            run_git_ok(&dir, &args, &[]).expect("git setup");
        }
        std::fs::write(dir.join("a.txt"), b"one").unwrap();
        Some(dir)
    }

    #[test]
    fn checkpoints_are_created_diffed_and_deleted() {
        let Some(repo) = temp_repo("cp") else { return };
        let service = GitCheckpointService::new();
        let ws = repo.to_string_lossy().into_owned();

        // Checkpoint 1: a.txt exists.
        let m1: GitCheckpointMeta = serde_json::from_value(
            service
                .call("", "createCheckpoint", &[serde_json::json!({ "workspacePath": ws, "checkpointId": "c1" })])
                .expect("create c1"),
        )
        .unwrap();
        assert_eq!(m1.checkpoint_id, "c1");
        assert!(m1.ref_name.ends_with("/c1"));

        // Change the file, then checkpoint 2.
        std::fs::write(repo.join("a.txt"), b"two").unwrap();
        let m2: GitCheckpointMeta = serde_json::from_value(
            service
                .call("", "createCheckpoint", &[serde_json::json!({ "workspacePath": ws, "checkpointId": "c2" })])
                .expect("create c2"),
        )
        .unwrap();

        // Diff c1..c2 sees the modified file.
        let diff = service
            .call("", "diffCheckpoints", &[serde_json::json!({ "workspacePath": ws, "from": m1, "to": m2 })])
            .expect("diff");
        assert_eq!(diff["files"].as_array().map(Vec::len), Some(1), "one changed file: {diff}");
        assert_eq!(diff["files"][0]["repoRelativePath"], serde_json::json!("a.txt"));

        // Delete c2 removes the ref and metadata.
        service
            .call("", "deleteCheckpoint", &[serde_json::json!({ "workspacePath": ws, "checkpoint": m2 })])
            .expect("delete");
        let ref_gone = run_git(&repo, &["rev-parse", "--verify", "refs/zcode/checkpoints/c2"], &[])
            .map(|(_, _, code)| code);
        assert!(!matches!(ref_gone, Ok(0)), "ref c2 should be deleted");

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn restore_is_a_loud_error_not_a_silent_approximation() {
        let service = GitCheckpointService::new();
        let error = service
            .call("", "restoreBetweenCheckpoints", &[serde_json::json!({ "workspacePath": "/tmp", "from": {}, "to": {} })])
            .expect_err("restore must error");
        assert!(format!("{error:?}").contains("restore"));
    }
}
