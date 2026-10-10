//! `updateSession` / `setRevert` / `clearRevert` write path (ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts`).
//!
//! `updateSession` reads the current row through the SAME read projection as `getSession`
//! ([`crate::session_sessions::get_session`]) so the TS `?? current` / explicit-`null` / strict
//! `=== undefined` defaulting can be reproduced field-by-field, then applies a single `update session`
//! statement (the TS runs no transaction) and returns the re-read row (`mustGetSession`). `setRevert`
//! and `clearRevert` are thin wrappers that build the right input object and delegate to it. The whole
//! bind order mirrors the TS `db.prepare(...).run(...)`: the three `undefined` vs `null` distinctions
//! matter (undefined keeps the current value, `null` clears a nullable column, provided replaces), as
//! does the guarded `time_updated = max(time_updated, ?)` (a path-repair may carry an older clock and
//! must not regress real activity time) and the `expectedTitleSources` compare-and-set early return.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde_json::{Map, Value};

/// Port of `updateSession`: read current, default every column from the input with the exact TS
/// `?? current` / strict-`undefined` / `summary === null` semantics, run the one `update`, then return
/// the re-read projection.
///
/// # Arguments
///
/// * `conn` - An open read-write connection (see [`crate::open_readwrite`]).
/// * `input` - The `UpdateSessionInput` object as a JSON `Value`. Presence of a key models a JS field
///   that is not `undefined`; `Value::Null` models an explicit `null`.
/// * `now` - Epoch ms the TS would read from `Date.now()`, injected for determinism.
///
/// # Returns
///
/// The updated `SessionInfo` projection (`getSession`'s decode of the re-read row), or the unchanged
/// `current` when the `expectedTitleSources` compare-and-set short-circuits the write.
///
/// # Errors
///
/// Returns `Err` with `Session not found: <id>` when no such row, `Session not found after write: <id>`
/// if the id vanished, the `updateSession input must be an object` message for a non-object input, or
/// the `rusqlite` error string when the statement fails.
pub fn update_session(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> std::result::Result<Value, String> {
    let obj = input
        .as_object()
        .ok_or_else(|| "updateSession input must be an object".to_string())?;
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "updateSession input requires an `id` string".to_string())?
        .to_string();

    // `const current = await getSession(db, input.id); if (!current) throw ...`
    let current = crate::session_sessions::get_session(conn, &id)?;
    if current.is_null() {
        return Err(format!("Session not found: {id}"));
    }
    let cur = current
        .as_object()
        .ok_or_else(|| "getSession projection must be an object".to_string())?;

    // Title compare-and-set early return: only when a new title is offered AND the stored title source
    // is not in the allowed set do we skip the whole write and hand back the untouched `current`.
    if obj.contains_key("title") {
        if let Some(expected) = obj.get("expectedTitleSources").and_then(Value::as_array) {
            if !expected.is_empty() {
                let stored_source =
                    cur_str(cur, "titleSource").unwrap_or_else(|| "first_input".into());
                let allowed = expected
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|s| s == stored_source);
                if !allowed {
                    return Ok(current);
                }
            }
        }
    }

    let cur_title = cur_str(cur, "title").unwrap_or_default();

    // directory / title / title_source use nullish coalescing (`?? current`): an explicit `null` in
    // the input also falls back to the current value, so read them as `as_str` (null → None).
    let directory = obj
        .get("directory")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| cur_str(cur, "directory").unwrap_or_default());
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| cur_title.clone());
    let title_source = obj
        .get("titleSource")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| cur_str(cur, "titleSource"))
        .unwrap_or_else(|| "first_input".to_string());

    // path / title_message_id / share_url use strict `=== undefined`: a provided `null` clears the
    // column rather than keeping the current value.
    let path = if obj.contains_key("path") {
        json_str(obj.get("path"))
    } else {
        cur_str(cur, "path")
    };
    let title_message_id = if obj.contains_key("titleMessageID") {
        json_str(obj.get("titleMessageID"))
    } else {
        cur_str(cur, "titleMessageID")
    };
    let share_url = if obj.contains_key("shareURL") {
        json_str(obj.get("shareURL"))
    } else {
        cur_str(cur, "shareURL")
    };

    // The summary block has three states: key absent → keep the current summary (re-encoding the
    // stored diffs so `summary_diffs` round-trips); explicit `null` → clear all four columns; provided
    // object → use its fields (`additions`/`deletions`/`files` `?? null`, `diffs` via `encodeJson`).
    let (sum_add, sum_del, sum_files, sum_diffs) = match obj.get("summary") {
        None => (
            cur_i64(cur, "summaryAdditions"),
            cur_i64(cur, "summaryDeletions"),
            cur_i64(cur, "summaryFiles"),
            encode_json(cur_json(cur, "summaryDiffs")),
        ),
        Some(Value::Null) => (None, None, None, None),
        Some(provided) => (
            provided.get("additions").and_then(Value::as_i64),
            provided.get("deletions").and_then(Value::as_i64),
            provided.get("files").and_then(Value::as_i64),
            encode_json(provided.get("diffs")),
        ),
    };

    // revert / permission use strict `=== undefined`; otherwise `encodeJson` (undefined/null → SQL NULL,
    // any value → its JSON text). Keeping the current value re-encodes the parsed JSON column.
    let revert = if obj.contains_key("revert") {
        encode_json(obj.get("revert"))
    } else {
        encode_json(cur_json(cur, "revert"))
    };
    let permission = if obj.contains_key("permission") {
        encode_json(obj.get("permission"))
    } else {
        encode_json(cur_json(cur, "permission"))
    };

    // time_title_updated: stamped to `now` when the title actually changed, or a title source/message
    // id was provided; otherwise the current value is kept. `titleChanged` uses `!== undefined` (so an
    // explicit `null` title counts as provided) and `!== current.title`.
    let title_provided = obj.contains_key("title");
    let title_changed = title_provided
        && match obj.get("title") {
            Some(Value::String(s)) => s.as_str() != cur_title,
            _ => true,
        };
    let touch_title =
        title_changed || obj.contains_key("titleSource") || obj.contains_key("titleMessageID");
    let time_title_updated = if touch_title {
        Some(now)
    } else {
        cur_time_i64(cur, "titleUpdated")
    };
    let time_compacting = if obj.contains_key("timeCompacting") {
        obj.get("timeCompacting").and_then(Value::as_i64)
    } else {
        cur_time_i64(cur, "compacting")
    };
    let time_archived = if obj.contains_key("timeArchived") {
        obj.get("timeArchived").and_then(Value::as_i64)
    } else {
        cur_time_i64(cur, "archived")
    };
    // `input.timeUpdated ?? now` (nullish): an explicit null also uses `now`.
    let time_updated_value = obj
        .get("timeUpdated")
        .and_then(Value::as_i64)
        .unwrap_or(now);

    conn.execute(
        "update session set
            directory = ?1,
            path = ?2,
            title = ?3,
            title_source = ?4,
            title_message_id = ?5,
            share_url = ?6,
            summary_additions = ?7,
            summary_deletions = ?8,
            summary_files = ?9,
            summary_diffs = ?10,
            revert = ?11,
            permission = ?12,
            time_title_updated = ?13,
            time_compacting = ?14,
            time_archived = ?15,
            time_updated = max(time_updated, ?16)
          where id = ?17",
        params![
            directory,
            path,
            title,
            title_source,
            title_message_id,
            share_url,
            sum_add,
            sum_del,
            sum_files,
            sum_diffs,
            revert,
            permission,
            time_title_updated,
            time_compacting,
            time_archived,
            time_updated_value,
            id,
        ],
    )
    .map_err(|e| e.to_string())?;

    must_get_session(conn, &id)
}

