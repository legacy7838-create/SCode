//! sessions family — SQL ported verbatim from
//! `adapters/src/storage/session-store/repositories/sessions.ts`.

use serde_json::Value;

use super::{js_i64, js_str, single_row_array, Ctx, StoreError};
use crate::jsjson::{self, JsValue};

/// `getSession`'s statement — also the read-back behind legacy `mustGetSession`.
const SESSION_SELECT_BY_ID: &str = "select * from session where id = ?";

/// Legacy `SESSION_TITLE_SOURCES`
/// (`contracts/src/interfaces/session-store.port.ts:45`).
const SESSION_TITLE_SOURCES: &[&str] = &["default", "first_input", "generated", "custom"];

const CREATE_SESSION_SQL: &str = r#"
      insert into session (
        id, project_id, workspace_id, parent_id, trace_id, task_type, slug, directory, path,
        title, title_source, title_message_id, version,
        share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
        revert, permission, time_created, time_updated, time_title_updated,
        time_compacting, time_archived
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null, ?, ?, ?, ?, null, null)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        parent_id = excluded.parent_id,
        trace_id = coalesce(session.trace_id, excluded.trace_id),
        task_type = excluded.task_type,
        slug = excluded.slug,
        directory = excluded.directory,
        path = excluded.path,
        title = excluded.title,
        title_source = excluded.title_source,
        title_message_id = excluded.title_message_id,
        version = excluded.version,
        share_url = excluded.share_url,
        permission = coalesce(excluded.permission, session.permission),
        time_title_updated = excluded.time_title_updated,
        time_updated = excluded.time_updated
      "#;

const UPDATE_SESSION_SQL: &str = r#"
      update session set
        directory = ?,
        path = ?,
        title = ?,
        title_source = ?,
        title_message_id = ?,
        share_url = ?,
        summary_additions = ?,
        summary_deletions = ?,
        summary_files = ?,
        summary_diffs = ?,
        revert = ?,
        permission = ?,
        time_title_updated = ?,
        time_compacting = ?,
        time_archived = ?,
        -- 路径自愈可能携带并发读取前的旧时间，不能回退真实活动时间。
        time_updated = max(time_updated, ?)
      where id = ?
      "#;

// ── row helpers ──────────────────────────────────────────────────────────────

/// `query_row` value → bindable JS value (TEXT → string, INTEGER/REAL → number,
/// NULL → null) so legacy re-binds of `current.*` keep their node:sqlite types.
fn to_js(value: &Value) -> JsValue {
  match value {
    Value::Null => JsValue::Null,
    Value::Bool(flag) => JsValue::Bool(*flag),
    Value::Number(number) => number.as_f64().map(JsValue::Number).unwrap_or(JsValue::Null),
    Value::String(text) => JsValue::Str(text.encode_utf16().collect()),
    Value::Array(items) => JsValue::Arr(items.iter().map(to_js).collect()),
    Value::Object(entries) => JsValue::Obj(
      entries
        .iter()
        .map(|(key, value)| (key.encode_utf16().collect(), to_js(value)))
        .collect(),
    ),
  }
}

/// Row column → bindable value; absent/NULL column → SQL NULL.
fn row_field(row: &Value, column: &str) -> JsValue {
  match row.get(column) {
    None | Some(Value::Null) => JsValue::Null,
    Some(value) => to_js(value),
  }
}

/// `decodeSessionRow`'s truthy collapse for `title_message_id`
/// (`row.title_message_id ? … : undefined`), then `?? null` in the merge:
/// NULL and `""` both bind as SQL NULL.
fn row_truthy_str(row: &Value, column: &str) -> JsValue {
  match row.get(column) {
    Some(Value::String(text)) if !text.is_empty() => js_str(text),
    _ => JsValue::Null,
  }
}

/// `encodeJson(decodeJson(column))` for the legacy JSON TEXT columns (revert,
/// permission, summary_diffs): NULL/`""` → SQL NULL (legacy `decodeJson` yields
/// `undefined` for falsy text), a JSON `null` decodes to JS `null` which
/// `encodeJson` maps back to SQL NULL, otherwise `JSON.parse` +
/// `JSON.stringify` — corrupt JSON throws exactly like legacy `decodeSessionRow`.
fn json_column_round_trip(row: &Value, column: &str) -> Result<JsValue, StoreError> {
  match row.get(column) {
    None | Some(Value::Null) => Ok(JsValue::Null),
    Some(Value::String(text)) if text.is_empty() => Ok(JsValue::Null),
    Some(Value::String(text)) => match jsjson::parse(text)? {
      JsValue::Null => Ok(JsValue::Null),
      parsed => Ok(JsValue::Str(jsjson::stringify(&parsed).encode_utf16().collect())),
    },
    Some(_) => Err(StoreError::op(format!("expected TEXT column `{}`", column))),
  }
}

