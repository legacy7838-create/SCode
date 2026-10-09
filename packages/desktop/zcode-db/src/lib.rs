//! Node-API addon exposing the Rust DB read path (slice 2). The TS callers will `require` the built
//! `.node` and call these; the SQL runs entirely in Rust (rusqlite), no JS in the DB path.
//!
//! READ-ONLY for now — the write path + migration/locking parity are later slices (PORTING-DB.md).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{Connection, OpenFlags};

fn open_readonly(path: &str) -> Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| Error::from_reason(format!("open {path}: {e}")))
}

/// Count rows in `tasks`.
#[napi]
pub fn tasks_count(db_path: String) -> Result<u32> {
    let conn = open_readonly(&db_path)?;
    let n: i64 = conn
        .query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(n as u32)
}

/// A task row projected for the UI.
#[napi(object)]
pub struct TaskRow {
    pub workspace_key: String,
    pub task_id: String,
    pub mode: String,
    pub title: String,
}

/// Most-recent tasks (parity with the TS `queryTaskList` ordering, read path).
#[napi]
pub fn list_recent_tasks(db_path: String, limit: u32) -> Result<Vec<TaskRow>> {
    let conn = open_readonly(&db_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT workspace_key, task_id, mode, title FROM tasks ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(TaskRow {
                workspace_key: row.get(0)?,
                task_id: row.get(1)?,
                mode: row.get(2)?,
                title: row.get(3)?,
            })
        })
        .map_err(|e| Error::from_reason(e.to_string()))?;
    rows.map(|r| r.map_err(|e| Error::from_reason(e.to_string())))
        .collect()
}

