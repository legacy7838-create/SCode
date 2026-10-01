//! dwf-journal — the **synchronous** surface of `zcode-events`
//! (`docs/specs/rust-native-events.md` §14).
//!
//! The domain contract `JournalStorePort` is synchronous by design, so this
//! module exposes synchronous `#[napi]` functions over its own rusqlite
//! connection. SQL is ported verbatim from the deleted
//! `dwf-journal*.ts` repositories; the row ⇄ record codecs stay in TS
//! (row-transport rule §3.3). There is no raw-SQL escape hatch: `exec` takes a
//! closed set of named ops and a JSON payload.

use std::sync::Mutex;

use napi_derive::napi;
use rusqlite::Connection;
use serde_json::Value;

use crate::error::StoreError;
use crate::jsjson::{self, JsValue};
use crate::ops::{self, Ctx};

/// One open journal connection. Owned by one `workflowJournalStore()` call — the
/// same ownership the deleted `DatabaseSync` had.
#[napi]
pub struct DwfJournal {
  conn: Mutex<Option<Connection>>,
  db_path: String,
}

#[napi]
impl DwfJournal {
  /// Sync open: `foreign_keys = on`, `busy_timeout = 5000` (legacy
  /// `new DatabaseSync(path, { timeout: 5_000 })` + `pragma foreign_keys = on`).
  #[napi(constructor)]
  pub fn new(db_path: String) -> napi::Result<Self> {
    let conn = Connection::open(&db_path).map_err(|error| {
      StoreError::from(error)
        .with_kind("open_failed")
        .with_db_path(&db_path)
        .into_napi()
    })?;
    conn.execute_batch("pragma foreign_keys = on")
      .map_err(|error| StoreError::from(error).into_napi())?;
    conn.execute_batch("pragma busy_timeout = 5000")
      .map_err(|error| StoreError::from(error).into_napi())?;
    Ok(DwfJournal {
      conn: Mutex::new(Some(conn)),
      db_path,
    })
  }

  /// One named journal op. Payload and result are JSON strings: writes return
  /// `"null"` (or a scalar as documented), reads return a row array.
  #[napi]
  pub fn exec(&self, op: String, payload: String) -> napi::Result<String> {
    let parsed = jsjson::parse(&payload).map_err(StoreError::into_napi)?;
    let guard = self.conn.lock().unwrap_or_else(|error| error.into_inner());
    let conn = guard.as_ref().ok_or_else(|| {
      StoreError::op("dwf journal: connection is closed").into_napi()
    })?;
    let ctx = Ctx { conn };
    dispatch(&ctx, &op, &parsed, &self.db_path).map_err(StoreError::into_napi)
  }

  /// Sync close: releases the connection (no I/O beyond the drop).
  #[napi]
  pub fn close(&self) {
    let mut guard = self.conn.lock().unwrap_or_else(|error| error.into_inner());
    *guard = None;
  }
}

// ── payload helpers ──────────────────────────────────────────────────────────

fn opt_i64(payload: &JsValue, key: &str) -> Result<Option<i64>, StoreError> {
  match payload.get(key) {
    None | Some(JsValue::Null) => Ok(None),
    Some(value) => value
      .as_i64()
      .map(Some)
      .ok_or_else(|| StoreError::op(format!("expected integer or null for `{}`", key))),
  }
}

fn row_json(ctx: &Ctx, sql: &str, values: &[JsValue]) -> Result<String, StoreError> {
  match ops::query_row(ctx, sql, values)? {
    Some(value) => Ok(serde_json::to_string(&value)?),
    None => Ok("null".to_string()),
  }
}

fn assert_run_touched(changes: usize, run_id: &str) -> Result<(), StoreError> {
  if changes == 0 {
    return Err(StoreError::op(format!("dwf journal: unknown run: {}", run_id)));
  }
  Ok(())
}

