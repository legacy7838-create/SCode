//! DWF (dynamic-workflow) journal store: the MUTATING ops of `JournalStorePort`
//! (`createRun`, `updateRunStatus`, `updateRunUsage`, `updateRunCaps`, `putActor`, `putNode`,
//! `appendEvent`) plus the shared row↔record codecs (`decodeRun`/`decodeActor`/`decodeNode`/
//! `decodeEvent` and the `encode*` helpers) that `session_journal_read` reuses.
//!
//! Ported verbatim from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/dwf-journal.ts`
//! (methods), `.../dwf-journal-codecs.ts` (codecs) and the `encodeJson`/`decodeJson` helpers in
//! `../json.ts`. The `dwf_*` schema is already frozen in `session_migrations.rs`
//! (`0019_dwf_journal`); `bootstrapSessionStoreJson` creates it.
//!
//! Transaction decisions, per op, taken verbatim from the TS (which uses NO explicit `begin`/`commit`
//! for any journal method — each is a single statement, or a statement pair where one is a read):
//! - `createRun`: one `insert` (+ the `getRun` read-back only on the duplicate-PK error path) → no txn.
//! - `updateRunStatus` / `updateRunUsage` / `updateRunCaps`: one `update` → no txn.
//! - `putActor` / `putNode`: one `insert ... on conflict do update` (upsert) → no txn.
//! - `appendEvent`: one `insert ... returning sequence` (sequence minted in-statement, NOT a separate
//!   read) → no txn.
//!
//! `now` (epoch ms) is injected on every call; the addon NEVER reads the clock. JSON columns are
//! re-serialized with `serde_json` under the crate's `preserve_order` feature so key order is
//! byte-identical to `JSON.stringify`. `undefined`-vs-`null` (the `??` / `=== undefined` split), the
//! `encodeJson` (undefined OR null → SQL NULL) vs `encodeResultJson` (only undefined → SQL NULL;
//! `null` round-trips to the string `"null"`) distinction, and the "absent column → absent key"
//! decode rule are reproduced exactly. Verified by `harness/session_journal_parity`.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{Map, Value};

use super::session_sessions::decode_json_col;

// ---------------------------------------------------------------------------
// Shared JSON helpers (encodeJson / decodeJson from json.ts) — pub(crate) so the
// read module (`session_journal_read`) reuses the exact same codecs.
// ---------------------------------------------------------------------------

/// Port of `encodeJson(value)`: `undefined`/`null` → SQL `NULL`, otherwise `JSON.stringify`. A field
/// the caller omitted arrives as `None`; an explicit JSON `null` arrives as `Some(Value::Null)` —
/// both map to `NULL`, matching the TS which checks `value === undefined || value === null`.
pub(crate) fn encode_json(value: Option<&Value>) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::to_string(v)
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

/// Port of `encodeResultJson(value)` (codecs.ts): ONLY `undefined` maps to SQL `NULL`; a `null` value
/// serializes to the string `"null"` so a legitimate `result: null` round-trips as `null`, not as
/// "no result". `None` (absent field) → `NULL`.
pub(crate) fn encode_result_json(value: Option<&Value>) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(v) => serde_json::to_string(v)
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

/// `?? null` for an optional string field: absent or `null` → `None`; a string → `Some`.
fn opt_str<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

/// Required integer field (`caps.maxConcurrency`, `spentTokens` are NOT NULL columns).
fn req_i64(input: &Value, key: &str) -> Result<i64, String> {
    input
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!(".{key} must be an integer"))
}

// ---------------------------------------------------------------------------
// Run settlement encode/decode (codecs.ts)
// ---------------------------------------------------------------------------

/// Physical `dwf_run.status` CHECK vocabulary (migration 0019); the logical `RunStatus`
/// (`errored`/`stopped`) maps to it only through these codecs. `pending`/`running` map through
/// unchanged and need no constant.
const PHYSICAL_COMPLETED: &str = "completed";
const PHYSICAL_FAILED: &str = "failed";
const PHYSICAL_CANCELLED: &str = "cancelled";

/// The `Interrupted` failure code that turns a physical `failed` row into a logical
/// `stopped(interrupted)` on decode (the legacy orphan-convergence rows).
const INTERRUPTED_CODE: &str = "Interrupted";

/// Envelope-sniffing whitelist for `cancelled` rows: a `stopReason` outside this set means the
/// `failure_json` is NOT a stopped envelope and the row degrades to `stopped(user)`.
fn is_stop_reason(value: &str) -> bool {
    matches!(
        value,
        "user" | "model" | "provider" | "interrupted" | "superseded"
    )
}

/// Port of `encodeRunSettlement`: logical status + settlement bag → `{ status: physical,
/// failure_json: Option<String> }`. `settlement` is the whole record for `createRun` (it carries
/// `stopReason`/`supersededBy`/`failure`) and the `RunSettlementRecord` for terminal
/// `updateRunStatus`; a non-terminal `createRun`/`updateRunStatus` path never reaches here for
/// pending/running (which just map through).
///
/// The stopped envelope is built in `JSON.stringify` key order: `stopReason`, then `supersededBy`
/// (only when present), then `error` (only when a `failure` is present).
pub(crate) fn encode_run_settlement(
    status: &str,
    settlement: Option<&Value>,
) -> Result<(String, Option<String>), String> {
    match status {
        "stopped" => {
            let mut envelope = Map::new();
            // stopReason ?? "user": absent OR null ⇒ "user".
            let reason = settlement
                .and_then(|s| s.get("stopReason"))
                .and_then(Value::as_str)
                .unwrap_or("user");
            envelope.insert("stopReason".into(), Value::String(reason.to_string()));
            if let Some(s) = settlement {
                if let Some(v) = s.get("supersededBy") {
                    if !v.is_null() {
                        envelope.insert("supersededBy".into(), v.clone());
                    }
                }
                if let Some(f) = s.get("failure") {
                    if !f.is_null() {
                        envelope.insert("error".into(), f.clone());
                    }
                }
            }
            Ok((
                PHYSICAL_CANCELLED.to_string(),
                Some(serde_json::to_string(&Value::Object(envelope)).map_err(|e| e.to_string())?),
            ))
        }
        "errored" => Ok((
            PHYSICAL_FAILED.to_string(),
            encode_json(settlement.and_then(|s| s.get("failure")))?,
        )),
        "completed" => Ok((
            PHYSICAL_COMPLETED.to_string(),
            encode_json(settlement.and_then(|s| s.get("failure")))?,
        )),
        // pending / running: physical = logical, no failure.
        other => Ok((other.to_string(), None)),
    }
}

