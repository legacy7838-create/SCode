//! Named operation surface. Every op's SQL is ported verbatim from the legacy
//! repositories; there is no raw-SQL escape hatch.
//!
//! Payload conventions (the TS wrapper builds payloads, the crate executes):
//! - `{"v": [...]}` — positional arguments exactly as the legacy `.run/.get/.all`
//!   call, shaped by unchanged legacy TS code (`encodeJson`, `integer()`, …).
//! - named fields — ops that need several statements or computed values; each op
//!   documents its payload in a doc comment.
//!
//! Payloads are parsed with the in-crate JS-semantics JSON parser (`jsjson`),
//! so UTF-16 strings, lone surrogates and JS number formatting behave like
//! `JSON.parse` on the TS side.
//!
//! Result strings: reads → JSON array of row objects (same column names/types as
//! node:sqlite); writes → `null` unless the op performs a read-back (row array)
//! or returns a scalar (number/boolean) as documented.

pub mod input_history;
pub mod inputs;
pub mod local_settings;
pub mod messages;
pub mod script_workflow;
pub mod sessions;
pub mod targets;
pub mod todos;
pub mod usage;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, Statement};
use serde_json::{Map, Number, Value};

use crate::error::StoreError;
use crate::jsjson::{self, JsValue};

pub struct Ctx<'a> {
  pub conn: &'a Connection,
}

// ── JSValue constructors ─────────────────────────────────────────────────────

pub fn js_str(value: &str) -> JsValue {
  JsValue::Str(value.encode_utf16().collect())
}

pub fn js_i64(value: i64) -> JsValue {
  JsValue::Number(value as f64)
}

pub fn js_f64(value: f64) -> JsValue {
  JsValue::Number(value)
}

pub fn js_null() -> JsValue {
  JsValue::Null
}

pub fn js_opt_str(value: Option<&str>) -> JsValue {
  match value {
    Some(text) => js_str(text),
    None => JsValue::Null,
  }
}

/// `encodeJson(value)` semantics (`json.ts:1-3`): absent/undefined/null → SQL
/// NULL, otherwise the JS-stringified subtree bytes as TEXT.
pub fn encode_json_field(payload: &JsValue, key: &str) -> Result<JsValue, StoreError> {
  match payload.get(key) {
    None | Some(JsValue::Null) => Ok(JsValue::Null),
    Some(value) => Ok(JsValue::Str(
      jsjson::stringify(value).encode_utf16().collect(),
    )),
  }
}

// ── payload accessors ────────────────────────────────────────────────────────

pub fn field<'a>(payload: &'a JsValue, key: &str) -> Result<&'a JsValue, StoreError> {
  payload
    .get(key)
    .ok_or_else(|| StoreError::op(format!("op payload missing field `{}`", key)))
}

pub fn field_opt<'a>(payload: &'a JsValue, key: &str) -> Option<&'a JsValue> {
  payload.get(key)
}

/// UTF-16 → lossy UTF-8 string, mirroring node:sqlite's JS-string→TEXT encoding.
pub fn as_str(value: &JsValue, what: &str) -> Result<String, StoreError> {
  value
    .as_str()
    .ok_or_else(|| StoreError::op(format!("expected string for {}", what)))
}

pub fn req_str(payload: &JsValue, key: &str) -> Result<String, StoreError> {
  as_str(field(payload, key)?, key)
}

/// `null`/absent → `None`.
pub fn opt_str(payload: &JsValue, key: &str) -> Result<Option<String>, StoreError> {
  match payload.get(key) {
    None | Some(JsValue::Null) => Ok(None),
    Some(value) => Ok(Some(as_str(value, key)?)),
  }
}

pub fn req_i64(payload: &JsValue, key: &str) -> Result<i64, StoreError> {
  field(payload, key)?
    .as_i64()
    .ok_or_else(|| StoreError::op(format!("expected integer for `{}`", key)))
}

pub fn opt_f64(payload: &JsValue, key: &str) -> Result<Option<f64>, StoreError> {
  match payload.get(key) {
    None | Some(JsValue::Null) => Ok(None),
    Some(value) => value
      .as_f64()
      .map(Some)
      .ok_or_else(|| StoreError::op(format!("expected number or null for `{}`", key))),
  }
}