/// Logical status filter → SQL predicate (ported from
/// `encodeRunStatusPredicate`, `dwf-journal-codecs.ts`). Returns the predicate
/// plus its parameters in order.
fn run_status_predicate(statuses: &[String]) -> (String, Vec<JsValue>) {
  let mut clauses: Vec<&str> = Vec::new();
  let mut params: Vec<JsValue> = Vec::new();
  for status in statuses {
    match status.as_str() {
      "stopped" => {
        clauses.push(
          "(status = 'cancelled' or (status = 'failed' and json_extract(failure_json, '$.code') = ?))",
        );
        params.push(ops::js_str("Interrupted"));
      }
      "errored" => {
        clauses.push(
          "(status = 'failed' and coalesce(json_extract(failure_json, '$.code'), '') <> ?)",
        );
        params.push(ops::js_str("Interrupted"));
      }
      other => {
        clauses.push("status = ?");
        params.push(ops::js_str(other));
      }
    }
  }
  if clauses.is_empty() {
    ("0".to_string(), params)
  } else {
    (format!("({})", clauses.join(" or ")), params)
  }
}

/// The `listRuns` payload's logical statuses, if present.
fn opt_statuses(payload: &JsValue) -> Result<Option<Vec<String>>, StoreError> {
  match payload.get("statuses") {
    None | Some(JsValue::Null) => Ok(None),
    Some(value) => {
      let items = value
        .as_array()
        .ok_or_else(|| StoreError::op("expected an array for `statuses`"))?;
      let mut out = Vec::with_capacity(items.len());
      for item in items {
        out.push(
          item
            .as_str()
            .ok_or_else(|| StoreError::op("expected a string status"))?,
        );
      }
      Ok(Some(out))
    }
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────────

pub fn dispatch(
  ctx: &Ctx,
  op: &str,
  payload: &JsValue,
  db_path: &str,
) -> Result<String, StoreError> {
  match op {
    // ── writes ────────────────────────────────────────────────────────────
    "createRun" => create_run(ctx, payload),
    "updateRunStatus" => update_run_status(ctx, payload),
    "updateRunUsage" => update_run_usage(ctx, payload),
    "updateRunCaps" => update_run_caps(ctx, payload),
    "putActor" => put_actor(ctx, payload),
    "putNode" => put_node(ctx, payload),
    "appendEvent" => append_event(ctx, payload),
    // ── run reads ─────────────────────────────────────────────────────────
    "getRun" => get_run(ctx, payload),
    "listNonTerminalRuns" => list_non_terminal_runs(ctx, payload),
    "listRuns" => list_runs(ctx, payload),
    "getRunRow" => get_run_row(ctx, payload),
    "countNodesByStatus" => count_nodes_by_status(ctx, payload),
    "listRecentLogEvents" => list_recent_log_events(ctx, payload),
    "listRunLifeSpans" => list_run_life_spans(ctx, payload),
    "listRunsByParentSession" => list_runs_by_parent_session(ctx, payload),
    // ── actor / node reads ────────────────────────────────────────────────
    "getActor" => get_actor(ctx, payload),
    "listActors" => list_actors(ctx, payload),
    "getNode" => get_node(ctx, payload),
    "listNodes" => list_nodes(ctx, payload),
    // ── artifact / world reads ────────────────────────────────────────────
    "listArtifactRows" => list_artifact_rows(ctx, payload),
    "listWorldNodes" => list_world_nodes(ctx, payload),
    "listArtifactItems" => list_artifact_items(ctx, payload),
    // ── event reads ───────────────────────────────────────────────────────
    "listEvents" => list_events(ctx, payload),
    other => Err(
      StoreError::op(format!("dwf journal: unknown op `{}`", other)).with_db_path(db_path),
    ),
  }
}

// ── writes ───────────────────────────────────────────────────────────────────

fn create_run(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  const SQL: &str = "
    insert into dwf_run (
      id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
      args_json, resumed_from, caps_max_concurrency,
      spent_tokens, status, failure_json, result_json, time_created, time_updated
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ";
  let run_id = ops::req_str(payload, "runId")?;
  let values = vec![
    ops::js_str(&run_id),
    opt_str_or_null(payload, "parentSessionId")?,
    opt_str_or_null(payload, "cwd")?,
    opt_str_or_null(payload, "name")?,
    opt_str_or_null(payload, "scriptText")?,
    opt_str_or_null(payload, "scriptHash")?,
    opt_str_or_null(payload, "toolCallId")?,
    opt_str_or_null(payload, "argsJson")?,
    opt_str_or_null(payload, "resumedFrom")?,
    ops::js_i64(ops::req_i64(payload, "capsMaxConcurrency")?),
    ops::js_i64(ops::req_i64(payload, "spentTokens")?),
    ops::js_str(&ops::req_str(payload, "physicalStatus")?),
    opt_str_or_null(payload, "failureJson")?,
    opt_str_or_null(payload, "resultJson")?,
    ops::js_i64(ops::req_i64(payload, "now")?),
    ops::js_i64(ops::req_i64(payload, "now")?),
  ];
  if let Err(error) = ops::execute(ctx, SQL, &values) {
    // Duplicate runs are contract errors on the caller's part and deserve a
    // directly readable message; other failures are rethrown as-is (legacy).
    if get_run_exists(ctx, &run_id)? {
      return Err(StoreError::op(format!(
        "dwf journal: run already exists: {}",
        run_id
      )));
    }
    return Err(error);
  }
  Ok("null".to_string())
}

fn get_run_exists(ctx: &Ctx, run_id: &str) -> Result<bool, StoreError> {
  let rows = ops::query_row(
    ctx,
    "select id from dwf_run where id = ?",
    &[ops::js_str(run_id)],
  )?;
  Ok(rows.is_some())
}

fn update_run_status(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let run_id = ops::req_str(payload, "runId")?;
  let physical_status = ops::req_str(payload, "physicalStatus")?;
  let now = ops::req_i64(payload, "now")?;
  let changes = if physical_status == "pending" || physical_status == "running" {
    // Non-final state = None settlement: clearing failure_json / result_json
    // (legacy comment in dwf-journal.ts:updateRunStatus).
    ops::execute_changes(
      ctx,
      "
      update dwf_run set
        status = ?,
        failure_json = null,
        result_json = null,
        time_updated = ?
      where id = ?
      ",
      &[
        ops::js_str(&physical_status),
        ops::js_i64(now),
        ops::js_str(&run_id),
      ],
    )?
  } else {
    ops::execute_changes(
      ctx,
      "
      update dwf_run set
        status = ?,
        failure_json = ?,
        result_json = coalesce(?, result_json),
        time_updated = ?
      where id = ?
      ",
      &[
        ops::js_str(&physical_status),
        opt_str_or_null(payload, "failureJson")?,
        opt_str_or_null(payload, "resultJson")?,
        ops::js_i64(now),
        ops::js_str(&run_id),
      ],
    )?
  };
  assert_run_touched(changes, &run_id)?;
  Ok("null".to_string())
}

fn update_run_usage(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let run_id = ops::req_str(payload, "runId")?;
  let changes = ops::execute_changes(
    ctx,
    "update dwf_run set spent_tokens = ?, time_updated = ? where id = ?",
    &[
      ops::js_i64(ops::req_i64(payload, "spentTokens")?),
      ops::js_i64(ops::req_i64(payload, "now")?),
      ops::js_str(&run_id),
    ],
  )?;
  assert_run_touched(changes, &run_id)?;
  Ok("null".to_string())
}

fn update_run_caps(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let run_id = ops::req_str(payload, "runId")?;
  let changes = ops::execute_changes(
    ctx,
    "update dwf_run set caps_max_concurrency = ?, time_updated = ? where id = ?",
    &[
      ops::js_i64(ops::req_i64(payload, "maxConcurrency")?),
      ops::js_i64(ops::req_i64(payload, "now")?),
      ops::js_str(&run_id),
    ],
  )?;
  assert_run_touched(changes, &run_id)?;
  Ok("null".to_string())
}

fn put_actor(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  const SQL: &str = "
    insert into dwf_actor (
      run_id, site_id, ordinal, name, persona_json, session_id, resolved_model,
      time_created, time_updated
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(run_id, site_id, ordinal) do update set
      name = excluded.name,
      persona_json = excluded.persona_json,
      session_id = excluded.session_id,
      resolved_model = excluded.resolved_model,
      time_updated = excluded.time_updated
  ";
  let now = ops::req_i64(payload, "now")?;
  ops::execute(
    ctx,
    SQL,
    &[
      ops::js_str(&ops::req_str(payload, "runId")?),
      ops::js_str(&ops::req_str(payload, "siteId")?),
      ops::js_i64(ops::req_i64(payload, "ordinal")?),
      opt_str_or_null(payload, "name")?,
      opt_str_or_null(payload, "personaJson")?,
      opt_str_or_null(payload, "sessionId")?,
      opt_str_or_null(payload, "resolvedModel")?,
      ops::js_i64(now),
      ops::js_i64(now),
    ],
  )?;
  Ok("null".to_string())
}

fn put_node(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  const SQL: &str = "
    insert into dwf_node (
      run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq,
      input_hash, status, result_json, error_json, stats_json, message_boundary,
      artifact_id, input_json, time_created, time_updated
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      time_updated = excluded.time_updated
  ";
  let now = ops::req_i64(payload, "now")?;
  ops::execute(
    ctx,
    SQL,
    &[
      ops::js_str(&ops::req_str(payload, "runId")?),
      ops::js_str(&ops::req_str(payload, "siteId")?),
      ops::js_i64(ops::req_i64(payload, "ordinal")?),
      ops::js_str(&ops::req_str(payload, "kind")?),
      opt_str_or_null(payload, "actorSiteId")?,
      opt_i64(payload, "actorOrdinal")?
        .map(ops::js_i64)
        .unwrap_or(JsValue::Null),
      opt_i64(payload, "actorSeq")?.map(ops::js_i64).unwrap_or(JsValue::Null),
      ops::js_str(&ops::req_str(payload, "inputHash")?),
      ops::js_str(&ops::req_str(payload, "status")?),
      opt_str_or_null(payload, "resultJson")?,
      opt_str_or_null(payload, "errorJson")?,
      opt_str_or_null(payload, "statsJson")?,
      opt_i64(payload, "messageBoundary")?
        .map(ops::js_i64)
        .unwrap_or(JsValue::Null),
      opt_str_or_null(payload, "artifactId")?,
      opt_str_or_null(payload, "inputJson")?,
      ops::js_i64(now),
      ops::js_i64(now),
    ],
  )?;
  Ok("null".to_string())
}

fn append_event(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  const SQL: &str = "
    insert into dwf_event (run_id, sequence, type, payload_json, time_created)
    values (
      ?,
      coalesce((select max(sequence) + 1 from dwf_event where run_id = ?), 0),
      ?, ?, ?
    )
    returning sequence
  ";
  let run_id = ops::req_str(payload, "runId")?;
  let row = ops::query_row(
    ctx,
    SQL,
    &[
      ops::js_str(&run_id),
      ops::js_str(&run_id),
      ops::js_str(&ops::req_str(payload, "eventType")?),
      ops::js_str(&ops::req_str(payload, "eventJson")?),
      ops::js_i64(ops::req_i64(payload, "timeCreated")?),
    ],
  )?;
  let sequence = row
    .as_ref()
    .and_then(|value| value.get("sequence"))
    .and_then(Value::as_i64)
    .ok_or_else(|| {
      StoreError::op(format!(
        "dwf journal: event insert returned no sequence for run: {}",
        run_id
      ))
    })?;
  Ok(sequence.to_string())
}

// ── run reads ────────────────────────────────────────────────────────────────

fn get_run(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  row_json(
    ctx,
    "select * from dwf_run where id = ?",
    &[ops::js_str(&ops::req_str(payload, "runId")?)],
  )
}

fn list_non_terminal_runs(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  ops::query_rows(
    ctx,
    "
    select * from dwf_run
    where parent_session_id = ?
      and status not in ('completed', 'failed', 'cancelled')
    order by id
    ",
    &[ops::js_str(&ops::req_str(payload, "parentSessionId")?)],
  )
}

fn list_runs(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let statuses = opt_statuses(payload)?;
  if matches!(&statuses, Some(list) if list.is_empty()) {
    return Ok("[]".to_string());
  }
  let limit = ops::req_i64(payload, "limit")?;
  if limit <= 0 {
    return Ok("[]".to_string());
  }
  let mut sql = String::from(
    "
    select
      id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
      args_json, resumed_from, caps_max_concurrency,
      spent_tokens, status, failure_json, time_created, time_updated
    from dwf_run
    where 1 = 1",
  );
  let mut params: Vec<JsValue> = Vec::new();
  if let Some(cwd) = opt_string(payload, "cwd")? {
    sql.push_str(" and cwd = ?");
    params.push(ops::js_str(&cwd));
  }
  if let Some(statuses) = &statuses {
    let (predicate, mut status_params) = run_status_predicate(statuses);
    sql.push_str(&format!(" and {}", predicate));
    params.append(&mut status_params);
  }
  if let Some(name) = opt_string(payload, "name")? {
    sql.push_str(" and name = ?");
    params.push(ops::js_str(&name));
  }
  sql.push_str(" order by time_updated desc limit ?");
  params.push(ops::js_i64(limit));
  ops::query_rows(ctx, &sql, &params)
}

fn get_run_row(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  row_json(
    ctx,
    "select * from dwf_run where id = ?",
    &[ops::js_str(&ops::req_str(payload, "runId")?)],
  )
}

fn count_nodes_by_status(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  ops::query_rows(
    ctx,
    "select status, count(*) as total from dwf_node where run_id = ? group by status",
    &[ops::js_str(&ops::req_str(payload, "runId")?)],
  )
}

fn list_recent_log_events(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let limit = ops::req_i64(payload, "limit")?;
  if limit <= 0 {
    return Ok("[]".to_string());
  }
  // The legacy body fetched `order by sequence desc` and reversed in JS; the
  // enclosing ascending order is the same total order (unique(run_id, sequence)).
  ops::query_rows(
    ctx,
    "
    select * from (
      select * from dwf_event
      where run_id = ? and type = 'log'
      order by sequence desc
      limit ?
    ) order by sequence
    ",
    &[
      ops::js_str(&ops::req_str(payload, "runId")?),
      ops::js_i64(limit),
    ],
  )
}

fn list_run_life_spans(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let run_id = ops::req_str(payload, "runId")?;
  ops::query_rows(
    ctx,
    "
    with lives as (
      select sequence, time_created,
             lead(sequence) over (order by sequence) as next_sequence
      from dwf_event
      where run_id = ? and type = 'run-started'
    )
    select
      l.time_created as started_at,
      (
        select e.time_created
        from dwf_event e
        where e.run_id = ?
          and e.sequence >= l.sequence
          and (l.next_sequence is null or e.sequence < l.next_sequence)
        order by e.sequence desc
        limit 1
      ) as last_activity_at
    from lives l
    order by l.sequence
    ",
    &[ops::js_str(&run_id), ops::js_str(&run_id)],
  )
}

fn list_runs_by_parent_session(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let limit = ops::req_i64(payload, "limit")?.max(0);
  ops::query_rows(
    ctx,
    "
    select
      id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
      args_json, resumed_from, caps_max_concurrency,
      spent_tokens, status, failure_json, time_created, time_updated
    from dwf_run
    where parent_session_id = ?
    order by time_updated desc, id desc
    limit ?
    ",
    &[
      ops::js_str(&ops::req_str(payload, "parentSessionId")?),
      ops::js_i64(limit),
    ],
  )
}

// ── actor / node reads ───────────────────────────────────────────────────────

fn get_actor(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  row_json(
    ctx,
    "select * from dwf_actor where run_id = ? and site_id = ? and ordinal = ?",
    &[
      ops::js_str(&ops::req_str(payload, "runId")?),
      ops::js_str(&ops::req_str(payload, "siteId")?),
      ops::js_i64(ops::req_i64(payload, "ordinal")?),
    ],
  )
}

fn list_actors(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  ops::query_rows(
    ctx,
    "select * from dwf_actor where run_id = ? order by id",
    &[ops::js_str(&ops::req_str(payload, "runId")?)],
  )
}

fn get_node(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  row_json(
    ctx,
    "select * from dwf_node where run_id = ? and site_id = ? and ordinal = ?",
    &[
      ops::js_str(&ops::req_str(payload, "runId")?),
      ops::js_str(&ops::req_str(payload, "siteId")?),
      ops::js_i64(ops::req_i64(payload, "ordinal")?),
    ],
  )
}

fn list_nodes(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  ops::query_rows(
    ctx,
    "select * from dwf_node where run_id = ? order by id",
    &[ops::js_str(&ops::req_str(payload, "runId")?)],
  )
}

// ── artifact / world reads ───────────────────────────────────────────────────

fn list_artifact_rows(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  ops::query_rows(
    ctx,
    "select * from dwf_node where run_id = ? and kind = 'artifact' order by id",
    &[ops::js_str(&ops::req_str(payload, "runId")?)],
  )
}

fn list_world_nodes(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  ops::query_rows(
    ctx,
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
    where run_id = ? and kind in ('world-read', 'world-run')
    order by id
    ",
    &[ops::js_str(&ops::req_str(payload, "runId")?)],
  )
}

fn list_artifact_items(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let limit = ops::req_i64(payload, "limit")?;
  if limit <= 0 {
    return Ok("[]".to_string());
  }
  let after = opt_i64(payload, "afterSequence")?;
  let cursor = if after.is_some() {
    " and sequence > ?"
  } else {
    ""
  };
  let sql = format!(
    "
    select sequence, payload_json from dwf_event
    where run_id = ?
      and type = 'report'
      and json_extract(payload_json, '$.artifactId') = ?{}
    order by sequence
    limit ?
    ",
    cursor
  );
  let mut params = vec![
    ops::js_str(&ops::req_str(payload, "runId")?),
    ops::js_str(&ops::req_str(payload, "artifactId")?),
  ];
  if let Some(after) = after {
    params.push(ops::js_i64(after));
  }
  params.push(ops::js_i64(limit));
  ops::query_rows(ctx, &sql, &params)
}

// ── event reads ──────────────────────────────────────────────────────────────

fn list_events(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let run_id = ops::req_str(payload, "runId")?;
  let after = opt_i64(payload, "afterSequence")?;
  let limit = opt_i64(payload, "limit")?;
  let (where_clause, mut params) = match after {
    Some(after) => (
      "run_id = ? and sequence > ?",
      vec![ops::js_str(&run_id), ops::js_i64(after)],
    ),
    None => ("run_id = ?", vec![ops::js_str(&run_id)]),
  };
  let sql = format!(
    "select * from dwf_event where {} order by sequence limit ?",
    where_clause
  );
  params.push(ops::js_i64(limit.map(|value| value.max(0)).unwrap_or(-1)));
  ops::query_rows(ctx, &sql, &params)
}

// ── small helpers ────────────────────────────────────────────────────────────

/// `null`/absent → SQL NULL, otherwise TEXT — the shared `encodeJson`/`?? null`
/// shape the TS payload builder applies before calling us.
fn opt_str_or_null(payload: &JsValue, key: &str) -> Result<JsValue, StoreError> {
  match ops::opt_str(payload, key)? {
    Some(text) => Ok(ops::js_str(&text)),
    None => Ok(JsValue::Null),
  }
}

fn opt_string(payload: &JsValue, key: &str) -> Result<Option<String>, StoreError> {
  ops::opt_str(payload, key)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn journal() -> DwfJournal {
    DwfJournal {
      conn: Mutex::new(Some(Connection::open_in_memory().unwrap())),
      db_path: ":memory:".to_string(),
    }
  }

  fn schema(conn: &Connection) {
    conn.execute_batch(
      "
      create table dwf_run (
        id text primary key,
        parent_session_id text,
        cwd text,
        name text,
        script_text text,
        script_hash text,
        tool_call_id text,
        args_json text,
        resumed_from text,
        caps_max_concurrency integer not null default 1,
        spent_tokens integer not null default 0,
        status text not null,
        failure_json text,
        result_json text,
        time_created integer not null,
        time_updated integer not null
      );
      create table dwf_actor (
        id integer primary key autoincrement,
        run_id text not null,
        site_id text not null,
        ordinal integer not null,
        name text,
        persona_json text,
        session_id text,
        resolved_model text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );
      create table dwf_node (
        id integer primary key autoincrement,
        run_id text not null,
        site_id text not null,
        ordinal integer not null,
        kind text not null,
        actor_site_id text,
        actor_ordinal integer,
        actor_seq integer,
        input_hash text not null,
        status text not null,
        result_json text,
        error_json text,
        stats_json text,
        message_boundary integer,
        artifact_id text,
        input_json text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );
      create table dwf_event (
        id integer primary key autoincrement,
        run_id text not null,
        sequence integer not null,
        type text not null,
        payload_json text not null,
        time_created integer not null,
        unique(run_id, sequence)
      );
      ",
    )
    .unwrap();
  }

  fn exec(journal: &DwfJournal, op: &str, payload: &str) -> String {
    let parsed = jsjson::parse(payload).unwrap();
    let guard = journal.conn.lock().unwrap();
    let ctx = Ctx {
      conn: guard.as_ref().unwrap(),
    };
    dispatch(&ctx, op, &parsed, ":memory:").unwrap()
  }

  #[test]
  fn create_run_round_trips_and_rejects_duplicates() {
    let journal = journal();
    schema(journal.conn.lock().unwrap().as_ref().unwrap());
    let created = exec(
      &journal,
      "createRun",
      r#"{"runId":"r1","capsMaxConcurrency":2,"spentTokens":0,"physicalStatus":"running","now":10}"#,
    );
    assert_eq!(created, "null");
    let row = exec(&journal, "getRun", r#"{"runId":"r1"}"#);
    assert!(row.contains("\"id\":\"r1\""));
    assert!(row.contains("\"status\":\"running\""));

    let parsed = jsjson::parse(
      r#"{"runId":"r1","capsMaxConcurrency":2,"spentTokens":0,"physicalStatus":"running","now":11}"#,
    )
    .unwrap();
    let guard = journal.conn.lock().unwrap();
    let ctx = Ctx {
      conn: guard.as_ref().unwrap(),
    };
    let error = dispatch(&ctx, "createRun", &parsed, ":memory:").unwrap_err();
    assert_eq!(error.message, "dwf journal: run already exists: r1");
  }

  #[test]
  fn append_event_allocates_sequences_in_one_statement() {
    let journal = journal();
    schema(journal.conn.lock().unwrap().as_ref().unwrap());
    assert_eq!(
      exec(
        &journal,
        "appendEvent",
        r#"{"runId":"r1","eventType":"log","eventJson":"{\"type\":\"log\"}","timeCreated":1}"#
      ),
      "0"
    );
    assert_eq!(
      exec(
        &journal,
        "appendEvent",
        r#"{"runId":"r1","eventType":"log","eventJson":"{\"type\":\"log\"}","timeCreated":2}"#
      ),
      "1"
    );
    let rows = exec(&journal, "listEvents", r#"{"runId":"r1"}"#);
    assert_eq!(rows.matches("\"sequence\"").count(), 2);
  }

  #[test]
  fn update_status_clears_on_non_final_and_coalesces_result_on_final() {
    let journal = journal();
    schema(journal.conn.lock().unwrap().as_ref().unwrap());
    exec(
      &journal,
      "createRun",
      r#"{"runId":"r1","capsMaxConcurrency":1,"spentTokens":0,"physicalStatus":"running","now":1}"#,
    );
    exec(
      &journal,
      "updateRunStatus",
      r#"{"runId":"r1","physicalStatus":"completed","failureJson":null,"resultJson":"{\"a\":1}","now":2}"#,
    );
    let settled = exec(
      &journal,
      "updateRunStatus",
      r#"{"runId":"r1","physicalStatus":"running","failureJson":null,"resultJson":null,"now":3}"#,
    );
    assert_eq!(settled, "null");
    let row = exec(&journal, "getRun", r#"{"runId":"r1"}"#);
    assert!(row.contains("\"result_json\":null"));
    let missing = {
      let parsed = jsjson::parse(r#"{"runId":"nope","physicalStatus":"completed","failureJson":null,"resultJson":null,"now":1}"#).unwrap();
      let guard = journal.conn.lock().unwrap();
      let ctx = Ctx {
        conn: guard.as_ref().unwrap(),
      };
      dispatch(&ctx, "updateRunStatus", &parsed, ":memory:").unwrap_err()
    };
    assert_eq!(missing.message, "dwf journal: unknown run: nope");
  }
}
