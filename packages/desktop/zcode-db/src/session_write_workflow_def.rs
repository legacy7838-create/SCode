//! `upsertScriptWorkflowDefinition` write path (ported from
//! `apps/zcode-cli/.../session-store/repositories/script-workflow-runs.ts`).
//!
//! The TS runs ONE `insert ... on conflict(id) do update set ...` upsert into `workflow_definition`
//! (no explicit transaction, so neither do we), then reads the row back and projects it through
//! `decodeDefinition`. The bind order and defaulting are reproduced exactly: `scope` falls back to
//! `'builtin'`/`'explicit'` by `source`, `trusted` is `1` only for literal `true`, `enabled` is `0`
//! only for literal `false`, `script_path` is `null` when the field is nullish, and `meta_json` is
//! `JSON.stringify(input.meta)`. `now` is injected by the caller (JS `Date.now()`, epoch ms) for both
//! `time_created` and `time_updated`, so the write is deterministic for parity testing.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

/// Port of `upsertScriptWorkflowDefinition`: apply the `workflow_definition` upsert, then read the
/// row back and return the `decodeDefinition` projection.
///
/// The conflict arm updates every payload column plus `time_updated` (never `time_created`), matching
/// the TS SQL verbatim so the update set cannot drift from the source build.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `input` - The `UpsertScriptWorkflowDefinitionInput` object: `{id, name, source, scope?,
///   trusted?, enabled?, scriptPath?, scriptHash, meta}`.
/// * `now` - Epoch ms for `time_created` (insert) and `time_updated` (insert + update).
///
/// # Returns
///
/// The read-back `ScriptWorkflowDefinitionRecord` projection.
///
/// # Errors
///
/// Returns `Err(String)` when a required field is missing/not a string, when the statement fails, or
/// when the row is absent after the write (mirrors the TS `Workflow definition not found after
/// write: <id>` throw).
pub fn upsert_script_workflow_definition(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> Result<Value, String> {
    let id = required_str(input, "id")?;
    let name = required_str(input, "name")?;
    let source = required_str(input, "source")?;
    let script_hash = required_str(input, "scriptHash")?;

    // scope ?? (source === 'builtin' ? 'builtin' : 'explicit'): only null/undefined fall back.
    let scope = match input.get("scope").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => {
            if source == "builtin" {
                "builtin".to_string()
            } else {
                "explicit".to_string()
            }
        }
    };

    // trusted === true ? 1 : 0 — any value other than literal `true` (incl. absent/non-bool) is 0.
    let trusted: i64 = if input.get("trusted").and_then(Value::as_bool) == Some(true) {
        1
    } else {
        0
    };
    // enabled === false ? 0 : 1 — only literal `false` is 0; absent or any other value is 1.
    let enabled: i64 = if input.get("enabled").and_then(Value::as_bool) == Some(false) {
        0
    } else {
        1
    };

    // scriptPath ?? null — nullish falls back to SQL NULL, otherwise the string.
    let script_path = input.get("scriptPath").and_then(Value::as_str);

    // meta_json = JSON.stringify(input.meta). `meta` is required; serde_json preserves key order
    // (the `preserve_order` feature), matching the JS object's insertion order for parity.
    let meta = input
        .get("meta")
        .ok_or_else(|| "definition.meta is required".to_string())?;
    let meta_json = serde_json::to_string(meta).map_err(|e| e.to_string())?;

    conn.execute(
        "insert into workflow_definition (
          id, name, source, scope, trusted, enabled, script_path, script_hash, meta_json,
          time_created, time_updated
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        on conflict(id) do update set
          name = excluded.name,
          source = excluded.source,
          scope = excluded.scope,
          trusted = excluded.trusted,
          enabled = excluded.enabled,
          script_path = excluded.script_path,
          script_hash = excluded.script_hash,
          meta_json = excluded.meta_json,
          time_updated = excluded.time_updated",
        params![
            id,
            name,
            source,
            scope,
            trusted,
            enabled,
            script_path,
            script_hash,
            meta_json,
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    read_definition(conn, id)
}

/// Read one `workflow_definition` row by id and project it via `decodeDefinition`.
///
/// Mirrors `mustGetDefinition`: the row is expected to exist after the write, so an absent row is
/// reported as the same `Workflow definition not found after write: <id>` error the TS throws.
fn read_definition(conn: &Connection, id: &str) -> Result<Value, String> {
    // Fetch the raw columns first (any type), then build the projection outside the closure so a
    // `meta_json` parse failure surfaces as a plain `String` error, matching this fn's signature.
    let raw = conn
        .query_row(
            "select id, name, source, scope, trusted, enabled, script_path, script_hash, meta_json, \
             time_created, time_updated from workflow_definition where id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>("id")?,
                    row.get::<_, String>("name")?,
                    row.get::<_, String>("source")?,
                    row.get::<_, String>("scope")?,
                    row.get::<_, i64>("trusted")?,
                    row.get::<_, i64>("enabled")?,
                    row.get::<_, Option<String>>("script_path")?,
                    row.get::<_, String>("script_hash")?,
                    row.get::<_, String>("meta_json")?,
                    row.get::<_, i64>("time_created")?,
                    row.get::<_, i64>("time_updated")?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let (id, name, source, scope, trusted, enabled, script_path, script_hash, meta_json, time_created, time_updated) =
        raw.ok_or_else(|| format!("Workflow definition not found after write: {id}"))?;

    // meta_json is NOT NULL and always valid JSON (written as JSON.stringify), like decodeDefinition's
    // JSON.parse; parse it back into the projection.
    let meta: Value = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;

    let mut obj = Map::new();
    obj.insert("enabled".to_string(), json_bool(enabled));
    obj.insert("id".to_string(), Value::String(id));
    obj.insert("meta".to_string(), meta);
    obj.insert("name".to_string(), Value::String(name));
    obj.insert("scope".to_string(), Value::String(scope));
    obj.insert("scriptHash".to_string(), Value::String(script_hash));
    // scriptPath: row.script_path ?? undefined — omit the key when the column is NULL, since
    // JSON.stringify drops undefined-valued keys.
    if let Some(path) = script_path {
        obj.insert("scriptPath".to_string(), Value::String(path));
    }
    obj.insert("source".to_string(), Value::String(source));
    obj.insert("timeCreated".to_string(), Value::from(time_created));
    obj.insert("timeUpdated".to_string(), Value::from(time_updated));
    obj.insert("trusted".to_string(), json_bool(trusted));
    Ok(Value::Object(obj))
}

/// Convert a stored `0`/`1` integer column into a JSON boolean (`enabled === 1` / `trusted === 1`).
fn json_bool(v: i64) -> Value {
    Value::Bool(v == 1)
}

/// Read a required top-level string field, erroring (rather than writing a silent `undefined` into a
/// NOT NULL column) when it is absent or not a string.
fn required_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("definition.{key} must be a string"))
}

/// N-API: `upsertScriptWorkflowDefinition` write boundary. Opens a read-write DB, applies the upsert,
/// and returns the read-back projection JSON. `definition_json` is the whole input object
/// (`{id, name, source, scope?, trusted?, enabled?, scriptPath?, scriptHash, meta}`); `now` is a JS
/// number (epoch ms) injected by the caller for deterministic, testable writes.
#[napi]
pub fn upsert_script_workflow_definition_json(
    db_path: String,
    definition_json: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&definition_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let value = upsert_script_workflow_definition(&conn, &input, now as i64)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// In-memory DB with just the `workflow_definition` table, using the exact DDL produced by the
    /// session migrations (base columns + the `scope` column added by migration 0008).
    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute_batch(
            "create table workflow_definition (
              id text primary key,
              name text not null,
              source text not null check(source in ('builtin', 'user')),
              trusted integer not null default 0 check(trusted in (0, 1)),
              enabled integer not null default 1 check(enabled in (0, 1)),
              script_path text,
              script_hash text not null,
              meta_json text not null,
              time_created integer not null,
              time_updated integer not null,
              scope text not null default 'explicit'
                check(scope in ('builtin', 'explicit', 'project', 'user'))
            );",
        )
        .expect("invariant: create table");
        conn
    }

    #[test]
    fn insert_returns_readback_projection() {
        let conn = db();
        let input = json!({
            "id": "wf-1",
            "name": "build",
            "source": "user",
            "scriptHash": "abc",
            "scriptPath": "/tmp/build.ts",
            "meta": { "phase": "ship", "n": 3 },
        });
        let out = upsert_script_workflow_definition(&conn, &input, 100).expect("insert ok");
        assert_eq!(out["id"], json!("wf-1"));
        assert_eq!(out["name"], json!("build"));
        assert_eq!(out["source"], json!("user"));
        // Absent scope for a non-builtin source defaults to 'explicit'.
        assert_eq!(out["scope"], json!("explicit"));
        // Absent trusted -> false, absent enabled -> true (default).
        assert_eq!(out["trusted"], json!(false));
        assert_eq!(out["enabled"], json!(true));
        assert_eq!(out["scriptHash"], json!("abc"));
        assert_eq!(out["scriptPath"], json!("/tmp/build.ts"));
        // meta round-trips through meta_json exactly.
        assert_eq!(out["meta"], json!({ "phase": "ship", "n": 3 }));
        assert_eq!(out["timeCreated"], json!(100));
        assert_eq!(out["timeUpdated"], json!(100));
        // Projection omits scriptPath only when NULL; here it is present.
        assert!(out.get("scriptPath").is_some());
    }

    #[test]
    fn update_branch_overwrites_payload_and_time_updated_keeps_created() {
        let conn = db();
        let first = json!({
            "id": "wf-1", "name": "v1", "source": "user",
            "scriptHash": "h1", "meta": { "a": 1 },
        });
        upsert_script_workflow_definition(&conn, &first, 100).expect("insert ok");

        let second = json!({
            "id": "wf-1", "name": "v2", "source": "builtin",
            "scope": "project", "trusted": true, "enabled": false,
            "scriptHash": "h2", "scriptPath": "/x.ts", "meta": { "b": 2 },
        });
        let out = upsert_script_workflow_definition(&conn, &second, 250).expect("update ok");

        // Updated fields reflect the second write.
        assert_eq!(out["name"], json!("v2"));
        assert_eq!(out["source"], json!("builtin"));
        assert_eq!(out["scope"], json!("project"));
        assert_eq!(out["trusted"], json!(true));
        assert_eq!(out["enabled"], json!(false));
        assert_eq!(out["scriptPath"], json!("/x.ts"));
        assert_eq!(out["meta"], json!({ "b": 2 }));
        // time_updated bumped, time_created preserved (conflict arm never touches it).
        assert_eq!(out["timeUpdated"], json!(250));
        assert_eq!(out["timeCreated"], json!(100));
        // Still a single row (upsert, not a second insert).
        let count: i64 = conn
            .query_row("select count(*) from workflow_definition", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
    }

    #[test]
    fn scope_defaults_builtin_vs_explicit() {
        let conn = db();
        let builtin = json!({
            "id": "b", "name": "n", "source": "builtin", "scriptHash": "h", "meta": {},
        });
        let out = upsert_script_workflow_definition(&conn, &builtin, 1).expect("ok");
        assert_eq!(out["scope"], json!("builtin"), "builtin source defaults to builtin scope");

        let user = json!({
            "id": "u", "name": "n", "source": "user", "scriptHash": "h", "meta": {},
        });
        let out = upsert_script_workflow_definition(&conn, &user, 1).expect("ok");
        assert_eq!(out["scope"], json!("explicit"), "non-builtin source defaults to explicit");

        // An explicit scope overrides the source-based default.
        let override_input = json!({
            "id": "o", "name": "n", "source": "builtin", "scope": "user",
            "scriptHash": "h", "meta": {},
        });
        let out = upsert_script_workflow_definition(&conn, &override_input, 1).expect("ok");
        assert_eq!(out["scope"], json!("user"), "provided scope wins");
    }

    #[test]
    fn trusted_and_enabled_coercion_and_null_script_path() {
        let conn = db();
        // Only literal true/false coerce to 1/0; other values fall to the default.
        let input = json!({
            "id": "t", "name": "n", "source": "user",
            "trusted": "yes", "enabled": 0,
            "scriptHash": "h", "meta": {},
        });
        let out = upsert_script_workflow_definition(&conn, &input, 1).expect("ok");
        // "yes" !== true -> trusted 0; 0 !== false -> enabled 1.
        assert_eq!(out["trusted"], json!(false));
        assert_eq!(out["enabled"], json!(true));
        // scriptPath absent -> NULL -> omitted from the projection (undefined dropped by stringify).
        assert!(out.get("scriptPath").is_none());

        // Explicit false enabled -> 0; explicit true trusted -> 1.
        let input = json!({
            "id": "t2", "name": "n", "source": "user",
            "trusted": true, "enabled": false, "scriptHash": "h", "meta": {},
        });
        let out = upsert_script_workflow_definition(&conn, &input, 1).expect("ok");
        assert_eq!(out["trusted"], json!(true));
        assert_eq!(out["enabled"], json!(false));
    }

    #[test]
    fn missing_required_field_errors() {
        let conn = db();
        let err = upsert_script_workflow_definition(
            &conn,
            &json!({ "name": "n", "source": "user", "scriptHash": "h", "meta": {} }),
            1,
        )
        .expect_err("missing id must fail");
        assert!(err.contains("id"), "unexpected error: {err}");
    }
}
