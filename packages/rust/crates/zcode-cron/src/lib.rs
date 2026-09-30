//! `zcode-cron` — automation schedule computation.
//!
//! Spec: docs/specs/rust-native-cron.md
//!
//! Two entry-point families, deliberately named so they are never confused at a call site:
//!   * [`expr`] — the raw 5-field cron **expression** path (replaces the `croner` npm package)
//!   * [`rule`] — the authoritative structured **`scheduleRule`** engine
//!
//! Every export is a pure function of its arguments: no clock read, no I/O, no process
//! (spec invariants 5 and 6). The `Date.now()` default stays in the TypeScript wrapper so a
//! test can pin `from`, which is what makes the parity corpus in `tests/parity.rs` possible.

pub mod expr;
pub mod localtime;
pub mod rule;

use napi::Error;
use napi_derive::napi;

pub use expr::{
    compute_next_run_at, is_fixed_calendar_cron, is_valid_cron_expr, previous_run_at,
    ONE_SHOT_MISSED_RUN_GRACE_MS, ONE_SHOT_STALE_TARGET_WINDOW_MS,
};
pub use rule::{
    build_interval_schedule_rule, build_relative_delay_schedule, compute_automation_next_run_at,
    compute_schedule_rule_next_run_at, infer_minute_interval_schedule_rule, is_one_shot_automation,
    schedule_rule_definition, CronFields, MonthlyMode, RelativeDelaySchedule, ScheduleRule, Unit,
};

/// The recurrence unit as a string, because napi cannot bind a `#[serde]` enum directly and
/// the wire shape is a lowercase string in both directions.
#[napi]
pub fn parse_unit(name: String) -> Option<String> {
    Unit::parse(&name).map(|unit| {
        serde_json::to_value(unit)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default()
    })
}

/// A `scheduleRule` in the shape the napi boundary uses: camelCase JSON, matching
/// `ZCodeAutomationScheduleRule` (`packages/shared/src/automation-types.ts:35-44`).
///
/// The TS side keeps the interface as the source of truth for the wire; this struct only
/// exists to cross the boundary, and `deny_unknown_fields` means a rule carrying a field this
/// version does not know is rejected rather than silently dropped.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduleRuleJson {
    unit: String,
    interval: f64,
    hour: f64,
    minute: f64,
    anchor_at: f64,
    #[serde(default)]
    weekdays: Option<Vec<f64>>,
    #[serde(default)]
    month_days: Option<Vec<f64>>,
    #[serde(default)]
    months: Option<Vec<f64>>,
    #[serde(default)]
    monthly_mode: Option<String>,
}

/// Internal helper: plain `String` errors, converted at the napi boundary with
/// `Error::from_reason`. Keeping it free of napi types means the parsing logic is testable
/// without the macro-generated surface.
fn rule_from_json(raw: &str) -> std::result::Result<ScheduleRule, String> {
    let parsed: ScheduleRuleJson =
        serde_json::from_str(raw).map_err(|error| format!("invalid scheduleRule: {error}"))?;
    let unit = Unit::parse(&parsed.unit)
        .ok_or_else(|| format!("Unsupported intervalUnit: {}", parsed.unit))?;
    let monthly_mode = match parsed.monthly_mode.as_deref() {
        None | Some("") => None,
        Some("date") => Some(MonthlyMode::Date),
        Some("weekday") => Some(MonthlyMode::Weekday),
        Some(other) => return Err(format!("Unsupported monthlyMode: {other}")),
    };
    Ok(ScheduleRule {
        unit,
        interval: parsed.interval,
        hour: parsed.hour,
        minute: parsed.minute,
        anchor_at: parsed.anchor_at,
        weekdays: parsed.weekdays,
        month_days: parsed.month_days,
        months: parsed.months,
        monthly_mode,
    })
}

/// `computeNextRunAt(cronExpr, from)` — next fire strictly later than `from`.
#[napi]
pub fn compute_next_run_at_js(cron_expr: String, from: f64) -> Option<f64> {
    compute_next_run_at(&cron_expr, from as i64).map(|value| value as f64)
}

/// `computeScheduleRuleNextRunAt(rule, from)`.
#[napi]
pub fn compute_schedule_rule_next_run_at_js(rule_json: String, from: f64) -> napi::Result<Option<f64>> {
    let rule = rule_from_json(&rule_json).map_err(Error::from_reason)?;
    Ok(compute_schedule_rule_next_run_at(&rule, from as i64).map(|value| value as f64))
}

/// `computeAutomationNextRunAt({ cronExpr, scheduleRule }, from)` — the entry point both
/// schedulers call. A rule is authoritative; the expression is only used when absent.
#[napi]
pub fn compute_automation_next_run_at_js(
    cron_expr: String,
    rule_json: Option<String>,
    from: f64,
) -> napi::Result<Option<f64>> {
    let rule = match rule_json.as_deref() {
        None | Some("") => None,
        Some(raw) => Some(rule_from_json(raw).map_err(Error::from_reason)?),
    };
    Ok(compute_automation_next_run_at(&cron_expr, rule.as_ref(), from as i64)
        .map(|value| value as f64))
}

