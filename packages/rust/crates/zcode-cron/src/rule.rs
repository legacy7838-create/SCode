//! The structured `scheduleRule` engine — `computeScheduleRuleNextRunAt` and its helpers.
//!
//! Ported branch-for-branch from `packages/services/src/session/automationCron.ts:138-226`.
//! The search bounds are load-bearing and are kept exactly (spec §5.3): changing a bound
//! changes *when a schedule reports "no future fire"*, which is a behaviour change, not an
//! optimisation.

use serde::{Deserialize, Serialize};

use crate::localtime::{
    add_days, at_time, date_in_month, day_in_month, days_since_monday, first_weekday_of_month,
    from_millis, hour, minute, month0, set_minutes, to_millis, year, Millis,
};

/// The recurrence unit. Serialised as the same lowercase strings the TS union uses, so the
/// wire shape is unchanged in both directions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Minute,
    Hourly,
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Unit {
    /// Parses a unit name, returning `None` for anything outside the union so the napi layer
    /// can raise the legacy "Unsupported intervalUnit" error rather than guessing.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "minute" => Some(Unit::Minute),
            "hourly" => Some(Unit::Hourly),
            "daily" => Some(Unit::Daily),
            "weekly" => Some(Unit::Weekly),
            "monthly" => Some(Unit::Monthly),
            "yearly" => Some(Unit::Yearly),
            _ => None,
        }
    }
}

/// How a monthly rule picks its day: an explicit day-of-month, or the first `weekdays[0]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MonthlyMode {
    Date,
    Weekday,
}

/// The authoritative recurrence rule (`ZCodeAutomationScheduleRule`,
/// `packages/shared/src/automation-types.ts:35-44`). Field names and optionality match the
/// interface exactly, and the camelCase renaming is what the TS wire uses.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRule {
    pub unit: Unit,
    pub interval: f64,
    pub hour: f64,
    pub minute: f64,
    pub anchor_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekdays: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub month_days: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub months: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monthly_mode: Option<MonthlyMode>,
}

/// `Math.max(1, Math.floor(interval))` — the legacy sanitisation at
/// `automationCron.ts:139`. Applied to every unit, including the closed-form ones, because the
/// legacy code applies it before the branch (`:139-140`).
fn sanitised_interval(interval: f64) -> i64 {
    let floored = interval.floor();
    if floored > 1.0 {
        floored as i64
    } else {
        1
    }
}

fn first_of<T: Copy + PartialOrd>(values: Option<&Vec<T>>, default: T) -> Vec<T> {
    match values {
        Some(list) if !list.is_empty() => list.clone(),
        _ => vec![default],
    }
}

