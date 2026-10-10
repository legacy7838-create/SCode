//! Target-run lifecycle WRITE ops, ported from the five exported helpers in
//! `apps/zcode-cli/packages/adapters/src/storage/session-target.ts`: `startSessionTargetRun`,
//! `heartbeatSessionTargetRun`, `finishSessionTargetRun`, `recoverInterruptedSessionTargetRun` and
//! `accountSessionTargetUsage`. The facade (`sqlite-session-store.ts` ~784-824) delegates each to one
//! of these helpers, so these are the real implementations (not inline facade SQL).
//!
//! Every method mutates ONLY the `session_target` row's run/accounting columns and then runs the inline
//! `touchSessionForTarget` bump; none writes a `model_usage`/`turn_usage`/`tool_usage` row, so there is
//! no overlap with `session_write_usage.rs`. `accountSessionTargetUsage` bumps the aggregate columns
//! (`tokens_used`, `time_used_seconds`) with a single atomic read-modify-write `UPDATE ... col = col + ?`
//! — exactly the TS expression, so no transaction is needed.
//!
//! Transaction decision: the TS runs each method as one `db.prepare(...).run(...)` under implicit
//! autocommit — there is NO `BEGIN`/`COMMIT` wrapping multiple statements of a single method in the
//! source (see `session-target.ts` `startSessionTargetRun` 177-207, `heartbeatSessionTargetRun` 209-236,
//! `finishSessionTargetRun` 238-299, `recoverInterruptedSessionTargetRun` 301-344,
//! `accountSessionTargetUsage` 346-381). So none of the Rust ports opens a transaction either.
//!
//! Clock/ids: the addon NEVER reads the clock. `startedAtMs`/`seenAtMs`/`endedAtMs` are already inputs
//! for four of the five methods, and `accountSessionTargetUsage` is the only one that reads `Date.now()`,
//! so its `now` is injected. The `targetID` is always an input to these methods (they never mint one), so
//! the write-parity harness can pin every column.
//!
//! The returned `SessionGoal` projection reuses [`crate::session_store::read_target`] (a verbatim port of
//! TS `decodeTargetRow`), so the projection byte-matches the basic-target writes in
//! [`crate::session_write_target`].

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde_json::Value;

use crate::session_store;

