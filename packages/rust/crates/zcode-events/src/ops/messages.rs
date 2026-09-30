//! messages/parts family — SQL ported verbatim from
//! `adapters/src/storage/session-store/repositories/messages.ts` (lines 40-259).

use serde_json::Value;

use super::{js_i64, js_str, Ctx, StoreError};
use crate::jsjson::{self, JsValue};

/// Verbatim rendering of `preserveLegacyMembers` (messages.ts:14-25).
fn preserve_legacy_members(table: &str, keys: &[&str]) -> String {
  keys.iter().fold("excluded.data".to_string(), |sql, key| {
    format!(
      "(select case when json_type({table}.data, '$.{key}') is not null\n      then json_set(previous.data, '$.{key}', json_extract({table}.data, '$.{key}')) else previous.data end\n      from (select {sql} as data) as previous)",
      table = table,
      key = key,
      sql = sql
    )
  })
}

fn message_data_update() -> String {
  preserve_legacy_members("message", &["model", "providerID", "modelID", "variant"])
}

fn part_data_update() -> String {
  preserve_legacy_members("part", &["fromModel", "toModel", "model"])
}

const TOUCH_SESSION_SQL: &str =
  "update session set time_updated = max(time_updated, ?) where id = ?";

/// Copy-legacy merge (`copyLegacyMembers`, messages.ts:184-203): SELECT the
/// source row, overlay the legacy snapshot keys onto the new data object, and
/// re-stringify with JS rules.
fn merge_copy(
  ctx: &Ctx,
  table: &str,
  data_json: &str,
  copy_from: &JsValue,
) -> Result<String, StoreError> {
  let source_id = copy_from
    .get("id")
    .and_then(|value| value.as_str())
    .ok_or_else(|| StoreError::op("copyFrom.id must be a string"))?;
  let source_session = copy_from
    .get("sessionID")
    .and_then(|value| value.as_str())
    .ok_or_else(|| StoreError::op("copyFrom.sessionID must be a string"))?;
  let sql = format!("SELECT data FROM {} WHERE id=? AND session_id=?", table);
  let values = vec![js_str(&source_id), js_str(&source_session)];
  let original = super::query_row(ctx, &sql, &values)?.ok_or_else(|| {
    StoreError::op(format!("Storage copy source missing: {}/{}", table, source_id))
  })?;
  let original_text = original
    .get("data")
    .and_then(Value::as_str)
    .ok_or_else(|| StoreError::op(format!("Storage copy source missing: {}/{}", table, source_id)))?;
  let keys: &[&str] = if table == "message" {
    &["model", "providerID", "modelID", "variant"]
  } else {
    &["fromModel", "toModel", "model"]
  };
  let data = jsjson::parse(data_json)?;
  let original_value = jsjson::parse(original_text)?;
  let merged = jsjson::merge_legacy_keys(&data, &original_value, keys)?;
  Ok(jsjson::stringify(&merged))
}

fn touch_session(ctx: &Ctx, session_id: &str, time_updated: i64) -> Result<(), StoreError> {
  super::execute(
    ctx,
    TOUCH_SESSION_SQL,
    &[js_i64(time_updated), js_str(session_id)],
  )
}

/// Payload:
/// `{ id, sessionID, timeCreated, timeUpdated, dataJson, copyFrom: {id, sessionID} | null }`
/// `dataJson` is the pre-stringified stored data (legacy `encodeJson(storedData)`);
/// with `copyFrom` the native merge rewrites it byte-identically to the legacy
/// JS merge. Result: `null`.
pub fn save_message(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let id = super::req_str(payload, "id")?;
  let session_id = super::req_str(payload, "sessionID")?;
  let time_created = super::req_i64(payload, "timeCreated")?;
  let time_updated = super::req_i64(payload, "timeUpdated")?;
  let data_json = super::req_str(payload, "dataJson")?;
  let copy_from = super::field_opt(payload, "copyFrom");
  let stored = match copy_from {
    None | Some(JsValue::Null) => data_json,
    Some(source) => merge_copy(ctx, "message", &data_json, source)?,
  };

  let sql = format!(
    r#"
      insert into message (id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = ?
        )
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        -- 旧字段是回滚快照，不能因新版 Reader 隐藏了它们而在普通更新时丢掉。
        data = case when message.session_id = excluded.session_id then {data_update} else excluded.data end,
        sequence = case
          when message.session_id = excluded.session_id then message.sequence
          else excluded.sequence
        end
    "#,
    data_update = message_data_update()
  );
  let values = vec![
    js_str(&id),
    js_str(&session_id),
    js_i64(time_created),
    js_i64(time_updated),
    JsValue::Str(stored.encode_utf16().collect()),
    js_str(&session_id),
  ];
  super::execute(ctx, &sql, &values)?;
  touch_session(ctx, &session_id, time_updated)?;
  Ok("null".to_string())
}

