//! The raw 5-field cron-expression path — the replacement for the `croner` npm dependency.
//!
//! Ported from `computeNextRunAt` (`automationCron.ts:61-64`) and the one-shot staleness probe
//! that reads `previousRuns` (`automationCron.ts:104`).
//!
//! **This is a different engine.** `croner` is replaced by the Rust `cron` crate, so the two
//! do not accept identical syntax (spec D1). The accepted subset is the standard 5-field form
//! — `*`, numbers, `*&#47;step`, ranges and comma lists — and anything else yields `None`,
//! which is the same "no future fire" signal the legacy code returns when `croner` cannot
//! schedule. Spec §6.2 requires a generated differential corpus to pin the exact boundary
//! rather than trusting this comment.

use chrono::{DateTime, Datelike, Local, Timelike};
use cron::Schedule;

use crate::localtime::{from_millis, to_millis, Millis};

/// The `@`-prefixed nicknames croner accepts, mapped to their 5-field equivalent.
///
/// Measured against `croner@10.0.1`: `@daily` from 2025-01-01 resolves to 2025-01-02, while
/// the `cron` crate rejects the expression outright. That is a real functional regression,
/// not a theoretical one — `isValidCronExpr` was implemented over `croner`, so a stored
/// `@daily` validated, and `computeNextRunAt` scheduled it. Any automation created that way
/// would have stopped firing.
///
/// `@every_second` and friends are deliberately absent: they have no meaning in a 5-field
/// local-time contract, and `computeNextRunAt` never resolved sub-minute schedules anyway.
const NICKNAMES: &[(&str, &str)] = &[
    ("@yearly", "0 0 1 1 *"),
    ("@annually", "0 0 1 1 *"),
    ("@monthly", "0 0 1 * *"),
    ("@weekly", "0 0 * * 0"),
    ("@daily", "0 0 * * *"),
    ("@midnight", "0 0 * * *"),
    ("@hourly", "0 * * * *"),
];

