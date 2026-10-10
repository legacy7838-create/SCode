//! `session_task_link` + `permission-full-access` WRITE paths (ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-activities.ts`
//! (`createSessionTaskLink`) and `.../permission-full-access.ts` (`commitPermissionFullAccess`), with
//! the row→record codec from `.../script-workflow-codecs.ts` (`decodeTaskLink`)).
//!
//! Transaction decision, taken verbatim from the SOURCE (not "improved"):
//!
//! - `createSessionTaskLink` (activities.ts:189-226): ONE `insert into session_task_link
//!   ... on conflict(child_session_id) do update set status = excluded.status, time_updated =
//!   excluded.time_updated` then the `decodeTaskLink` read-back by `child_session_id`. A lone write
//!   statement is atomic on its own, so — exactly like the TS — it is NOT wrapped in a transaction.
//!   The `unique(child_session_id)` constraint (session_migrations.rs:369) is what the `on conflict`
//!   target matches: a second link for the SAME child session updates ONLY `status`/`time_updated`,
//!   leaving every other column (id, role, depth, path, the parent/run/activity ids, the time_created)
//!   at the first insert's values.
//! - `commitPermissionFullAccess` (permission-full-access.ts:6-54) is a MULTI-STATEMENT ATOMIC WRITE.
//!   The TS opens `begin immediate`, then (a) probes `session_entry` by the receipt id — an already
//!   committed receipt short-circuits with `commit` + early return, (b) for every `queueItemIds` reads
//!   the `admitted` `session_input` payload, mutates the `intent`/`conversationInputIntent` sub-objects
//!   to `{ ...intent, mode: "yolo" }` and updates the row, then (c) saves the `execution` + `receipt`
//!   session entries — and closes with `commit`. Any throw (session mismatch, receipt-session mismatch,
//!   missing/invalid pending input, a failed statement) hits `rollback` before rethrowing. Reproduced
//!   with ONE `rusqlite` `BEGIN IMMEDIATE` … `COMMIT`, rolling back on every error path.
//!
//! The two `Permission commit session mismatch` / `Permission receipt session mismatch` guard throws
//! live at their exact TS positions (the first before the transaction opens, the second inside it).
//!
//! The TS `input.signal?.throwIfAborted()` is a JS `AbortSignal` probe: the N-API boundary cannot
//! observe a caller's signal synchronously across the FFI, and — crucially — it has NO write effect, so
//! it is not reproduced here; the facade's own `throwBeforeWrite()` already owns cancellation before the
//! call, matching every other ported write boundary.
//!
//! JSON-column parity: `serde_json` runs with `preserve_order`, so a mutated `session_input` payload is
//! re-serialised with `Value::to_string()` keeping insertion order to byte-match JS
//! `JSON.stringify(JSON.parse(col))`. `?? null` for optional string columns is modelled as
//! "present-and-non-null → the value, else SQL `NULL`"; the JS spread `{ ...intent, mode: "yolo" }`
//! preserves an existing `mode` key's position (overriding its value) and appends a brand-new one.
//! `now` (the `Date.now()` the TS reads per queue-item write and for `session_task_link`
//! `time_created`/`time_updated`) and every id are INJECTED by the caller; the addon never reads the
//! clock, keeping writes deterministic and parity-testable.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

// ---------------------------------------------------------------------------
// createSessionTaskLink
// ---------------------------------------------------------------------------

