//! Usage write paths (`recordModelUsage` / `upsertTurnUsage` / `upsertToolUsage` / `pruneUsage`),
//! ported from
//! `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts`.
//!
//! Each of the three record ops is a single guarded upsert (`insert … on conflict … do update set`)
//! followed by an inline `await pruneUsage(db)`. In the TS the upsert is one `.run()` statement with
//! NO surrounding transaction, and `pruneUsage` then opens its OWN `begin immediate` … `commit`
//! (rolling back on error). We reproduce that split exactly: the upsert runs as a plain statement and
//! the prune runs as its own `BEGIN IMMEDIATE` transaction. Adding a `BEGIN IMMEDIATE` around the
//! upsert where the source has none would change lock/rollback behavior, so we do not.
//!
//! `pruneUsage` deletes rows whose `started_at < beforeTime` (strict `<`, so a row sitting exactly on
//! the cutoff survives) from all three tables. When the caller omits `beforeTime`, TS defaults it to
//! `Date.now() - USAGE_RETENTION_MS` (30 days). The addon NEVER reads the clock: every record wrapper
//! takes `now` (epoch ms) as an injected argument and computes the default cutoff as
//! `now - USAGE_RETENTION_MS`; the standalone `prune_usage_json` takes an optional explicit
//! `beforeTime` (`None` → the same `now - USAGE_RETENTION_MS` default).
//!
//! TS value normalization reproduced verbatim:
//! - `integer(v)`: non-number / NaN / ±Infinity → `0`, else `max(0, trunc(v))`. Applied to every
//!   NOT-NULL integer column the TS wraps in `integer(...)`.
//! - `boolean(v)`: JS truthiness → `1`/`0`. Applied to the `retryable` / `cancelled_by_user` /
//!   `context_exceeded` / `truncated` columns (never NULL).
//! - `nullableBoolean(v)` (tool `read_only` / `destructive`): `undefined` → SQL NULL, otherwise the
//!   `boolean(v)` 0/1. An explicit JSON `null` is NOT `undefined`, so it maps to `0` — matching TS.
//! - `encodeJson(v)` (model `raw_usage_json` / `provider_metadata_json`): `undefined` or `null` → SQL
//!   NULL, else `JSON.stringify(v)`. Re-serialized with `serde_json`'s `preserve_order` so key order
//!   byte-matches `JSON.stringify`.
//! - `x ?? null` optional columns: absent / JSON `null` → SQL NULL; a present number is bound verbatim
//!   (integer-valued doubles bind as `INTEGER`, otherwise `REAL`, mirroring a JS number bound through
//!   node:sqlite).
//!
//! `model_usage.computed_total_tokens` uses TS's `input.computedTotalTokens ?? <fallback>`: when the
//! caller supplies it we bind it as-is (NOT run through `integer`); when absent we compute
//! `inputSideTokensFromNormalizedUsage(inputTokens, cacheCreation, cacheRead) + integer(outputTokens)`,
//! whose fallback term is always a non-negative integer.

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use rusqlite::{params_from_iter, Connection};
use serde_json::Value;

/// Owned rusqlite bind value for the wide usage statements: each column is prepared with the exact
/// TS binding semantics (NULL / INTEGER / REAL / TEXT) and handed to `params_from_iter`.
type RusqliteValue = rusqlite::types::Value;

/// Port of the TS `USAGE_RETENTION_DAYS = 30` → `USAGE_RETENTION_MS` (30 days in epoch ms).
const USAGE_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Port of TS `integer(value)`: a non-number or non-finite (`NaN` / ±Infinity) collapses to `0`;
/// otherwise the value is truncated toward zero and clamped to `>= 0` (`Math.max(0, Math.trunc(v))`).
fn integer(value: Option<&Value>) -> i64 {
    match value.and_then(Value::as_f64) {
        Some(v) if v.is_finite() => v.trunc().max(0.0) as i64,
        _ => 0,
    }
}

/// Port of TS `boolean(value)`: JS truthiness (`undefined`/`null`/`false`/`0`/`""` are falsy; any
/// non-zero number, non-empty string, object or array is truthy). Returns a SQL 0/1.
fn boolean(value: Option<&Value>) -> i64 {
    if js_truthy(value) {
        1
    } else {
        0
    }
}

