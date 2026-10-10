//! Message/part WRITE paths (ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts`).
//!
//! `saveMessage` / `savePart` are a single guard-ed upsert (`insert ... on conflict(id) do update`)
//! followed by an inline `touchSession` bump. The TS does NOT wrap either in a transaction — each is
//! one atomic upsert statement plus one `update session` — so neither do we: adding a `BEGIN
//! IMMEDIATE` where the source has none would change lock/rollback behavior.
//!
//! The two subtleties reproduced verbatim:
//! - `preserveLegacyMembers` folds a nested `SELECT ... json_set/json_extract` expression (bound to
//!   `MESSAGE_DATA_UPDATE` / `PART_DATA_UPDATE`) into the upsert's
//!   `data = case when <scope matches> then <expr> else excluded.data end` arm. On a same-scope
//!   re-save it copies the *existing* legacy keys (`model`/`providerID`/`modelID`/`variant` for
//!   message; `fromModel`/`toModel`/`model` for part) into the freshly-encoded `excluded.data` only
//!   where the existing row still carries them (`json_type(...) is not null`); a cross-scope id
//!   collision takes `excluded.data` untouched. The fold order (which key ends up outermost) is
//!   reproduced exactly so the generated SQL matches the TS character-for-character.
//! - the `sequence` arm keeps the *existing* `sequence` on a same-scope re-save (including a NULL,
//!   which must NOT be re-queued) and only takes the `excluded` queue-tail value on a scope change.
//!
//! `now` (epoch ms) and every `time_*` value are injected through the params/JSON — the addon never
//! reads the clock, keeping writes deterministic and parity-testable. The stored `data` is built by
//! parsing the passed JSON object (never a cached column) and re-serializing with `serde_json`'s
//! `preserve_order` so key insertion order matches `JSON.stringify`.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

/// Legacy keys the message upsert folds into the preserved-data CASE (order matters: it fixes which
/// key is the outermost `select`, exactly as `preserveLegacyMembers` reduces the array).
const MESSAGE_LEGACY_KEYS: [&str; 4] = ["model", "providerID", "modelID", "variant"];
/// Legacy keys the part upsert folds into its CASE.
const PART_LEGACY_KEYS: [&str; 3] = ["fromModel", "toModel", "model"];

/// Port of `preserveLegacyMembers`: fold a nested preserve-expression starting from
/// `excluded.data`. Each key wraps the accumulated SQL one level deeper, so the LAST key in `keys`
/// ends up outermost — reproduced by folding left-to-right with the same template as the JS.
fn preserve_legacy_members(table: &str, keys: &[&str]) -> String {
    keys.iter().fold("excluded.data".to_string(), |sql, key| {
        format!(
            "(select case when json_type({table}.data, '$.{key}') is not null
      then json_set(previous.data, '$.{key}', json_extract({table}.data, '$.{key}')) else previous.data end
      from (select {sql} as data) as previous)"
        )
    })
}

