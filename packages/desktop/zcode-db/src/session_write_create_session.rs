//! `createSession` WRITE path, ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts`
//! (lines 20-79).
//!
//! The TS is a single `insert into session (...) ... on conflict(id) do update set ...` statement
//! followed by a `mustGetSession` re-read. It runs NO transaction — one atomic statement, then a
//! plain `select * from session where id = ?` — so neither do we: adding a `BEGIN` where the source
//! has none would change lock and error-boundary behavior (the re-read of an upserted row must see
//! exactly the same autocommit visibility the TS `DatabaseSync` gets).
//!
//! The SQL text and the 18-value bind order are copied verbatim from `sessions.ts` (lines 29-76) so
//! the statement cannot drift from the source build: the seven `null` literals (summary/revert/time_
//! compacting/time_archived) stay literals, `permission` is the 15th bind, and the three derived
//! time values the last three.
//!
//! Reproduced TS subtleties (each mirrors the exact operator used in the source):
//! - `input.time?.created ?? now` / `input.time?.updated ?? timeCreated` (lines 25-26): nullish, so
//!   `0` is a VALID stored time and only `null`/absent falls back; `now` is INJECTED (the addon
//!   never reads the clock).
//! - `input.taskType ?? "interactive"` and `input.titleSource ?? "first_input"` (lines 63, 68): the
//!   defaults fire on null/undefined only — an explicitly-provided empty string is still bound and
//!   hits the `title_source` CHECK constraint exactly like the TS.
//! - `encodeJson(input.permission)` (`json.ts` line 1): `undefined`/`null` → SQL NULL; any other
//!   value → `JSON.stringify` (serde_json with `preserve_order` reproduces the compact text and the
//!   key order; keys with `undefined` values were already dropped by the JS `JSON.stringify` that
//!   serialized the input at the N-API boundary).
//! - `input.titleSource || input.titleMessageID ? timeUpdated : null` (line 75): JS *truthiness*,
//!   NOT nullish — an empty-string `titleSource` is falsy here even though the `??` on line 68
//!   stored it as `''` in the column.
//! - the read-back returns `crate::session_sessions::get_session`'s `decodeSessionRow` projection
//!   byte-identically (fixed key order), and a vanished row throws
//!   `Session not found after write: <id>` exactly like `mustGetSession` (line 354).

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde_json::Value;

/// The verbatim TS statement (`sessions.ts` lines 30-55), including the upsert arm:
/// `trace_id = coalesce(session.trace_id, excluded.trace_id)` keeps an existing trace,
/// `permission = coalesce(excluded.permission, session.permission)` keeps an existing ruleset when
/// the new one is NULL, and `time_created` is never touched by the conflict arm.
const CREATE_SESSION_SQL: &str = "
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
      ";

/// JS truthiness for `input.titleSource || input.titleMessageID` (line 75): `undefined`/`null` and
/// the empty string are falsy; any other JSON value is truthy. Private to this module.
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// A nullish-coalesced (`?? null`) nullable text column: `undefined`/`null` → SQL NULL; a string is
/// kept verbatim (an empty string is NOT nullish and must survive to the bind, unlike a truthiness
/// check). Private to this module.
fn opt_str<'a>(obj: &'a Value, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

/// Port of `encodeJson` (`json.ts` line 1) for `input.permission`: `undefined`/`null` → `None`
/// (SQL NULL); any other value → its compact JSON text. `serde_json` carries `preserve_order`, so
/// a parsed object re-serializes with the input's key order, matching `JSON.stringify`.
fn encode_json(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.to_string()),
    }
}

/// Read a required string field (TS direct property access into a NOT NULL column; an absent or
/// non-string value would fail the bind on the TS side too).
fn req_str<'a>(obj: &'a Value, key: &str) -> Result<&'a str, String> {
    obj.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("createSession input.{key} must be a string"))
}

