//! Legacy/remote session repair + claim write path (ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts`).
//!
//! Three per-call maintenance ops, each a SINGLE `update session` statement. The TS wraps none of them
//! in a transaction (`sessions.ts` lines 233-307: every one is `db.prepare(...).run(...)` followed by a
//! direct return), so neither do we — adding a `BEGIN IMMEDIATE` where the source has none would change
//! lock/rollback behavior. No op reads the clock: `claimLegacySessionWorkspace` and
//! `repairLegacyRemoteSessionWorkspace` take no time at all, and `repairRemoteSessionPaths` receives an
//! explicit `timeUpdated` in its input (used inside `max(time_updated, ?)`), so nothing is injected here.
//!
//! Reproduced verbatim:
//! - `claimLegacySessionWorkspace` folds `[...new Set(input.sessionIDs)]` (dedup, first-occurrence
//!   order) and short-circuits `0` before touching the DB when the set is empty; the `id in (...)`
//!   placeholder list is sized by the DEDUPED count. The return is `Number(result.changes)` — the count
//!   of rows the guarded `where workspace_id is null and directory = ? and id in (...)` modified.
//! - `repairLegacyRemoteSessionWorkspace` is a single-session CAS (`where id = ? and workspace_id is
//!   null and directory = ? and (path is null or path = ?)`) returning `changes === 1`.
//! - `repairRemoteSessionPaths` owns ONLY the path fields (`directory`, `path`) plus the guarded clock,
//!   never the title/permission/revert/archive columns an older full-field `updateSession` reused to
//!   overwrite concurrent values. Its `where` carries the subtle `((? is null and path is null) or
//!   path = ?)`: the same `expectedPath` binds twice — a SQL `NULL` takes the `path is null` arm, a
//!   string takes `path = ?` — reproducing the TS null-vs-value dispatch exactly.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection};
use serde_json::{Map, Value};

/// Port of `claimLegacySessionWorkspace`: claim the `sessionIDs` allowlist (deduped) whose
/// `workspace_id` is still `NULL` and whose `directory` matches, stamping `workspaceID`.
///
/// # Arguments
///
/// * `conn` - An open read-write connection (see [`crate::open_readwrite`]).
/// * `input` - The `ClaimLegacySessionWorkspaceInput` object: `{ sessionIDs: string[], directory,
///   workspaceID }`.
///
/// # Returns
///
/// The number of rows modified (`0` when the deduped allowlist is empty, without running any statement).
///
/// # Errors
///
/// Returns `Err` for a non-object input, a missing/mis-typed `sessionIDs` element or non-string
/// `directory`/`workspaceID`, or a failed statement.
pub fn claim_legacy_session_workspace(conn: &Connection, input: &Value) -> Result<i64, String> {
    let obj = input
        .as_object()
        .ok_or_else(|| "claimLegacySessionWorkspace input must be an object".to_string())?;

    // `const sessionIDs = [...new Set(input.sessionIDs)]`: preserve first-occurrence order, drop
    // repeats. A duplicate would not change the matched row set, but it WOULD change the `id in (...)`
    // arity, so the dedup is reproduced for a byte-identical statement.
    let raw_ids = obj
        .get("sessionIDs")
        .and_then(Value::as_array)
        .ok_or_else(|| "claimLegacySessionWorkspace requires a `sessionIDs` array".to_string())?;
    let mut session_ids: Vec<String> = Vec::with_capacity(raw_ids.len());
    for value in raw_ids {
        let id = value
            .as_str()
            .ok_or_else(|| "claimLegacySessionWorkspace sessionIDs must be strings".to_string())?;
        if !session_ids.iter().any(|seen| seen == id) {
            session_ids.push(id.to_string());
        }
    }
    // `if (sessionIDs.length === 0) return 0;` — no query, no DB touch.
    if session_ids.is_empty() {
        return Ok(0);
    }

    let directory = field_str(obj, "directory")?;
    let workspace_id = field_str(obj, "workspaceID")?;

    let placeholders = session_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "update session
         set workspace_id = ?
         where workspace_id is null
           and directory = ?
           and id in ({placeholders})"
    );

    // Bind order mirrors the TS `.run(input.workspaceID, input.directory, ...sessionIDs)`.
    let mut binds: Vec<SqlValue> = Vec::with_capacity(2 + session_ids.len());
    binds.push(SqlValue::Text(workspace_id.to_string()));
    binds.push(SqlValue::Text(directory.to_string()));
    for id in &session_ids {
        binds.push(SqlValue::Text(id.clone()));
    }

    let changes = conn
        .execute(&sql, rusqlite::params_from_iter(binds.iter()))
        .map_err(|e| e.to_string())?;
    Ok(changes as i64)
}

