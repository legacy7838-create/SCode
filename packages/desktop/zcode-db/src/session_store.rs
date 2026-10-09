//! Session-store read operations, one atomic unit per public facade method (the Agent CLI
//! `~/.zcode/cli/db/db.sqlite`). The JS store ran these on one shared `DatabaseSync` handle across
//! multi-statement transactions; here each public read is a self-contained query, so the stateless
//! N-API model matches the JS behavior at the operation boundary. Projections mirror the TS codecs
//! (`decodeTodoRow`, …) exactly, verified by `harness/session_read_parity`.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value, json};

/// Port of `readTodos` + `decodeTodoRow`: ordered by `position asc`, projected to
/// `{content, status, priority}` (the codec drops the id/position/time columns).
pub fn read_todos(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "select content, status, priority from todo where session_id = ?1 order by position asc",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok(json!({
                "content": row.get::<_, String>(0)?,
                "status": row.get::<_, String>(1)?,
                "priority": row.get::<_, String>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(Value::Array(out))
}

/// The `session_input` row columns, in table order (accessed by name in JS `select *`).
const SESSION_INPUT_COLUMNS: &str = "id, session_id, kind, delivery, payload, admitted_sequence, \
    promoted_sequence, promoted_message_id, status, status_reason, time_created, time_updated";

/// Port of `decodePayload`: JSON.parse; an object becomes `{text:"", ...parsed}` (text first,
/// parsed's own key order, its `text` overriding the default), anything else → `{text:""}`.
fn decode_payload(raw: &str) -> Value {
    let mut out = Map::new();
    if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(raw) {
        // `{ text: "", ...parsed }`: text occupies the first slot; parsed keys follow in order.
        let text = parsed.get("text").cloned().unwrap_or_else(|| json!(""));
        out.insert("text".to_string(), text);
        for (k, v) in parsed {
            if k != "text" {
                out.insert(k, v);
            }
        }
        Value::Object(out)
    } else {
        out.insert("text".to_string(), json!(""));
        Value::Object(out)
    }
}

/// Port of `decodeSessionInputRow` — exact key order + coercion of the JS codec, reading columns by
/// name (avoids a 12-positional-arg helper). Optional fields appear only when the column is non-NULL.
fn row_to_session_input(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let delivery: String = row.get("delivery")?;
    let delivery = match delivery.as_str() {
        "startNow" | "guide" | "queue" => delivery,
        _ => "queue".to_string(),
    };
    let status: String = row.get("status")?;
    let status = match status.as_str() {
        "admitted" | "promoted" | "cancelled" | "discarded" | "failed" => status,
        _ => "admitted".to_string(),
    };
    let payload: String = row.get("payload")?;

    let mut o = Map::new();
    o.insert("id".into(), json!(row.get::<_, String>("id")?));
    o.insert("sessionID".into(), json!(row.get::<_, String>("session_id")?));
    o.insert("kind".into(), json!(row.get::<_, String>("kind")?));
    o.insert("delivery".into(), json!(delivery));
    o.insert("payload".into(), decode_payload(&payload));
    o.insert(
        "admittedSequence".into(),
        json!(row.get::<_, i64>("admitted_sequence")?),
    );
    if let Some(v) = row.get::<_, Option<i64>>("promoted_sequence")? {
        o.insert("promotedSequence".into(), json!(v));
    }
    if let Some(v) = row.get::<_, Option<String>>("promoted_message_id")? {
        o.insert("promotedMessageID".into(), json!(v));
    }
    o.insert("status".into(), json!(status));
    if let Some(v) = row.get::<_, Option<String>>("status_reason")? {
        o.insert("statusReason".into(), json!(v));
    }
    o.insert(
        "time".into(),
        json!({
            "created": row.get::<_, i64>("time_created")?,
            "updated": row.get::<_, i64>("time_updated")?,
        }),
    );
    Ok(Value::Object(o))
}


/// N-API: `getProjectPermission` port. Two-tier read: `local_setting`
/// (scope=project, namespace=permission, key=ruleset) first, then the legacy `permission.data`
/// column. Mirrors `decodeJson` exactly: empty → `null`, invalid JSON → error (JS `JSON.parse`
/// throws), missing → `null`.
pub fn get_project_permission(conn: &Connection, project_id: &str) -> Result<Value, String> {
    let setting: Option<String> = conn
        .query_row(
            "select value from local_setting \
             where scope='project' and scope_id=?1 and namespace='permission' and key='ruleset'",
            [project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let raw = match setting {
        Some(v) => Some(v),
        None => conn
            .query_row(
                "select data from permission where project_id = ?1",
                [project_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?,
    };
    decode_json_null_on_empty(&raw)
}

/// `decodeJson(v) ?? null`: absent/empty → `null`; otherwise `JSON.parse` (invalid → propagate an
/// error, matching the throw in JS).
fn decode_json_null_on_empty(raw: &Option<String>) -> Result<Value, String> {
    match raw {
        None => Ok(Value::Null),
        Some(s) if s.is_empty() => Ok(Value::Null),
        Some(s) => serde_json::from_str(s).map_err(|e| e.to_string()),
    }
}

/// N-API: `getProjectPermissionMode` port. Reads the `local_setting` mode row; empty/absent →
/// `null`; invalid JSON → error (JS `JSON.parse` throws); a `.mode` that is not one of
/// plan/build/edit/yolo/auto → `null` (mirrors `isCollaborationMode`).
pub fn get_project_permission_mode(conn: &Connection, project_id: &str) -> Result<Value, String> {
    let raw: Option<String> = conn
        .query_row(
            "select value from local_setting \
             where scope='project' and scope_id=?1 and namespace='permission' and key='mode'",
            [project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(s) = raw.filter(|v| !v.is_empty()) else {
        return Ok(Value::Null);
    };
    let parsed: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    let mode = parsed.get("mode").and_then(Value::as_str);
    if matches!(mode, Some("plan") | Some("build") | Some("edit") | Some("yolo") | Some("auto")) {
        Ok(json!(mode.unwrap()))
    } else {
        Ok(Value::Null)
    }
}

/// Port of `readTarget`/`readSessionTarget`: the `session_target` row for a session projected to
/// `SessionGoal` (`decodeTargetRow`) — all columns direct, nulls kept as JSON null, fixed key order;
/// `null` when no row.
pub fn read_target(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let sql = "select session_id, target_id, objective, summary_title, status, token_budget, \
        tokens_used, time_used_seconds, active_input_id, active_run_started_at, \
        active_run_last_seen_at, time_created, time_updated \
        from session_target where session_id = ?1";
    let row = conn
        .query_row(sql, [session_id], |r| {
            Ok(json!({
                "sessionID": r.get::<_, String>(0)?,
                "targetID": r.get::<_, String>(1)?,
                "objective": r.get::<_, String>(2)?,
                "summaryTitle": r.get::<_, Option<String>>(3)?,
                "status": r.get::<_, String>(4)?,
                "tokenBudget": r.get::<_, Option<i64>>(5)?,
                "tokensUsed": r.get::<_, i64>(6)?,
                "timeUsedSeconds": r.get::<_, i64>(7)?,
                "activeInputId": r.get::<_, Option<String>>(8)?,
                "activeRunStartedAtMs": r.get::<_, Option<i64>>(9)?,
                "activeRunLastSeenAtMs": r.get::<_, Option<i64>>(10)?,
                "time": {
                    "created": r.get::<_, i64>(11)?,
                    "updated": r.get::<_, i64>(12)?,
                },
            }))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.unwrap_or(Value::Null))
}

/// Port of `listSessionInputs`: all (or one status) for a session, ordered by `admitted_sequence`.
pub fn list_session_inputs(
    conn: &Connection,
    session_id: &str,
    status: Option<&str>,
) -> Result<Value, String> {
    let sql = format!(
        "select {} from session_input where session_id = ?1{} order by admitted_sequence",
        SESSION_INPUT_COLUMNS,
        if status.is_some() { " and status = ?2" } else { "" }
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match status {
        Some(s) => stmt.query_map(rusqlite::params![session_id, s], row_to_session_input),
        None => stmt.query_map(rusqlite::params![session_id], row_to_session_input),
    }
    .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(Value::Array(out))
}

/// Port of `getSessionInputById`: the record by id, or `null`.
pub fn get_session_input_by_id(conn: &Connection, id: &str) -> Result<Value, String> {
    let sql = format!("select {} from session_input where id = ?1", SESSION_INPUT_COLUMNS);
    let row = conn
        .query_row(&sql, [id], row_to_session_input)
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.unwrap_or(Value::Null))
}


/// `normalizedInputHistoryAttachments` for one entry array: keep only file/image/pdf/url types with a
/// trimmed non-empty `path` or a trimmed non-empty `content` that isn't a `data:` URL; empty result →
/// `None` (omit). Attachment key order: type, path?, content?.
fn normalize_attachments(value: &Value) -> Option<Value> {
    let arr = value.as_array()?;
    let mut out: Vec<Value> = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else { continue };
        let ty = obj.get("type").and_then(Value::as_str);
        if !matches!(ty, Some("file") | Some("image") | Some("pdf") | Some("url")) {
            continue;
        }
        let path = obj.get("path").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
        let content = obj
            .get("content")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty() && !t.starts_with("data:"));
        if path.is_none() && content.is_none() {
            continue;
        }
        let mut m = Map::new();
        m.insert("type".into(), json!(ty.unwrap()));
        if let Some(p) = path {
            m.insert("path".into(), json!(p));
        }
        if let Some(c) = content {
            m.insert("content".into(), json!(c));
        }
        out.push(Value::Object(m));
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Array(out))
    }
}

/// Port of `recallPreviousInputHistory`: the newest (offset by `skip`) input-history entry for a
/// project, or `null`. `decodeJson(attachments)` throws on invalid JSON (propagated).
pub fn recall_previous_input_history(
    conn: &Connection,
    project_id: &str,
    skip: i64,
) -> Result<Value, String> {
    let sql = "select id, project_id, session_id, text, attachments, kind, time_created \
               from input_history where project_id = ?1 \
               order by time_created desc, id desc limit 1 offset ?2";
    let row = conn
        .query_row(sql, rusqlite::params![project_id, skip], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((id, project_id, session_id, text, attachments_raw, kind, time_created)) = row else {
        return Ok(Value::Null);
    };

    let attachments = match attachments_raw.filter(|s| !s.is_empty()) {
        Some(s) => {
            let parsed: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
            normalize_attachments(&parsed)
        }
        None => None,
    };

    let mut o = Map::new();
    o.insert("id".into(), json!(id));
    o.insert("projectID".into(), json!(project_id));
    if let Some(v) = session_id.filter(|s| !s.is_empty()) {
        o.insert("sessionID".into(), json!(v));
    }
    o.insert("text".into(), json!(text));
    if let Some(a) = attachments {
        o.insert("attachments".into(), a);
    }
    o.insert("kind".into(), json!(kind));
    o.insert("time".into(), json!({ "created": time_created }));
    Ok(Value::Object(o))
}
