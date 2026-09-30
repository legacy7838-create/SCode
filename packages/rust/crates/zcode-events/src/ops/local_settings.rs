//! local settings / permissions family — SQL ported verbatim from
//! `adapters/src/storage/session-store/repositories/local-settings.ts` (lines 7-131).

use super::{js_i64, js_str, Ctx, StoreError};
use crate::jsjson::JsValue;

/// Positional argument at `index` of a `{"v": [...]}` payload.
fn arg<'a>(v: &'a [JsValue], index: usize) -> Result<&'a JsValue, StoreError> {
  v
    .get(index)
    .ok_or_else(|| StoreError::op(format!("missing positional argument {}", index)))
}

/// Positional integer argument at `index` of a `{"v": [...]}` payload.
fn arg_i64(v: &[JsValue], index: usize) -> Result<i64, StoreError> {
  arg(v, index)?
    .as_i64()
    .ok_or_else(|| StoreError::op(format!("expected integer at positional argument {}", index)))
}

/// Verbatim `readLocalSetting` SELECT (local-settings.ts:99-102); parameters
/// bind `(scope, scope_id, namespace, key)` in that order.
const READ_LOCAL_SETTING_SQL: &str = r#"
      select value from local_setting
      where scope = ? and scope_id = ? and namespace = ? and key = ?
      "#;

/// Verbatim `writeLocalSetting` INSERT (local-settings.ts:120-128). The legacy
/// call sites always pass `scope = 'project'`, `namespace = 'permission'`,
/// `schemaVersion = 1`, and `time` as both created and updated timestamp.
fn write_local_setting(
  ctx: &Ctx,
  key: &str,
  scope_id: &str,
  value: &str,
  time: i64,
) -> Result<(), StoreError> {
  super::execute(
    ctx,
    r#"
      insert into local_setting (
        scope, scope_id, namespace, key, value, schema_version, time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(scope, scope_id, namespace, key) do update set
        value = excluded.value,
        schema_version = excluded.schema_version,
        time_updated = excluded.time_updated
      "#,
    &[
      js_str("project"),
      js_str(scope_id),
      js_str("permission"),
      js_str(key),
      js_str(value),
      js_i64(1),
      js_i64(time),
      js_i64(time),
    ],
  )
}

/// Legacy `getProjectPermission` read-back (local-settings.ts:11-24): the
/// `local_setting` ruleset read and the `permission` table read, both run in
/// that order. Result: `[[settingRows],[permissionRows]]` (0/1 rows each).
fn permission_readback(ctx: &Ctx, project_id: &str) -> Result<String, StoreError> {
  let setting_rows = super::query_rows(
    ctx,
    READ_LOCAL_SETTING_SQL,
    &[
      js_str("project"),
      js_str(project_id),
      js_str("permission"),
      js_str("ruleset"),
    ],
  )?;
  let permission_rows = super::query_rows(
    ctx,
    "select * from permission where project_id = ?",
    &[js_str(project_id)],
  )?;
  Ok(format!("[{},{}]", setting_rows, permission_rows))
}

/// Payload: `{ "v": [projectID] }` -> Result: `[[settingRows],[permissionRows]]`
/// — the legacy `local_setting` ruleset read (scope `project`, namespace
/// `permission`, key `ruleset`) followed by `select * from permission`, both
/// always run in that order. TS applies the legacy decode chain
/// (`decodeJson(setting.value) ?? null`, else `decodeJson(row.data) ?? null`).
pub fn get_project_permission(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = super::vlist(payload)?;
  let project_id = super::as_str(arg(v, 0)?, "projectID")?;
  permission_readback(ctx, &project_id)
}

/// Payload: `{ "v": [projectID, valueJson, nowMs] }` where `valueJson` is TS
/// `JSON.stringify(permission)` and `nowMs` is TS `Date.now()` ->
/// Result: `[[settingRows],[permissionRows]]` — the verbatim `writeLocalSetting`
/// upsert (key `ruleset`) followed by the same read-back as
/// `get_project_permission`. TS throws
/// `Project permission not found after write: {projectID}` when both decode to null.
pub fn save_project_permission(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = super::vlist(payload)?;
  let project_id = super::as_str(arg(v, 0)?, "projectID")?;
  let value_json = super::as_str(arg(v, 1)?, "valueJson")?;
  let now_ms = arg_i64(v, 2)?;
  write_local_setting(ctx, "ruleset", &project_id, &value_json, now_ms)?;
  permission_readback(ctx, &project_id)
}

/// Payload: `{ "v": [projectID] }` -> Result: `[{value}, …]` (0/1 rows, column
/// `value` = the stored JSON text); TS decodes (`decodeJson(value).mode` +
/// `isCollaborationMode`).
pub fn get_project_permission_mode(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = super::vlist(payload)?;
  let project_id = super::as_str(arg(v, 0)?, "projectID")?;
  super::query_rows(
    ctx,
    READ_LOCAL_SETTING_SQL,
    &[
      js_str("project"),
      js_str(&project_id),
      js_str("permission"),
      js_str("mode"),
    ],
  )
}

/// Payload: `{ "v": [projectID, valueJson, nowMs] }` where `valueJson` is TS
/// `JSON.stringify({ mode })` and `nowMs` is TS `Date.now()` -> Result: `null`
/// — the verbatim `writeLocalSetting` upsert (key `mode`). Legacy returns
/// `input.mode`, which TS still has.
pub fn save_project_permission_mode(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = super::vlist(payload)?;
  let project_id = super::as_str(arg(v, 0)?, "projectID")?;
  let value_json = super::as_str(arg(v, 1)?, "valueJson")?;
  let now_ms = arg_i64(v, 2)?;
  write_local_setting(ctx, "mode", &project_id, &value_json, now_ms)?;
  Ok("null".to_string())
}