/// `buildIntervalScheduleRule(intervalUnit, interval, cronExpr, anchorAt)`.
///
/// A bad `intervalUnit` returns a typed error so the TypeScript wrapper can re-throw the legacy
/// `Error("Unsupported intervalUnit: …")` and the existing validation-layer behaviour is
/// preserved verbatim (spec §8).
#[napi]
pub fn build_interval_schedule_rule_js(
    interval_unit: String,
    interval: f64,
    cron_expr: String,
    anchor_at: f64,
) -> napi::Result<String> {
    let unit =
        Unit::parse(&interval_unit)
        .ok_or_else(|| Error::from_reason(format!("Unsupported intervalUnit: {interval_unit}")))?;
    let rule = build_interval_schedule_rule(unit, interval, &cron_expr, anchor_at as i64);
    serde_json::to_string(&rule)
        .map_err(|error| Error::from_reason(format!("cannot serialise scheduleRule: {error}")))
}

/// `inferMinuteIntervalScheduleRule(cronExpr, anchorAt)` — `undefined` when the expression is
/// not the `*&#47;N * * * *` form.
#[napi]
pub fn infer_minute_interval_schedule_rule_js(
    cron_expr: String,
    anchor_at: f64,
) -> napi::Result<Option<String>> {
    Ok(
        infer_minute_interval_schedule_rule(&cron_expr, anchor_at as i64)
            .and_then(|rule| serde_json::to_string(&rule).ok()),
    )
}

/// `buildRelativeDelaySchedule(delayMinutes, from)`.
#[napi]
pub fn build_relative_delay_schedule_js(delay_minutes: f64, from: f64) -> napi::Result<String> {
    let schedule = build_relative_delay_schedule(delay_minutes, from as i64);
    serde_json::to_string(&schedule)
        .map_err(|error| Error::from_reason(format!("cannot serialise schedule: {error}")))
}

/// `isOneShotAutomation({ recurring, maxRuns })`.
///
/// `max_runs` is optional on purpose: legacy reads `(automation.maxRuns ?? 1) <= 1`, so an
/// absent field must behave as `1`, not as `0` (spec §5.4).
#[napi]
pub fn is_one_shot_automation_js(recurring: bool, max_runs: Option<f64>) -> bool {
    is_one_shot_automation(recurring, max_runs)
}

/// `scheduleRuleDefinition(rule)` — the change-detection key.
///
/// Byte-identical to the legacy `JSON.stringify` is required, because two schedulers compare
/// this string to decide whether an edit changed the schedule; a byte difference would
/// silently re-schedule every automation on upgrade (spec §5.4, D2).
#[napi]
pub fn schedule_rule_definition_js(rule_json: String) -> napi::Result<String> {
    let rule = rule_from_json(&rule_json).map_err(Error::from_reason)?;
    Ok(schedule_rule_definition(&rule))
}

/// `isValidCronExpr(expr)`.
#[napi]
pub fn is_valid_cron_expr_js(cron_expr: String) -> bool {
    is_valid_cron_expr(&cron_expr)
}

/// The outcome of `computeInitialAutomationNextRunAt`.
///
/// Two distinguishable states, matching the legacy function's two: a fire time (possibly
/// `None`, which is the legacy "no future fire"), and a *stale one-shot* which legacy raises
/// as an error. Modelling the second as its own variant is what lets the wrapper re-raise the
/// original class with its original message instead of collapsing it into `null`.
///
/// The variant and field names are **spelled out** rather than derived from `rename_all`:
/// a container-level `rename_all` on an enum renames the *tag value* but leaves the inner
/// fields snake_cased, which produced `{"kind":"staleOneShot","target_at":…}` while the
/// TypeScript wrapper read `kind === "StaleOneShot"` and `outcome.targetAt`. Every one of
/// those disagreed at once, and the failure mode was a silent `null` rather than an error.
#[derive(serde::Serialize)]
#[serde(tag = "kind")]
enum InitialNextRun {
    /// `nextRunAt` is `None` when the schedule has no future fire.
    #[serde(rename = "At")]
    At {
        #[serde(rename = "nextRunAt")]
        next_run_at: Option<f64>,
    },
    #[serde(rename = "StaleOneShot")]
    StaleOneShot {
        #[serde(rename = "targetAt")]
        target_at: f64,
    },
}

