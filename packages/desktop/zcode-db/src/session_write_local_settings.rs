//! Local-settings WRITE operations, ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/local-settings.ts`.
//!
//! These write into the `local_setting` upsert table (no FK, single atomic statement — TS does not
//! wrap them in a transaction, so neither do we). The read-back for `saveProjectPermission` reuses
//! the existing [`crate::session_store::get_project_permission`] projection rather than
//! re-implementing the two-tier read, keeping a single source of truth for the `ruleset` decode.
//!
//! `now` is injected by the caller (JS `Date.now()`, epoch ms) — the addon never reads the clock,
//! matching the rest of the write path and keeping the operation deterministic for parity tests.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::session_store;

/// Port of the private `writeLocalSetting` helper: the `local_setting` upsert. `time_created` and
/// `time_updated` both use `time`; the `on conflict(scope, scope_id, namespace, key)` arm updates
/// only `value`, `schema_version` and `time_updated` (never `time_created`), exactly as the TS SQL.
///
/// The SQL is copied verbatim from `local-settings.ts` so the conflict target and update set cannot
/// drift from the source build.
///
/// # Errors
///
/// Returns `Err` when the statement fails (e.g. a `NOT NULL` violation on a column).
#[allow(clippy::too_many_arguments)]
pub fn write_local_setting(
    conn: &Connection,
    scope: &str,
    scope_id: &str,
    namespace: &str,
    key: &str,
    value: &str,
    schema_version: i64,
    time: i64,
) -> Result<(), String> {
    conn.execute(
        "insert into local_setting (
          scope, scope_id, namespace, key, value, schema_version, time_created, time_updated
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        on conflict(scope, scope_id, namespace, key) do update set
          value = excluded.value,
          schema_version = excluded.schema_version,
          time_updated = excluded.time_updated",
        params![scope, scope_id, namespace, key, value, schema_version, time, time],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `saveProjectPermission`: upsert the `permission`/`ruleset` setting (value = the incoming
/// ruleset JSON verbatim, matching TS `JSON.stringify(input.permission)`), then read it back through
/// [`crate::session_store::get_project_permission`].
///
/// TS THROWS `Project permission not found after write: <id>` when the read-back is null; we mirror
/// that by returning `Err`. A ruleset that parses to JSON `null` (or an empty value) triggers the
/// same failure, since the read decodes those to `null` exactly like `decodeJson(...) ?? null`.
///
/// # Arguments
///
/// * `conn` — an open read-write connection.
/// * `project_id` — the `scope_id` (project) the ruleset is bound to.
/// * `permission_json` — the ruleset as a JSON string (`JSON.stringify(permission)`).
/// * `now` — epoch ms for `time_created`/`time_updated`.
///
/// # Returns
///
/// The read-back `PermissionRuleset` projection.
///
/// # Errors
///
/// Propagates a write/decode failure, or the `Project permission not found after write` error when
/// the read-back is null.
pub fn save_project_permission(
    conn: &Connection,
    project_id: &str,
    permission_json: &str,
    now: i64,
) -> Result<Value, String> {
    write_local_setting(
        conn,
        "project",
        project_id,
        "permission",
        "ruleset",
        permission_json,
        1,
        now,
    )?;
    let saved = session_store::get_project_permission(conn, project_id)?;
    if saved.is_null() {
        return Err(format!(
            "Project permission not found after write: {project_id}"
        ));
    }
    Ok(saved)
}

/// Port of `saveProjectPermissionMode`: upsert the `permission`/`mode` setting with value =
/// `JSON.stringify({ mode })` (built with serde_json to match the TS object shape exactly), then
/// return `input.mode` directly — no read-back (the TS returns the argument, not the stored row).
///
/// # Arguments
///
/// * `conn` — an open read-write connection.
/// * `project_id` — the `scope_id` (project) the mode is bound to.
/// * `mode` — the collaboration mode string (stored under the `mode` key).
/// * `now` — epoch ms for `time_created`/`time_updated`.
///
/// # Returns
///
/// The mode as a JSON string value (`"yolo"`), matching `input.mode`.
///
/// # Errors
///
/// Returns `Err` when the upsert statement fails.
pub fn save_project_permission_mode(
    conn: &Connection,
    project_id: &str,
    mode: &str,
    now: i64,
) -> Result<Value, String> {
    let value = json!({ "mode": mode }).to_string();
    write_local_setting(
        conn, "project", project_id, "permission", "mode", &value, 1, now,
    )?;
    Ok(json!(mode))
}

/// N-API: `saveProjectPermission` port. Stores the ruleset (value = `permission_json` verbatim),
/// then returns the read-back projection JSON. If the read-back is null, throws
/// `Project permission not found after write: <id>` (mirrors the TS throw).
#[napi]
pub fn save_project_permission_json(
    db_path: String,
    project_id: String,
    permission_json: String,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value = save_project_permission(&conn, &project_id, &permission_json, now as i64)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `saveProjectPermissionMode` port. Stores `{"mode": mode}` and returns the mode string JSON
/// (`"yolo"`), matching the TS `return input.mode` (no read-back).
#[napi]
pub fn save_project_permission_mode_json(
    db_path: String,
    project_id: String,
    mode: String,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value = save_project_permission_mode(&conn, &project_id, &mode, now as i64)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory DB with the two tables `local_setting` (upsert target) and `permission`
    /// (the legacy read-back fallback), using the exact DDL from the session migrations.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute_batch(
            "create table local_setting (
              scope text not null,
              scope_id text not null,
              namespace text not null,
              key text not null,
              value text not null,
              schema_version integer not null,
              time_created integer not null,
              time_updated integer not null,
              primary key(scope, scope_id, namespace, key)
            );
            create table permission (
              project_id text primary key,
              time_created integer not null,
              time_updated integer not null,
              data text not null
            );",
        )
        .expect("invariant: create tables");
        conn
    }

    fn stored(conn: &Connection, key: &str) -> (String, i64, i64, i64) {
        conn.query_row(
            "select value, schema_version, time_created, time_updated \
             from local_setting where scope='project' and namespace='permission' and key=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("row present")
    }

    #[test]
    fn save_permission_inserts_then_upserts_update_branch() {
        let conn = db();
        let ruleset = json!({ "rules": [] });
        let out = save_project_permission(&conn, "p1", &ruleset.to_string(), 100).expect("ok");
        assert_eq!(out, ruleset);
        assert_eq!(stored(&conn, "ruleset"), (ruleset.to_string(), 1, 100, 100));

        // Upsert UPDATE branch: value/time_updated change, time_created is preserved (never touched
        // by the conflict arm) and a single row remains.
        let second = json!({ "rules": [{ "action": "deny" }] });
        let out2 =
            save_project_permission(&conn, "p1", &second.to_string(), 250).expect("re-save ok");
        assert_eq!(out2, second);
        let (value, schema, created, updated) = stored(&conn, "ruleset");
        assert_eq!(value, second.to_string());
        assert_eq!(schema, 1);
        assert_eq!(created, 100, "time_created kept on update");
        assert_eq!(updated, 250, "time_updated bumped on update");

        let count: i64 = conn
            .query_row("select count(*) from local_setting", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1, "upsert, not a second insert");
    }

    #[test]
    fn save_permission_errors_when_readback_null() {
        let conn = db();
        // A ruleset JSON literal `null` decodes to null → the read-back is treated as missing.
        let err = save_project_permission(&conn, "p2", "null", 10).unwrap_err();
        assert_eq!(err, "Project permission not found after write: p2");
    }

    #[test]
    fn save_mode_writes_object_and_returns_mode() {
        let conn = db();
        let out = save_project_permission_mode(&conn, "p3", "yolo", 42).expect("ok");
        assert_eq!(out, json!("yolo"));
        assert_eq!(stored(&conn, "mode"), (r#"{"mode":"yolo"}"#.to_string(), 1, 42, 42));
    }
}