/// Port of TS `nullableBoolean(value)`: `undefined` (absent field) → SQL NULL; anything else (an
/// explicit `null` included) → the `boolean(value)` 0/1.
fn nullable_boolean(value: Option<&Value>) -> RusqliteValue {
    match value {
        None => RusqliteValue::Null,
        Some(v) => RusqliteValue::Integer(boolean(Some(v))),
    }
}

/// JS truthiness of an optional JSON value (`None`/JSON null are falsy). Shared by `boolean`.
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// A required string column bound the way the TS passes it (`input.x`, no `?? null`). Errors when the
/// field is absent or not a string — those columns are NOT NULL and the contract types them required.
fn req_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("usage.{key} must be a string"))
}

/// Port of a required number column the TS binds directly (`input.startedAt`): an integer-valued
/// double binds as `INTEGER`, otherwise `REAL`, matching a JS number passed through node:sqlite.
fn req_number(input: &Value, key: &str) -> Result<RusqliteValue, String> {
    input
        .get(key)
        .and_then(Value::as_f64)
        .map(number_value)
        .ok_or_else(|| format!("usage.{key} must be a number"))
}

/// Bind a finite JS number: integral values become `INTEGER`, the rest `REAL` (SQLite INTEGER-affinity
/// stores a lossless double as an integer and keeps a fractional one as a real — the same as node:
/// sqlite binding a `number`).
fn number_value(v: f64) -> RusqliteValue {
    if v.fract() == 0.0 {
        RusqliteValue::Integer(v as i64)
    } else {
        RusqliteValue::Real(v)
    }
}

/// Port of a `x ?? null` optional number column: absent / JSON null → SQL NULL; a present number is
/// bound through [`number_value`].
fn opt_number(input: &Value, key: &str) -> RusqliteValue {
    match input.get(key) {
        None | Some(Value::Null) => RusqliteValue::Null,
        Some(v) => v.as_f64().map(number_value).unwrap_or(RusqliteValue::Null),
    }
}

/// Port of a `x ?? null` optional string column: absent / JSON null → SQL NULL, else `TEXT`.
fn opt_str(input: &Value, key: &str) -> RusqliteValue {
    match input.get(key) {
        None | Some(Value::Null) => RusqliteValue::Null,
        Some(v) => match v.as_str() {
            Some(s) => RusqliteValue::Text(s.to_string()),
            None => RusqliteValue::Null,
        },
    }
}

/// Port of `encodeJson(input[key])`: `undefined` (absent) or `null` → SQL NULL, else the compact JSON
/// string of the value (`serde_json` re-serializes in insertion order via `preserve_order`, matching
/// `JSON.stringify`).
fn encode_json(input: &Value, key: &str) -> Result<RusqliteValue, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(RusqliteValue::Null),
        Some(v) => serde_json::to_string(v)
            .map(RusqliteValue::Text)
            .map_err(|e| e.to_string()),
    }
}

/// Port of `inputSideTokensFromNormalizedUsage(inputTokens, cacheCreation, cacheRead)`: when the
/// normalized `input` is `> 0` it is the answer, otherwise the cache tokens are summed.
fn input_side_tokens(input_tokens: i64, cache_creation: i64, cache_read: i64) -> i64 {
    if input_tokens > 0 {
        input_tokens
    } else {
        cache_creation + cache_read
    }
}

/// `BEGIN IMMEDIATE` … delete-3-tables … `COMMIT`, rolling back on any error — the exact TS
/// `pruneUsage` body. `beforeTime` is the (already-defaulted) epoch-ms cutoff; `started_at < ?` is a
/// strict comparison so a row at exactly the cutoff is preserved.
fn prune(conn: &Connection, before_time: i64) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| format!("begin: {e}"))?;
    let result = (|| -> Result<(), rusqlite::Error> {
        conn.execute("delete from model_usage where started_at < ?1", [before_time])?;
        conn.execute("delete from turn_usage where started_at < ?1", [before_time])?;
        conn.execute("delete from tool_usage where started_at < ?1", [before_time])?;
        Ok(())
    })();
    match result {
        Ok(()) => conn
            .execute("COMMIT", [])
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e.to_string())
        }
    }
}