/// `decodeSessionTitleSource` (codecs.ts:44-48).
fn decode_title_source(row: &Value) -> String {
  match row.get("title_source") {
    Some(Value::String(text)) if SESSION_TITLE_SOURCES.contains(&text.as_str()) => text.clone(),
    _ => "first_input".to_string(),
  }
}

// ── payload helpers ──────────────────────────────────────────────────────────

/// JS truthiness for the legacy `if (x)` / `x && …` guards; an absent key is
/// `undefined` (falsy).
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

/// `value ?? null` for legacy `.run(…, x ?? null, …)` arguments.
fn or_null(object: &JsValue, key: &str) -> JsValue {
  match object.get(key) {
    None | Some(JsValue::Null) => JsValue::Null,
    Some(value) => value.clone(),
  }
}

/// `value ?? fallback` for legacy `.run(…, x ?? "default", …)` arguments.
fn or_str(object: &JsValue, key: &str, fallback: &str) -> JsValue {
  match object.get(key) {
    None | Some(JsValue::Null) => js_str(fallback),
    Some(value) => value.clone(),
  }
}

/// `summary === null ? null : (summary.<field> ?? null)`; with `input.summary`
/// absent, the legacy default composition (`current` columns, decoded then
/// `?? null`) instead.
fn summary_field(summary: Option<&JsValue>, current: &Value, key: &str, column: &str) -> JsValue {
  match summary {
    None => row_field(current, column),
    Some(JsValue::Null) => JsValue::Null,
    Some(value) => match value.get(key) {
      None | Some(JsValue::Null) => JsValue::Null,
      Some(field) => field.clone(),
    },
  }
}