/// Decoded logical settlement triple, mirroring `DwfRunSettlementFields`.
pub(crate) struct DecodedSettlement {
    pub status: String,
    pub stop_reason: Option<String>,
    pub superseded_by: Option<String>,
    pub failure: Option<Value>,
}

/// Port of `decodeRunSettlement`: physical `status` + `failure_json` → logical triple. The single
/// read-side entry point shared by full records and enum rows.
pub(crate) fn decode_run_settlement(
    status: &str,
    failure_json: &Option<String>,
) -> Result<DecodedSettlement, String> {
    let raw: Option<Value> = decode_json_col(failure_json)?;
    match status {
        PHYSICAL_CANCELLED => {
            // Default: stopped(user). Only a well-formed stopped envelope overrides.
            let mut out = DecodedSettlement {
                status: "stopped".to_string(),
                stop_reason: Some("user".to_string()),
                superseded_by: None,
                failure: None,
            };
            if let Some(Value::Object(obj)) = raw.as_ref() {
                let reason = obj.get("stopReason").and_then(Value::as_str);
                if let Some(r) = reason {
                    if is_stop_reason(r) {
                        out.stop_reason = Some(r.to_string());
                        if let Some(sb) = obj.get("supersededBy").and_then(Value::as_str) {
                            if !sb.is_empty() {
                                out.superseded_by = Some(sb.to_string());
                            }
                        }
                        if let Some(err) = obj.get("error") {
                            if !err.is_null() {
                                out.failure = Some(err.clone());
                            }
                        }
                    }
                }
            }
            Ok(out)
        }
        PHYSICAL_FAILED => {
            let is_interrupted = raw
                .as_ref()
                .and_then(|v| v.get("code"))
                .and_then(Value::as_str)
                == Some(INTERRUPTED_CODE);
            if is_interrupted {
                Ok(DecodedSettlement {
                    status: "stopped".to_string(),
                    stop_reason: Some("interrupted".to_string()),
                    superseded_by: None,
                    failure: raw,
                })
            } else {
                Ok(DecodedSettlement {
                    status: "errored".to_string(),
                    stop_reason: None,
                    superseded_by: None,
                    failure: raw,
                })
            }
        }
        PHYSICAL_COMPLETED => Ok(DecodedSettlement {
            status: "completed".to_string(),
            stop_reason: None,
            superseded_by: None,
            failure: raw,
        }),
        // pending / running.
        other => Ok(DecodedSettlement {
            status: other.to_string(),
            stop_reason: None,
            superseded_by: None,
            failure: None,
        }),
    }
}

/// SQL predicate for `listRuns`' logical status filter (codecs.ts `encodeRunStatusPredicate`): the
/// `stopped`/`errored` logical states share the physical `failed` column and are disambiguated in
/// SQL via `json_extract(failure_json, '$.code')`. Returns `(sql, params)`. An empty selection
/// yields the always-false clause `"0"`.
pub(crate) fn encode_run_status_predicate(statuses: &[&str]) -> (String, Vec<String>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();
    for status in statuses {
        match *status {
            "stopped" => {
                clauses.push(
                    "(status = 'cancelled' or (status = 'failed' and json_extract(failure_json, '$.code') = ?))"
                        .to_string(),
                );
                params.push(INTERRUPTED_CODE.to_string());
            }
            "errored" => {
                clauses.push(
                    "(status = 'failed' and coalesce(json_extract(failure_json, '$.code'), '') <> ?)"
                        .to_string(),
                );
                params.push(INTERRUPTED_CODE.to_string());
            }
            other => {
                clauses.push("status = ?".to_string());
                params.push(other.to_string());
            }
        }
    }
    let sql = if clauses.is_empty() {
        "0".to_string()
    } else {
        format!("({})", clauses.join(" or "))
    };
    (sql, params)
}

// ---------------------------------------------------------------------------
// Run row codecs (shared shape for full / detail / enum projections)
// ---------------------------------------------------------------------------

/// Owned raw `dwf_run` columns the metadata decoder needs (present in both `select *` and the narrow
/// enum `select`). Mirrors the fields `decodeRunMetadata` reads. `time_created`/`time_updated` are
/// part of this set because both the full and the narrow (`listRuns`) selects include them; the
/// unbounded `result_json` is deliberately NOT here (see `RunFullCols`).
pub(crate) struct RunMetaCols {
    pub id: String,
    pub parent_session_id: Option<String>,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub script_text: Option<String>,
    pub script_hash: Option<String>,
    pub tool_call_id: Option<String>,
    pub args_json: Option<String>,
    pub resumed_from: Option<String>,
    pub caps_max_concurrency: i64,
    pub spent_tokens: i64,
    pub status: String,
    pub failure_json: Option<String>,
    pub time_created: i64,
    pub time_updated: i64,
}

/// The metadata columns PLUS the unbounded `result_json`. Only the `select *` rows (getRun,
/// getRunRow, listNonTerminalRuns) expose it, so it is read separately from the narrow enum rows.
pub(crate) struct RunFullCols {
    pub meta: RunMetaCols,
    pub result_json: Option<String>,
}