/// Port of `recordModelUsage`: run the `model_usage` guarded upsert (no surrounding transaction, as
/// the TS `.run()` has none), then prune with the caller-injected `now` default cutoff.
///
/// # Arguments
///
/// * `conn` - open read-write connection (`open_readwrite` enables FK enforcement).
/// * `input` - the `ModelUsageRecord` JSON object.
/// * `now` - injected epoch ms; used ONLY for the trailing `pruneUsage` default cutoff.
///
/// # Errors
///
/// Returns `Err(String)` for a missing/mis-typed required field, a JSON encode failure, or a failed
/// statement.
pub fn record_model_usage(conn: &Connection, input: &Value, now: i64) -> Result<(), String> {
    // computedTotalTokens is bound as-is when present (TS `input.computedTotalTokens ?? fallback`).
    let computed_total_tokens = match input.get("computedTotalTokens") {
        None | Some(Value::Null) => RusqliteValue::Integer(
            input_side_tokens(
                integer(input.get("inputTokens")),
                integer(input.get("cacheCreationInputTokens")),
                integer(input.get("cacheReadInputTokens")),
            ) + integer(input.get("outputTokens")),
        ),
        Some(v) => v
            .as_f64()
            .map(number_value)
            .unwrap_or(RusqliteValue::Null),
    };

    let p: Vec<RusqliteValue> = vec![
        RusqliteValue::Text(req_str(input, "id")?.to_string()),
        RusqliteValue::Text(req_str(input, "logicalRequestId")?.to_string()),
        RusqliteValue::Integer(integer(input.get("attemptIndex"))),
        RusqliteValue::Text(req_str(input, "sessionID")?.to_string()),
        opt_str(input, "turnID"),
        opt_str(input, "traceID"),
        opt_str(input, "spanID"),
        opt_str(input, "assistantMessageID"),
        opt_str(input, "parentUserMessageID"),
        RusqliteValue::Text(req_str(input, "querySource")?.to_string()),
        RusqliteValue::Text(req_str(input, "providerId")?.to_string()),
        RusqliteValue::Text(req_str(input, "modelId")?.to_string()),
        opt_str(input, "reasoningLevel"),
        opt_str(input, "agent"),
        opt_str(input, "mode"),
        opt_str(input, "taskType"),
        RusqliteValue::Text(req_str(input, "status")?.to_string()),
        req_number(input, "startedAt")?,
        opt_number(input, "firstTokenAt"),
        opt_number(input, "completedAt"),
        opt_number(input, "durationMs"),
        opt_number(input, "timeToFirstTokenMs"),
        opt_str(input, "finishReason"),
        RusqliteValue::Integer(integer(input.get("toolCallCount"))),
        RusqliteValue::Integer(integer(input.get("inputTokens"))),
        RusqliteValue::Integer(integer(input.get("outputTokens"))),
        RusqliteValue::Integer(integer(input.get("reasoningTokens"))),
        RusqliteValue::Integer(integer(input.get("cacheCreationInputTokens"))),
        RusqliteValue::Integer(integer(input.get("cacheReadInputTokens"))),
        opt_number(input, "providerTotalTokens"),
        computed_total_tokens,
        RusqliteValue::Integer(integer(input.get("retryCount"))),
        RusqliteValue::Integer(boolean(input.get("retryable"))),
        RusqliteValue::Integer(boolean(input.get("cancelledByUser"))),
        RusqliteValue::Integer(boolean(input.get("contextExceeded"))),
        opt_str(input, "errorType"),
        opt_str(input, "errorCode"),
        opt_str(input, "errorMessage"),
        encode_json(input, "rawUsage")?,
        encode_json(input, "providerMetadata")?,
    ];

    conn
        .execute(
            "
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
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
        ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
        ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40
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
      ",
            params_from_iter(p),
        )
        .map_err(|e| e.to_string())?;
    prune(conn, now - USAGE_RETENTION_MS)
}