/// `computeScheduleRuleNextRunAt` — next fire of a structured rule, in epoch ms.
///
/// Returns `None` when the search bounds are exhausted, which is the same "no future fire"
/// signal the legacy `null` carries.
pub fn compute_schedule_rule_next_run_at(rule: &ScheduleRule, from: Millis) -> Option<Millis> {
    let interval = sanitised_interval(rule.interval);
    let hour = rule.hour as u32;
    let minute = rule.minute as u32;
    let anchor = from_millis(rule.anchor_at as Millis);

    match rule.unit {
        // `automationCron.ts:141-147`. Derives from the fixed anchor, never from `from`, so a
        // late dispatch cannot accumulate drift.
        //
        // The legacy expression is `Math.max(1, Math.floor(x) + 1)`: the clamp wraps the *whole*
        // `floor + 1`, not just the floor. Clamping only the floor yields 2 instead of 1 when
        // `from == anchorAt`, which would fire a minute interval one step too late.
        Unit::Minute => {
            let step = interval * 60 * 1_000;
            let raw = ((from - rule.anchor_at as Millis) as f64 / step as f64).floor() + 1.0;
            let steps = if raw < 1.0 { 1 } else { raw as i64 };
            Some(rule.anchor_at as Millis + steps * step)
        }
        // `automationCron.ts:149-155`. Same clamp shape, but the legacy floor is 0 here.
        Unit::Hourly => {
            let base = set_minutes(anchor, minute);
            let step = interval * 60 * 60 * 1_000;
            let raw = ((from - to_millis(base)) as f64 / step as f64).floor() + 1.0;
            let steps = if raw < 0.0 { 0 } else { raw as i64 };
            Some(to_millis(base) + steps * step)
        }
        // `automationCron.ts:157-166`
        Unit::Daily => {
            let anchor_year = year(anchor);
            let anchor_month = month0(anchor);
            let anchor_day = crate::localtime::day_of_month(anchor);
            for index in 0..36_600i64 {
                let candidate = at_time(
                    anchor_year,
                    anchor_month,
                    anchor_day as i32 + (index * interval) as i32,
                    hour,
                    minute,
                );
                let millis = to_millis(candidate);
                if millis > from {
                    return Some(millis);
                }
            }
            None
        }
        // `automationCron.ts:168-185`
        Unit::Weekly => {
            let anchor_week = {
                let midnight = at_time(year(anchor), month0(anchor), crate::localtime::day_of_month(anchor) as i32, 0, 0);
                add_days(midnight, -(days_since_monday(midnight) as i32))
            };
            let mut weekdays = first_of(rule.weekdays.as_ref(), 1.0);
            weekdays.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let mut week = 0i64;
            while week < 5_220 {
                for weekday in &weekdays {
                    let day_offset = ((*weekday as i64 + 6) % 7) as i32;
                    let candidate = at_time(
                        year(anchor_week),
                        month0(anchor_week),
                        crate::localtime::day_of_month(anchor_week) as i32
                            + (week * 7) as i32
                            + day_offset,
                        hour,
                        minute,
                    );
                    let millis = to_millis(candidate);
                    if millis > from {
                        return Some(millis);
                    }
                }
                week += interval;
            }
            None
        }
        // `automationCron.ts:187-209`. The bound is inclusive on purpose (legacy comment at
        // `:187-188`): an expired current-month candidate must still be able to roll a full
        // cycle rather than returning null.
        Unit::Monthly => {
            let anchor_year = year(anchor);
            let anchor_month = month0(anchor);
            let mut offset = 0i64;
            while offset <= 1_200 {
                let month = date_in_month(anchor_year, anchor_month as i32 + offset as i32, 1);
                let (month_year, month0_index) = (year(month), month0(month));
                let candidates: Vec<_> = match rule.monthly_mode {
                    Some(MonthlyMode::Weekday) => {
                        let weekday = rule.weekdays.as_ref().and_then(|w| w.first()).copied().unwrap_or(1.0);
                        vec![first_weekday_of_month(month_year, month0_index, weekday as u32)]
                    }
                    _ => {
                        let mut days = first_of(rule.month_days.as_ref(), 1.0);
                        days.sort_by(|a, b| a.partial_cmp(b).unwrap());
                        days.iter()
                            // The legacy filter `date.getMonth() === month.getMonth()`
                            // (`automationCron.ts:204`) drops day 31 from a 30-day month, and
                            // February 29/30 from a non-leap February.
                            .filter(|day| {
                                let resolved = day_in_month(month_year, month0_index, **day as i32);
                                resolved as f64 == **day
                            })
                            .map(|day| at_time(month_year, month0_index, *day as i32, 0, 0))
                            .collect()
                    }
                };
                for candidate in candidates {
                    let millis = to_millis(at_time(year(candidate), month0(candidate), crate::localtime::day_of_month(candidate) as i32, hour, minute));
                    if millis > from {
                        return Some(millis);
                    }
                }
                offset += interval;
            }
            None
        }
        // `automationCron.ts:212-224`
        Unit::Yearly => {
            let target_month = match rule.months.as_ref().and_then(|m| m.first()) {
                Some(month) => ((((*month as i64 - 1) % 12) + 12) % 12) as u32,
                // Legacy falls back to the anchor month for records written before `months`
                // existed (`automationCron.ts:213`).
                None => month0(anchor),
            };
            let target_day = rule
                .month_days
                .as_ref()
                .and_then(|d| d.first())
                .copied()
                .unwrap_or(crate::localtime::day_of_month(anchor) as f64);
            let anchor_year = year(anchor);
            let mut offset = 0i64;
            while offset < 400 {
                let candidate_year = anchor_year + offset as i32;
                // Construct first, then guard on the month, so 2/29 rolls into March and is
                // skipped exactly as the legacy `getMonth() !== targetMonth` does
                // (`automationCron.ts:214`).
                let date = at_time(candidate_year, target_month, target_day as i32, hour, minute);
                if month0(date) != target_month {
                    offset += interval;
                    continue;
                }
                let millis = to_millis(date);
                if millis > from {
                    return Some(millis);
                }
                offset += interval;
            }
            None
        }
    }
}

