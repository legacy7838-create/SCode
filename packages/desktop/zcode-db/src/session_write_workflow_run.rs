//! Script-workflow run/activity/event WRITE paths (ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-runs.ts`
//! and `.../script-workflow-activities.ts`, with row↔record codecs from
//! `.../script-workflow-codecs.ts`).
//!
//! Six ops: `createScriptWorkflowRun`, `updateScriptWorkflowRun`, `createScriptWorkflowActivity`,
//! `updateScriptWorkflowActivity`, `appendScriptWorkflowEvent`, and the read `findCachedScriptWorkflowActivity`.
//!
//! Transaction decision, per op, taken verbatim from the TS (which uses NO explicit transactions):
//! - `createScriptWorkflowRun` (runs.ts:58-90): one `insert into workflow_run` + one read-back. Single
//!   write statement → no txn.
//! - `updateScriptWorkflowRun` (runs.ts:92-126): one read of the current row + one `update` + read-back.
//!   Only one write statement → no txn.
//! - `createScriptWorkflowActivity` (activities.ts:21-63): a `select coalesce(max(attempt),0)+1` probe,
//!   then ONE `insert` + read-back. The max-probe is a read, not a write, so the write side is still a
//!   single statement → no txn. The `attempt` it mints is deterministic given the prior rows, so the
//!   parity harness seeds activities in the same order on both DBs.
//! - `updateScriptWorkflowActivity` (activities.ts:65-97): read current + one `update` + read-back → no
//!   txn.
//! - `appendScriptWorkflowEvent` (activities.ts:126-166): a `select coalesce(max(sequence),0)+1` probe
//!   scoped to `run_id`, then ONE `insert` + read-back → no txn. NOTE the TS uses `coalesce(max(...), 0)
//!   + 1` (NOT the `-1` queue-tail form the message/part sequence columns use), so the first event gets
//!   `sequence = 1`. Reproduced exactly.
//! - `findCachedScriptWorkflowActivity` (activities.ts:99-114): read-only cache lookup → no txn.
//!
//! Every `time_*` value, the `attempt`/`sequence` (minted deterministically by the max-probe above), and
//! every id are supplied by the caller — the addon NEVER reads the clock. `now` (epoch ms) is injected
//! and used for `time_created`/`time_updated`, matching the TS's single `Date.now()` snapshot.
//!
//! JSON-column encoding matches `encodeJson` (`json.ts:1-3`): an absent OR `null` input value → SQL
//! `NULL` column; any other value → `JSON.stringify`, reproduced by `serde_json::to_string` under the
//! crate's `preserve_order` feature so key order is byte-identical. The update path's "keep the existing
//! column" arm reproduces TS's `encodeJson(decodeJson(col))` = re-parse and re-serialize, so a stored
//! snapshot survives a patch that omits the field.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use super::session_sessions::decode_json_col;

// ---------------------------------------------------------------------------
// Shared JSON helpers (encodeJson / decodeJson from json.ts)
// ---------------------------------------------------------------------------

/// Port of `encodeJson(value)`: `undefined`/`null` → `NULL` column, otherwise `JSON.stringify`. The
/// `input` here is the raw field value (already parsed by serde): an absent field is passed as `None`,
/// a JSON `null` is `Some(Value::Null)`, both map to `NULL`.
fn encode_json(value: Option<&Value>) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::to_string(v)
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

/// Port of `encodeJson(decodeJson(col))`: re-parse a stored JSON column and re-serialize it, so the
/// update path reproduces TS byte-for-byte. A `NULL`/empty column decodes to `undefined` → `NULL`; a
/// stored snapshot round-trips through parse+stringify exactly as `JSON.stringify(JSON.parse(col))`.
fn reencode_json_col(raw: Option<String>) -> Result<Option<String>, String> {
    let parsed = decode_json_col(&raw)?;
    encode_json(parsed.as_ref())
}

/// Read a required top-level string field, erroring rather than writing `undefined` into a NOT NULL
/// column (mirrors TS's direct `input.<field>` access, which a `node:sqlite` NOT NULL would reject).
fn required_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!(".{key} must be a string"))
}

/// Read a required top-level integer field (`call_index` is a JS number; NOT NULL in the schema).
fn required_i64(input: &Value, key: &str) -> Result<i64, String> {
    input
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!(".{key} must be an integer"))
}

/// `?? null` for an optional string column: absent/`null` → `NULL`; otherwise the string.
fn opt_str<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

/// `?? null` for an optional integer column: absent/`null` → `NULL`; otherwise the integer.
fn opt_i64(input: &Value, key: &str) -> Option<i64> {
    input.get(key).and_then(Value::as_i64)
}

// ---------------------------------------------------------------------------
// createScriptWorkflowRun / updateScriptWorkflowRun
// ---------------------------------------------------------------------------