/// Port of `upsertTurnUsage`: run the `turn_usage` upsert (conflict target `(session_id, turn_id)`,
/// with the `coalesce`/`min` merge arms taken verbatim from the TS), then prune with the `now` default
/// cutoff. No surrounding transaction on the upsert, matching the source.
pub fn upsert_turn_usage(conn: &Connection, input: &Value, now: i64) -> Result<(), String> {
    let p: Vec<RusqliteValue> = vec![
        RusqliteValue::Text(req_str(input, "sessionID")?.to_string()),
        RusqliteValue::Text(req_str(input, "turnID")?.to_string()),
        opt_str(input, "traceID"),
        opt_str(input, "userMessageID"),
        RusqliteValue::Text(req_str(input, "status")?.to_string()),
        req_number(input, "startedAt")?,
        opt_number(input, "firstModelStartAt"),
        opt_number(input, "firstTokenAt"),
        opt_number(input, "completedAt"),
        opt_number(input, "durationMs"),
        opt_number(input, "timeToFirstTokenMs"),
        RusqliteValue::Integer(integer(input.get("modelRequestCount"))),
        RusqliteValue::Integer(integer(input.get("modelRetryCount"))),
        RusqliteValue::Integer(integer(input.get("toolCallCount"))),
        RusqliteValue::Integer(integer(input.get("toolErrorCount"))),
        RusqliteValue::Integer(integer(input.get("inputTokens"))),
        RusqliteValue::Integer(integer(input.get("outputTokens"))),
        RusqliteValue::Integer(integer(input.get("reasoningTokens"))),
        RusqliteValue::Integer(integer(input.get("cacheCreationInputTokens"))),
        RusqliteValue::Integer(integer(input.get("cacheReadInputTokens"))),
        RusqliteValue::Integer(integer(input.get("computedTotalTokens"))),
        RusqliteValue::Integer(boolean(input.get("retryable"))),
        RusqliteValue::Integer(boolean(input.get("cancelledByUser"))),
        RusqliteValue::Integer(boolean(input.get("contextExceeded"))),
        opt_str(input, "errorType"),
        opt_str(input, "errorCode"),
    ];

    conn
        .execute(
            "
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
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
        ?21, ?22, ?23, ?24, ?25, ?26
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
      ",
            params_from_iter(p),
        )
        .map_err(|e| e.to_string())?;
    prune(conn, now - USAGE_RETENTION_MS)
}

/// Port of `upsertToolUsage`: run the `tool_usage` upsert (conflict target `id`, with the
/// `case`/`coalesce`/`min`/`max` merge arms taken verbatim from the TS — including the `tool_name`
/// `unknown` guard and the status downgrade prevention), then prune with the `now` default cutoff.
pub fn upsert_tool_usage(conn: &Connection, input: &Value, now: i64) -> Result<(), String> {
    let p: Vec<RusqliteValue> = vec![
        RusqliteValue::Text(req_str(input, "id")?.to_string()),
        RusqliteValue::Text(req_str(input, "sessionID")?.to_string()),
        opt_str(input, "turnID"),
        opt_str(input, "traceID"),
        RusqliteValue::Text(req_str(input, "toolCallID")?.to_string()),
        RusqliteValue::Text(req_str(input, "toolName")?.to_string()),
        opt_str(input, "sideEffectScope"),
        nullable_boolean(input.get("readOnly")),
        nullable_boolean(input.get("destructive")),
        opt_str(input, "approvalStatus"),
        RusqliteValue::Text(req_str(input, "status")?.to_string()),
        req_number(input, "startedAt")?,
        opt_number(input, "firstOutputAt"),
        opt_number(input, "completedAt"),
        opt_number(input, "durationMs"),
        opt_number(input, "timeToFirstOutputMs"),
        opt_number(input, "exitCode"),
        RusqliteValue::Integer(integer(input.get("outputBytes"))),
        RusqliteValue::Integer(integer(input.get("stdoutBytes"))),
        RusqliteValue::Integer(integer(input.get("stderrBytes"))),
        RusqliteValue::Integer(boolean(input.get("truncated"))),
        RusqliteValue::Integer(integer(input.get("retryCount"))),
        RusqliteValue::Integer(boolean(input.get("retryable"))),
        RusqliteValue::Integer(boolean(input.get("cancelledByUser"))),
        opt_str(input, "errorType"),
        opt_str(input, "errorCode"),
        opt_str(input, "errorMessage"),
    ];

    conn
        .execute(
            "
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
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
        ?21, ?22, ?23, ?24, ?25, ?26, ?27
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
      ",
            params_from_iter(p),
        )
        .map_err(|e| e.to_string())?;
    prune(conn, now - USAGE_RETENTION_MS)
}

