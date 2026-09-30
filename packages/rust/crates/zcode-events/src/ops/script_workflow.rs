//! script workflow family — SQL ported verbatim from
//! `adapters/src/storage/session-store/repositories/script-workflow-runs.ts`
//! and `script-workflow-activities.ts`. Rows cross the boundary raw (legacy
//! column names); `decodeRun`/`decodeActivity`/`decodeDefinition`/`decodeEvent`/
//! `decodeTaskLink` stay in the frozen TS codecs.

use serde_json::Value;

use super::{js_f64, js_i64, js_null, js_str, single_row_array, Ctx, StoreError};
use crate::jsjson::{parse as js_parse, stringify, JsValue};

// ── shared statements ────────────────────────────────────────────────────────

/// `getScriptWorkflowRun`'s statement — also the current-row read and the
/// `mustGetRun` read-back behind `updateScriptWorkflowRun`.
const SELECT_RUN_SQL: &str = "select * from workflow_run where id = ?";

/// `getActivity`'s statement — also the current-row read and the
/// `mustGetActivity` read-back behind `updateScriptWorkflowActivity`.
const SELECT_ACTIVITY_SQL: &str = "select * from workflow_activity where id = ?";

/// `mustGetDefinition`'s read-back behind `upsertScriptWorkflowDefinition`.
const SELECT_DEFINITION_SQL: &str = "select * from workflow_definition where id = ?";

/// `mustGetEvent`'s read-back behind `appendScriptWorkflowEvent`.
const SELECT_EVENT_SQL: &str = "select * from workflow_event where run_id = ? and sequence = ?";

/// `mustGetTaskLink`'s read-back behind `createSessionTaskLink`.
const SELECT_TASK_LINK_SQL: &str = "select * from session_task_link where child_session_id = ?";

// ── payload helpers ──────────────────────────────────────────────────────────

/// The i-th argument of a `{"v": [...]}` payload.
fn arg(v: &[JsValue], index: usize) -> Result<&JsValue, StoreError> {
  v.get(index)
    .ok_or_else(|| StoreError::op(format!("missing positional argument at index {index}")))
}

/// `x ?? null` for legacy `.run(…, x ?? null, …)` arguments.
fn or_null(object: &JsValue, key: &str) -> JsValue {
  match object.get(key) {
    None | Some(JsValue::Null) => JsValue::Null,
    Some(value) => value.clone(),
  }
}

/// JS truthiness for the legacy `if (x)` guards; an absent key is `undefined`
/// (falsy).
fn js_truthy(value: Option<&JsValue>) -> bool {
  match value {
    None => false,
    Some(JsValue::Null) => false,
    Some(JsValue::Bool(flag)) => *flag,
    Some(JsValue::Number(number)) => *number != 0.0 && !number.is_nan(),
    Some(JsValue::Str(units)) => !units.is_empty(),
    Some(JsValue::Arr(_)) => true,
    Some(JsValue::Obj(_)) => true,
  }
}

/// Raw row column → bindable JS value (`rows_to_json` emits scalar rows only).
fn json_to_js(value: &Value) -> JsValue {
  match value {
    Value::Null => js_null(),
    Value::Number(number) => number
      .as_i64()
      .map(js_i64)
      .or_else(|| number.as_f64().map(js_f64))
      .unwrap_or_else(js_null),
    Value::String(text) => js_str(text),
    // Not reachable for `rows_to_json` output (NULL / number / string).
    _ => js_null(),
  }
}

/// Legacy `input.key === undefined ? (current.<column> ?? null) : input.key`:
/// an absent key (== JS `undefined`) keeps the current column (SQL NULL stays
/// NULL), an explicit `null` is preserved as SQL NULL, any other value is
/// written verbatim.
fn merge_column(input: &JsValue, key: &str, row: &Value, column: &str) -> JsValue {
  match input.get(key) {
    None => row.get(column).map_or_else(js_null, json_to_js),
    Some(value) => value.clone(),
  }
}

/// Legacy `input.key ?? current.<column>` (JS `??`: absent *and* explicit
/// `null` fall through to the current column) — `status`/`budgetSpent` of the
/// run update and `status` of the activity update.
fn merge_coalesce(input: &JsValue, key: &str, row: &Value, column: &str) -> JsValue {
  match input.get(key) {
    Some(value) if !value.is_null() => value.clone(),
    _ => row.get(column).map_or_else(js_null, json_to_js),
  }
}

