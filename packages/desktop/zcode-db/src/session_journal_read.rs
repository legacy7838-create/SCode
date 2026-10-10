//! DWF (dynamic-workflow) journal store: the READ side of `JournalStorePort` plus the host-side
//! introspection/artifact queries. Ported verbatim from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/dwf-journal.ts`
//! (getRun/getActor/listActors/getNode/listNodes/listEvents), `.../dwf-journal-introspection.ts`
//! (listRuns/getRunRow/countNodesByStatus/listRecentLogEvents/listRunLifeSpans/
//! listRunsByParentSession/listWorldNodes/listNonTerminalRuns) and `.../dwf-journal-artifacts.ts`
//! (listArtifactRows/listArtifactItems).
//!
//! Every codec (`decode_run_cols`/`decode_actor_cols`/`decode_node_cols`/`decode_event_cols`,
//! `insert_run_metadata`, `encode_run_status_predicate`, ...) is reused from `session_journal` so the
//! read and write paths can never diverge on "which optional columns count as absent". Rows are
//! gathered as owned `*Cols` via rusqlite `Result` readers, then decoded to JSON afterwards (a
//! row-mapper may not itself return `Result<_, String>`). All queries push cursor/limit/filters down
//! to SQL — never SELECT-all-then-slice. Unknown runId and out-of-range cursor return `[]` (no
//! throw): the deliberate projection-vs-journal race-window contract.
//!
//! The addon NEVER reads the clock; reads don't need `now`. Read connections are opened read-only via
//! `crate::open_readonly`. Verified by `harness/session_journal_read_parity`.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params, types::ToSql, Connection, OptionalExtension, Row};
use serde_json::{Map, Value};

use super::session_journal::{
    decode_actor_cols, decode_event_cols, decode_node_cols, decode_run_cols,
    encode_run_status_predicate, insert_run_metadata, read_actor_cols, read_event_cols,
    read_node_cols, read_run_full_cols, read_run_meta_cols, NodeCols, RunFullCols, RunMetaCols,
};

/// A world-read / world-run row: the `decodeNode` columns (no `result_json`) plus the SQL-computed
/// size/count/exit columns and timestamps. Read as owned data so the JSON build happens after collect.
struct WorldRowCols {
    node: NodeCols,
    time_created: i64,
    time_updated: i64,
    result_bytes: Option<i64>,
    result_count: Option<i64>,
    exit_code: Option<i64>,
    stdout_bytes: Option<i64>,
    stderr_bytes: Option<i64>,
}

/// Read the narrow world-node projection columns (no `id`, no `result_json`).
fn read_world_cols(row: &Row<'_>) -> rusqlite::Result<WorldRowCols> {
    Ok(WorldRowCols {
        node: NodeCols {
            run_id: row.get("run_id")?,
            site_id: row.get("site_id")?,
            ordinal: row.get("ordinal")?,
            kind: row.get("kind")?,
            actor_site_id: row.get("actor_site_id")?,
            actor_ordinal: row.get("actor_ordinal")?,
            actor_seq: row.get("actor_seq")?,
            input_hash: row.get("input_hash")?,
            status: row.get("status")?,
            // The narrow select never carries the result body; the byte sizes come from the
            // computed columns below. `None` here makes `decode_node_cols` omit `result`.
            result_json: None,
            error_json: row.get("error_json")?,
            stats_json: row.get("stats_json")?,
            message_boundary: row.get("message_boundary")?,
            artifact_id: row.get("artifact_id")?,
            input_json: row.get("input_json")?,
        },
        time_created: row.get("time_created")?,
        time_updated: row.get("time_updated")?,
        result_bytes: row.get("result_bytes")?,
        result_count: row.get("result_count")?,
        exit_code: row.get("exit_code")?,
        stdout_bytes: row.get("stdout_bytes")?,
        stderr_bytes: row.get("stderr_bytes")?,
    })
}