/// Port of `pruneUsage`: delete `started_at < beforeTime` from all three usage tables inside one
/// `BEGIN IMMEDIATE` transaction. `before_time` is `None` when the caller omitted `input.beforeTime`,
/// in which case TS defaults it to `Date.now() - USAGE_RETENTION_MS`; since the addon never reads the
/// clock, the injected `now` supplies that default.
pub fn prune_usage(conn: &Connection, before_time: Option<i64>, now: i64) -> Result<(), String> {
    let cutoff = before_time.unwrap_or(now - USAGE_RETENTION_MS);
    prune(conn, cutoff)
}

/// N-API: `recordModelUsage` write boundary. Opens a read-write DB, runs the `model_usage` upsert,
/// then prunes with the `now` default cutoff. `model_json` is the serialized `ModelUsageRecord`;
/// `now` is a JS number (epoch ms) injected for the trailing prune. Returns `"null"` (TS returns void).
#[napi]
pub fn record_model_usage_json(db_path: String, model_json: String, now: f64) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&model_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    record_model_usage(&conn, &input, now as i64).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `upsertTurnUsage` write boundary. `turn_json` is the serialized `TurnUsageRecord`; `now`
/// feeds the trailing prune default cutoff.
#[napi]
pub fn upsert_turn_usage_json(db_path: String, turn_json: String, now: f64) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&turn_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    upsert_turn_usage(&conn, &input, now as i64).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `upsertToolUsage` write boundary. `tool_json` is the serialized `ToolUsageRecord`; `now`
/// feeds the trailing prune default cutoff.
#[napi]
pub fn upsert_tool_usage_json(db_path: String, tool_json: String, now: f64) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&tool_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let conn = crate::open_readwrite(&db_path)?;
    upsert_tool_usage(&conn, &input, now as i64).map_err(Error::from_reason)?;
    Ok("null".to_string())
}