/// Read the metadata columns by name. Works for both `select * from dwf_run` and the explicit narrow
/// column list (both expose these column names).
pub(crate) fn read_run_meta_cols(row: &Row<'_>) -> rusqlite::Result<RunMetaCols> {
    Ok(RunMetaCols {
        id: row.get("id")?,
        parent_session_id: row.get("parent_session_id")?,
        cwd: row.get("cwd")?,
        name: row.get("name")?,
        script_text: row.get("script_text")?,
        script_hash: row.get("script_hash")?,
        tool_call_id: row.get("tool_call_id")?,
        args_json: row.get("args_json")?,
        resumed_from: row.get("resumed_from")?,
        caps_max_concurrency: row.get("caps_max_concurrency")?,
        spent_tokens: row.get("spent_tokens")?,
        status: row.get("status")?,
        failure_json: row.get("failure_json")?,
        time_created: row.get("time_created")?,
        time_updated: row.get("time_updated")?,
    })
}

/// Read a full `select *` run row (metadata + `result_json`).
pub(crate) fn read_run_full_cols(row: &Row<'_>) -> rusqlite::Result<RunFullCols> {
    Ok(RunFullCols {
        meta: read_run_meta_cols(row)?,
        result_json: row.get("result_json")?,
    })
}

/// Insert the shared run-metadata keys (codecs.ts `decodeRunMetadata`) into `m`, in exact TS
/// insertion order: `runId, caps, spentTokens, status, [stopReason], [supersededBy],
/// [parentSessionId], [cwd], [name], [toolCallId], [scriptText], [scriptHash], [resumedFrom],
/// [args]`. `NULL` columns become ABSENT keys, not `undefined`/`null`.
pub(crate) fn insert_run_metadata(
    m: &mut Map<String, Value>,
    cols: &RunMetaCols,
) -> Result<DecodedSettlement, String> {
    let settlement = decode_run_settlement(&cols.status, &cols.failure_json)?;

    let mut caps = Map::new();
    caps.insert(
        "maxConcurrency".into(),
        Value::from(cols.caps_max_concurrency),
    );

    m.insert("runId".into(), Value::String(cols.id.clone()));
    m.insert("caps".into(), Value::Object(caps));
    m.insert("spentTokens".into(), Value::from(cols.spent_tokens));
    m.insert("status".into(), Value::String(settlement.status.clone()));
    if let Some(v) = &settlement.stop_reason {
        m.insert("stopReason".into(), Value::String(v.clone()));
    }
    if let Some(v) = &settlement.superseded_by {
        m.insert("supersededBy".into(), Value::String(v.clone()));
    }
    if let Some(v) = &cols.parent_session_id {
        m.insert("parentSessionId".into(), Value::String(v.clone()));
    }
    if let Some(v) = &cols.cwd {
        m.insert("cwd".into(), Value::String(v.clone()));
    }
    if let Some(v) = &cols.name {
        m.insert("name".into(), Value::String(v.clone()));
    }
    if let Some(v) = &cols.tool_call_id {
        m.insert("toolCallId".into(), Value::String(v.clone()));
    }
    if let Some(v) = &cols.script_text {
        m.insert("scriptText".into(), Value::String(v.clone()));
    }
    if let Some(v) = &cols.script_hash {
        m.insert("scriptHash".into(), Value::String(v.clone()));
    }
    if let Some(v) = &cols.resumed_from {
        m.insert("resumedFrom".into(), Value::String(v.clone()));
    }
    // args: NULL → absent key (not `{}`); otherwise parse. Empty string is not a stored shape.
    if let Some(raw) = &cols.args_json {
        if !raw.is_empty() {
            let v: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
            m.insert("args".into(), v);
        }
    }
    Ok(settlement)
}

/// Full `RunRecord` projection (`decodeRun`): metadata, then `[failure]`, then `[result]` — in exact
/// TS order. Takes owned cols so the read path can `query_map` a rusqlite-`Result` reader and decode
/// the JSON after collecting (row-mappers may not return `Result<_, String>`).
pub(crate) fn decode_run_cols(cols: &RunFullCols) -> Result<Value, String> {
    let mut m = Map::new();
    let settlement = insert_run_metadata(&mut m, &cols.meta)?;
    if let Some(f) = settlement.failure {
        m.insert("failure".into(), f);
    }
    if let Some(raw) = &cols.result_json {
        if !raw.is_empty() {
            let v: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
            m.insert("result".into(), v);
        }
    }
    Ok(Value::Object(m))
}

/// Owned raw `dwf_actor` columns (codecs.ts `DwfActorRow`).
pub(crate) struct ActorCols {
    pub run_id: String,
    pub site_id: String,
    pub ordinal: i64,
    pub name: Option<String>,
    pub persona_json: Option<String>,
    pub session_id: Option<String>,
    pub resolved_model: Option<String>,
}

pub(crate) fn read_actor_cols(row: &Row<'_>) -> rusqlite::Result<ActorCols> {
    Ok(ActorCols {
        run_id: row.get("run_id")?,
        site_id: row.get("site_id")?,
        ordinal: row.get("ordinal")?,
        name: row.get("name")?,
        persona_json: row.get("persona_json")?,
        session_id: row.get("session_id")?,
        resolved_model: row.get("resolved_model")?,
    })
}

/// `ActorRecord` projection (`decodeActor`): `runId, siteId, ordinal, [name], [persona], [sessionId],
/// [resolvedModel]`, from owned cols.
pub(crate) fn decode_actor_cols(cols: &ActorCols) -> Result<Value, String> {
    let mut m = Map::new();
    m.insert("runId".into(), Value::String(cols.run_id.clone()));
    m.insert("siteId".into(), Value::String(cols.site_id.clone()));
    m.insert("ordinal".into(), Value::from(cols.ordinal));
    if let Some(v) = &cols.name {
        m.insert("name".into(), Value::String(v.clone()));
    }
    if let Some(p) = decode_json_col(&cols.persona_json)? {
        m.insert("persona".into(), p);
    }
    if let Some(v) = &cols.session_id {
        m.insert("sessionId".into(), Value::String(v.clone()));
    }
    if let Some(v) = &cols.resolved_model {
        m.insert("resolvedModel".into(), Value::String(v.clone()));
    }
    Ok(Value::Object(m))
}