/// Project a collected world row (mirror of `listWorldNodes`' JS map): decodeNode keys, then
/// `timeCreated`/`timeUpdated`, then each absent-when-NULL byte/count key.
fn world_row_to_value(cols: WorldRowCols) -> Result<Value, String> {
    let mut m = match decode_node_cols(&cols.node)? {
        Value::Object(m) => m,
        _ => return Err("decode_node_cols must yield an object".to_string()),
    };
    m.insert("timeCreated".into(), Value::from(cols.time_created));
    m.insert("timeUpdated".into(), Value::from(cols.time_updated));
    if let Some(v) = cols.result_bytes {
        m.insert("resultBytes".into(), Value::from(v));
    }
    if let Some(v) = cols.result_count {
        m.insert("resultCount".into(), Value::from(v));
    }
    // exit_code is a JSON extract: only a real number is emitted (matches `typeof === "number"`).
    if let Some(v) = cols.exit_code {
        m.insert("exitCode".into(), Value::from(v));
    }
    if let Some(v) = cols.stdout_bytes {
        m.insert("stdoutBytes".into(), Value::from(v));
    }
    if let Some(v) = cols.stderr_bytes {
        m.insert("stderrBytes".into(), Value::from(v));
    }
    Ok(Value::Object(m))
}

// ---------------------------------------------------------------------------
// Run projections built on the shared `insert_run_metadata` (exact TS key order)
// ---------------------------------------------------------------------------

/// `DwfRunListItem` = metadata + `timeCreated`/`timeUpdated`, WITHOUT `failure`/`result`.
fn run_list_item(cols: &RunMetaCols) -> Result<Value, String> {
    let mut m = Map::new();
    insert_run_metadata(&mut m, cols)?;
    m.insert("timeCreated".into(), Value::from(cols.time_created));
    m.insert("timeUpdated".into(), Value::from(cols.time_updated));
    Ok(Value::Object(m))
}

/// `DwfRunDetailRow` = full `RunRecord` (metadata + failure + result) + `timeCreated`/`timeUpdated`.
fn run_detail_row(cols: &RunFullCols) -> Result<Value, String> {
    let mut m = match decode_run_cols(cols)? {
        Value::Object(m) => m,
        _ => return Err("decode_run_cols must yield an object".to_string()),
    };
    m.insert("timeCreated".into(), Value::from(cols.meta.time_created));
    m.insert("timeUpdated".into(), Value::from(cols.meta.time_updated));
    Ok(Value::Object(m))
}

/// `DwfRunSessionListItem` = list-item + `failure` appended AFTER `timeUpdated` (the session row
/// selects `failure_json` but NOT `result_json`).
fn run_session_list_item(cols: &RunMetaCols) -> Result<Value, String> {
    let mut m = Map::new();
    let settlement = insert_run_metadata(&mut m, cols)?;
    m.insert("timeCreated".into(), Value::from(cols.time_created));
    m.insert("timeUpdated".into(), Value::from(cols.time_updated));
    if let Some(f) = settlement.failure {
        m.insert("failure".into(), f);
    }
    Ok(Value::Object(m))
}

