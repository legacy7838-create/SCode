//! Basic `session_target` lifecycle WRITE ops, ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-target.ts`.
//!
//! Scope is the four lifecycle writes plus the summary-title write: `setSessionTarget` (upsert),
//! `createSessionTarget` (the `insert or ignore` variant), `updateSessionTargetStatus`,
//! `clearSessionTarget` and `updateSessionTargetSummaryTitle`. Each ends with the inline
//! `touchSessionForTarget` bump (`update session set time_updated = max(time_updated, ?) where id = ?`).
//! The TS runs each statement as its own implicit autocommit (no `BEGIN`/`COMMIT`), so neither do we.
//!
//! Two things make this path non-deterministic on the TS side, so the N-API wrappers take them as
//! explicit inputs instead of generating them in Rust: `target_id` (TS mints
//! `target_<base36(Date.now())>_<randomUUID()>`, so the caller injects a fixed id) and `now` (TS reads
//! `Date.now()`, so the caller injects a fixed epoch ms). With both pinned, the deterministic columns
//! (`session_id`, `objective`, `summary_title`, `status`, `token_budget`, `tokens_used`,
//! `time_used_seconds`, `active_*`, `time_created`, `time_updated`) and the touched
//! `session.time_updated` are exactly reproducible for the write-parity harness.
//!
//! The returned `SessionGoal` projection reuses [`crate::session_store::read_target`] (a verbatim port
//! of TS `decodeTargetRow`), keeping a single source of truth for the row→JSON shape.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde_json::Value;

use crate::session_store;

