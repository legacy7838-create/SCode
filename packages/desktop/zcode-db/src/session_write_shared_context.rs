//! Shared-context import composite write ops (ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`, lines
//! 472-577): `commitSharedContextImportBundle` and `transitionSharedContextImport`.
//!
//! Both are ATOMIC composites wrapping multiple sub-writes inside ONE `BEGIN IMMEDIATE` ... `COMMIT`
//! / `ROLLBACK` transaction, exactly as the TS class method does. The stateless addon opens a fresh
//! read-write connection per call and drives the transaction manually so no sub-step is committed
//! without the others.
//!
//! ## commitSharedContextImportBundle
//!
//! The multi-clause identity guard (contextMessage/provenance session match, `provenance.id` must
//! include the session id, role/visibility/source checks) throws
//! `"Shared context import bundle identity is invalid"` BEFORE the transaction opens — no writes on
//! guard failure.
//!
//! The provenance-namespace rationale: `session_entry.id` is a global PK; `saveSessionEntry`'s
//! `on conflict(id)` arm rewrites `session_id`, so a bare provenance id would let a second import
//! steal the first session's row (the first session's transcript silently disappears). The guard
//! enforces `provenance.id.includes(session.id)` at the single write entry point, covering all
//! callers rather than fixing one specific construction site.
//!
//! Inside the transaction:
//! - Idempotency: if the session already exists (`getSession`), find the provenance entry by `id`.
//!   Missing → throw `"Shared context import session is incomplete"`. Present → COMMIT + return.
//! - Fresh import: `createSession`, `saveMessage`, `savePart` (for each part),
//!   `saveSessionEntry`. COMMIT + return the persisted `SessionInfo`.
//!
//! ## transitionSharedContextImport
//!
//! Status transition for an existing `v4/shared_context_import` entry identified by
//! `data.contextId`. Guard chain:
//! 1. Entry must exist (otherwise ROLLBACK + false).
//! 2. Entry's `data.status` must be in `expectedStatus` (otherwise ROLLBACK + false).
//! 3. Update the entry with new `status` and optional `sourceId`.
//! 4. If a message with `info.metadata.contextId === input.contextId` exists, re-save it with
//!    `sharedContextStatus` stamped into its metadata.
//! 5. COMMIT + return true.
//!
//! Any statement failure inside the transaction rolls back and propagates the error.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::Connection;
use serde_json::{Map, Value};