/// Port of `setRevert`: build the `{id, revert, summary?}` update input from the
/// `{sessionID, revert, summary?}` shape and delegate to [`update_session`]. `summary` is reduced to
/// `{additions, deletions, files, diffs}` only when truthy (a JS truthiness check: `null`/`undefined`
/// omit it, so the stored summary is kept).
pub fn set_revert(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> std::result::Result<Value, String> {
    let obj = input
        .as_object()
        .ok_or_else(|| "setRevert input must be an object".to_string())?;
    let session_id = obj
        .get("sessionID")
        .and_then(Value::as_str)
        .ok_or_else(|| "setRevert input requires a `sessionID` string".to_string())?;

    let mut update = Map::new();
    update.insert("id".to_string(), Value::String(session_id.to_string()));
    if let Some(revert) = obj.get("revert") {
        update.insert("revert".to_string(), revert.clone());
    }
    if let Some(summary) = obj.get("summary").filter(|s| !s.is_null()) {
        let mut kept = Map::new();
        for key in ["additions", "deletions", "files", "diffs"] {
            if let Some(v) = summary.get(key) {
                kept.insert(key.to_string(), v.clone());
            }
        }
        update.insert("summary".to_string(), Value::Object(kept));
    }

    update_session(conn, &Value::Object(update), now)
}

/// Port of `clearRevert`: delegate to [`update_session`] with `{id, revert: null, summary: null}`.
pub fn clear_revert(
    conn: &Connection,
    session_id: &str,
    now: i64,
) -> std::result::Result<Value, String> {
    let mut update = Map::new();
    update.insert("id".to_string(), Value::String(session_id.to_string()));
    update.insert("revert".to_string(), Value::Null);
    update.insert("summary".to_string(), Value::Null);
    update_session(conn, &Value::Object(update), now)
}

/// `mustGetSession`: re-read the row after a write; error if it vanished.
fn must_get_session(conn: &Connection, id: &str) -> std::result::Result<Value, String> {
    let session = crate::session_sessions::get_session(conn, id)?;
    if session.is_null() {
        return Err(format!("Session not found after write: {id}"));
    }
    Ok(session)
}

/// Read a `current` string field, treating an absent (null-projected) key as `None`.
fn cur_str(cur: &Map<String, Value>, key: &str) -> Option<String> {
    cur.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Read a `current` integer field (keeps `0`, mirroring the projection's `?? undefined`).
fn cur_i64(cur: &Map<String, Value>, key: &str) -> Option<i64> {
    cur.get(key).and_then(Value::as_i64)
}

/// Read a `current` JSON-column value that the projection kept (present and non-null); `None` means
/// the column was null/absent so `encodeJson` yields SQL NULL.
fn cur_json<'a>(cur: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    cur.get(key).filter(|v| !v.is_null())
}

/// Read a `current.time.<key>` integer (the nested time object).
fn cur_time_i64(cur: &Map<String, Value>, key: &str) -> Option<i64> {
    cur.get("time")
        .and_then(Value::as_object)
        .and_then(|t| t.get(key))
        .and_then(Value::as_i64)
}

/// An input value used as a nullable string column: `null` (or a non-string) → SQL NULL, otherwise
/// the string. Mirrors the strict `=== undefined ? current : value` branches after presence is checked.
fn json_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

/// Port of `encodeJson`: `undefined`/`null` → `None` (SQL NULL); any other value → its compact JSON
/// text. `serde_json` is built with `preserve_order`, so re-encoding a parsed column reproduces the
/// stored text exactly, matching `JSON.stringify(JSON.parse(x))` in the TS keep-current path.
fn encode_json(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(x) => serde_json::to_string(x).ok(),
    }
}

/// N-API: `updateSession` write boundary. Parses `input_json` (an `UpdateSessionInput`), applies the
/// guarded partial update, and returns the re-read `SessionInfo` JSON. `now` is a JS number (epoch ms)
/// injected by the caller for deterministic, testable writes.
#[napi]
pub fn update_session_json(db_path: String, input_json: String, now: f64) -> Result<String, Error> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let session = update_session(&conn, &input, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&session).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `setRevert` write boundary; returns the re-read `SessionInfo` JSON of the affected session.
#[napi]
pub fn set_revert_json(db_path: String, input_json: String, now: f64) -> Result<String, Error> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let session = set_revert(&conn, &input, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&session).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `clearRevert` write boundary; returns the re-read `SessionInfo` JSON with revert + summary
/// cleared.
#[napi]
pub fn clear_revert_json(db_path: String, session_id: String, now: f64) -> Result<String, Error> {
    let conn = crate::open_readwrite(&db_path)?;
    let session = clear_revert(&conn, &session_id, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&session).map_err(|e| Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("invariant: enable foreign keys");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 0)
            .expect("invariant: apply session schema");
        seed(
            &conn,
            "s1",
            "dir0",
            "title0",
            "first_input",
            100,
            None,
            None,
        );
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn seed(
        conn: &Connection,
        id: &str,
        directory: &str,
        title: &str,
        title_source: &str,
        time_updated: i64,
        revert: Option<&str>,
        permission: Option<&str>,
    ) {
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, title_source, \
             time_created, time_updated, revert, permission) \
             values (?1,'p','slug',?2,?3,'v',?4,1,?5,?6,?7)",
            params![
                id,
                directory,
                title,
                title_source,
                time_updated,
                revert,
                permission
            ],
        )
        .expect("invariant: seed session");
    }

    /// Read one raw column back as `Option<i64>` / `Option<String>` via rusqlite.
    fn col_i64(conn: &Connection, id: &str, column: &str) -> Option<i64> {
        let sql = format!("select {column} from session where id = ?1");
        conn.query_row(&sql, [id], |r| r.get::<_, Option<i64>>(0))
            .unwrap_or(None)
    }

    fn col_str(conn: &Connection, id: &str, column: &str) -> Option<String> {
        let sql = format!("select {column} from session where id = ?1");
        conn.query_row(&sql, [id], |r| r.get::<_, Option<String>>(0))
            .unwrap_or(None)
    }

    fn run(conn: &Connection, input: Value, now: i64) -> Value {
        update_session(conn, &input, now).expect("update ok")
    }

    #[test]
    fn partial_update_keeps_current_for_undefined_fields() {
        let conn = db();
        let out = run(&conn, json!({"id": "s1", "timeUpdated": 5_000}), 5_000);
        // Only time_updated moved; everything else retained from `current`.
        assert_eq!(col_str(&conn, "s1", "directory").as_deref(), Some("dir0"));
        assert_eq!(col_str(&conn, "s1", "title").as_deref(), Some("title0"));
        assert_eq!(
            col_str(&conn, "s1", "title_source").as_deref(),
            Some("first_input")
        );
        assert_eq!(out["directory"], json!("dir0"));
        assert_eq!(out["title"], json!("title0"));
    }

    #[test]
    fn explicit_field_change_is_applied() {
        let conn = db();
        run(
            &conn,
            json!({"id": "s1", "directory": "dirNew", "title": "titleNew", "shareURL": "http://x"}),
            5_000,
        );
        assert_eq!(col_str(&conn, "s1", "directory").as_deref(), Some("dirNew"));
        assert_eq!(col_str(&conn, "s1", "title").as_deref(), Some("titleNew"));
        assert_eq!(
            col_str(&conn, "s1", "share_url").as_deref(),
            Some("http://x")
        );
        // title changed → time_title_updated stamped to now.
        assert_eq!(col_i64(&conn, "s1", "time_title_updated"), Some(5_000));
    }

    #[test]
    fn explicit_null_clears_nullable_share_and_path() {
        let conn = db();
        run(&conn, json!({"id": "s1", "shareURL": "http://keep"}), 2_000);
        assert_eq!(
            col_str(&conn, "s1", "share_url").as_deref(),
            Some("http://keep")
        );
        // shareURL present as null → strict undefined check clears it.
        run(
            &conn,
            json!({"id": "s1", "shareURL": null, "path": null}),
            3_000,
        );
        assert_eq!(col_str(&conn, "s1", "share_url"), None);
        assert_eq!(col_str(&conn, "s1", "path"), None);
    }

    #[test]
    fn summary_null_clears_all_summary_columns() {
        let conn = db();
        run(
            &conn,
            json!({"id": "s1", "summary": {"additions": 10, "deletions": 5, "files": 2, "diffs": [{"a": 1}]}}),
            2_000,
        );
        assert_eq!(col_i64(&conn, "s1", "summary_additions"), Some(10));
        assert!(col_str(&conn, "s1", "summary_diffs").is_some());
        run(&conn, json!({"id": "s1", "summary": null}), 3_000);
        assert_eq!(col_i64(&conn, "s1", "summary_additions"), None);
        assert_eq!(col_i64(&conn, "s1", "summary_deletions"), None);
        assert_eq!(col_i64(&conn, "s1", "summary_files"), None);
        assert_eq!(col_str(&conn, "s1", "summary_diffs"), None);
    }

    #[test]
    fn summary_absent_keeps_current_and_reencodes_diffs() {
        let conn = db();
        run(
            &conn,
            json!({"id": "s1", "summary": {"additions": 10, "deletions": 5, "files": 2, "diffs": [{"a": 1}]}}),
            2_000,
        );
        let before = col_str(&conn, "s1", "summary_diffs");
        // summary undefined → keep current summary; diffs re-encode to the same stored text.
        run(&conn, json!({"id": "s1", "title": "t2"}), 3_000);
        assert_eq!(col_i64(&conn, "s1", "summary_additions"), Some(10));
        assert_eq!(col_str(&conn, "s1", "summary_diffs"), before);
    }

    #[test]
    fn expected_title_sources_no_op_returns_current() {
        let conn = db();
        // Stored source is `first_input`; CAS allows only `generated` → skip the write entirely.
        let out = run(
            &conn,
            json!({"id": "s1", "title": "ignored", "expectedTitleSources": ["generated"]}),
            9_000,
        );
        assert_eq!(
            out["title"],
            json!("title0"),
            "returns current projection unchanged"
        );
        assert_eq!(col_str(&conn, "s1", "title").as_deref(), Some("title0"));
        assert_eq!(
            col_i64(&conn, "s1", "time_updated"),
            Some(100),
            "no write, clock untouched"
        );
    }

    #[test]
    fn expected_title_sources_match_applies_write() {
        let conn = db();
        run(
            &conn,
            json!({"id": "s1", "title": "ok", "expectedTitleSources": ["first_input", "custom"]}),
            9_000,
        );
        assert_eq!(col_str(&conn, "s1", "title").as_deref(), Some("ok"));
    }

    #[test]
    fn time_updated_never_moves_backwards() {
        let conn = db();
        // s1 seeded with time_updated 100; a stale timeUpdated of 4 must not regress the max().
        run(&conn, json!({"id": "s1", "timeUpdated": 4}), 4);
        assert_eq!(col_i64(&conn, "s1", "time_updated"), Some(100));
        run(&conn, json!({"id": "s1", "timeUpdated": 7_000}), 7_000);
        assert_eq!(col_i64(&conn, "s1", "time_updated"), Some(7_000));
    }

    #[test]
    fn set_revert_delegates_to_update() {
        let conn = db();
        let out = set_revert(
            &conn,
            &json!({"sessionID": "s1", "revert": {"messageID": "m1"}, "summary": {"additions": 7}}),
            5_000,
        )
        .expect("set_revert ok");
        assert_eq!(
            col_str(&conn, "s1", "revert").as_deref(),
            Some("{\"messageID\":\"m1\"}")
        );
        assert_eq!(col_i64(&conn, "s1", "summary_additions"), Some(7));
        assert_eq!(out["revert"], json!({"messageID": "m1"}));
    }

    #[test]
    fn clear_revert_delegates_and_empties_revert_and_summary() {
        let conn = db();
        run(
            &conn,
            json!({"id": "s1", "revert": {"messageID": "m1"}, "summary": {"additions": 7}}),
            2_000,
        );
        clear_revert(&conn, "s1", 5_000).expect("clear_revert ok");
        assert_eq!(col_str(&conn, "s1", "revert"), None);
        assert_eq!(col_i64(&conn, "s1", "summary_additions"), None);
    }

    #[test]
    fn revert_undefined_round_trips_current_revert() {
        let conn = db();
        seed(
            &conn,
            "keep",
            "d",
            "t",
            "first_input",
            100,
            Some("{\"a\":1,\"b\":2}"),
            None,
        );
        // No revert field provided → encodeJson(current.revert) must reproduce the stored text.
        run(&conn, json!({"id": "keep", "timeUpdated": 9_000}), 9_000);
        assert_eq!(
            col_str(&conn, "keep", "revert").as_deref(),
            Some("{\"a\":1,\"b\":2}")
        );
    }

    #[test]
    fn not_found_throws() {
        let conn = db();
        let err = update_session(&conn, &json!({"id": "ghost", "title": "x"}), 1_000)
            .expect_err("must throw for missing session");
        assert!(
            err.contains("Session not found: ghost"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn returns_read_back_projection() {
        let conn = db();
        let out = run(&conn, json!({"id": "s1", "title": "newTitle"}), 6_000);
        assert_eq!(out["id"], json!("s1"));
        assert_eq!(out["title"], json!("newTitle"));
        assert_eq!(out["time"]["updated"], json!(6_000));
    }
}
