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

/// `messagesInfo`: the session's message infos WITHOUT parts, in exactly the same order as
/// [`messages`].
///
/// 原因：cold hydration 的若干守卫（fork/goalBoundary/turn 定位）只读 `info`
/// （role、parentID、anchor、modelSelection），但 `messages` 会把每个 part 正文一起读出来。
/// 实测 229 条消息的会话 payload 为 11.19MB，其中 10.80MB 是 part 正文、info 只有 177KB，
/// 整读一次 92ms 且同步阻塞 Host 事件循环。这个投影让只关心结构体的调用点不必为正文买单。
/// 需要 part 正文的调用点必须继续用 [`messages`] 或 [`message_with_parts`]，不要用这个。
pub fn messages_info(conn: &Connection, session_id: &str) -> Result<Value, String> {
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
        out.push(decode_message_info(&data, id, session_id.to_string())?);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_write_messages::{save_message, save_part};

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute("PRAGMA foreign_keys = ON", [])
            .expect("invariant: enable fk");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 1_000)
            .expect("invariant: apply session schema");
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
             values ('s1','p','slug','/d','t','v',100,100)",
            [],
        )
        .expect("invariant: seed session");
        save_message(
            &conn,
            &json!({ "id": "m1", "sessionID": "s1", "role": "user", "time": { "created": 200 } }),
            None,
            600,
        )
        .expect("save m1");
        save_message(
            &conn,
            &json!({
                "id": "a1", "sessionID": "s1", "role": "assistant",
                "time": { "created": 300, "completed": 500 }, "cost": 0, "parentID": "m1"
            }),
            None,
            600,
        )
        .expect("save a1");
        save_part(
            &conn,
            &json!({
                "id": "p1", "messageID": "m1", "sessionID": "s1",
                "type": "text", "text": "hello 世界"
            }),
            None,
            600,
        )
        .expect("save p1");
        save_part(
            &conn,
            &json!({
                "id": "p2", "messageID": "a1", "sessionID": "s1",
                "type": "text", "text": "reply"
            }),
            None,
            600,
        )
        .expect("save p2");
        conn
    }

    #[test]
    fn messages_info_mirrors_messages_order_and_info_content() {
        let conn = seeded();
        let full = messages(&conn, "s1").expect("messages");
        let infos = messages_info(&conn, "s1").expect("messages_info");
        let full_arr = full.as_array().expect("messages yields an array");
        let info_arr = infos.as_array().expect("messages_info yields an array");

        assert_eq!(
            info_arr.len(),
            full_arr.len(),
            "same rows must be visible to both reads"
        );
        for (i, entry) in full_arr.iter().enumerate() {
            assert_eq!(
                entry.get("info"),
                info_arr.get(i),
                "row {i} must carry the identical info projection"
            );
        }
    }

    #[test]
    fn messages_info_carries_no_part_bodies() {
        // The whole point of the projection: it must not smuggle parts back in.
        let conn = seeded();
        let infos = messages_info(&conn, "s1").expect("messages_info");
        for value in infos.as_array().expect("array") {
            assert!(
                value.get("parts").is_none(),
                "info-only rows must not expose parts: {value}"
            );
        }
    }

    #[test]
    fn messages_info_of_unknown_session_is_empty_array() {
        // Parity with `messages`: unknown session returns [], never an error.
        let conn = seeded();
        assert_eq!(
            messages_info(&conn, "nope").expect("messages_info"),
            Value::Array(Vec::new())
        );
    }
}
