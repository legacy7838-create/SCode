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
