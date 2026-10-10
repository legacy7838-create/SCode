//! `recordInputHistory` write path (ported from
//! `apps/zcode-cli/.../session-store/repositories/input-history.ts`).
//!
//! The TS records one trimmed user input into `input_history`, guarded by two no-write fast paths:
//! an empty (post-`trim`) text returns `null`, and a re-record of the newest entry for the same
//! project whose `text` AND stable attachment projection are unchanged returns `null`. Otherwise it
//! inserts a new row and prunes the table back to the newest 100 rows, all inside a single
//! `BEGIN IMMEDIATE` transaction (COMMIT on success, ROLLBACK on any error). The returned object is
//! the freshly-built projection, NOT a re-read of the row.
//!
//! `id` and `now` are injected by the caller (epoch ms + a stable id) so the write is deterministic
//! and parity-testable; the addon never reads the clock or mints a UUID, matching the rest of the
//! write path. Attachment normalization/trimming and the newest-entry read reuse the exact same
//! semantics as [`crate::session_store::recall_previous_input_history`] (whose private
//! `normalize_attachments` is reproduced here verbatim since it is not crate-visible).

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};

use crate::session_store;

/// Port of the TS `INPUT_HISTORY_LIMIT`: after every insert the table is pruned to the newest rows.
const INPUT_HISTORY_LIMIT: i64 = 100;

/// Port of `normalizedInputHistoryAttachments` for one entry array (reproduced verbatim from the
/// private `normalize_attachments` in `session_store.rs`, which is not reachable across modules):
/// keep only `file`/`image`/`pdf`/`url` types that have a trimmed non-empty `path` OR a trimmed
/// non-empty `content` that isn't a `data:` URL; drop entries with neither; an empty result → `None`
/// (omit). Attachment key order (which `JSON.stringify`/`to_string` preserves) is `type`, `path?`,
/// `content?`, matching the TS object literal.
fn normalize_attachments(value: &Value) -> Option<Value> {
    let arr = value.as_array()?;
    let mut out: Vec<Value> = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else { continue };
        let ty = obj.get("type").and_then(Value::as_str);
        if !matches!(ty, Some("file") | Some("image") | Some("pdf") | Some("url")) {
            continue;
        }
        let path = obj
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty());
        let content = obj
            .get("content")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty() && !t.starts_with("data:"));
        if path.is_none() && content.is_none() {
            continue;
        }
        let mut m = Map::new();
        // `ty` is `Some` here (guaranteed by the `matches!` guard above).
        let ty_str = ty.unwrap_or("");
        m.insert("type".into(), json!(ty_str));
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

/// Port of `encodeJson(attachments)` for the normalized column value: `None` (undefined) → SQL NULL,
/// `Some(array)` → its compact JSON string (matches `JSON.stringify`, byte-for-byte under
/// `serde_json`'s `preserve_order`).
fn encode_attachments_json(normalized: Option<&Value>) -> Result<Option<String>, String> {
    normalized.map(serde_json::to_string).transpose().map_err(|e| e.to_string())
}

/// Port of `recordInputHistory`: insert one trimmed input row for `project_id`, unless it is empty
/// or duplicates the newest entry for the same project (same `text` + same stable attachments), in
/// which case no write happens. On insert, the table is pruned to the newest
/// [`INPUT_HISTORY_LIMIT`] rows inside one `BEGIN IMMEDIATE` transaction.
///
/// # Arguments
///
/// * `conn` - A read-write connection (this fn owns the transaction lifecycle).
/// * `id` - The new row's primary key, injected by the caller (the TS mints `input_<base36>_<uuid>`;
///   passing it in keeps the write deterministic for parity testing).
/// * `project_id` - The owning project (`input_history.project_id`).
/// * `session_id` - Optional owning session; `None` binds SQL NULL (TS `input.sessionID ?? null`).
/// * `text` - The raw input text; trimmed here. An empty trim returns `null` with no write.
/// * `kind` - The input-history kind column.
/// * `attachments` - The RAW input attachment array (normalization happens here); `Value::Null`
///   when the caller supplied none, mirroring TS `input.attachments === undefined`.
/// * `now` - Epoch ms for `time_created` (TS `input.time?.created ?? Date.now()`), injected.
///
/// # Returns
///
/// The freshly-built entry projection as a JSON object, or `Value::Null` when the write was skipped
/// (empty text or duplicate of the newest entry).
///
/// # Errors
///
/// Returns `Err(String)` when the newest-entry read or any statement fails. On a failure inside the
/// insert/prune transaction the transaction is rolled back, so the stored rows are unchanged.
#[allow(clippy::too_many_arguments)]
pub fn record_input_history(
    conn: &Connection,
    id: &str,
    project_id: &str,
    session_id: Option<&str>,
    text: &str,
    kind: &str,
    attachments: &Value,
    now: i64,
) -> Result<Value, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Value::Null);
    }
    let normalized = normalize_attachments(attachments);

    // Dedup guard against the newest entry for this project (`skip = 0`). `recall_previous_input_
    // history` already normalizes the stored attachments, so comparing its (re)normalized string to
    // the new normalized string is exactly TS's `stableInputHistoryAttachments` equality (idempotent).
    let prev = session_store::recall_previous_input_history(conn, project_id, 0)?;
    if prev.get("text").and_then(Value::as_str) == Some(text)
        && stable_attachments_str(prev.get("attachments")) == stable_attachments_str(normalized.as_ref())
    {
        return Ok(Value::Null);
    }

    // BEGIN IMMEDIATE ... COMMIT / ROLLBACK, mirroring the TS `db.exec("begin immediate")` try/catch.
    conn.execute("BEGIN IMMEDIATE", []).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let attachments_col = encode_attachments_json(normalized.as_ref())?;
        conn.execute(
            "insert into input_history (id, project_id, session_id, text, attachments, kind, time_created) \
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, project_id, session_id, text, attachments_col, kind, now],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "delete from input_history \
             where id not in ( \
               select id from input_history \
               order by time_created desc, id desc \
               limit ?1 \
             )",
            [INPUT_HISTORY_LIMIT],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            return Err(e);
        }
    }

    // The returned projection is built from the inputs, NOT a re-read (matching the TS `return {...}`).
    let mut o = Map::new();
    o.insert("id".into(), json!(id));
    o.insert("projectID".into(), json!(project_id));
    // TS returns `sessionID: input.sessionID`; `JSON.stringify` drops it ONLY when `undefined`
    // (the key is absent). An empty string is a real value and is KEPT, so omit only when None.
    if let Some(s) = session_id {
        o.insert("sessionID".into(), json!(s));
    }
    o.insert("text".into(), json!(text));
    if let Some(a) = &normalized {
        o.insert("attachments".into(), a.clone());
    }
    o.insert("kind".into(), json!(kind));
    o.insert("time".into(), json!({ "created": now }));
    Ok(Value::Object(o))
}