/// N-API: `pruneUsage` write boundary. `before_time` is the optional `input.beforeTime` (null →
/// `now - USAGE_RETENTION_MS`); `now` is the injected epoch ms used only for that default.
#[napi]
pub fn prune_usage_json(
    db_path: String,
    before_time: Option<f64>,
    now: f64,
) -> napi::Result<String> {
    let conn = crate::open_readwrite(&db_path)?;
    prune_usage(&conn, before_time.map(|v| v as i64), now as i64).map_err(Error::from_reason)?;
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
        conn.execute(
            "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
             values ('s1','p','slug','/d','t','v',100,100)",
            [],
        )
        .expect("invariant: seed session");
        conn
    }

    fn model_row(conn: &Connection, id: &str) -> (Option<i64>, Option<String>) {
        conn.query_row(
            "select provider_total_tokens, raw_usage_json from model_usage where id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("read model_usage row")
    }

    #[test]
    fn model_insert_and_upsert_idempotent_on_id() {
        let conn = db();
        let first = json!({
            "id": "mu1", "logicalRequestId": "lr1", "sessionID": "s1",
            "querySource": "main_turn", "providerId": "pv", "modelId": "md",
            "status": "completed", "startedAt": 500,
        });
        record_model_usage(&conn, &first, 10_000).expect("first insert");
        let (_, raw1) = model_row(&conn, "mu1");
        assert_eq!(raw1, None, "no rawUsage → NULL column");

        // Re-save the same id with a changed status + a rawUsage payload: the upsert overwrites (not
        // coalesce), so exactly one row remains with the new values.
        let second = json!({
            "id": "mu1", "logicalRequestId": "lr1", "sessionID": "s1",
            "querySource": "main_turn", "providerId": "pv", "modelId": "md",
            "status": "error", "startedAt": 500,
            "rawUsage": { "b": 2, "a": 1 },
        });
        record_model_usage(&conn, &second, 10_000).expect("upsert re-save");
        let count: i64 = conn
            .query_row("select count(*) from model_usage", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1, "on conflict(id) must overwrite, not duplicate");
        let status: String = conn
            .query_row("select status from model_usage where id='mu1'", [], |r| r.get(0))
            .expect("status");
        assert_eq!(status, "error", "status overwritten");
        // Key order must byte-match JSON.stringify of {b:2,a:1} → "b" first (preserve_order).
        let (_, raw2) = model_row(&conn, "mu1");
        assert_eq!(raw2.as_deref(), Some(r#"{"b":2,"a":1}"#));
    }

    #[test]
    fn model_integer_boolean_and_computed_defaults() {
        let conn = db();
        // No token counts / no computedTotalTokens: integer() → 0; computed falls back to
        // input_side_tokens(0,0,0) + integer(0) = 0.
        let input = json!({
            "id": "mu2", "logicalRequestId": "lr", "sessionID": "s1",
            "querySource": "main_turn", "providerId": "pv", "modelId": "md",
            "status": "completed", "startedAt": 500,
            "retryable": true, "cancelledByUser": false,
        });
        record_model_usage(&conn, &input, 10_000).expect("insert");
        let ctt: i64 = conn
            .query_row("select computed_total_tokens from model_usage where id='mu2'", [], |r| {
                r.get(0)
            })
            .expect("ctt");
        assert_eq!(ctt, 0);
        let (retryable, cancelled): (i64, i64) = conn
            .query_row(
                "select retryable, cancelled_by_user from model_usage where id='mu2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("bools");
        assert_eq!((retryable, cancelled), (1, 0), "boolean() → 1/0");

        // Explicit inputTokens drives the fallback (input>0 → input), plus output tokens.
        let input2 = json!({
            "id": "mu3", "logicalRequestId": "lr", "sessionID": "s1",
            "querySource": "main_turn", "providerId": "pv", "modelId": "md",
            "status": "completed", "startedAt": 500,
            "inputTokens": 7, "outputTokens": 3, "cacheReadInputTokens": 100,
        });
        record_model_usage(&conn, &input2, 10_000).expect("insert2");
        let ctt: i64 = conn
            .query_row("select computed_total_tokens from model_usage where id='mu3'", [], |r| {
                r.get(0)
            })
            .expect("ctt2");
        // input(7)>0 → side=7, + integer(output=3) = 10 (cache ignored).
        assert_eq!(ctt, 10);

        // providerTotalTokens null → NULL column.
        let (ptt, _) = model_row(&conn, "mu3");
        assert_eq!(ptt, None);
    }

    #[test]
    fn turn_upsert_merge_semantics() {
        let conn = db();
        let first = json!({
            "sessionID": "s1", "turnID": "t1", "traceID": "tr", "userMessageID": "um",
            "status": "running", "startedAt": 1000, "completedAt": null, "durationMs": null,
            "errorType": null, "error_code": null,
            "inputTokens": 5, "outputTokens": 5,
        });
        upsert_turn_usage(&conn, &first, 10_000).expect("first");
        // Re-save with a later startedAt, null traceID, and a completedAt: trace coalesce keeps the
        // existing traceID, started_at takes the min, completed_at is taken from excluded.
        let second = json!({
            "sessionID": "s1", "turnID": "t1",
            "status": "completed", "startedAt": 2000, "completedAt": 3000,
            "inputTokens": 9,
        });
        upsert_turn_usage(&conn, &second, 10_000).expect("re-save");
        let count: i64 = conn
            .query_row("select count(*) from turn_usage", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1, "conflict(session_id,turn_id) overwrites");
        let (started, trace, completed, input_tokens): (i64, Option<String>, Option<i64>, i64) = conn
            .query_row(
                "select started_at, trace_id, completed_at, input_tokens from turn_usage",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .expect("read");
        assert_eq!(started, 1000, "started_at = min(existing, excluded)");
        assert_eq!(trace.as_deref(), Some("tr"), "trace_id coalesce keeps existing when excluded null");
        assert_eq!(completed, Some(3000), "completed_at = coalesce(excluded, existing)");
        assert_eq!(input_tokens, 9, "input_tokens = excluded (overwrite)");
    }

    #[test]
    fn tool_upsert_unknown_name_and_status_guard_and_nullable_bool() {
        let conn = db();
        // First save: a real tool_name, completed status, read_only true, destructive undefined (NULL).
        let first = json!({
            "id": "tu1", "sessionID": "s1", "toolCallID": "call1", "toolName": "bash",
            "status": "completed", "startedAt": 1000, "readOnly": true,
            "outputBytes": 10, "stdoutBytes": 6, "stderrBytes": 4, "truncated": false,
        });
        upsert_tool_usage(&conn, &first, 10_000).expect("first");
        let (destructive, read_only): (Option<i64>, Option<i64>) = conn
            .query_row(
                "select destructive, read_only from tool_usage where id='tu1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("nullable bools");
        assert_eq!(destructive, None, "undefined destructive → NULL");
        assert_eq!(read_only, Some(1), "readOnly true → 1");

        // Re-save: tool_name 'unknown' (CASE keeps existing 'bash'), status 'running' (guard keeps the
        // terminal 'completed'), startedAt later (min keeps 1000), outputBytes smaller (max keeps 10),
        // readOnly absent → coalesce keeps existing 1.
        let second = json!({
            "id": "tu1", "sessionID": "s1", "toolCallID": "call1", "toolName": "unknown",
            "status": "running", "startedAt": 2000, "outputBytes": 3, "stdoutBytes": 2, "stderrBytes": 1,
        });
        upsert_tool_usage(&conn, &second, 10_000).expect("re-save");
        let count: i64 = conn
            .query_row("select count(*) from tool_usage", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
        let (name, status, started, out): (String, String, i64, i64) = conn
            .query_row(
                "select tool_name, status, started_at, output_bytes from tool_usage where id='tu1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .expect("read merged");
        assert_eq!(name, "bash", "excluded 'unknown' must not overwrite existing tool_name");
        assert_eq!(status, "completed", "terminal status must not be downgraded to running");
        assert_eq!(started, 1000, "started_at = min(existing, excluded)");
        assert_eq!(out, 10, "output_bytes = max(existing, excluded)");
    }

    #[test]
    fn prune_boundary_is_strict_less_than() {
        let conn = db();
        // Seed model_usage rows at three timestamps around a chosen cutoff. `now = USAGE_RETENTION_MS`
        // makes each op's trailing prune cutoff `now - RETENTION = 0`, so seeding prunes nothing and the
        // rows survive until the explicit prune under test.
        for (id, started) in [("old", 100i64), ("exact", 200), ("new", 300)] {
            let input = json!({
                "id": id, "logicalRequestId": "lr", "sessionID": "s1",
                "querySource": "main_turn", "providerId": "pv", "modelId": "md",
                "status": "completed", "startedAt": started,
            });
            record_model_usage(&conn, &input, USAGE_RETENTION_MS).expect("seed");
        }
        // prune_usage with explicit beforeTime = 200 deletes only started_at < 200 (the 'old' row);
        // the row exactly at the cutoff (200) survives.
        prune_usage(&conn, Some(200), 0).expect("prune");
        let mut stmt = conn
            .prepare("select id from model_usage order by id")
            .expect("prepare");
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("collect");
        assert_eq!(ids, vec!["exact".to_string(), "new".to_string()]);
    }

    #[test]
    fn prune_default_cutoff_uses_now_minus_retention() {
        let conn = db();
        let cutoff = 500_000;
        // A row older than the default cutoff and a row exactly at it.
        let old = cutoff - 1;
        let at = cutoff;
        for (id, started) in [("gone", old), ("kept", at)] {
            let input = json!({
                "id": id, "logicalRequestId": "lr", "sessionID": "s1",
                "querySource": "main_turn", "providerId": "pv", "modelId": "md",
                "status": "completed", "startedAt": started,
            });
            // now chosen so now - RETENTION_MS == cutoff.
            record_model_usage(&conn, &input, cutoff + USAGE_RETENTION_MS).expect("seed");
        }
        // now default cutoff == cutoff → 'gone' deleted, 'kept' survives.
        prune_usage(&conn, None, cutoff + USAGE_RETENTION_MS).expect("prune default");
        let count: i64 = conn
            .query_row("select count(*) from model_usage", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1, "only the row below the default cutoff is pruned");
    }

    #[test]
    fn fk_enforced_when_missing_session() {
        let conn = db();
        let input = json!({
            "id": "fk1", "logicalRequestId": "lr", "sessionID": "ghost",
            "querySource": "main_turn", "providerId": "pv", "modelId": "md",
            "status": "completed", "startedAt": 500,
        });
        let err = record_model_usage(&conn, &input, 10_000).expect_err("missing FK parent must fail");
        assert!(err.contains("FOREIGN KEY") || err.contains("foreign key"), "{err}");
    }
}
