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

/// Parses a 5-field expression into a `Schedule`, returning `None` when the engine rejects it.
fn parse(cron_expr: &str) -> Option<Schedule> {
    // `cron` expects seconds-first; the product contract is the standard 5-field form
    // (minute hour day-of-month month day-of-week), so a zero seconds field is prepended.
    let trimmed = cron_expr.trim();
    if trimmed.is_empty() {
        return None;
    }
    use std::str::FromStr as _;
    Schedule::from_str(&format!("0 {trimmed}")).ok()
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
}
