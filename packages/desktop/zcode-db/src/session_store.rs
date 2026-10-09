//! Session-store read operations, one atomic unit per public facade method (the Agent CLI
//! `~/.zcode/cli/db/db.sqlite`). The JS store ran these on one shared `DatabaseSync` handle across
//! multi-statement transactions; here each public read is a self-contained query, so the stateless
//! N-API model matches the JS behavior at the operation boundary. Projections mirror the TS codecs
//! (`decodeTodoRow`, …) exactly, verified by `harness/session_read_parity`.

use rusqlite::Connection;
use serde_json::{Value, json};

/// Port of `readTodos` + `decodeTodoRow`: ordered by `position asc`, projected to
/// `{content, status, priority}` (the codec drops the id/position/time columns).
pub fn read_todos(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "select content, status, priority from todo where session_id = ?1 order by position asc",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok(json!({
                "content": row.get::<_, String>(0)?,
                "status": row.get::<_, String>(1)?,
                "priority": row.get::<_, String>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(Value::Array(out))
}