pub fn opt_bool(payload: &JsValue, key: &str) -> Result<Option<bool>, StoreError> {
  match payload.get(key) {
    None | Some(JsValue::Null) => Ok(None),
    Some(value) => value
      .as_bool()
      .map(Some)
      .ok_or_else(|| StoreError::op(format!("expected boolean for `{}`", key))),
  }
}


pub fn req_arr<'a>(payload: &'a JsValue, key: &str) -> Result<&'a Vec<JsValue>, StoreError> {
  field(payload, key)?
    .as_array()
    .ok_or_else(|| StoreError::op(format!("expected array for `{}`", key)))
}

pub fn opt_arr<'a>(payload: &'a JsValue, key: &str) -> Result<Option<&'a Vec<JsValue>>, StoreError> {
  match payload.get(key) {
    None | Some(JsValue::Null) => Ok(None),
    Some(value) => value
      .as_array()
      .map(Some)
      .ok_or_else(|| StoreError::op(format!("expected array for `{}`", key))),
  }
}

/// The positional argument list for Convention-A ops.
pub fn vlist(payload: &JsValue) -> Result<&Vec<JsValue>, StoreError> {
  req_arr(payload, "v")
}


// ── binding ──────────────────────────────────────────────────────────────────

/// JS value → SQLite parameter (TEXT/INTEGER/REAL/NULL), matching node:sqlite's
/// conversion: integer-valued numbers bind as INTEGER, others as REAL; booleans
/// and objects/arrays are rejected (legacy never bound those either).
pub struct J<'a>(pub &'a JsValue);

impl rusqlite::ToSql for J<'_> {
  fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
    let value = match self.0 {
      JsValue::Null => SqlValue::Null,
      JsValue::Bool(_) => {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(StoreError::op(
          "cannot bind a boolean SQL parameter",
        ))))
      }
      JsValue::Number(number) => {
        if number.fract() == 0.0
          && number.is_finite()
          && *number >= i64::MIN as f64
          && *number <= i64::MAX as f64
        {
          SqlValue::Integer(*number as i64)
        } else {
          SqlValue::Real(*number)
        }
      }
      JsValue::Str(units) => SqlValue::Text(jsjson::units_to_string(units)),
      other => {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(StoreError::op(
          format!("cannot bind a JSON {} as an SQL parameter", other.type_of()),
        ))))
      }
    };
    Ok(rusqlite::types::ToSqlOutput::Owned(value))
  }
}

pub fn bind_list(values: &[JsValue]) -> Vec<J<'_>> {
  values.iter().map(J).collect()
}

// ── execution helpers ────────────────────────────────────────────────────────

pub fn execute(ctx: &Ctx, sql: &str, values: &[JsValue]) -> Result<(), StoreError> {
  let mut stmt = ctx.conn.prepare(sql)?;
  stmt.execute(rusqlite::params_from_iter(bind_list(values)))?;
  Ok(())
}

/// Like `execute`, returning `changes` (node:sqlite `.run().changes`).
pub fn execute_changes(ctx: &Ctx, sql: &str, values: &[JsValue]) -> Result<usize, StoreError> {
  let mut stmt = ctx.conn.prepare(sql)?;
  let changes = stmt.execute(rusqlite::params_from_iter(bind_list(values)))?;
  Ok(changes)
}

/// All rows as a JSON array of objects keyed by column name.
/// TEXT→string, INTEGER→number, REAL→number, NULL→null; the schema has no BLOB
/// columns (verified against the real DB), so a BLOB is a hard error.
pub fn query_rows(ctx: &Ctx, sql: &str, values: &[JsValue]) -> Result<String, StoreError> {
  let mut stmt = ctx.conn.prepare(sql)?;
  rows_to_json(&mut stmt, values)
}

