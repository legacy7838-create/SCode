//! todo family — SQL ported verbatim from
//! `adapters/src/storage/session-store/repositories/todos.ts`.

use super::{js_i64, js_str, Ctx, StoreError};
use crate::jsjson::JsValue;

/// Verbatim `touchSession` from `sessions.ts:339-343`.
const TOUCH_SESSION_SQL: &str =
  "update session set time_updated = max(time_updated, ?) where id = ?";

/// Payload: `{ "v": [sessionID] }` → todo rows ordered by `position asc`
/// (legacy column names).
pub fn read_todos(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::query_rows(
    ctx,
    r#"
      select * from todo
      where session_id = ?
      order by position asc
      "#,
    super::vlist(payload)?,
  )
}

/// Payload: `{ sessionID, todos: [{ content, status, priority }], nowMs }` →
/// `null`. Replaces the session's todos (delete, then insert each with a
/// 0-based `position` and `nowMs` = `Date.now()` for both times), then touches
/// the session with `nowMs`. No transaction here — the batch owns atomicity
/// (legacy `db.exec("begin immediate")` lives in the write batch instead).
pub fn update_todos(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let session_id = super::req_str(payload, "sessionID")?;
  let todos = super::req_arr(payload, "todos")?;
  let now_ms = super::req_i64(payload, "nowMs")?;

  super::execute(
    ctx,
    "delete from todo where session_id = ?",
    &[js_str(&session_id)],
  )?;
  for (position, todo) in todos.iter().enumerate() {
    let content = super::req_str(todo, "content")?;
    let status = super::req_str(todo, "status")?;
    let priority = super::req_str(todo, "priority")?;
    super::execute(
      ctx,
      r#"
        insert into todo (
          session_id, content, status, priority, position, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?)
        "#,
      &[
        js_str(&session_id),
        js_str(&content),
        js_str(&status),
        js_str(&priority),
        js_i64(position as i64),
        js_i64(now_ms),
        js_i64(now_ms),
      ],
    )?;
  }
  super::execute(
    ctx,
    TOUCH_SESSION_SQL,
    &[js_i64(now_ms), js_str(&session_id)],
  )?;
  Ok("null".to_string())
}
