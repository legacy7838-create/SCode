//! targets family — SQL ported verbatim from
//! `apps/zcode-cli/packages/adapters/src/storage/session-target.ts` (458 lines,
//! 13 distinct statements incl. the `case` status clauses). Row decoding stays
//! on the TS side: every result is a raw `session_target` row array with legacy
//! column names (0/1 rows for single-row reads).

use serde_json::Value;

use super::{js_f64, js_i64, js_null, js_opt_str, js_str, Ctx, StoreError};
use crate::jsjson::JsValue;

// ── verbatim SQL (session-target.ts) ─────────────────────────────────────────

const SELECT_SQL: &str = "select * from session_target where session_id = ?";

const SET_TARGET_SQL: &str = r#"
    insert into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
    ) values (?, ?, ?, null, ?, ?, 0, 0, ?, ?)
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
      time_updated = excluded.time_updated
    "#;

const CLONE_TARGET_SQL: &str = r#"
    insert into session_target (
      session_id,
      target_id,
      objective,
      summary_title,
      status,
      token_budget,
      tokens_used,
      time_used_seconds,
      active_input_id,
      active_run_started_at,
      active_run_last_seen_at,
      time_created,
      time_updated
    ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?)
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
      time_updated = excluded.time_updated
    "#;

const CREATE_TARGET_SQL: &str = r#"
    insert or ignore into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
    ) values (?, ?, ?, null, 'active', ?, 0, 0, ?, ?)
    "#;

const UPDATE_STATUS_SQL: &str = r#"
      update session_target
      set status = ?, time_updated = ?
      where session_id = ?
      "#;

const START_RUN_SQL: &str = r#"
      update session_target
      set
        active_input_id = ?,
        active_run_started_at = ?,
        active_run_last_seen_at = ?,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and status = 'active'
      "#;

const HEARTBEAT_RUN_SQL: &str = r#"
      update session_target
      set
        active_run_last_seen_at = max(coalesce(active_run_last_seen_at, 0), ?),
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at is not null
      "#;

const FINISH_RUN_SQL: &str = r#"
      update session_target
      set
        tokens_used = tokens_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when ? is not null then ?
          when status = 'active' and token_budget is not null and tokens_used + ? >= token_budget then 'budget_limited'
          else status
        end,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      "#;

const RECOVER_RUN_SQL: &str = r#"
      update session_target
      set
        time_used_seconds = time_used_seconds + ?,
        status = ?,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      "#;

const ACCOUNT_USAGE_SQL: &str = r#"
      update session_target
      set
        tokens_used = tokens_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when status = 'active' and token_budget is not null and tokens_used + ? >= token_budget then 'budget_limited'
          else status
        end,
        time_updated = ?
      where session_id = ? and target_id = ?
      "#;

const UPDATE_SUMMARY_SQL: &str = r#"
      update session_target
      set summary_title = ?, time_updated = ?
      where session_id = ? and target_id = ?
      "#;

const DELETE_SQL: &str = "delete from session_target where session_id = ?";

const TOUCH_SESSION_SQL: &str =
  "update session set time_updated = max(time_updated, ?) where id = ?";

// ── shared helpers ───────────────────────────────────────────────────────────

/// `touchSessionForTarget` (session-target.ts): `update session set
/// time_updated = max(time_updated, ?)`; a failing `.run()` throws in legacy
/// too, so errors propagate.
fn touch_session(ctx: &Ctx, session_id: &str, time_updated: i64) -> Result<(), StoreError> {
  super::execute(ctx, TOUCH_SESSION_SQL, &[js_i64(time_updated), js_str(session_id)])
}

/// `readSessionTarget` as a raw row array (0/1 rows).
fn read_rows(ctx: &Ctx, session_id: &str) -> Result<String, StoreError> {
  super::query_rows(ctx, SELECT_SQL, &[js_str(session_id)])
}

fn read_row(ctx: &Ctx, session_id: &str) -> Result<Option<Value>, StoreError> {
  super::query_row(ctx, SELECT_SQL, &[js_str(session_id)])
}

/// `mustReadTarget`: read-back after a write with the exact legacy message.
fn must_read(ctx: &Ctx, session_id: &str) -> Result<String, StoreError> {
  let row = read_row(ctx, session_id)?
    .ok_or_else(|| StoreError::op(format!("Session target not found after write: {session_id}")))?;
  Ok(super::single_row_array(row))
}

/// Legacy `SessionGoal | null` early returns → row array (0/1 rows).
fn row_array(row: Option<Value>) -> String {
  match row {
    Some(value) => super::single_row_array(value),
    None => "[]".to_string(),
  }
}