/// Inline port of the private `touchSessionForTarget`: bump the parent session's `time_updated` to the
/// newer value only, never backwards (`max(time_updated, ?)`), exactly as the TS statement.
fn touch_session(conn: &Connection, session_id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "update session set time_updated = max(time_updated, ?1) where id = ?2",
        params![now, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of the private `mustReadTarget`: read the target back via [`crate::session_store::read_target`],
/// throwing `Session target not found after write: <id>` (mirrored as `Err`) when it is null.
fn must_read_target(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let target = session_store::read_target(conn, session_id)?;
    if target.is_null() {
        return Err(format!(
            "Session target not found after write: {session_id}"
        ));
    }
    Ok(target)
}

/// Port of `setSessionTarget`: upsert the session's single target row (the `on conflict(session_id)`
/// arm replaces every column and clears the three `active_*` run fields), then touch the session, then
/// read back with `mustReadTarget`. No transaction, matching the TS (implicit autocommit).
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `session_id` - The parent `session.id` (also the `session_target` primary key).
/// * `target_id` - Caller-injected id (TS mints this via clock+uuid; passed in for determinism).
/// * `objective` - The goal objective text.
/// * `status` - The goal status (`active`/`paused`/`budget_limited`/`complete`); stored verbatim.
/// * `token_budget` - Optional token budget (TS `input.tokenBudget ?? null`).
/// * `now` - Epoch ms injected by the caller (TS `Date.now()`).
///
/// # Returns
///
/// The read-back `SessionGoal` projection JSON.
///
/// # Errors
///
/// Returns `Err` when a statement fails, or the read-back is null after the write.
pub fn set_session_target(
    conn: &Connection,
    session_id: &str,
    target_id: &str,
    objective: &str,
    status: &str,
    token_budget: Option<i64>,
    now: i64,
) -> Result<Value, String> {
    // SQL + bind order copied verbatim from `session-target.ts` (`setSessionTarget`).
    conn.execute(
        "insert into session_target (
          session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
        ) values (?1, ?2, ?3, null, ?4, ?5, 0, 0, ?6, ?7)
        on conflict(session_id) do update set
          target_id = excluded.target_id,
          objective = excluded.objective,
          summary_title = excluded.summary_title,
          status = excluded.status,
          token_budget = excluded.token_budget,
          tokens_used = excluded.tokens_used,
          time_used_seconds = excluded.time_used_seconds,
          active_input_id = null,
          active_run_started_at = null,
          active_run_last_seen_at = null,
          time_created = excluded.time_created,
          time_updated = excluded.time_updated",
        params![session_id, target_id, objective, status, token_budget, now, now],
    )
    .map_err(|e| e.to_string())?;
    touch_session(conn, session_id, now)?;
    must_read_target(conn, session_id)
}

/// Port of `createSessionTarget` (the `insert or ignore` variant): insert a fresh `active` target with
/// counters 0, ignoring a `session_id` conflict. Then read back; if the stored row's `target_id` does
/// not equal the injected one (i.e. the insert was ignored because a row already existed) TS returns
/// `null` WITHOUT touching the session — replicated exactly. Only on a real insert does it touch +
/// return the target.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `session_id` - The parent `session.id` / primary key.
/// * `target_id` - Caller-injected id.
/// * `objective` - The goal objective text.
/// * `token_budget` - Optional token budget (TS `input.tokenBudget ?? null`).
/// * `now` - Epoch ms injected by the caller.
///
/// # Returns
///
/// The read-back `SessionGoal` JSON on a real insert, or JSON `null` when the insert was ignored
/// (existing row has a different `target_id`), matching TS `SessionGoal | null`.
///
/// # Errors
///
/// Returns `Err` when a statement or the read-back fails.
pub fn create_session_target(
    conn: &Connection,
    session_id: &str,
    target_id: &str,
    objective: &str,
    token_budget: Option<i64>,
    now: i64,
) -> Result<Value, String> {
    // SQL + bind order copied verbatim from `session-target.ts` (`createSessionTarget`). Status is the
    // literal `'active'`; `tokens_used`/`time_used_seconds` are the literal `0`s; `summary_title` null.
    conn.execute(
        "insert or ignore into session_target (
          session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
        ) values (?1, ?2, ?3, null, 'active', ?4, 0, 0, ?5, ?6)",
        params![session_id, target_id, objective, token_budget, now, now],
    )
    .map_err(|e| e.to_string())?;

    let target = session_store::read_target(conn, session_id)?;
    // TS: `if (target?.targetID !== targetID) return null;` — a null read or a mismatched id (conflict
    // ignored the insert) both return null and skip the touch.
    let inserted = target
        .get("targetID")
        .and_then(Value::as_str)
        .is_some_and(|id| id == target_id);
    if !inserted {
        return Ok(Value::Null);
    }
    touch_session(conn, session_id, now)?;
    Ok(target)
}

/// Port of `updateSessionTargetStatus`: set `status` + `time_updated` for the session's target. When no
/// row matches (`changes === 0`) TS returns `null` and does not touch the session — replicated.
/// Otherwise touch + `mustReadTarget`.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `session_id` - The parent `session.id`.
/// * `status` - The new status string.
/// * `now` - Epoch ms injected by the caller.
///
/// # Returns
///
/// The read-back `SessionGoal` JSON, or JSON `null` when no target row was updated.
///
/// # Errors
///
/// Returns `Err` when a statement fails, or the read-back is null after a successful update.
pub fn update_session_target_status(
    conn: &Connection,
    session_id: &str,
    status: &str,
    now: i64,
) -> Result<Value, String> {
    let changes = conn
        .execute(
            "update session_target set status = ?1, time_updated = ?2 where session_id = ?3",
            params![status, now, session_id],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        return Ok(Value::Null);
    }
    touch_session(conn, session_id, now)?;
    must_read_target(conn, session_id)
}

/// Port of `clearSessionTarget`: delete the session's target row. TS returns `false` when nothing was
/// deleted (`changes === 0`) and does not touch the session; otherwise touch + `true`.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `session_id` - The parent `session.id`.
/// * `now` - Epoch ms injected by the caller (used only for the session touch).
///
/// # Returns
///
/// `true` when a row was deleted (and the session touched), `false` otherwise.
///
/// # Errors
///
/// Returns `Err` when a statement fails.
pub fn clear_session_target(conn: &Connection, session_id: &str, now: i64) -> Result<bool, String> {
    let changes = conn
        .execute(
            "delete from session_target where session_id = ?1",
            [session_id],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        return Ok(false);
    }
    touch_session(conn, session_id, now)?;
    Ok(true)
}