/// Owned raw `dwf_node` columns the `decodeNode` projection needs (codecs.ts `DwfNodeRow`).
pub(crate) struct NodeCols {
    pub run_id: String,
    pub site_id: String,
    pub ordinal: i64,
    pub kind: String,
    pub actor_site_id: Option<String>,
    pub actor_ordinal: Option<i64>,
    pub actor_seq: Option<i64>,
    pub input_hash: String,
    pub status: String,
    pub result_json: Option<String>,
    pub error_json: Option<String>,
    pub stats_json: Option<String>,
    pub message_boundary: Option<i64>,
    pub artifact_id: Option<String>,
    pub input_json: Option<String>,
}

pub(crate) fn read_node_cols(row: &Row<'_>) -> rusqlite::Result<NodeCols> {
    Ok(NodeCols {
        run_id: row.get("run_id")?,
        site_id: row.get("site_id")?,
        ordinal: row.get("ordinal")?,
        kind: row.get("kind")?,
        actor_site_id: row.get("actor_site_id")?,
        actor_ordinal: row.get("actor_ordinal")?,
        actor_seq: row.get("actor_seq")?,
        input_hash: row.get("input_hash")?,
        status: row.get("status")?,
        result_json: row.get("result_json")?,
        error_json: row.get("error_json")?,
        stats_json: row.get("stats_json")?,
        message_boundary: row.get("message_boundary")?,
        artifact_id: row.get("artifact_id")?,
        input_json: row.get("input_json")?,
    })
}

/// `NodeRecord` projection (`decodeNode`) in exact TS key order. The `result` decodes only when
/// `result_json` is non-null (an un-settled node omits it).
pub(crate) fn decode_node_cols(cols: &NodeCols) -> Result<Value, String> {
    let mut m = Map::new();
    m.insert("runId".into(), Value::String(cols.run_id.clone()));
    m.insert("siteId".into(), Value::String(cols.site_id.clone()));
    m.insert("ordinal".into(), Value::from(cols.ordinal));
    m.insert("kind".into(), Value::String(cols.kind.clone()));
    m.insert("inputHash".into(), Value::String(cols.input_hash.clone()));
    m.insert("status".into(), Value::String(cols.status.clone()));
    if let Some(v) = &cols.actor_site_id {
        m.insert("actorSiteId".into(), Value::String(v.clone()));
    }
    if let Some(v) = cols.actor_ordinal {
        m.insert("actorOrdinal".into(), Value::from(v));
    }
    if let Some(v) = cols.actor_seq {
        m.insert("actorSeq".into(), Value::from(v));
    }
    if let Some(raw) = &cols.result_json {
        if !raw.is_empty() {
            let v: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
            m.insert("result".into(), v);
        }
    }
    if let Some(v) = decode_json_col(&cols.error_json)? {
        m.insert("error".into(), v);
    }
    if let Some(v) = decode_json_col(&cols.stats_json)? {
        m.insert("stats".into(), v);
    }
    // message_boundary: 0 is a legitimate boundary, so the check is "not null", not truthiness.
    if let Some(v) = cols.message_boundary {
        m.insert("messageBoundary".into(), Value::from(v));
    }
    if let Some(v) = &cols.artifact_id {
        m.insert("artifactId".into(), Value::String(v.clone()));
    }
    if let Some(v) = decode_json_col(&cols.input_json)? {
        m.insert("input".into(), v);
    }
    Ok(Value::Object(m))
}

/// Owned raw `dwf_event` columns (codecs.ts `DwfEventRow`).
pub(crate) struct EventCols {
    pub sequence: i64,
    pub payload_json: String,
    pub time_created: i64,
}

pub(crate) fn read_event_cols(row: &Row<'_>) -> rusqlite::Result<EventCols> {
    Ok(EventCols {
        sequence: row.get("sequence")?,
        payload_json: row.get("payload_json")?,
        time_created: row.get("time_created")?,
    })
}

/// `StoredEvent` projection (`decodeEvent`) from owned cols: `{ sequence, event, timeCreated }`.
/// `event` is the raw payload re-parsed (preserve order); `timeCreated` is written unconditionally.
pub(crate) fn decode_event_cols(cols: &EventCols) -> Result<Value, String> {
    let event: Value = serde_json::from_str(&cols.payload_json).map_err(|e| e.to_string())?;
    let mut m = Map::new();
    m.insert("sequence".into(), Value::from(cols.sequence));
    m.insert("event".into(), event);
    m.insert("timeCreated".into(), Value::from(cols.time_created));
    Ok(Value::Object(m))
}

// ---------------------------------------------------------------------------
// MUTATING ops
// ---------------------------------------------------------------------------

/// Port of `createRun` (dwf-journal.ts:78-127): one `insert into dwf_run`. On a statement failure
/// the duplicate-run contract error is checked and thrown when the row already exists. No txn.
pub fn create_run(conn: &Connection, record: &Value, now: i64) -> Result<(), String> {
    let run_id = record
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| ".runId must be a string".to_string())?;
    let status = record
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| ".status must be a string".to_string())?;
    let caps = record
        .get("caps")
        .and_then(|c| c.get("maxConcurrency"))
        .and_then(Value::as_i64)
        .ok_or_else(|| ".caps.maxConcurrency must be an integer".to_string())?;
    let spent_tokens = req_i64(record, "spentTokens")?;
    let args_json = encode_json(record.get("args"))?;
    let result_json = encode_result_json(record.get("result"))?;
    // settlement == the whole record for createRun (carries stopReason/supersededBy/failure).
    let (physical_status, failure_json) = encode_run_settlement(status, Some(record))?;

    let inserted = conn.execute(
        "insert into dwf_run (
          id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
          args_json, resumed_from, caps_max_concurrency,
          spent_tokens, status, failure_json, result_json, time_created, time_updated
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            run_id,
            opt_str(record, "parentSessionId"),
            opt_str(record, "cwd"),
            opt_str(record, "name"),
            opt_str(record, "scriptText"),
            opt_str(record, "scriptHash"),
            opt_str(record, "toolCallId"),
            args_json,
            opt_str(record, "resumedFrom"),
            caps,
            spent_tokens,
            physical_status,
            failure_json,
            result_json,
            now,
            now,
        ],
    );

    if let Err(err) = inserted {
        // Duplicate run is a caller contract error worth an explicit message; any other failure
        // (FK, disk, constraint) propagates as-is. Mirrors the TS catch: re-check `getRun`.
        if run_exists(conn, run_id)? {
            return Err(format!("dwf journal: run already exists: {run_id}"));
        }
        return Err(err.to_string());
    }
    Ok(())
}