/// Inline port of the private `touchSessionForTarget`: bump the parent session's `time_updated` to the
/// newer value only (`max(time_updated, ?)`), exactly as the TS statement.
fn touch_session(conn: &Connection, session_id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "update session set time_updated = max(time_updated, ?1) where id = ?2",
        params![now, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of the private `mustReadTarget`: read back via [`crate::session_store::read_target`], returning
/// `Err("Session target not found after write: <id>")` (TS `throw`) when the row is null.
fn must_read_target(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let target = session_store::read_target(conn, session_id)?;
    if target.is_null() {
        return Err(format!(
            "Session target not found after write: {session_id}"
        ));
    }
    Ok(target)
}

/// Port of the private `elapsedSecondsBetween`: `Math.max(0, Math.ceil((end - start) / 1000))`. Kept in
/// `f64` so `ceil` matches JS's float division exactly (integer division would truncate toward zero, not
/// ceil, for positive remainders).
fn elapsed_seconds_between(started_at_ms: i64, ended_at_ms: i64) -> i64 {
    let ceiled = ((ended_at_ms - started_at_ms) as f64 / 1000.0).ceil();
    if ceiled < 0.0 {
        0
    } else {
        ceiled as i64
    }
}

/// Port of `startSessionTargetRun`. `startedAt = Math.max(0, input.startedAtMs)`; the single UPDATE is
/// guarded by `session_id`, `target_id` AND `status = 'active'` (a paused/complete target cannot start a
/// run). Zero changes → return the plain `read_target` (which may be the non-active row); otherwise
/// touch + `mustReadTarget`.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `session_id` - The parent `session.id`.
/// * `target_id` - Expected target id (part of the `where` guard).
/// * `input_id` - The active input id to stamp onto the run fields.
/// * `started_at_ms` - Run start epoch ms (TS `input.startedAtMs`, clamped to >= 0).
///
/// # Returns
///
/// The read-back `SessionGoal` JSON on a matched update, or the plain current-target read on zero change.
///
/// # Errors
///
/// Returns `Err` when a statement fails, or the read-back is null after a successful update.
pub fn start_session_target_run(
    conn: &Connection,
    session_id: &str,
    target_id: &str,
    input_id: &str,
    started_at_ms: i64,
) -> Result<Value, String> {
    let started_at = started_at_ms.max(0);
    // SQL + bind order copied verbatim from `session-target.ts` (`startSessionTargetRun`).
    let changes = conn
        .execute(
            "update session_target set
              active_input_id = ?1,
              active_run_started_at = ?2,
              active_run_last_seen_at = ?3,
              time_updated = max(time_updated, ?4)
            where session_id = ?5
              and target_id = ?6
              and status = 'active'",
            params![input_id, started_at, started_at, started_at, session_id, target_id],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        return session_store::read_target(conn, session_id);
    }
    touch_session(conn, session_id, started_at)?;
    must_read_target(conn, session_id)
}

/// Port of `heartbeatSessionTargetRun`. `seenAt = Math.max(0, input.seenAtMs)`; the UPDATE advances
/// `active_run_last_seen_at` to `max(coalesce(..., 0), ?)` (never backwards) and is guarded by
/// `session_id`, `target_id`, `active_input_id = ?` AND `active_run_started_at is not null` (only a live
/// run can heartbeat). Zero changes → plain read; otherwise touch + `mustReadTarget`.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `session_id` - The parent `session.id`.
/// * `target_id` - Expected target id (part of the `where` guard).
/// * `input_id` - The expected active input id (part of the `where` guard).
/// * `seen_at_ms` - Heartbeat epoch ms (TS `input.seenAtMs`, clamped to >= 0).
///
/// # Returns
///
/// The read-back `SessionGoal` JSON on a matched update, or the plain current-target read on zero change.
///
/// # Errors
///
/// Returns `Err` when a statement fails, or the read-back is null after a successful update.
pub fn heartbeat_session_target_run(
    conn: &Connection,
    session_id: &str,
    target_id: &str,
    input_id: &str,
    seen_at_ms: i64,
) -> Result<Value, String> {
    let seen_at = seen_at_ms.max(0);
    // SQL + bind order copied verbatim from `session-target.ts` (`heartbeatSessionTargetRun`).
    let changes = conn
        .execute(
            "update session_target set
              active_run_last_seen_at = max(coalesce(active_run_last_seen_at, 0), ?1),
              time_updated = max(time_updated, ?2)
            where session_id = ?3
              and target_id = ?4
              and active_input_id = ?5
              and active_run_started_at is not null",
            params![seen_at, seen_at, session_id, target_id, input_id],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        return session_store::read_target(conn, session_id);
    }
    touch_session(conn, session_id, seen_at)?;
    must_read_target(conn, session_id)
}

/// Port of `finishSessionTargetRun`. First guards in JS against a missing / mismatched / un-started run
/// (returns the current read untouched): `!current`, `targetID !== input.targetID`,
/// `activeInputId !== input.inputID`, or `activeRunStartedAtMs == null`. Otherwise computes
/// `timeDelta = elapsedSecondsBetween(activeRunStartedAtMs, endedAt)` and the atomic UPDATE adds the
/// token/time deltas, resolves `status` (explicit override wins, else auto-`budget_limited` when the
/// budget is reached), clears the three run fields, and bumps `time_updated = max(...)`. Zero changes →
/// plain read; otherwise touch + `mustReadTarget`.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `session_id` - The parent `session.id`.
/// * `target_id` - Expected target id.
/// * `input_id` - Expected active input id.
/// * `ended_at_ms` - Run end epoch ms (TS `input.endedAtMs`, clamped to >= 0).
/// * `status` - Optional terminal status override (TS `input.status ?? null`).
/// * `tokens_used_delta` - Optional token delta (TS `input.tokensUsedDelta ?? 0`, clamped to >= 0).
///
/// # Returns
///
/// The read-back `SessionGoal` JSON on a matched finish, the plain current-target read on a guard hit or
/// zero change.
///
/// # Errors
///
/// Returns `Err` when a statement fails, or the read-back is null after a successful update.
#[allow(clippy::too_many_arguments)]
pub fn finish_session_target_run(
    conn: &Connection,
    session_id: &str,
    target_id: &str,
    input_id: &str,
    ended_at_ms: i64,
    status: Option<&str>,
    tokens_used_delta: Option<i64>,
) -> Result<Value, String> {
    let current = session_store::read_target(conn, session_id)?;
    // Reproduce the JS early-return guard exactly: any of these four conditions returns `current` as-is.
    if current.is_null() {
        return Ok(current);
    }
    let cur_target_id = current.get("targetID").and_then(Value::as_str);
    let cur_active_input = current.get("activeInputId").and_then(Value::as_str);
    let cur_started_at = current.get("activeRunStartedAtMs").and_then(Value::as_i64);
    if cur_target_id != Some(target_id)
        || cur_active_input != Some(input_id)
        || cur_started_at.is_none()
    {
        return Ok(current);
    }

    let ended_at = ended_at_ms.max(0);
    let token_delta = tokens_used_delta.unwrap_or(0).max(0);
    // `cur_started_at` is guaranteed Some by the guard above.
    let started_at = cur_started_at.unwrap_or(0);
    let time_delta = elapsed_seconds_between(started_at, ended_at);

    // SQL + bind order copied verbatim from `session-target.ts` (`finishSessionTargetRun`). The explicit
    // status override is bound TWICE (`when ? is not null then ?`) to mirror the two `?` placeholders; a
    // null bind makes the first arm fall through to the budget-limited check.
    let changes = conn
        .execute(
            "update session_target set
              tokens_used = tokens_used + ?1,
              time_used_seconds = time_used_seconds + ?2,
              status = case
                when ?3 is not null then ?4
                when status = 'active' and token_budget is not null and tokens_used + ?5 >= token_budget then 'budget_limited'
                else status
              end,
              active_input_id = null,
              active_run_started_at = null,
              active_run_last_seen_at = null,
              time_updated = max(time_updated, ?6)
            where session_id = ?7
              and target_id = ?8
              and active_input_id = ?9
              and active_run_started_at = ?10",
            params![
                token_delta,
                time_delta,
                status,
                status,
                token_delta,
                ended_at,
                session_id,
                target_id,
                input_id,
                started_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        return session_store::read_target(conn, session_id);
    }
    touch_session(conn, session_id, ended_at)?;
    must_read_target(conn, session_id)
}

/// Port of `recoverInterruptedSessionTargetRun`. Guard: return `current` when there is no row, when
/// `!current.activeInputId` (null OR empty string — JS falsy), or `activeRunStartedAtMs == null`. The
/// settle end is `activeRunLastSeenAtMs ?? activeRunStartedAtMs` (never `Date.now()`, so offline time is
/// not counted). `nextStatus` is `paused` only when the row is `active` (else preserved). The UPDATE adds
/// the recovered `timeDelta`, applies `nextStatus`, clears the run fields, and bumps `time_updated = max`
/// — guarded by `session_id`, `target_id`, `active_input_id` AND `active_run_started_at = ?`. Zero
/// changes → plain read; otherwise touch + `mustReadTarget`.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `session_id` - The parent `session.id`.
///
/// # Returns
///
/// The read-back `SessionGoal` JSON on a matched recovery, the plain current-target read on a guard hit
/// or zero change.
///
/// # Errors
///
/// Returns `Err` when a statement fails, or the read-back is null after a successful update.
pub fn recover_interrupted_session_target_run(
    conn: &Connection,
    session_id: &str,
) -> Result<Value, String> {
    let current = session_store::read_target(conn, session_id)?;
    if current.is_null() {
        return Ok(current);
    }
    // JS `!current.activeInputId` is falsy for null/undefined/empty string.
    let cur_active_input = current.get("activeInputId").and_then(Value::as_str);
    if cur_active_input.is_none_or(|s| s.is_empty()) {
        return Ok(current);
    }
    let cur_started_at = current.get("activeRunStartedAtMs").and_then(Value::as_i64);
    if cur_started_at.is_none() {
        return Ok(current);
    }
    let cur_last_seen = current.get("activeRunLastSeenAtMs").and_then(Value::as_i64);
    let cur_status = current
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    let cur_target_id = current
        .get("targetID")
        .and_then(Value::as_str)
        .unwrap_or("");

    // Guarantee Some from the guard above; unwrap_or keeps the borrow checker happy without a panic path.
    let started_at = cur_started_at.unwrap_or(0);
    // `??`: fall back to started_at only when last_seen is null/undefined.
    let ended_at = cur_last_seen.unwrap_or(started_at);
    let time_delta = elapsed_seconds_between(started_at, ended_at);
    let next_status: &str = if cur_status == "active" {
        "paused"
    } else {
        cur_status
    };

    // SQL + bind order copied verbatim from `session-target.ts` (`recoverInterruptedSessionTargetRun`).
    let changes = conn
        .execute(
            "update session_target set
              time_used_seconds = time_used_seconds + ?1,
              status = ?2,
              active_input_id = null,
              active_run_started_at = null,
              active_run_last_seen_at = null,
              time_updated = max(time_updated, ?3)
            where session_id = ?4
              and target_id = ?5
              and active_input_id = ?6
              and active_run_started_at = ?7",
            params![
                time_delta,
                next_status,
                ended_at,
                session_id,
                cur_target_id,
                cur_active_input.unwrap_or(""),
                started_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        return session_store::read_target(conn, session_id);
    }
    touch_session(conn, session_id, ended_at)?;
    must_read_target(conn, session_id)
}

/// Port of `accountSessionTargetUsage`. `now` is injected (TS reads `Date.now()` — the only clock read in
/// this group). Deltas clamp to >= 0; when BOTH are 0 the TS returns the plain read with NO write and NO
/// touch — replicated. Otherwise a single atomic UPDATE adds the two counters, auto-`budget_limited` when
/// the budget is reached, sets `time_updated = now` (NOT max — verbatim), guarded by `session_id` AND
/// `target_id`. Zero changes → plain read; otherwise touch + `mustReadTarget`.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `session_id` - The parent `session.id`.
/// * `target_id` - Expected target id (part of the `where` guard).
/// * `tokens_used_delta` - Optional token delta (TS `?? 0`, clamped to >= 0).
/// * `time_used_seconds_delta` - Optional time delta (TS `?? 0`, clamped to >= 0).
/// * `now` - Epoch ms injected by the caller (TS `Date.now()`).
///
/// # Returns
///
/// The read-back `SessionGoal` JSON on a matched update, the plain current-target read on the zero-delta
/// early-return or a zero-change update.
///
/// # Errors
///
/// Returns `Err` when a statement fails, or the read-back is null after a successful update.
pub fn account_session_target_usage(
    conn: &Connection,
    session_id: &str,
    target_id: &str,
    tokens_used_delta: Option<i64>,
    time_used_seconds_delta: Option<i64>,
    now: i64,
) -> Result<Value, String> {
    let token_delta = tokens_used_delta.unwrap_or(0).max(0);
    let time_delta = time_used_seconds_delta.unwrap_or(0).max(0);
    // TS early-return: `if (tokenDelta === 0 && timeDelta === 0) return readSessionTarget(...)` — no
    // write, no touch.
    if token_delta == 0 && time_delta == 0 {
        return session_store::read_target(conn, session_id);
    }

    // SQL + bind order copied verbatim from `session-target.ts` (`accountSessionTargetUsage`). Note the
    // `time_updated = ?2` is a PLAIN set (not max), matching the source.
    let changes = conn
        .execute(
            "update session_target set
              tokens_used = tokens_used + ?1,
              time_used_seconds = time_used_seconds + ?2,
              status = case
                when status = 'active' and token_budget is not null and tokens_used + ?3 >= token_budget then 'budget_limited'
                else status
              end,
              time_updated = ?4
            where session_id = ?5 and target_id = ?6",
            params![
                token_delta,
                time_delta,
                token_delta,
                now,
                session_id,
                target_id,
            ],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        return session_store::read_target(conn, session_id);
    }
    touch_session(conn, session_id, now)?;
    must_read_target(conn, session_id)
}

/// N-API: `startSessionTargetRun` port. Returns the read-back `SessionGoal` JSON, or the plain current
/// target read (JSON `null` only when there is no row) on a zero-change update.
#[napi]
pub fn start_session_target_run_json(
    db_path: String,
    session_id: String,
    target_id: String,
    input_id: String,
    started_at_ms: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value = start_session_target_run(
        &conn,
        &session_id,
        &target_id,
        &input_id,
        started_at_ms as i64,
    )
    .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `heartbeatSessionTargetRun` port.
#[napi]
pub fn heartbeat_session_target_run_json(
    db_path: String,
    session_id: String,
    target_id: String,
    input_id: String,
    seen_at_ms: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value =
        heartbeat_session_target_run(&conn, &session_id, &target_id, &input_id, seen_at_ms as i64)
            .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `finishSessionTargetRun` port. `status` is a JS string or null/undefined;
/// `tokens_used_delta` is a JS number or null/undefined.
#[napi]
pub fn finish_session_target_run_json(
    db_path: String,
    session_id: String,
    target_id: String,
    input_id: String,
    ended_at_ms: f64,
    status: Option<String>,
    tokens_used_delta: Option<f64>,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value = finish_session_target_run(
        &conn,
        &session_id,
        &target_id,
        &input_id,
        ended_at_ms as i64,
        status.as_deref(),
        tokens_used_delta.map(|v| v as i64),
    )
    .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `recoverInterruptedSessionTargetRun` port.
#[napi]
pub fn recover_interrupted_session_target_run_json(
    db_path: String,
    session_id: String,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value =
        recover_interrupted_session_target_run(&conn, &session_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `accountSessionTargetUsage` port. `now` is injected (TS `Date.now()`); the deltas are JS
/// numbers or null/undefined.
#[napi]
pub fn account_session_target_usage_json(
    db_path: String,
    session_id: String,
    target_id: String,
    tokens_used_delta: Option<f64>,
    time_used_seconds_delta: Option<f64>,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value = account_session_target_usage(
        &conn,
        &session_id,
        &target_id,
        tokens_used_delta.map(|v| v as i64),
        time_used_seconds_delta.map(|v| v as i64),
        now as i64,
    )
    .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// In-memory DB with the real session schema, one seeded parent session (`time_updated` starts at 100
    /// so the `max()` touch moves it forward) and a seeded `session_target` row (status defaults `active`,
    /// fixed `target_id`, no active run) so the FK + CHECK constraints pass.
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
        conn.execute(
            "insert into session_target (session_id, target_id, objective, status, time_created, time_updated) \
             values ('s1','t1','obj','active',100,100)",
            [],
        )
        .expect("invariant: seed target");
        conn
    }

    fn session_time_updated(conn: &Connection) -> i64 {
        conn.query_row("select time_updated from session where id='s1'", [], |r| {
            r.get(0)
        })
        .expect("read session time_updated")
    }

    #[test]
    fn start_creates_run_defaults_and_touches() {
        let conn = db();
        let out = start_session_target_run(&conn, "s1", "t1", "in1", 5_000).expect("start ok");
        assert_eq!(out["activeInputId"], serde_json::json!("in1"));
        assert_eq!(out["activeRunStartedAtMs"], serde_json::json!(5_000));
        assert_eq!(out["activeRunLastSeenAtMs"], serde_json::json!(5_000));
        assert_eq!(out["time"]["updated"], serde_json::json!(5_000));
        assert_eq!(session_time_updated(&conn), 5_000, "touched");
    }

    #[test]
    fn start_clamps_negative_start_to_zero() {
        let conn = db();
        let out = start_session_target_run(&conn, "s1", "t1", "in1", -8_000).expect("start ok");
        assert_eq!(
            out["activeRunStartedAtMs"],
            serde_json::json!(0),
            "Math.max(0, -8000) = 0"
        );
    }

    #[test]
    fn start_returns_current_read_when_status_not_active() {
        let conn = db();
        // Non-active target: the `status = 'active'` guard yields zero changes -> plain read, no touch.
        conn.execute(
            "update session_target set status='paused' where session_id='s1'",
            [],
        )
        .expect("pause");
        conn.execute("update session set time_updated = 100 where id='s1'", [])
            .expect("reset clock");
        let out = start_session_target_run(&conn, "s1", "t1", "in1", 9_000).expect("ok");
        assert_eq!(out["status"], serde_json::json!("paused"));
        assert_eq!(
            out["activeInputId"],
            serde_json::Value::Null,
            "no run stamped on guard hit"
        );
        assert_eq!(
            session_time_updated(&conn),
            100,
            "no touch on zero-change path"
        );
    }

    #[test]
    fn heartbeat_bumps_seen_at_forward_only() {
        let conn = db();
        start_session_target_run(&conn, "s1", "t1", "in1", 5_000).expect("start");
        conn.execute("update session set time_updated = 5_000 where id='s1'", [])
            .expect("sync clock");
        let out = heartbeat_session_target_run(&conn, "s1", "t1", "in1", 8_000).expect("hb");
        assert_eq!(out["activeRunLastSeenAtMs"], serde_json::json!(8_000));
        // Backwards heartbeat never regresses the last-seen value.
        let out = heartbeat_session_target_run(&conn, "s1", "t1", "in1", 6_000).expect("hb back");
        assert_eq!(
            out["activeRunLastSeenAtMs"],
            serde_json::json!(8_000),
            "max(coalesce(...)) never moves last-seen back"
        );
    }

    #[test]
    fn heartbeat_returns_current_read_when_input_mismatch() {
        let conn = db();
        start_session_target_run(&conn, "s1", "t1", "in1", 5_000).expect("start");
        // Wrong input id: guard fails -> zero changes -> plain read (run fields stay from start).
        let out = heartbeat_session_target_run(&conn, "s1", "t1", "WRONG", 9_000).expect("ok");
        assert_eq!(
            out["activeRunLastSeenAtMs"],
            serde_json::json!(5_000),
            "unchanged on guard hit"
        );
    }

    #[test]
    fn finish_sets_terminal_status_clears_run_and_adds_duration() {
        let conn = db();
        start_session_target_run(&conn, "s1", "t1", "in1", 0).expect("start at 0");
        // 1500ms elapsed -> ceil(1.5) = 2 seconds; token delta 100.
        let out =
            finish_session_target_run(&conn, "s1", "t1", "in1", 1_500, Some("complete"), Some(100))
                .expect("finish");
        assert_eq!(out["status"], serde_json::json!("complete"));
        assert_eq!(out["tokensUsed"], serde_json::json!(100));
        assert_eq!(
            out["timeUsedSeconds"],
            serde_json::json!(2),
            "ceil(1500/1000)=2"
        );
        assert_eq!(out["activeInputId"], serde_json::Value::Null);
        assert_eq!(out["activeRunStartedAtMs"], serde_json::Value::Null);
        assert_eq!(out["activeRunLastSeenAtMs"], serde_json::Value::Null);
    }

    #[test]
    fn finish_auto_budget_limited_when_no_status_override() {
        let conn = db();
        conn.execute(
            "update session_target set token_budget=100 where session_id='s1'",
            [],
        )
        .expect("budget");
        start_session_target_run(&conn, "s1", "t1", "in1", 0).expect("start");
        // No status override; tokenDelta 100 reaches the 100 budget -> budget_limited.
        let out = finish_session_target_run(&conn, "s1", "t1", "in1", 1_000, None, Some(100))
            .expect("finish");
        assert_eq!(out["status"], serde_json::json!("budget_limited"));
    }

    #[test]
    fn finish_returns_current_read_when_run_mismatch() {
        let conn = db();
        // No active run started yet: activeRunStartedAtMs is null -> early guard returns current, no write.
        conn.execute("update session set time_updated = 100 where id='s1'", [])
            .expect("reset");
        let out =
            finish_session_target_run(&conn, "s1", "t1", "in1", 9_000, Some("complete"), Some(500))
                .expect("ok");
        assert_eq!(
            out["tokensUsed"],
            serde_json::json!(0),
            "no accounting on guard hit"
        );
        assert_eq!(out["status"], serde_json::json!("active"));
        assert_eq!(session_time_updated(&conn), 100, "no touch on guard hit");
    }

    #[test]
    fn recover_flips_active_running_to_paused_settling_at_last_seen() {
        let conn = db();
        start_session_target_run(&conn, "s1", "t1", "in1", 10_000).expect("start");
        heartbeat_session_target_run(&conn, "s1", "t1", "in1", 13_000).expect("hb");
        // endedAt = last_seen(13000) ?? started; timeDelta = ceil((13000-10000)/1000) = 3; active -> paused.
        let out = recover_interrupted_session_target_run(&conn, "s1").expect("recover");
        assert_eq!(out["status"], serde_json::json!("paused"));
        assert_eq!(out["timeUsedSeconds"], serde_json::json!(3));
        assert_eq!(out["activeInputId"], serde_json::Value::Null);
        assert_eq!(out["activeRunStartedAtMs"], serde_json::Value::Null);
        assert_eq!(out["activeRunLastSeenAtMs"], serde_json::Value::Null);
    }

    #[test]
    fn recover_returns_current_read_when_no_active_run() {
        let conn = db();
        conn.execute("update session set time_updated = 100 where id='s1'", [])
            .expect("reset");
        // No active input -> guard returns current (the seeded idle row), no write, no touch.
        let out = recover_interrupted_session_target_run(&conn, "s1").expect("ok");
        assert_eq!(out["status"], serde_json::json!("active"));
        assert_eq!(out["timeUsedSeconds"], serde_json::json!(0));
        assert_eq!(session_time_updated(&conn), 100, "no touch on guard hit");
    }

    #[test]
    fn account_increments_counters_and_is_idempotent_on_zero_delta() {
        let conn = db();
        let out = account_session_target_usage(&conn, "s1", "t1", Some(50), Some(7), 4_000)
            .expect("account");
        assert_eq!(out["tokensUsed"], serde_json::json!(50));
        assert_eq!(out["timeUsedSeconds"], serde_json::json!(7));
        assert_eq!(
            out["time"]["updated"],
            serde_json::json!(4_000),
            "plain set time_updated=now"
        );
        assert_eq!(session_time_updated(&conn), 4_000);

        // Zero-delta early-return: no write (counters unchanged), no touch (clock stays).
        conn.execute("update session set time_updated = 100 where id='s1'", [])
            .expect("reset clock");
        let out2 = account_session_target_usage(&conn, "s1", "t1", Some(0), Some(0), 9_000)
            .expect("account zero");
        assert_eq!(out2["tokensUsed"], serde_json::json!(50), "unchanged");
        assert_eq!(
            out2["time"]["updated"],
            serde_json::json!(4_000),
            "time_updated unchanged"
        );
        assert_eq!(
            session_time_updated(&conn),
            100,
            "no touch on zero-delta path"
        );
    }

    #[test]
    fn account_clamps_negative_delta_to_zero() {
        let conn = db();
        let out = account_session_target_usage(&conn, "s1", "t1", Some(-999), Some(-1), 3_000)
            .expect("account");
        // Both clamp to 0 -> early return, no write.
        assert_eq!(out["tokensUsed"], serde_json::json!(0));
        assert_eq!(
            out["time"]["updated"],
            serde_json::json!(100),
            "untouched (seed value)"
        );
    }

    #[test]
    fn account_returns_current_read_when_target_id_mismatch() {
        let conn = db();
        conn.execute("update session set time_updated = 100 where id='s1'", [])
            .expect("reset");
        // Wrong target_id -> zero changes -> plain read (current row), no touch.
        let out = account_session_target_usage(&conn, "s1", "WRONG", Some(500), Some(10), 8_000)
            .expect("ok");
        assert_eq!(out["targetID"], serde_json::json!("t1"));
        assert_eq!(out["tokensUsed"], serde_json::json!(0), "no accounting");
        assert_eq!(
            session_time_updated(&conn),
            100,
            "no touch on zero-change path"
        );
    }

    #[test]
    fn touch_session_max_never_moves_clock_backwards() {
        let conn = db();
        start_session_target_run(&conn, "s1", "t1", "in1", 5_000).expect("start");
        conn.execute("update session set time_updated = 20_000 where id='s1'", [])
            .expect("advance session clock");
        // A smaller later now keeps the newer session clock (max).
        heartbeat_session_target_run(&conn, "s1", "t1", "in1", 6_000).expect("hb");
        assert_eq!(
            session_time_updated(&conn),
            20_000,
            "max(time_updated, ?) preserves the newer session clock"
        );
    }
}
