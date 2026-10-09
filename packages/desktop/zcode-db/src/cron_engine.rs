//! `computeNextRunAt` engine (croner-parity, slice 29). croner uses 5-field `min hour dom mon dow`
//! with second=0 firing; the Rust `cron` crate is 6-field (`sec min hour dom mon dow`). Day-of-week
//! numbering can differ — the golden fixtures under `tests/cron_fixtures.json` (generated from the
//! real `croner`) are the parity oracle, so this is proven, not assumed.

use std::str::FromStr;

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use cron::Schedule;

/// Map one croner day-of-week numeric (0/7=Sun … 6=Sat) to the `cron` crate's (1=Sun … 7=Sat).
/// `croner` and the `cron` crate disagree on DOW numbering (the 243-case fixture run proved every
/// divergence is exactly this), so the DOW field is rewritten before parsing.
fn dow_number_to_crate(n: u32) -> u32 {
    (n % 7) + 1
}

fn map_dow_atom(token: &str) -> String {
    // Names first (croner: SUN=0..SAT=6), then numerics.
    let as_index: Option<u32> = match token.to_ascii_uppercase().as_str() {
        "SUN" => Some(0),
        "MON" => Some(1),
        "TUE" => Some(2),
        "WED" => Some(3),
        "THU" => Some(4),
        "FRI" => Some(5),
        "SAT" => Some(6),
        _ => token.parse::<u32>().ok(),
    };
    match as_index {
        Some(n) => dow_number_to_crate(n).to_string(),
        None => token.to_string(),
    }
}

/// Rewrite the DOW field so numeric/range/list/step atoms follow the `cron` crate's convention.
fn normalize_dow(token: &str) -> String {
    token
        .split(',')
        .map(|part| {
            // split a trailing /step off, transform the base, keep the step verbatim
            let (base, step) = match part.split_once('/') {
                Some((b, s)) => (b, Some(s)),
                None => (part, None),
            };
            let base_mapped = if base == "*" {
                "*".to_string()
            } else if let Some((a, b)) = base.split_once('-') {
                format!("{}-{}", map_dow_atom(a), map_dow_atom(b))
            } else {
                map_dow_atom(base)
            };
            match step {
                Some(s) => format!("{base_mapped}/{s}"),
                None => base_mapped,
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Rebuild a croner expression as a `cron`-crate 6-field (sec-first) expression with a normalized
/// DOW field. 5-field `min hour dom mon dow` → `0 min hour dom mon dow'`.
fn to_cron_crate_expr(expr: &str) -> Option<String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    match fields.len() {
        5 => {
            let dow = normalize_dow(fields[4]);
            Some(format!(
                "0 {} {} {} {} {dow}",
                fields[0], fields[1], fields[2], fields[3]
            ))
        }
        6 => {
            let dow = normalize_dow(fields[5]);
            Some(format!(
                "{} {} {} {} {} {dow}",
                fields[0], fields[1], fields[2], fields[3], fields[4]
            ))
        }
        _ => None,
    }
}

/// Compute the next run (epoch ms) strictly after `from_ms`, interpreting `expr` (5- or 6-field) in
/// timezone `tz`, or `None` when there is no future occurrence / inputs are invalid.
pub fn compute_next_run_at(expr: &str, from_ms: i64, tz: &str) -> Option<i64> {
    let zone = Tz::from_str(tz).ok()?;
    let normalized = to_cron_crate_expr(expr)?;
    let schedule = Schedule::from_str(&normalized).ok()?;
    let from: DateTime<Tz> = zone.timestamp_millis_opt(from_ms).single()?;
    let next = schedule.after(&from).next()?;
    Some(next.with_timezone(&Utc).timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        expr: String,
        tz: String,
        base: i64,
        // croner's nextRun() ms, `null` for no future run, or "ERR" if croner threw.
        next: serde_json::Value,
    }

    /// Parity oracle against 243 croner-generated fixtures (5-field exprs × UTC + a DST zone + a
    /// fixed-offset zone × instants incl. US DST spring-forward/fall-back). Names any divergence.
    #[test]
    fn cron_next_run_matches_croner_fixtures() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cron_fixtures.json");
        let raw = std::fs::read_to_string(path).expect("fixtures present");
        let cases: Vec<Case> = serde_json::from_str(&raw).expect("valid fixtures");
        let mut mismatches: Vec<String> = Vec::new();
        for c in &cases {
            let got = compute_next_run_at(&c.expr, c.base, &c.tz);
            let want = match &c.next {
                serde_json::Value::Null => None,
                serde_json::Value::String(s) if s == "ERR" => None,
                serde_json::Value::Number(n) => n.as_i64(),
                other => panic!("unexpected next value: {other}"),
            };
            if got != want {
                mismatches.push(format!(
                    "expr={} tz={} base={} want={:?} got={:?}",
                    c.expr, c.tz, c.base, want, got
                ));
            }
        }
        assert!(
            mismatches.is_empty(),
            "{} / {} cron cases diverge from croner:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches
                .iter()
                .take(15)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