/// Port of `createSession` against an already-open read-write connection: one atomic upsert (no
/// transaction, exactly as the TS) plus the `mustGetSession` re-read.
///
/// # Arguments
///
/// * `conn` - an open read-write connection (`crate::open_readwrite` sets FK enforcement + WAL).
/// * `input` - the `CreateSessionInput` as a JSON object. Key presence models a defined JS field;
///   `Value::Null` models an explicit `null` (both are nullish for `??`, only `null`-ish values are
///   falsy nowhere the TS uses truthiness — see the module docs for the `||` case).
/// * `now` - the epoch ms the TS would read from `Date.now()`, injected for determinism.
///
/// # Returns
///
/// The re-read `SessionInfo` projection (`crate::session_sessions::get_session`'s decode).
///
/// # Errors
///
/// Returns `Err` for a missing/mis-typed required field, a statement failure (e.g. a `title_source`
/// CHECK violation), or `Session not found after write: <id>` when the re-read is missing.
pub fn create_session(conn: &Connection, input: &Value, now: i64) -> Result<Value, String> {
    if !input.is_object() {
        return Err("createSession input must be an object".to_string());
    }

    // `const timeCreated = input.time?.created ?? now;` / `const timeUpdated = input.time?.updated
    // ?? timeCreated;` — `??` keeps `0`, so only null/absent falls back.
    let time_obj = input.get("time").filter(|t| !t.is_null());
    let time_created = time_obj
        .and_then(|t| t.get("created"))
        .and_then(Value::as_i64)
        .unwrap_or(now);
    let time_updated = time_obj
        .and_then(|t| t.get("updated"))
        .and_then(Value::as_i64)
        .unwrap_or(time_created);

    // `input.titleSource || input.titleMessageID ? timeUpdated : null` — truthiness, not `??`.
    let time_title_updated = if is_truthy(input.get("titleSource"))
        || is_truthy(input.get("titleMessageID"))
    {
        Some(time_updated)
    } else {
        None
    };

    let id = req_str(input, "id")?.to_string();
    conn.execute(
        CREATE_SESSION_SQL,
        params![
            id,                                       // input.id
            req_str(input, "projectID")?,             // input.projectID
            opt_str(input, "workspaceID"),            // input.workspaceID ?? null
            opt_str(input, "parentID"),               // input.parentID ?? null
            opt_str(input, "traceID"),                // input.traceID ?? null
            opt_str(input, "taskType")
                .unwrap_or("interactive"),            // input.taskType ?? "interactive"
            req_str(input, "slug")?,                  // input.slug
            req_str(input, "directory")?,             // input.directory
            opt_str(input, "path"),                   // input.path ?? null
            req_str(input, "title")?,                 // input.title
            opt_str(input, "titleSource")
                .unwrap_or("first_input"),            // input.titleSource ?? "first_input"
            opt_str(input, "titleMessageID"),         // input.titleMessageID ?? null
            req_str(input, "version")?,               // input.version
            opt_str(input, "shareURL"),               // input.shareURL ?? null
            encode_json(input.get("permission")),     // encodeJson(input.permission)
            time_created,
            time_updated,
            time_title_updated,
        ],
    )
    .map_err(|e| e.to_string())?;

    // `return mustGetSession(db, input.id);` — re-read through the SAME projection as `getSession`.
    let session = crate::session_sessions::get_session(conn, &id)?;
    if session.is_null() {
        return Err(format!("Session not found after write: {id}"));
    }
    Ok(session)
}