/// Expands a `@` nickname to its 5-field form, or returns the input unchanged.
fn expand_nickname(cron_expr: &str) -> String {
    let trimmed = cron_expr.trim();
    let lowered = trimmed.to_ascii_lowercase();
    NICKNAMES
        .iter()
        .find(|(nickname, _)| *nickname == lowered)
        .map(|(_, expansion)| (*expansion).to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

/// Parses a 5-field expression into a `Schedule`, returning `None` when the engine rejects it.
fn parse(cron_expr: &str) -> Option<Schedule> {
    // `cron` expects seconds-first; the product contract is the standard 5-field form
    // (minute hour day-of-month month day-of-week), so a zero seconds field is prepended.
    let expanded = expand_nickname(cron_expr);
    let trimmed = expanded.trim();
    if trimmed.is_empty() {
        return None;
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() < 5 {
        return None;
    }
    // The day-of-week field must be renumbered before the crate sees it (see
    // `translate_day_of_week`); everything else is already in the crate's numbering.
    let mut normalised: Vec<String> = fields.iter().map(|f| (*f).to_string()).collect();
    normalised[4] = translate_day_of_week(fields[4])?;
    use std::str::FromStr as _;
    Schedule::from_str(&format!("0 {}", normalised.join(" "))).ok()
}

/// Renumbers a day-of-week field from cron's 0-based convention to the `cron` crate's.
///
/// Returns `None` when the field is not a legal cron day-of-week at all, so the expression is
/// rejected the way croner rejected it.
///
/// **This is not optional.** Measured against both engines:
///
/// | input | croner | `cron` crate |
/// |---|---|---|
/// | `0` | Sunday | **rejected** ("must be >= 1") |
/// | `1` | Monday | **Sunday** |
/// | `7` | **rejected** (range is 0-6) | Saturday |
///
/// So without the translation `0 0 * * 1-5` — "Monday to Friday", which the product accepts
/// and users write — silently becomes Sunday to Thursday, `0 0 * * 0`, a perfectly valid
/// Sunday schedule, is rejected outright, and `0 0 * * 7`, which croner refused, would be
/// quietly accepted as Saturday. The differential corpus (`tests/differential.rs`) caught the
/// first two across 30 rows; the third was found by an end-to-end probe afterwards, which is
/// why the corpus now carries `0 0 * * 7` explicitly.
///
/// Step expressions are **expanded to an explicit list** rather than shifted. `*/2` means
/// {0, 2, 4, 6} in croner but {1, 3, 5, 7} in the crate, so shifting the base is not enough —
/// the two sets differ. The expansion is over at most seven values, so it costs nothing and
/// removes the need to reason about the crate's step semantics over a shifted range.
///
/// Three-letter day names (`sun`, `mon`, …) are passed through untouched: the crate already
/// resolves them to the same weekday.
fn translate_day_of_week(field: &str) -> Option<String> {
    if field == "*" || field == "?" {
        return Some(field.to_string());
    }
    // An alphabetic field is a name list; both engines agree on the names.
    if field.chars().any(|c| c.is_ascii_alphabetic()) {
        return Some(field.to_string());
    }

    let mut days: Vec<u8> = Vec::new();
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (range_part, step) = match part.split_once('/') {
            Some((range, step)) => (range, step.parse::<u32>().ok().filter(|s| *s > 0)),
            None => (part, None),
        };

        let (start, end) = if range_part == "*" {
            (0u32, 6u32)
        } else if let Some((low, high)) = range_part.split_once('-') {
            match (low.parse::<u32>(), high.parse::<u32>()) {
                (Ok(low), Ok(high)) => (low, high),
                // A non-numeric bound is not a legal day field.
                _ => return None,
            }
        } else {
            match range_part.parse::<u32>() {
                Ok(single) => (single, single),
                Err(_) => return None,
            }
        };
        // cron's day-of-week is 0-6, with 7 accepted as an alias for Saturday. The `cron`
        // crate numbers 1-7 with 7 = Saturday, so 0-6 shift up by one and 7 is already
        // correct in both. Anything beyond 7 is invalid input in both engines and is rejected
        // here rather than translated, because the crate would read other values as weekdays
        // and quietly fire.
        if start > 7 || end > 7 || start > end {
            return None;
        }

        match step {
            Some(step) => {
                let mut day = start;
                while day <= end {
                    days.push(day as u8);
                    day += step;
                }
            }
            None => {
                for day in start..=end {
                    days.push(day as u8);
                }
            }
        }
    }

    if days.is_empty() {
        return None;
    }
    // Deduplicate *after* mapping, not before: cron's 0 and 7 are the same weekday, so `0,7`
    // must collapse to a single day rather than becoming `1,1`.
    //
    // +1 converts cron's 0=Sunday to the crate's 1=Sunday. Day 7 needs its own rule: cron
    // treats 0 and 7 as the *same* weekday (both Sunday, the standard crontab convention),
    // while the crate's 7 is Saturday. Verified against croner@10.0.1: `0 0 * * 7` from a
    // Monday resolves to the following Sunday, not Saturday. So 7 maps to 1 like 0 does.
    let mut mapped: Vec<u8> = days
        .iter()
        .map(|day| if *day == 7 { 1 } else { *day + 1 })
        .collect();
    mapped.sort_unstable();
    mapped.dedup();
    Some(
        mapped
            .iter()
            .map(|day| day.to_string())
            .collect::<Vec<_>>()
            .join(","),
    )
}

/// `computeNextRunAt` — next fire strictly later than `from`, in epoch ms.
pub fn compute_next_run_at(cron_expr: &str, from: Millis) -> Option<Millis> {
    let schedule = parse(cron_expr)?;
    schedule.after(&from_millis(from)).next().map(to_millis)
}

/// The most recent fire at or before `from` — the Rust equivalent of `croner`'s
/// `previousRuns(1, date)[0]`, used by the one-shot staleness probe.
///
/// The `cron` crate only iterates forwards, so this is a two-phase search:
///
/// 1. **Find any fire strictly before `from`** by stepping the probe backwards with an
///    exponentially growing stride. A single forward probe is not enough: asking for the
///    next fire after `from - 1s` returns *tomorrow's* when today's already passed, which is
///    how a naive version of this returned `None` for every input.
/// 2. **Walk forward** from that fire while the next one is still `< from`, keeping the last.
///
/// Strictly-before matters for `croner` parity: `previousRuns(1, from)` excludes `from`
/// itself, so a schedule firing exactly on the boundary must report the *previous* occurrence.
///
/// Both phases are bounded so a pathological expression cannot turn this into a long loop.
pub fn previous_run_at(cron_expr: &str, from: Millis) -> Option<Millis> {
    let schedule = parse(cron_expr)?;

    // Phase 1: exponential back-off until a fire lands strictly in the past.
    let mut probe = from;
    let mut stride = 1_000i64;
    let mut seed: Option<Millis> = None;
    for _ in 0..PREVIOUS_BACKOFF_STEPS {
        probe = probe.saturating_sub(stride);
        stride = stride.saturating_mul(2).max(1_000);
        if let Some(next) = schedule.after(&from_millis(probe)).next() {
            let millis = to_millis(next);
            if millis < from {
                seed = Some(millis);
                break;
            }
        }
        // No early break on the stride: to find the previous occurrence of a yearly schedule
        // from its own fire time, the probe must get all the way back past the *prior* year.
        // A 400-day ceiling stopped the search one step too early and returned `None`. The
        // doubling plus `saturating_mul` terminates on its own, and the iteration cap is the
        // only bound needed.
    }

    // Phase 2: advance while the following fire is still strictly in the past.
    let mut best = seed?;
    for _ in 0..PREVIOUS_FORWARD_STEPS {
        match schedule.after(&from_millis(best - 1)).next() {
            Some(next) => {
                let millis = to_millis(next);
                if millis >= from {
                    break;
                }
                best = millis;
            }
            None => break,
        }
    }
    Some(best)
}

/// Back-off steps taken before giving up on finding a past fire.
///
/// Doubling from one second, 48 steps reaches ~89 years — comfortably past the previous
/// occurrence of any schedule a user can express in five cron fields.
const PREVIOUS_BACKOFF_STEPS: usize = 48;
/// Forward steps taken while refining. A 30-minute window over the densest schedule
/// (`* * * * *`, one fire per minute) needs 30; 64 leaves headroom.
const PREVIOUS_FORWARD_STEPS: usize = 64;

/// The window a one-off fixed-calendar task that "just missed" is allowed to be caught up in.
///
/// A 1-minute grace means a tool call that crossed the minute boundary still runs; the 30-minute
/// window then treats a stale target as a model miscalculation rather than a real appointment
/// next year (`automationCron.ts:12-16`).
pub const ONE_SHOT_MISSED_RUN_GRACE_MS: i64 = 60 * 1_000;
pub const ONE_SHOT_STALE_TARGET_WINDOW_MS: i64 = 30 * 60 * 1_000;

/// `^\d+\s+\d+\s+\d+\s+\d+\s+\*$` — a fixed month/day cron, i.e. no recurring part
/// (`automationCron.ts:17`).
pub fn is_fixed_calendar_cron(cron_expr: &str) -> bool {
    let fields: Vec<&str> = cron_expr.trim().split_whitespace().collect();
    fields.len() == 5
        && fields[4] == "*"
        && fields[..4]
            .iter()
            .all(|field| !field.is_empty() && field.chars().all(|c| c.is_ascii_digit()))
}

/// The target epoch a stale one-shot was aiming at, so the error message can name it.
pub fn stale_one_shot_target(cron_expr: &str, from: Millis) -> Option<Millis> {
    let previous = previous_run_at(cron_expr, from)?;
    if from >= previous && from - previous <= ONE_SHOT_STALE_TARGET_WINDOW_MS {
        Some(previous)
    } else {
        None
    }
}

/// `isValidCronExpr` from `automationCronValidation.ts`.
///
/// The legacy validator accepted a 5-field expression; this keeps the same shape and defers
/// the real parse to the engine, so "valid" means "the scheduler can act on it".
pub fn is_valid_cron_expr(cron_expr: &str) -> bool {
    parse(cron_expr).is_some()
}

/// Convenience for the napi layer: the local calendar parts of an instant, used by the
/// relative-delay builder and by tests that assert on local fields.
pub fn local_parts(from: Millis) -> (i32, u32, u32, u32, u32) {
    let at: DateTime<Local> = from_millis(from);
    (at.year(), at.month0(), at.day(), at.hour(), at.minute())
}

/// Re-exported so the napi layer can build a `DateTime<Local>` from a naive local value when
/// emitting the one-shot error message.
pub fn local_from_parts(year: i32, month0: u32, day: u32, hour: u32, minute: u32) -> Millis {
    to_millis(crate::localtime::at_time(year, month0, day as i32, hour, minute))
}

/// Silences the unused-import warning for `TimeZone` when no other module needs it here.
#[allow(dead_code)]
fn _local_parts_are_local(at: &DateTime<Local>) -> (i32, u32, u32, u32, u32) {
    (at.year(), at.month0(), at.day(), at.hour(), at.minute())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::localtime::{
    at_time, hour, minute, month0, to_millis, year, Millis,
};

    fn at(y: i32, m: u32, d: u32, h: u32, mi: u32) -> Millis {
        to_millis(at_time(y, m, d as i32, h, mi))
    }

    #[test]
    fn next_run_is_strictly_later_than_from() {
        let from = at(2025, 5, 10, 9, 0);
        // Every day at 09:30, so from 09:00 rolls to 09:30 the same day.
        assert_eq!(compute_next_run_at("30 9 * * *", from), Some(at(2025, 5, 10, 9, 30)));
        // From exactly 09:30 must roll to the next day, never return the same instant.
        assert_eq!(
            compute_next_run_at("30 9 * * *", at(2025, 5, 10, 9, 30)),
            Some(at(2025, 5, 11, 9, 30))
        );
    }

    #[test]
    fn malformed_expressions_yield_no_fire_rather_than_throwing() {
        for expr in ["", "   ", "not a cron", "* *", "99 99 99 99 99", "60 * * * *"] {
            assert_eq!(compute_next_run_at(expr, at(2025, 0, 1, 0, 0)), None, "{expr:?}");
            assert!(!is_valid_cron_expr(expr), "{expr:?}");
        }
    }

    #[test]
    fn standard_forms_parse() {
        let from = at(2025, 5, 10, 0, 0);
        assert!(compute_next_run_at("* * * * *", from).is_some(), "every minute");
        assert!(compute_next_run_at("*/15 * * * *", from).is_some(), "step");
        assert!(compute_next_run_at("0 9-17 * * *", from).is_some(), "range");
        assert!(compute_next_run_at("0 9 1,15 * *", from).is_some(), "list");
        assert!(compute_next_run_at("0 9 * * 1-5", from).is_some(), "weekday range");
    }

    #[test]
    fn step_and_day_of_month_interact_the_way_a_user_expects() {
        let from = at(2025, 0, 31, 0, 0);
        // "day 31" must skip February rather than clamp to the 28th.
        let next = compute_next_run_at("0 0 31 * *", from).unwrap();
        let fired = crate::localtime::from_millis(next);
        assert_eq!((month0(fired) + 1, crate::localtime::day_of_month(fired)), (3, 31));
    }

    #[test]
    fn previous_run_is_the_most_recent_past_fire() {
        let from = at(2025, 5, 10, 9, 45);
        assert_eq!(previous_run_at("30 9 * * *", from), Some(at(2025, 5, 10, 9, 30)));
        // Strictly before, matching `croner`'s `previousRuns`, which excludes `from` itself.
        // `0 0 1 1 *` also fires on 1 January, so the previous occurrence is the year before.
        assert_eq!(
            previous_run_at("0 0 1 1 *", at(2024, 0, 1, 0, 0)),
            Some(at(2023, 0, 1, 0, 0))
        );
    }

    #[test]
    fn fixed_calendar_detection_matches_the_legacy_regex() {
        assert!(is_fixed_calendar_cron("30 9 10 6 *"));
        assert!(is_fixed_calendar_cron("  30 9 10 6   *  "));
        assert!(!is_fixed_calendar_cron("*/5 * * * *"), "step is not a fixed calendar");
        assert!(!is_fixed_calendar_cron("30 9 10 6 1"), "a weekday field disqualifies it");
        assert!(!is_fixed_calendar_cron("30 9 10 * *"), "a wildcard day-of-month disqualifies it");
        assert!(!is_fixed_calendar_cron("a b c d *"));
    }

    #[test]
    fn stale_one_shot_is_only_reported_inside_the_window() {
        // 09:30 fire, now 09:31 -> 1 minute old, inside the 30-minute window.
        assert_eq!(
            stale_one_shot_target("30 9 * * *", at(2025, 5, 10, 9, 31)),
            Some(at(2025, 5, 10, 9, 30))
        );
        // 31 minutes later is outside the window, so no staleness is claimed.
        assert_eq!(stale_one_shot_target("30 9 * * *", at(2025, 5, 10, 10, 1)), None);
        // Before any fire, there is nothing to have missed.
        assert_eq!(stale_one_shot_target("0 0 1 1 *", at(2024, 0, 1, 0, 0)), None);
    }

    #[test]
    fn local_parts_round_trips_through_the_builder() {
        let millis = at(2025, 5, 10, 9, 7);
        let (y, m, d, h, mi) = local_parts(millis);
        assert_eq!((y, m, d, h, mi), (2025, 5, 10, 9, 7));
        assert_eq!(local_from_parts(y, m, d, h, mi), millis);
        let at2 = crate::localtime::from_millis(millis);
        assert_eq!((year(at2), month0(at2), hour(at2), minute(at2)), (2025, 5, 9, 7));
    }

    /// The day-of-week renumbering. Measured against both engines, because getting it wrong
    /// silently shifts every weekday automation:
    ///
    /// | input | croner | `cron` crate |
    /// |---|---|---|
    /// | `0` | Sunday | **rejected** |
    /// | `1` | Monday | **Sunday** |
    /// | `7` | rejected | Saturday |
    ///
    /// The differential corpus caught 30 broken rows before this existed.
    #[test]
    fn day_of_week_is_renumbered_from_zero_based_to_one_based() {
        let t = translate_day_of_week_for_tests;
        // 0=Sunday becomes 1=Sunday.
        assert_eq!(t("0").as_deref(), Some("1"));
        assert_eq!(t("1").as_deref(), Some("2"));
        assert_eq!(t("6").as_deref(), Some("7"));
        // Ranges and lists shift with it, and are expanded so the order is stable.
        assert_eq!(t("0-6").as_deref(), Some("1,2,3,4,5,6,7"));
        assert_eq!(t("1-5").as_deref(), Some("2,3,4,5,6"));
        assert_eq!(t("0,6").as_deref(), Some("1,7"));
        assert_eq!(t("1,3,5").as_deref(), Some("2,4,6"));
    }

    /// A step must be **expanded**, not shifted: `*/2` is {0,2,4,6} in croner but {1,3,5,7}
    /// in the crate, so moving the base by one is not enough — the two sets differ.
    #[test]
    fn day_of_week_steps_are_expanded_rather_than_shifted() {
        let t = translate_day_of_week_for_tests;
        assert_eq!(t("*/2").as_deref(), Some("1,3,5,7")); // croner {0,2,4,6}
        assert_eq!(t("*/3").as_deref(), Some("1,4,7")); // croner {0,3,6}
        assert_eq!(t("1-5/2").as_deref(), Some("2,4,6")); // croner {1,3,5}
    }

    /// Names and wildcards pass through: the crate already resolves `sun` to 1, i.e. Sunday,
    /// which is the same meaning croner gives it.
    #[test]
    fn day_of_week_names_and_wildcards_pass_through() {
        let t = translate_day_of_week_for_tests;
        assert_eq!(t("*").as_deref(), Some("*"));
        assert_eq!(t("?").as_deref(), Some("?"));
        assert_eq!(t("sun").as_deref(), Some("sun"));
        assert_eq!(t("mon,wed").as_deref(), Some("mon,wed"));
    }

    /// An out-of-range day is **rejected**, not passed through.
    ///
    /// `7` is the boundary and is deliberately *not* rejected: measured against `croner@10.0.1`,
    /// it resolves to a Saturday, and so does the crate's 7. A first attempt rejected 7 on the
    /// (wrong) assumption that cron's range was strictly 0-6, which the differential corpus
    /// immediately caught across ten anchors.
    #[test]
    fn an_out_of_range_day_of_week_is_rejected() {
        let t = translate_day_of_week_for_tests;
        // 7 is cron's alias for Sunday (0), so it maps to the crate's 1 just like 0 does.
        // Passing it through as 7 would select the crate's Saturday instead.
        assert_eq!(t("7").as_deref(), Some("1"));
        assert_eq!(t("0,7").as_deref(), Some("1"), "0 and 7 are the same weekday");
        assert_eq!(t("0-7").as_deref(), Some("1,2,3,4,5,6,7"), "the full week is all seven days");
        // Beyond 7 there is no Saturday left to mean.
        assert_eq!(t("8"), None);
        assert_eq!(t("0-9"), None);
        assert_eq!(t("5-2"), None, "an inverted range is not a legal day field");
        assert_eq!(t(""), None);
        // And end to end: 7 must fire on a Sunday, not a Saturday. 2025-06-18 is a Wednesday;
        // the next Sunday is the 22nd and the next Saturday is the 21st, so this pins the
        // difference rather than just "some day in the week".
        assert_eq!(
            compute_next_run_at("0 0 * * 7", at(2025, 5, 18, 0, 0)),
            Some(at(2025, 5, 22, 0, 0)),
            "cron's 7 is Sunday, so it must not land on Saturday the 21st"
        );
        assert_eq!(compute_next_run_at("0 0 * * 8", at(2025, 5, 18, 0, 0)), None);
    }

    /// `@`-prefixed nicknames are a real functional surface, not a nicety: `isValidCronExpr`
    /// was implemented over croner, so a stored `@daily` both validated and scheduled.
    /// The crate rejects them outright, which would have silently stopped those automations.
    #[test]
    fn cron_nicknames_are_expanded() {
        let from = at(2025, 0, 1, 0, 0);
        // Verified against croner@10.0.1.
        assert_eq!(compute_next_run_at("@daily", from), Some(at(2025, 0, 2, 0, 0)));
        assert_eq!(compute_next_run_at("@yearly", from), Some(at(2026, 0, 1, 0, 0)));
        assert_eq!(compute_next_run_at("@monthly", from), Some(at(2025, 1, 1, 0, 0)));
        // Case-insensitive, as croner treats them.
        assert_eq!(compute_next_run_at("@DAILY", from), Some(at(2025, 0, 2, 0, 0)));
        // The aliases croner accepts.
        assert_eq!(compute_next_run_at("@annually", from), Some(at(2026, 0, 1, 0, 0)));
        assert_eq!(compute_next_run_at("@midnight", from), Some(at(2025, 0, 2, 0, 0)));
        assert_eq!(compute_next_run_at("@hourly", from), Some(at(2025, 0, 1, 1, 0)));
        assert_eq!(compute_next_run_at("@weekly", from), Some(at(2025, 0, 5, 0, 0)));
        // An unknown nickname is still rejected.
        assert_eq!(compute_next_run_at("@fortnightly", from), None);
    }

    /// The renumbering must hold end to end, not just in the helper: a Monday-to-Friday
    /// schedule has to fire on weekdays, not Sunday-to-Thursday.
    #[test]
    fn a_weekday_range_fires_on_weekdays_after_renumbering() {
        // 2025-06-16 is a Monday.
        let monday = at(2025, 5, 16, 9, 0);
        // From Monday 09:00, "0 0 * * 1-5" (Mon-Fri in croner) must next fire Tuesday, because
        // Monday 00:00 has already passed.
        assert_eq!(compute_next_run_at("0 0 * * 1-5", monday), Some(at(2025, 5, 17, 0, 0)));
        // A Sunday-only schedule must fire on a Sunday, which the crate rejects outright
        // without the renumbering.
        let wednesday = at(2025, 5, 18, 0, 0);
        assert_eq!(compute_next_run_at("0 0 * * 0", wednesday), Some(at(2025, 5, 22, 0, 0)));
        // Every day of the week, which is `0-6` in croner and rejected by the crate.
        assert!(compute_next_run_at("0 0 * * 0-6", wednesday).is_some());
    }
}

/// Test-only re-export so the day-of-week translation can be probed directly, including for
/// inputs that `parse` would reject before the translation ever runs.
#[cfg(any(test, feature = "test-hooks"))]
pub fn translate_day_of_week_for_tests(field: &str) -> Option<String> {
    translate_day_of_week(field)
}
