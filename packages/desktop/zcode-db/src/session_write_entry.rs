//! `saveSessionEntry` write path (ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-entries.ts`).
//!
//! A single upsert statement admits one `session_entry` row. The TS does not wrap it in a
//! transaction, so neither do we (the statement is atomic on its own). The tricky part is the
//! `on conflict(id) do update ... data = case ...` arm: for a `runtime/model_selection` re-save whose
//! type, session id and stored payload all still match (`json_type(...) = 'object'`), SQLite MERGES
//! the new `$.modelSelection` into the existing object via `json_set` (preserving any other keys the
//! stored row already had); every other conflict falls through to the freshly-encoded `excluded.data`.
//! That CASE is reproduced verbatim, with the boolean `isModelSelection` bound as the CASE's first
//! `?` (`Number(isModelSelection)` in TS, so `1` matches / `0` does not under SQLite truthiness).
//!
//! After the upsert, unless `touchSession === false`, the parent `session.time_updated` is bumped
//! through the same guarded `max(time_updated, ?)` `touchSession` the sessions repo uses. The `time`
//! values (`time.created`, `time.updated`) come in on the entry JSON — the addon never reads the
//! clock, keeping the write deterministic and parity-testable.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

/// `SESSION_ENTRY_MODEL_SELECTION` (contracts `session-store.port.ts`): the entry `type` that the
/// storage adapter wraps its payload under a `modelSelection` key for. Compared by exact string.
const SESSION_ENTRY_MODEL_SELECTION: &str = "runtime/model_selection";