fn row_str<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
  row.get(key).and_then(Value::as_str)
}

fn row_i64(row: &Value, key: &str) -> Option<i64> {
  row.get(key).and_then(Value::as_i64)
}

/// JS number payload field with `?? null` semantics (absent/null → SQL NULL).
fn opt_number(payload: &JsValue, key: &str) -> Result<JsValue, StoreError> {
  Ok(match super::opt_f64(payload, key)? {
    Some(value) => js_f64(value),
    None => js_null(),
  })
}

/// `elapsedSecondsBetween` (session-target.ts tail):
/// `Math.max(0, Math.ceil((endedAtMs - startedAtMs) / 1000))`.
fn elapsed_seconds(started_at_ms: i64, ended_at_ms: i64) -> i64 {
  let diff = ended_at_ms - started_at_ms;
  if diff <= 0 {
    0
  } else {
    (diff + 999) / 1000
  }
}

// ── ops ──────────────────────────────────────────────────────────────────────

/// Payload: `{ sessionID }` → row array (0 or 1 raw `session_target` rows).
pub fn read_target(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  read_rows(ctx, &session_id)
}

/// Payload: `{ sessionID, targetID, objective, status, tokenBudget, nowMs }`
/// (`targetID` pre-generated by TS: `target_${now.toString(36)}_${uuid}`;
/// `tokenBudget` number|null) → read-back row array (1 row).
pub fn set_target(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let target_id = super::req_str(payload, "targetID")?;
  let objective = super::req_str(payload, "objective")?;
  let status = super::req_str(payload, "status")?;
  let token_budget = opt_number(payload, "tokenBudget")?;
  let now_ms = super::req_i64(payload, "nowMs")?;
  super::execute(
    ctx,
    SET_TARGET_SQL,
    &[
      js_str(&session_id),
      js_str(&target_id),
      js_str(&objective),
      js_str(&status),
      token_budget,
      js_i64(now_ms),
      js_i64(now_ms),
    ],
  )?;
  touch_session(ctx, &session_id, now_ms)?;
  must_read(ctx, &session_id)
}

/// Payload: `{ sessionID, targetID, objective, summaryTitle, status,
/// tokenBudget, tokensUsed, timeUsedSeconds, timeCreated, timeUpdated, nowMs }`
/// (target fields copied from legacy `input.source`; `summaryTitle` and
/// `tokenBudget` may be null) → read-back row array (1 row).
pub fn clone_target_for_fork(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let target_id = super::req_str(payload, "targetID")?;
  let objective = super::req_str(payload, "objective")?;
  let summary_title = super::opt_str(payload, "summaryTitle")?;
  let status = super::req_str(payload, "status")?;
  let token_budget = opt_number(payload, "tokenBudget")?;
  let tokens_used = super::req_i64(payload, "tokensUsed")?;
  let time_used_seconds = super::req_i64(payload, "timeUsedSeconds")?;
  let time_created = super::req_i64(payload, "timeCreated")?;
  let time_updated = super::req_i64(payload, "timeUpdated")?;
  let now_ms = super::req_i64(payload, "nowMs")?;
  super::execute(
    ctx,
    CLONE_TARGET_SQL,
    &[
      js_str(&session_id),
      js_str(&target_id),
      js_str(&objective),
      js_opt_str(summary_title.as_deref()),
      js_str(&status),
      token_budget,
      js_i64(tokens_used),
      js_i64(time_used_seconds),
      js_i64(time_created),
      js_i64(time_updated),
    ],
  )?;
  touch_session(ctx, &session_id, now_ms)?;
  must_read(ctx, &session_id)
}

/// Payload: `{ sessionID, targetID, objective, tokenBudget, nowMs }` → `[]`
/// when `insert or ignore` skipped the write (the existing row keeps its
/// `target_id`; no session touch), else read-back row array (1 row).
pub fn create_target(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let target_id = super::req_str(payload, "targetID")?;
  let objective = super::req_str(payload, "objective")?;
  let token_budget = opt_number(payload, "tokenBudget")?;
  let now_ms = super::req_i64(payload, "nowMs")?;
  super::execute(
    ctx,
    CREATE_TARGET_SQL,
    &[
      js_str(&session_id),
      js_str(&target_id),
      js_str(&objective),
      token_budget,
      js_i64(now_ms),
      js_i64(now_ms),
    ],
  )?;
  let current = read_row(ctx, &session_id)?;
  let created = match &current {
    Some(row) => row_str(row, "target_id") == Some(target_id.as_str()),
    None => false,
  };
  if !created {
    return Ok("[]".to_string());
  }
  touch_session(ctx, &session_id, now_ms)?;
  must_read(ctx, &session_id)
}