/// Shared body of `updateSession`/`setRevert`/`clearRevert`: legacy
/// `updateSession`'s read-modify-write with the verbatim UPDATE statement and
/// the `mustGetSession` read-back.
fn apply_update(ctx: &Ctx, input: &JsValue, now_ms: i64) -> Result<String, StoreError> {
  let id = super::req_str(input, "id")?;
  let current = super::query_row(ctx, SESSION_SELECT_BY_ID, &[js_str(&id)])?
    .ok_or_else(|| StoreError::op(format!("Session not found: {id}")))?;

  // Legacy decodes (JSON.parse) these columns while loading `current`; keep
  // the same throw timing for corrupt JSON even on the early-return path.
  let current_diffs = json_column_round_trip(&current, "summary_diffs")?;
  let current_revert = json_column_round_trip(&current, "revert")?;
  let current_permission = json_column_round_trip(&current, "permission")?;

  // summary = input.summary === undefined ? { …current… } : input.summary
  let summary = input.get("summary");

  let decoded_title_source = decode_title_source(&current);

  // if (input.title !== undefined && input.expectedTitleSources &&
  //     input.expectedTitleSources.length > 0 &&
  //     !input.expectedTitleSources.includes(current.titleSource ?? "first_input"))
  if input.has_key("title") {
    if let Some(expected) = input
      .get("expectedTitleSources")
      .and_then(|value| value.as_array())
    {
      if !expected.is_empty() {
        let includes = expected
          .iter()
          .any(|item| item.as_str().as_deref() == Some(decoded_title_source.as_str()));
        if !includes {
          return Ok(single_row_array(current));
        }
      }
    }
  }

  let current_title = row_field(&current, "title");
  let title_changed = input.has_key("title") && input.get("title") != Some(&current_title);
  // nextTitleSource = input.titleSource ?? current.titleSource ?? "first_input"
  let next_title_source = match input.get("titleSource") {
    None | Some(JsValue::Null) => js_str(&decoded_title_source),
    Some(value) => value.clone(),
  };
  // summary_diffs = summary === null ? null
  //   : input.summary === undefined ? encodeJson(default.diffs)  (= column round-trip)
  //   : encodeJson(summary.diffs)
  let summary_diffs = match summary {
    None => current_diffs,
    Some(JsValue::Null) => JsValue::Null,
    Some(value) => super::encode_json_field(value, "diffs")?,
  };

  let values = vec![
    // directory = input.directory ?? current.directory
    match input.get("directory") {
      None | Some(JsValue::Null) => row_field(&current, "directory"),
      Some(value) => value.clone(),
    },
    // path = input.path === undefined ? (current.path ?? null) : input.path
    match input.get("path") {
      None => row_field(&current, "path"),
      Some(value) => value.clone(),
    },
    // title = input.title ?? current.title
    match input.get("title") {
      None | Some(JsValue::Null) => current_title,
      Some(value) => value.clone(),
    },
    next_title_source,
    // title_message_id = input.titleMessageID === undefined
    //   ? (current.titleMessageID ?? null) : input.titleMessageID
    match input.get("titleMessageID") {
      None => row_truthy_str(&current, "title_message_id"),
      Some(value) => value.clone(),
    },
    // share_url = input.shareURL === undefined
    //   ? (current.shareURL ?? null) : input.shareURL
    match input.get("shareURL") {
      None => row_field(&current, "share_url"),
      Some(value) => value.clone(),
    },
    summary_field(summary, &current, "additions", "summary_additions"),
    summary_field(summary, &current, "deletions", "summary_deletions"),
    summary_field(summary, &current, "files", "summary_files"),
    summary_diffs,
    // revert = input.revert === undefined ? encodeJson(current.revert)
    //   : encodeJson(input.revert)
    match input.get("revert") {
      None => current_revert,
      Some(_) => super::encode_json_field(input, "revert")?,
    },
    // permission = input.permission === undefined ? encodeJson(current.permission)
    //   : encodeJson(input.permission)
    match input.get("permission") {
      None => current_permission,
      Some(_) => super::encode_json_field(input, "permission")?,
    },
    // titleChanged || input.titleSource !== undefined || input.titleMessageID !== undefined
    //   ? now : (current.time.titleUpdated ?? null)
    if title_changed || input.has_key("titleSource") || input.has_key("titleMessageID") {
      js_i64(now_ms)
    } else {
      row_field(&current, "time_title_updated")
    },
    // time_compacting = input.timeCompacting === undefined
    //   ? (current.time.compacting ?? null) : input.timeCompacting
    match input.get("timeCompacting") {
      None => row_field(&current, "time_compacting"),
      Some(value) => value.clone(),
    },
    // time_archived = input.timeArchived === undefined
    //   ? (current.time.archived ?? null) : input.timeArchived
    match input.get("timeArchived") {
      None => row_field(&current, "time_archived"),
      Some(value) => value.clone(),
    },
    // time_updated = max(time_updated, input.timeUpdated ?? now) — max is SQL-side
    match input.get("timeUpdated") {
      None | Some(JsValue::Null) => js_i64(now_ms),
      Some(value) => value.clone(),
    },
    js_str(&id),
  ];

  super::execute(ctx, UPDATE_SESSION_SQL, &values)?;
  let row = super::query_required_row(ctx, SESSION_SELECT_BY_ID, &[js_str(&id)], || {
    format!("Session not found after write: {id}")
  })?;
  Ok(single_row_array(row))
}

// ── ops ──────────────────────────────────────────────────────────────────────

/// Payload: `{ input: CreateSessionInput, nowMs: number }` → `[sessionRow]`.
/// `timeCreated = input.time?.created ?? nowMs`, `timeUpdated =
/// input.time?.updated ?? timeCreated`; `taskType ?? "interactive"`,
/// `titleSource ?? "first_input"`; `permission` via `encodeJson`;
/// `time_title_updated = input.titleSource || input.titleMessageID ? timeUpdated : null`.
/// Verbatim upsert, then read-back `select * from session where id = ?`
/// (error `Session not found after write: {id}`). Raw row, legacy column names.
pub fn create_session(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let input = super::field(payload, "input")?;
  let now_ms = super::req_i64(payload, "nowMs")?;
  let id = super::req_str(input, "id")?;

  // input.time?.created ?? nowMs / input.time?.updated ?? timeCreated
  let time = super::field_opt(input, "time").filter(|value| !value.is_null());
  let time_created = time
    .and_then(|value| value.get("created"))
    .filter(|value| !value.is_null())
    .cloned()
    .unwrap_or_else(|| js_i64(now_ms));
  let time_updated = time
    .and_then(|value| value.get("updated"))
    .filter(|value| !value.is_null())
    .cloned()
    .unwrap_or_else(|| time_created.clone());
  // input.titleSource || input.titleMessageID ? timeUpdated : null
  let time_title_updated = if js_truthy(super::field_opt(input, "titleSource"))
    || js_truthy(super::field_opt(input, "titleMessageID"))
  {
    time_updated.clone()
  } else {
    JsValue::Null
  };

  let values = vec![
    js_str(&id),
    super::field(input, "projectID")?.clone(),
    or_null(input, "workspaceID"),
    or_null(input, "parentID"),
    or_null(input, "traceID"),
    or_str(input, "taskType", "interactive"),
    super::field(input, "slug")?.clone(),
    super::field(input, "directory")?.clone(),
    or_null(input, "path"),
    super::field(input, "title")?.clone(),
    or_str(input, "titleSource", "first_input"),
    or_null(input, "titleMessageID"),
    super::field(input, "version")?.clone(),
    or_null(input, "shareURL"),
    super::encode_json_field(input, "permission")?,
    time_created,
    time_updated,
    time_title_updated,
  ];
  super::execute(ctx, CREATE_SESSION_SQL, &values)?;

  let row = super::query_required_row(ctx, SESSION_SELECT_BY_ID, &[js_str(&id)], || {
    format!("Session not found after write: {id}")
  })?;
  Ok(single_row_array(row))
}