/// N-API: `createSession` write boundary. `input_json` is the serialized `CreateSessionInput`;
/// `now` is a JS number (epoch ms) injected as the TS `Date.now()` so the addon never reads the
/// clock. Returns the re-read `SessionInfo` as a JSON string.
#[napi]
pub fn create_session_json(db_path: String, input_json: String, now: f64) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let session = create_session(&conn, &input, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&session).map_err(|e| Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// In-memory DB carrying the full session schema (including the `task_type`, `title_source`,
    /// `title_message_id`, `time_title_updated` and `trace_id` ALTER migrations) exactly as the
    /// production bootstrap applies them, so CHECK constraints fire identically.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute("PRAGMA foreign_keys = ON", [])
            .expect("invariant: enable fk");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 1_000)
            .expect("invariant: apply session schema");
        conn
    }

    /// Raw stored columns for direct NULL-vs-default assertions.
    struct Stored {
        workspace: Option<String>,
        task_type: String,
        title_source: String,
        permission: Option<String>,
        share: Option<String>,
        created: i64,
        updated: i64,
        title_ts: Option<i64>,
    }

    fn stored(conn: &Connection, id: &str) -> Stored {
        conn.query_row(
            "select workspace_id, task_type, title_source, permission, \
             share_url, time_created, time_updated, time_title_updated \
             from session where id = ?1",
            [id],
            |r| {
                Ok(Stored {
                    workspace: r.get(0)?,
                    task_type: r.get(1)?,
                    title_source: r.get(2)?,
                    permission: r.get(3)?,
                    share: r.get(4)?,
                    created: r.get(5)?,
                    updated: r.get(6)?,
                    title_ts: r.get(7)?,
                })
            },
        )
        .expect("row present")
    }

    #[test]
    fn minimal_input_applies_defaults_and_null_columns() {
        let conn = db();
        let out = create_session(
            &conn,
            &json!({
                "id": "s1", "projectID": "p1", "slug": "sl", "directory": "/d",
                "title": "T", "version": "v1"
            }),
            5_000,
        )
        .expect("create ok");
        let row = stored(&conn, "s1");
        assert_eq!(row.workspace, None, "absent workspaceID binds NULL");
        assert_eq!(row.task_type, "interactive", "taskType ?? default applied");
        assert_eq!(row.title_source, "first_input", "titleSource ?? default applied");
        assert_eq!(row.permission, None, "encodeJson(undefined) is NULL");
        assert_eq!(row.share, None);
        assert_eq!(row.created, 5_000, "time?.created ?? now");
        assert_eq!(row.updated, 5_000, "time?.updated ?? timeCreated");
        assert_eq!(row.title_ts, None, "falsy titleSource||titleMessageID → NULL");
        // Read-back projection: fixed decodeSessionRow key order, defaults visible.
        assert_eq!(
            out.to_string(),
            r#"{"id":"s1","projectID":"p1","taskType":"interactive","slug":"sl","directory":"/d","title":"T","titleSource":"first_input","version":"v1","time":{"created":5000,"updated":5000}}"#
        );
    }

    #[test]
    fn full_input_binds_every_optional_and_mirrors_permission_json_order() {
        let conn = db();
        let out = create_session(
            &conn,
            &json!({
                "id": "s2", "projectID": "p2", "workspaceID": "w2", "parentID": "sp",
                "traceID": "tr2", "taskType": "fork", "slug": "sl2", "directory": "/d2",
                "path": "/d2/sub", "title": "T2", "titleSource": "generated",
                "titleMessageID": "m9", "version": "v2", "shareURL": "https://x",
                "permission": { "b": 1, "a": [2, {"deep": null}] },
                "time": { "created": 100, "updated": 200 }
            }),
            9_999,
        )
        .expect("create ok");
        let row = stored(&conn, "s2");
        assert_eq!(row.workspace.as_deref(), Some("w2"));
        assert_eq!(row.task_type, "fork");
        assert_eq!(row.title_source, "generated");
        // preserve_order: re-serialization keeps the input's key order exactly like JSON.stringify.
        assert_eq!(row.permission.as_deref(), Some(r#"{"b":1,"a":[2,{"deep":null}]}"#));
        assert_eq!(row.share.as_deref(), Some("https://x"));
        assert_eq!(row.created, 100, "explicit time.created wins over now");
        assert_eq!(row.updated, 200, "explicit time.updated wins over timeCreated");
        assert_eq!(row.title_ts, Some(200), "truthy titleSource → time_title_updated = timeUpdated");
        assert_eq!(
            out.get("parentID").and_then(Value::as_str),
            Some("sp"),
            "read-back carries parentID"
        );
        assert_eq!(out["permission"], json!({ "b": 1, "a": [2, { "deep": null }] }));
    }

    #[test]
    fn explicit_null_and_absent_optionals_both_store_null_zero_time_is_kept() {
        let conn = db();
        create_session(
            &conn,
            &json!({
                "id": "s3", "projectID": "p3", "slug": "sl", "directory": "/d",
                "title": "T", "version": "v",
                "workspaceID": null, "path": null, "shareURL": null, "traceID": null,
                "parentID": null, "titleMessageID": null, "permission": null,
                "time": { "created": 0 }
            }),
            7_000,
        )
        .expect("explicit nulls ok");
        let row = stored(&conn, "s3");
        assert_eq!(row.workspace, None, "explicit null → NULL, same as absent (?? nullish)");
        assert_eq!(row.permission, None, "encodeJson(null) is NULL");
        assert_eq!(row.share, None);
        assert_eq!(row.created, 0, "?? keeps 0 as a valid stored time (not replaced by now)");
        assert_eq!(row.updated, 0, "time?.updated ?? timeCreated keeps the 0");
    }

    #[test]
    fn title_message_id_alone_stamps_time_title_updated_defaulted_title_source() {
        let conn = db();
        create_session(
            &conn,
            &json!({
                "id": "s4", "projectID": "p4", "slug": "sl", "directory": "/d",
                "title": "T", "version": "v", "titleMessageID": "m1"
            }),
            4_000,
        )
        .expect("create ok");
        let row = stored(&conn, "s4");
        assert_eq!(row.title_source, "first_input", "absent titleSource still defaults the column");
        assert_eq!(row.title_ts, Some(row.updated), "truthy titleMessageID stamps time_title_updated");
    }

    #[test]
    fn re_create_same_id_takes_upsert_arm_preserving_trace_permission_and_time_created() {
        let conn = db();
        create_session(
            &conn,
            &json!({
                "id": "s5", "projectID": "p5", "slug": "sl", "directory": "/d",
                "title": "T", "version": "v", "traceID": "trace-keep",
                "permission": { "rules": ["a"] }, "time": { "created": 111, "updated": 222 }
            }),
            3_000,
        )
        .expect("first create");
        create_session(
            &conn,
            &json!({
                "id": "s5", "projectID": "p5b", "slug": "sl-new", "directory": "/d",
                "title": "T2", "version": "v", "time": { "created": 999, "updated": 888 }
            }),
            3_000,
        )
        .expect("re-create same id");
        let row = stored(&conn, "s5");
        assert_eq!(row.created, 111, "time_created is NOT in the conflict arm → preserved");
        assert_eq!(row.updated, 888, "time_updated = excluded.time_updated");
        assert_eq!(row.permission.as_deref(), Some(r#"{"rules":["a"]}"#), "coalesce(excluded, session) keeps old permission when new is NULL");
        let trace: Option<String> = conn
            .query_row("select trace_id from session where id='s5'", [], |r| r.get(0))
            .expect("trace");
        assert_eq!(trace.as_deref(), Some("trace-keep"), "coalesce(session.trace_id, excluded) keeps existing trace");
    }

    #[test]
    fn invalid_title_source_violates_check_and_empty_string_is_not_defaulted() {
        let conn = db();
        // `??` does NOT replace the empty string with the default, so the CHECK rejects it —
        // exactly like the TS binding '' to the column.
        let err = create_session(
            &conn,
            &json!({
                "id": "s6", "projectID": "p6", "slug": "sl", "directory": "/d",
                "title": "T", "version": "v", "titleSource": ""
            }),
            1,
        )
        .unwrap_err();
        assert!(err.contains("CHECK"), "expected a CHECK constraint failure, got: {err}");
        let err2 = create_session(
            &conn,
            &json!({
                "id": "s6", "projectID": "p6", "slug": "sl", "directory": "/d",
                "title": "T", "version": "v", "titleSource": "bogus"
            }),
            1,
        )
        .unwrap_err();
        assert!(err2.contains("CHECK"), "invalid enum must hit the CHECK: {err2}");
    }

    #[test]
    fn missing_required_field_errors_before_any_statement() {
        let conn = db();
        let err = create_session(
            &conn,
            &json!({ "id": "s7", "projectID": "p7", "slug": "sl" }),
            1,
        )
        .unwrap_err();
        assert!(err.contains("directory"), "expected directory error: {err}");
        let count: i64 = conn
            .query_row("select count(*) from session", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 0, "failed validation must not write a row");
    }
}
