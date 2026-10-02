//! `zcode-task` channel — the task-list core backed by the task index.
//!
//! Replaces the task-list surface of `@zcode/server`'s `zcode-task`
//! channel. It serves the operations that are pure task-index reads/writes —
//! `listTaskList` (the task list the UI shows), pinned/archived listings,
//! unread clearing, pin toggling, and stale archival — directly against the
//! `zcode-task-index` crate on the same `tasks-index.sqlite` the scheduler owns.
//!
//! The session/grouping/agent operations (session snapshots, grouped-view
//! ordering, agent process control) are NOT served here: they belong to the
//! session runtime (rung 6) and return loud errors, never a canned answer. The
//! workspace identity rule is the shared one: `workspaceIdentity?.trim() ||
//! workspacePath`.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};
use zcode_task_index::task_read::{
    archive_stale_tasks, list_task_metas, query_task_list, ListQuery, TaskListQuery,
};
use zcode_task_index::task_write::{clear_task_unread_if_matches, update_task_state, StatePatch};

use crate::services::paths;

/// `getWorkspaceKey`: the identity rule. Applied here, outside the engine, so
/// two paths sharing an identity cannot produce two scopes.
fn workspace_key(workspace_path: &str, workspace_identity: Option<&str>) -> String {
    workspace_identity
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(workspace_path)
        .to_string()
}

fn task_index_db_path() -> PathBuf {
    paths::app_config_dir().join("tasks-index.sqlite")
}

pub struct ZCodeTaskService {
    conn: Mutex<rusqlite::Connection>,
}

impl ZCodeTaskService {
    pub fn new() -> Result<Self, String> {
        Self::new_with_path(task_index_db_path())
    }

    /// Open the task index at an explicit path (tests, or a relocated index).
    pub fn new_with_path(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE,
        )
        .map_err(|error| format!("cannot open task index: {error}"))?;
        conn.busy_timeout(std::time::Duration::from_millis(5_000))
            .map_err(|error| format!("cannot set task index busy timeout: {error}"))?;
        let _ = conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
        );
        // Self-initialise the schema (idempotent — migrations are ledgered), so a
        // fresh index works exactly as the TS `ensureReady` does. The scheduler's
        // own open is likewise idempotent.
        let migrations = zcode_task_index::schema::build_migrations(&conn)
            .map_err(|error| format!("cannot build task-index migrations: {error}"))?;
        zcode_task_index::migrate::run_migrations(&mut conn, &migrations, now_ms() as i64)
            .map_err(|error| format!("cannot run task-index migrations: {error}"))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn list_task_list(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let scopes = params
            .get("workspaceScopes")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| HandlerError::message("listTaskList requires `workspaceScopes`"))?;
        let mut workspace_keys = Vec::new();
        let mut workspace_purpose_by_key = Vec::new();
        for scope in scopes {
            let path = scope
                .get("workspacePath")
                .and_then(JsonValue::as_str)
                .ok_or_else(|| HandlerError::message("workspaceScope requires `workspacePath`"))?;
            let identity = scope.get("workspaceIdentity").and_then(JsonValue::as_str);
            let key = workspace_key(path, identity);
            if let Some(purpose) = scope.get("workspacePurpose").and_then(JsonValue::as_str) {
                workspace_purpose_by_key.push((key.clone(), purpose.to_string()));
            }
            workspace_keys.push(key);
        }
        let query = TaskListQuery {
            workspace_keys,
            search: params.get("search").and_then(JsonValue::as_str).map(str::to_string),
            kind: params.get("kind").and_then(JsonValue::as_str).map(str::to_string),
            provider: params.get("provider").and_then(JsonValue::as_str).map(str::to_string),
            limit: params.get("limit").and_then(JsonValue::as_i64),
            sort_by: params.get("sortBy").and_then(JsonValue::as_str).map(str::to_string),
            workspace_purpose_by_key,
        };
        let conn = self.conn.lock().unwrap();
        let result = query_task_list(&conn, &query).map_err(handler_error)?;
        Ok(serde_json::to_value(result).map_err(handler_error)?)
    }

    fn list_pinned(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let mut list_params = params.clone();
        if let Some(object) = list_params.as_object_mut() {
            object.insert("kind".into(), serde_json::json!("pinned"));
        }
        self.list_task_list(&list_params)
    }

    fn set_task_pinned(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let workspace_path = required_str(params, "workspacePath")?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let task_id = required_str(params, "taskId")?;
        let pinned = params
            .get("pinned")
            .and_then(JsonValue::as_bool)
            .ok_or_else(|| HandlerError::message("setTaskPinned requires a `pinned` boolean"))?;
        let now = now_ms();
        let key = workspace_key(workspace_path, identity);
        let mut conn = self.conn.lock().unwrap();
        let meta = update_task_state(
            &mut conn,
            &key,
            task_id,
            &StatePatch { pinned: Some(pinned), ..Default::default() },
            now as i64,
        )
        .map_err(handler_error)?;
        serde_json::to_value(meta).map_err(handler_error)
    }

    fn set_task_unread(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let workspace_path = required_str(params, "workspacePath")?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let task_id = required_str(params, "taskId")?;
        let key = workspace_key(workspace_path, identity);
        let mut conn = self.conn.lock().unwrap();
        let result = clear_task_unread_if_matches(&mut conn, &key, task_id, i64::MAX)
            .map_err(handler_error)?;
        serde_json::to_value(result).map_err(handler_error)
    }

    fn list_archived(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let workspace_path = required_str(params, "workspacePath")?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let key = workspace_key(workspace_path, identity);
        let conn = self.conn.lock().unwrap();
        let metas = list_task_metas(
            &conn,
            &ListQuery {
                workspace_key: Some(key),
                include_deleted: false,
                provider: None,
                pinned: None,
                archived: Some(true),
            },
        )
        .map_err(handler_error)?;
        serde_json::to_value(&metas).map_err(handler_error)
    }

    fn archive_stale(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let workspace_path = required_str(params, "workspacePath")?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let older_than_days = params
            .get("olderThanDays")
            .and_then(JsonValue::as_f64)
            .unwrap_or(1.0);
        // `Math.max(1, floor(days))`: a zero/negative span would archive
        // everything; the floor is a safety bound.
        let days = older_than_days.floor().max(1.0) as i64;
        let cutoff = now_ms() as i64 - days * 86_400_000;
        let key = workspace_key(workspace_path, identity);
        let mut conn = self.conn.lock().unwrap();
        let metas = archive_stale_tasks(&mut conn, &key, cutoff, None).map_err(handler_error)?;
        serde_json::to_value(&metas).map_err(handler_error)
    }
}

