//! Message/part reads (`messages`, `messageWithParts`) mirroring `decodeMessageRow`/`decodePartRow` +
//! `decodeStoredMessage`/`decodeStoredPart`/`decodeTimelineSelection` (`codecs.ts`). `serde_json`'s
//! `Map` is an ordered `IndexMap`, so `insert` on an existing key keeps its position (updates value) and
//! appends new keys — exactly JS `{...decoded, id, sessionID}` spread semantics. Per role/type we strip
//! legacy keys and append the normalized selection last. `JSON.parse` of the `data` column throws on
//! invalid content (propagated). Verified by `harness/session_messages_parity`.

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use super::model_selection::parse_model_selection_value;

fn obj_of(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

/// `decodeTimelineSelection`: strip `label`, normalize the rest as a `ModelSelection`, then re-append a
/// string `label` last; invalid selection → `None` (field omitted).
fn decode_timeline_selection(value: &Value) -> Option<Value> {
    let obj = obj_of(value)?;
    let mut stripped = obj.clone();
    stripped.shift_remove("label");
    let sel = parse_model_selection_value(&Value::Object(stripped))?;
    let mut s = sel.as_object()?.clone();
    if let Some(label) = obj.get("label").filter(|l| l.is_string()) {
        s.insert("label".to_string(), label.clone());
    }
    Some(Value::Object(s))
}

/// `decodeStoredMessage` + the outer `{...decoded, id, sessionID}`.
fn decode_message_info(data: &str, id: String, session_id: String) -> Result<Value, String> {
    let raw: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
    let mut m = Map::new();
    if let Some(obj) = obj_of(&raw) {
        match obj.get("role").and_then(Value::as_str) {
            Some("user") => {
                for (k, v) in obj {
                    if k != "model" && k != "modelSelection" {
                        m.insert(k.clone(), v.clone());
                    }
                }
                if let Some(sel) = obj.get("modelSelection").and_then(parse_model_selection_value) {
                    m.insert("modelSelection".to_string(), sel);
                }
            }
            Some("assistant") => {
                for (k, v) in obj {
                    if k != "providerID" && k != "modelID" && k != "variant" {
                        m.insert(k.clone(), v.clone());
                    }
                }
            }
            _ => {
                for (k, v) in obj {
                    m.insert(k.clone(), v.clone());
                }
            }
        }
    }
    m.insert("id".to_string(), json!(id));
    m.insert("sessionID".to_string(), json!(session_id));
    Ok(Value::Object(m))
}

/// `decodeStoredPart` + the outer `{...decoded, id, sessionID, messageID}`.
fn decode_part_info(
    data: &str,
    id: String,
    session_id: String,
    message_id: String,
) -> Result<Value, String> {
    let raw: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
    let mut m = Map::new();
    if let Some(obj) = obj_of(&raw) {
        let ty = obj.get("type").and_then(Value::as_str);
        let tl = obj.get("timelineType").and_then(Value::as_str);
        if ty == Some("timeline") && tl == Some("model_change") {
            for (k, v) in obj {
                if !matches!(k.as_str(), "fromModel" | "toModel" | "fromModelSelection" | "toModelSelection") {
                    m.insert(k.clone(), v.clone());
                }
            }
            if let Some(fm) = obj.get("fromModelSelection").and_then(decode_timeline_selection) {
                m.insert("fromModel".to_string(), fm);
            }
            if let Some(tm) = obj.get("toModelSelection").and_then(decode_timeline_selection) {
                m.insert("toModel".to_string(), tm);
            }
        } else if ty == Some("subtask") {
            for (k, v) in obj {
                if k != "model" && k != "modelSelection" {
                    m.insert(k.clone(), v.clone());
                }
            }
            if let Some(ms) = obj.get("modelSelection").and_then(parse_model_selection_value) {
                m.insert("model".to_string(), ms);
            }
        } else {
            for (k, v) in obj {
                m.insert(k.clone(), v.clone());
            }
        }
    }
    m.insert("id".to_string(), json!(id));
    m.insert("sessionID".to_string(), json!(session_id));
    m.insert("messageID".to_string(), json!(message_id));
    Ok(Value::Object(m))
}

/// `messages`: all messages with their parts for a session, in the JS ordering.
pub fn messages(conn: &Connection, session_id: &str) -> Result<Value, String> {
    // Parts first, grouped by message_id (encounter order preserved within each group).
    let mut parts_by: HashMap<String, Vec<Value>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "select id, message_id, data from part where session_id = ?1
                 order by message_id, sequence is null, sequence, time_created, id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([session_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, message_id, data) = row.map_err(|e| e.to_string())?;
            let part = decode_part_info(&data, id.clone(), session_id.to_string(), message_id.clone())?;
            parts_by.entry(message_id).or_default().push(part);
        }
    }

    let mut out = Vec::new();
    let mut stmt = conn
        .prepare(
            "select id, data from message where session_id = ?1
             order by sequence is null, sequence, time_created, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([session_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, data) = row.map_err(|e| e.to_string())?;
        let info = decode_message_info(&data, id.clone(), session_id.to_string())?;
        let parts = parts_by.get(&id).cloned().unwrap_or_default();
        let mut entry = Map::new();
        entry.insert("info".to_string(), info);
        entry.insert("parts".to_string(), Value::Array(parts));
        out.push(Value::Object(entry));
    }
    Ok(Value::Array(out))
}

/// `messageWithParts`: a single message with its parts, or `null`.
pub fn message_with_parts(
    conn: &Connection,
    session_id: &str,
    message_id: &str,
) -> Result<Value, String> {
    let msg: Option<(String, String)> = conn
        .query_row(
            "select id, data from message where id = ?1 and session_id = ?2",
            rusqlite::params![message_id, session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((id, data)) = msg else {
        return Ok(Value::Null);
    };
    let info = decode_message_info(&data, id, session_id.to_string())?;

    let mut parts = Vec::new();
    let mut stmt = conn
        .prepare(
            "select id, message_id, data from part where message_id = ?1 and session_id = ?2
             order by sequence is null, sequence, time_created, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![message_id, session_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (pid, pmid, pdata) = row.map_err(|e| e.to_string())?;
        parts.push(decode_part_info(&pdata, pid, session_id.to_string(), pmid)?);
    }

    let mut entry = Map::new();
    entry.insert("info".to_string(), info);
    entry.insert("parts".to_string(), Value::Array(parts));
    Ok(Value::Object(entry))
}