/// `getRun` existence probe for the duplicate-run error path.
fn run_exists(conn: &Connection, run_id: &str) -> Result<bool, String> {
    let found = conn
        .query_row("select 1 from dwf_run where id = ?1", [run_id], |_| Ok(()))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(found.is_some())
}

/// Port of `updateRunStatus` (dwf-journal.ts:136-183). Non-terminal (pending/running) clears
/// `failure_json`/`result_json`; terminal writes status + failure in one statement and COALESCEs
/// `result_json` (absent result = keep existing). Throws on an unknown run (0 rows touched).
pub fn update_run_status(
    conn: &Connection,
    run_id: &str,
    status: &str,
    settlement: Option<&Value>,
    now: i64,
) -> Result<(), String> {
    if status == "pending" || status == "running" {
        let changes = conn
            .execute(
                "update dwf_run set
                  status = ?1,
                  failure_json = null,
                  result_json = null,
                  time_updated = ?2
                where id = ?3",
                params![status, now, run_id],
            )
            .map_err(|e| e.to_string())?;
        return assert_run_touched(changes, run_id);
    }
    let (physical_status, failure_json) = encode_run_settlement(status, settlement)?;
    let result_json = encode_result_json(settlement.and_then(|s| s.get("result")))?;
    let changes = conn
        .execute(
            "update dwf_run set
              status = ?1,
              failure_json = ?2,
              result_json = coalesce(?3, result_json),
              time_updated = ?4
            where id = ?5",
            params![physical_status, failure_json, result_json, now, run_id],
        )
        .map_err(|e| e.to_string())?;
    assert_run_touched(changes, run_id)
}

/// Port of `updateRunUsage` (dwf-journal.ts:185-190): ONLY `spent_tokens` (+ `time_updated`). Throws
/// on an unknown run. Never touches status/failure.
pub fn update_run_usage(
    conn: &Connection,
    run_id: &str,
    spent_tokens: i64,
    now: i64,
) -> Result<(), String> {
    let changes = conn
        .execute(
            "update dwf_run set spent_tokens = ?1, time_updated = ?2 where id = ?3",
            params![spent_tokens, now, run_id],
        )
        .map_err(|e| e.to_string())?;
    assert_run_touched(changes, run_id)
}

/// Port of `updateRunCaps` (dwf-journal.ts:198-203): ONLY `caps_max_concurrency` (+ `time_updated`).
/// Throws on an unknown run.
pub fn update_run_caps(
    conn: &Connection,
    run_id: &str,
    caps: &Value,
    now: i64,
) -> Result<(), String> {
    let max_concurrency = caps
        .get("maxConcurrency")
        .and_then(Value::as_i64)
        .ok_or_else(|| ".maxConcurrency must be an integer".to_string())?;
    let changes = conn
        .execute(
            "update dwf_run set caps_max_concurrency = ?1, time_updated = ?2 where id = ?3",
            params![max_concurrency, now, run_id],
        )
        .map_err(|e| e.to_string())?;
    assert_run_touched(changes, run_id)
}

/// Port of `assertRunTouched` (dwf-journal.ts:428): 0 rows affected = unknown run → throw.
fn assert_run_touched(changes: usize, run_id: &str) -> Result<(), String> {
    if changes == 0 {
        return Err(format!("dwf journal: unknown run: {run_id}"));
    }
    Ok(())
}

