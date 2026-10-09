//! `updateTodos` write path (ported from
//! `apps/zcode-cli/.../session-store/repositories/todos.ts`).
//!
//! The TS replaces a session's whole ordered todo list in one `BEGIN IMMEDIATE` transaction: delete
//! every `todo` row for the session, re-insert the incoming list with `position` = array index (the
//! JS `entries()` counter, 0-based) and both `time_created`/`time_updated` = `now`, then bump the
//! parent `session.time_updated` through the same guarded `max(time_updated, ?)` `touchSession` the
//! sessions repo uses. The list is `content`/`status`/`priority` only (the TS `TodoItem` shape —
//! `position` is the index, not a payload field). `now` is injected by the caller (epoch ms) so the
//! write is deterministic and testable; the SQL, ordering and commit/rollback shape are reproduced
//! inline, with no dependency on any sibling module.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde_json::Value;

/// Port of `updateTodos`: replace the session's ordered todo list + touch the session, all inside one
/// `BEGIN IMMEDIATE` transaction (COMMIT on success, ROLLBACK on any error — mirrors the TS
/// try/commit/catch-rollback so a failure never leaves a half-written list).
///
/// # Arguments
///
/// * `conn` - A read-write connection (the caller owns the transaction lifecycle via this fn).
/// * `session_id` - The parent `session.id`; `todo.session_id` has an FK to it (`on delete cascade`).
/// * `todos` - Incoming list; each element is `{content, status, priority}`. `position` is the
///   0-based index in this slice, matching the JS `input.todos.entries()` counter.
/// * `now` - Epoch ms injected by the caller; used for every row's `time_created`/`time_updated` and
///   the `touchSession` value.
///
/// # Errors
///
/// Returns `Err(String)` when a field is missing/not a string, or any SQL statement fails. On error
/// the transaction is rolled back, so the stored list is unchanged.
pub fn update_todos(
    conn: &Connection,
    session_id: &str,
    todos: &[Value],
    now: i64,
) -> std::result::Result<(), String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let result = (|| -> std::result::Result<(), String> {
        // Delete the whole prior list for this session (TS: `delete from todo where session_id = ?`).
        conn.execute("delete from todo where session_id = ?1", [session_id])
            .map_err(|e| e.to_string())?;

        // Re-insert the incoming list only when non-empty (TS `if (input.todos.length > 0)`); an
        // empty list just clears the session's todos. `position` is the index, times are both `now`.
        if !todos.is_empty() {
            for (position, todo) in todos.iter().enumerate() {
                let content = field_str(todo, "content")?;
                let status = field_str(todo, "status")?;
                let priority = field_str(todo, "priority")?;
                conn.execute(
                    "insert into todo (session_id, content, status, priority, position, time_created, time_updated) \
                     values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![session_id, content, status, priority, position as i64, now, now],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        // `touchSession` (sessions.ts): bump the parent's `time_updated` to the newer value, never
        // backwards — `max(time_updated, ?)`, not an unconditional overwrite.
        conn.execute(
            "update session set time_updated = max(time_updated, ?1) where id = ?2",
            params![now, session_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// Read a required string field from a todo object, mirroring TS's `todo.content` access (an absent
/// or non-string field is an error rather than a silent `undefined` written into a NOT NULL column).
fn field_str<'a>(todo: &'a Value, key: &str) -> std::result::Result<&'a str, String> {
    todo.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("todo.{key} must be a string"))
}

/// N-API: `updateTodos` write boundary. Opens a read-write DB, applies the transactional todo-list
/// replacement, and returns `null` (the TS returns `void`). `todos_json` is a JSON array of
/// `{content, status, priority}` objects; `position` is the array index. `now` is a JS number
/// (epoch ms) injected by the caller for deterministic, testable writes.
#[napi]
pub fn update_todos_json(
    db_path: String,
    session_id: String,
    todos_json: String,
    now: f64,
) -> Result<String> {
    let todos: Vec<Value> =
        serde_json::from_str(&todos_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    update_todos(&conn, &session_id, &todos, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&Value::Null).map_err(|e| Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::result::Result as StdResult;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        // The production path turns FKs on per-connection (`open_readwrite`); mirror it so the
        // `todo.session_id` cascade/`FOREIGN KEY` constraint actually fires in these tests.
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("invariant: enable foreign keys");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 0)
            .expect("invariant: apply session schema");
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) \
             values ('s1','p','slug','/d','t','v',100,100)",
            [],
        )
        .expect("invariant: seed session");
        conn
    }

    fn positions_and_times(conn: &Connection) -> Vec<(i64, i64, i64)> {
        let mut stmt = conn
            .prepare("select position, time_created, time_updated from todo where session_id='s1' order by position")
            .expect("select");
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .expect("query")
            .collect::<StdResult<Vec<_>, _>>()
            .expect("collect")
    }

    #[test]
    fn replaces_list_with_index_positions_and_injected_times() {
        let conn = db();
        // Pre-existing rows that must be fully replaced.
        conn.execute(
            "insert into todo (session_id, content, status, priority, position, time_created, time_updated) \
             values ('s1','old','completed','high',0,7,7),('s1','older','pending','low',1,8,8)",
            [],
        )
        .expect("seed todos");

        update_todos(
            &conn,
            "s1",
            &[
                json!({"content": "a", "status": "pending", "priority": "high"}),
                json!({"content": "b", "status": "in_progress", "priority": "low"}),
            ],
            5_000,
        )
        .expect("update ok");

        assert_eq!(
            positions_and_times(&conn),
            vec![(0, 5_000, 5_000), (1, 5_000, 5_000)],
            "old rows deleted, new rows keyed by index with injected now"
        );
        let content: Vec<String> = {
            let mut stmt = conn
                .prepare("select content from todo where session_id='s1' order by position")
                .expect("select");
            stmt.query_map([], |r| r.get(0))
                .expect("query")
                .collect::<StdResult<Vec<_>, _>>()
                .expect("collect")
        };
        assert_eq!(content, vec!["a", "b"]);
        // touchSession bumped 100 -> 5000 (max).
        let updated: i64 = conn
            .query_row("select time_updated from session where id='s1'", [], |r| {
                r.get(0)
            })
            .expect("read");
        assert_eq!(updated, 5_000);
    }

    #[test]
    fn empty_list_clears_and_still_touches() {
        let conn = db();
        conn.execute(
            "insert into todo (session_id, content, status, priority, position, time_created, time_updated) \
             values ('s1','x','pending','medium',0,7,7)",
            [],
        )
        .expect("seed todo");
        update_todos(&conn, "s1", &[], 9_000).expect("update ok");
        assert!(positions_and_times(&conn).is_empty(), "list cleared");
        let updated: i64 = conn
            .query_row("select time_updated from session where id='s1'", [], |r| {
                r.get(0)
            })
            .expect("read");
        assert_eq!(updated, 9_000);
    }

    #[test]
    fn touch_session_never_moves_clock_backwards() {
        let conn = db();
        conn.execute("update session set time_updated = 10_000 where id='s1'", [])
            .expect("advance");
        update_todos(
            &conn,
            "s1",
            &[json!({"content":"a","status":"pending","priority":"low"})],
            4,
        )
        .expect("update ok");
        let updated: i64 = conn
            .query_row("select time_updated from session where id='s1'", [], |r| {
                r.get(0)
            })
            .expect("read");
        assert_eq!(
            updated, 10_000,
            "max(time_updated, now) keeps the newer clock"
        );
    }

    #[test]
    fn bad_field_shape_rolls_back_and_leaves_prior_list() {
        let conn = db();
        conn.execute(
            "insert into todo (session_id, content, status, priority, position, time_created, time_updated) \
             values ('s1','keep','pending','low',0,7,7)",
            [],
        )
        .expect("seed todo");
        // Missing `priority` -> field_str error after the delete already ran inside the txn.
        let err = update_todos(
            &conn,
            "s1",
            &[json!({"content":"a","status":"pending"})],
            500,
        )
        .expect_err("must fail on missing field");
        assert!(err.contains("priority"), "unexpected error: {err}");
        assert_eq!(
            positions_and_times(&conn),
            vec![(0, 7, 7)],
            "rollback restored the prior list"
        );
    }

    #[test]
    fn foreign_key_violation_rolls_back() {
        let conn = db();
        // No session 'ghost': the delete is a no-op but the insert trips the FK, rolling the txn.
        conn.execute("update session set time_updated = 55 where id='s1'", [])
            .expect("set sentinel");
        let err = update_todos(
            &conn,
            "ghost",
            &[json!({"content":"a","status":"pending","priority":"low"})],
            500,
        )
        .expect_err("FK violation must surface");
        assert!(
            err.contains("FOREIGN KEY") || err.contains("constraint"),
            "unexpected error: {err}"
        );
    }
}