/// `buildRelativeDelaySchedule` — collapses "in N minutes" into a one-shot rule anchored to
/// the caller's clock (`automationCron.ts:72-83`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelativeDelaySchedule {
    /// Compatibility display only: a 5-field cron of the target's local minute/hour/day/month.
    pub cron_expr: String,
    pub schedule_rule: ScheduleRule,
}

pub fn build_relative_delay_schedule(delay_minutes: f64, from: Millis) -> RelativeDelaySchedule {
    let target = from_millis(from + (delay_minutes * 60.0 * 1_000.0) as i64);
    RelativeDelaySchedule {
        cron_expr: format!(
            "{} {} {} {} *",
            minute(target),
            hour(target),
            crate::localtime::day_of_month(target),
            month0(target) + 1
        ),
        schedule_rule: ScheduleRule {
            unit: Unit::Minute,
            interval: delay_minutes,
            hour: hour(target) as f64,
            minute: minute(target) as f64,
            anchor_at: from as f64,
            weekdays: None,
            month_days: None,
            months: None,
            monthly_mode: None,
        },
    }
}

/// `inferMinuteIntervalScheduleRule` — recognises `*&#47;N * * * *` as a product rule
/// (`automationCron.ts:228-240`).
pub fn infer_minute_interval_schedule_rule(cron_expr: &str, anchor_at: Millis) -> Option<ScheduleRule> {
    let trimmed = cron_expr.trim();
    let rest = trimmed.strip_prefix("*/")?;
    let (digits, tail) = rest.split_once(char::is_whitespace)?;
    // The legacy regex is `^\*\/([1-9]\d*)\s+\*\s+\*\s+\*\s+\*$` — the first group must not
    // start with 0, and the remaining four fields must all be `*`.
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) || digits.starts_with('0') {
        return None;
    }
    let fields: Vec<&str> = tail.split_whitespace().collect();
    if fields.len() != 4 || fields.iter().any(|f| *f != "*") {
        return None;
    }
    let anchor = from_millis(anchor_at);
    Some(ScheduleRule {
        unit: Unit::Minute,
        interval: digits.parse::<f64>().ok()?,
        hour: hour(anchor) as f64,
        minute: minute(anchor) as f64,
        anchor_at: anchor_at as f64,
        weekdays: None,
        month_days: None,
        months: None,
        monthly_mode: None,
    })
}

/// The five cron fields, with wildcard fields left as `None`.
///
/// Mirrors `parseCronFields` (`automationCron.ts:247-283`): only plain numbers and comma lists
/// are understood, and anything else degrades to `None` so the caller substitutes a safe
/// default. Step and `#` syntax is deliberately *not* supported here — the legacy comment at
/// `:270-272` says those exceeded the carrier scenario and were downgraded on purpose.
#[derive(Debug, Default, PartialEq)]
pub struct CronFields {
    pub minute: Option<f64>,
    pub hour: Option<f64>,
    pub month_days: Option<Vec<f64>>,
    pub months: Option<Vec<f64>>,
    pub weekdays: Option<Vec<f64>>,
}

