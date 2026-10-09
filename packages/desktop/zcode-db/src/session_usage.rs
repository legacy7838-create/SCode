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

/// Port of `queryAppUsage`. Runs the same 8 SQLite aggregate queries as `usage.ts` (so float `avg()`,
/// integer `/` day-bucketing, and group ordering are engine-identical), then reproduces the JS
/// post-processing exactly: `Number(x ?? 0)` coercion, null-preserving `avg*` fields, the three-query
/// day-merge, and `[...map.values()].sort(dayIndex asc)`. `since`/`until`/`tz_offset_ms` are epoch ms.
pub fn query_app_usage(
    conn: &Connection,
    since: i64,
    until: i64,
    tz_offset_ms: i64,
) -> Result<Value, String> {
    const DAY_MS: i64 = 86_400_000;

    // 1. model totals
    let totals = conn
        .query_row(
            "select coalesce(sum(computed_total_tokens),0), coalesce(sum(input_tokens),0), \
             coalesce(sum(output_tokens),0), coalesce(sum(reasoning_tokens),0), \
             coalesce(sum(cache_creation_input_tokens),0), coalesce(sum(cache_read_input_tokens),0), \
             count(*), coalesce(sum(case when status='error' then 1 else 0 end),0), \
             avg(time_to_first_token_ms) from model_usage where started_at >= ?1 and started_at <= ?2",
            rusqlite::params![since, until],
            |r| {
                Ok(json!([
                    r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?, r.get::<_, i64>(7)?, r.get::<_, Option<f64>>(8)?,
                ]))
            },
        )
        .map_err(|e| e.to_string())?;
    // 2. turn totals + longest session
    let turn_totals = conn
        .query_row(
            "select count(distinct session_id), count(*), \
             avg(case when status='completed' then duration_ms else null end) \
             from turn_usage where started_at >= ?1 and started_at <= ?2",
            rusqlite::params![since, until],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<f64>>(2)?)),
        )
        .map_err(|e| e.to_string())?;
    let longest = conn
        .query_row(
            "select coalesce(max(sessionDurationMs),0) from ( \
             select coalesce(sum(case when status='completed' then duration_ms else 0 end),0) as sessionDurationMs \
             from turn_usage where started_at >= ?1 and started_at <= ?2 group by session_id)",
            rusqlite::params![since, until],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;
    // 3. tool totals
    let tool_totals = conn
        .query_row(
            "select count(*), coalesce(sum(case when status='error' then 1 else 0 end),0) \
             from tool_usage where started_at >= ?1 and started_at <= ?2",
            rusqlite::params![since, until],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(|e| e.to_string())?;
    // 4. models (group model_id, order totalTokens desc). model_id is NOT NULL but TS maps `?? null`,
    // so read as Option to preserve a null if ever present.
    let models = {
        let mut s = conn
            .prepare(
                "select model_id, coalesce(sum(computed_total_tokens),0) as totalTokens, coalesce(sum(input_tokens),0), \
                 coalesce(sum(output_tokens),0), count(*) from model_usage \
                 where started_at >= ?1 and started_at <= ?2 group by model_id order by totalTokens desc",
            )
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map(rusqlite::params![since, until], |r| {
                Ok(json!({
                    "modelId": r.get::<_, Option<String>>(0)?,
                    "totalTokens": r.get::<_, i64>(1)?,
                    "inputTokens": r.get::<_, i64>(2)?,
                    "outputTokens": r.get::<_, i64>(3)?,
                    "requestCount": r.get::<_, i64>(4)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    // 5. tools (group tool_name, order callCount desc)
    let tools = {
        let mut s = conn
            .prepare(
                "select tool_name, count(*) as callCount, coalesce(sum(case when status='error' then 1 else 0 end),0), \
                 avg(duration_ms) from tool_usage where started_at >= ?1 and started_at <= ?2 \
                 group by tool_name order by callCount desc",
            )
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map(rusqlite::params![since, until], |r| {
                Ok(json!({
                    "toolName": r.get::<_, String>(0)?,
                    "callCount": r.get::<_, i64>(1)?,
                    "errorCount": r.get::<_, i64>(2)?,
                    "avgDurationMs": r.get::<_, Option<f64>>(3)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    // 6/7/8. day buckets merged by dayIndex
    let mut day_map: std::collections::BTreeMap<i64, (i64, i64, i64)> = std::collections::BTreeMap::new();
    for (sql, idx) in [
        ("select cast((started_at + ?1) / ?2 as integer) as dayIndex, coalesce(sum(computed_total_tokens),0) from model_usage where started_at >= ?3 and started_at <= ?4 group by dayIndex", 0usize),
        ("select cast((started_at + ?1) / ?2 as integer) as dayIndex, count(*) from turn_usage where started_at >= ?3 and started_at <= ?4 group by dayIndex", 1),
        ("select cast((started_at + ?1) / ?2 as integer) as dayIndex, count(*) from tool_usage where started_at >= ?3 and started_at <= ?4 group by dayIndex", 2),
    ] {
        let mut s = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = s
            .query_map(rusqlite::params![tz_offset_ms, DAY_MS, since, until], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (di, val) in rows {
            let e = day_map.entry(di).or_default();
            match idx {
                0 => e.0 = val,
                1 => e.1 = val,
                _ => e.2 = val,
            }
        }
    }
    let days: Vec<Value> = day_map
        .iter()
        .map(|(di, (t, turn, tool))| json!({ "dayIndex": di, "totalTokens": t, "turnCount": turn, "toolCallCount": tool }))
        .collect();
    let day_models = {
        let mut s = conn
            .prepare(
                "select cast((started_at + ?1) / ?2 as integer) as dayIndex, model_id, coalesce(sum(computed_total_tokens),0) \
                 from model_usage where started_at >= ?3 and started_at <= ?4 group by dayIndex, model_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map(rusqlite::params![tz_offset_ms, DAY_MS, since, until], |r| {
                Ok(json!({
                    "dayIndex": r.get::<_, i64>(0)?,
                    "modelId": r.get::<_, Option<String>>(1)?,
                    "totalTokens": r.get::<_, i64>(2)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    let avg_time_to_first_token = totals[8].clone();
    Ok(json!({
        "totals": {
            "totalTokens": totals[0], "inputTokens": totals[1], "outputTokens": totals[2],
            "reasoningTokens": totals[3], "cacheCreationTokens": totals[4], "cacheReadTokens": totals[5],
            "modelRequestCount": totals[6], "modelErrorCount": totals[7],
            "avgTimeToFirstTokenMs": avg_time_to_first_token,
        },
        "turnTotals": {
            "totalSessions": turn_totals.0, "totalTurns": turn_totals.1,
            "avgTurnDurationMs": turn_totals.2, "longestSessionMs": longest,
        },
        "toolTotals": { "toolCallCount": tool_totals.0, "toolErrorCount": tool_totals.1 },
        "models": models,
        "tools": tools,
        "days": days,
        "dayModels": day_models,
    }))
}