/// Payload: `{ sessionID, messageID }` → `null`.
pub fn remove_message(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let message_id = super::req_str(payload, "messageID")?;
  super::execute(
    ctx,
    "delete from message where id = ? and session_id = ?",
    &[js_str(&message_id), js_str(&session_id)],
  )?;
  Ok("null".to_string())
}

/// Payload: `{ id, sessionID, messageID, timeCreated, timeUpdated, dataJson, copyFrom }` → `null`.
pub fn save_part(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let id = super::req_str(payload, "id")?;
  let session_id = super::req_str(payload, "sessionID")?;
  let message_id = super::req_str(payload, "messageID")?;
  let time_created = super::req_i64(payload, "timeCreated")?;
  let time_updated = super::req_i64(payload, "timeUpdated")?;
  let data_json = super::req_str(payload, "dataJson")?;
  let copy_from = super::field_opt(payload, "copyFrom");
  let stored = match copy_from {
    None | Some(JsValue::Null) => data_json,
    Some(source) => merge_copy(ctx, "part", &data_json, source)?,
  };

  let sql = format!(
    r#"
      insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from part
          where message_id = ?
        )
      )
      on conflict(id) do update set
        message_id = excluded.message_id,
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        data = case when part.message_id = excluded.message_id and part.session_id = excluded.session_id
          then {data_update} else excluded.data end,
        sequence = case
          when part.message_id = excluded.message_id and part.session_id = excluded.session_id
            then part.sequence
          else excluded.sequence
        end
    "#,
    data_update = part_data_update()
  );
  let values = vec![
    js_str(&id),
    js_str(&message_id),
    js_str(&session_id),
    js_i64(time_created),
    js_i64(time_updated),
    JsValue::Str(stored.encode_utf16().collect()),
    js_str(&message_id),
  ];
  super::execute(ctx, &sql, &values)?;
  touch_session(ctx, &session_id, time_updated)?;
  Ok("null".to_string())
}

/// Payload: `{ sessionID, messageID, partID }` → `null`.
pub fn remove_part(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let message_id = super::req_str(payload, "messageID")?;
  let part_id = super::req_str(payload, "partID")?;
  super::execute(
    ctx,
    "delete from part where id = ? and message_id = ? and session_id = ?",
    &[js_str(&part_id), js_str(&message_id), js_str(&session_id)],
  )?;
  Ok("null".to_string())
}

/// Payload: `{ sessionID }` → `[messageRows, partRows]` (the TS wrapper groups
/// them exactly like legacy `messages()`).
pub fn messages(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let message_rows = super::query_rows(
    ctx,
    r#"
      select * from message
      where session_id = ?
      order by sequence is null, sequence, time_created, rowid
      "#,
    &[js_str(&session_id)],
  )?;
  let part_rows = super::query_rows(
    ctx,
    r#"
      select * from part
      where session_id = ?
      order by message_id, sequence is null, sequence, time_created, id
      "#,
    &[js_str(&session_id)],
  )?;
  Ok(format!("[{}, {}]", message_rows, part_rows))
}

/// Payload: `{ sessionID, messageID }` → `[messageRows, partRows]` (message rows 0/1).
pub fn message_with_parts(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let message_id = super::req_str(payload, "messageID")?;
  let message_rows = super::query_rows(
    ctx,
    "select * from message where id = ? and session_id = ?",
    &[js_str(&message_id), js_str(&session_id)],
  )?;
  let part_rows = super::query_rows(
    ctx,
    r#"
      select * from part
      where message_id = ? and session_id = ?
      order by sequence is null, sequence, time_created, id
      "#,
    &[js_str(&message_id), js_str(&session_id)],
  )?;
  Ok(format!("[{}, {}]", message_rows, part_rows))
}