/// Port of `updateSessionTargetSummaryTitle`: set `summary_title` + `time_updated`, guarded by BOTH
/// `session_id` and `target_id` (so a stale title sidecar cannot overwrite a newer goal). On zero
/// changes TS returns `readSessionTarget(...)` — the current row, which may be non-null (the target_id
/// simply did not match) — replicated. Otherwise touch + `mustReadTarget`.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `session_id` - The parent `session.id`.
/// * `target_id` - The expected target id (part of the `where` guard, matching TS).
/// * `summary_title` - The summary title text.
/// * `now` - Epoch ms injected by the caller.
///
/// # Returns
///
/// On a matched update: the touched read-back `SessionGoal` JSON. On zero changes: the plain
/// `read_target` result (JSON `null` when there is no row at all).
///
/// # Errors
///
/// Returns `Err` when a statement fails, or the read-back is null after a successful update.
pub fn update_target_summary_title(
    conn: &Connection,
    session_id: &str,
    target_id: &str,
    summary_title: &str,
    now: i64,
) -> Result<Value, String> {
    let changes = conn
        .execute(
            "update session_target set summary_title = ?1, time_updated = ?2 where session_id = ?3 and target_id = ?4",
            params![summary_title, now, session_id, target_id],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        // TS: `return readSessionTarget(db, { sessionID })` (not null — could still be a live row).
        return session_store::read_target(conn, session_id);
    }
    touch_session(conn, session_id, now)?;
    must_read_target(conn, session_id)
}