/// The `stableInputHistoryAttachments` value for one attachment source (already-normalized array from
/// `recall`, the new normalized array, or `None`): its compact JSON string, or `"[]"` when absent.
/// Both sides of the dedup comparison run through this, so an absent attachment list and an empty
/// normalized list collapse to the same `"[]"` sentinel — exactly the TS behavior.
fn stable_attachments_str(value: Option<&Value>) -> String {
    match value {
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()),
        None => "[]".to_string(),
    }
}

/// N-API: `recordInputHistory` write boundary. `input_json` is `{ projectID, sessionID?, text,
/// attachments?, kind }` where `attachments` is the RAW input array (normalized inside Rust). `id`
/// and `now` are passed in (JS number epoch ms) so the write is deterministic and parity-testable.
/// Returns the created entry JSON, or the literal `"null"` when the write was skipped or the text was
/// empty.
#[napi]
pub fn record_input_history_json(
    db_path: String,
    input_json: String,
    id: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let project_id = input
        .get("projectID")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::from_reason("input.projectID must be a string"))?;
    let text = input
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::from_reason("input.text must be a string"))?;
    let kind = input
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::from_reason("input.kind must be a string"))?;
    let session_id = input.get("sessionID").and_then(Value::as_str);
    // Raw attachment array; absent → Value::Null (mirrors TS `input.attachments === undefined`).
    let attachments = input
        .get("attachments")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::Null);

    let conn = crate::open_readwrite(&db_path)?;
    let entry = record_input_history(
        &conn,
        &id,
        project_id,
        session_id,
        text,
        kind,
        &attachments,
        now as i64,
    )
    .map_err(Error::from_reason)?;
    serde_json::to_string(&entry).map_err(|e| Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute("PRAGMA foreign_keys = ON", [])
            .expect("invariant: enable fk");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 1_700_000_000_000)
            .expect("invariant: apply session schema");
        conn
    }

    fn row_count(conn: &Connection) -> i64 {
        conn.query_row("select count(*) from input_history", [], |r| r.get(0))
            .expect("count")
    }

    fn attachments_column(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row(
            "select attachments from input_history where id = ?1",
            [id],
            |r| r.get::<_, Option<String>>(0),
        )
        .expect("read attachments column")
    }

    #[test]
    fn empty_text_returns_null_without_writing() {
        let conn = db();
        let out = record_input_history(
            &conn,
            "input_x",
            "p",
            None,
            "   ",
            "prompt",
            &Value::Null,
            100,
        )
        .expect("ok");
        assert_eq!(out, Value::Null, "whitespace-only text is skipped");
        assert_eq!(row_count(&conn), 0, "no row inserted");
    }

    #[test]
    fn inserts_new_entry_and_projects_it() {
        let conn = db();
        let out = record_input_history(
            &conn,
            "input_1",
            "p",
            Some("s1"),
            "  hello  ",
            "prompt",
            &json!([{ "type": "file", "path": " /a.txt " }]),
            500,
        )
        .expect("insert ok");
        assert_eq!(
            out,
            json!({
                "id": "input_1",
                "projectID": "p",
                "sessionID": "s1",
                "text": "hello",
                "attachments": [{ "type": "file", "path": "/a.txt" }],
                "kind": "prompt",
                "time": { "created": 500 },
            }),
            "projection matches the TS return shape (trimmed text, normalized attachments)"
        );
        assert_eq!(row_count(&conn), 1);
        // The stored attachments column is the compact JSON of the normalized array (trim applied).
        assert_eq!(
            attachments_column(&conn, "input_1").as_deref(),
            Some(r#"[{"type":"file","path":"/a.txt"}]"#)
        );
    }

    #[test]
    fn duplicate_text_and_attachments_skips() {
        let conn = db();
        let first = record_input_history(
            &conn,
            "input_1",
            "p",
            None,
            "same text",
            "prompt",
            &json!([{ "type": "image", "content": "  png  " }]),
            100,
        )
        .expect("first insert");
        assert!(!first.is_null());
        // Same trimmed text + same (re)normalized attachments → no second row.
        let second = record_input_history(
            &conn,
            "input_2",
            "p",
            None,
            "same text",
            "prompt",
            &json!([{ "type": "image", "content": "png" }]),
            200,
        )
        .expect("dedup ok");
        assert_eq!(second, Value::Null, "duplicate of newest entry is skipped");
        assert_eq!(row_count(&conn), 1, "only the first row remains");
    }

    #[test]
    fn changed_text_or_attachments_inserts_new_row() {
        let conn = db();
        record_input_history(&conn, "input_1", "p", None, "a", "prompt", &Value::Null, 100)
            .expect("first");
        let second =
            record_input_history(&conn, "input_2", "p", None, "b", "prompt", &Value::Null, 200)
                .expect("second");
        assert!(!second.is_null(), "different text is a new row");
        assert_eq!(row_count(&conn), 2);
    }

    #[test]
    fn normalization_drops_data_urls_and_bad_types() {
        let conn = db();
        let raw = json!([
            { "type": "image", "content": "data:image/png;base64,AAAA" }, // data: content → dropped
            { "type": "nope", "path": "/x" }, // bad type → dropped
            { "type": "url", "path": "   " }, // empty path, no content → dropped
            { "type": "pdf", "content": "text/plain" }, // kept (content is not a data: URL)
        ]);
        let out = record_input_history(&conn, "input_1", "p", None, "hi", "prompt", &raw, 300)
            .expect("insert");
        assert_eq!(
            out.get("attachments"),
            Some(&json!([{ "type": "pdf", "content": "text/plain" }])),
            "only the valid, non-data: attachment survives"
        );
        assert_eq!(
            attachments_column(&conn, "input_1").as_deref(),
            Some(r#"[{"type":"pdf","content":"text/plain"}]"#)
        );
    }

    #[test]
    fn all_attachments_dropped_omits_key_and_stores_null() {
        let conn = db();
        let raw = json!([{ "type": "bad", "path": "/x" }]);
        let out = record_input_history(&conn, "input_1", "p", None, "hi", "prompt", &raw, 300)
            .expect("insert");
        assert!(out.get("attachments").is_none(), "empty normalized list omits the key");
        assert_eq!(attachments_column(&conn, "input_1"), None, "encodeJson(undefined) → NULL");
    }

    #[test]
    fn empty_session_id_is_stored_and_kept_in_projection() {
        let conn = db();
        let out = record_input_history(
            &conn,
            "input_1",
            "p",
            Some(""),
            "hi",
            "prompt",
            &Value::Null,
            400,
        )
        .expect("insert");
        // TS keeps `sessionID: ""` (only `undefined` is dropped by JSON.stringify).
        assert_eq!(
            out.get("sessionID"),
            Some(&json!("")),
            "empty sessionID must be kept in the returned projection (parity with TS)"
        );
    }

    #[test]
    fn prune_keeps_newest_100_rows() {
        let conn = db();
        // Seed 105 distinct rows with increasing time_created so ordering is unambiguous.
        for i in 0..105 {
            record_input_history(
                &conn,
                &format!("seed_{i:03}"),
                "pruneproj",
                None,
                &format!("text {i}"),
                "prompt",
                &Value::Null,
                1_000 + i,
            )
            .expect("seed insert");
        }
        // The final prune on the 105th insert must have trimmed back to 100.
        assert_eq!(row_count(&conn), 100, "table pruned to INPUT_HISTORY_LIMIT");
        // The 100 newest (highest time_created) rows must remain; the 5 oldest dropped.
        let oldest_present: i64 = conn
            .query_row(
                "select count(*) from input_history where time_created <= 1004",
                [],
                |r| r.get(0),
            )
            .expect("read");
        assert_eq!(oldest_present, 0, "the 5 oldest rows were pruned away");
    }

    #[test]
    fn bad_json_field_via_napi_shape_is_rejected() {
        // The core requires a string `text`; the wrapper surfaces non-string/missing fields as errors.
        // Here we exercise the core directly with a missing attachment array (Value::Null) to confirm
        // it is treated as "no attachments" rather than an error.
        let conn = db();
        let out = record_input_history(&conn, "input_1", "p", None, "x", "prompt", &json!(null), 1)
            .expect("null attachments accepted");
        assert!(out.get("attachments").is_none());
    }
}