/// Payload: `{ sessionID, status, nowMs }` → `[]` when no row matched (no
/// session touch), else read-back row array (1 row).
pub fn update_target_status(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let status = super::req_str(payload, "status")?;
  let now_ms = super::req_i64(payload, "nowMs")?;
  let changes = super::execute_changes(
    ctx,
    UPDATE_STATUS_SQL,
    &[js_str(&status), js_i64(now_ms), js_str(&session_id)],
  )?;
  if changes == 0 {
    return Ok("[]".to_string());
  }
  touch_session(ctx, &session_id, now_ms)?;
  must_read(ctx, &session_id)
}

/// Payload: `{ sessionID, targetID, inputID, startedAtMs }` (`startedAt` =
/// `max(0, startedAtMs)` computed natively) → current-row array when no row
/// matched (plain read, no session touch), else read-back row array (1 row).
pub fn start_target_run(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let target_id = super::req_str(payload, "targetID")?;
  let input_id = super::req_str(payload, "inputID")?;
  let started_at = super::req_i64(payload, "startedAtMs").map(|ms| ms.max(0))?;
  let changes = super::execute_changes(
    ctx,
    START_RUN_SQL,
    &[
      js_str(&input_id),
      js_i64(started_at),
      js_i64(started_at),
      js_i64(started_at),
      js_str(&session_id),
      js_str(&target_id),
    ],
  )?;
  if changes == 0 {
    return read_rows(ctx, &session_id);
  }
  touch_session(ctx, &session_id, started_at)?;
  must_read(ctx, &session_id)
}

/// Payload: `{ sessionID, targetID, inputID, seenAtMs }` (`seenAt` =
/// `max(0, seenAtMs)` computed natively) → current-row array when no row
/// matched (plain read, no session touch), else read-back row array (1 row).
pub fn heartbeat_target_run(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let target_id = super::req_str(payload, "targetID")?;
  let input_id = super::req_str(payload, "inputID")?;
  let seen_at = super::req_i64(payload, "seenAtMs").map(|ms| ms.max(0))?;
  let changes = super::execute_changes(
    ctx,
    HEARTBEAT_RUN_SQL,
    &[
      js_i64(seen_at),
      js_i64(seen_at),
      js_str(&session_id),
      js_str(&target_id),
      js_str(&input_id),
    ],
  )?;
  if changes == 0 {
    return read_rows(ctx, &session_id);
  }
  touch_session(ctx, &session_id, seen_at)?;
  must_read(ctx, &session_id)
}

/// Payload: `{ sessionID, targetID, inputID, endedAtMs, status?,
/// tokensUsedDelta? }` (absent keys = legacy `undefined`) → current-row array
/// when the guard fails (missing row, `target_id`/`active_input_id` mismatch,
/// or no active run) or the UPDATE matched nothing (no session touch), else
/// read-back row array (1 row). `status` is bound twice (`?? null`);
/// `endedAt = max(0, endedAtMs)`, `tokenDelta = max(0, tokensUsedDelta ?? 0)`,
/// `timeDelta = max(0, ceil((endedAt - active_run_started_at) / 1000))`.
pub fn finish_target_run(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let target_id = super::req_str(payload, "targetID")?;
  let input_id = super::req_str(payload, "inputID")?;
  let ended_at_ms = super::req_i64(payload, "endedAtMs")?;
  let status = super::opt_str(payload, "status")?;
  let tokens_used_delta = super::opt_f64(payload, "tokensUsedDelta")?.unwrap_or(0.0).max(0.0);

  let current = read_row(ctx, &session_id)?;
  let started_at = match &current {
    Some(row)
      if row_str(row, "target_id") == Some(target_id.as_str())
        && row_str(row, "active_input_id") == Some(input_id.as_str()) =>
    {
      row_i64(row, "active_run_started_at")
    }
    _ => None,
  };
  let started_at = match started_at {
    Some(value) => value,
    None => return Ok(row_array(current)),
  };

  let ended_at = ended_at_ms.max(0);
  let time_delta = elapsed_seconds(started_at, ended_at);
  let changes = super::execute_changes(
    ctx,
    FINISH_RUN_SQL,
    &[
      js_f64(tokens_used_delta),
      js_i64(time_delta),
      js_opt_str(status.as_deref()),
      js_opt_str(status.as_deref()),
      js_f64(tokens_used_delta),
      js_i64(ended_at),
      js_str(&session_id),
      js_str(&target_id),
      js_str(&input_id),
      js_i64(started_at),
    ],
  )?;
  if changes == 0 {
    return read_rows(ctx, &session_id);
  }
  touch_session(ctx, &session_id, ended_at)?;
  must_read(ctx, &session_id)
}