/// Port of `createSessionTaskLink` (activities.ts:189-226): the upsert into `session_task_link` plus
/// the `decodeTaskLink` read-back keyed by `child_session_id`. No transaction (single write statement).
///
/// # Arguments
///
/// * `conn` — read-write connection (FK enforcement owned by the caller, see [`crate::open_readwrite`]).
///   `child_session_id` must reference a seeded `session`; a present `parent_session_id` likewise;
///   `root_workflow_run_id` references `workflow_run`; `activity_id` references `workflow_activity`;
///   `parent_link_id` references another `session_task_link`.
/// * `input` — `CreateSessionTaskLinkInput`: `{id, childSessionId, role, path, status, depth?,
///   rootWorkflowRunId?, parentLinkId?, activityId?, parentSessionId?, phase?, label?, agentType?,
///   model?}`.
/// * `now` — injected epoch ms for `time_created` and `time_updated`.
///
/// # Returns
///
/// The read-back `SessionTaskLinkRecord` projection (`decodeTaskLink` key order).
///
/// # Errors
///
/// Returns `Err(String)` for a missing/mis-typed required field, a failed statement (e.g. an FK
/// violation), or a missing row after the write (mirrors `Session task link not found after write`).
pub fn create_session_task_link(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> Result<Value, String> {
    let id = required_str(input, "id")?;
    let child_session_id = required_str(input, "childSessionId")?;
    let role = required_str(input, "role")?;
    let path = required_str(input, "path")?;
    let status = required_str(input, "status")?;
    let depth = opt_i64(input, "depth").unwrap_or(0);

    conn.execute(
        "insert into session_task_link (
          id, root_workflow_run_id, parent_link_id, activity_id, parent_session_id,
          child_session_id, role, depth, path, phase, label, agent_type, model, status,
          time_created, time_updated
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
        on conflict(child_session_id) do update set
          status = excluded.status,
          time_updated = excluded.time_updated",
        params![
            id,
            opt_str(input, "rootWorkflowRunId"),
            opt_str(input, "parentLinkId"),
            opt_str(input, "activityId"),
            opt_str(input, "parentSessionId"),
            child_session_id,
            role,
            depth,
            path,
            opt_str(input, "phase"),
            opt_str(input, "label"),
            opt_str(input, "agentType"),
            opt_str(input, "model"),
            status,
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    must_get_task_link(conn, child_session_id)
}

// ---------------------------------------------------------------------------
// commitPermissionFullAccess
// ---------------------------------------------------------------------------

/// Port of `commitPermissionFullAccess` (permission-full-access.ts:6-54): an atomic
/// `BEGIN IMMEDIATE` write that upgrades every `admitted` queue input's intent to `mode: "yolo"`, then
/// persists the `execution` and `receipt` session entries. Returns `Ok(())` on commit; on the
/// idempotency short-circuit (a receipt entry already stored for this session) it commits with no
/// queue/entry writes, matching the TS.
///
/// # Arguments
///
/// * `conn` — read-write connection.
/// * `input` — `{sessionID, queueItemIds: string[], execution: SessionEntryInfo, receipt:
///   SessionEntryInfo}`. (The TS also carries `signal?`; the addon cannot observe a JS `AbortSignal`,
///   and it has no write effect, so it is intentionally not part of the JSON.)
/// * `now` — injected epoch ms for each `session_input` `time_updated` write (the TS's per-iteration
///   `Date.now()`, frozen to one value for parity).
///
/// # Errors
///
/// Returns `Err(String)`: `"Permission commit session mismatch"` when `execution.sessionID` or
/// `receipt.sessionID` differs from `sessionID`; `"Permission receipt session mismatch"` when a stored
/// receipt entry belongs to a different session; `` `Pending input unavailable: ${id}` `` when a queue
/// item is missing or its payload is not a JSON string; or any sibling-module / `rusqlite` error. Every
/// error path rolls the transaction back before returning.
pub fn commit_permission_full_access(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> Result<(), String> {
    let session_id = required_str(input, "sessionID")?;
    let execution = required_obj(input, "execution")?;
    let receipt = required_obj(input, "receipt")?;

    // TS:5-9 — guard BEFORE the transaction: both entries must be scoped to this session.
    if session_of(execution)? != session_id || session_of(receipt)? != session_id {
        return Err("Permission commit session mismatch".to_string());
    }

    let queue_ids = match input.get("queueItemIds") {
        Some(Value::Array(arr)) => arr.clone(),
        Some(_) => return Err("queueItemIds must be an array".to_string()),
        None => Vec::new(),
    };

    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let body = || -> Result<(), String> {
        let receipt_id = receipt
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| ".id must be a string".to_string())?;

        // TS:19-27 — already-committed receipt for THIS session short-circuits (idempotent re-commit).
        let existing: Option<String> = conn
            .query_row(
                "select session_id from session_entry where id = ?1",
                [receipt_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if existing.is_some() {
            if existing.as_deref() != Some(session_id) {
                return Err("Permission receipt session mismatch".to_string());
            }
            return Ok(());
        }

        // TS:28-46 — for every queue item, read the admitted payload, flip the intent modes, re-encode.
        for id_value in &queue_ids {
            let id = id_value
                .as_str()
                .ok_or_else(|| "queueItemIds elements must be strings".to_string())?;
            let payload: Option<String> = conn
                .query_row(
                    "select payload from session_input \
                     where id = ?1 and session_id = ?2 and status = 'admitted'",
                    params![id, session_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
            // TS: `!row || typeof row.payload !== "string"`. The `session_input.payload` column is
            // NOT NULL TEXT, so a present row always yields a string; only a missing row reaches here.
            let payload = payload.ok_or_else(|| format!("Pending input unavailable: {id}"))?;
            let mut parsed: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
            for key in ["intent", "conversationInputIntent"] {
                let flip = parsed
                    .get(key)
                    .is_some_and(|v| matches!(v, Value::Object(_)));
                if flip {
                    let mut obj = match parsed.get(key) {
                        Some(Value::Object(o)) => o.clone(),
                        _ => Map::new(),
                    };
                    obj.insert("mode".to_string(), Value::String("yolo".to_string()));
                    if let Some(map) = parsed.as_object_mut() {
                        map.insert(key.to_string(), Value::Object(obj));
                    }
                }
            }
            conn.execute(
                "update session_input set payload = ?1, time_updated = ?2 \
                 where id = ?3 and session_id = ?4 and status = 'admitted'",
                params![parsed.to_string(), now, id, session_id],
            )
            .map_err(|e| e.to_string())?;
        }

        // TS:47-48 — persist both entries (each is one upsert + touchSession via the entry module).
        crate::session_write_entry::save_session_entry(conn, execution)?;
        crate::session_write_entry::save_session_entry(conn, receipt)?;
        Ok(())
    }();

    match body {
        Ok(()) => {
            conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// The `sessionID` field of an entry/input object (TS reads it directly; a missing/non-string is a
/// typed error rather than a silent `undefined`).
fn session_of(value: &Value) -> Result<&str, String> {
    value
        .get("sessionID")
        .and_then(Value::as_str)
        .ok_or_else(|| ".sessionID must be a string".to_string())
}

/// Read a required top-level object field.
fn required_obj<'a>(input: &'a Value, key: &str) -> Result<&'a Value, String> {
    input
        .get(key)
        .filter(|v| v.is_object())
        .ok_or_else(|| format!(".{key} must be an object"))
}

/// Read a required top-level string field (mirrors TS's direct `input.<field>` into a NOT NULL column).
fn required_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!(".{key} must be a string"))
}

/// `?? null` for an optional string column: absent/`null` → `None`; otherwise the string.
fn opt_str<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

/// `?? <default>` for an optional integer column (`depth`): absent/`null` → `None` (caller defaults).
fn opt_i64(input: &Value, key: &str) -> Option<i64> {
    input.get(key).and_then(Value::as_i64)
}

/// Read a `session_task_link` row by `child_session_id` and return the `decodeTaskLink` projection;
/// throw the TS "not found after write" message when absent.
fn must_get_task_link(conn: &Connection, child_session_id: &str) -> Result<Value, String> {
    let row = conn
        .query_row(
            "select activity_id, agent_type, child_session_id, depth, id, label, model, \
                    parent_link_id, parent_session_id, path, phase, role, root_workflow_run_id, \
                    status, time_created, time_updated \
             from session_task_link where child_session_id = ?1",
            [child_session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>("activity_id")?,
                    row.get::<_, Option<String>>("agent_type")?,
                    row.get::<_, String>("child_session_id")?,
                    row.get::<_, i64>("depth")?,
                    row.get::<_, String>("id")?,
                    row.get::<_, Option<String>>("label")?,
                    row.get::<_, Option<String>>("model")?,
                    row.get::<_, Option<String>>("parent_link_id")?,
                    row.get::<_, Option<String>>("parent_session_id")?,
                    row.get::<_, String>("path")?,
                    row.get::<_, Option<String>>("phase")?,
                    row.get::<_, String>("role")?,
                    row.get::<_, Option<String>>("root_workflow_run_id")?,
                    row.get::<_, String>("status")?,
                    row.get::<_, i64>("time_created")?,
                    row.get::<_, i64>("time_updated")?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Session task link not found after write: {child_session_id}"))?;

    let (
        activity_id,
        agent_type,
        child,
        depth,
        id,
        label,
        model,
        parent_link_id,
        parent_session_id,
        path,
        phase,
        role,
        root_workflow_run_id,
        status,
        time_created,
        time_updated,
    ) = row;

    // `decodeTaskLink` key order (codecs.ts:184-202); optional string columns are OMITTED when NULL.
    let mut m = Map::new();
    opt_str_into(&mut m, "activityId", activity_id);
    opt_str_into(&mut m, "agentType", agent_type);
    m.insert("childSessionId".to_string(), Value::String(child));
    m.insert("createdAt".to_string(), Value::from(time_created));
    m.insert("depth".to_string(), Value::from(depth));
    m.insert("id".to_string(), Value::String(id));
    opt_str_into(&mut m, "label", label);
    opt_str_into(&mut m, "model", model);
    opt_str_into(&mut m, "parentLinkId", parent_link_id);
    opt_str_into(&mut m, "parentSessionId", parent_session_id);
    m.insert("path".to_string(), Value::String(path));
    opt_str_into(&mut m, "phase", phase);
    m.insert("role".to_string(), Value::String(role));
    opt_str_into(&mut m, "rootWorkflowRunId", root_workflow_run_id);
    m.insert("status".to_string(), Value::String(status));
    m.insert("updatedAt".to_string(), Value::from(time_updated));
    Ok(Value::Object(m))
}

/// Insert an optional string into the projection only when present (`row.x ?? undefined` → key omitted
/// for `undefined`), preserving `decodeTaskLink`'s key order.
fn opt_str_into(m: &mut Map<String, Value>, key: &str, raw: Option<String>) {
    if let Some(v) = raw {
        m.insert(key.to_string(), Value::String(v));
    }
}

// ---------------------------------------------------------------------------
// N-API boundaries
// ---------------------------------------------------------------------------

/// N-API: `createSessionTaskLink` write boundary. `link_json` is the serialized
/// `CreateSessionTaskLinkInput`; `now` is the injected epoch ms. Returns the read-back projection JSON.
#[napi]
pub fn create_session_task_link_json(
    db_path: String,
    link_json: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&link_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let value = create_session_task_link(&conn, &input, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `commitPermissionFullAccess` write boundary. `input_json` is the serialized input
/// (`{sessionID, queueItemIds, execution, receipt}`); `now` is the injected epoch ms. Returns the JSON
/// literal `"null"` (the TS returns `void`).
#[napi]
pub fn commit_permission_full_access_json(
    db_path: String,
    input_json: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    commit_permission_full_access(&conn, &input, now as i64).map_err(Error::from_reason)?;
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
             values ('parent','p','slug-p','/dp','t','v',100,100)",
            [],
        )
        .expect("invariant: seed parent session");
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
             values ('child','p','slug-c','/dc','t','v',100,100)",
            [],
        )
        .expect("invariant: seed child session");
        conn
    }

    /// Seed a `workflow_run` (FK target of `root_workflow_run_id`) and a `workflow_activity` (FK target
    /// of `activity_id`) so the task-link reference checks pass.
    fn seed_workflow_parents(conn: &Connection, run_id: &str, activity_id: &str) {
        conn.execute(
            "insert into workflow_run (
               id, name, kind, status, cwd, script_hash, budget_spent, time_created, time_updated
             ) values (?1,'n','script','running','/c','h',0,100,100)",
            [run_id],
        )
        .expect("invariant: seed run");
        conn.execute(
            "insert into workflow_activity (
               id, run_id, call_index, call_path, attempt, type, input_hash, status,
               time_created, time_updated
             ) values (?1,?2,0,'p',1,'step','h','queued',100,100)",
            params![activity_id, run_id],
        )
        .expect("invariant: seed activity");
    }

    // -----------------------------------------------------------------------
    // createSessionTaskLink
    // -----------------------------------------------------------------------

    #[test]
    fn task_link_full_projection_and_key_order() {
        let conn = db();
        seed_workflow_parents(&conn, "run-1", "act-1");
        let out = create_session_task_link(
            &conn,
            &json!({
                "id": "link-1", "rootWorkflowRunId": "run-1", "parentLinkId": null,
                "activityId": "act-1", "parentSessionId": "parent", "childSessionId": "child",
                "role": "worker", "depth": 2, "path": "a/b/c", "phase": "build",
                "label": "the label", "agentType": "explore", "model": "opus", "status": "running"
            }),
            5000,
        )
        .expect("create link");

        // decodeTaskLink key order (codecs.ts:184-202), byte-checkable against JSON.stringify of a
        // pre-ordered object. `parentLinkId` is passed as explicit `null` (→ NULL → omitted), so the
        // remaining 15 keys must appear in exact `decodeTaskLink` order.
        let keys: Vec<&String> = out.as_object().expect("object").keys().collect();
        assert_eq!(
            keys,
            vec![
                "activityId",
                "agentType",
                "childSessionId",
                "createdAt",
                "depth",
                "id",
                "label",
                "model",
                "parentSessionId",
                "path",
                "phase",
                "role",
                "rootWorkflowRunId",
                "status",
                "updatedAt"
            ],
            "projection preserves decodeTaskLink key order"
        );
        assert_eq!(out["depth"], json!(2));
        assert_eq!(
            out["createdAt"],
            json!(5000),
            "now injected as time_created"
        );
        assert_eq!(
            out["updatedAt"],
            json!(5000),
            "now injected as time_updated"
        );
        assert_eq!(out["childSessionId"], json!("child"));
        // An explicit `parentLinkId: null` is treated as absent → key omitted (NULL → undefined).
        assert!(out.get("parentLinkId").is_none());
    }

    #[test]
    fn task_link_optional_fields_omitted_and_depth_default() {
        let conn = db();
        let out = create_session_task_link(
            &conn,
            &json!({
                "id": "link-min", "childSessionId": "child", "role": "root",
                "path": "root", "status": "pending"
            }),
            6000,
        )
        .expect("minimal create");
        assert_eq!(out["depth"], json!(0), "depth defaults to 0 when absent");
        for k in [
            "activityId",
            "agentType",
            "label",
            "model",
            "parentLinkId",
            "parentSessionId",
            "phase",
            "rootWorkflowRunId",
        ] {
            assert!(out.get(k).is_none(), "{k} absent → NULL → omitted");
        }
    }

    #[test]
    fn task_link_present_parent_link_id_kept() {
        let conn = db();
        // Root link first so a second link can reference it as parent (FK-valid).
        create_session_task_link(
            &conn,
            &json!({
                "id": "link-root", "childSessionId": "parent", "role": "root",
                "path": "root", "status": "running"
            }),
            7000,
        )
        .expect("root link");
        let child = create_session_task_link(
            &conn,
            &json!({
                "id": "link-child", "parentLinkId": "link-root", "childSessionId": "child",
                "role": "worker", "path": "root.child", "status": "running"
            }),
            7000,
        )
        .expect("child link");
        assert_eq!(
            child["parentLinkId"],
            json!("link-root"),
            "present parent_link_id surfaces"
        );
    }

    #[test]
    fn task_link_recommit_upserts_only_status_and_time_updated() {
        let conn = db();
        create_session_task_link(
            &conn,
            &json!({
                "id": "link-1", "childSessionId": "child", "role": "worker", "depth": 3,
                "path": "orig", "status": "running", "label": "keep me"
            }),
            5000,
        )
        .expect("first insert");
        // Same child session: the on-conflict arm touches ONLY status + time_updated. A different id,
        // role, depth, path, label are IGNORED (already stored row keeps them).
        let again = create_session_task_link(
            &conn,
            &json!({
                "id": "link-DIFFERENT", "childSessionId": "child", "role": "changed",
                "depth": 99, "path": "changed", "status": "completed", "label": "changed"
            }),
            9000,
        )
        .expect("re-commit");
        assert_eq!(
            again["id"],
            json!("link-1"),
            "id preserved (not the excluded id)"
        );
        assert_eq!(again["role"], json!("worker"), "role preserved");
        assert_eq!(again["depth"], json!(3), "depth preserved");
        assert_eq!(again["path"], json!("orig"), "path preserved");
        assert_eq!(again["label"], json!("keep me"), "label preserved");
        assert_eq!(again["createdAt"], json!(5000), "time_created preserved");
        assert_eq!(
            again["status"],
            json!("completed"),
            "status = excluded.status"
        );
        assert_eq!(
            again["updatedAt"],
            json!(9000),
            "time_updated = excluded now"
        );
    }

    #[test]
    fn task_link_missing_required_throws() {
        let conn = db();
        let err = create_session_task_link(
            &conn,
            &json!({ "id": "x", "childSessionId": "child", "role": "r", "path": "p" }),
            1000,
        )
        .expect_err("status is required");
        assert_eq!(err, ".status must be a string");
    }

    // -----------------------------------------------------------------------
    // commitPermissionFullAccess
    // -----------------------------------------------------------------------

    fn seed_admitted_input(conn: &Connection, id: &str, session_id: &str, payload: &str) {
        conn.execute(
            "insert into session_input (
               id, session_id, kind, delivery, payload, admitted_sequence, status,
               time_created, time_updated
             ) values (?1,?2,'user','queue',?3,
               (select coalesce(max(admitted_sequence), -1) + 1 from session_input where session_id = ?2),
               'admitted', 1, 1)",
            params![id, session_id, payload],
        )
        .expect("seed input");
    }

    fn entry_exists(conn: &Connection, id: &str) -> bool {
        conn.query_row(
            "select 1 from session_entry where id = ?1",
            [id],
            |_| Ok(()),
        )
        .is_ok()
    }

    fn input_payload(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "select payload from session_input where id = ?1",
            [id],
            |r| r.get::<_, String>(0),
        )
        .expect("read payload")
    }

    fn base_commit_input() -> Value {
        json!({
            "sessionID": "child",
            "queueItemIds": ["q1"],
            "execution": {
                "id": "exec-1", "sessionID": "child", "type": "permission/execution",
                "time": { "created": 5000, "updated": 5000 }, "data": { "ok": true }
            },
            "receipt": {
                "id": "rcpt-1", "sessionID": "child", "type": "permission/receipt",
                "time": { "created": 5000, "updated": 5000 }, "data": { "granted": "yolo" }
            }
        })
    }

    #[test]
    fn permission_commit_fresh_flips_yolo_and_writes_entries() {
        let conn = db();
        seed_admitted_input(
            &conn,
            "q1",
            "child",
            r#"{"text":"hi","intent":{"queuePosition":1}}"#,
        );
        let input = base_commit_input();
        commit_permission_full_access(&conn, &input, 5000).expect("commit");
        // intent got `mode:"yolo"` appended, existing keys preserved.
        assert_eq!(
            input_payload(&conn, "q1"),
            r#"{"text":"hi","intent":{"queuePosition":1,"mode":"yolo"}}"#
        );
        // both entries persisted.
        assert!(entry_exists(&conn, "exec-1"));
        assert!(entry_exists(&conn, "rcpt-1"));
        let updated: i64 = conn
            .query_row(
                "select time_updated from session_input where id='q1'",
                [],
                |r| r.get(0),
            )
            .expect("read updated");
        assert_eq!(updated, 5000, "now injected into time_updated");
    }

    #[test]
    fn permission_commit_flips_conversation_input_intent_and_existing_mode_position() {
        let conn = db();
        // `intent` already carries `mode` at a non-first position → the flip keeps its position.
        // `conversationInputIntent` is an object → also flipped. `otherKey` is left untouched.
        seed_admitted_input(
            &conn,
            "q1",
            "child",
            r#"{"otherKey":1,"intent":{"mode":"ask","x":2},"conversationInputIntent":{"a":true}}"#,
        );
        let input = base_commit_input();
        commit_permission_full_access(&conn, &input, 5000).expect("commit");
        assert_eq!(
            input_payload(&conn, "q1"),
            r#"{"otherKey":1,"intent":{"mode":"yolo","x":2},"conversationInputIntent":{"a":true,"mode":"yolo"}}"#,
            "existing mode keeps its slot (overridden); new mode appended last"
        );
    }

    #[test]
    fn permission_commit_leaves_non_object_intents_untouched() {
        let conn = db();
        // `intent` is a plain string (truthy but not an object) and `conversationInputIntent` is null:
        // both must be skipped (TS `intent && typeof intent === "object" && !Array.isArray`).
        seed_admitted_input(
            &conn,
            "q1",
            "child",
            r#"{"intent":"nope","conversationInputIntent":null,"keep":1}"#,
        );
        let before = input_payload(&conn, "q1");
        let input = base_commit_input();
        commit_permission_full_access(&conn, &input, 5000).expect("commit");
        assert_eq!(
            input_payload(&conn, "q1"),
            before,
            "no flip on non-object intent"
        );
    }

    #[test]
    fn permission_commit_is_idempotent_on_recommit() {
        let conn = db();
        seed_admitted_input(&conn, "q1", "child", r#"{"intent":{"x":1}}"#);
        let input = base_commit_input();
        commit_permission_full_access(&conn, &input, 5000).expect("first commit");
        let payload_after_first = input_payload(&conn, "q1");
        // Second commit: the receipt entry already exists for this session → short-circuit with commit,
        // so the queue item is NOT re-flipped and time_updated is NOT re-stamped.
        commit_permission_full_access(&conn, &input, 8888).expect("re-commit");
        assert_eq!(
            input_payload(&conn, "q1"),
            payload_after_first,
            "idempotent re-commit makes no queue changes"
        );
        let updated: i64 = conn
            .query_row(
                "select time_updated from session_input where id='q1'",
                [],
                |r| r.get(0),
            )
            .expect("read updated");
        assert_eq!(updated, 5000, "re-commit does not re-stamp time_updated");
    }

    #[test]
    fn permission_commit_rejects_wrong_entry_session() {
        let conn = db();
        seed_admitted_input(&conn, "q1", "child", r#"{"intent":{}}"#);
        let mut input = base_commit_input();
        input["execution"]["sessionID"] = json!("parent");
        let err = commit_permission_full_access(&conn, &input, 5000).expect_err("mismatch");
        assert_eq!(err, "Permission commit session mismatch");
        // The guard fires BEFORE the transaction: no writes happened.
        assert_eq!(input_payload(&conn, "q1"), r#"{"intent":{}}"#);
        assert!(!entry_exists(&conn, "exec-1"));
    }

    #[test]
    fn permission_commit_rolls_back_when_pending_input_missing() {
        let conn = db();
        // q1 exists and is admitted (will be flipped + written first); q2 is absent → the second
        // iteration throws, and the whole transaction (q1 write + neither entry) rolls back.
        seed_admitted_input(&conn, "q1", "child", r#"{"intent":{"x":1}}"#);
        let mut input = base_commit_input();
        input["queueItemIds"] = json!(["q1", "q2"]);
        let err = commit_permission_full_access(&conn, &input, 5000)
            .expect_err("missing pending input must throw");
        assert_eq!(err, "Pending input unavailable: q2");
        assert_eq!(
            input_payload(&conn, "q1"),
            r#"{"intent":{"x":1}}"#,
            "rolled-back q1 keeps its original payload"
        );
        assert!(
            !entry_exists(&conn, "exec-1"),
            "rolled-back entries not persisted"
        );
        assert!(
            !entry_exists(&conn, "rcpt-1"),
            "rolled-back entries not persisted"
        );
    }
}