/// Legacy `input.key === undefined ? encodeJson(current.<column>) :
/// encodeJson(input.key)`:
/// * key absent → the column's JSON round-trip — `null`/`""` → SQL NULL, else
///   `JSON.parse` + `JSON.stringify` (invalid JSON throws like legacy);
/// * key present → `encode_json_field` (explicit `null` → SQL NULL, else the
///   JS-stringified subtree).
fn merge_json_column(
  input: &JsValue,
  key: &str,
  row: &Value,
  column: &str,
) -> Result<JsValue, StoreError> {
  match input.get(key) {
    None => match row.get(column).and_then(Value::as_str) {
      None | Some("") => Ok(js_null()),
      Some(json) => Ok(js_str(&stringify(&js_parse(json)?))),
    },
    Some(_) => super::encode_json_field(input, key),
  }
}

/// Legacy `row?.next_attempt ?? 1` / `row?.next_sequence ?? 1` (the aggregate
/// SELECT always yields one row).
fn next_counter(row: Option<Value>, key: &str) -> i64 {
  row.as_ref()
    .and_then(|row| row.get(key))
    .and_then(Value::as_i64)
    .unwrap_or(1)
}

/// Legacy `input.status ?? "queued"` for `createScriptWorkflowActivity`.
fn activity_status(payload: &JsValue) -> JsValue {
  match payload.get("status") {
    Some(value) if !value.is_null() => value.clone(),
    _ => js_str("queued"),
  }
}

// ── ops ──────────────────────────────────────────────────────────────────────