/// Payload: `{ input: UpdateSessionInput, nowMs: number }` → `[sessionRow]`.
/// Legacy `updateSession` read-modify-write: JSON key absent == `undefined`,
/// explicit `null` preserved; early return `[currentRow]` (no UPDATE) when
/// `title` is set, `expectedTitleSources` is a non-empty array and does not
/// contain the decoded `title_source`; `summary`/`revert`/`permission` follow
/// the `encodeJson`/`decodeJson` round-trip rules. Errors: `Session not found:
/// {id}` (missing row), `Session not found after write: {id}` (read-back).
/// Raw row, legacy column names.
pub fn update_session(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let input = super::field(payload, "input")?;
  let now_ms = super::req_i64(payload, "nowMs")?;
  apply_update(ctx, input, now_ms)
}

/// Payload: `{ "v": [sessionID] }` → session rows (0/1) of
/// `select * from session where id = ?`. Raw row, legacy column names.
pub fn get_session(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  super::query_rows(ctx, SESSION_SELECT_BY_ID, super::vlist(payload)?)
}

/// Payload: `{ input: ListSessionsInput (its limit lifted to the payload
/// root), limit: number | null }` → session rows ordered `time_updated desc,
/// id desc`; `limit` binds only when > 0. Clauses in legacy order:
/// `project_id`, `workspace_id`, `directory`, `path`, `roots`, `taskTypes`
/// (pre-filtered/deduped by the TS wrapper), `time_archived`. Key absent ==
/// legacy `undefined`, explicit `null` preserved (`workspace_id is null`).
pub fn list_sessions(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let input = super::field(payload, "input")?;
  let mut clauses: Vec<String> = Vec::new();
  let mut values: Vec<JsValue> = Vec::new();

  // if (input.projectID)
  let project_id = super::field_opt(input, "projectID");
  if js_truthy(project_id) {
    clauses.push("project_id = ?".to_string());
    values.push(project_id.unwrap().clone());
  }

  // if (input.workspaceID !== undefined)
  if let Some(workspace_id) = super::field_opt(input, "workspaceID") {
    if workspace_id.is_null() {
      clauses.push("workspace_id is null".to_string());
    } else {
      clauses.push("workspace_id = ?".to_string());
      values.push(workspace_id.clone());
    }
  }

  // if (input.directory)
  let directory = super::field_opt(input, "directory");
  if js_truthy(directory) {
    clauses.push("directory = ?".to_string());
    values.push(directory.unwrap().clone());
  }

  // if (input.path !== undefined)
  if let Some(path) = super::field_opt(input, "path") {
    let path = super::as_str(path, "path")?;
    if path.is_empty() {
      clauses.push("(path is null or path = '')".to_string());
    } else {
      clauses.push("(path = ? or path like ?)".to_string());
      values.push(js_str(&path));
      values.push(js_str(&format!("{path}/%")));
    }
  }

  // if (input.roots)
  if js_truthy(super::field_opt(input, "roots")) {
    clauses.push("parent_id is null".to_string());
  }

  // normalizeSessionTaskTypes — the TS wrapper pre-filters/dedups `taskTypes`.
  if let Some(task_types) = super::opt_arr(input, "taskTypes")? {
    if !task_types.is_empty() {
      let placeholders = task_types
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
      clauses.push(format!("task_type in ({placeholders})"));
      values.extend(task_types.iter().cloned());
    }
  }

  // if (!input.includeArchived)
  if !js_truthy(super::field_opt(input, "includeArchived")) {
    clauses.push("time_archived is null".to_string());
  }

  let where_sql = if clauses.is_empty() {
    String::new()
  } else {
    format!("where {}", clauses.join(" and "))
  };
  // input.limit && input.limit > 0 ? input.limit : undefined
  let limit_value = match super::field_opt(payload, "limit") {
    Some(value) => match value {
      JsValue::Number(number) if *number > 0.0 => Some(value),
      _ => None,
    },
    None => None,
  };
  let limit_sql = match limit_value {
    Some(value) => {
      values.push(value.clone());
      " limit ?"
    }
    None => "",
  };
  let sql = format!(
    "select * from session {} order by time_updated desc, id desc{}",
    where_sql, limit_sql
  );
  super::query_rows(ctx, &sql, &values)
}