/// Port of `putActor` (dwf-journal.ts:257-285): `insert ... on conflict(run_id, site_id, ordinal) do
/// update set` (name/persona/session/resolved_model/time_updated). No txn.
pub fn put_actor(conn: &Connection, record: &Value, now: i64) -> Result<(), String> {
    let run_id = record
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| ".runId must be a string".to_string())?;
    let site_id = record
        .get("siteId")
        .and_then(Value::as_str)
        .ok_or_else(|| ".siteId must be a string".to_string())?;
    let ordinal = req_i64(record, "ordinal")?;
    let persona_json = encode_json(record.get("persona"))?;

    conn.execute(
        "insert into dwf_actor (
          run_id, site_id, ordinal, name, persona_json, session_id, resolved_model,
          time_created, time_updated
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        on conflict(run_id, site_id, ordinal) do update set
          name = excluded.name,
          persona_json = excluded.persona_json,
          session_id = excluded.session_id,
          resolved_model = excluded.resolved_model,
          time_updated = excluded.time_updated",
        params![
            run_id,
            site_id,
            ordinal,
            opt_str(record, "name"),
            persona_json,
            opt_str(record, "sessionId"),
            opt_str(record, "resolvedModel"),
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Port of `putNode` (dwf-journal.ts:301-354): full-row upsert keyed on `(run_id, site_id, ordinal)`.
/// `result_json` uses `encodeResultJson` (undefined → NULL, null → `"null"`); `error_json`/
/// `stats_json`/`input_json` use `encodeJson`. No txn.
pub fn put_node(conn: &Connection, record: &Value, now: i64) -> Result<(), String> {
    let run_id = record
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| ".runId must be a string".to_string())?;
    let site_id = record
        .get("siteId")
        .and_then(Value::as_str)
        .ok_or_else(|| ".siteId must be a string".to_string())?;
    let ordinal = req_i64(record, "ordinal")?;
    let kind = record
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| ".kind must be a string".to_string())?;
    let input_hash = record
        .get("inputHash")
        .and_then(Value::as_str)
        .ok_or_else(|| ".inputHash must be a string".to_string())?;
    let status = record
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| ".status must be a string".to_string())?;
    let result_json = encode_result_json(record.get("result"))?;
    let error_json = encode_json(record.get("error"))?;
    let stats_json = encode_json(record.get("stats"))?;
    let input_json = encode_json(record.get("input"))?;

    conn.execute(
        "insert into dwf_node (
          run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq,
          input_hash, status, result_json, error_json, stats_json, message_boundary,
          artifact_id, input_json, time_created, time_updated
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        on conflict(run_id, site_id, ordinal) do update set
          kind = excluded.kind,
          actor_site_id = excluded.actor_site_id,
          actor_ordinal = excluded.actor_ordinal,
          actor_seq = excluded.actor_seq,
          input_hash = excluded.input_hash,
          status = excluded.status,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          stats_json = excluded.stats_json,
          message_boundary = excluded.message_boundary,
          artifact_id = excluded.artifact_id,
          input_json = excluded.input_json,
          time_updated = excluded.time_updated",
        params![
            run_id,
            site_id,
            ordinal,
            kind,
            opt_str(record, "actorSiteId"),
            opt_i64_of(record, "actorOrdinal"),
            opt_i64_of(record, "actorSeq"),
            input_hash,
            status,
            result_json,
            error_json,
            stats_json,
            opt_i64_of(record, "messageBoundary"),
            opt_str(record, "artifactId"),
            input_json,
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// `?? null` for an optional integer field: absent/`null` → `None`; otherwise `Some`.
fn opt_i64_of(input: &Value, key: &str) -> Option<i64> {
    input.get(key).and_then(Value::as_i64)
}

/// Port of `appendEvent` (dwf-journal.ts:386-411): one `insert ... returning sequence`, sequence
/// minted in-statement as `coalesce((select max(sequence)+1 ... where run_id = ?), 0)` — so the
/// FIRST event gets sequence `0` (NOT the `max+1` form the script-workflow journal uses). Returns
/// the `StoredEvent` projection. No txn.
pub fn append_event(
    conn: &Connection,
    run_id: &str,
    event: &str,
    now: i64,
) -> Result<Value, String> {
    // event.type is stored in the dedicated `type` column (redundancy for pushdown filtering).
    let parsed: Value = serde_json::from_str(event).map_err(|e| e.to_string())?;
    let etype = parsed
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "event.type must be a string".to_string())?;

    let row = conn
        .query_row(
            "insert into dwf_event (run_id, sequence, type, payload_json, time_created)
             values (
               ?1,
               coalesce((select max(sequence) + 1 from dwf_event where run_id = ?2), 0),
               ?3, ?4, ?5
             )
             returning sequence",
            params![run_id, run_id, etype, event, now],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let sequence = row.ok_or_else(|| {
        format!("dwf journal: event insert returned no sequence for run: {run_id}")
    })?;

    let mut m = Map::new();
    m.insert("sequence".into(), Value::from(sequence));
    m.insert("event".into(), parsed);
    m.insert("timeCreated".into(), Value::from(now));
    Ok(Value::Object(m))
}

// ---------------------------------------------------------------------------
// N-API boundaries
// ---------------------------------------------------------------------------

/// N-API: `createRun`. `record_json` is the serialized `RunRecord`; `now` is the injected epoch ms.
/// Returns `"null"` on success (the port returns void); throws the duplicate-run contract error.
#[napi]
pub fn dwf_create_run_json(db_path: String, record_json: String, now: f64) -> napi::Result<String> {
    let record: Value =
        serde_json::from_str(&record_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    create_run(&conn, &record, now as i64).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `updateRunStatus`. `settlement_json` is the serialized `RunSettlementRecord` or an empty
/// string / `"null"` for none; `now` is injected. Returns `"null"`; throws on unknown run.
#[napi]
pub fn dwf_update_run_status_json(
    db_path: String,
    run_id: String,
    status: String,
    settlement_json: String,
    now: f64,
) -> napi::Result<String> {
    let settlement: Option<Value> = if settlement_json.is_empty() {
        None
    } else {
        let v: Value = serde_json::from_str(&settlement_json)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        if v.is_null() {
            None
        } else {
            Some(v)
        }
    };
    let conn = crate::open_readwrite(&db_path)?;
    update_run_status(&conn, &run_id, &status, settlement.as_ref(), now as i64)
        .map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `updateRunUsage` (only `spent_tokens`). Throws on unknown run.
#[napi]
pub fn dwf_update_run_usage_json(
    db_path: String,
    run_id: String,
    spent_tokens: f64,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    update_run_usage(&conn, &run_id, spent_tokens as i64, now as i64)
        .map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `updateRunCaps` (only `caps_max_concurrency`). `caps_json` = `{"maxConcurrency": N}`.
/// Throws on unknown run.
#[napi]
pub fn dwf_update_run_caps_json(
    db_path: String,
    run_id: String,
    caps_json: String,
    now: f64,
) -> napi::Result<String> {
    let caps: Value =
        serde_json::from_str(&caps_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    update_run_caps(&conn, &run_id, &caps, now as i64).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `putActor` (upsert). `record_json` = serialized `ActorRecord`; `now` injected.
#[napi]
pub fn dwf_put_actor_json(db_path: String, record_json: String, now: f64) -> napi::Result<String> {
    let record: Value =
        serde_json::from_str(&record_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    put_actor(&conn, &record, now as i64).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `putNode` (upsert). `record_json` = serialized `NodeRecord`; `now` injected.
#[napi]
pub fn dwf_put_node_json(db_path: String, record_json: String, now: f64) -> napi::Result<String> {
    let record: Value =
        serde_json::from_str(&record_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    put_node(&conn, &record, now as i64).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `appendEvent`. `event_json` is the serialized `RunEvent` (stored verbatim as `payload_json`,
/// matching `JSON.stringify(event)`); `now` is the injected epoch ms. Returns the `StoredEvent`.
#[napi]
pub fn dwf_append_event_json(
    db_path: String,
    run_id: String,
    event_json: String,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    let value =
        append_event(&conn, &run_id, &event_json, now as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

// ---------------------------------------------------------------------------
// Unit tests (codec + op behaviour on an in-memory DB mirroring node:sqlite FK/CHECK)
// ---------------------------------------------------------------------------

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
        conn
    }

    fn seed_run(conn: &Connection, id: &str) {
        create_run(
            conn,
            &json!({
                "runId": id, "caps": { "maxConcurrency": 4 }, "spentTokens": 0,
                "status": "running", "parentSessionId": null
            }),
            1000,
        )
        .expect("seed run");
    }

    #[test]
    fn create_run_maps_logical_status_to_physical() {
        let conn = db();
        create_run(
            &conn,
            &json!({
                "runId": "r1", "caps": { "maxConcurrency": 3 }, "spentTokens": 10,
                "status": "running", "cwd": "/work", "args": { "a": 1 },
                "result": { "v": 2 }
            }),
            2000,
        )
        .expect("create");
        let (status, failure): (String, Option<String>) = conn
            .query_row(
                "select status, failure_json from dwf_run where id = 'r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("read");
        assert_eq!(status, "running");
        assert_eq!(failure, None, "running carries no failure envelope");

        // stopped → cancelled + envelope.
        create_run(
            &conn,
            &json!({
                "runId": "r2", "caps": { "maxConcurrency": 1 }, "spentTokens": 0,
                "status": "stopped", "stopReason": "user"
            }),
            2000,
        )
        .expect("create stopped");
        let (status, failure): (String, String) = conn
            .query_row(
                "select status, failure_json from dwf_run where id = 'r2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("read");
        assert_eq!(status, "cancelled");
        assert_eq!(failure, json!({ "stopReason": "user" }).to_string());
    }

    #[test]
    fn create_run_duplicate_throws_contract_error() {
        let conn = db();
        seed_run(&conn, "dup");
        let err = create_run(
            &conn,
            &json!({
                "runId": "dup", "caps": { "maxConcurrency": 4 }, "spentTokens": 0,
                "status": "running"
            }),
            1000,
        )
        .expect_err("duplicate must throw");
        assert_eq!(err, "dwf journal: run already exists: dup");
    }

    #[test]
    fn result_json_undefined_vs_null_split() {
        let conn = db();
        // result: null must store the string "null", not SQL NULL.
        create_run(
            &conn,
            &json!({
                "runId": "rnull", "caps": { "maxConcurrency": 1 }, "spentTokens": 0,
                "status": "running", "result": null
            }),
            1000,
        )
        .expect("create with null result");
        let stored: Option<String> = conn
            .query_row(
                "select result_json from dwf_run where id='rnull'",
                [],
                |r| r.get(0),
            )
            .expect("read");
        assert_eq!(
            stored.as_deref(),
            Some("null"),
            "null result round-trips as \"null\""
        );

        // absent result → SQL NULL.
        let stored_absent: Option<String> = conn
            .query_row(
                "select result_json from dwf_run where id=(select 'rnull')",
                [],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        let _ = stored_absent;
        create_run(
            &conn,
            &json!({
                "runId": "rabsent", "caps": { "maxConcurrency": 1 }, "spentTokens": 0,
                "status": "running"
            }),
            1000,
        )
        .expect("create absent result");
        let stored2: Option<String> = conn
            .query_row(
                "select result_json from dwf_run where id='rabsent'",
                [],
                |r| r.get(0),
            )
            .expect("read");
        assert_eq!(stored2, None, "absent result → NULL");
    }

    #[test]
    fn update_run_status_clears_on_non_terminal_and_throws_unknown() {
        let conn = db();
        create_run(
            &conn,
            &json!({
                "runId": "r1", "caps": { "maxConcurrency": 1 }, "spentTokens": 0,
                "status": "completed", "result": { "x": 1 },
                "failure": { "code": "Boom", "message": "m" }
            }),
            1000,
        )
        .expect("create completed");
        // resume flips back to running → clears failure_json and result_json.
        update_run_status(&conn, "r1", "running", None, 2000).expect("resume");
        let row: (Option<String>, Option<String>) = conn
            .query_row(
                "select failure_json, result_json from dwf_run where id='r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("read");
        assert_eq!(row.0, None, "failure cleared on non-terminal");
        assert_eq!(row.1, None, "result cleared on non-terminal");

        let err = update_run_status(&conn, "ghost", "running", None, 2000)
            .expect_err("unknown run must throw");
        assert_eq!(err, "dwf journal: unknown run: ghost");
    }

    #[test]
    fn update_run_status_terminal_coalesces_result() {
        let conn = db();
        create_run(
            &conn,
            &json!({
                "runId": "r1", "caps": { "maxConcurrency": 1 }, "spentTokens": 0,
                "status": "running", "result": { "keep": true }
            }),
            1000,
        )
        .expect("create with result");
        // Terminal settle with NO result: coalesce keeps the existing artifact.
        update_run_status(
            &conn,
            "r1",
            "errored",
            Some(&json!({ "failure": { "code": "X" } })),
            2000,
        )
        .expect("settle errored");
        let stored: Option<String> = conn
            .query_row("select result_json from dwf_run where id='r1'", [], |r| {
                r.get(0)
            })
            .expect("read");
        assert_eq!(
            stored.as_deref(),
            Some(json!({ "keep": true }).to_string().as_str()),
            "absent result coalesces (keeps existing)"
        );
    }

    #[test]
    fn single_column_updates_never_touch_others() {
        let conn = db();
        create_run(
            &conn,
            &json!({
                "runId": "r1", "caps": { "maxConcurrency": 4 }, "spentTokens": 7,
                "status": "running"
            }),
            1000,
        )
        .expect("create");
        // Usage update only bumps spent_tokens; caps stays.
        update_run_usage(&conn, "r1", 99, 1500).expect("usage");
        let (spent, caps): (i64, i64) = conn
            .query_row(
                "select spent_tokens, caps_max_concurrency from dwf_run where id='r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("read");
        assert_eq!(spent, 99);
        assert_eq!(caps, 4, "caps untouched by usage update");

        // Caps update only bumps caps_max_concurrency; usage stays.
        update_run_caps(&conn, "r1", &json!({ "maxConcurrency": 8 }), 1600).expect("caps");
        let (spent2, caps2): (i64, i64) = conn
            .query_row(
                "select spent_tokens, caps_max_concurrency from dwf_run where id='r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("read");
        assert_eq!(caps2, 8);
        assert_eq!(spent2, 99, "usage untouched by caps update");

        // Both throw on unknown run.
        assert_eq!(
            update_run_usage(&conn, "ghost", 1, 1000).unwrap_err(),
            "dwf journal: unknown run: ghost"
        );
        assert_eq!(
            update_run_caps(&conn, "ghost", &json!({ "maxConcurrency": 1 }), 1000).unwrap_err(),
            "dwf journal: unknown run: ghost"
        );
    }

    #[test]
    fn append_event_first_sequence_is_zero_and_scopes_per_run() {
        let conn = db();
        seed_run(&conn, "r1");
        let e1 = append_event(
            &conn,
            "r1",
            &json!({ "type": "log", "message": "a" }).to_string(),
            100,
        )
        .expect("append 1");
        assert_eq!(
            e1["sequence"],
            json!(0),
            "first event sequence is 0 (coalesce(max+1,0))"
        );
        let e2 = append_event(
            &conn,
            "r1",
            &json!({ "type": "log", "message": "b" }).to_string(),
            101,
        )
        .expect("append 2");
        assert_eq!(e2["sequence"], json!(1));
        // Different run restarts at 0 (sequence scoped per run).
        seed_run(&conn, "r2");
        let e3 = append_event(&conn, "r2", &json!({ "type": "log" }).to_string(), 102)
            .expect("other run");
        assert_eq!(e3["sequence"], json!(0));
        // Returned StoredEvent carries the verbatim event object.
        assert_eq!(e2["event"], json!({ "type": "log", "message": "b" }));
    }

    #[test]
    fn put_actor_and_node_upsert_replace_whole_row() {
        let conn = db();
        seed_run(&conn, "r1");
        put_actor(
            &conn,
            &json!({ "runId": "r1", "siteId": "s", "ordinal": 0, "name": "a", "persona": { "x": 1 } }),
            1000,
        )
        .expect("insert actor");
        // Re-insert: upsert replaces name/persona, drops the omitted fields to NULL.
        put_actor(
            &conn,
            &json!({ "runId": "r1", "siteId": "s", "ordinal": 0, "name": "b", "sessionId": "sess" }),
            2000,
        )
        .expect("update actor");
        let row = decode_actor_cols(
            &conn
                .query_row(
                    "select * from dwf_actor where run_id='r1' and site_id='s' and ordinal=0",
                    [],
                    read_actor_cols,
                )
                .map_err(|e| e.to_string())
                .expect("read actor cols"),
        )
        .expect("read actor");
        assert_eq!(row["name"], json!("b"));
        assert_eq!(row["sessionId"], json!("sess"));
        assert!(
            row.get("persona").is_none(),
            "omitted persona replaced to NULL → absent key"
        );

        put_node(
            &conn,
            &json!({
                "runId": "r1", "siteId": "n", "ordinal": 0, "kind": "ask",
                "inputHash": "h", "status": "running", "artifactId": "art"
            }),
            1000,
        )
        .expect("insert node");
        let node = decode_node_cols(
            &conn
                .query_row(
                    "select * from dwf_node where run_id='r1' and site_id='n' and ordinal=0",
                    [],
                    read_node_cols,
                )
                .map_err(|e| e.to_string())
                .expect("read node cols"),
        )
        .expect("read node");
        assert_eq!(node["artifactId"], json!("art"));

        // Second (settlement) write omits artifactId → upsert wipes it to NULL (documented contract).
        put_node(
            &conn,
            &json!({
                "runId": "r1", "siteId": "n", "ordinal": 0, "kind": "ask",
                "inputHash": "h", "status": "completed"
            }),
            2000,
        )
        .expect("settle node");
        let node2 = decode_node_cols(
            &conn
                .query_row(
                    "select * from dwf_node where run_id='r1' and site_id='n' and ordinal=0",
                    [],
                    read_node_cols,
                )
                .map_err(|e| e.to_string())
                .expect("read node2 cols"),
        )
        .expect("read node2");
        assert!(
            node2.get("artifactId").is_none(),
            "upsert full-replace clears artifactId"
        );
        assert_eq!(node2["status"], json!("completed"));
    }

    #[test]
    fn decode_run_settlement_interrupted_maps_to_stopped() {
        let s = decode_run_settlement(
            "failed",
            &Some(json!({ "code": "Interrupted", "message": "gone" }).to_string()),
        )
        .expect("decode");
        assert_eq!(s.status, "stopped");
        assert_eq!(s.stop_reason.as_deref(), Some("interrupted"));
        assert!(s.failure.is_some());

        let s2 = decode_run_settlement("failed", &Some(json!({ "code": "Boom" }).to_string()))
            .expect("decode2");
        assert_eq!(s2.status, "errored");
    }

    #[test]
    fn status_predicate_shapes() {
        let (sql, params) = encode_run_status_predicate(&["stopped", "completed"]);
        assert!(sql.contains("'cancelled'"));
        assert_eq!(
            params,
            vec![INTERRUPTED_CODE.to_string(), "completed".to_string()]
        );
        let (sql0, _) = encode_run_status_predicate(&[]);
        assert_eq!(sql0, "0", "empty selection → always-false clause");
    }
}
