//! First vertical slice of the Rust DB port: open the existing ZCode tasks-index SQLite file
//! READ-ONLY (so it can never mutate the running app's data) and read rows. Proves the Rust
//! `rusqlite` foundation reads the same database the TypeScript layer uses — no JS involved.
//!
//! Subsequent slices port each repo method (`TaskIndexRepo`, `AutomationRepo`, `OffPeakTaskRepo`)
//! and expose them to the TS callers across a native boundary. See `zcode-db/PORTING-DB.md`.

use rusqlite::{Connection, OpenFlags};
use std::env;
use std::error::Error;
use std::path::PathBuf;

/// Resolve the tasks-index DB path: `ZCODE_TASKS_DB` override, else `~/.zcode/v2/tasks-index.sqlite`.
fn db_path() -> PathBuf {
    if let Ok(p) = env::var("ZCODE_TASKS_DB") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".zcode/v2/tasks-index.sqlite")
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = db_path();
    // READ_ONLY: this slice must never write. Migration/locking parity is handled in later slices.
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    let task_count: i64 = conn.query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))?;
    println!("opened (read-only): {}", path.display());
    println!("tasks rows: {task_count}");

    let mut stmt = conn.prepare(
        "SELECT workspace_key, task_id, mode, title FROM tasks ORDER BY updated_at DESC LIMIT 5",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (workspace_key, task_id, mode, title) = row?;
        println!("  task {task_id} [{mode}] {title}  (ws={workspace_key})");
    }
    Ok(())
}