pub fn parse_cron_fields(cron_expr: &str) -> CronFields {
    let parts: Vec<&str> = cron_expr.trim().split_whitespace().collect();
    if parts.len() < 5 {
        // Legacy returns `{}` so the caller falls back to anchor-derived defaults rather than
        // treating "0 9" as a valid cron (`automationCron.ts:263-265`).
        return CronFields::default();
    }
    let parse_single = |token: &str| -> Option<f64> {
        if token == "*" || token == "?" {
            return None;
        }
        token.parse::<f64>().ok().filter(|v| v.is_finite())
    };
    let parse_list = |token: &str| -> Option<Vec<f64>> {
        if token == "*" || token == "?" {
            return None;
        }
        let values: Vec<f64> = token
            .split(',')
            .filter_map(|piece| piece.parse::<f64>().ok().filter(|v| v.is_finite()))
            .collect();
        (!values.is_empty()).then_some(values)
    };
    CronFields {
        minute: parse_single(parts[0]),
        hour: parse_single(parts[1]),
        month_days: parse_list(parts[2]),
        months: parse_list(parts[3]),
        weekdays: parse_list(parts[4]),
    }
}

/// `buildIntervalScheduleRule` — normalises the model-authored interval carrier into the
/// authoritative rule (`automationCron.ts:301-348`).
///
/// Note the deliberate asymmetry the legacy code carries: the `hourly` branch discards `hour`
/// and the `minute` branch discards both, because the engine only reads the fields it needs
/// (`automationCron.ts:315-322`). That is preserved rather than "cleaned up".
pub fn build_interval_schedule_rule(
    interval_unit: Unit,
    interval: f64,
    cron_expr: &str,
    anchor_at: Millis,
) -> ScheduleRule {
    let fields = parse_cron_fields(cron_expr);
    let anchor = from_millis(anchor_at);
    // The legacy code shadows `minute`/`hour` with locals in the same statement
    // (`automationCron.ts:288-291`); Rust needs the functions captured first.
    let anchor_minute = minute(anchor) as f64;
    let anchor_hour = hour(anchor) as f64;
    let rule_minute = fields.minute.unwrap_or(anchor_minute);
    let rule_hour = fields.hour.unwrap_or(anchor_hour);
    let month_days = fields
        .month_days
        .unwrap_or_else(|| vec![crate::localtime::day_of_month(anchor) as f64]);
    // cron is 1-based for months; the rule is too (`automationCron.ts:290`).
    let months = fields.months.unwrap_or_else(|| vec![month0(anchor) as f64 + 1.0]);
    let weekdays = fields.weekdays.unwrap_or_else(|| vec![1.0]);

    match interval_unit {
        Unit::Minute => ScheduleRule {
            unit: Unit::Minute,
            interval,
            hour: anchor_hour,
            minute: anchor_minute,
            anchor_at: anchor_at as f64,
            weekdays: None,
            month_days: None,
            months: None,
            monthly_mode: None,
        },
        Unit::Hourly => ScheduleRule {
            unit: Unit::Hourly,
            interval,
            hour: 0.0,
            minute: rule_minute,
            anchor_at: anchor_at as f64,
            weekdays: None,
            month_days: None,
            months: None,
            monthly_mode: None,
        },
        Unit::Daily => ScheduleRule {
            unit: Unit::Daily,
            interval,
            hour: rule_hour,
            minute: rule_minute,
            anchor_at: anchor_at as f64,
            weekdays: None,
            month_days: None,
            months: None,
            monthly_mode: None,
        },
        Unit::Weekly => ScheduleRule {
            unit: Unit::Weekly,
            interval,
            hour: rule_hour,
            minute: rule_minute,
            anchor_at: anchor_at as f64,
            weekdays: Some(weekdays),
            month_days: None,
            months: None,
            monthly_mode: None,
        },
        Unit::Monthly => ScheduleRule {
            unit: Unit::Monthly,
            interval,
            hour: rule_hour,
            minute: rule_minute,
            anchor_at: anchor_at as f64,
            weekdays: None,
            month_days: Some(month_days),
            months: None,
            monthly_mode: Some(MonthlyMode::Date),
        },
        Unit::Yearly => ScheduleRule {
            unit: Unit::Yearly,
            interval,
            hour: rule_hour,
            minute: rule_minute,
            anchor_at: anchor_at as f64,
            weekdays: None,
            month_days: Some(month_days),
            months: Some(months),
            monthly_mode: None,
        },
    }
}