/// JS truthiness for a possibly-absent JSON value (`undefined`/`null` are falsy, the empty string is
/// falsy, an object/array is truthy). Used to gate the legacy `variant` key exactly as the TS ternary
/// `... ? { variant } : {}` does.
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// Clone the input object's fields in order, dropping `skip` (mirrors JS rest-destructuring, e.g.
/// `const { id, sessionID, ...data } = input`). Rebuilding rather than removing keeps insertion order
/// independent of the backing map's removal semantics.
fn rest(input: &Value, skip: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    if let Value::Object(map) = input {
        for (key, value) in map {
            if !skip.contains(&key.as_str()) {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    out
}

/// Build the frozen legacy `model` object the old protocol mapper reads for a `user` message:
/// `{ providerID, modelID, [variant] }` from `modelSelection`, or an empty object when
/// `modelSelection` is absent/null. Matches the TS ternary's key order and `undefined` dropping.
fn build_legacy_model(selection: Option<&Value>) -> Value {
    let mut model = Map::new();
    if let Some(sel) = selection.filter(|v| v.is_object()) {
        if let Some(provider) = sel.get("providerId") {
            model.insert("providerID".to_string(), provider.clone());
        }
        if let Some(id) = sel.get("modelId") {
            model.insert("modelID".to_string(), id.clone());
        }
        let reasoning = sel.get("options").and_then(|o| o.get("reasoningLevel"));
        if is_truthy(reasoning) {
            if let Some(rl) = reasoning {
                model.insert("variant".to_string(), rl.clone());
            }
        }
    }
    Value::Object(model)
}

/// Build the frozen legacy `toModel` object for a timeline `model_change` part:
/// `{ providerID, modelID, [variant], label }`, or `{}` when `toModel` is falsy.
fn build_legacy_to_model(to_model: Option<&Value>) -> Value {
    let mut model = Map::new();
    if let Some(tm) = to_model.filter(|v| v.is_object()) {
        if let Some(provider) = tm.get("providerId") {
            model.insert("providerID".to_string(), provider.clone());
        }
        if let Some(id) = tm.get("modelId") {
            model.insert("modelID".to_string(), id.clone());
        }
        let reasoning = tm.get("options").and_then(|o| o.get("reasoningLevel"));
        if is_truthy(reasoning) {
            if let Some(rl) = reasoning {
                model.insert("variant".to_string(), rl.clone());
            }
        }
        // `label: toModel.label` — an absent label is `undefined` and is dropped by `JSON.stringify`,
        // so it is only written when present (null included, matching the type's required `label`).
        if let Some(label) = tm.get("label") {
            model.insert("label".to_string(), label.clone());
        }
    }
    Value::Object(model)
}

/// Port of `partCreatedAt(part, fallback)`: derive the row's `time_created` from the part shape,
/// falling back to `fallback` (the injected `now`). `??` maps to "use fallback when null/absent";
/// `0` is a valid stored value and is NOT replaced by the fallback.
fn part_created_at(input: &Value, fallback: i64) -> i64 {
    let ty = input.get("type").and_then(Value::as_str).unwrap_or("");
    let time_start = || {
        input
            .get("time")
            .and_then(|t| t.get("start"))
            .and_then(Value::as_i64)
    };
    match ty {
        "text" | "reasoning" | "compaction" | "timeline" => time_start().unwrap_or(fallback),
        "tool" => {
            let status = input
                .get("state")
                .and_then(|s| s.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if matches!(status, "running" | "completed" | "error") {
                input
                    .get("state")
                    .and_then(|s| s.get("time"))
                    .and_then(|t| t.get("start"))
                    .and_then(Value::as_i64)
                    .unwrap_or(fallback)
            } else {
                fallback
            }
        }
        "retry" => input
            .get("time")
            .and_then(|t| t.get("created"))
            .and_then(Value::as_i64)
            .unwrap_or(fallback),
        _ => fallback,
    }
}

/// Port of `copyLegacyMembers`: when a `copyFrom` `{ id, sessionID }` is given, read the source row's
/// `data` and copy any legacy keys it still carries onto the freshly-built `stored` object. Throws
/// `Storage copy source missing: <table>/<id>` when the source row is absent (mirrors the TS `throw`).
fn copy_legacy_members(
    conn: &Connection,
    table: &str,
    stored: &Value,
    source: Option<&Value>,
    keys: &[&str],
) -> Result<Value, String> {
    let mut result = match stored {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let Some(source) = source else {
        return Ok(Value::Object(result));
    };
    let source_id = field_str(source, "id")?;
    let source_session = field_str(source, "sessionID")?;
    let sql = format!("SELECT data FROM {table} WHERE id=? AND session_id=?");
    let row: Option<String> = conn
        .query_row(&sql, params![source_id, source_session], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let raw = row.ok_or_else(|| format!("Storage copy source missing: {table}/{source_id}"))?;
    let original: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    // `for (const key of keys) if (Object.hasOwn(original, key)) result[key] = original[key]`:
    // `insert` on an existing key keeps its position (JS assignment), on a new key appends it.
    for key in keys {
        if let Some(value) = original.get(*key) {
            result.insert((*key).to_string(), value.clone());
        }
    }
    Ok(Value::Object(result))
}

/// Port of `saveMessage` against an already-open read-write connection.
///
/// Reproduces the TS exactly: drop `id`/`sessionID`, add the frozen legacy `model` object for a `user`
/// role, derive `time_updated` (assistant → `time.completed ?? now`, else `time.created`), run the
/// guarded upsert (preserving legacy keys + sequence on a same-scope re-save), then `touchSession`.
///
/// # Arguments
///
/// * `conn` - open read-write connection (`open_readwrite` sets FK enforcement).
/// * `input` - `MessageInfo` JSON object (`{ id, sessionID, role, time, modelSelection?, ... }`).
/// * `copy_from` - optional `{ id, sessionID }` fork/copy source row for legacy-member copy.
/// * `now` - injected epoch ms, used only as the assistant `time.completed ?? now` fallback.
///
/// # Errors
///
/// Returns `Err(String)` for a missing/mis-typed field, a missing `copyFrom` source row, or a failed
/// statement.
pub fn save_message(
    conn: &Connection,
    input: &Value,
    copy_from: Option<&Value>,
    now: i64,
) -> Result<(), String> {
    let id = field_str(input, "id")?;
    let session_id = field_str(input, "sessionID")?;
    let role = field_str(input, "role")?;
    let time = input
        .get("time")
        .ok_or_else(|| "message.time is required".to_string())?;
    let time_created = time
        .get("created")
        .and_then(Value::as_i64)
        .ok_or_else(|| "message.time.created must be an integer".to_string())?;
    let time_updated = if role == "assistant" {
        time.get("completed").and_then(Value::as_i64).unwrap_or(now)
    } else {
        time_created
    };

    let mut data = rest(input, &["id", "sessionID"]);
    if role == "user" {
        data.insert(
            "model".to_string(),
            build_legacy_model(input.get("modelSelection")),
        );
    }
    let stored = Value::Object(data);
    let final_data =
        copy_legacy_members(conn, "message", &stored, copy_from, &MESSAGE_LEGACY_KEYS)?;
    let encoded = final_data.to_string();

    let expr = preserve_legacy_members("message", &MESSAGE_LEGACY_KEYS);
    let sql = format!(
        "insert into message (id, session_id, time_created, time_updated, data, sequence)
         values (?1, ?2, ?3, ?4, ?5,
           ( select coalesce(max(sequence), -1) + 1 from message where session_id = ?6 ))
         on conflict(id) do update set
           session_id = excluded.session_id,
           time_updated = excluded.time_updated,
           data = case when message.session_id = excluded.session_id then {expr} else excluded.data end,
           sequence = case
             when message.session_id = excluded.session_id then message.sequence
             else excluded.sequence
           end"
    );
    conn.execute(
        &sql,
        params![
            id,
            session_id,
            time_created,
            time_updated,
            encoded,
            session_id
        ],
    )
    .map_err(|e| e.to_string())?;

    // `touchSession(db, sessionID, timeUpdated)` — inline bump, never backwards.
    conn.execute(
        "update session set time_updated = max(time_updated, ?1) where id = ?2",
        params![time_updated, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `savePart` against an already-open read-write connection.
///
/// Reproduces the TS exactly: drop `id`/`sessionID`/`messageID`; for a timeline `model_change` rewrite
/// the frozen legacy `toModel` and move `fromModel`/`toModel` into `fromModelSelection`/
/// `toModelSelection`; for a `subtask` move `model` into `modelSelection`; then run the guarded upsert
/// (preserving legacy keys + sequence on a same-`(message_id, session_id)` re-save) and `touchSession`.
///
/// # Arguments
///
/// * `conn` - open read-write connection.
/// * `input` - `MessagePart` JSON object (`{ id, sessionID, messageID, type, timelineType?, ... }`).
/// * `copy_from` - optional `{ id, sessionID }` copy source row.
/// * `now` - injected epoch ms; `time_updated` and the `partCreatedAt` fallback.
///
/// # Errors
///
/// Returns `Err(String)` for a missing/mis-typed field, a missing `copyFrom` source row, or a failed
/// statement.
pub fn save_part(
    conn: &Connection,
    input: &Value,
    copy_from: Option<&Value>,
    now: i64,
) -> Result<(), String> {
    let id = field_str(input, "id")?;
    let session_id = field_str(input, "sessionID")?;
    let message_id = field_str(input, "messageID")?;
    let ty = input.get("type").and_then(Value::as_str).unwrap_or("");

    let stored = if ty == "timeline"
        && input.get("timelineType").and_then(Value::as_str) == Some("model_change")
    {
        let from_model = input.get("fromModel");
        let to_model = input.get("toModel");
        let mut part = rest(
            input,
            &["id", "sessionID", "messageID", "fromModel", "toModel"],
        );
        part.insert("toModel".to_string(), build_legacy_to_model(to_model));
        if let Some(fm) = from_model {
            part.insert("fromModelSelection".to_string(), fm.clone());
        }
        if let Some(tm) = to_model {
            part.insert("toModelSelection".to_string(), tm.clone());
        }
        Value::Object(part)
    } else if ty == "subtask" {
        let model = input.get("model");
        let mut part = rest(input, &["id", "sessionID", "messageID", "model"]);
        if let Some(m) = model {
            part.insert("modelSelection".to_string(), m.clone());
        }
        Value::Object(part)
    } else {
        Value::Object(rest(input, &["id", "sessionID", "messageID"]))
    };

    let final_data = copy_legacy_members(conn, "part", &stored, copy_from, &PART_LEGACY_KEYS)?;
    let encoded = final_data.to_string();
    let time_created = part_created_at(input, now);

    let expr = preserve_legacy_members("part", &PART_LEGACY_KEYS);
    let sql = format!(
        "insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
         values (?1, ?2, ?3, ?4, ?5, ?6,
           ( select coalesce(max(sequence), -1) + 1 from part where message_id = ?7 ))
         on conflict(id) do update set
           message_id = excluded.message_id,
           session_id = excluded.session_id,
           time_updated = excluded.time_updated,
           data = case when part.message_id = excluded.message_id and part.session_id = excluded.session_id
             then {expr} else excluded.data end,
           sequence = case
             when part.message_id = excluded.message_id and part.session_id = excluded.session_id
               then part.sequence
             else excluded.sequence
           end"
    );
    conn.execute(
        &sql,
        params![
            id,
            message_id,
            session_id,
            time_created,
            now,
            encoded,
            message_id
        ],
    )
    .map_err(|e| e.to_string())?;

    // `touchSession(db, sessionID, now)`.
    conn.execute(
        "update session set time_updated = max(time_updated, ?1) where id = ?2",
        params![now, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `removeMessage`: scoped delete on `id` AND `session_id` (a wrong-scope id is a no-op). No
/// `touchSession`, matching the TS.
pub fn remove_message(conn: &Connection, session_id: &str, message_id: &str) -> Result<(), String> {
    conn.execute(
        "delete from message where id = ?1 and session_id = ?2",
        params![message_id, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `removePart`: scoped delete on `id` AND `message_id` AND `session_id`. No `touchSession`,
/// matching the TS.
pub fn remove_part(
    conn: &Connection,
    session_id: &str,
    message_id: &str,
    part_id: &str,
) -> Result<(), String> {
    conn.execute(
        "delete from part where id = ?1 and message_id = ?2 and session_id = ?3",
        params![part_id, message_id, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read a required string field, mirroring TS's direct property access into a NOT NULL column.
fn field_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("message/part.{key} must be a string"))
}

/// Parse a nullable `copyFrom` JSON string (`null`/absent → `None`).
fn parse_copy_from(raw: Option<&str>) -> Result<Option<Value>, String> {
    match raw {
        None => Ok(None),
        Some(text) => serde_json::from_str::<Value>(text)
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

/// N-API: `saveMessage` write boundary. Opens a read-write DB, runs the guarded upsert + inline
/// `touchSession`, and returns the JSON literal `"null"` (the TS returns `void`). `message_json` is the
/// serialized `MessageInfo`; `copy_from_json` is an optional `{ id, sessionID }` copy source (null/
/// undefined for a normal save); `now` is a JS number (epoch ms) injected for the assistant fallback.
#[napi]
pub fn save_message_json(
    db_path: String,
    message_json: String,
    copy_from_json: Option<String>,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&message_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let copy_from = parse_copy_from(copy_from_json.as_deref()).map_err(Error::from_reason)?;
    let conn = crate::open_readwrite(&db_path)?;
    save_message(&conn, &input, copy_from.as_ref(), now as i64).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `savePart` write boundary. `part_json` is the serialized `MessagePart`; `copy_from_json` is
/// an optional `{ id, sessionID }`; `now` is the injected epoch ms for `time_updated` and the
/// `partCreatedAt` fallback.
#[napi]
pub fn save_part_json(
    db_path: String,
    part_json: String,
    copy_from_json: Option<String>,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&part_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let copy_from = parse_copy_from(copy_from_json.as_deref()).map_err(Error::from_reason)?;
    let conn = crate::open_readwrite(&db_path)?;
    save_part(&conn, &input, copy_from.as_ref(), now as i64).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `removeMessage` write boundary (scoped delete; no `touchSession`).
#[napi]
pub fn remove_message_json(
    db_path: String,
    session_id: String,
    message_id: String,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    remove_message(&conn, &session_id, &message_id).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `removePart` write boundary (scoped delete; no `touchSession`).
#[napi]
pub fn remove_part_json(
    db_path: String,
    session_id: String,
    message_id: String,
    part_id: String,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    remove_part(&conn, &session_id, &message_id, &part_id).map_err(Error::from_reason)?;
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
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 1_000)
            .expect("invariant: apply session schema");
        for session in ["s1", "s2"] {
            conn.execute(
                "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
                 values (?1,'p','slug','/d','t','v',100,100)",
                [session],
            )
            .expect("invariant: seed session");
        }
        conn
    }

    fn message_row(conn: &Connection, id: &str) -> (String, String, i64) {
        conn.query_row(
            "select session_id, data, sequence from message where id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)?)),
        )
        .expect("read message")
    }

    fn part_data(conn: &Connection, id: &str) -> String {
        conn.query_row("select data from part where id = ?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .expect("read part")
    }

    #[test]
    fn user_message_builds_legacy_model_object() {
        let conn = db();
        save_message(
            &conn,
            &json!({
                "id": "m1", "sessionID": "s1", "role": "user",
                "time": { "created": 200 },
                "agent": "main",
                "modelSelection": { "providerId": "p", "modelId": "q", "options": { "reasoningLevel": "high" } }
            }),
            None,
            999,
        )
        .expect("save ok");
        let (session_id, data, sequence) = message_row(&conn, "m1");
        assert_eq!(session_id, "s1");
        assert_eq!(sequence, 0, "first message in scope gets sequence 0");
        let parsed: Value = serde_json::from_str(&data).expect("valid json");
        // Legacy `model` is appended after the rest fields, with the frozen uppercase keys.
        assert_eq!(
            parsed.get("model"),
            Some(&json!({ "providerID": "p", "modelID": "q", "variant": "high" })),
            "model object carries providerID/modelID/variant"
        );
    }

    #[test]
    fn assistant_message_strips_legacy_model_and_uses_completed_time() {
        let conn = db();
        save_message(
            &conn,
            &json!({
                "id": "a1", "sessionID": "s1", "role": "assistant",
                "time": { "created": 100, "completed": 500 },
                "cost": 0
            }),
            None,
            999,
        )
        .expect("save ok");
        let (_, data, _) = message_row(&conn, "a1");
        let parsed: Value = serde_json::from_str(&data).expect("valid json");
        assert!(
            parsed.get("model").is_none(),
            "assistant has no legacy model"
        );
        // time_updated = completed (500) bumped the seeded session clock (100 -> 500).
        let updated: i64 = conn
            .query_row("select time_updated from session where id='s1'", [], |r| {
                r.get(0)
            })
            .expect("read");
        assert_eq!(updated, 500);
    }

    #[test]
    fn same_scope_re_save_preserves_existing_legacy_key_via_case() {
        let conn = db();
        // First save a user message that carries a legacy `model` snapshot.
        save_message(
            &conn,
            &json!({
                "id": "r1", "sessionID": "s1", "role": "user",
                "time": { "created": 200 }, "agent": "main",
                "modelSelection": { "providerId": "p", "modelId": "q" }
            }),
            None,
            999,
        )
        .expect("first save");
        // Externally stamp an extra preserved key into the stored snapshot (simulates a legacy row).
        conn.execute(
            "update message set data = json_set(data, '$.providerID', 'KEEP') where id='r1'",
            [],
        )
        .expect("stamp legacy providerID");

        // Re-save SAME scope with a *new* encoded snapshot that lacks `providerID` at top level. The
        // CASE must copy the existing `providerID` (json_type not null) into the new data.
        save_message(
            &conn,
            &json!({
                "id": "r1", "sessionID": "s1", "role": "assistant",
                "time": { "created": 300, "completed": 400 }
            }),
            None,
            999,
        )
        .expect("re-save same scope");
        let (_, data, _) = message_row(&conn, "r1");
        let parsed: Value = serde_json::from_str(&data).expect("valid json");
        assert_eq!(
            parsed.get("providerID"),
            Some(&json!("KEEP")),
            "preserved legacy providerID survived the same-scope re-save"
        );
    }

    #[test]
    fn cross_scope_re_save_takes_excluded_data() {
        let conn = db();
        save_message(
            &conn,
            &json!({
                "id": "x1", "sessionID": "s1", "role": "user",
                "time": { "created": 200 }, "modelSelection": { "providerId": "p", "modelId": "q" }
            }),
            None,
            999,
        )
        .expect("first save in s1");
        conn.execute(
            "update message set data = json_set(data, '$.providerID', 'KEEP') where id='x1'",
            [],
        )
        .expect("stamp legacy providerID");

        // Re-save the SAME id but under a DIFFERENT session: the CASE falls to `excluded.data`, so the
        // preserved `providerID` must NOT survive, and the new scope's sequence queue is taken.
        save_message(
            &conn,
            &json!({
                "id": "x1", "sessionID": "s2", "role": "assistant",
                "time": { "created": 300, "completed": 400 }
            }),
            None,
            999,
        )
        .expect("re-save cross scope");
        let (session_id, data, _) = message_row(&conn, "x1");
        assert_eq!(session_id, "s2", "row re-bound to the new session");
        let parsed: Value = serde_json::from_str(&data).expect("valid json");
        assert!(
            parsed.get("providerID").is_none(),
            "cross-scope re-save must not preserve the old legacy snapshot"
        );
    }

    #[test]
    fn copy_from_missing_source_row_throws() {
        let conn = db();
        let err = save_message(
            &conn,
            &json!({
                "id": "c1", "sessionID": "s1", "role": "assistant",
                "time": { "created": 300, "completed": 400 }
            }),
            Some(&json!({ "id": "ghost", "sessionID": "s1" })),
            999,
        )
        .expect_err("missing copy source must throw");
        assert_eq!(err, "Storage copy source missing: message/ghost");
    }

    #[test]
    fn copy_from_copies_present_legacy_keys() {
        let conn = db();
        // Source row carries a legacy `model` snapshot we expect to be copied onto the new message.
        save_message(
            &conn,
            &json!({
                "id": "src", "sessionID": "s1", "role": "user",
                "time": { "created": 200 }, "modelSelection": { "providerId": "p", "modelId": "q" }
            }),
            None,
            999,
        )
        .expect("seed source");
        conn.execute(
            "update message set data = json_set(data, '$.variant', 'srcvar') where id='src'",
            [],
        )
        .expect("add source variant");

        save_message(
            &conn,
            &json!({
                "id": "dst", "sessionID": "s1", "role": "assistant",
                "time": { "created": 300, "completed": 400 }
            }),
            Some(&json!({ "id": "src", "sessionID": "s1" })),
            999,
        )
        .expect("copy save");
        let (_, data, _) = message_row(&conn, "dst");
        let parsed: Value = serde_json::from_str(&data).expect("valid json");
        assert_eq!(
            parsed.get("variant"),
            Some(&json!("srcvar")),
            "legacy variant copied"
        );
    }

    #[test]
    fn timeline_model_change_part_rewrites_legacy_to_model() {
        let conn = db();
        save_message(
            &conn,
            &json!({ "id": "pm1", "sessionID": "s1", "role": "assistant", "time": { "created": 100, "completed": 100 } }),
            None,
            999,
        )
        .expect("seed message");
        save_part(
            &conn,
            &json!({
                "id": "tp1", "sessionID": "s1", "messageID": "pm1",
                "type": "timeline", "timelineType": "model_change",
                "fromModel": { "providerId": "a", "modelId": "b" },
                "toModel": { "providerId": "c", "modelId": "d", "options": { "reasoningLevel": "low" }, "label": "ToLabel" }
            }),
            None,
            5000,
        )
        .expect("save part");
        let parsed: Value = serde_json::from_str(&part_data(&conn, "tp1")).expect("valid json");
        // toModel is the frozen legacy snapshot (uppercase keys + variant + label).
        assert_eq!(
            parsed.get("toModel"),
            Some(
                &json!({ "providerID": "c", "modelID": "d", "variant": "low", "label": "ToLabel" })
            ),
            "legacy toModel rewritten"
        );
        assert!(
            parsed.get("toModelSelection").is_some(),
            "current toModelSelection kept"
        );
        assert!(
            parsed.get("fromModelSelection").is_some(),
            "fromModelSelection kept"
        );
        // time_created uses partCreatedAt → timeline time.start ?? now → now (5000) here.
        let created: i64 = conn
            .query_row("select time_created from part where id='tp1'", [], |r| {
                r.get(0)
            })
            .expect("read");
        assert_eq!(created, 5000);
    }

    #[test]
    fn subtask_part_maps_model_to_model_selection() {
        let conn = db();
        save_message(
            &conn,
            &json!({ "id": "sm1", "sessionID": "s1", "role": "assistant", "time": { "created": 100, "completed": 100 } }),
            None,
            999,
        )
        .expect("seed message");
        save_part(
            &conn,
            &json!({
                "id": "sub1", "sessionID": "s1", "messageID": "sm1",
                "type": "subtask", "name": "worker",
                "model": { "providerId": "p", "modelId": "q" }
            }),
            None,
            5000,
        )
        .expect("save part");
        let parsed: Value = serde_json::from_str(&part_data(&conn, "sub1")).expect("valid json");
        assert!(parsed.get("model").is_none(), "original model key dropped");
        assert_eq!(
            parsed.get("modelSelection"),
            Some(&json!({ "providerId": "p", "modelId": "q" })),
            "model moved into modelSelection"
        );
    }

    #[test]
    fn remove_message_is_scope_guarded() {
        let conn = db();
        save_message(
            &conn,
            &json!({ "id": "rm1", "sessionID": "s1", "role": "assistant", "time": { "created": 100, "completed": 100 } }),
            None,
            999,
        )
        .expect("save");
        // Wrong session: no-op.
        remove_message(&conn, "s2", "rm1").expect("remove scoped miss");
        let count: i64 = conn
            .query_row("select count(*) from message where id='rm1'", [], |r| {
                r.get(0)
            })
            .expect("count");
        assert_eq!(count, 1, "scoped miss must not delete");
        remove_message(&conn, "s1", "rm1").expect("remove scoped hit");
        let count: i64 = conn
            .query_row("select count(*) from message where id='rm1'", [], |r| {
                r.get(0)
            })
            .expect("count");
        assert_eq!(count, 0);
    }

    #[test]
    fn remove_part_is_scope_guarded() {
        let conn = db();
        save_message(
            &conn,
            &json!({ "id": "pmsg", "sessionID": "s1", "role": "assistant", "time": { "created": 100, "completed": 100 } }),
            None,
            999,
        )
        .expect("seed message");
        save_part(
            &conn,
            &json!({ "id": "ppart", "sessionID": "s1", "messageID": "pmsg", "type": "text", "text": "hi" }),
            None,
            5000,
        )
        .expect("save part");
        // Wrong message scope: no-op.
        remove_part(&conn, "s1", "other", "ppart").expect("remove scoped miss");
        let count: i64 = conn
            .query_row("select count(*) from part where id='ppart'", [], |r| {
                r.get(0)
            })
            .expect("count");
        assert_eq!(count, 1);
        remove_part(&conn, "s1", "pmsg", "ppart").expect("remove hit");
        let count: i64 = conn
            .query_row("select count(*) from part where id='ppart'", [], |r| {
                r.get(0)
            })
            .expect("count");
        assert_eq!(count, 0);
    }
}
