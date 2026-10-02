//! `off-peak-task` channel — the local off-peak task table.
//!
//! Replaces the `@zcode/server` `off-peak-task` channel. The off-peak task's
//! local lifecycle reads/writes the `off_peak_tasks` table via the
//! `zcode-task-index` crate. `get` and `delete` use the crate's `OffPeakStore`;
//! `list` reads the table for a workspace. The create/cancel/pause/continue/
//! update operations need the server ticket acquisition and the session
//! dispatch (the agent), so they return loud errors rather than faking a
//! dispatch that would silently strand a task.

use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};
use zcode_task_index::offpeak::{OffPeakRow, OffPeakStore};

use crate::services::paths;

/// One off-peak task, as the renderer sees it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OffPeakTaskView {
    off_peak_task_id: String,
    session_id: Option<String>,
    prompt: String,
    workspace_key: String,
    status: String,
    queued_at: i64,
    created_at: i64,
    updated_at: i64,
    model_selection: Option<String>,
}

impl From<OffPeakRow> for OffPeakTaskView {
    fn from(row: OffPeakRow) -> Self {
        Self {
            off_peak_task_id: row.off_peak_task_id,
            session_id: row.session_id,
            prompt: row.prompt,
            workspace_key: row.workspace_key,
            status: row.status,
            queued_at: row.queued_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
            model_selection: row.model_selection,
        }
    }
}

fn task_index_db_path() -> std::path::PathBuf {
    paths::app_config_dir().join("tasks-index.sqlite")
}

/// `getWorkspaceKey`: the identity rule.
fn workspace_key(workspace_path: &str, workspace_identity: Option<&str>) -> String {
    workspace_identity
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(workspace_path)
        .to_string()
}

pub struct OffPeakTaskService {
    conn: Mutex<rusqlite::Connection>,
}

impl OffPeakTaskService {
    pub fn new() -> Result<Self, String> {
        Self::new_with_path(task_index_db_path())
    }

    /// Open the task index at an explicit path (tests, or a relocated index).
    pub fn new_with_path(path: std::path::PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE,
        )
        .map_err(|error| format!("cannot open task index: {error}"))?;
        conn.busy_timeout(std::time::Duration::from_millis(5_000))
            .map_err(|error| format!("cannot set busy timeout: {error}"))?;
        let _ = conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
        // Self-initialise the schema (idempotent — migrations are ledgered).
        let migrations = zcode_task_index::schema::build_migrations(&conn)
            .map_err(|error| format!("cannot build migrations: {error}"))?;
        zcode_task_index::migrate::run_migrations(&mut conn, &migrations, now_ms() as i64)
            .map_err(|error| format!("cannot run migrations: {error}"))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn get_task(&self, id: &str) -> Result<JsonValue, HandlerError> {
        let conn = self.conn.lock().unwrap();
        let row = OffPeakStore::get(&conn, id).map_err(handler_error)?;
        match row {
            Some(row) => serde_json::to_value(OffPeakTaskView::from(row)).map_err(handler_error),
            None => Ok(JsonValue::Null),
        }
    }

    fn delete_task(&self, id: &str) -> Result<JsonValue, HandlerError> {
        let conn = self.conn.lock().unwrap();
        OffPeakStore::delete(&conn, id).map_err(handler_error)?;
        Ok(JsonValue::Null)
    }

    fn list_tasks(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let workspace_path = params
            .get("workspacePath")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("list requires a `workspacePath`"))?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let key = workspace_key(workspace_path, identity);
        let conn = self.conn.lock().unwrap();
        let mut statement = conn
            .prepare("SELECT * FROM off_peak_tasks WHERE workspace_key = ?1 ORDER BY created_at DESC")
            .map_err(handler_error)?;
        let rows = statement
            .query_map([&key], OffPeakRow::from_row)
            .map_err(handler_error)?;
        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(OffPeakTaskView::from(row.map_err(handler_error)?));
        }
        serde_json::to_value(&tasks).map_err(handler_error)
    }
}

impl Default for OffPeakTaskService {
    fn default() -> Self {
        Self::new().expect("task index must open at construction")
    }
}

impl ChannelHandler for OffPeakTaskService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        let params = args.first().cloned().unwrap_or(JsonValue::Null);
        match method {
            "list" => self.list_tasks(&params),
            "get" => {
                let id = required_str(&params, "offPeakTaskId")?;
                self.get_task(id)
            }
            "deleteTask" => {
                let id = required_str(&params, "offPeakTaskId")?;
                self.delete_task(id)
            }
            // The rest need the server ticket + session dispatch; faking them
            // would silently strand a task rather than scheduling it.
            "createTask" | "cancelTask" | "pauseTask" | "continueTask" | "updateTask" | "deleteHistory" => {
                Err(HandlerError::message(format!(
                    "off-peak-task.{method} needs the server ticket + agent session dispatch and is \\
                     not yet ported to the Rust host"
                )))
            }
            other => Err(HandlerError::message(format!(
                "off-peak-task.{other} is not implemented by the Rust host"
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

    fn temp_db(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("zcode-offpeak-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("tasks-index.sqlite")
    }

    fn seed_task(conn: &mut rusqlite::Connection, key: &str, id: &str) {
        conn.execute(
            "INSERT INTO off_peak_tasks (off_peak_task_id, prompt, permission_mode, workspace_key,
                workspace_path, status, schedulable, queued_at, created_at, updated_at)
             VALUES (?1, 'do a thing', 'default', ?2, ?2, 'queued', 1, 1, 1, 1)",
            rusqlite::params![id, key],
        )
        .expect("seed off-peak task");
    }

    #[test]
    fn a_seeded_task_lists_gets_and_deletes() {
        let db = temp_db("crud");
        let service = OffPeakTaskService::new_with_path(db.clone()).expect("open");
        {
            let mut conn = service.conn.lock().unwrap();
            seed_task(&mut conn, "/ws", "op1");
        }
        let list = service
            .call("", "list", &[serde_json::json!({ "workspacePath": "/ws" })])
            .expect("list");
        assert_eq!(list.as_array().map(Vec::len), Some(1), "one task: {list}");
        assert_eq!(list[0]["offPeakTaskId"], serde_json::json!("op1"));

        let got = service
            .call("", "get", &[serde_json::json!({ "offPeakTaskId": "op1" })])
            .expect("get");
        assert_eq!(got["prompt"], serde_json::json!("do a thing"));

        service
            .call("", "deleteTask", &[serde_json::json!({ "offPeakTaskId": "op1" })])
            .expect("delete");
        let after = service
            .call("", "list", &[serde_json::json!({ "workspacePath": "/ws" })])
            .expect("list after delete");
        assert_eq!(after.as_array().map(Vec::len), Some(0), "deleted: {after}");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn dispatch_operations_error_loudly() {
        let db = temp_db("dispatch");
        let service = OffPeakTaskService::new_with_path(db.clone()).expect("open");
        // Every dispatch operation must error loudly (server ticket / session
        // dispatch), never silently succeed and strand a task.
        for method in ["createTask", "cancelTask", "pauseTask", "continueTask", "updateTask", "deleteHistory"] {
            assert!(
                service.call("", method, &[serde_json::json!({})]).is_err(),
                "{method} must error"
            );
        }
        let _ = std::fs::remove_file(&db);
    }
}