/// Faithful port of the TS `listTaskMetas` DB query for a single workspace: exclude tombstones
/// (`deleted = 0`) and order by `updated_at DESC, created_at DESC, task_id DESC`. Returns the raw
/// rows; the `meta_json` → `ZCodeTaskMeta` transform (`rowToMeta`) is a later slice.
pub fn query_tasks_by_workspace(
    conn: &Connection,
    workspace_key: &str,
) -> std::result::Result<Vec<TaskRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT workspace_key, task_id, mode, title
         FROM tasks
         WHERE workspace_key = ?1 AND deleted = 0
         ORDER BY updated_at DESC, created_at DESC, task_id DESC",
    )?;
    let rows = stmt.query_map([workspace_key], |row| {
        Ok(TaskRow {
            workspace_key: row.get(0)?,
            task_id: row.get(1)?,
            mode: row.get(2)?,
            title: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// N-API wrapper: tasks for one workspace (read-only).
#[napi]
pub fn list_tasks_by_workspace(db_path: String, workspace_key: String) -> Result<Vec<TaskRow>> {
    let conn = open_readonly(&db_path)?;
    query_tasks_by_workspace(&conn, &workspace_key).map_err(|e| Error::from_reason(e.to_string()))
}

/// Input for an upsert of one task row (subset of the TS `syncTaskMeta` write path).
#[derive(Clone)]
#[napi(object)]
pub struct NewTask {
    pub workspace_key: String,
    pub task_id: String,
    pub title: String,
    pub mode: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Insert or update a task row (write building block for the `syncTaskMeta` port). Uses SQLite
/// upsert so repeated calls are idempotent on `(workspace_key, task_id)` — matching the TS repo's
/// upsert semantics. Returns the number of affected rows.
pub fn upsert_task(conn: &Connection, task: &NewTask) -> std::result::Result<usize, rusqlite::Error> {
    conn.execute(
        "INSERT INTO tasks (workspace_key, task_id, title, mode, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(workspace_key, task_id) DO UPDATE SET
           title = excluded.title, mode = excluded.mode, updated_at = excluded.updated_at",
        rusqlite::params![
            task.workspace_key,
            task.task_id,
            task.title,
            task.mode,
            task.created_at,
            task.updated_at,
        ],
    )
}

/// Rust projection of the TS `ZCodeTaskMeta` (meta_json blob). Known scalar fields are typed;
/// unknown/complex fields (traceId, thoughtLevel, target, …) are preserved in `rest` for lossless
/// round-trip. camelCase JSON keys map to snake_case Rust fields via serde `rename_all`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMeta {
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(flatten)]
    pub rest: std::collections::BTreeMap<String, serde_json::Value>,
}

/// Parse a `meta_json` blob into `TaskMeta` (foundation for the `rowToMeta` port).
pub fn parse_task_meta(meta_json: &str) -> std::result::Result<TaskMeta, serde_json::Error> {
    serde_json::from_str(meta_json)
}

/// N-API: return the raw `meta_json` string for one task (parse it in Rust via `parse_task_meta`).
#[napi]
pub fn read_task_meta_json(
    db_path: String,
    workspace_key: String,
    task_id: String,
) -> Result<Option<String>> {
    let conn = open_readonly(&db_path)?;
    let mut stmt = conn
        .prepare("SELECT meta_json FROM tasks WHERE workspace_key = ?1 AND task_id = ?2")
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let mut rows = stmt
        .query_map(rusqlite::params![workspace_key, task_id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .map_err(|e| Error::from_reason(e.to_string()))?;
    match rows.next() {
        Some(r) => r.map_err(|e| Error::from_reason(e.to_string())),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, workspace_path TEXT, workspace_identity TEXT,
               task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT,
               provider TEXT, mode TEXT NOT NULL DEFAULT 'build', model TEXT,
               migration_source TEXT, forked_from_task_id TEXT, cron_automation_id TEXT,
               off_peak_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               unread_at INTEGER, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
               deleted INTEGER DEFAULT 0, title_overridden INTEGER DEFAULT 0,
               searchable_text TEXT, meta_json TEXT DEFAULT '{}',
               PRIMARY KEY (workspace_key, task_id));",
        )
        .unwrap();
        // ws-A: three tasks with distinct updated_at + one tombstone (deleted=1) that must be excluded.
        let ins = |ws: &str, id: &str, upd: i64, del: i64, title: &str| {
            conn.execute(
                "INSERT INTO tasks (workspace_key, task_id, mode, title, created_at, updated_at, deleted)
                 VALUES (?1, ?2, 'build', ?3, ?4, ?4, ?5)",
                rusqlite::params![ws, id, title, upd, del],
            )
            .unwrap();
        };
        ins("ws-A", "t-old", 100, 0, "old");
        ins("ws-A", "t-new", 300, 0, "new");
        ins("ws-A", "t-mid", 200, 0, "mid");
        ins("ws-A", "t-dead", 400, 1, "deleted");
        ins("ws-B", "other", 500, 0, "other-ws");
        conn
    }

    #[test]
    fn upsert_inserts_then_updates_idempotently() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
               mode TEXT NOT NULL DEFAULT 'build', created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0,
               PRIMARY KEY (workspace_key, task_id));",
        )
        .unwrap();
        let t = NewTask {
            workspace_key: "ws".into(),
            task_id: "id1".into(),
            title: "first".into(),
            mode: "build".into(),
            created_at: 10,
            updated_at: 10,
        };
        assert_eq!(upsert_task(&conn, &t).unwrap(), 1, "insert affects 1 row");
        // Same key, new title/updated_at => UPDATE (not a second row).
        let t2 = NewTask {
            title: "second".into(),
            updated_at: 20,
            ..t.clone()
        };
        assert_eq!(upsert_task(&conn, &t2).unwrap(), 1, "update affects the same 1 row");
        let rows = conn
            .prepare("SELECT title, updated_at FROM tasks WHERE workspace_key='ws' AND task_id='id1'")
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 1, "still one row (upsert, not duplicate)");
        assert_eq!(rows[0], ("second".to_string(), 20));
    }

    #[test]
    fn filters_deleted_and_orders_desc() {
        let conn = fixture_db();
        let rows = query_tasks_by_workspace(&conn, "ws-A").unwrap();
        // Excludes t-dead (deleted) and other-ws (different workspace); ordered by updated_at DESC.
        let ids: Vec<&str> = rows.iter().map(|r| r.task_id.as_str()).collect();
        assert_eq!(ids, vec!["t-new", "t-mid", "t-old"]);
    }

    #[test]
    fn excludes_other_workspace() {
        let conn = fixture_db();
        let rows = query_tasks_by_workspace(&conn, "ws-B").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].task_id, "other");
    }

    #[test]
    fn parses_real_meta_json_shape() {
        // Mirrors a real row's meta_json keys observed in the live DB.
        let sample = r#"{"taskId":"sess_x","traceId":"zcode-sess_x","title":"hey","titleOverridden":false,"workspacePath":"/p","createdAt":1,"updatedAt":2,"mode":"build","model":"m","thoughtLevel":"high","provider":"p","status":"idle","lastError":null,"target":{}}"#;
        let m = parse_task_meta(sample).unwrap();
        assert_eq!(m.task_id, "sess_x");
        assert_eq!(m.title, "hey");
        assert_eq!(m.mode, "build");
        assert_eq!(m.created_at, 1);
        assert_eq!(m.updated_at, 2);
        assert_eq!(m.model.as_deref(), Some("m"));
        // Unknown/complex fields are preserved (lossless), not dropped.
        assert!(m.rest.contains_key("traceId"));
        assert!(m.rest.contains_key("thoughtLevel"));
        assert!(m.rest.contains_key("target"));
    }
}