impl Default for ZCodeTaskService {
    fn default() -> Self {
        Self::new().expect("task index must open at construction")
    }
}

impl ChannelHandler for ZCodeTaskService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        let params = args.first().cloned().unwrap_or(JsonValue::Null);
        match method {
            "listTaskList" => self.list_task_list(&params),
            "listPinnedTasks" => self.list_pinned(&params),
            "setTaskPinned" => self.set_task_pinned(&params),
            "setTaskUnread" => self.set_task_unread(&params),
            "listArchivedTasks" => self.list_archived(&params),
            "archiveStaleTasks" => self.archive_stale(&params),
            other => Err(HandlerError::message(format!(
                "zcode-task.{other} (session snapshot / grouped view / agent process) is not yet \
                 ported to the Rust host; it belongs to the session runtime"
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

fn required_str<'a>(params: &'a JsonValue, field: &str) -> Result<&'a str, HandlerError> {
    params
        .get(field)
        .and_then(JsonValue::as_str)
        .ok_or_else(|| HandlerError::message(format!("missing required `{field}`")))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn handler_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::message(error.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zcode-taskidx-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("tasks-index.sqlite")
    }

    fn seed_task(conn: &mut rusqlite::Connection, key: &str, task_id: &str) {
        conn.execute(
            "INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, mode,
                created_at, updated_at, last_unread_at, meta_json, searchable_text)
             VALUES (?1, ?2, ?3, ?3, 'completed', 'build', 1, 1, 0, '{}', ?3)",
            rusqlite::params![key, "/ws", task_id],
        )
        .expect("seed task");
    }

    #[test]
    fn a_seeded_task_is_listed_and_pinnable() {
        let db = temp_db("list");
        let service = ZCodeTaskService::new_with_path(db.clone()).expect("open");
        {
            let mut conn = service.conn.lock().unwrap();
            seed_task(&mut conn, "/ws", "task-a");
        }

        let list = service
            .list_task_list(&serde_json::json!({
                "kind": "recent",
                "workspaceScopes": [{ "workspacePath": "/ws" }],
                "sortBy": "updated"
            }))
            .expect("list");
        assert_eq!(list["total"], serde_json::json!(1), "one task: {list}");
        assert_eq!(list["items"][0]["taskId"], serde_json::json!("task-a"));

        // Pin it and verify the pinned listing now sees it.
        service
            .set_task_pinned(&serde_json::json!({
                "workspacePath": "/ws",
                "taskId": "task-a",
                "pinned": true
            }))
            .expect("pin");
        let pinned = service.list_pinned(&serde_json::json!({
            "kind": "pinned",
            "workspaceScopes": [{ "workspacePath": "/ws" }],
            "sortBy": "updated"
        }))
        .expect("pinned list");
        assert_eq!(pinned["total"], serde_json::json!(1), "pinned: {pinned}");

        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn an_empty_scope_list_is_an_empty_result_not_an_error() {
        let db = temp_db("empty");
        let service = ZCodeTaskService::new_with_path(db.clone()).expect("open");
        let list = service
            .list_task_list(&serde_json::json!({
                "kind": "recent",
                "workspaceScopes": [],
                "sortBy": "updated"
            }))
            .expect("empty list");
        assert_eq!(list["total"], serde_json::json!(0));
        let _ = std::fs::remove_file(&db);
    }
}
