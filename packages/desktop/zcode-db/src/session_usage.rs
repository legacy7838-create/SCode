//! Script/LLM usage read: `queryTaskUsage` (integer accumulation over `model_usage`), a faithful port
//! of `usage.ts`. Float/tz `queryAppUsage` is NOT here (deferred — `avg()`/tz day-bucketing are a
//! distinct Phase-6 risk needing its own parity pass). Accumulation distinguishes JS `Number(x ?? 0)`
//! (unclamped, used for raw total/output/reasoning/cache adds) from `integer()` (clamp>=0, used inside
//! `inputSideTokensFromStoredUsage`). Verified by `harness/session_usage_parity`.

use rusqlite::Connection;
use serde_json::{Map, Value, json};

fn iv(v: i64) -> i64 {
    v.max(0)
}

/// Port of `taskUsageInputBaselineSource`.
fn baseline_source(query_source: &str) -> Option<&str> {
    match query_source {
        "main_turn" | "subagent" | "workflow_child" => Some(query_source),
        _ => None,
    }
}

/// Port of `inputSideTokensFromStoredUsage` (integer() = clamp >= 0).
fn input_side_tokens(
    input_tokens: i64,
    output_tokens: i64,
    cache_creation: i64,
    cache_read: i64,
    provider_total: Option<i64>,
    computed_total: i64,
) -> i64 {
    let input = iv(input_tokens);
    let cache = iv(cache_creation) + iv(cache_read);
    if input <= 0 {
        return cache;
    }
    if cache <= 0 {
        return input;
    }
    let output = iv(output_tokens);
    let total = iv(provider_total.unwrap_or(computed_total));
    if total > 0 {
        let total_input_distance = (total - (input + output)).abs();
        let no_cache_distance = (total - (input + cache + output)).abs();
        if no_cache_distance < total_input_distance {
            return input + cache;
        }
    }
    input
}

/// Port of `queryTaskUsage`.
pub fn query_task_usage(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "select query_source, status, input_tokens, output_tokens, reasoning_tokens, \
             cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens, \
             provider_total_tokens \
             from model_usage where session_id = ?1 order by started_at asc, id asc",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([session_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, Option<i64>>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut total_tokens = 0i64;
    let mut input_tokens = 0i64;
    let mut output_tokens = 0i64;
    let mut reasoning_tokens = 0i64;
    let mut cache_creation_tokens = 0i64;
    let mut cache_read_tokens = 0i64;
    let mut model_error_count = 0i64;
    let mut baseline: Vec<(String, i64)> = Vec::new();

    for (query_source, status, in_toks, out_toks, re_toks, cache_c, cache_r, computed, provider) in &rows {
        let raw_total = provider.unwrap_or(*computed); // Number(provider ?? computed ?? 0), unclamped
        let input_side = input_side_tokens(*in_toks, *out_toks, *cache_c, *cache_r, *provider, *computed);
        let source = baseline_source(query_source);
        let incremental = match source {
            None => input_side,
            Some(s) => {
                let base = baseline.iter().find(|(k, _)| k == s).map(|(_, v)| *v).unwrap_or(0);
                (input_side - base).max(0)
            }
        };
        if let Some(s) = source {
            match baseline.iter_mut().find(|(k, _)| k == s) {
                Some(slot) => slot.1 = input_side,
                None => baseline.push((s.to_string(), input_side)),
            }
        }
        let non_input = (raw_total - input_side).max(0);
        total_tokens += incremental + non_input;
        input_tokens += incremental;
        output_tokens += *out_toks; // Number(col ?? 0), unclamped
        reasoning_tokens += *re_toks;
        if source.is_none() {
            cache_creation_tokens += *cache_c;
            cache_read_tokens += *cache_r;
        }
        if status.as_str() == "error" {
            model_error_count += 1;
        }
    }

    let mut baseline_map = Map::new();
    for (k, v) in baseline {
        baseline_map.insert(k, json!(v));
    }
    Ok(json!({
        "sessionID": session_id,
        "totalTokens": total_tokens,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "reasoningTokens": reasoning_tokens,
        "cacheCreationTokens": cache_creation_tokens,
        "cacheReadTokens": cache_read_tokens,
        "modelRequestCount": rows.len(),
        "modelErrorCount": model_error_count,
        "inputBaselineBySource": baseline_map,
    }))
}