/// Port of `commitSharedContextImportBundle` against an already-open read-write connection.
///
/// Runs the identity guard BEFORE `BEGIN IMMEDIATE`; on success, opens the transaction and either
/// returns the pre-existing session (idempotency path) or writes the full bundle (fresh-import path).
/// Any error rolls back.
///
/// # Arguments
///
/// * `conn` — an open read-write connection (`crate::open_readwrite` sets FK enforcement + WAL).
/// * `bundle` — the `SharedContextImportCommitBundle` as a JSON object:
///   `{ session: CreateSessionInput, contextMessage: { info: MessageInfo, parts: MessagePart[] },
///      provenance: SessionEntryInfo }`.
/// * `now` — injected epoch ms; forwarded to the sub-write cores as their `Date.now()` fallback.
///
/// # Returns
///
/// The `SessionInfo` projection (created or pre-existing), as a `serde_json::Value`.
///
/// # Errors
///
/// - `"Shared context import bundle identity is invalid"` when any guard clause fails (no writes).
/// - `"Shared context import session is incomplete"` when the session exists but the provenance
///   entry matching `provenance.id` is missing (rolls back).
/// - Any `rusqlite` / sibling-module error string from the sub-writes (rolls back).
pub fn commit_shared_context_import_bundle(
    conn: &Connection,
    bundle: &Value,
    now: i64,
) -> Result<Value, String> {
    let session = bundle
        .get("session")
        .ok_or_else(|| "bundle.session is required".to_string())?;
    let context_message = bundle
        .get("contextMessage")
        .ok_or_else(|| "bundle.contextMessage is required".to_string())?;
    let provenance = bundle
        .get("provenance")
        .ok_or_else(|| "bundle.provenance is required".to_string())?;

    let msg_info = context_message
        .get("info")
        .ok_or_else(|| "contextMessage.info is required".to_string())?;
    let parts = context_message
        .get("parts")
        .and_then(Value::as_array)
        .ok_or_else(|| "contextMessage.parts must be an array".to_string())?;

    let session_id = session
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "session.id must be a string".to_string())?;

    // Identity guard (mirrors TS lines 477-489 verbatim): every clause must pass before any write.
    //
    // - `String(contextMessage.info.sessionID) !== String(session.id)`: both are strings already in
    //   the JSON; `String()` is a no-op on the Rust side. The comparison uses `!=` (strict `!==`).
    // - `String(provenance.sessionID) !== String(session.id)`: same rationale.
    // - `!provenance.id.includes(String(session.id))`: the provenance id must contain the session id
    //   as a substring. This guards against the global-PK re-binding vector.
    // - `contextMessage.info.role !== "user"`, `visibility !== "model-only"`, `source !==
    //   "shared_context"`: role/visibility/source checks on the context message.
    let msg_session_id = msg_info.get("sessionID").and_then(Value::as_str).unwrap_or("");
    let prov_session_id = provenance.get("sessionID").and_then(Value::as_str).unwrap_or("");
    let prov_id = provenance.get("id").and_then(Value::as_str).unwrap_or("");

    if msg_session_id != session_id
        || prov_session_id != session_id
        || !prov_id.contains(session_id)
        || msg_info.get("role").and_then(Value::as_str) != Some("user")
        || msg_info.get("visibility").and_then(Value::as_str) != Some("model-only")
        || msg_info.get("source").and_then(Value::as_str) != Some("shared_context")
    {
        return Err("Shared context import bundle identity is invalid".to_string());
    }

    // BEGIN IMMEDIATE: acquire the write lock before any operation.
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;

    let body = || -> Result<Value, String> {
        // Idempotency check: does the session already exist?
        let existing = crate::session_sessions::get_session(conn, session_id)?;
        if !existing.is_null() {
            // Look for the provenance entry matching `provenance.id` among entries of the same type.
            let prov_type = provenance
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("");
            let entries =
                crate::session_entries::session_entries(conn, session_id, Some(prov_type))?;
            let found = entries
                .as_array()
                .and_then(|arr| {
                    arr.iter()
                        .find(|c| c.get("id").and_then(Value::as_str) == Some(prov_id))
                })
                .is_some();
            if !found {
                return Err("Shared context import session is incomplete".to_string());
            }
            return Ok(existing);
        }

        // Fresh import path: create session, save message, save parts, save provenance entry.
        let persisted = crate::session_write_create_session::create_session(conn, session, now)?;
        crate::session_write_messages::save_message(conn, msg_info, None, now)?;
        for part in parts {
            crate::session_write_messages::save_part(conn, part, None, now)?;
        }
        crate::session_write_entry::save_session_entry(conn, provenance)?;
        Ok(persisted)
    }();

    match body {
        Ok(session_info) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(session_info)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// Port of `transitionSharedContextImport` against an already-open read-write connection.
///
/// Opens `BEGIN IMMEDIATE`, locates the `v4/shared_context_import` entry by `data.contextId`,
/// validates the status guard, updates the entry (and optionally the context message metadata),
/// then COMMITs. Returns `true` on success, `false` when the entry is absent or its status does not
/// match `expectedStatus` (in both cases a ROLLBACK runs first).
///
/// # Arguments
///
/// * `conn` — an open read-write connection.
/// * `input` — the `SharedContextImportTransition` as a JSON object:
///   `{ sessionID, contextId, expectedStatus, status, sourceId? }`.
/// * `now` — injected epoch ms; used for `entry.time.updated` and forwarded to `save_message`.
///
/// # Returns
///
/// `true` if the transition was applied, `false` if the entry was not found or the status guard
/// rejected it.
///
/// # Errors
///
/// Propagates any `rusqlite` / sibling-module error from the sub-writes (rolls back).
pub fn transition_shared_context_import(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> Result<bool, String> {
    let session_id = input
        .get("sessionID")
        .and_then(Value::as_str)
        .ok_or_else(|| "input.sessionID must be a string".to_string())?;
    let context_id = input
        .get("contextId")
        .and_then(Value::as_str)
        .ok_or_else(|| "input.contextId must be a string".to_string())?;

    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;

    let body = || -> Result<bool, String> {
        // Find the `v4/shared_context_import` entry whose `data.contextId === input.contextId`.
        let entries =
            crate::session_entries::session_entries(conn, session_id, Some("v4/shared_context_import"))?;
        let entry = entries.as_array().and_then(|arr| {
            arr.iter().find(|c| {
                let data = c.get("data");
                matches!(data, Some(Value::Object(d)) if
                    d.get("contextId").and_then(Value::as_str) == Some(context_id))
            })
        });

        let Some(entry) = entry else {
            let _ = conn.execute("ROLLBACK", []);
            return Ok(false);
        };

        // Status guard: `expectedStatus` (single value or array) must include `data.status`.
        let data = entry.get("data").cloned().unwrap_or(Value::Null);
        let entry_status = data.get("status").and_then(Value::as_str).unwrap_or("");

        let expected = match input.get("expectedStatus") {
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>(),
            Some(v) => vec![v.as_str().unwrap_or("")],
            None => vec![],
        };

        if !expected.contains(&entry_status) {
            let _ = conn.execute("ROLLBACK", []);
            return Ok(false);
        }

        // Build the updated entry: `{ ...entry, time: { ...entry.time, updated: now },
        //   data: { ...data, status: input.status, ...(input.sourceId ? {sourceId} : {}) } }`.
        let mut updated_entry = entry.as_object().cloned().unwrap_or_default();
        updated_entry.insert(
            "time".to_string(),
            with_updated_time(entry.get("time"), now),
        );

        let mut new_data = match &data {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        new_data.insert(
            "status".to_string(),
            Value::String(
                input
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ),
        );
        // `...(input.sourceId ? { sourceId: input.sourceId } : {})`: truthiness check.
        if let Some(sid) = input.get("sourceId") {
            if is_js_truthy(sid) {
                new_data.insert("sourceId".to_string(), sid.clone());
            }
        }
        updated_entry.insert("data".to_string(), Value::Object(new_data));

        crate::session_write_entry::save_session_entry(
            conn,
            &Value::Object(updated_entry),
        )?;

        // Find the context message whose `info.metadata.contextId === input.contextId` and re-save
        // it with `sharedContextStatus` in its metadata.
        let msgs = crate::session_messages::messages(conn, session_id)?;
        let context_msg_info = msgs.as_array().and_then(|arr| {
            arr.iter().find_map(|m| {
                let info = m.get("info")?;
                let meta = info.get("metadata");
                if matches!(meta, Some(Value::Object(md)) if
                    md.get("contextId").and_then(Value::as_str) == Some(context_id))
                {
                    Some(info.clone())
                } else {
                    None
                }
            })
        });

        if let Some(info) = context_msg_info {
            let mut obj = info.as_object().cloned().unwrap_or_default();
            // `{ ...(info.metadata ?? {}), sharedContextStatus: input.status }`
            let mut md = match info.get("metadata") {
                Some(Value::Object(m)) => m.clone(),
                _ => Map::new(),
            };
            md.insert(
                "sharedContextStatus".to_string(),
                Value::String(
                    input
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                ),
            );
            obj.insert("metadata".to_string(), Value::Object(md));
            crate::session_write_messages::save_message(conn, &Value::Object(obj), None, now)?;
        }

        Ok(true)
    }();

    match body {
        Ok(result) => {
            // The `false` early-returns already rolled back; only COMMIT when `true`.
            if result {
                conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            }
            Ok(result)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// TS `{ ...entry.time, updated: now }`: copy existing time keys, set `updated`. Keeps insertion
/// order for existing keys (assignment semantics) and appends `updated` if absent.
fn with_updated_time(time: Option<&Value>, now: i64) -> Value {
    let mut m = match time {
        Some(Value::Object(obj)) => obj.clone(),
        _ => Map::new(),
    };
    m.insert("updated".to_string(), Value::Number(now.into()));
    Value::Object(m)
}

/// JS truthiness: `null`/`false`/`0`/`NaN`/`""`/`undefined` are falsy; everything else is truthy.
fn is_js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// N-API: `commitSharedContextImportBundle` write boundary. Opens a read-write DB, runs the
/// identity guard + composite transaction, and returns the `SessionInfo` JSON.
///
/// `bundle_json` is the serialized `SharedContextImportCommitBundle`; `now` is the injected epoch ms.
#[napi]
pub fn commit_shared_context_import_bundle_json(
    db_path: String,
    bundle_json: String,
    now: f64,
) -> napi::Result<String> {
    let bundle: Value =
        serde_json::from_str(&bundle_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let session =
        commit_shared_context_import_bundle(&conn, &bundle, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&session).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `transitionSharedContextImport` write boundary. Opens a read-write DB, runs the composite
/// status transition, and returns the boolean projection as a JSON literal (`"true"` / `"false"`).
///
/// `input_json` is the serialized `SharedContextImportTransition`; `now` is the injected epoch ms.
#[napi]
pub fn transition_shared_context_import_json(
    db_path: String,
    input_json: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let result =
        transition_shared_context_import(&conn, &input, now as i64).map_err(Error::from_reason)?;
    Ok(result.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE session (
               id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
               trace_id TEXT, task_type TEXT DEFAULT 'interactive', slug TEXT NOT NULL,
               directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, title_source TEXT,
               title_message_id TEXT, version TEXT NOT NULL, share_url TEXT,
               summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
               summary_diffs TEXT, revert TEXT, permission TEXT,
               time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
               time_title_updated INTEGER, time_compacting INTEGER, time_archived INTEGER
             );
             CREATE TABLE message (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
               time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
               data TEXT NOT NULL, sequence INTEGER
             );
             CREATE TABLE part (
               id TEXT PRIMARY KEY,
               message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
               session_id TEXT NOT NULL,
               time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
               data TEXT NOT NULL, sequence INTEGER
             );
             CREATE TABLE session_entry (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
               type TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
               data TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    fn seed_session(conn: &Connection) {
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version,
              time_created, time_updated) values ('s1','p','s','/d','t','v',1,1)",
            [],
        )
        .unwrap();
    }

    fn valid_bundle_json() -> Value {
        serde_json::json!({
            "session": {
                "id": "import-s1",
                "projectID": "p1",
                "slug": "imported",
                "directory": "/tmp",
                "title": "Imported",
                "version": "1",
                "time": { "created": 100, "updated": 100 }
            },
            "contextMessage": {
                "info": {
                    "id": "msg-ctx-1",
                    "sessionID": "import-s1",
                    "role": "user",
                    "visibility": "model-only",
                    "source": "shared_context",
                    "time": { "created": 100 },
                    "metadata": { "contextId": "ctx-abc" }
                },
                "parts": [
                    {
                        "id": "part-1",
                        "sessionID": "import-s1",
                        "messageID": "msg-ctx-1",
                        "type": "text",
                        "text": "hello from shared context"
                    }
                ]
            },
            "provenance": {
                "id": "prov-import-s1-001",
                "sessionID": "import-s1",
                "type": "v4/shared_context_import",
                "time": { "created": 100, "updated": 100 },
                "data": {
                    "contextId": "ctx-abc",
                    "status": "pending"
                },
                "touchSession": false
            }
        })
    }

    #[test]
    fn commit_happy_path() {
        let conn = setup_db();
        // Need project FK: our session has project_id='p1' but no FK on project in test schema
        // (simplified). Just run the composite.
        let bundle = valid_bundle_json();
        let result = commit_shared_context_import_bundle(&conn, &bundle, 200);
        assert!(result.is_ok(), "happy path should succeed: {:?}", result.err());
        let session = result.unwrap();
        assert_eq!(session["id"], "import-s1");
    }

    #[test]
    fn commit_idempotency_returns_existing() {
        let conn = setup_db();
        let bundle = valid_bundle_json();
        // First import: creates the session.
        let r1 = commit_shared_context_import_bundle(&conn, &bundle, 200).unwrap();
        // Second import: same bundle -> session already exists with the provenance entry.
        let r2 = commit_shared_context_import_bundle(&conn, &bundle, 300).unwrap();
        assert_eq!(r1["id"], r2["id"]);
    }

    #[test]
    fn guard_rejects_mismatched_context_session_id() {
        let conn = setup_db();
        let mut bundle = valid_bundle_json();
        bundle["contextMessage"]["info"]["sessionID"] =
            serde_json::json!("different-session");
        let result = commit_shared_context_import_bundle(&conn, &bundle, 200);
        assert_eq!(
            result.err().unwrap(),
            "Shared context import bundle identity is invalid"
        );
        // No writes: session should not exist.
        let s = crate::session_sessions::get_session(&conn, "import-s1").unwrap();
        assert!(s.is_null());
    }

    #[test]
    fn guard_rejects_mismatched_provenance_session_id() {
        let conn = setup_db();
        let mut bundle = valid_bundle_json();
        bundle["provenance"]["sessionID"] = serde_json::json!("other");
        let result = commit_shared_context_import_bundle(&conn, &bundle, 200);
        assert_eq!(
            result.err().unwrap(),
            "Shared context import bundle identity is invalid"
        );
    }

    #[test]
    fn guard_rejects_provenance_id_without_session_namespace() {
        let conn = setup_db();
        let mut bundle = valid_bundle_json();
        // provenance.id must include the session id as substring
        bundle["provenance"]["id"] = serde_json::json!("bare-prov-id");
        let result = commit_shared_context_import_bundle(&conn, &bundle, 200);
        assert_eq!(
            result.err().unwrap(),
            "Shared context import bundle identity is invalid"
        );
    }

    #[test]
    fn guard_rejects_wrong_role() {
        let conn = setup_db();
        let mut bundle = valid_bundle_json();
        bundle["contextMessage"]["info"]["role"] = serde_json::json!("assistant");
        let result = commit_shared_context_import_bundle(&conn, &bundle, 200);
        assert_eq!(
            result.err().unwrap(),
            "Shared context import bundle identity is invalid"
        );
    }

    #[test]
    fn guard_rejects_wrong_visibility() {
        let conn = setup_db();
        let mut bundle = valid_bundle_json();
        bundle["contextMessage"]["info"]["visibility"] = serde_json::json!("full");
        let result = commit_shared_context_import_bundle(&conn, &bundle, 200);
        assert_eq!(
            result.err().unwrap(),
            "Shared context import bundle identity is invalid"
        );
    }

    #[test]
    fn guard_rejects_wrong_source() {
        let conn = setup_db();
        let mut bundle = valid_bundle_json();
        bundle["contextMessage"]["info"]["source"] = serde_json::json!("other_source");
        let result = commit_shared_context_import_bundle(&conn, &bundle, 200);
        assert_eq!(
            result.err().unwrap(),
            "Shared context import bundle identity is invalid"
        );
    }

    #[test]
    fn rollback_on_partial_failure() {
        let conn = setup_db();
        let mut bundle = valid_bundle_json();
        // Part references a non-existent messageID. The `part.message_id` FK to `message(id)`
        // will fail after save_message succeeds but before save_part completes.
        bundle["contextMessage"]["parts"] = serde_json::json!([
            {
                "id": "part-bad",
                "sessionID": "import-s1",
                "messageID": "nonexistent-msg",
                "type": "text",
                "text": "fail"
            }
        ]);

        let result = commit_shared_context_import_bundle(&conn, &bundle, 200);
        assert!(result.is_err(), "should fail due to FK violation on part");

        // Rollback must undo ALL prior writes including session creation.
        let s = crate::session_sessions::get_session(&conn, "import-s1").unwrap();
        assert!(s.is_null(), "rollback must undo the session creation");
    }

    #[test]
    fn transition_returns_false_when_entry_missing() {
        let conn = setup_db();
        seed_session(&conn);
        let input = serde_json::json!({
            "sessionID": "s1",
            "contextId": "no-such-ctx",
            "expectedStatus": "pending",
            "status": "reserved"
        });
        let result = transition_shared_context_import(&conn, &input, 999).unwrap();
        assert!(!result);
    }

    #[test]
    fn transition_returns_false_on_status_mismatch() {
        let conn = setup_db();
        seed_session(&conn);
        // Insert a shared_context_import entry with status "attached"
        conn.execute(
            "insert into session_entry (id, session_id, type, time_created, time_updated, data)
             values ('entry-1', 's1', 'v4/shared_context_import', 1, 1,
               '{\"contextId\":\"ctx-1\",\"status\":\"attached\"}')",
            [],
        )
        .unwrap();

        let input = serde_json::json!({
            "sessionID": "s1",
            "contextId": "ctx-1",
            "expectedStatus": "pending",
            "status": "reserved"
        });
        let result = transition_shared_context_import(&conn, &input, 999).unwrap();
        assert!(!result);
    }

    #[test]
    fn transition_success_updates_entry_and_message() {
        let conn = setup_db();
        seed_session(&conn);
        conn.execute(
            "insert into session_entry (id, session_id, type, time_created, time_updated, data)
             values ('entry-1', 's1', 'v4/shared_context_import', 1, 1,
               '{\"contextId\":\"ctx-1\",\"status\":\"pending\"}')",
            [],
        )
        .unwrap();
        // Insert a message with metadata.contextId = "ctx-1" (must include `time` for save_message).
        conn.execute(
            "insert into message (id, session_id, time_created, time_updated, data)
             values ('msg-1', 's1', 1, 1,
               '{\"role\":\"user\",\"time\":{\"created\":1},\"metadata\":{\"contextId\":\"ctx-1\"}}')",
            [],
        )
        .unwrap();

        let input = serde_json::json!({
            "sessionID": "s1",
            "contextId": "ctx-1",
            "expectedStatus": ["pending", "reserved"],
            "status": "reserved",
            "sourceId": "src-123"
        });
        let result = transition_shared_context_import(&conn, &input, 500).unwrap();
        assert!(result);

        // Verify entry was updated
        let raw: String = conn
            .query_row(
                "select data from session_entry where id = 'entry-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let data: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(data["status"], "reserved");
        assert_eq!(data["sourceId"], "src-123");

        // Verify time_updated was bumped
        let tu: i64 = conn
            .query_row(
                "select time_updated from session_entry where id = 'entry-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tu, 500);

        // Verify message metadata was updated
        let mdata: String = conn
            .query_row("select data from message where id = 'msg-1'", [], |r| r.get(0))
            .unwrap();
        let msg: Value = serde_json::from_str(&mdata).unwrap();
        assert_eq!(msg["metadata"]["sharedContextStatus"], "reserved");
    }

    #[test]
    fn transition_without_source_id_does_not_add_key() {
        let conn = setup_db();
        seed_session(&conn);
        conn.execute(
            "insert into session_entry (id, session_id, type, time_created, time_updated, data)
             values ('entry-1', 's1', 'v4/shared_context_import', 1, 1,
               '{\"contextId\":\"ctx-1\",\"status\":\"pending\"}')",
            [],
        )
        .unwrap();

        let input = serde_json::json!({
            "sessionID": "s1",
            "contextId": "ctx-1",
            "expectedStatus": "pending",
            "status": "attached"
        });
        let result = transition_shared_context_import(&conn, &input, 500).unwrap();
        assert!(result);

        let raw: String = conn
            .query_row(
                "select data from session_entry where id = 'entry-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let data: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(data["status"], "attached");
        assert!(data.get("sourceId").is_none());
    }
}
