//! Session-entry reads (`sessionEntries`) mirroring `decodeSessionEntryRow` +
//! `decodeStoredSessionModelSelection` (`codecs.ts`). Key order is fixed
//! (`id, sessionID, type, time{created,updated}, data`); `JSON.parse` of the `data` column throws on
//! invalid content (propagated). For the `runtime/model_selection` type, `data` is the normalized
//! `.modelSelection` via `parse_model_selection_value`, falling back to the raw `.modelSelection`
//! when invalid, and is OMITTED when `data` is not an object or the sub-key is absent — matching JS
//! `undefined`. Verified by `harness/session_entries_parity`.

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use super::model_selection::parse_model_selection_value;

const MODEL_SELECTION_TYPE: &str = "runtime/model_selection";

fn decode_ms_entry(raw: &Value) -> Option<Value> {
    let ms = raw.as_object()?.get("modelSelection")?;
    Some(parse_model_selection_value(ms).unwrap_or_else(|| ms.clone()))
}

fn entry_to_value(
    id: String,
    session_id: String,
    etype: String,
    time_created: i64,
    time_updated: i64,
    data_json: &str,
) -> Result<Value, String> {
    let raw = serde_json::from_str::<Value>(data_json).map_err(|e| e.to_string())?;
    let is_model_selection = etype == MODEL_SELECTION_TYPE;
    let mut o = Map::new();
    o.insert("id".into(), json!(id));
    o.insert("sessionID".into(), json!(session_id));
    o.insert("type".into(), json!(etype));
    o.insert("time".into(), json!({ "created": time_created, "updated": time_updated }));
    let data = if is_model_selection {
        decode_ms_entry(&raw)
    } else {
        Some(raw)
    };
    if let Some(d) = data {
        o.insert("data".into(), d);
    }
    Ok(Value::Object(o))
}

/// Port of `sessionEntries`: all (or one type) entries for a session, ordered by
/// `time_created, rowid`.
pub fn session_entries(
    conn: &Connection,
    session_id: &str,
    etype: Option<&str>,
) -> Result<Value, String> {
    // Gather raw tuples first (query_map closure is rusqlite-only); JSON parse + projection follow so
    // a parse error propagates rather than being swallowed.
    let sql = format!(
        "select id, session_id, type, time_created, time_updated, data from session_entry \
         where session_id = ?1{} order by time_created, rowid",
        if etype.is_some() { " and type = ?2" } else { "" }
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match etype {
        Some(t) => stmt
            .query_map(rusqlite::params![session_id, t], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map(rusqlite::params![session_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
    };
    let mut out = Vec::with_capacity(rows.len());
    for (id, sid, et, tc, tu, dj) in rows {
        out.push(entry_to_value(id, sid, et, tc, tu, &dj)?);
    }
    Ok(Value::Array(out))
}