/// N-API: `setSessionTarget` port. `token_budget` is a JS number or null/undefined; `now`/`target_id`
/// are caller-injected for determinism. Returns the read-back `SessionGoal` JSON.
#[napi]
pub fn set_session_target_json(
    db_path: String,
    session_id: String,
    target_id: String,
    objective: String,
    status: String,
    token_budget: Option<f64>,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value = set_session_target(
        &conn,
        &session_id,
        &target_id,
        &objective,
        &status,
        token_budget.map(|v| v as i64),
        now as i64,
    )
    .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `createSessionTarget` port. Returns the read-back `SessionGoal` JSON, or `"null"` when the
/// insert was ignored (a row with a different `target_id` already exists).
#[napi]
pub fn create_session_target_json(
    db_path: String,
    session_id: String,
    target_id: String,
    objective: String,
    token_budget: Option<f64>,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value = create_session_target(
        &conn,
        &session_id,
        &target_id,
        &objective,
        token_budget.map(|v| v as i64),
        now as i64,
    )
    .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `updateSessionTargetStatus` port. Returns the read-back `SessionGoal` JSON, or `"null"` when
/// no row matched.
#[napi]
pub fn update_session_target_status_json(
    db_path: String,
    session_id: String,
    status: String,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value = update_session_target_status(&conn, &session_id, &status, now as i64)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `clearSessionTarget` port. Returns JSON `true`/`false` — the TS boolean (whether a row was
/// deleted). `"null"` is never returned, matching the source's `boolean` return type.
#[napi]
pub fn clear_session_target_json(
    db_path: String,
    session_id: String,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let deleted =
        clear_session_target(&conn, &session_id, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&Value::Bool(deleted)).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `updateSessionTargetSummaryTitle` port. `target_id` is part of the `where` guard (matching the
/// verbatim TS SQL), so the wrapper takes it explicitly. Returns the read-back `SessionGoal` JSON, or
/// the plain current-target read (`"null"` only when there is no row) on a non-matching update.
#[napi]
pub fn update_target_summary_title_json(
    db_path: String,
    session_id: String,
    target_id: String,
    summary_title: String,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value =
        update_target_summary_title(&conn, &session_id, &target_id, &summary_title, now as i64)
            .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// In-memory DB with the real session schema (via the bootstrap migrations) and one seeded parent
    /// session whose `time_updated` starts at 100 so the `max()` touch can move it forward.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
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

    fn target_row(conn: &Connection) -> Option<Value> {
        let v = session_store::read_target(conn, "s1").expect("read_target");
        if v.is_null() {
            None
        } else {
            Some(v)
        }
    }

    fn session_time_updated(conn: &Connection) -> i64 {
        conn.query_row("select time_updated from session where id='s1'", [], |r| {
            r.get(0)
        })
        .expect("read session time_updated")
    }

    #[test]
    fn create_inserts_active_zero_counters_then_touches() {
        let conn = db();
        let out = create_session_target(&conn, "s1", "t-fixed", "obj", Some(1000), 5_000)
            .expect("create ok");
        assert_eq!(out["status"], serde_json::json!("active"));
        assert_eq!(out["targetID"], serde_json::json!("t-fixed"));
        assert_eq!(out["summaryTitle"], serde_json::Value::Null);
        assert_eq!(out["tokensUsed"], serde_json::json!(0));
        assert_eq!(out["timeUsedSeconds"], serde_json::json!(0));
        assert_eq!(out["tokenBudget"], serde_json::json!(1000));
        assert_eq!(out["time"]["created"], serde_json::json!(5_000));
        assert_eq!(out["time"]["updated"], serde_json::json!(5_000));
        assert_eq!(
            session_time_updated(&conn),
            5_000,
            "touchSession bumped to now"
        );
    }

    #[test]
    fn create_is_ignored_when_row_exists_and_returns_null_without_touch() {
        let conn = db();
        create_session_target(&conn, "s1", "first", "obj", None, 1_000).expect("first create");
        // Second create with a different injected target_id: `insert or ignore` conflicts, so the row
        // keeps `first`; read-back targetID !== "second" -> null, and the session is NOT touched again.
        conn.execute("update session set time_updated = 100 where id='s1'", [])
            .expect("reset session clock");
        let out = create_session_target(&conn, "s1", "second", "other", Some(9), 500)
            .expect("second create ok");
        assert!(out.is_null(), "ignored insert returns null");
        let row = target_row(&conn).expect("row still present");
        assert_eq!(
            row["targetID"],
            serde_json::json!("first"),
            "existing row untouched"
        );
        assert_eq!(
            session_time_updated(&conn),
            100,
            "no touch on the ignored path (still at reset value)"
        );
    }

    #[test]
    fn set_upserts_then_replaces_and_clears_active_fields() {
        let conn = db();
        // First set (fresh insert branch).
        set_session_target(&conn, "s1", "t1", "objective-a", "active", None, 2_000)
            .expect("set ok");
        assert_eq!(
            target_row(&conn).expect("row")["objective"],
            serde_json::json!("objective-a")
        );
        // Pre-seed an active run field so the update arm must null it out.
        conn.execute(
            "update session_target set active_input_id='in1', active_run_started_at=7, active_run_last_seen_at=8 where session_id='s1'",
            [],
        )
        .expect("seed active run");
        // Second set (on-conflict update branch): replace + clear active_* + status change.
        let out = set_session_target(&conn, "s1", "t2", "objective-b", "paused", Some(300), 4_000)
            .expect("re-set ok");
        assert_eq!(out["targetID"], serde_json::json!("t2"));
        assert_eq!(out["objective"], serde_json::json!("objective-b"));
        assert_eq!(out["status"], serde_json::json!("paused"));
        assert_eq!(out["tokenBudget"], serde_json::json!(300));
        assert_eq!(out["activeInputId"], serde_json::Value::Null);
        assert_eq!(out["activeRunStartedAtMs"], serde_json::Value::Null);
        assert_eq!(out["activeRunLastSeenAtMs"], serde_json::Value::Null);
        assert_eq!(out["time"]["created"], serde_json::json!(4_000));
        assert_eq!(out["time"]["updated"], serde_json::json!(4_000));

        let count: i64 = conn
            .query_row("select count(*) from session_target", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1, "upsert keeps a single row");
    }

    #[test]
    fn update_status_changes_row_and_touches() {
        let conn = db();
        create_session_target(&conn, "s1", "t1", "obj", None, 100).expect("seed");
        let out = update_session_target_status(&conn, "s1", "complete", 3_000).expect("update");
        assert_eq!(out["status"], serde_json::json!("complete"));
        assert_eq!(out["time"]["updated"], serde_json::json!(3_000));
        assert_eq!(session_time_updated(&conn), 3_000);
    }

    #[test]
    fn update_status_returns_null_when_no_target_row() {
        let conn = db();
        // No session_target row for s1: changes === 0 -> null, session untouched.
        let out = update_session_target_status(&conn, "s1", "paused", 9_000).expect("ok");
        assert!(out.is_null());
        assert_eq!(
            session_time_updated(&conn),
            100,
            "no touch on zero-change path"
        );
    }

    #[test]
    fn clear_deletes_and_touches_and_is_idempotent_false_on_repeat() {
        let conn = db();
        create_session_target(&conn, "s1", "t1", "obj", None, 100).expect("seed");
        assert!(clear_session_target(&conn, "s1", 6_000).expect("clear first = true"));
        assert!(target_row(&conn).is_none(), "row deleted");
        assert_eq!(session_time_updated(&conn), 6_000, "touched on delete");
        // Second clear: nothing to delete -> false, session not re-touched.
        assert!(!clear_session_target(&conn, "s1", 7_000).expect("clear second = false"));
        assert_eq!(
            session_time_updated(&conn),
            6_000,
            "no touch when nothing deleted"
        );
    }

    #[test]
    fn summary_title_updates_when_target_id_matches() {
        let conn = db();
        create_session_target(&conn, "s1", "t1", "obj", None, 100).expect("seed");
        let out =
            update_target_summary_title(&conn, "s1", "t1", "the-title", 4_000).expect("title ok");
        assert_eq!(out["summaryTitle"], serde_json::json!("the-title"));
        assert_eq!(out["time"]["updated"], serde_json::json!(4_000));
        assert_eq!(
            session_time_updated(&conn),
            4_000,
            "touched on matched update"
        );
    }

    #[test]
    fn summary_title_returns_current_read_when_target_id_mismatches() {
        let conn = db();
        create_session_target(&conn, "s1", "t1", "obj", None, 100).expect("seed");
        // Wrong target_id: zero changes -> TS returns readSessionTarget (non-null current row), no touch.
        let out = update_target_summary_title(&conn, "s1", "WRONG", "should-not-apply", 8_000)
            .expect("ok");
        assert_eq!(
            out["targetID"],
            serde_json::json!("t1"),
            "returns the live current row"
        );
        assert_eq!(
            out["summaryTitle"],
            serde_json::Value::Null,
            "title not written"
        );
        assert_eq!(
            session_time_updated(&conn),
            100,
            "no touch on non-matching path"
        );
    }

    #[test]
    fn touch_session_max_never_moves_clock_backwards() {
        let conn = db();
        create_session_target(&conn, "s1", "t1", "obj", None, 100).expect("seed");
        conn.execute("update session set time_updated = 20_000 where id='s1'", [])
            .expect("advance session clock");
        // now < current session clock: max() keeps the newer value.
        update_session_target_status(&conn, "s1", "paused", 500).expect("update");
        assert_eq!(
            session_time_updated(&conn),
            20_000,
            "max(time_updated, now) keeps the newer session clock"
        );
    }

    #[test]
    fn must_read_target_errors_when_missing() {
        let conn = db();
        // s1 has no target; a direct must-read (as set's read-back path) errors, matching TS throw.
        let err = must_read_target(&conn, "s1").expect_err("must throw when null");
        assert_eq!(err, "Session target not found after write: s1");
    }
}
