//! entries / ledger family — SQL ported verbatim from
//! `adapters/src/storage/session-store/repositories/session-entries.ts`,
//! `session-inputs.ts` and `permission-full-access.ts`.

use super::{js_i64, js_str, Ctx, StoreError};
use crate::jsjson::JsValue;

/// Verbatim `touchSession` from `sessions.ts:339-343`.
const TOUCH_SESSION_SQL: &str =
  "update session set time_updated = max(time_updated, ?) where id = ?";

/// Payload:
/// `{ id, sessionID, type, timeCreated, timeUpdated, dataJson, isModelSelection, touchSession, touchTime }`
/// - `dataJson`: pre-stringified stored value — TS already applied the
///   `modelSelection` wrap and threw `Session entry data must be
///   JSON-serializable` before dispatch.
/// - `isModelSelection`: TS computes `type === SESSION_ENTRY_MODEL_SELECTION`;
///   bound as legacy `Number(isModelSelection)` (integer 1/0).
/// - `touchSession`: TS computes `input.touchSession !== false`; when true the
///   session is touched with `touchTime` (= `timeUpdated`).
/// Result: `null`.
pub fn save_session_entry(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let id = super::req_str(payload, "id")?;
  let session_id = super::req_str(payload, "sessionID")?;
  let entry_type = super::req_str(payload, "type")?;
  let time_created = super::req_i64(payload, "timeCreated")?;
  let time_updated = super::req_i64(payload, "timeUpdated")?;
  let data_json = super::req_str(payload, "dataJson")?;
  let is_model_selection = super::opt_bool(payload, "isModelSelection")?
    .ok_or_else(|| StoreError::op("expected boolean for `isModelSelection`"))?;
  let touch_session = super::opt_bool(payload, "touchSession")?
    .ok_or_else(|| StoreError::op("expected boolean for `touchSession`"))?;
  let touch_time = super::req_i64(payload, "touchTime")?;

  super::execute(
    ctx,
    r#"
      insert into session_entry (id, session_id, type, time_created, time_updated, data)
      values (?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        session_id = excluded.session_id,
        type = excluded.type,
        time_updated = excluded.time_updated,
        data = case
          when ? and session_entry.type = excluded.type
            and session_entry.session_id = excluded.session_id
            and json_type(session_entry.data) = 'object'
          then json_set(session_entry.data, '$.modelSelection', json_extract(excluded.data, '$.modelSelection'))
          else excluded.data
        end
      "#,
    &[
      js_str(&id),
      js_str(&session_id),
      js_str(&entry_type),
      js_i64(time_created),
      js_i64(time_updated),
      js_str(&data_json),
      js_i64(i64::from(is_model_selection)),
    ],
  )?;
  if touch_session {
    super::execute(
      ctx,
      TOUCH_SESSION_SQL,
      &[js_i64(touch_time), js_str(&session_id)],
    )?;
  }
  Ok("null".to_string())
}

/// Payload: `{ sessionID, type? }` → session-entry rows ordered by
/// `time_created, rowid` (legacy column names). A JS-falsy `type`
/// (absent/null/empty) selects the no-type branch, like legacy `input.type ?`.
pub fn session_entries(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let entry_type = super::opt_str(payload, "type")?.filter(|value| !value.is_empty());
  match entry_type {
    Some(entry_type) => super::query_rows(
      ctx,
      r#"
          select * from session_entry
          where session_id = ? and type = ?
          order by time_created, rowid
          "#,
      &[js_str(&session_id), js_str(&entry_type)],
    ),
    None => super::query_rows(
      ctx,
      r#"
          select * from session_entry
          where session_id = ?
          order by time_created, rowid
          "#,
      &[js_str(&session_id)],
    ),
  }
}

/// Payload: `{ "v": [id, sessionID, kind, delivery, payloadJson, sessionID, nowMs, nowMs] }`
/// (`payloadJson` = TS `encodeJson(payload) ?? "{}"`, `nowMs` = `Date.now()`).
/// Result: `null`.
pub fn save_session_input(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::execute(
    ctx,
    r#"
      insert into session_input (
        id, session_id, kind, delivery, payload,
        admitted_sequence, status, time_created, time_updated
      )
      values (
        ?, ?, ?, ?, ?,
        (
          select coalesce(max(admitted_sequence), -1) + 1
          from session_input
          where session_id = ?
        ),
        'admitted', ?, ?
      )
      on conflict(id) do update set
        kind = excluded.kind,
        delivery = excluded.delivery,
        payload = excluded.payload,
        time_updated = excluded.time_updated
      "#,
    super::vlist(payload)?,
  )?;
  Ok("null".to_string())
}

/// Payload: `{ "v": [promotedMessageID, sessionID, nowMs, id, sessionID] }` →
/// `null` (the `markSessionInputPromoted` UPDATE guarded by
/// `status = 'admitted'`).
pub fn mark_session_input_promoted(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::execute(
    ctx,
    r#"
      update session_input
      set status = 'promoted',
          promoted_message_id = ?,
          promoted_sequence = (
            select coalesce(max(promoted_sequence), -1) + 1
            from session_input
            where session_id = ?
          ),
          time_updated = ?
      where id = ? and session_id = ? and status = 'admitted'
      "#,
    super::vlist(payload)?,
  )?;
  Ok("null".to_string())
}

/// Payload: `{ "v": [status, reasonOrNull, nowMs, id, sessionID] }` → `null`
/// (the `settleSessionInput` UPDATE guarded by `status = 'admitted'`).
pub fn settle_session_input(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::execute(
    ctx,
    r#"
      update session_input
      set status = ?, status_reason = ?, time_updated = ?
      where id = ? and session_id = ? and status = 'admitted'
      "#,
    super::vlist(payload)?,
  )?;
  Ok("null".to_string())
}

/// Payload: `{ sessionID, status? }` → session-input rows ordered by
/// `admitted_sequence` (legacy column names). A JS-falsy `status`
/// (absent/null/empty) selects the no-status branch, like legacy
/// `input.status ?`.
pub fn list_session_inputs(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let status = super::opt_str(payload, "status")?.filter(|value| !value.is_empty());
  match status {
    Some(status) => super::query_rows(
      ctx,
      r#"
            select * from session_input
            where session_id = ? and status = ?
            order by admitted_sequence
            "#,
      &[js_str(&session_id), js_str(&status)],
    ),
    None => super::query_rows(
      ctx,
      r#"
            select * from session_input
            where session_id = ?
            order by admitted_sequence
            "#,
      &[js_str(&session_id)],
    ),
  }
}

/// Payload: `{ "v": [id] }` → session-input rows 0/1 (legacy
/// `getSessionInputById`; TS decodes the row or maps `[]` to `null`).
pub fn get_session_input_by_id(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::query_rows(
    ctx,
    "select * from session_input where id = ?",
    super::vlist(payload)?,
  )
}

/// Payload: `{ "v": [id, sessionID] }` → `[{ delivery, payload }]` / `[]`
/// (tx-only primitive: the `updateSessionInputs` admitted-row read).
pub fn get_admitted_session_input_row(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::query_rows(
    ctx,
    "select delivery, payload from session_input where id = ? and session_id = ? and status = 'admitted'",
    super::vlist(payload)?,
  )
}

/// Payload: `{ "v": [payloadJson, nowMs, id, sessionID], setDelivery, delivery? }`
/// (tx-only primitive). `setDelivery: true` runs the `updateSessionInputs`
/// write with `[delivery, payloadJson, nowMs, id, sessionID]`; `false` runs the
/// `commitPermissionFullAccess` payload-only write. Result: `null`.
pub fn set_admitted_session_input_row(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let values = super::vlist(payload)?;
  let set_delivery = super::opt_bool(payload, "setDelivery")?
    .ok_or_else(|| StoreError::op("expected boolean for `setDelivery`"))?;
  if set_delivery {
    let delivery = super::req_str(payload, "delivery")?;
    let mut with_delivery = Vec::with_capacity(values.len() + 1);
    with_delivery.push(js_str(&delivery));
    with_delivery.extend(values.iter().cloned());
    super::execute(
      ctx,
      "update session_input set delivery = ?, payload = ?, time_updated = ? where id = ? and session_id = ? and status = 'admitted'",
      &with_delivery,
    )?;
  } else {
    super::execute(
      ctx,
      "update session_input set payload = ?, time_updated = ? where id = ? and session_id = ? and status = 'admitted'",
      values,
    )?;
  }
  Ok("null".to_string())
}

/// Payload: `{ "v": [receiptId] }` → `[{ session_id }]` / `[]` (tx-only
/// primitive: the `commitPermissionFullAccess` receipt lookup).
pub fn get_session_entry_session_id(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::query_rows(
    ctx,
    "select session_id from session_entry where id = ?",
    super::vlist(payload)?,
  )
}

/// Payload: `{ "v": [messageID, sessionID, nowMs, id, sessionID] }` → `null`
/// (tx-only primitive: the final UPDATE of legacy `promoteSessionInput`, the
/// variant WITHOUT the `status = 'admitted'` guard).
pub fn promote_session_input_status(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::execute(
    ctx,
    r#"
        update session_input
        set status = 'promoted',
            promoted_message_id = ?,
            promoted_sequence = (
              select coalesce(max(promoted_sequence), -1) + 1
              from session_input
              where session_id = ?
            ),
            time_updated = ?
        where id = ? and session_id = ?
        "#,
    super::vlist(payload)?,
  )?;
  Ok("null".to_string())
}