/// Payload: `{"v": [id, name, source, scope, trusted01, enabled01, scriptPath,
/// scriptHash, metaJson, nowMs, nowMs]}` — the exact 11 args of legacy
/// `.run(...)` (TS pre-computes the `scope` default `builtin`/`explicit`,
/// trusted/enabled as 0/1, `JSON.stringify(meta)` and both timestamps) →
/// `[definitionRow]`: verbatim INSERT + ON CONFLICT, then the
/// `workflow_definition` read-back (error
/// `Workflow definition not found after write: {id}`). Raw row, legacy column
/// names.
pub fn upsert_definition(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = super::vlist(payload)?;
  super::execute(
    ctx,
    r#"
      insert into workflow_definition (
        id, name, source, scope, trusted, enabled, script_path, script_hash, meta_json,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        name = excluded.name,
        source = excluded.source,
        scope = excluded.scope,
        trusted = excluded.trusted,
        enabled = excluded.enabled,
        script_path = excluded.script_path,
        script_hash = excluded.script_hash,
        meta_json = excluded.meta_json,
        time_updated = excluded.time_updated
    "#,
    v,
  )?;
  let id = super::as_str(arg(v, 0)?, "v[0]")?;
  let row = super::query_required_row(ctx, SELECT_DEFINITION_SQL, &[js_str(&id)], || {
    format!("Workflow definition not found after write: {id}")
  })?;
  Ok(single_row_array(row))
}

/// Payload: `{"v": [id, definitionId, name, parentSessionId, cwd, scriptPath,
/// scriptHash, argsJson, argsHash, status, budgetTotal, statsJson, nowMs,
/// nowMs]}` — the exact 14 args of legacy `.run(...)` (TS pre-computes
/// `encodeJson(args)`, `encodeJson(stats)`, the `pending` status default and
/// both `Date.now()` timestamps; `'script'` and the null column literals live
/// in the SQL) → `[runRow]`: verbatim INSERT, then the `workflow_run`
/// read-back (error `Workflow run not found after write: {id}`). Raw row,
/// legacy column names.
pub fn create_run(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = super::vlist(payload)?;
  super::execute(
    ctx,
    r#"
      insert into workflow_run (
        id, definition_id, name, kind, parent_session_id, cwd, script_path, script_hash,
        args_json, args_hash, status, current_phase, budget_total, budget_spent,
        stats_json, failure_json, time_created, time_started, time_updated, time_completed
      ) values (?, ?, ?, 'script', ?, ?, ?, ?, ?, ?, ?, null, ?, 0, ?, null, ?, null, ?, null)
    "#,
    v,
  )?;
  let id = super::as_str(arg(v, 0)?, "v[0]")?;
  let row = super::query_required_row(ctx, SELECT_RUN_SQL, &[js_str(&id)], || {
    format!("Workflow run not found after write: {id}")
  })?;
  Ok(single_row_array(row))
}

/// Payload: `{ input: UpdateScriptWorkflowRunInput, nowMs: number }` →
/// `[runRow]`. Legacy read-modify-write: the current row is SELECTed first
/// (error `Workflow run not found: {id}`), then the verbatim UPDATE —
/// * `currentPhase` / `startedAt` / `completedAt`: key absent (== JS
///   `undefined`) keeps the current column (`column ?? null`), explicit `null`
///   is preserved as SQL NULL;
/// * `status` / `budgetSpent`: JS `??` — absent *and* explicit `null` fall
///   back to the current column;
/// * `stats` / `failure`: key absent → the column's JSON round-trip
///   (`null`/`""` → SQL NULL, else `JSON.parse` + `JSON.stringify`, invalid
///   JSON throws), key present → `encodeJson` (explicit `null` → SQL NULL);
/// * `time_updated = nowMs`.
/// Read-back error `Workflow run not found after write: {id}`. Raw row, legacy
/// column names.
pub fn update_run(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let input = super::field(payload, "input")?;
  let now = super::req_i64(payload, "nowMs")?;
  let id = super::req_str(input, "id")?;
  let current = super::query_row(ctx, SELECT_RUN_SQL, &[js_str(&id)])?
    .ok_or_else(|| StoreError::op(format!("Workflow run not found: {id}")))?;
  let values = vec![
    merge_coalesce(input, "status", &current, "status"),
    merge_column(input, "currentPhase", &current, "current_phase"),
    merge_coalesce(input, "budgetSpent", &current, "budget_spent"),
    merge_json_column(input, "stats", &current, "stats_json")?,
    merge_json_column(input, "failure", &current, "failure_json")?,
    merge_column(input, "startedAt", &current, "time_started"),
    js_i64(now),
    merge_column(input, "completedAt", &current, "time_completed"),
    js_str(&id),
  ];
  super::execute(
    ctx,
    r#"
      update workflow_run set
        status = ?,
        current_phase = ?,
        budget_spent = ?,
        stats_json = ?,
        failure_json = ?,
        time_started = ?,
        time_updated = ?,
        time_completed = ?
      where id = ?
    "#,
    &values,
  )?;
  let row = super::query_required_row(ctx, SELECT_RUN_SQL, &[js_str(&id)], || {
    format!("Workflow run not found after write: {id}")
  })?;
  Ok(single_row_array(row))
}

/// Payload: `{"v": [runId]}` → run rows (0/1) of
/// `select * from workflow_run where id = ?`; `[]` when missing. Raw rows,
/// legacy column names.
pub fn get_run(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::query_rows(ctx, SELECT_RUN_SQL, super::vlist(payload)?)
}

/// Payload: `{ cwd?: string, statuses?: string[], limit?: number | null }`
/// (absent keys == legacy `undefined`; an empty `statuses` array adds no
/// clause; `limit` binds only when > 0) → run rows of
/// `select * from workflow_run ${where} order by time_updated desc,
/// id desc${limit}`, clauses in legacy order `cwd = ?` then
/// `status in (?, …)`; parameters pushed in clause order, `limit` last. Raw
/// rows, legacy column names.
pub fn list_runs(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let mut clauses: Vec<String> = Vec::new();
  let mut values: Vec<JsValue> = Vec::new();

  // if (input.cwd)
  let cwd = super::field_opt(payload, "cwd");
  if js_truthy(cwd) {
    clauses.push("cwd = ?".to_string());
    values.push(cwd.unwrap().clone());
  }

  // if (input.statuses && input.statuses.length > 0)
  if let Some(statuses) = super::opt_arr(payload, "statuses")? {
    if !statuses.is_empty() {
      let placeholders = statuses
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
      clauses.push(format!("status in ({placeholders})"));
      values.extend(statuses.iter().cloned());
    }
  }

  // const limit = input.limit && input.limit > 0 ? input.limit : undefined;
  let limit_value = match super::field_opt(payload, "limit") {
    Some(value @ JsValue::Number(number)) if *number > 0.0 => Some(value),
    _ => None,
  };
  if let Some(limit) = limit_value {
    values.push(limit.clone());
  }

  let where_sql = if clauses.is_empty() {
    String::new()
  } else {
    format!("where {}", clauses.join(" and "))
  };
  let limit_sql = if limit_value.is_some() { " limit ?" } else { "" };
  let sql = format!(
    "select * from workflow_run {where_sql} order by time_updated desc, id desc{limit_sql}"
  );
  super::query_rows(ctx, &sql, &values)
}

/// Payload: `{ id, runId, parentActivityId: string | null, callIndex,
/// callPath, type, phase: string | null, label: string | null, inputHash,
/// prompt: string | null, optsJson: string | null (TS-pre-encoded
/// `encodeJson(opts)`), status, nowMs }` → `[activityRow]`. Verbatim attempt
/// SELECT (`coalesce(max(attempt), 0) + 1`, missing row → 1), verbatim INSERT
/// with the computed attempt and legacy `status ?? "queued"`, then the
/// `workflow_activity` read-back (error
/// `Workflow activity not found after write: {id}`). Raw row, legacy column
/// names.
pub fn create_activity(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let now = super::req_i64(payload, "nowMs")?;
  let id = super::req_str(payload, "id")?;
  let run_id = super::req_str(payload, "runId")?;
  let call_path = super::req_str(payload, "callPath")?;
  let attempt_row = super::query_row(
    ctx,
    r#"
      select coalesce(max(attempt), 0) + 1 as next_attempt
      from workflow_activity where run_id = ? and call_path = ?
    "#,
    &[js_str(&run_id), js_str(&call_path)],
  )?;
  let attempt = next_counter(attempt_row, "next_attempt");
  let values = vec![
    js_str(&id),
    js_str(&run_id),
    or_null(payload, "parentActivityId"),
    js_i64(super::req_i64(payload, "callIndex")?),
    js_str(&call_path),
    js_i64(attempt),
    js_str(&super::req_str(payload, "type")?),
    or_null(payload, "phase"),
    or_null(payload, "label"),
    js_str(&super::req_str(payload, "inputHash")?),
    or_null(payload, "prompt"),
    or_null(payload, "optsJson"),
    activity_status(payload),
    js_i64(now),
    js_i64(now),
  ];
  super::execute(
    ctx,
    r#"
      insert into workflow_activity (
        id, run_id, parent_activity_id, call_index, call_path, attempt, type, phase,
        label, input_hash, prompt, opts_json, status, child_session_id, result_json,
        error_json, time_created, time_started, time_updated, time_completed
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, null, ?, null)
    "#,
    &values,
  )?;
  let row = super::query_required_row(ctx, SELECT_ACTIVITY_SQL, &[js_str(&id)], || {
    format!("Workflow activity not found after write: {id}")
  })?;
  Ok(single_row_array(row))
}

/// Payload: `{ input: UpdateScriptWorkflowActivityInput, nowMs: number }` →
/// `[activityRow]`. Legacy read-modify-write: the current row is SELECTed
/// first (error `Workflow activity not found: {id}`), then the verbatim UPDATE —
/// * `childSessionId` / `startedAt` / `completedAt`: key absent (== JS
///   `undefined`) keeps the current column (`column ?? null`), explicit `null`
///   is preserved as SQL NULL;
/// * `status`: JS `??` — absent *and* explicit `null` fall back to the
///   current column;
/// * `result` / `error`: key absent → the column's JSON round-trip
///   (`null`/`""` → SQL NULL, else `JSON.parse` + `JSON.stringify`, invalid
///   JSON throws), key present → `encodeJson` (explicit `null` → SQL NULL);
/// * `time_updated = nowMs`.
/// Read-back error `Workflow activity not found after write: {id}`. Raw row,
/// legacy column names.
pub fn update_activity(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let input = super::field(payload, "input")?;
  let now = super::req_i64(payload, "nowMs")?;
  let id = super::req_str(input, "id")?;
  let current = super::query_row(ctx, SELECT_ACTIVITY_SQL, &[js_str(&id)])?
    .ok_or_else(|| StoreError::op(format!("Workflow activity not found: {id}")))?;
  let values = vec![
    merge_coalesce(input, "status", &current, "status"),
    merge_column(input, "childSessionId", &current, "child_session_id"),
    merge_json_column(input, "result", &current, "result_json")?,
    merge_json_column(input, "error", &current, "error_json")?,
    merge_column(input, "startedAt", &current, "time_started"),
    js_i64(now),
    merge_column(input, "completedAt", &current, "time_completed"),
    js_str(&id),
  ];
  super::execute(
    ctx,
    r#"
      update workflow_activity set
        status = ?,
        child_session_id = ?,
        result_json = ?,
        error_json = ?,
        time_started = ?,
        time_updated = ?,
        time_completed = ?
      where id = ?
    "#,
    &values,
  )?;
  let row = super::query_required_row(ctx, SELECT_ACTIVITY_SQL, &[js_str(&id)], || {
    format!("Workflow activity not found after write: {id}")
  })?;
  Ok(single_row_array(row))
}

/// Payload: `{"v": [runId, callPath, inputHash]}` → activity rows (0/1) of
/// the verbatim cached lookup (`status in ('completed', 'cached')`,
/// `order by attempt desc limit 1`). Raw rows, legacy column names.
pub fn find_cached_activity(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::query_rows(
    ctx,
    r#"
      select * from workflow_activity
      where run_id = ? and call_path = ? and input_hash = ? and status in ('completed', 'cached')
      order by attempt desc
      limit 1
    "#,
    super::vlist(payload)?,
  )
}

/// Payload: `{"v": [runId]}` → activity rows of
/// `select * from workflow_activity where run_id = ? order by call_index asc,
/// id asc`. Raw rows, legacy column names.
pub fn list_activities(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::query_rows(
    ctx,
    "select * from workflow_activity where run_id = ? order by call_index asc, id asc",
    super::vlist(payload)?,
  )
}

/// Payload: `{ id, runId, type, phase: string | null, activityId: string |
/// null, payloadJson: string | null (TS-pre-encoded `encodeJson(payload)`),
/// nowMs }` → `[eventRow]`. Verbatim sequence SELECT
/// (`coalesce(max(sequence), 0) + 1`, missing row → 1), verbatim INSERT, then
/// the `(run_id, sequence)` read-back (error
/// `Workflow event not found after write: {runId}:{sequence}`). Raw row, legacy
/// column names.
pub fn append_event(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let now = super::req_i64(payload, "nowMs")?;
  let id = super::req_str(payload, "id")?;
  let run_id = super::req_str(payload, "runId")?;
  let sequence_row = super::query_row(
    ctx,
    r#"
      select coalesce(max(sequence), 0) + 1 as next_sequence
      from workflow_event where run_id = ?
    "#,
    &[js_str(&run_id)],
  )?;
  let sequence = next_counter(sequence_row, "next_sequence");
  let values = vec![
    js_str(&id),
    js_str(&run_id),
    js_i64(sequence),
    js_str(&super::req_str(payload, "type")?),
    or_null(payload, "phase"),
    or_null(payload, "activityId"),
    or_null(payload, "payloadJson"),
    js_i64(now),
  ];
  super::execute(
    ctx,
    r#"
      insert into workflow_event (
        id, run_id, sequence, type, phase, activity_id, payload_json, time_created
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    "#,
    &values,
  )?;
  let row = super::query_required_row(ctx, SELECT_EVENT_SQL, &[js_str(&run_id), js_i64(sequence)], || {
    format!("Workflow event not found after write: {run_id}:{sequence}")
  })?;
  Ok(single_row_array(row))
}

/// Payload: `{ runId: string, limit: number | null }` (`limit <= 0` or absent
/// → the no-limit branch) → event rows ordered `sequence asc`: the two
/// verbatim branch statements (`… order by sequence desc limit ?` wrapped back
/// to ascending, or `… order by sequence asc`). Raw rows, legacy column names.
pub fn list_events(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let run_id = super::req_str(payload, "runId")?;
  // const limit = input.limit && input.limit > 0 ? input.limit : undefined;
  let limit_value = match super::field_opt(payload, "limit") {
    Some(value @ JsValue::Number(number)) if *number > 0.0 => Some(value),
    _ => None,
  };
  match limit_value {
    Some(limit) => super::query_rows(
      ctx,
      r#"
          select * from (
            select * from workflow_event where run_id = ? order by sequence desc limit ?
          ) order by sequence asc
        "#,
      &[js_str(&run_id), limit.clone()],
    ),
    None => super::query_rows(
      ctx,
      "select * from workflow_event where run_id = ? order by sequence asc",
      &[js_str(&run_id)],
    ),
  }
}

/// Payload: `{"v": [id, rootWorkflowRunId, parentLinkId, activityId,
/// parentSessionId, childSessionId, role, depth, path, phase, label, agentType,
/// model, status, nowMs, nowMs]}` — the exact 16 args of legacy `.run(...)`
/// (TS pre-computes every `?? null` default and `depth ?? 0`, plus both
/// timestamps) → `[taskLinkRow]`: verbatim INSERT + ON CONFLICT, then the
/// `session_task_link` read-back by `child_session_id` (error
/// `Session task link not found after write: {childSessionId}`). Raw row,
/// legacy column names.
pub fn create_session_task_link(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = super::vlist(payload)?;
  super::execute(
    ctx,
    r#"
      insert into session_task_link (
        id, root_workflow_run_id, parent_link_id, activity_id, parent_session_id,
        child_session_id, role, depth, path, phase, label, agent_type, model, status,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(child_session_id) do update set
        status = excluded.status,
        time_updated = excluded.time_updated
    "#,
    v,
  )?;
  let child_session_id = super::as_str(arg(v, 5)?, "v[5]")?;
  let row = super::query_required_row(ctx, SELECT_TASK_LINK_SQL, &[js_str(&child_session_id)], || {
    format!("Session task link not found after write: {child_session_id}")
  })?;
  Ok(single_row_array(row))
}