/// Port of `createScriptWorkflowRun` (runs.ts:58-90): one `insert into workflow_run` (kind `'script'`,
/// `current_phase`/`failure_json`/`time_started`/`time_completed` NULL, `budget_spent` 0) then the
/// `decodeRun` read-back. No transaction (single write statement).
///
/// # Arguments
///
/// * `conn` - open read-write connection (FK enforcement on; `parent_session_id` must reference a
///   seeded `session`, `definition_id` is a plain text column with no FK).
/// * `input` - `CreateScriptWorkflowRunInput`: `{id, definitionId?, name, parentSessionId?, cwd,
///   scriptPath?, scriptHash, args?, argsHash?, status?, budgetTotal?, stats?}`.
/// * `now` - injected epoch ms for `time_created` and `time_updated`.
///
/// # Returns
///
/// The read-back `ScriptWorkflowRunRecord` projection (decodeRun key order).
///
/// # Errors
///
/// Returns `Err(String)` for a missing/mis-typed required field, a failed statement, or a missing row
/// after the write (mirrors `Workflow run not found after write`).
pub fn create_script_workflow_run(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> Result<Value, String> {
    let id = required_str(input, "id")?;
    let name = required_str(input, "name")?;
    let cwd = required_str(input, "cwd")?;
    let script_hash = required_str(input, "scriptHash")?;
    let status = opt_str(input, "status").unwrap_or("pending");
    let args_json = encode_json(input.get("args"))?;
    let stats_json = encode_json(input.get("stats"))?;

    conn.execute(
        "insert into workflow_run (
          id, definition_id, name, kind, parent_session_id, cwd, script_path, script_hash,
          args_json, args_hash, status, current_phase, budget_total, budget_spent,
          stats_json, failure_json, time_created, time_started, time_updated, time_completed
        ) values (?1, ?2, ?3, 'script', ?4, ?5, ?6, ?7, ?8, ?9, ?10, null, ?11, 0, ?12, null, ?13, null, ?14, null)",
        params![
            id,
            opt_str(input, "definitionId"),
            name,
            opt_str(input, "parentSessionId"),
            cwd,
            opt_str(input, "scriptPath"),
            script_hash,
            args_json,
            opt_str(input, "argsHash"),
            status,
            opt_i64(input, "budgetTotal"),
            stats_json,
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    must_get_run(conn, id)
}

/// Port of `updateScriptWorkflowRun` (runs.ts:92-126): read the current row (throw if absent), apply the
/// patch, run one `update`, then the `decodeRun` read-back. No transaction (single write statement).
///
/// Patch semantics reproduced exactly:
/// - `status` uses `?? current.status`; `budget_spent` uses `?? current.budget_spent`.
/// - `current_phase`/`time_started`/`time_completed` keep the *current* value only when the input field
///   is absent (`=== undefined`); a present `null` writes `NULL` (so `undefined` is NOT the same as
///   `null` here — an explicitly-present `null` overwrites).
/// - `stats_json`/`failure_json` re-encode the current stored snapshot when absent (TS
///   `encodeJson(current.stats)`), else `encodeJson(input.…)`; re-encoding round-trips parse+stringify.
///
/// # Errors
///
/// Returns `Err(String)` when the row is absent (mirrors `Workflow run not found: <id>`) or a statement
/// fails.
pub fn update_script_workflow_run(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> Result<Value, String> {
    let id = required_str(input, "id")?;

    let current = conn
        .query_row(
            "select status, current_phase, budget_spent, stats_json, failure_json, time_started, time_completed \
             from workflow_run where id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>("status")?,
                    row.get::<_, Option<String>>("current_phase")?,
                    row.get::<_, i64>("budget_spent")?,
                    row.get::<_, Option<String>>("stats_json")?,
                    row.get::<_, Option<String>>("failure_json")?,
                    row.get::<_, Option<i64>>("time_started")?,
                    row.get::<_, Option<i64>>("time_completed")?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Workflow run not found: {id}"))?;
    let (
        cur_status,
        cur_phase,
        cur_budget_spent,
        cur_stats,
        cur_failure,
        cur_started,
        cur_completed,
    ) = current;

    // status = input.status ?? current.status
    let status = opt_str(input, "status").unwrap_or(cur_status.as_str());

    // current_phase = input.currentPhase === undefined ? (current.currentPhase ?? null) : input.currentPhase
    let current_phase = match input.get("currentPhase") {
        None => cur_phase,
        Some(v) => json_to_opt_string(v),
    };
    // budget_spent = input.budgetSpent ?? current.budgetSpent
    let budget_spent = opt_i64(input, "budgetSpent").unwrap_or(cur_budget_spent);

    // stats_json = input.stats === undefined ? encodeJson(current.stats) : encodeJson(input.stats)
    let stats_json = match input.get("stats") {
        None => reencode_json_col(cur_stats)?,
        Some(v) => encode_json(Some(v))?,
    };
    let failure_json = match input.get("failure") {
        None => reencode_json_col(cur_failure)?,
        Some(v) => encode_json(Some(v))?,
    };

    let time_started = match input.get("startedAt") {
        None => cur_started,
        Some(v) => json_to_opt_i64(v),
    };
    let time_completed = match input.get("completedAt") {
        None => cur_completed,
        Some(v) => json_to_opt_i64(v),
    };

    conn.execute(
        "update workflow_run set
          status = ?1,
          current_phase = ?2,
          budget_spent = ?3,
          stats_json = ?4,
          failure_json = ?5,
          time_started = ?6,
          time_updated = ?7,
          time_completed = ?8
        where id = ?9",
        params![
            status,
            current_phase,
            budget_spent,
            stats_json,
            failure_json,
            time_started,
            now,
            time_completed,
            id,
        ],
    )
    .map_err(|e| e.to_string())?;

    must_get_run(conn, id)
}

/// Read a `workflow_run` row by id and return the decodeRun projection; throw the TS "not found after
/// write" message when absent. Reuses the existing read module's `get_script_workflow_run` so the
/// projection is byte-identical to the read path.
fn must_get_run(conn: &Connection, id: &str) -> Result<Value, String> {
    let run = crate::session_workflow::get_script_workflow_run(conn, id)?;
    if run.is_null() {
        return Err(format!("Workflow run not found after write: {id}"));
    }
    Ok(run)
}

/// `?? null` semantics for a JSON value into an optional string: `null`/absent → `None`, a string →
/// `Some`, any other scalar → stringified form is not expected for these typed columns.
fn json_to_opt_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        _ => value.as_str().map(str::to_string),
    }
}

/// `?? null` semantics for a JSON value into an optional integer: `null`/absent → `None`, a number →
/// `Some(i64)`.
fn json_to_opt_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Null => None,
        _ => value.as_i64(),
    }
}