/// Port of `repairLegacyRemoteSessionWorkspace`: migrate ONE session from a legacy remote identity to
/// the resolved `{project_id, workspace_id, directory, path}`, guarded by a full-match CAS on
/// `id`, `workspace_id is null`, `directory = legacy`, and `path is null or path = legacy`.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `input` - The `RepairLegacyRemoteSessionWorkspaceInput` object: `{ sessionID, projectID,
///   legacyWorkspaceDirectory, workspaceID, workspacePath }` (all required strings).
///
/// # Returns
///
/// `true` iff exactly one row matched and was updated (`Number(result.changes) === 1`).
///
/// # Errors
///
/// Returns `Err` for a non-object input, a missing/mis-typed field, or a failed statement.
pub fn repair_legacy_remote_session_workspace(
    conn: &Connection,
    input: &Value,
) -> Result<bool, String> {
    let obj = input
        .as_object()
        .ok_or_else(|| "repairLegacyRemoteSessionWorkspace input must be an object".to_string())?;
    let project_id = field_str(obj, "projectID")?;
    let workspace_id = field_str(obj, "workspaceID")?;
    let workspace_path = field_str(obj, "workspacePath")?;
    let session_id = field_str(obj, "sessionID")?;
    let legacy_dir = field_str(obj, "legacyWorkspaceDirectory")?;

    let changes = conn
        .execute(
            "update session
             set project_id = ?, workspace_id = ?, directory = ?, path = ?
             where id = ?
               and workspace_id is null
               and directory = ?
               and (path is null or path = ?)",
            params![
                project_id,
                workspace_id,
                workspace_path,
                workspace_path,
                session_id,
                legacy_dir,
                legacy_dir,
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(changes == 1)
}

/// Port of `repairRemoteSessionPaths`: re-point ONE session's `directory`/`path` (and bump the clock via
/// `max`) using a CAS on `id`, `workspace_id`, `expectedDirectory`, and the `expectedPath`
/// null-or-equal arm. Touches only the path fields, never title/permission/revert/archive.
///
/// # Arguments
///
/// * `conn` - An open read-write connection.
/// * `input` - The `RepairRemoteSessionPathsInput` object: `{ sessionID, workspaceID, expectedDirectory,
///   expectedPath: string|null, directory, path: string|null, timeUpdated }`.
///
/// # Returns
///
/// `true` iff exactly one row matched and was updated (`Number(result.changes) === 1`).
///
/// # Errors
///
/// Returns `Err` for a non-object input, a missing/mis-typed field, or a failed statement.
pub fn repair_remote_session_paths(conn: &Connection, input: &Value) -> Result<bool, String> {
    let obj = input
        .as_object()
        .ok_or_else(|| "repairRemoteSessionPaths input must be an object".to_string())?;
    let directory = field_str(obj, "directory")?;
    // `path` and `expectedPath` are `string | null`; a JSON `null`/absent binds SQL NULL so the
    // `(? is null and path is null)` arm is taken, a string binds text so `path = ?` is taken.
    let path = nullable_str(obj, "path");
    let session_id = field_str(obj, "sessionID")?;
    let workspace_id = field_str(obj, "workspaceID")?;
    let expected_directory = field_str(obj, "expectedDirectory")?;
    let expected_path = nullable_str(obj, "expectedPath");
    let time_updated = obj
        .get("timeUpdated")
        .and_then(Value::as_i64)
        .ok_or_else(|| "repairRemoteSessionPaths requires an integer `timeUpdated`".to_string())?;

    let changes = conn
        .execute(
            "update session
             set directory = ?, path = ?, time_updated = max(time_updated, ?)
             where id = ?
               and workspace_id = ?
               and directory = ?
               and ((? is null and path is null) or path = ?)",
            params![
                directory,
                path,
                time_updated,
                session_id,
                workspace_id,
                expected_directory,
                expected_path,
                expected_path,
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(changes == 1)
}

/// Read a required (NOT NULL) string field, mirroring the TS direct access into the bind list.
fn field_str<'a>(obj: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    obj.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing or non-string `{key}`"))
}

/// Read a `string | null` field: JSON `null` or an absent key yield `None` (SQL NULL); a string yields
/// `Some`. Non-string, non-null values are treated as absent (`None`) to match binding `null`.
fn nullable_str<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

/// Encode a row-count return as JSON text (a JS number → `JSON.stringify(count)`).
fn count_json(count: i64) -> String {
    Value::from(count).to_string()
}

/// Encode a boolean return as JSON text (`true`/`false`).
fn bool_json(value: bool) -> String {
    Value::Bool(value).to_string()
}

/// N-API: `claimLegacySessionWorkspace` write boundary. Returns the number of claimed rows as JSON.
#[napi]
pub fn claim_legacy_session_workspace_json(
    db_path: String,
    input_json: String,
) -> Result<String, Error> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let count = claim_legacy_session_workspace(&conn, &input).map_err(Error::from_reason)?;
    Ok(count_json(count))
}

/// N-API: `repairLegacyRemoteSessionWorkspace` write boundary. Returns `true`/`false` as JSON.
#[napi]
pub fn repair_legacy_remote_session_workspace_json(
    db_path: String,
    input_json: String,
) -> Result<String, Error> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let changed =
        repair_legacy_remote_session_workspace(&conn, &input).map_err(Error::from_reason)?;
    Ok(bool_json(changed))
}

/// N-API: `repairRemoteSessionPaths` write boundary. Returns `true`/`false` as JSON.
#[napi]
pub fn repair_remote_session_paths_json(
    db_path: String,
    input_json: String,
) -> Result<String, Error> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let changed = repair_remote_session_paths(&conn, &input).map_err(Error::from_reason)?;
    Ok(bool_json(changed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// In-memory DB with the session schema applied and a few seeded parent sessions covering the
    /// legacy/remote states each repair targets.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute("PRAGMA foreign_keys = ON", [])
            .expect("invariant: enable fk");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 0)
            .expect("invariant: apply session schema");
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn seed(
        conn: &Connection,
        id: &str,
        project_id: &str,
        workspace_id: Option<&str>,
        directory: &str,
        path: Option<&str>,
        time_updated: i64,
    ) {
        conn.execute(
            "insert into session (id, project_id, workspace_id, slug, directory, path, title, \
             version, time_created, time_updated) \
             values (?1,?2,?3,'s',?4,?5,'t','v',1,?6)",
            params![id, project_id, workspace_id, directory, path, time_updated],
        )
        .expect("invariant: seed session");
    }

    fn ws(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row("select workspace_id from session where id = ?1", [id], |r| {
            r.get::<_, Option<String>>(0)
        })
        .unwrap_or(None)
    }

    fn col(conn: &Connection, id: &str, column: &str) -> Option<String> {
        let sql = format!("select {column} from session where id = ?1");
        conn.query_row(&sql, [id], |r| r.get::<_, Option<String>>(0))
            .unwrap_or(None)
    }

    fn clock(conn: &Connection, id: &str) -> Option<i64> {
        conn.query_row("select time_updated from session where id = ?1", [id], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .unwrap_or(None)
    }

    // ---- claimLegacySessionWorkspace ----

    #[test]
    fn claim_matches_directory_and_null_workspace_only() {
        let conn = db();
        // s1 qualifies (null ws, dir=/w, in allowlist). s2 has a wrong directory. s3 already has a ws.
        seed(&conn, "s1", "p", None, "/w", None, 10);
        seed(&conn, "s2", "p", None, "/other", None, 10);
        seed(&conn, "s3", "p", Some("existing"), "/w", None, 10);
        let count = claim_legacy_session_workspace(
            &conn,
            &json!({ "sessionIDs": ["s1", "s2", "s3", "ghost"], "directory": "/w", "workspaceID": "W" }),
        )
        .expect("claim ok");
        assert_eq!(count, 1, "only s1 meets null-ws + dir + allowlist");
        assert_eq!(ws(&conn, "s1").as_deref(), Some("W"));
        assert_eq!(ws(&conn, "s2"), None, "directory mismatch untouched");
        assert_eq!(ws(&conn, "s3").as_deref(), Some("existing"), "non-null ws untouched");
    }

    #[test]
    fn claim_dedups_and_is_idempotent() {
        let conn = db();
        seed(&conn, "s1", "p", None, "/w", None, 10);
        seed(&conn, "s2", "p", None, "/w", None, 10);
        // Duplicated ids across the list still claim both rows once each (set-deduped to [s1,s2]).
        let first = claim_legacy_session_workspace(
            &conn,
            &json!({ "sessionIDs": ["s1", "s1", "s2"], "directory": "/w", "workspaceID": "W" }),
        )
        .expect("first claim");
        assert_eq!(first, 2);
        // Second run: workspace_id is now non-null for both → the null-guard excludes them → 0 changes.
        let second = claim_legacy_session_workspace(
            &conn,
            &json!({ "sessionIDs": ["s1", "s2"], "directory": "/w", "workspaceID": "W2" }),
        )
        .expect("second claim");
        assert_eq!(second, 0, "already-claimed rows are not re-stamped");
        assert_eq!(ws(&conn, "s1").as_deref(), Some("W"));
    }

    #[test]
    fn claim_empty_allowlist_returns_zero_without_touching_db() {
        let conn = db();
        seed(&conn, "s1", "p", None, "/w", None, 10);
        let count = claim_legacy_session_workspace(
            &conn,
            &json!({ "sessionIDs": [], "directory": "/w", "workspaceID": "W" }),
        )
        .expect("empty claim");
        assert_eq!(count, 0);
        assert_eq!(ws(&conn, "s1"), None, "no query, no stamp");
    }

    // ---- repairLegacyRemoteSessionWorkspace ----

    #[test]
    fn repair_legacy_matches_full_cas() {
        let conn = db();
        seed(&conn, "s1", "oldProj", None, "/legacy", None, 10);
        let changed = repair_legacy_remote_session_workspace(
            &conn,
            &json!({
                "sessionID": "s1", "projectID": "newProj", "legacyWorkspaceDirectory": "/legacy",
                "workspaceID": "W", "workspacePath": "/resolved"
            }),
        )
        .expect("repair");
        assert!(changed, "null-ws + dir match + null-path → one row migrated");
        assert_eq!(col(&conn, "s1", "project_id").as_deref(), Some("newProj"));
        assert_eq!(ws(&conn, "s1").as_deref(), Some("W"));
        assert_eq!(col(&conn, "s1", "directory").as_deref(), Some("/resolved"));
        assert_eq!(col(&conn, "s1", "path").as_deref(), Some("/resolved"));
    }

    #[test]
    fn repair_legacy_no_match_when_directory_differs() {
        let conn = db();
        seed(&conn, "s1", "oldProj", None, "/different", None, 10);
        let changed = repair_legacy_remote_session_workspace(
            &conn,
            &json!({
                "sessionID": "s1", "projectID": "newProj", "legacyWorkspaceDirectory": "/legacy",
                "workspaceID": "W", "workspacePath": "/resolved"
            }),
        )
        .expect("repair");
        assert!(!changed, "directory CAS miss → false");
        assert_eq!(col(&conn, "s1", "project_id").as_deref(), Some("oldProj"), "untouched");
    }

    #[test]
    fn repair_legacy_rejects_pre_existing_workspace_or_mismatched_path() {
        let conn = db();
        // Already has a workspace_id → `workspace_id is null` guard fails.
        seed(&conn, "hasWs", "p", Some("W0"), "/legacy", None, 10);
        assert!(
            !repair_legacy_remote_session_workspace(
                &conn,
                &json!({
                    "sessionID": "hasWs", "projectID": "p2", "legacyWorkspaceDirectory": "/legacy",
                    "workspaceID": "W", "workspacePath": "/r"
                }),
            )
            .expect("repair")
        );
        // path present but != legacyWorkspaceDirectory → the `(path is null or path = ?)` arm fails.
        seed(&conn, "otherPath", "p", None, "/legacy", Some("/elsewhere"), 10);
        assert!(
            !repair_legacy_remote_session_workspace(
                &conn,
                &json!({
                    "sessionID": "otherPath", "projectID": "p2", "legacyWorkspaceDirectory": "/legacy",
                    "workspaceID": "W", "workspacePath": "/r"
                }),
            )
            .expect("repair")
        );
        // path present and EQUAL to legacy dir → matches.
        seed(&conn, "samePath", "p", None, "/legacy", Some("/legacy"), 10);
        assert!(
            repair_legacy_remote_session_workspace(
                &conn,
                &json!({
                    "sessionID": "samePath", "projectID": "p2", "legacyWorkspaceDirectory": "/legacy",
                    "workspaceID": "W", "workspacePath": "/r"
                }),
            )
            .expect("repair")
        );
    }

    #[test]
    fn repair_legacy_is_idempotent_after_migrating() {
        let conn = db();
        seed(&conn, "s1", "oldProj", None, "/legacy", None, 10);
        let input = json!({
            "sessionID": "s1", "projectID": "newProj", "legacyWorkspaceDirectory": "/legacy",
            "workspaceID": "W", "workspacePath": "/resolved"
        });
        assert!(repair_legacy_remote_session_workspace(&conn, &input).expect("first"));
        // directory is now /resolved (not /legacy) and workspace_id is set → CAS fails → false.
        assert!(!repair_legacy_remote_session_workspace(&conn, &input).expect("second"));
    }

    // ---- repairRemoteSessionPaths ----

    #[test]
    fn repair_paths_null_expected_path_matches_null_and_bumps_clock() {
        let conn = db();
        seed(&conn, "s1", "p", Some("W"), "/old", None, 100);
        let changed = repair_remote_session_paths(
            &conn,
            &json!({
                "sessionID": "s1", "workspaceID": "W", "expectedDirectory": "/old",
                "expectedPath": null, "directory": "/new", "path": null, "timeUpdated": 500
            }),
        )
        .expect("repair");
        assert!(changed);
        assert_eq!(col(&conn, "s1", "directory").as_deref(), Some("/new"));
        assert_eq!(col(&conn, "s1", "path"), None, "null path stays null");
        assert_eq!(clock(&conn, "s1"), Some(500), "max moved forward");
    }

    #[test]
    fn repair_paths_string_expected_path_matches_equal_and_clears_or_sets() {
        let conn = db();
        seed(&conn, "s1", "p", Some("W"), "/old", Some("/old/rel"), 100);
        let changed = repair_remote_session_paths(
            &conn,
            &json!({
                "sessionID": "s1", "workspaceID": "W", "expectedDirectory": "/old",
                "expectedPath": "/old/rel", "directory": "/new", "path": "/new/rel",
                "timeUpdated": 500
            }),
        )
        .expect("repair");
        assert!(changed, "string expectedPath takes the `path = ?` arm on an equal value");
        assert_eq!(col(&conn, "s1", "path").as_deref(), Some("/new/rel"));
    }

    #[test]
    fn repair_paths_expected_path_string_does_not_match_null_column() {
        let conn = db();
        seed(&conn, "s1", "p", Some("W"), "/old", None, 100);
        // expectedPath is a string but the stored path is NULL: the `(? is null ...)` arm is false and
        // `path = ?` (string vs NULL) is false → no match.
        let changed = repair_remote_session_paths(
            &conn,
            &json!({
                "sessionID": "s1", "workspaceID": "W", "expectedDirectory": "/old",
                "expectedPath": "/old/rel", "directory": "/new", "path": null, "timeUpdated": 500
            }),
        )
        .expect("repair");
        assert!(!changed);
        assert_eq!(col(&conn, "s1", "directory").as_deref(), Some("/old"), "untouched");
    }

    #[test]
    fn repair_paths_clock_never_moves_backwards_and_guards_workspace() {
        let conn = db();
        seed(&conn, "s1", "p", Some("W"), "/old", None, 1000);
        // stale timeUpdated must not regress time_updated via max().
        let changed = repair_remote_session_paths(
            &conn,
            &json!({
                "sessionID": "s1", "workspaceID": "W", "expectedDirectory": "/old",
                "expectedPath": null, "directory": "/new", "path": null, "timeUpdated": 4
            }),
        )
        .expect("repair");
        assert!(changed, "still matched and modified directory");
        assert_eq!(clock(&conn, "s1"), Some(1000), "guarded max keeps the newer clock");
        // Wrong workspace_id CAS → no match.
        assert!(
            !repair_remote_session_paths(
                &conn,
                &json!({
                    "sessionID": "s1", "workspaceID": "OTHER", "expectedDirectory": "/new",
                    "expectedPath": null, "directory": "/x", "path": null, "timeUpdated": 5000
                }),
            )
            .expect("repair")
        );
    }

    #[test]
    fn repair_paths_is_idempotent_after_repointing() {
        let conn = db();
        seed(&conn, "s1", "p", Some("W"), "/old", None, 100);
        let input = json!({
            "sessionID": "s1", "workspaceID": "W", "expectedDirectory": "/old",
            "expectedPath": null, "directory": "/new", "path": null, "timeUpdated": 500
        });
        assert!(repair_remote_session_paths(&conn, &input).expect("first"));
        // Now directory is /new, so expectedDirectory=/old no longer matches → false, clock held.
        assert!(!repair_remote_session_paths(&conn, &input).expect("second"));
        assert_eq!(clock(&conn, "s1"), Some(500));
    }

    #[test]
    fn repairs_error_on_missing_required_fields() {
        let conn = db();
        assert!(repair_remote_session_paths(&conn, &json!({ "sessionID": "s1" })).is_err());
        assert!(
            repair_legacy_remote_session_workspace(&conn, &json!({ "sessionID": "s1" })).is_err()
        );
        assert!(claim_legacy_session_workspace(&conn, &json!({ "directory": "/w" })).is_err());
    }
}