/// Port of `saveSessionEntry` against an already-open read-write connection.
///
/// Reproduces the TS exactly: derive `isModelSelection` from `type`; encode the payload (model
/// selection wraps `data ?? null` as `{ modelSelection: ... }`, otherwise the raw `data`), throwing
/// the JSON-serializable error when a non-model-selection payload encodes to null; run the guarded
/// upsert; then, unless `touchSession === false`, bump the parent session clock.
///
/// # Arguments
///
/// * `conn` — an open read-write `Connection` (FK enforcement is the caller's concern, see
///   [`crate::open_readwrite`]). `session_entry.session_id` has an FK to `session.id`.
/// * `entry` — the `SessionEntryInfo` as a JSON object: `{ id, sessionID, type, time: { created,
///   updated }, data?, touchSession? }`. `data` may be absent (treated as `undefined`).
///
/// # Errors
///
/// Returns the TS message `"Session entry data must be JSON-serializable"` when a non-model-selection
/// entry has `data` that is null/absent (matching TS `if (!encoded) throw ...`). Otherwise returns the
/// `rusqlite` error string for a missing/typed-wrong field or a failed statement (e.g. the FK when
/// the parent `session` row is absent, mirroring `node:sqlite`).
pub fn save_session_entry(conn: &Connection, entry: &Value) -> Result<(), String> {
    let id = field_str(entry, "id")?;
    let session_id = field_str(entry, "sessionID")?;
    let entry_type = field_str(entry, "type")?;

    let time = entry
        .get("time")
        .ok_or_else(|| "entry.time is required".to_string())?;
    let created = field_i64(time, "created")?;
    let updated = field_i64(time, "updated")?;

    // `input.data` — absent or explicit null both behave like JS `undefined`/`null` for `??`.
    let data = entry.get("data").cloned().unwrap_or(Value::Null);
    let is_model_selection = entry_type == SESSION_ENTRY_MODEL_SELECTION;

    // `encodeJson(isModelSelection ? { modelSelection: input.data ?? null } : input.data)`.
    // `encodeJson` yields null only for undefined/null; a non-null value is JSON.stringify'd. The
    // model-selection wrapper is always an object, so it never encodes to null.
    let encoded = if is_model_selection {
        json!({ "modelSelection": data }).to_string()
    } else if data.is_null() {
        return Err("Session entry data must be JSON-serializable".to_string());
    } else {
        data.to_string()
    };

    // Bind order matches the TS `.run(...)`: id, sessionID, type, time.created, time.updated,
    // encoded, then Number(isModelSelection) as the CASE's first `?`.
    conn.execute(
        "insert into session_entry (id, session_id, type, time_created, time_updated, data)
         values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict(id) do update set
           session_id = excluded.session_id,
           type = excluded.type,
           time_updated = excluded.time_updated,
           data = case
             when ?7 and session_entry.type = excluded.type
               and session_entry.session_id = excluded.session_id
               and json_type(session_entry.data) = 'object'
             then json_set(session_entry.data, '$.modelSelection', json_extract(excluded.data, '$.modelSelection'))
             else excluded.data
           end",
        params![id, session_id, entry_type, created, updated, encoded, is_model_selection as i64],
    )
    .map_err(|e| e.to_string())?;

    // `if (input.touchSession !== false)`: absent/true/non-false all run the bump; only `false` skips.
    if entry.get("touchSession") != Some(&Value::Bool(false)) {
        conn.execute(
            "update session set time_updated = max(time_updated, ?1) where id = ?2",
            params![updated, session_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Read a required string field, mirroring TS's direct property access into a NOT NULL column: an
/// absent or non-string field is an error rather than a silent `undefined` written to SQLite.
fn field_str<'a>(entry: &'a Value, key: &str) -> Result<&'a str, String> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("entry.{key} must be a string"))
}

/// Read a required integer field (a `time.created`/`time.updated` epoch-ms value). JSON integers back
/// the i64 columns, matching how node:sqlite binds a JS integer.
fn field_i64(entry: &Value, key: &str) -> Result<i64, String> {
    entry
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("entry.time.{key} must be an integer"))
}

/// N-API: `saveSessionEntry` write boundary. Opens a read-write DB, applies the guarded upsert +
/// inline `touchSession`, and returns the JSON literal `"null"` (the TS returns `void`). `entry_json`
/// is the serialized `SessionEntryInfo` (`{ id, sessionID, type, time, data?, touchSession? }`).
#[napi]
pub fn save_session_entry_json(db_path: String, entry_json: String) -> napi::Result<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    save_session_entry(&conn, &entry).map_err(Error::from_reason)?;
    Ok("null".to_string())
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
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
             values ('s1','p','slug','/d','t','v',100,100)",
            [],
        )
        .expect("invariant: seed session");
        conn
    }

    fn entry_data(conn: &Connection, id: &str) -> String {
        conn.query_row("select data from session_entry where id = ?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .expect("read data")
    }

    fn session_time(conn: &Connection) -> i64 {
        conn.query_row("select time_updated from session where id='s1'", [], |r| {
            r.get(0)
        })
        .expect("read session time")
    }

    #[test]
    fn plain_non_model_selection_insert_stores_raw_data() {
        let conn = db();
        save_session_entry(
            &conn,
            &json!({
                "id": "e1", "sessionID": "s1", "type": "message",
                "time": { "created": 200, "updated": 300 }, "data": { "text": "hello" }
            }),
        )
        .expect("insert ok");
        assert_eq!(entry_data(&conn, "e1"), r#"{"text":"hello"}"#);
        // touchSession bumped 100 -> 300 (max).
        assert_eq!(session_time(&conn), 300);
    }

    #[test]
    fn model_selection_wraps_data_under_selection_key() {
        let conn = db();
        save_session_entry(
            &conn,
            &json!({
                "id": "m1", "sessionID": "s1", "type": SESSION_ENTRY_MODEL_SELECTION,
                "time": { "created": 200, "updated": 300 }, "data": { "providerId": "x" }
            }),
        )
        .expect("insert ok");
        assert_eq!(
            entry_data(&conn, "m1"),
            r#"{"modelSelection":{"providerId":"x"}}"#,
            "payload wrapped under the modelSelection key"
        );
    }

    #[test]
    fn model_selection_with_null_data_wraps_as_explicit_null() {
        let conn = db();
        // `data` absent (undefined) → `{ modelSelection: null }`, still serializable (no throw).
        save_session_entry(
            &conn,
            &json!({
                "id": "mnull", "sessionID": "s1", "type": SESSION_ENTRY_MODEL_SELECTION,
                "time": { "created": 1, "updated": 2 }
            }),
        )
        .expect("insert ok");
        assert_eq!(entry_data(&conn, "mnull"), r#"{"modelSelection":null}"#);
    }

    #[test]
    fn re_save_model_selection_merges_into_existing_object() {
        let conn = db();
        // Seed an existing model-selection row that carries an extra key beyond `modelSelection`,
        // so a merge (json_set) is observably different from a plain `excluded.data` overwrite.
        conn.execute(
            "insert into session_entry (id, session_id, type, time_created, time_updated, data)
             values ('m2','s1',?1,1,1,'{\"modelSelection\":{\"providerId\":\"old\"},\"keep\":\"yes\"}')",
            [SESSION_ENTRY_MODEL_SELECTION],
        )
        .expect("seed model_selection row");

        save_session_entry(
            &conn,
            &json!({
                "id": "m2", "sessionID": "s1", "type": SESSION_ENTRY_MODEL_SELECTION,
                "time": { "created": 5, "updated": 6 }, "data": { "providerId": "new" }
            }),
        )
        .expect("re-save ok");

        // CASE merge branch: `$.modelSelection` replaced, unrelated `keep` preserved.
        assert_eq!(
            entry_data(&conn, "m2"),
            r#"{"modelSelection":{"providerId":"new"},"keep":"yes"}"#,
            "json_set merged the new modelSelection into the existing object"
        );
    }

    #[test]
    fn re_save_with_changed_type_falls_through_to_excluded_data() {
        let conn = db();
        save_session_entry(
            &conn,
            &json!({
                "id": "t1", "sessionID": "s1", "type": SESSION_ENTRY_MODEL_SELECTION,
                "time": { "created": 1, "updated": 2 }, "data": { "providerId": "a" }
            }),
        )
        .expect("first model_selection insert");

        // Re-save the same id but as a different, non-model-selection type: the CASE's leading
        // `isModelSelection` is 0 and the type differs, so the whole CASE falls to `excluded.data`
        // (the raw new payload, no wrapper), not a merge.
        save_session_entry(
            &conn,
            &json!({
                "id": "t1", "sessionID": "s1", "type": "message",
                "time": { "created": 3, "updated": 4 }, "data": { "text": "plain" }
            }),
        )
        .expect("re-save changed type");

        assert_eq!(entry_data(&conn, "t1"), r#"{"text":"plain"}"#);
        let stored_type: String = conn
            .query_row("select type from session_entry where id='t1'", [], |r| {
                r.get(0)
            })
            .expect("read type");
        assert_eq!(stored_type, "message");
    }

    #[test]
    fn missing_data_non_model_selection_is_rejected() {
        let conn = db();
        let err = save_session_entry(
            &conn,
            &json!({
                "id": "bad", "sessionID": "s1", "type": "message",
                "time": { "created": 1, "updated": 2 }
            }),
        )
        .expect_err("undefined data must throw");
        assert_eq!(err, "Session entry data must be JSON-serializable");
    }

    #[test]
    fn touch_session_false_skips_the_session_bump() {
        let conn = db();
        conn.execute("update session set time_updated = 900 where id='s1'", [])
            .expect("advance session clock");
        save_session_entry(
            &conn,
            &json!({
                "id": "noTouch", "sessionID": "s1", "type": "message",
                "time": { "created": 1, "updated": 5000 }, "data": { "text": "t" },
                "touchSession": false
            }),
        )
        .expect("insert ok");
        // Entry was written, but the parent session clock is untouched (5000 > 900 would bump it).
        assert_eq!(entry_data(&conn, "noTouch"), r#"{"text":"t"}"#);
        assert_eq!(
            session_time(&conn),
            900,
            "touchSession:false must not bump session"
        );
    }
}