/// `computeInitialAutomationNextRunAt(automation, from)` — `automationCron.ts:95-119`.
///
/// A one-shot fixed-calendar cron that just missed its target minute rolls to the following
/// year. A miss of under a minute is caught up immediately; a miss older than the 1-minute
/// grace is reported as stale so the service can refuse it instead of writing a schedule the
/// user did not ask for.
#[napi]
pub fn compute_initial_automation_next_run_at_js(
    cron_expr: String,
    recurring: bool,
    rule_json: Option<String>,
    from: f64,
) -> napi::Result<String> {
    let rule = match rule_json.as_deref() {
        None | Some("") => None,
        Some(raw) => Some(rule_from_json(raw).map_err(Error::from_reason)?),
    };
    let from_ms = from as i64;
    let next_run_at = compute_automation_next_run_at(&cron_expr, rule.as_ref(), from_ms);

    let outcome = if recurring || rule.is_some() || !is_fixed_calendar_cron(&cron_expr) {
        InitialNextRun::At {
            next_run_at: next_run_at.map(|value| value as f64),
        }
    } else {
        let target_age_ms = previous_run_at(&cron_expr, from_ms)
            .filter(|previous| {
                from_ms >= *previous && from_ms - previous <= ONE_SHOT_STALE_TARGET_WINDOW_MS
            })
            .map(|previous| from_ms - previous);
        let rolled_to_next_occurrence = next_run_at
            .map(|next| next - from_ms > ONE_SHOT_STALE_TARGET_WINDOW_MS)
            .unwrap_or(true);
        match target_age_ms {
            // The tool call crossed the minute boundary by less than a minute: run it now
            // rather than writing a schedule the user did not ask for.
            Some(age) if rolled_to_next_occurrence && age < ONE_SHOT_MISSED_RUN_GRACE_MS => {
                InitialNextRun::At {
                    next_run_at: Some(from_ms as f64),
                }
            }
            // Older than the grace window: report it so the service can refuse before writing.
            Some(age) if rolled_to_next_occurrence => InitialNextRun::StaleOneShot {
                target_at: (from_ms - age) as f64,
            },
            _ => InitialNextRun::At {
                next_run_at: next_run_at.map(|value| value as f64),
            },
        }
    };
    serde_json::to_string(&outcome)
        .map_err(|error| Error::from_reason(format!("cannot serialise outcome: {error}")))
}

/// Exposed so the parity harness can compare the previous-fire probe as well as the next one.
#[napi]
pub fn previous_run_at_js(cron_expr: String, from: f64) -> Option<f64> {
    previous_run_at(&cron_expr, from as i64).map(|value| value as f64)
}

/// Exposed for the fixture corpus: whether an expression is the fixed-calendar form.
#[napi]
pub fn is_fixed_calendar_cron_js(cron_expr: String) -> bool {
    is_fixed_calendar_cron(&cron_expr)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The boundary mirror is the strict layer: a rule carrying a field this version does not
    /// know must be rejected, because silently dropping it would compute a plausible but wrong
    /// schedule. Pinned here because the mirror is private and cannot be reached from an
    /// integration test.
    #[test]
    fn the_boundary_mirror_rejects_an_unknown_field() {
        let with_extra = r#"{"unit":"daily","interval":1,"hour":9,"minute":0,"anchorAt":0,"futureField":true}"#;
        assert!(
            rule_from_json(with_extra).is_err(),
            "an unknown rule field must not be silently ignored at the boundary"
        );
        let valid = r#"{"unit":"daily","interval":1,"hour":9,"minute":0,"anchorAt":0}"#;
        assert!(rule_from_json(valid).is_ok());
    }

    #[test]
    fn the_boundary_mirror_rejects_an_unsupported_unit() {
        let raw = r#"{"unit":"fortnightly","interval":1,"hour":9,"minute":0,"anchorAt":0}"#;
        let err = rule_from_json(raw).unwrap_err();
        assert!(err.contains("Unsupported intervalUnit"), "{err}");
    }

    #[test]
    fn the_boundary_mirror_rejects_an_unsupported_monthly_mode() {
        let raw = r#"{"unit":"monthly","interval":1,"hour":9,"minute":0,"anchorAt":0,"monthlyMode":"newmoon"}"#;
        let err = rule_from_json(raw).unwrap_err();
        assert!(err.contains("Unsupported monthlyMode"), "{err}");
    }

    /// The outcome enum's wire shape is stringly-typed on both sides of the boundary, so a
    /// rename on either side would be invisible until a user's automation silently stopped
    /// rescheduling. The first attempt at this annotation produced
    /// `{"kind":"staleOneShot","target_at":…}` against a reader expecting
    /// `kind === "StaleOneShot"` / `outcome.targetAt`, and every field disagreed at once.
    #[test]
    fn the_outcome_enum_serialises_with_the_names_the_wrapper_expects() {
        let at = InitialNextRun::At {
            next_run_at: Some(1_700_000_000_000.0),
        };
        assert_eq!(
            serde_json::to_string(&at).unwrap(),
            r#"{"kind":"At","nextRunAt":1700000000000.0}"#
        );

        let stale = InitialNextRun::StaleOneShot { target_at: 42.0 };
        assert_eq!(
            serde_json::to_string(&stale).unwrap(),
            r#"{"kind":"StaleOneShot","targetAt":42.0}"#
        );

        // "No future fire" must be an explicit null, never 0 (which would read as 1970) and
        // never a NaN (which does not survive JSON at all).
        let none = InitialNextRun::At { next_run_at: None };
        assert_eq!(
            serde_json::to_string(&none).unwrap(),
            r#"{"kind":"At","nextRunAt":null}"#
        );
    }
}