// ---------------------------------------------------------------------------
// createScriptWorkflowActivity / updateScriptWorkflowActivity / findCached
// ---------------------------------------------------------------------------

/// Port of `createScriptWorkflowActivity` (activities.ts:21-63): mint `attempt = coalesce(max,0)+1`
/// scoped to `(run_id, call_path)`, then one `insert` (child_session_id/result_json/error_json/time_started/
/// time_completed NULL) and the `decodeActivity` read-back. No transaction (single write statement; the
/// max-probe is a read).
///
/// # Arguments
///
/// * `conn` - open read-write connection. `run_id` must reference a seeded `workflow_run`.
/// * `input` - `CreateScriptWorkflowActivityInput`: `{id, runId, parentActivityId?, callIndex, callPath,
///   type, phase?, label?, inputHash, prompt?, opts?, status?}`.
/// * `now` - injected epoch ms for `time_created` and `time_updated`.
///
/// # Errors
///
/// Returns `Err(String)` for a missing/mis-typed required field or a failed statement.
pub fn create_script_workflow_activity(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> Result<Value, String> {
    let id = required_str(input, "id")?;
    let run_id = required_str(input, "runId")?;
    let call_index = required_i64(input, "callIndex")?;
    let call_path = required_str(input, "callPath")?;
    let atype = required_str(input, "type")?;
    let input_hash = required_str(input, "inputHash")?;
    let status = opt_str(input, "status").unwrap_or("queued");
    let opts_json = encode_json(input.get("opts"))?;

    let attempt: i64 = conn
        .query_row(
            "select coalesce(max(attempt), 0) + 1 as next_attempt \
             from workflow_activity where run_id = ?1 and call_path = ?2",
            params![run_id, call_path],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(1);

    conn.execute(
        "insert into workflow_activity (
          id, run_id, parent_activity_id, call_index, call_path, attempt, type, phase,
          label, input_hash, prompt, opts_json, status, child_session_id, result_json,
          error_json, time_created, time_started, time_updated, time_completed
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, null, null, null, ?14, null, ?15, null)",
        params![
            id,
            run_id,
            opt_str(input, "parentActivityId"),
            call_index,
            call_path,
            attempt,
            atype,
            opt_str(input, "phase"),
            opt_str(input, "label"),
            input_hash,
            opt_str(input, "prompt"),
            opts_json,
            status,
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    must_get_activity(conn, id)
}

/// Port of `updateScriptWorkflowActivity` (activities.ts:65-97): read the current row (throw if absent),
/// apply the patch, run one `update`, then the `decodeActivity` read-back. No transaction.
///
/// Patch semantics mirror `updateScriptWorkflowRun`: `status` uses `??`; `child_session_id` /
/// `time_started` / `time_completed` keep the current value only when the input field is absent;
/// `result_json` / `error_json` re-encode the current snapshot when absent.
///
/// # Errors
///
/// Returns `Err(String)` when the row is absent (mirrors `Workflow activity not found: <id>`) or a
/// statement fails.
pub fn update_script_workflow_activity(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> Result<Value, String> {
    let id = required_str(input, "id")?;

    let current = conn
        .query_row(
            "select status, child_session_id, result_json, error_json, time_started, time_completed \
             from workflow_activity where id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>("status")?,
                    row.get::<_, Option<String>>("child_session_id")?,
                    row.get::<_, Option<String>>("result_json")?,
                    row.get::<_, Option<String>>("error_json")?,
                    row.get::<_, Option<i64>>("time_started")?,
                    row.get::<_, Option<i64>>("time_completed")?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Workflow activity not found: {id}"))?;
    let (cur_status, cur_child, cur_result, cur_error, cur_started, cur_completed) = current;

    let status = opt_str(input, "status").unwrap_or(cur_status.as_str());
    let child_session_id = match input.get("childSessionId") {
        None => cur_child,
        Some(v) => json_to_opt_string(v),
    };
    let result_json = match input.get("result") {
        None => reencode_json_col(cur_result)?,
        Some(v) => encode_json(Some(v))?,
    };
    let error_json = match input.get("error") {
        None => reencode_json_col(cur_error)?,
        Some(v) => encode_json(Some(v))?,
    };
    let time_started = match input.get("startedAt") {
        None => cur_started,
        Some(v) => json_to_opt_i64(v),
    };
    let time_completed = match input.get("completedAt") {
        None => cur_completed,
        Some(v) => json_to_opt_i64(v),
    };

    conn.execute(
        "update workflow_activity set
          status = ?1,
          child_session_id = ?2,
          result_json = ?3,
          error_json = ?4,
          time_started = ?5,
          time_updated = ?6,
          time_completed = ?7
        where id = ?8",
        params![
            status,
            child_session_id,
            result_json,
            error_json,
            time_started,
            now,
            time_completed,
            id,
        ],
    )
    .map_err(|e| e.to_string())?;

    must_get_activity(conn, id)
}

/// Port of `findCachedScriptWorkflowActivity` (activities.ts:99-114): the highest-`attempt` completed
/// or cached activity matching `(run_id, call_path, input_hash)`, or `null`. Read-only, no transaction.
pub fn find_cached_script_workflow_activity(
    conn: &Connection,
    input: &Value,
) -> Result<Value, String> {
    let run_id = required_str(input, "runId")?;
    let call_path = required_str(input, "callPath")?;
    let input_hash = required_str(input, "inputHash")?;
    let row = conn
        .query_row(
            "select * from workflow_activity
             where run_id = ?1 and call_path = ?2 and input_hash = ?3 and status in ('completed', 'cached')
             order by attempt desc
             limit 1",
            params![run_id, call_path, input_hash],
            read_activity_raw,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Ok(Value::Null),
        Some(r) => r.into_value(),
    }
}

// ---------------------------------------------------------------------------
// appendScriptWorkflowEvent
// ---------------------------------------------------------------------------

/// Port of `appendScriptWorkflowEvent` (activities.ts:126-166): mint `sequence = coalesce(max,0)+1`
/// scoped to `run_id` (NOTE: `+1` from `0`, NOT the `-1` message-queue form, so the first event is
/// sequence 1), then one `insert` and the `decodeEvent` read-back by `(run_id, sequence)`. No
/// transaction.
///
/// # Arguments
///
/// * `conn` - open read-write connection. `run_id` must reference a seeded `workflow_run`; a present
///   `activityId` must reference a seeded `workflow_activity`.
/// * `input` - `{id, runId, type, phase?, activityId?, payload?}`.
/// * `now` - injected epoch ms for `time_created`.
///
/// # Errors
///
/// Returns `Err(String)` for a missing/mis-typed required field, a failed statement, or a missing row
/// after the write.
pub fn append_script_workflow_event(
    conn: &Connection,
    input: &Value,
    now: i64,
) -> Result<Value, String> {
    let id = required_str(input, "id")?;
    let run_id = required_str(input, "runId")?;
    let etype = required_str(input, "type")?;
    let payload_json = encode_json(input.get("payload"))?;

    let sequence: i64 = conn
        .query_row(
            "select coalesce(max(sequence), 0) + 1 as next_sequence \
             from workflow_event where run_id = ?1",
            [run_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(1);

    conn.execute(
        "insert into workflow_event (
          id, run_id, sequence, type, phase, activity_id, payload_json, time_created
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            run_id,
            sequence,
            etype,
            opt_str(input, "phase"),
            opt_str(input, "activityId"),
            payload_json,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    must_get_event(conn, run_id, sequence)
}

// ---------------------------------------------------------------------------
// Read-back projections (private decoders mirroring script-workflow-codecs.ts)
// ---------------------------------------------------------------------------

/// Owned raw workflow-activity row; mirrors the read module's `ActivityRaw`.
struct ActivityRaw {
    id: String,
    run_id: String,
    call_index: i64,
    attempt: i64,
    call_path: String,
    atype: String,
    status: String,
    input_hash: String,
    time_created: i64,
    time_updated: i64,
    child_session_id: Option<String>,
    parent_activity_id: Option<String>,
    phase: Option<String>,
    label: Option<String>,
    prompt: Option<String>,
    opts_json: Option<String>,
    result_json: Option<String>,
    error_json: Option<String>,
    time_started: Option<i64>,
    time_completed: Option<i64>,
}

fn read_activity_raw(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActivityRaw> {
    Ok(ActivityRaw {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        call_index: row.get("call_index")?,
        attempt: row.get("attempt")?,
        call_path: row.get("call_path")?,
        atype: row.get("type")?,
        status: row.get("status")?,
        input_hash: row.get("input_hash")?,
        time_created: row.get("time_created")?,
        time_updated: row.get("time_updated")?,
        child_session_id: row.get("child_session_id")?,
        parent_activity_id: row.get("parent_activity_id")?,
        phase: row.get("phase")?,
        label: row.get("label")?,
        prompt: row.get("prompt")?,
        opts_json: row.get("opts_json")?,
        result_json: row.get("result_json")?,
        error_json: row.get("error_json")?,
        time_started: row.get("time_started")?,
        time_completed: row.get("time_completed")?,
    })
}

impl ActivityRaw {
    /// decodeActivity key order (codecs.ts:146-169), matching the read module's `ActivityRaw::into_value`.
    fn into_value(self) -> Result<Value, String> {
        let mut m = Map::new();
        m.insert("attempt".into(), Value::from(self.attempt));
        m.insert("callIndex".into(), Value::from(self.call_index));
        m.insert("callPath".into(), Value::String(self.call_path));
        opt_str_into(&mut m, "childSessionId", self.child_session_id);
        opt_i64_into(&mut m, "completedAt", self.time_completed);
        m.insert("createdAt".into(), Value::from(self.time_created));
        json_col_into(&mut m, "error", &self.error_json)?;
        m.insert("id".into(), Value::String(self.id));
        m.insert("inputHash".into(), Value::String(self.input_hash));
        opt_str_into(&mut m, "label", self.label);
        json_col_into(&mut m, "opts", &self.opts_json)?;
        opt_str_into(&mut m, "parentActivityId", self.parent_activity_id);
        opt_str_into(&mut m, "phase", self.phase);
        opt_str_into(&mut m, "prompt", self.prompt);
        json_col_into(&mut m, "result", &self.result_json)?;
        m.insert("runId".into(), Value::String(self.run_id));
        opt_i64_into(&mut m, "startedAt", self.time_started);
        m.insert("status".into(), Value::String(self.status));
        m.insert("type".into(), Value::String(self.atype));
        m.insert("updatedAt".into(), Value::from(self.time_updated));
        Ok(Value::Object(m))
    }
}

/// Owned raw workflow-event row; mirrors the read module's `EventRaw`.
struct EventRaw {
    id: String,
    run_id: String,
    sequence: i64,
    etype: String,
    time_created: i64,
    activity_id: Option<String>,
    phase: Option<String>,
    payload_json: Option<String>,
}

fn read_event_raw(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRaw> {
    Ok(EventRaw {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        sequence: row.get("sequence")?,
        etype: row.get("type")?,
        time_created: row.get("time_created")?,
        activity_id: row.get("activity_id")?,
        phase: row.get("phase")?,
        payload_json: row.get("payload_json")?,
    })
}

impl EventRaw {
    /// decodeEvent key order (codecs.ts:171-182), matching the read module's `EventRaw::into_value`.
    fn into_value(self) -> Result<Value, String> {
        let mut m = Map::new();
        opt_str_into(&mut m, "activityId", self.activity_id);
        m.insert("createdAt".into(), Value::from(self.time_created));
        m.insert("id".into(), Value::String(self.id));
        json_col_into(&mut m, "payload", &self.payload_json)?;
        opt_str_into(&mut m, "phase", self.phase);
        m.insert("runId".into(), Value::String(self.run_id));
        m.insert("sequence".into(), Value::from(self.sequence));
        m.insert("type".into(), Value::String(self.etype));
        Ok(Value::Object(m))
    }
}

fn opt_str_into(m: &mut Map<String, Value>, key: &str, raw: Option<String>) {
    if let Some(v) = raw {
        m.insert(key.to_string(), Value::String(v));
    }
}

fn opt_i64_into(m: &mut Map<String, Value>, key: &str, raw: Option<i64>) {
    if let Some(v) = raw {
        m.insert(key.to_string(), Value::from(v));
    }
}

fn json_col_into(
    m: &mut Map<String, Value>,
    key: &str,
    raw: &Option<String>,
) -> Result<(), String> {
    if let Some(v) = decode_json_col(raw)? {
        m.insert(key.to_string(), v);
    }
    Ok(())
}

/// Read a `workflow_activity` row by id and return the decodeActivity projection; throw the TS
/// "not found after write" message when absent.
fn must_get_activity(conn: &Connection, id: &str) -> Result<Value, String> {
    let row = conn
        .query_row(
            "select * from workflow_activity where id = ?1",
            [id],
            read_activity_raw,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Workflow activity not found after write: {id}"))?;
    row.into_value()
}

/// Read a `workflow_event` row by `(run_id, sequence)` and return the decodeEvent projection; throw the
/// TS "not found after write" message when absent.
fn must_get_event(conn: &Connection, run_id: &str, sequence: i64) -> Result<Value, String> {
    let row = conn
        .query_row(
            "select * from workflow_event where run_id = ?1 and sequence = ?2",
            params![run_id, sequence],
            read_event_raw,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Workflow event not found after write: {run_id}:{sequence}"))?;
    row.into_value()
}

// ---------------------------------------------------------------------------
// N-API boundaries
// ---------------------------------------------------------------------------

/// N-API: `createScriptWorkflowRun` write boundary. `run_json` is the serialized
/// `CreateScriptWorkflowRunInput`; `now` is the injected epoch ms. Returns the read-back projection.
#[napi]
pub fn create_script_workflow_run_json(
    db_path: String,
    run_json: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&run_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let value =
        create_script_workflow_run(&conn, &input, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `updateScriptWorkflowRun` write boundary. `run_json` is the serialized
/// `UpdateScriptWorkflowRunInput`; `now` is the injected epoch ms for `time_updated`.
#[napi]
pub fn update_script_workflow_run_json(
    db_path: String,
    run_json: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&run_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let value =
        update_script_workflow_run(&conn, &input, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `createScriptWorkflowActivity` write boundary. `activity_json` is the serialized
/// `CreateScriptWorkflowActivityInput`; `now` is the injected epoch ms.
#[napi]
pub fn create_script_workflow_activity_json(
    db_path: String,
    activity_json: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&activity_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let value =
        create_script_workflow_activity(&conn, &input, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `updateScriptWorkflowActivity` write boundary. `activity_json` is the serialized
/// `UpdateScriptWorkflowActivityInput`; `now` is the injected epoch ms for `time_updated`.
#[napi]
pub fn update_script_workflow_activity_json(
    db_path: String,
    activity_json: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&activity_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let value =
        update_script_workflow_activity(&conn, &input, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `appendScriptWorkflowEvent` write boundary. `event_json` is the serialized event input
/// `{id, runId, type, phase?, activityId?, payload?}`; `now` is the injected epoch ms.
#[napi]
pub fn append_script_workflow_event_json(
    db_path: String,
    event_json: String,
    now: f64,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&event_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let value =
        append_script_workflow_event(&conn, &input, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `findCachedScriptWorkflowActivity` read boundary. `filter_json` is `{runId, callPath,
/// inputHash}`. Returns `"null"` when there is no cached match.
#[napi]
pub fn find_cached_script_workflow_activity_json(
    db_path: String,
    filter_json: String,
) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&filter_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    let value = find_cached_script_workflow_activity(&conn, &input).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// In-memory DB with the session schema (FK parents) applied via the bootstrap migrations, plus a
    /// seeded session and a parent run where needed. FK enforcement ON so the workflow FK/CHECK
    /// constraints mirror `node:sqlite`.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute("PRAGMA foreign_keys = ON", [])
            .expect("invariant: enable fk");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 1_000)
            .expect("invariant: apply session schema");
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
             values ('s1','p','slug','/d','t','v',100,100)",
            [],
        )
        .expect("invariant: seed session");
        conn
    }

    fn seed_run(conn: &Connection, id: &str) {
        create_script_workflow_run(
            conn,
            &json!({ "id": id, "name": "n", "cwd": "/c", "scriptHash": "h" }),
            1000,
        )
        .expect("seed run");
    }

    #[test]
    fn create_run_full_column_encode_and_defaults() {
        let conn = db();
        let out = create_script_workflow_run(
            &conn,
            &json!({
                "id": "r1", "definitionId": "d1", "name": "build", "parentSessionId": "s1",
                "cwd": "/work", "scriptPath": "/b.ts", "scriptHash": "hash",
                "args": { "a": 1 }, "argsHash": "ah", "status": "running",
                "budgetTotal": 50, "stats": { "calls": 3 }
            }),
            2000,
        )
        .expect("create run");
        assert_eq!(out["kind"], json!("script"), "kind hardcoded to script");
        assert_eq!(out["status"], json!("running"));
        assert_eq!(out["budgetSpent"], json!(0), "budget_spent defaults to 0");
        assert_eq!(out["budgetTotal"], json!(50));
        assert_eq!(out["args"], json!({ "a": 1 }), "args_json round-trips");
        assert_eq!(out["stats"], json!({ "calls": 3 }));
        assert_eq!(out["createdAt"], json!(2000));
        assert_eq!(out["updatedAt"], json!(2000));
        assert!(
            out.get("currentPhase").is_none(),
            "current_phase NULL on create"
        );
        assert!(out.get("failure").is_none(), "failure_json NULL on create");
        assert!(
            out.get("startedAt").is_none(),
            "time_started NULL on create"
        );
        // Absent optional fields are omitted in the projection.
        let minimal = create_script_workflow_run(
            &conn,
            &json!({ "id": "r2", "name": "n", "cwd": "/c", "scriptHash": "h" }),
            1000,
        )
        .expect("minimal create");
        assert_eq!(
            minimal["status"],
            json!("pending"),
            "status defaults to pending"
        );
        assert!(
            minimal.get("args").is_none(),
            "absent args -> NULL -> omitted"
        );
        assert!(
            minimal.get("budgetTotal").is_none(),
            "absent budgetTotal -> NULL"
        );
    }

    #[test]
    fn update_run_partial_patch_semantics() {
        let conn = db();
        create_script_workflow_run(
            &conn,
            &json!({
                "id": "r1", "name": "n", "cwd": "/c", "scriptHash": "h",
                "status": "pending", "stats": { "x": 1 }
            }),
            1000,
        )
        .expect("create");
        assert!(
            create_script_workflow_run(
                &conn,
                &json!({ "id": "r0", "name": "n", "cwd": "/c", "scriptHash": "h", "currentPhase": "ignored" }),
                1000
            )
            .expect("create ignores currentPhase")
                .get("currentPhase")
                .is_none(),
            "create hardcodes current_phase NULL, never reads the input field"
        );
        // Seed a current_phase via a prior update, and give the run a failure snapshot.
        update_script_workflow_run(
            &conn,
            &json!({ "id": "r1", "currentPhase": "phase-a", "failure": { "code": 1 } }),
            1500,
        )
        .expect("seed phase+failure");
        // Patch only status: stats, currentPhase and failure keep the existing snapshot.
        let after =
            update_script_workflow_run(&conn, &json!({ "id": "r1", "status": "running" }), 2000)
                .expect("update");
        assert_eq!(after["status"], json!("running"));
        assert_eq!(
            after["stats"],
            json!({ "x": 1 }),
            "absent stats re-encode current snapshot"
        );
        assert_eq!(
            after["currentPhase"],
            json!("phase-a"),
            "absent currentPhase preserved"
        );
        assert_eq!(
            after["failure"],
            json!({ "code": 1 }),
            "absent failure re-encodes current snapshot"
        );
        assert_eq!(
            after["updatedAt"],
            json!(2000),
            "time_updated = injected now"
        );
        // An explicitly-present null overwrites (undefined !== null).
        let cleared =
            update_script_workflow_run(&conn, &json!({ "id": "r1", "currentPhase": null }), 3000)
                .expect("update clear phase");
        assert!(
            cleared.get("currentPhase").is_none(),
            "explicit null currentPhase -> NULL"
        );
        // New stats replace the snapshot; failure written.
        let patched = update_script_workflow_run(
            &conn,
            &json!({ "id": "r1", "stats": { "y": 2 }, "failure": { "msg": "boom" } }),
            4000,
        )
        .expect("update patch json");
        assert_eq!(patched["stats"], json!({ "y": 2 }));
        assert_eq!(patched["failure"], json!({ "msg": "boom" }));
    }

    #[test]
    fn update_run_missing_row_throws() {
        let conn = db();
        let err = update_script_workflow_run(&conn, &json!({ "id": "ghost" }), 1000)
            .expect_err("missing run must throw");
        assert_eq!(err, "Workflow run not found: ghost");
    }

    #[test]
    fn create_activity_mints_attempt_per_run_path() {
        let conn = db();
        seed_run(&conn, "r1");
        let a1 = create_script_workflow_activity(
            &conn,
            &json!({
                "id": "a1", "runId": "r1", "callIndex": 0, "callPath": "wf.step",
                "type": "agent", "inputHash": "h1", "opts": { "temp": 0.2 }
            }),
            1500,
        )
        .expect("first activity");
        assert_eq!(a1["attempt"], json!(1), "first attempt is 1");
        assert_eq!(a1["status"], json!("queued"), "status defaults to queued");
        assert_eq!(a1["opts"], json!({ "temp": 0.2 }));
        assert!(
            a1.get("childSessionId").is_none(),
            "child_session_id NULL on create"
        );
        // Same (run, call_path) -> attempt increments; different path resets to 1.
        let a2 = create_script_workflow_activity(
            &conn,
            &json!({
                "id": "a2", "runId": "r1", "callIndex": 1, "callPath": "wf.step",
                "type": "agent", "inputHash": "h1"
            }),
            1500,
        )
        .expect("second activity same path");
        assert_eq!(a2["attempt"], json!(2), "same run+path bumps attempt");
        let a3 = create_script_workflow_activity(
            &conn,
            &json!({
                "id": "a3", "runId": "r1", "callIndex": 0, "callPath": "wf.other",
                "type": "agent", "inputHash": "h9"
            }),
            1500,
        )
        .expect("third activity other path");
        assert_eq!(
            a3["attempt"],
            json!(1),
            "different path resets attempt to 1"
        );
    }

    #[test]
    fn update_activity_status_and_json_encode() {
        let conn = db();
        seed_run(&conn, "r1");
        create_script_workflow_activity(
            &conn,
            &json!({
                "id": "a1", "runId": "r1", "callIndex": 0, "callPath": "c",
                "type": "agent", "inputHash": "h1", "result": { "keep": true }
            }),
            1500,
        )
        .expect("create");
        // result was NULL on create (create hardcodes result_json NULL) — re-encode keeps NULL.
        let running = update_script_workflow_activity(
            &conn,
            &json!({ "id": "a1", "status": "running", "startedAt": 1600 }),
            1700,
        )
        .expect("update running");
        assert_eq!(running["status"], json!("running"));
        assert_eq!(running["startedAt"], json!(1600));
        assert!(
            running.get("result").is_none(),
            "create forces result NULL; re-encode stays NULL"
        );
        // completed with result/error + completedAt
        let done = update_script_workflow_activity(
            &conn,
            &json!({
                "id": "a1", "status": "completed", "childSessionId": "s1",
                "result": { "value": 42 }, "error": { "code": 5 }, "completedAt": 1800
            }),
            1800,
        )
        .expect("update completed");
        assert_eq!(done["status"], json!("completed"));
        assert_eq!(done["childSessionId"], json!("s1"));
        assert_eq!(done["result"], json!({ "value": 42 }));
        assert_eq!(done["error"], json!({ "code": 5 }));
        assert_eq!(done["completedAt"], json!(1800));
    }

    #[test]
    fn find_cached_hit_vs_miss() {
        let conn = db();
        seed_run(&conn, "r1");
        create_script_workflow_activity(
            &conn,
            &json!({
                "id": "a1", "runId": "r1", "callIndex": 0, "callPath": "c",
                "type": "agent", "inputHash": "h1"
            }),
            1500,
        )
        .expect("create");
        // Miss while status is 'queued'.
        let miss = find_cached_script_workflow_activity(
            &conn,
            &json!({ "runId": "r1", "callPath": "c", "inputHash": "h1" }),
        )
        .expect("query");
        assert!(miss.is_null(), "queued activity is not a cache hit");
        // Complete it -> hit.
        update_script_workflow_activity(&conn, &json!({ "id": "a1", "status": "completed" }), 1600)
            .expect("complete");
        let hit = find_cached_script_workflow_activity(
            &conn,
            &json!({ "runId": "r1", "callPath": "c", "inputHash": "h1" }),
        )
        .expect("query hit");
        assert_eq!(hit["id"], json!("a1"), "completed activity is returned");
        assert_eq!(hit["attempt"], json!(1));
        // Different inputHash -> miss.
        let other = find_cached_script_workflow_activity(
            &conn,
            &json!({ "runId": "r1", "callPath": "c", "inputHash": "zzz" }),
        )
        .expect("query other");
        assert!(other.is_null());
    }

    #[test]
    fn append_event_sequence_max_plus_one() {
        let conn = db();
        seed_run(&conn, "r1");
        create_script_workflow_activity(
            &conn,
            &json!({
                "id": "a1", "runId": "r1", "callIndex": 0, "callPath": "c",
                "type": "agent", "inputHash": "h1"
            }),
            1500,
        )
        .expect("create activity");
        // First event -> sequence 1 (coalesce(max,0)+1, NOT the -1 queue form).
        let e1 = append_script_workflow_event(
            &conn,
            &json!({ "id": "e1", "runId": "r1", "type": "log", "payload": { "m": "hi" } }),
            1600,
        )
        .expect("first event");
        assert_eq!(e1["sequence"], json!(1));
        assert_eq!(e1["payload"], json!({ "m": "hi" }));
        assert!(e1.get("activityId").is_none(), "absent activityId -> NULL");
        // Second -> sequence 2, with a FK-valid activityId and a phase.
        let e2 = append_script_workflow_event(
            &conn,
            &json!({ "id": "e2", "runId": "r1", "type": "step", "activityId": "a1", "phase": "p" }),
            1601,
        )
        .expect("second event");
        assert_eq!(e2["sequence"], json!(2));
        assert_eq!(e2["activityId"], json!("a1"));
        assert_eq!(e2["phase"], json!("p"));
        assert!(
            e2.get("payload").is_none(),
            "absent payload -> NULL -> omitted"
        );
        // A different run restarts the sequence at 1.
        seed_run(&conn, "r2");
        let e3 = append_script_workflow_event(
            &conn,
            &json!({ "id": "e3", "runId": "r2", "type": "log" }),
            1602,
        )
        .expect("other run event");
        assert_eq!(e3["sequence"], json!(1), "sequence scoped per run");
    }
}