pub fn rows_to_json(stmt: &mut Statement<'_>, values: &[JsValue]) -> Result<String, StoreError> {
  let columns: Vec<String> = stmt
    .column_names()
    .iter()
    .map(|name| name.to_string())
    .collect();
  let mut rows = stmt.query(rusqlite::params_from_iter(bind_list(values)))?;
  let mut collected: Vec<Map<String, Value>> = Vec::new();
  while let Some(row) = rows.next()? {
    let mut map = Map::with_capacity(columns.len());
    for (index, name) in columns.iter().enumerate() {
      let value = row.get_ref(index)?;
      let json = match value {
        rusqlite::types::ValueRef::Null => Value::Null,
        rusqlite::types::ValueRef::Integer(i) => Value::Number(Number::from(i)),
        rusqlite::types::ValueRef::Real(f) => Number::from_f64(f)
          .map(Value::Number)
          .unwrap_or(Value::Null),
        rusqlite::types::ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        rusqlite::types::ValueRef::Blob(_) => {
          return Err(StoreError::op(format!(
            "unexpected BLOB column `{}` (the session schema declares zero BLOB columns)",
            name
          )))
        }
      };
      map.insert(name.clone(), json);
    }
    collected.push(map);
  }
  // Stable key order = SELECT column order (codecs construct new objects anyway).
  let ordered: Vec<Value> = collected
    .into_iter()
    .map(|map| {
      let mut ordered_map = Map::new();
      for column in &columns {
        if let Some(entry) = map.get(column) {
          ordered_map.insert(column.clone(), entry.clone());
        }
      }
      Value::Object(ordered_map)
    })
    .collect();
  Ok(serde_json::to_string(&Value::Array(ordered))?)
}

/// Single-row get → `Some(row)` / `None`.
pub fn query_row(ctx: &Ctx, sql: &str, values: &[JsValue]) -> Result<Option<Value>, StoreError> {
  let rows = query_rows(ctx, sql, values)?;
  let parsed: Vec<Value> = serde_json::from_str(&rows)?;
  Ok(parsed.into_iter().next())
}

/// Exactly-one-row read-back (`mustGet…` in legacy) with the legacy message.
pub fn query_required_row(
  ctx: &Ctx,
  sql: &str,
  values: &[JsValue],
  missing: impl FnOnce() -> String,
) -> Result<Value, StoreError> {
  query_row(ctx, sql, values)?.ok_or_else(|| StoreError::op(missing()))
}