/// Payload: `{ sessionID }` → current-row array when there is nothing to
/// recover (missing row, null/empty `active_input_id`, or null
/// `active_run_started_at`) or the UPDATE matched nothing (no session touch),
/// else read-back row array (1 row). Settles against
/// `active_run_last_seen_at ?? active_run_started_at` (never `Date.now()`) and
/// flips `active` → `paused`.
pub fn recover_interrupted_target_run(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;

  let current = read_row(ctx, &session_id)?;
  // (target_id, active_input_id, active_run_started_at, last_seen, status) —
  // all owned so the early return can hand `current` back untouched.
  let plan = match &current {
    Some(row) => {
      let input_id = row_str(row, "active_input_id").filter(|id| !id.is_empty());
      match (input_id, row_i64(row, "active_run_started_at")) {
        (Some(input_id), Some(started_at)) => Some((
          row_str(row, "target_id").map(str::to_string),
          input_id.to_string(),
          started_at,
          row_i64(row, "active_run_last_seen_at"),
          row_str(row, "status").map(str::to_string),
        )),
        _ => None,
      }
    }
    None => None,
  };
  let (target_id, input_id, started_at, last_seen, status) = match plan {
    Some(plan) => plan,
    None => return Ok(row_array(current)),
  };

  let ended_at = last_seen.unwrap_or(started_at);
  let time_delta = elapsed_seconds(started_at, ended_at);
  let next_status = js_opt_str(match status.as_deref() {
    Some("active") => Some("paused"),
    other => other,
  });
  let changes = super::execute_changes(
    ctx,
    RECOVER_RUN_SQL,
    &[
      js_i64(time_delta),
      next_status,
      js_i64(ended_at),
      js_str(&session_id),
      js_opt_str(target_id.as_deref()),
      js_str(&input_id),
      js_i64(started_at),
    ],
  )?;
  if changes == 0 {
    return read_rows(ctx, &session_id);
  }
  touch_session(ctx, &session_id, ended_at)?;
  must_read(ctx, &session_id)
}

/// Payload: `{ sessionID, targetID, tokensUsedDelta?, timeUsedSecondsDelta?,
/// nowMs }` → current-row array when both clamped deltas are 0 (no SQL, no
/// session touch) or the UPDATE matched nothing, else read-back row array
/// (1 row).
pub fn account_target_usage(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let target_id = super::req_str(payload, "targetID")?;
  let token_delta = super::opt_f64(payload, "tokensUsedDelta")?.unwrap_or(0.0).max(0.0);
  let time_delta = super::opt_f64(payload, "timeUsedSecondsDelta")?.unwrap_or(0.0).max(0.0);
  let now_ms = super::req_i64(payload, "nowMs")?;
  if token_delta == 0.0 && time_delta == 0.0 {
    return read_rows(ctx, &session_id);
  }
  let changes = super::execute_changes(
    ctx,
    ACCOUNT_USAGE_SQL,
    &[
      js_f64(token_delta),
      js_f64(time_delta),
      js_f64(token_delta),
      js_i64(now_ms),
      js_str(&session_id),
      js_str(&target_id),
    ],
  )?;
  if changes == 0 {
    return read_rows(ctx, &session_id);
  }
  touch_session(ctx, &session_id, now_ms)?;
  must_read(ctx, &session_id)
}

/// Payload: `{ sessionID, targetID, summaryTitle, nowMs }` → current-row array
/// when no row matched (no session touch), else read-back row array (1 row).
pub fn update_target_summary_title(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let target_id = super::req_str(payload, "targetID")?;
  let summary_title = super::req_str(payload, "summaryTitle")?;
  let now_ms = super::req_i64(payload, "nowMs")?;
  let changes = super::execute_changes(
    ctx,
    UPDATE_SUMMARY_SQL,
    &[
      js_str(&summary_title),
      js_i64(now_ms),
      js_str(&session_id),
      js_str(&target_id),
    ],
  )?;
  if changes == 0 {
    return read_rows(ctx, &session_id);
  }
  touch_session(ctx, &session_id, now_ms)?;
  must_read(ctx, &session_id)
}

/// Payload: `{ sessionID, nowMs }` → `"true"` when the row was deleted
/// (session touched), `"false"` when nothing matched (no session touch).
pub fn clear_target(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let now_ms = super::req_i64(payload, "nowMs")?;
  let changes = super::execute_changes(ctx, DELETE_SQL, &[js_str(&session_id)])?;
  if changes == 0 {
    return Ok("false".to_string());
  }
  touch_session(ctx, &session_id, now_ms)?;
  Ok("true".to_string())
}