/// `scheduleRuleDefinition` — the change-detection key (`automationCron.ts:16-23`).
///
/// Two schedulers compare this string to decide whether a rule edit changed the schedule, so
/// it must be byte-identical: a `JSON.stringify` of a fixed-shape array where the three
/// calendar arrays are **sorted copies** and an absent field is `null`, not omitted.
pub fn schedule_rule_definition(rule: &ScheduleRule) -> String {
    let sorted = |values: Option<&Vec<f64>>| -> Option<String> {
        values.map(|list| {
            let mut copy = list.clone();
            copy.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let body = copy
                .iter()
                .map(|value| {
                    // JSON.stringify prints whole numbers without a decimal point.
                    if value.fract() == 0.0 {
                        format!("{}", *value as i64)
                    } else {
                        format!("{value}")
                    }
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("[{body}]")
        })
    };
    let monthly_mode = match rule.monthly_mode {
        Some(MonthlyMode::Date) => "\"date\"".to_string(),
        Some(MonthlyMode::Weekday) => "\"weekday\"".to_string(),
        None => "null".to_string(),
    };
    let number = |value: f64| -> String {
        if value.fract() == 0.0 {
            format!("{}", value as i64)
        } else {
            format!("{value}")
        }
    };
    format!(
        "[\"{}\",{},{},{},{},{},{},{}]",
        unit_name(rule.unit),
        number(rule.interval),
        number(rule.hour),
        number(rule.minute),
        sorted(rule.weekdays.as_ref()).unwrap_or_else(|| "null".to_string()),
        sorted(rule.month_days.as_ref()).unwrap_or_else(|| "null".to_string()),
        sorted(rule.months.as_ref()).unwrap_or_else(|| "null".to_string()),
        monthly_mode,
    )
}

fn unit_name(unit: Unit) -> &'static str {
    match unit {
        Unit::Minute => "minute",
        Unit::Hourly => "hourly",
        Unit::Daily => "daily",
        Unit::Weekly => "weekly",
        Unit::Monthly => "monthly",
        Unit::Yearly => "yearly",
    }
}

/// `isOneShotAutomation` — `!recurring && (maxRuns ?? 1) <= 1` (`automationCron.ts:45-48`).
///
/// The `?? 1` matters: a missing `maxRuns` is one run, not zero. A caller passing `Some(0)`
/// gets one-shot too, since `0 <= 1`.
pub fn is_one_shot_automation(recurring: bool, max_runs: Option<f64>) -> bool {
    !recurring && max_runs.unwrap_or(1.0) <= 1.0
}

/// `computeAutomationNextRunAt` — the entry point both schedulers call
/// (`automationCron.ts:353-358`). A `scheduleRule` is authoritative; the cron expression is the
/// compatibility display and only used when no rule exists.
pub fn compute_automation_next_run_at(
    cron_expr: &str,
    rule: Option<&ScheduleRule>,
    from: Millis,
) -> Option<Millis> {
    match rule {
        Some(rule) => compute_schedule_rule_next_run_at(rule, from),
        None => crate::expr::compute_next_run_at(cron_expr, from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::localtime::{day_of_month, hour as lhour, minute as lminute, month0 as lmonth0};

    fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> Millis {
        to_millis(at_time(year, month, day as i32, hour, minute))
    }

    fn rule<F: FnOnce(&mut ScheduleRule)>(unit: Unit, from: Millis, extra: F) -> ScheduleRule {
        let mut r = ScheduleRule {
            unit,
            interval: 1.0,
            hour: 9.0,
            minute: 30.0,
            anchor_at: from as f64,
            weekdays: None,
            month_days: None,
            months: None,
            monthly_mode: None,
        };
        extra(&mut r);
        r
    }

    /// The February overflow the legacy `getMonth() !== targetMonth` guard depends on. If the
    /// port clamped instead of rolling, a Feb-29 automation would fire in March.
    #[test]
    fn yearly_feb_29_skips_non_leap_years_instead_of_firing_in_march() {
        let anchor = at(2025, 0, 1, 9, 30);
        let r = rule(Unit::Yearly, anchor, |r| {
            r.months = Some(vec![2.0]);
            r.month_days = Some(vec![29.0]);
        });
        let next = compute_schedule_rule_next_run_at(&r, at(2025, 0, 1, 0, 0)).unwrap();
        let fired = from_millis(next);
        assert_eq!(lmonth0(fired), 1, "must land in February");
        assert_eq!(day_of_month(fired), 29);
        assert_eq!(year(fired), 2028, "2028 is the next leap year after 2025");
    }

    #[test]
    fn yearly_month_day_31_skips_short_months() {
        let anchor = at(2025, 0, 1, 9, 30);
        let r = rule(Unit::Yearly, anchor, |r| {
            r.months = Some(vec![2.0]);
            r.month_days = Some(vec![31.0]);
        });
        // February never has a 31st, so the search exhausts and reports no future fire,
        // matching the legacy behaviour of rolling and then skipping every candidate.
        let next = compute_schedule_rule_next_run_at(&r, at(2025, 0, 1, 0, 0));
        assert_eq!(next, None);
    }

    #[test]
    fn daily_advances_by_the_interval() {
        let anchor = at(2025, 5, 10, 9, 30);
        let r = rule(Unit::Daily, anchor, |r| r.interval = 3.0);
        let next = compute_schedule_rule_next_run_at(&r, at(2025, 5, 10, 9, 30)).unwrap();
        let fired = from_millis(next);
        assert_eq!((lmonth0(fired), day_of_month(fired)), (5, 13));
    }

    #[test]
    fn daily_is_strictly_later_than_from() {
        let anchor = at(2025, 5, 10, 9, 30);
        let r = rule(Unit::Daily, anchor, |_| {});
        // Exactly on a fire time must roll to the next day, never return the same instant.
        let next = compute_schedule_rule_next_run_at(&r, at(2025, 5, 10, 9, 30)).unwrap();
        assert_eq!(next, at(2025, 5, 11, 9, 30));
    }

    #[test]
    fn minute_unit_derives_from_the_anchor_not_from_now() {
        // The whole point of the anchor derivation (`automationCron.ts:143-146`): a late
        // dispatch must not accumulate drift.
        let anchor = at(2025, 5, 10, 9, 0);
        let r = rule(Unit::Minute, anchor, |r| r.interval = 15.0);
        let a = compute_schedule_rule_next_run_at(&r, at(2025, 5, 10, 9, 0)).unwrap();
        let b = compute_schedule_rule_next_run_at(&r, at(2025, 5, 10, 9, 7)).unwrap();
        assert_eq!(a, b, "7 minutes late must still yield the same anchored fire time");
        assert_eq!(a, at(2025, 5, 10, 9, 15));
    }

    #[test]
    fn interval_is_sanitised_to_at_least_one() {
        let anchor = at(2025, 5, 10, 9, 0);
        for interval in [0.0, -5.0, 0.4] {
            let r = rule(Unit::Minute, anchor, |r| r.interval = interval);
            let next = compute_schedule_rule_next_run_at(&r, anchor).unwrap();
            assert_eq!(next, at(2025, 5, 10, 9, 1), "interval {interval} must behave as 1");
        }
    }

    #[test]
    fn weekly_uses_monday_based_days() {
        let anchor = at(2025, 5, 11, 9, 0); // Wednesday
        let r = rule(Unit::Weekly, anchor, |r| r.weekdays = Some(vec![1.0])); // Monday
        let next = compute_schedule_rule_next_run_at(&r, anchor).unwrap();
        let fired = from_millis(next);
        // June 2025 Mondays are 2, 9, 16, 23, 30 (verified against Node), so the next one
        // after Wednesday the 11th is the 16th. A Sunday-based conversion would give the 17th.
        assert_eq!(day_of_month(fired), 16);
        assert_eq!(lmonth0(fired), 5);
    }

    #[test]
    fn monthly_by_date_picks_the_configured_day() {
        let anchor = at(2025, 0, 15, 9, 0);
        let r = rule(Unit::Monthly, anchor, |r| r.month_days = Some(vec![28.0]));
        let next = compute_schedule_rule_next_run_at(&r, at(2025, 0, 20, 0, 0)).unwrap();
        let fired = from_millis(next);
        assert_eq!((lmonth0(fired), day_of_month(fired)), (0, 28));
    }

    #[test]
    fn monthly_by_weekday_picks_the_first_weekday_of_the_month() {
        let anchor = at(2025, 0, 15, 9, 0);
        let r = rule(Unit::Monthly, anchor, |r| {
            r.monthly_mode = Some(MonthlyMode::Weekday);
            r.weekdays = Some(vec![1.0]); // first Monday
        });
        let next = compute_schedule_rule_next_run_at(&r, at(2025, 0, 20, 0, 0)).unwrap();
        let fired = from_millis(next);
        // February 2025 starts on a Saturday, so the first Monday is the 3rd.
        assert_eq!((lmonth0(fired), day_of_month(fired)), (1, 3));
    }

    #[test]
    fn hourly_uses_the_rule_minute() {
        let anchor = at(2025, 5, 10, 9, 0);
        let r = rule(Unit::Hourly, anchor, |r| {
            r.interval = 2.0;
            r.minute = 45.0;
        });
        let next = compute_schedule_rule_next_run_at(&r, at(2025, 5, 10, 9, 0)).unwrap();
        assert_eq!(next, at(2025, 5, 10, 9, 45));
    }

    #[test]
    fn one_shot_detection_defaults_missing_max_runs_to_one() {
        assert!(is_one_shot_automation(false, None));
        assert!(is_one_shot_automation(false, Some(1.0)));
        assert!(is_one_shot_automation(false, Some(0.0)));
        assert!(!is_one_shot_automation(false, Some(2.0)));
        assert!(!is_one_shot_automation(true, None), "recurring is never one-shot");
        assert!(!is_one_shot_automation(true, Some(1.0)));
    }

    /// The change-detection key is compared as a string by both schedulers, so a byte
    /// difference silently re-schedules every automation on upgrade.
    #[test]
    fn schedule_rule_definition_is_order_independent_and_uses_null_for_absent() {
        let a = ScheduleRule {
            unit: Unit::Weekly,
            interval: 2.0,
            hour: 9.0,
            minute: 30.0,
            anchor_at: 1000.0,
            weekdays: Some(vec![5.0, 1.0, 3.0]),
            month_days: None,
            months: None,
            monthly_mode: None,
        };
        let mut b = a.clone();
        b.weekdays = Some(vec![1.0, 3.0, 5.0]);
        assert_eq!(schedule_rule_definition(&a), schedule_rule_definition(&b));
        assert_eq!(
            schedule_rule_definition(&a),
            "[\"weekly\",2,9,30,[1,3,5],null,null,null]"
        );
    }

    #[test]
    fn schedule_rule_definition_distinguishes_anchor_free_fields_only() {
        // anchorAt is deliberately excluded: it is not part of "did the schedule change".
        let base = ScheduleRule {
            unit: Unit::Daily,
            interval: 1.0,
            hour: 9.0,
            minute: 0.0,
            anchor_at: 1.0,
            weekdays: None,
            month_days: None,
            months: None,
            monthly_mode: None,
        };
        let mut moved = base.clone();
        moved.anchor_at = 999_999.0;
        assert_eq!(schedule_rule_definition(&base), schedule_rule_definition(&moved));
        let mut changed = base.clone();
        changed.hour = 10.0;
        assert_ne!(schedule_rule_definition(&base), schedule_rule_definition(&changed));
    }

    #[test]
    fn cron_field_parsing_degrades_to_none_for_unsupported_syntax() {
        let plain = parse_cron_fields("30 9 1 1 *");
        assert_eq!(plain.minute, Some(30.0));
        assert_eq!(plain.hour, Some(9.0));
        assert_eq!(plain.month_days, Some(vec![1.0]));

        // Step syntax is explicitly unsupported (legacy comment at `automationCron.ts:270`).
        let step = parse_cron_fields("*/5 * * * *");
        assert_eq!(step.minute, None);

        // Fewer than five fields yields an empty result, never a partial parse.
        assert_eq!(parse_cron_fields("0 9"), CronFields::default());

        let list = parse_cron_fields("0 9 1,15 * 1,3");
        assert_eq!(list.month_days, Some(vec![1.0, 15.0]));
        assert_eq!(list.weekdays, Some(vec![1.0, 3.0]));
    }

    #[test]
    fn interval_carrier_drops_fields_the_engine_never_reads() {
        let anchor = at(2025, 5, 10, 14, 20);
        // minute and hourly both discard `hour` on purpose (`automationCron.ts:315-322`).
        let minute_rule = build_interval_schedule_rule(Unit::Minute, 5.0, "0 9 * * *", anchor);
        assert_eq!((minute_rule.hour, minute_rule.minute), (14.0, 20.0));
        let hourly = build_interval_schedule_rule(Unit::Hourly, 2.0, "30 9 * * *", anchor);
        assert_eq!(hourly.hour, 0.0);
        assert_eq!(hourly.minute, 30.0);
    }

    #[test]
    fn relative_delay_schedule_anchors_to_the_caller_clock() {
        let from = at(2025, 5, 10, 9, 0);
        let schedule = build_relative_delay_schedule(90.0, from);
        // 90 minutes later is 10:30 on the same day.
        assert_eq!(schedule.cron_expr, "30 10 10 6 *");
        assert_eq!(schedule.schedule_rule.interval, 90.0);
        assert_eq!(schedule.schedule_rule.anchor_at, from as f64);
        let fired = from_millis(schedule.schedule_rule.anchor_at as Millis);
        assert_eq!((lhour(fired), lminute(fired)), (9, 0));
    }

    #[test]
    fn minute_interval_inference_requires_the_exact_star_form() {
        let anchor = at(2025, 5, 10, 9, 7);
        let inferred = infer_minute_interval_schedule_rule("*/15 * * * *", anchor).unwrap();
        assert_eq!(inferred.interval, 15.0);
        assert_eq!((inferred.hour, inferred.minute), (9.0, 7.0));
        // A leading zero is rejected by the legacy regex `[1-9]\d*`.
        assert!(infer_minute_interval_schedule_rule("*/05 * * * *", anchor).is_none());
        assert!(infer_minute_interval_schedule_rule("*/15 * * * 1", anchor).is_none());
        assert!(infer_minute_interval_schedule_rule("0 9 * * *", anchor).is_none());
    }

    #[test]
    fn monthly_bound_is_inclusive_so_a_cycle_can_roll() {
        // The inclusive bound (legacy comment `automationCron.ts:187-188`) means offset 1200
        // is a reachable candidate, so a rule whose current candidate expired can still roll a
        // full 100-year cycle instead of returning null.
        let anchor = at(2025, 0, 1, 9, 0);
        let r = rule(Unit::Monthly, anchor, |r| {
            r.interval = 1200.0;
            r.month_days = Some(vec![1.0]);
        });
        // The `rule` helper defaults to 09:30, so the candidates fire at :30 past.
        assert_eq!(
            compute_schedule_rule_next_run_at(&r, at(2124, 0, 1, 0, 0)),
            Some(at(2125, 0, 1, 9, 30)),
            "offset exactly 1200 must be considered"
        );
        // Past that, the search is exhausted and reports no future fire.
        assert_eq!(
            compute_schedule_rule_next_run_at(&r, at(2126, 0, 1, 0, 0)),
            None,
            "the bound is inclusive, not unbounded"
        );
    }
}