pub fn single_row_array(row: Value) -> String {
  serde_json::to_string(&Value::Array(vec![row])).unwrap_or_else(|_| "[]".into())
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/// Kinds usable only under `tx_begin` (scope-owned row primitives).
pub const TX_ONLY_KINDS: &[&str] = &[
  "getAdmittedSessionInputRow",
  "setAdmittedSessionInputRow",
  "getSessionEntrySessionId",
  "promoteSessionInputStatus",
];

/// Usage writes that make the batch run the coalesced prune (§4.2).
pub fn is_usage_write(kind: &str) -> bool {
  matches!(
    kind,
    "recordModelUsage" | "upsertTurnUsage" | "upsertToolUsage" | "pruneUsage"
  )
}

/// Retention window from `usage.ts:16-17` (30 days).
pub const USAGE_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

pub fn dispatch(ctx: &Ctx, kind: &str, payload: &JsValue) -> Result<String, StoreError> {
  match kind {
    // sessions
    "createSession" => sessions::create_session(ctx, payload),
    "updateSession" => sessions::update_session(ctx, payload),
    "getSession" => sessions::get_session(ctx, payload),
    "listSessions" => sessions::list_sessions(ctx, payload),
    "claimLegacySessionWorkspace" => sessions::claim_legacy_session_workspace(ctx, payload),
    "repairLegacyRemoteSessionWorkspace" => {
      sessions::repair_legacy_remote_session_workspace(ctx, payload)
    }
    "repairRemoteSessionPaths" => sessions::repair_remote_session_paths(ctx, payload),
    "setRevert" => sessions::set_revert(ctx, payload),
    "clearRevert" => sessions::clear_revert(ctx, payload),
    // messages / parts
    "saveMessage" => messages::save_message(ctx, payload),
    "removeMessage" => messages::remove_message(ctx, payload),
    "savePart" => messages::save_part(ctx, payload),
    "removePart" => messages::remove_part(ctx, payload),
    "messages" => messages::messages(ctx, payload),
    "messageWithParts" => messages::message_with_parts(ctx, payload),
    // entries / ledger
    "saveSessionEntry" => inputs::save_session_entry(ctx, payload),
    "sessionEntries" => inputs::session_entries(ctx, payload),
    "saveSessionInput" => inputs::save_session_input(ctx, payload),
    "markSessionInputPromoted" => inputs::mark_session_input_promoted(ctx, payload),
    "settleSessionInput" => inputs::settle_session_input(ctx, payload),
    "listSessionInputs" => inputs::list_session_inputs(ctx, payload),
    "getSessionInputById" => inputs::get_session_input_by_id(ctx, payload),
    "getAdmittedSessionInputRow" => inputs::get_admitted_session_input_row(ctx, payload),
    "setAdmittedSessionInputRow" => inputs::set_admitted_session_input_row(ctx, payload),
    "getSessionEntrySessionId" => inputs::get_session_entry_session_id(ctx, payload),
    "promoteSessionInputStatus" => inputs::promote_session_input_status(ctx, payload),
    // targets
    "readTarget" => targets::read_target(ctx, payload),
    "setTarget" => targets::set_target(ctx, payload),
    "cloneTargetForFork" => targets::clone_target_for_fork(ctx, payload),
    "createTarget" => targets::create_target(ctx, payload),
    "updateTargetStatus" => targets::update_target_status(ctx, payload),
    "startTargetRun" => targets::start_target_run(ctx, payload),
    "heartbeatTargetRun" => targets::heartbeat_target_run(ctx, payload),
    "finishTargetRun" => targets::finish_target_run(ctx, payload),
    "recoverInterruptedTargetRun" => targets::recover_interrupted_target_run(ctx, payload),
    "accountTargetUsage" => targets::account_target_usage(ctx, payload),
    "updateTargetSummaryTitle" => targets::update_target_summary_title(ctx, payload),
    "clearTarget" => targets::clear_target(ctx, payload),
    // todos
    "readTodos" => todos::read_todos(ctx, payload),
    "updateTodos" => todos::update_todos(ctx, payload),
    // local settings / permissions
    "getProjectPermission" => local_settings::get_project_permission(ctx, payload),
    "saveProjectPermission" => local_settings::save_project_permission(ctx, payload),
    "getProjectPermissionMode" => local_settings::get_project_permission_mode(ctx, payload),
    "saveProjectPermissionMode" => local_settings::save_project_permission_mode(ctx, payload),
    // usage
    "recordModelUsage" => usage::record_model_usage(ctx, payload),
    "upsertTurnUsage" => usage::upsert_turn_usage(ctx, payload),
    "upsertToolUsage" => usage::upsert_tool_usage(ctx, payload),
    "pruneUsage" => usage::prune_usage(ctx, payload),
    "queryAppUsage" => usage::query_app_usage(ctx, payload),
    "queryTaskUsage" => usage::query_task_usage(ctx, payload),
    // input history
    "recordInputHistory" => input_history::record_input_history(ctx, payload),
    "recallPreviousInputHistory" => input_history::recall_previous_input_history(ctx, payload),
    // script workflow
    "upsertScriptWorkflowDefinition" => script_workflow::upsert_definition(ctx, payload),
    "createScriptWorkflowRun" => script_workflow::create_run(ctx, payload),
    "updateScriptWorkflowRun" => script_workflow::update_run(ctx, payload),
    "getScriptWorkflowRun" => script_workflow::get_run(ctx, payload),
    "listScriptWorkflowRuns" => script_workflow::list_runs(ctx, payload),
    "createScriptWorkflowActivity" => script_workflow::create_activity(ctx, payload),
    "updateScriptWorkflowActivity" => script_workflow::update_activity(ctx, payload),
    "findCachedScriptWorkflowActivity" => script_workflow::find_cached_activity(ctx, payload),
    "listScriptWorkflowActivities" => script_workflow::list_activities(ctx, payload),
    "appendScriptWorkflowEvent" => script_workflow::append_event(ctx, payload),
    "listScriptWorkflowEvents" => script_workflow::list_events(ctx, payload),
    "createSessionTaskLink" => script_workflow::create_session_task_link(ctx, payload),
    other => Err(StoreError::op(format!("unknown store op kind `{}`", other))),
  }
}

