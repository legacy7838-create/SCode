//! usage family — SQL ported verbatim from
//! `adapters/src/storage/session-store/repositories/usage.ts` (lines 20-673).

use super::{execute, js_i64, query_rows, vlist, Ctx};
use crate::error::StoreError;
use crate::jsjson::JsValue;

/// Fixed-offset day bucket width (`DAY_MS`, usage.ts:391).
const DAY_MS: i64 = 86_400_000;

/// Legacy `recordModelUsage` insert (usage.ts:30-120): the database inherits
/// the historical column names created by 0010; the domain layer uses the more
/// accurate reasoningLevel.
const RECORD_MODEL_USAGE_SQL: &str = r#"
      insert into model_usage (
        id,
        logical_request_id,
        attempt_index,
        session_id,
        turn_id,
        trace_id,
        span_id,
        assistant_message_id,
        parent_user_message_id,
        query_source,
        provider_id,
        model_id,
        variant,
        agent,
        mode,
        task_type,
        status,
        started_at,
        first_token_at,
        completed_at,
        duration_ms,
        time_to_first_token_ms,
        finish_reason,
        tool_call_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        provider_total_tokens,
        computed_total_tokens,
        retry_count,
        retryable,
        cancelled_by_user,
        context_exceeded,
        error_type,
        error_code,
        error_message,
        raw_usage_json,
        provider_metadata_json
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      on conflict(id) do update set
        logical_request_id = excluded.logical_request_id,
        attempt_index = excluded.attempt_index,
        session_id = excluded.session_id,
        turn_id = excluded.turn_id,
        trace_id = excluded.trace_id,
        span_id = excluded.span_id,
        assistant_message_id = excluded.assistant_message_id,
        parent_user_message_id = excluded.parent_user_message_id,
        query_source = excluded.query_source,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        variant = excluded.variant,
        agent = excluded.agent,
        mode = excluded.mode,
        task_type = excluded.task_type,
        status = excluded.status,
        started_at = excluded.started_at,
        first_token_at = excluded.first_token_at,
        completed_at = excluded.completed_at,
        duration_ms = excluded.duration_ms,
        time_to_first_token_ms = excluded.time_to_first_token_ms,
        finish_reason = excluded.finish_reason,
        tool_call_count = excluded.tool_call_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        provider_total_tokens = excluded.provider_total_tokens,
        computed_total_tokens = excluded.computed_total_tokens,
        retry_count = excluded.retry_count,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        context_exceeded = excluded.context_exceeded,
        error_type = excluded.error_type,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        raw_usage_json = excluded.raw_usage_json,
        provider_metadata_json = excluded.provider_metadata_json
      "#;

/// Legacy `upsertTurnUsage` insert (usage.ts:167-237).
const UPSERT_TURN_USAGE_SQL: &str = r#"
      insert into turn_usage (
        session_id,
        turn_id,
        trace_id,
        user_message_id,
        status,
        started_at,
        first_model_start_at,
        first_token_at,
        completed_at,
        duration_ms,
        time_to_first_token_ms,
        model_request_count,
        model_retry_count,
        tool_call_count,
        tool_error_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        computed_total_tokens,
        retryable,
        cancelled_by_user,
        context_exceeded,
        error_type,
        error_code
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      on conflict(session_id, turn_id) do update set
        trace_id = coalesce(excluded.trace_id, turn_usage.trace_id),
        user_message_id = coalesce(excluded.user_message_id, turn_usage.user_message_id),
        status = excluded.status,
        started_at = min(turn_usage.started_at, excluded.started_at),
        first_model_start_at = coalesce(turn_usage.first_model_start_at, excluded.first_model_start_at),
        first_token_at = coalesce(turn_usage.first_token_at, excluded.first_token_at),
        completed_at = coalesce(excluded.completed_at, turn_usage.completed_at),
        duration_ms = coalesce(excluded.duration_ms, turn_usage.duration_ms),
        time_to_first_token_ms = coalesce(excluded.time_to_first_token_ms, turn_usage.time_to_first_token_ms),
        model_request_count = excluded.model_request_count,
        model_retry_count = excluded.model_retry_count,
        tool_call_count = excluded.tool_call_count,
        tool_error_count = excluded.tool_error_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        computed_total_tokens = excluded.computed_total_tokens,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        context_exceeded = excluded.context_exceeded,
        error_type = coalesce(excluded.error_type, turn_usage.error_type),
        error_code = coalesce(excluded.error_code, turn_usage.error_code)
      "#;

/// Legacy `upsertToolUsage` insert (usage.ts:260-331).
const UPSERT_TOOL_USAGE_SQL: &str = r#"
      insert into tool_usage (
        id,
        session_id,
        turn_id,
        trace_id,
        tool_call_id,
        tool_name,
        side_effect_scope,
        read_only,
        destructive,
        approval_status,
        status,
        started_at,
        first_output_at,
        completed_at,
        duration_ms,
        time_to_first_output_ms,
        exit_code,
        output_bytes,
        stdout_bytes,
        stderr_bytes,
        truncated,
        retry_count,
        retryable,
        cancelled_by_user,
        error_type,
        error_code,
        error_message
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        turn_id = coalesce(excluded.turn_id, tool_usage.turn_id),
        trace_id = coalesce(excluded.trace_id, tool_usage.trace_id),
        tool_call_id = excluded.tool_call_id,
        tool_name = case
          when excluded.tool_name = 'unknown' then tool_usage.tool_name
          else excluded.tool_name
        end,
        side_effect_scope = coalesce(excluded.side_effect_scope, tool_usage.side_effect_scope),
        read_only = coalesce(excluded.read_only, tool_usage.read_only),
        destructive = coalesce(excluded.destructive, tool_usage.destructive),
        approval_status = coalesce(excluded.approval_status, tool_usage.approval_status),
        status = case
          when tool_usage.status in ('completed', 'error', 'cancelled') and excluded.status = 'running'
            then tool_usage.status
          else excluded.status
        end,
        started_at = min(tool_usage.started_at, excluded.started_at),
        first_output_at = coalesce(tool_usage.first_output_at, excluded.first_output_at),
        completed_at = coalesce(excluded.completed_at, tool_usage.completed_at),
        duration_ms = coalesce(excluded.duration_ms, tool_usage.duration_ms),
        time_to_first_output_ms = coalesce(excluded.time_to_first_output_ms, tool_usage.time_to_first_output_ms),
        exit_code = coalesce(excluded.exit_code, tool_usage.exit_code),
        output_bytes = max(tool_usage.output_bytes, excluded.output_bytes),
        stdout_bytes = max(tool_usage.stdout_bytes, excluded.stdout_bytes),
        stderr_bytes = max(tool_usage.stderr_bytes, excluded.stderr_bytes),
        truncated = max(tool_usage.truncated, excluded.truncated),
        retry_count = excluded.retry_count,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        error_type = coalesce(excluded.error_type, tool_usage.error_type),
        error_code = coalesce(excluded.error_code, tool_usage.error_code),
        error_message = coalesce(excluded.error_message, tool_usage.error_message)
      "#;

// ── queryAppUsage SELECTs (usage.ts:393-541) ─────────────────────────────────

const TOTALS_SQL: &str = r#"select
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         coalesce(sum(reasoning_tokens), 0) as reasoningTokens,
         coalesce(sum(cache_creation_input_tokens), 0) as cacheCreationTokens,
         coalesce(sum(cache_read_input_tokens), 0) as cacheReadTokens,
         count(*) as modelRequestCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as modelErrorCount,
         avg(time_to_first_token_ms) as avgTimeToFirstTokenMs
       from model_usage
       where started_at >= ? and started_at <= ?"#;

const TURN_TOTALS_SQL: &str = r#"select
         count(distinct session_id) as totalSessions,
         count(*) as totalTurns,
         avg(case when status = 'completed' then duration_ms else null end) as avgTurnDurationMs
       from turn_usage
       where started_at >= ? and started_at <= ?"#;

const LONGEST_SESSION_SQL: &str = r#"select coalesce(max(sessionDurationMs), 0) as longestSessionMs
       from (
         select coalesce(sum(case when status = 'completed' then duration_ms else 0 end), 0)
           as sessionDurationMs
         from turn_usage
         where started_at >= ? and started_at <= ?
         group by session_id
       )"#;

const TOOL_TOTALS_SQL: &str = r#"select
         count(*) as toolCallCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as toolErrorCount
       from tool_usage
       where started_at >= ? and started_at <= ?"#;

const MODELS_SQL: &str = r#"select
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         count(*) as requestCount
       from model_usage
       where started_at >= ? and started_at <= ?
       group by model_id
       order by totalTokens desc"#;

const TOOLS_SQL: &str = r#"select
         tool_name as toolName,
         count(*) as callCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as errorCount,
         avg(duration_ms) as avgDurationMs
       from tool_usage
       where started_at >= ? and started_at <= ?
       group by tool_name
       order by callCount desc"#;

const DAYS_SQL: &str = r#"select
         cast((started_at + ?) / ? as integer) as dayIndex,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex"#;

const TURN_DAYS_SQL: &str = r#"select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as turnCount
       from turn_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex"#;

const TOOL_DAYS_SQL: &str = r#"select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as toolCallCount
       from tool_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex"#;

const DAY_MODELS_SQL: &str = r#"select
         cast((started_at + ?) / ? as integer) as dayIndex,
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex, model_id"#;

/// Legacy `queryTaskUsage` select (usage.ts:595-610).
const TASK_USAGE_SQL: &str = r#"select
         id,
         query_source as querySource,
         status,
         input_tokens as inputTokens,
         output_tokens as outputTokens,
         reasoning_tokens as reasoningTokens,
         cache_creation_input_tokens as cacheCreationTokens,
         cache_read_input_tokens as cacheReadTokens,
         computed_total_tokens as computedTotalTokens,
         provider_total_tokens as providerTotalTokens
       from model_usage
       where session_id = ?
       order by started_at asc, id asc"#;

/// Payload: `{ "v": [40 values] }` — the exact positional args of the legacy
/// `recordModelUsage` `.run(...)` (usage.ts:121-162), pre-shaped by TS
/// (`integer()`/`boolean()`/`encodeJson(...)`; `computedTotalTokens` computed
/// before send; `rawUsage`/`providerMetadata` arrive as pre-stringified strings
/// or null). -> Result: `"null"` (verbatim INSERT + ON CONFLICT UPDATE). The
/// batch runs the coalesced prune (spec §4.2) — this op never prunes.
pub fn record_model_usage(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = vlist(payload)?;
  execute(ctx, RECORD_MODEL_USAGE_SQL, v)?;
  Ok("null".to_string())
}

/// Payload: `{ "v": [26 values] }` — the exact positional args of the legacy
/// `upsertTurnUsage` `.run(...)` (usage.ts:228-255), pre-shaped by TS
/// (`integer()`/`boolean()`). -> Result: `"null"` (verbatim INSERT + ON
/// CONFLICT UPDATE). The batch runs the coalesced prune (spec §4.2) — this op
/// never prunes.
pub fn upsert_turn_usage(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = vlist(payload)?;
  execute(ctx, UPSERT_TURN_USAGE_SQL, v)?;
  Ok("null".to_string())
}

/// Payload: `{ "v": [27 values] }` — the exact `toolUsageValues(input)` order
/// (usage.ts:352-381), pre-shaped by TS (`integer()`/`boolean()`/
/// `nullableBoolean()`). -> Result: `"null"` (verbatim INSERT + ON CONFLICT
/// UPDATE). The batch runs the coalesced prune (spec §4.2) — this op never
/// prunes.
pub fn upsert_tool_usage(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = vlist(payload)?;
  execute(ctx, UPSERT_TOOL_USAGE_SQL, v)?;
  Ok("null".to_string())
}

/// Payload: `{ "v": [beforeTime] }` — TS computed
/// `input.beforeTime ?? nowMs - USAGE_RETENTION_MS` (30 days). -> Result:
/// `"null"`; the three legacy DELETEs (`model_usage`, `turn_usage`,
/// `tool_usage`), each bound to `beforeTime`. The legacy transaction wrapped
/// exactly these three statements; the batch's transaction provides that
/// atomicity here, so this op opens none.
pub fn prune_usage(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = vlist(payload)?;
  let before = v
    .first()
    .ok_or_else(|| StoreError::op("pruneUsage expects `v` = [beforeTime]"))?;
  let params = std::slice::from_ref(before);
  execute(ctx, "delete from model_usage where started_at < ?", params)?;
  execute(ctx, "delete from turn_usage where started_at < ?", params)?;
  execute(ctx, "delete from tool_usage where started_at < ?", params)?;
  Ok("null".to_string())
}

/// Payload: `{ "v": [since, until, tzOffsetMs] }` -> Result: a JSON object with
/// the ten legacy SELECT reads as rows-JSON arrays: `{"totals":[...],
/// "turnTotals":[...],"longestSession":[...],"toolTotals":[...],"models":[...],
/// "tools":[...],"days":[...],"turnDays":[...],"toolDays":[...],
/// "dayModels":[...]}`. Day-bucketed reads bind `[tzOffsetMs, 86400000, since,
/// until]` (fixed-offset tz bucketing; DST drift up to 1 hour across daily
/// boundaries is acceptable for usage statistics — usage.ts:384-385). TS
/// performs the legacy dayMap merge and result shaping (`.get` reads come back
/// as one-element row arrays).
pub fn query_app_usage(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = vlist(payload)?;
  if v.len() != 3 {
    return Err(StoreError::op(
      "queryAppUsage expects `v` = [since, until, tzOffsetMs]",
    ));
  }
  let range = &v[..2];
  let day_range = [v[2].clone(), js_i64(DAY_MS), v[0].clone(), v[1].clone()];

  let totals = query_rows(ctx, TOTALS_SQL, range)?;
  let turn_totals = query_rows(ctx, TURN_TOTALS_SQL, range)?;
  let longest_session = query_rows(ctx, LONGEST_SESSION_SQL, range)?;
  let tool_totals = query_rows(ctx, TOOL_TOTALS_SQL, range)?;
  let models = query_rows(ctx, MODELS_SQL, range)?;
  let tools = query_rows(ctx, TOOLS_SQL, range)?;
  let days = query_rows(ctx, DAYS_SQL, &day_range)?;
  let turn_days = query_rows(ctx, TURN_DAYS_SQL, &day_range)?;
  let tool_days = query_rows(ctx, TOOL_DAYS_SQL, &day_range)?;
  let day_models = query_rows(ctx, DAY_MODELS_SQL, &day_range)?;

  Ok(format!(
    r#"{{"totals":{totals},"turnTotals":{turn_totals},"longestSession":{longest_session},"toolTotals":{tool_totals},"models":{models},"tools":{tools},"days":{days},"turnDays":{turn_days},"toolDays":{tool_days},"dayModels":{day_models}}}"#
  ))
}

/// Payload: `{ "v": [sessionID] }` -> Result: rows-JSON array of the verbatim
/// SELECT (aliased columns: id, querySource, status, inputTokens,
/// outputTokens, reasoningTokens, cacheCreationTokens, cacheReadTokens,
/// computedTotalTokens, providerTotalTokens; ordered by started_at asc, id
/// asc). TS runs the legacy aggregation loop.
pub fn query_task_usage(ctx: &Ctx, payload: &JsValue) -> Result<String, StoreError> {
  let v = vlist(payload)?;
  if v.len() != 1 {
    return Err(StoreError::op("queryTaskUsage expects `v` = [sessionID]"));
  }
  query_rows(ctx, TASK_USAGE_SQL, v)
}