/// Port of `getRun`: the full `RunRecord` by id, or `Value::Null` for an unknown run.
pub fn get_run(conn: &Connection, run_id: &str) -> Result<Value, String> {
    let cols = conn
        .query_row(
            "select * from dwf_run where id = ?1",
            [run_id],
            read_run_full_cols,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match cols {
        None => Ok(Value::Null),
        Some(c) => decode_run_cols(&c),
    }
}

/// Port of `getActor`: the `ActorRecord` by `(run_id, site_id, ordinal)`, or `null`.
pub fn get_actor(
    conn: &Connection,
    run_id: &str,
    site_id: &str,
    ordinal: i64,
) -> Result<Value, String> {
    let cols = conn
        .query_row(
            "select * from dwf_actor where run_id = ?1 and site_id = ?2 and ordinal = ?3",
            params![run_id, site_id, ordinal],
            read_actor_cols,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match cols {
        None => Ok(Value::Null),
        Some(c) => decode_actor_cols(&c),
    }
}

/// Port of `listActors`: all actors for a run, `order by id`.
pub fn list_actors(conn: &Connection, run_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare("select * from dwf_actor where run_id = ?1 order by id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], read_actor_cols)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    rows.iter()
        .map(decode_actor_cols)
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

/// Port of `getNode`: the `NodeRecord` by `(run_id, site_id, ordinal)`, or `null`.
pub fn get_node(
    conn: &Connection,
    run_id: &str,
    site_id: &str,
    ordinal: i64,
) -> Result<Value, String> {
    let cols = conn
        .query_row(
            "select * from dwf_node where run_id = ?1 and site_id = ?2 and ordinal = ?3",
            params![run_id, site_id, ordinal],
            read_node_cols,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match cols {
        None => Ok(Value::Null),
        Some(c) => decode_node_cols(&c),
    }
}

/// Port of `listNodes`: all nodes for a run, `order by id`.
pub fn list_nodes(conn: &Connection, run_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare("select * from dwf_node where run_id = ?1 order by id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], read_node_cols)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    rows.iter()
        .map(decode_node_cols)
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

/// Port of `listEvents`: events ascending by `sequence`, with `afterSequence`/`limit` pushed to SQL.
/// `opts` = `Some({ afterSequence?, limit? })` or `None`. Unknown run / out-of-range cursor → `[]`.
pub fn list_events(conn: &Connection, run_id: &str, opts: Option<&Value>) -> Result<Value, String> {
    // cursor == "strictly greater than" (matches the in-memory impl). Default limit = -1 = SQLite's
    // "no limit", so the absent and explicit-limit cases share one statement shape.
    let after = opts
        .and_then(|o| o.get("afterSequence"))
        .and_then(Value::as_i64);
    let limit = opts.and_then(|o| o.get("limit")).and_then(Value::as_i64);
    let where_sql = match after {
        Some(_) => "run_id = ? and sequence > ?",
        None => "run_id = ?",
    };
    let limit_val: i64 = match limit {
        Some(l) => l.max(0),
        None => -1,
    };
    let sql = format!("select * from dwf_event where {where_sql} order by sequence limit ?");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match after {
        Some(a) => stmt
            .query_map(params![run_id, a, limit_val], read_event_cols)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map(params![run_id, limit_val], read_event_cols)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
    };
    rows.iter()
        .map(decode_event_cols)
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

/// Port of `listNonTerminalRuns` (host-side orphan convergence): non-terminal runs for a parent
/// session, `order by id`. The physical terminal set (`completed`/`failed`/`cancelled`) is the
/// index-friendly prefilter; the terminal-set authority stays in the service.
pub fn list_non_terminal_runs(conn: &Connection, parent_session_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "select * from dwf_run
             where parent_session_id = ?1 and status not in ('completed', 'failed', 'cancelled')
             order by id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([parent_session_id], read_run_full_cols)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    rows.iter()
        .map(decode_run_cols)
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

// The narrow metadata column list `listRuns` / `listRunsByParentSession` select (no `result_json`).
const RUN_METADATA_COLUMNS: &str = "
        id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
        args_json, resumed_from, caps_max_concurrency,
        spent_tokens, status, failure_json, time_created, time_updated
      from dwf_run";

/// Port of `listRuns`: enum rows by project (cwd) + optional statuses/name, most-recently-updated
/// first, `limit`. Empty status set → `[]`; `limit <= 0` → `[]`. Every filter is pushed to SQL.
pub fn list_runs(conn: &Connection, query: &Value) -> Result<Value, String> {
    // Empty status set means "match nothing", not "no filter"; limit <= 0 is an empty page.
    if let Some(arr) = query.get("statuses").and_then(Value::as_array) {
        if arr.is_empty() {
            return Ok(Value::Array(Vec::new()));
        }
    }
    let limit = query.get("limit").and_then(Value::as_i64).unwrap_or(0);
    if limit <= 0 {
        return Ok(Value::Array(Vec::new()));
    }

    let mut clauses: Vec<String> = Vec::new();
    let mut vals: Vec<Box<dyn ToSql>> = Vec::new();
    // cwd: only when the KEY is present (`=== undefined` check in TS), even if empty string.
    if let Some(cwd) = query.get("cwd") {
        clauses.push(" and cwd = ?".to_string());
        vals.push(Box::new(cwd.as_str().map(str::to_string)));
    }
    // Logical statuses → physical SQL predicate (stopped/errored share physical `failed`).
    if let Some(arr) = query.get("statuses").and_then(Value::as_array) {
        let statuses: Vec<&str> = arr.iter().filter_map(Value::as_str).collect();
        let (sql, params_list) = encode_run_status_predicate(&statuses);
        clauses.push(format!(" and {sql}"));
        for p in params_list {
            vals.push(Box::new(p));
        }
    }
    if let Some(name) = query.get("name") {
        clauses.push(" and name = ?".to_string());
        vals.push(Box::new(name.as_str().map(str::to_string)));
    }
    vals.push(Box::new(limit));

    let sql = format!(
        "select{RUN_METADATA_COLUMNS} where 1 = 1{} order by time_updated desc limit ?",
        clauses.join("")
    );
    let refs: Vec<&dyn ToSql> = vals.iter().map(|v| v.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(refs), read_run_meta_cols)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let out = rows
        .iter()
        .map(run_list_item)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(out))
}

/// Port of `listRunsByParentSession`: session enum rows (metadata + failure, no result), most-
/// recently-updated then id desc, `limit` clamped to `>= 0`.
pub fn list_runs_by_parent_session(
    conn: &Connection,
    parent_session_id: &str,
    limit: i64,
) -> Result<Value, String> {
    let sql = format!(
        "select{RUN_METADATA_COLUMNS} where parent_session_id = ? order by time_updated desc, id desc limit ?"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![parent_session_id, limit.max(0)], read_run_meta_cols)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let out = rows
        .iter()
        .map(run_session_list_item)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(out))
}

/// Port of `getRunRow`: the detail row (`RunRecord` + timestamps) by id, or `null`.
pub fn get_run_row(conn: &Connection, run_id: &str) -> Result<Value, String> {
    let cols = conn
        .query_row(
            "select * from dwf_run where id = ?1",
            [run_id],
            read_run_full_cols,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match cols {
        None => Ok(Value::Null),
        Some(c) => run_detail_row(&c),
    }
}

/// Port of `countNodesByStatus`: the three-state aggregate computed in SQL, three keys ALWAYS
/// present (0 when absent). Key order matches the TS initializer: `running, completed, failed`.
pub fn count_nodes_by_status(conn: &Connection, run_id: &str) -> Result<Value, String> {
    let mut counts = Map::new();
    counts.insert("running".into(), Value::from(0));
    counts.insert("completed".into(), Value::from(0));
    counts.insert("failed".into(), Value::from(0));
    let mut stmt = conn
        .prepare("select status, count(*) as total from dwf_node where run_id = ?1 group by status")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], |row| {
            Ok((row.get::<_, String>("status")?, row.get::<_, i64>("total")?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (status, total) in rows {
        counts.insert(status, Value::from(total));
    }
    Ok(Value::Object(counts))
}

/// Port of `listRecentLogEvents`: the last `limit` `log` events, returned in ascending `sequence`
/// (SQL takes the tail with `desc limit ?`, then JS reverses). `limit <= 0` → `[]`.
pub fn list_recent_log_events(
    conn: &Connection,
    run_id: &str,
    limit: i64,
) -> Result<Value, String> {
    if limit <= 0 {
        return Ok(Value::Array(Vec::new()));
    }
    let mut stmt = conn
        .prepare(
            "select * from dwf_event where run_id = ?1 and type = 'log' order by sequence desc limit ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![run_id, limit], read_event_cols)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = rows
        .iter()
        .map(decode_event_cols)
        .collect::<Result<Vec<_>, _>>()?;
    out.reverse();
    Ok(Value::Array(out))
}

/// Port of `listRunLifeSpans`: each run "life" (`run-started` → that life's last event), in time
/// order, decoded from raw columns (no payload parse). `lastActivityAt` defaults to `startedAt`
/// when the correlated subquery returns NULL.
pub fn list_run_life_spans(conn: &Connection, run_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "
      with lives as (
        select sequence, time_created,
               lead(sequence) over (order by sequence) as next_sequence
        from dwf_event
        where run_id = ?1 and type = 'run-started'
      )
      select
        l.time_created as started_at,
        (
          select e.time_created
          from dwf_event e
          where e.run_id = ?2
            and e.sequence >= l.sequence
            and (l.next_sequence is null or e.sequence < l.next_sequence)
          order by e.sequence desc
          limit 1
        ) as last_activity_at
      from lives l
      order by l.sequence
      ",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![run_id, run_id], |row| {
            let started: i64 = row.get("started_at")?;
            let last: Option<i64> = row.get("last_activity_at")?;
            Ok((started, last))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|(started, last)| {
            let mut m = Map::new();
            m.insert("startedAt".into(), Value::from(started));
            m.insert(
                "lastActivityAt".into(),
                Value::from(last.unwrap_or(started)),
            );
            Value::Object(m)
        })
        .collect();
    Ok(Value::Array(out))
}

/// Port of `listArtifactRows`: the `kind = 'artifact'` node rows in insertion order (`order by id`).
pub fn list_artifact_rows(conn: &Connection, run_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare("select * from dwf_node where run_id = ?1 and kind = 'artifact' order by id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], read_node_cols)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    rows.iter()
        .map(decode_node_cols)
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

/// Port of `listWorldNodes`: world-read / world-run node rows in insertion order, WITHOUT parsing
/// `result_json` (the body is read elsewhere by `(siteId, ordinal)`). Result size/count/exitCode
/// are computed by SQLite JSON functions and appended as absent-when-NULL keys.
pub fn list_world_nodes(conn: &Connection, run_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "
      select
        run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, input_hash,
        status, error_json, stats_json, message_boundary, artifact_id, input_json,
        length(cast(result_json as blob)) as result_bytes,
        case when json_type(result_json) = 'array' then json_array_length(result_json) end
          as result_count,
        case when json_type(result_json) = 'object' then json_extract(result_json, '$.exitCode') end
          as exit_code,
        case when json_type(result_json) = 'object'
          then length(cast(json_extract(result_json, '$.stdout') as blob)) end as stdout_bytes,
        case when json_type(result_json) = 'object'
          then length(cast(json_extract(result_json, '$.stderr') as blob)) end as stderr_bytes,
        time_created, time_updated
      from dwf_node
      where run_id = ?1 and kind in ('world-read', 'world-run')
      order by id
      ",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], read_world_cols)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let out = rows
        .into_iter()
        .map(world_row_to_value)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(out))
}

/// Port of `listArtifactItems`: `report` events feeding a preset artifact, paged ascending by
/// journal `sequence`. `limit <= 0` → `[]`. Returns `{ sequence, siteId, ordinal, item }` (key order
/// matches the TS literal).
pub fn list_artifact_items(
    conn: &Connection,
    run_id: &str,
    artifact_id: &str,
    query: &Value,
) -> Result<Value, String> {
    let limit = query.get("limit").and_then(Value::as_i64).unwrap_or(0);
    if limit <= 0 {
        return Ok(Value::Array(Vec::new()));
    }
    let after = query.get("afterSequence").and_then(Value::as_i64);
    let cursor = match after {
        Some(_) => " and sequence > ?",
        None => "",
    };
    let sql = format!(
        "
      select sequence, payload_json from dwf_event
      where run_id = ?
        and type = 'report'
        and json_extract(payload_json, '$.artifactId') = ?{cursor}
      order by sequence
      limit ?
      "
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let read_pair = |row: &Row<'_>| -> rusqlite::Result<(i64, String)> {
        Ok((row.get("sequence")?, row.get("payload_json")?))
    };
    let collected = match after {
        Some(a) => stmt
            .query_map(params![run_id, artifact_id, a, limit], read_pair)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map(params![run_id, artifact_id, limit], read_pair)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
    };
    let out = collected
        .into_iter()
        .map(|(sequence, payload)| -> Result<Value, String> {
            let parsed: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
            let instance = parsed.get("instance");
            let mut m = Map::new();
            m.insert("sequence".into(), Value::from(sequence));
            m.insert(
                "siteId".into(),
                instance
                    .and_then(|i| i.get("siteId"))
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            m.insert(
                "ordinal".into(),
                instance
                    .and_then(|i| i.get("ordinal"))
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            m.insert(
                "item".into(),
                parsed.get("item").cloned().unwrap_or(Value::Null),
            );
            Ok(Value::Object(m))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(out))
}

// ---------------------------------------------------------------------------
// N-API boundaries (read-only open; reads never touch the clock)
// ---------------------------------------------------------------------------

/// N-API: `getRun`. Returns the `RunRecord` JSON, or `"null"` for an unknown run.
#[napi]
pub fn dwf_get_run_json(db_path: String, run_id: String) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = get_run(&conn, &run_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `getActor`. Returns the `ActorRecord` JSON, or `"null"`.
#[napi]
pub fn dwf_get_actor_json(
    db_path: String,
    run_id: String,
    site_id: String,
    ordinal: f64,
) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = get_actor(&conn, &run_id, &site_id, ordinal as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listActors`. Returns a JSON array.
#[napi]
pub fn dwf_list_actors_json(db_path: String, run_id: String) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = list_actors(&conn, &run_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `getNode`. Returns the `NodeRecord` JSON, or `"null"`.
#[napi]
pub fn dwf_get_node_json(
    db_path: String,
    run_id: String,
    site_id: String,
    ordinal: f64,
) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = get_node(&conn, &run_id, &site_id, ordinal as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listNodes`. Returns a JSON array.
#[napi]
pub fn dwf_list_nodes_json(db_path: String, run_id: String) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = list_nodes(&conn, &run_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listEvents`. `opts_json` = `{ afterSequence?, limit? }` or `""`/`"null"` for none.
/// Unknown run / out-of-range cursor → `"[]"` (no throw).
#[napi]
pub fn dwf_list_events_json(
    db_path: String,
    run_id: String,
    opts_json: String,
) -> napi::Result<String> {
    let opts: Option<Value> = if opts_json.is_empty() {
        None
    } else {
        let v: Value =
            serde_json::from_str(&opts_json).map_err(|e| Error::from_reason(e.to_string()))?;
        if v.is_null() {
            None
        } else {
            Some(v)
        }
    };
    let conn = crate::open_readonly(&db_path)?;
    let value = list_events(&conn, &run_id, opts.as_ref()).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listNonTerminalRuns`. Returns a JSON array of full `RunRecord`s.
#[napi]
pub fn dwf_list_non_terminal_runs_json(
    db_path: String,
    parent_session_id: String,
) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = list_non_terminal_runs(&conn, &parent_session_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listRuns`. `query_json` = `{ cwd?, limit, statuses?, name? }`. Returns a JSON array.
#[napi]
pub fn dwf_list_runs_json(db_path: String, query_json: String) -> napi::Result<String> {
    let query: Value =
        serde_json::from_str(&query_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readonly(&db_path)?;
    let value = list_runs(&conn, &query).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listRunsByParentSession`. Returns a JSON array of session enum rows.
#[napi]
pub fn dwf_list_runs_by_parent_session_json(
    db_path: String,
    parent_session_id: String,
    limit: f64,
) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = list_runs_by_parent_session(&conn, &parent_session_id, limit as i64)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `getRunRow`. Returns the detail row JSON, or `"null"`.
#[napi]
pub fn dwf_get_run_row_json(db_path: String, run_id: String) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = get_run_row(&conn, &run_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `countNodesByStatus`. Returns `{ running, completed, failed }`.
#[napi]
pub fn dwf_count_nodes_by_status_json(db_path: String, run_id: String) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = count_nodes_by_status(&conn, &run_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listRecentLogEvents`. Returns a JSON array in ascending sequence.
#[napi]
pub fn dwf_list_recent_log_events_json(
    db_path: String,
    run_id: String,
    limit: f64,
) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = list_recent_log_events(&conn, &run_id, limit as i64).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listRunLifeSpans`. Returns a JSON array of `{ startedAt, lastActivityAt }`.
#[napi]
pub fn dwf_list_run_life_spans_json(db_path: String, run_id: String) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = list_run_life_spans(&conn, &run_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listArtifactRows`. Returns a JSON array of artifact `NodeRecord`s.
#[napi]
pub fn dwf_list_artifact_rows_json(db_path: String, run_id: String) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = list_artifact_rows(&conn, &run_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listWorldNodes`. Returns a JSON array of world-read / world-run rows.
#[napi]
pub fn dwf_list_world_nodes_json(db_path: String, run_id: String) -> napi::Result<String> {
    let conn = crate::open_readonly(&db_path)?;
    let value = list_world_nodes(&conn, &run_id).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

/// N-API: `listArtifactItems`. `query_json` = `{ afterSequence?, limit }`. Returns a JSON array.
#[napi]
pub fn dwf_list_artifact_items_json(
    db_path: String,
    run_id: String,
    artifact_id: String,
    query_json: String,
) -> napi::Result<String> {
    let query: Value =
        serde_json::from_str(&query_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readonly(&db_path)?;
    let value =
        list_artifact_items(&conn, &run_id, &artifact_id, &query).map_err(Error::from_reason)?;
    serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_journal::{append_event, create_run, put_node};
    use serde_json::json;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("invariant: open in-memory db");
        conn.execute("PRAGMA foreign_keys = ON", [])
            .expect("invariant: enable fk");
        crate::session_bootstrap::run_session_migrations_in_tx(&conn, 1_000)
            .expect("invariant: apply session schema");
        conn
    }

    fn seed_run(conn: &Connection, id: &str, parent: Option<&str>) {
        create_run(
            conn,
            &json!({
                "runId": id, "parentSessionId": parent, "caps": { "maxConcurrency": 4 },
                "spentTokens": 0, "status": "running", "cwd": "/c"
            }),
            1000,
        )
        .expect("seed run");
    }

    #[test]
    fn get_run_absent_returns_null() {
        let conn = db();
        assert!(get_run(&conn, "nope").expect("read").is_null());
        seed_run(&conn, "r1", Some("s1"));
        let run = get_run(&conn, "r1").expect("read");
        assert_eq!(run["runId"], json!("r1"));
        assert_eq!(run["status"], json!("running"));
        assert_eq!(run["caps"], json!({ "maxConcurrency": 4 }));
        assert!(run.get("result").is_none(), "absent result omitted");
    }

    #[test]
    fn list_events_pushes_cursor_and_limit_to_sql() {
        let conn = db();
        seed_run(&conn, "r1", Some("s1"));
        for i in 0..5i64 {
            append_event(
                &conn,
                "r1",
                &json!({ "type": "log", "message": format!("m{i}") }).to_string(),
                100 + i,
            )
            .expect("append");
        }
        // No opts → all 5, ascending from 0.
        let all = list_events(&conn, "r1", None).expect("all");
        assert_eq!(all.as_array().unwrap().len(), 5);
        assert_eq!(all[0]["sequence"], json!(0));
        // afterSequence = 2 → strictly-greater (3, 4).
        let after = list_events(&conn, "r1", Some(&json!({ "afterSequence": 2 }))).expect("after");
        let seqs: Vec<i64> = after
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["sequence"].as_i64().unwrap())
            .collect();
        assert_eq!(seqs, vec![3, 4]);
        // limit = 1 → first event only.
        let lim = list_events(&conn, "r1", Some(&json!({ "limit": 1 }))).expect("limit");
        assert_eq!(lim.as_array().unwrap().len(), 1);
        // Out-of-range cursor → [] (no throw).
        let oob = list_events(&conn, "r1", Some(&json!({ "afterSequence": 999 }))).expect("oob");
        assert_eq!(oob.as_array().unwrap().len(), 0);
        // Unknown run → [] (no throw).
        let unknown = list_events(&conn, "ghost", None).expect("unknown");
        assert_eq!(unknown.as_array().unwrap().len(), 0);
    }

    #[test]
    fn list_runs_status_empty_and_limit_guards() {
        let conn = db();
        seed_run(&conn, "r1", Some("s1"));
        // Empty status set → [] (not "no filter").
        let empty = list_runs(&conn, &json!({ "limit": 10, "statuses": [] })).expect("runs");
        assert_eq!(empty.as_array().unwrap().len(), 0);
        // limit <= 0 → [].
        let zero = list_runs(&conn, &json!({ "limit": 0 })).expect("runs");
        assert_eq!(zero.as_array().unwrap().len(), 0);
        // cwd literal match + status filter (running).
        let got = list_runs(
            &conn,
            &json!({ "cwd": "/c", "limit": 10, "statuses": ["running"] }),
        )
        .expect("got");
        assert_eq!(got.as_array().unwrap().len(), 1);
        // A list item omits failure/result and carries timeCreated/timeUpdated.
        let item = &got[0];
        assert!(item.get("result").is_none() && item.get("failure").is_none());
        assert_eq!(item["timeCreated"], json!(1000));
    }

    #[test]
    fn list_runs_stopped_vs_errored_disambiguated_in_sql() {
        let conn = db();
        // errored run (physical failed + non-Interrupted code).
        create_run(
            &conn,
            &json!({
                "runId": "e1", "caps": { "maxConcurrency": 1 }, "spentTokens": 0,
                "status": "errored", "failure": { "code": "Boom" }, "cwd": "/c"
            }),
            1000,
        )
        .expect("errored");
        // stopped-via-Interrupted run (physical failed + Interrupted).
        create_run(
            &conn,
            &json!({
                "runId": "i1", "caps": { "maxConcurrency": 1 }, "spentTokens": 0,
                "status": "errored", "failure": { "code": "Interrupted" }, "cwd": "/c"
            }),
            1000,
        )
        .expect("interrupted");
        let errored =
            list_runs(&conn, &json!({ "limit": 10, "statuses": ["errored"] })).expect("errored");
        assert_eq!(
            errored.as_array().unwrap().len(),
            1,
            "only Boom counts as errored"
        );
        assert_eq!(errored[0]["runId"], json!("e1"));
        let stopped =
            list_runs(&conn, &json!({ "limit": 10, "statuses": ["stopped"] })).expect("stopped");
        assert_eq!(
            stopped.as_array().unwrap().len(),
            1,
            "Interrupted resolves to stopped"
        );
    }

    #[test]
    fn count_nodes_three_keys_always_present() {
        let conn = db();
        seed_run(&conn, "r1", Some("s1"));
        let counts = count_nodes_by_status(&conn, "r1").expect("counts");
        assert_eq!(counts, json!({ "running": 0, "completed": 0, "failed": 0 }));
        put_node(
            &conn,
            &json!({
                "runId": "r1", "siteId": "n", "ordinal": 0, "kind": "ask",
                "inputHash": "h", "status": "completed"
            }),
            1500,
        )
        .expect("node");
        let counts2 = count_nodes_by_status(&conn, "r1").expect("counts2");
        assert_eq!(counts2["completed"], json!(1));
    }

    #[test]
    fn list_recent_log_events_ascending_tail() {
        let conn = db();
        seed_run(&conn, "r1", Some("s1"));
        for i in 0..4i64 {
            append_event(
                &conn,
                "r1",
                &json!({ "type": "log", "message": format!("l{i}") }).to_string(),
                200 + i,
            )
            .expect("append");
        }
        append_event(
            &conn,
            "r1",
            &json!({ "type": "run-started", "runId": "r1", "caps": { "maxConcurrency": 1 } })
                .to_string(),
            210,
        )
        .expect("append started");
        // Last 2 log events, returned ascending.
        let recent = list_recent_log_events(&conn, "r1", 2).expect("recent");
        let arr = recent.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(
            arr[0]["event"]["message"],
            json!("l2"),
            "oldest-of-tail first"
        );
        assert_eq!(arr[1]["event"]["message"], json!("l3"));
        // limit <= 0 → [].
        assert_eq!(
            list_recent_log_events(&conn, "r1", 0)
                .expect("zero")
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn list_run_life_spans_from_events() {
        let conn = db();
        seed_run(&conn, "r1", Some("s1"));
        append_event(
            &conn,
            "r1",
            &json!({ "type": "run-started", "runId": "r1", "caps": { "maxConcurrency": 1 } })
                .to_string(),
            300,
        )
        .expect("started");
        append_event(
            &conn,
            "r1",
            &json!({ "type": "log", "message": "x" }).to_string(),
            350,
        )
        .expect("log");
        let spans = list_run_life_spans(&conn, "r1").expect("spans");
        let arr = spans.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["startedAt"], json!(300));
        assert_eq!(
            arr[0]["lastActivityAt"],
            json!(350),
            "life ends at last event"
        );
    }

    #[test]
    fn list_world_nodes_omits_result_and_adds_bytes() {
        let conn = db();
        seed_run(&conn, "r1", Some("s1"));
        put_node(
            &conn,
            &json!({
                "runId": "r1", "siteId": "w", "ordinal": 0, "kind": "world-run",
                "inputHash": "h", "status": "completed",
                "input": { "op": "run", "args": ["echo"] },
                "result": { "exitCode": 0, "stdout": "hello", "stderr": "" }
            }),
            1500,
        )
        .expect("world node");
        let nodes = list_world_nodes(&conn, "r1").expect("world");
        let arr = nodes.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert!(
            arr[0].get("result").is_none(),
            "world list never carries result body"
        );
        assert_eq!(arr[0]["exitCode"], json!(0));
        assert_eq!(arr[0]["stdoutBytes"], json!(5), "hello = 5 bytes");
        assert_eq!(
            arr[0]["stderrBytes"],
            json!(0),
            "empty string still counted (0 bytes)"
        );
        assert_eq!(arr[0]["input"], json!({ "op": "run", "args": ["echo"] }));
    }

    #[test]
    fn list_artifact_items_filters_reports_by_artifact_id() {
        let conn = db();
        seed_run(&conn, "r1", Some("s1"));
        append_event(
            &conn,
            "r1",
            &json!({
                "type": "report", "instance": { "siteId": "s", "ordinal": 3 },
                "item": { "v": 1 }, "artifactId": "perf"
            })
            .to_string(),
            400,
        )
        .expect("report tagged");
        append_event(
            &conn,
            "r1",
            &json!({ "type": "report", "instance": { "siteId": "s", "ordinal": 4 }, "item": { "v": 2 } })
                .to_string(),
            401,
        )
        .expect("report untagged");
        let items =
            list_artifact_items(&conn, "r1", "perf", &json!({ "limit": 10 })).expect("items");
        let arr = items.as_array().unwrap();
        assert_eq!(arr.len(), 1, "only the tagged report for `perf`");
        assert_eq!(arr[0]["ordinal"], json!(3));
        assert_eq!(arr[0]["item"], json!({ "v": 1 }));
        assert_eq!(arr[0]["siteId"], json!("s"));
        // limit <= 0 → [].
        assert_eq!(
            list_artifact_items(&conn, "r1", "perf", &json!({ "limit": 0 }))
                .expect("zero")
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn get_node_and_actor_return_null_for_absent() {
        let conn = db();
        assert!(get_node(&conn, "r", "s", 0).expect("node").is_null());
        assert!(get_actor(&conn, "r", "s", 0).expect("actor").is_null());
        assert!(get_run_row(&conn, "r").expect("row").is_null());
    }
}