/// Payload: `{ workspaceID: string, directory: string, sessionIDs: string[] }`
/// (deduped by the TS wrapper) → JSON number of changed rows; empty
/// `sessionIDs` → `"0"` without touching SQL.
pub fn claim_legacy_session_workspace(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let workspace_id = super::req_str(payload, "workspaceID")?;
  let directory = super::req_str(payload, "directory")?;
  let session_ids = super::req_arr(payload, "sessionIDs")?;
  if session_ids.is_empty() {
    return Ok("0".to_string());
  }
  // 3.3.6 的 SSH/WSL session 没有 workspace_id，3.4 sessions-index 又按完整
  // identity 严格查询，升级后历史任务全部不可见。这里只认 host tasks-index 给出的精确
  // taskId allowlist，并叠加实际目录和 NULL identity，不能退化成按路径批量认领。
  let placeholders = session_ids
    .iter()
    .map(|_| "?")
    .collect::<Vec<_>>()
    .join(", ");
  let sql = format!(
    r#"update session
       set workspace_id = ?
       where workspace_id is null
         and directory = ?
         and id in ({placeholders})"#
  );
  let mut values = Vec::with_capacity(session_ids.len() + 2);
  values.push(js_str(&workspace_id));
  values.push(js_str(&directory));
  values.extend(session_ids.iter().cloned());
  let changes = super::execute_changes(ctx, &sql, &values)?;
  Ok(changes.to_string())
}

/// Payload: `{ "v": [projectID, workspaceID, workspacePath, workspacePath,
/// sessionID, legacyWorkspaceDirectory, legacyWorkspaceDirectory] }` — the
/// exact 7 args of legacy `.run(...)` → `"true"` / `"false"` (changes === 1).
pub fn repair_legacy_remote_session_workspace(
  ctx: &Ctx,
  payload: &JsValue,
) -> Result<String, StoreError> {
  // 3.4.2 把 WSL identity 当成执行路径，生产路径还可能先被 path.resolve
  // 拼到真实 cwd 后落库。只按单 session 和完整旧目录精确迁移，禁止模糊搜索或批量认领。
  let changes = super::execute_changes(
    ctx,
    r#"update session
       set project_id = ?, workspace_id = ?, directory = ?, path = ?
       where id = ?
         and workspace_id is null
         and directory = ?
         and (path is null or path = ?)"#,
    super::vlist(payload)?,
  )?;
  Ok((changes == 1).to_string())
}

/// Payload: `{ "v": [directory, path, timeUpdated, sessionID, workspaceID,
/// expectedDirectory, expectedPath, expectedPath] }` — the exact 8 args of
/// legacy `.run(...)` → `"true"` / `"false"` (changes === 1).
pub fn repair_remote_session_paths(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  // 路径自愈曾复用全字段 updateSession，把读取快照中的标题、权限、回滚和
  // 归档状态覆盖到并发新值上。维护性迁移只能拥有路径字段，并用旧路径做 CAS。
  let changes = super::execute_changes(
    ctx,
    r#"update session
       set directory = ?, path = ?, time_updated = max(time_updated, ?)
       where id = ?
         and workspace_id = ?
         and directory = ?
         and ((? is null and path is null) or path = ?)"#,
    super::vlist(payload)?,
  )?;
  Ok((changes == 1).to_string())
}

/// Payload: `{ input: { id, revert, summary? }, nowMs: number }` →
/// `[sessionRow]`. The TS wrapper composes `input` exactly like legacy
/// `setRevert`; execution is the legacy `updateSession` implementation (see
/// `update_session`).
pub fn set_revert(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  update_session(ctx, payload)
}

/// Payload: `{ input: { id, revert: null, summary: null }, nowMs: number }` →
/// `[sessionRow]`. The TS wrapper composes `input` exactly like legacy
/// `clearRevert`; execution is the legacy `updateSession` implementation (see
/// `update_session`).
pub fn clear_revert(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  update_session(ctx, payload)
}
