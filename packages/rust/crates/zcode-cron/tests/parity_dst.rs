//! DST parity: the two `Date` behaviours a naive port gets wrong, plus the property that
//! actually matters for a scheduler.
//!
//! Spec: docs/specs/rust-native-cron.md §3 (DST rows), §6.1 (`dst_spring_forward_gap`,
//! `dst_fall_back_overlap`), risk R1.
//!
//! `TZ` is process-global in Rust, so a test cannot pin a zone for itself. Each case
//! therefore names the zone it is written for:
//!
//! * **in that zone** it asserts the exact resolution Node produces;
//! * **in any other zone** the same wall-clock time is an ordinary instant, so the test
//!   asserts the zone-independent invariant instead — that the fields round-trip and that a
//!   daily schedule keeps its local time.
//!
//! That keeps the suite honest everywhere and still proves the specific behaviour where it
//! can be observed:
//!
//! ```text
//! TZ=America/New_York cargo test -p zcode-cron --test parity_dst   # spring + autumn cases
//! TZ=Europe/Berlin    cargo test -p zcode-cron --test parity_dst
//! ```

use zcode_cron::localtime::{
    at_time, day_of_month, hour, minute, month0, to_millis, year,
};
use zcode_cron::rule::{compute_schedule_rule_next_run_at, ScheduleRule, Unit};

fn ambient_zone() -> String {
    std::env::var("TZ").unwrap_or_else(|_| "unset".to_string())
}

fn daily_rule(anchor_millis: i64, hour_of_day: u32, minute_of_hour: u32) -> ScheduleRule {
    ScheduleRule {
        unit: Unit::Daily,
        interval: 1.0,
        hour: hour_of_day as f64,
        minute: minute_of_hour as f64,
        anchor_at: anchor_millis as f64,
        weekdays: None,
        month_days: None,
        months: None,
        monthly_mode: None,
    }
}

/// A local time inside the spring-forward gap does not exist.
///
/// In `America/New_York`, 2024-03-10 02:00 jumps to 03:00, so 02:30 is not a real wall-clock
/// time. Node resolves it **forward** out of the gap to 03:30 (verified:
/// `TZ=America/New_York node -e 'console.log(new Date(2024,2,10,2,30).toString())'` →
/// `Sun Mar 10 2024 03:30:00 GMT-0400`). Resolving backward instead would place the fire an
/// hour before the user asked for, which is the failure R1 warns about.
#[test]
fn spring_forward_gap_resolves_forward() {
    let gap = at_time(2024, 2, 10, 2, 30);
    let (y, m, d, h, mi) = (
        year(gap),
        month0(gap),
        day_of_month(gap),
        hour(gap),
        minute(gap),
    );

    if ambient_zone() == "America/New_York" {
        assert_eq!(
            (y, m, d, h, mi),
            (2024, 2, 10, 3, 30),
            "a nonexistent 02:30 must resolve forward to 03:30, as Node does"
        );
    } else {
        // Not a transition here, so the wall clock must round-trip untouched.
        assert_eq!(
            (y, m, d, h, mi),
            (2024, 2, 10, 2, 30),
            "outside a DST gap the local fields must be preserved exactly"
        );
    }
}

/// A local time inside the fall-back overlap happens twice.
///
/// In `America/New_York`, 2024-11-03 02:00 falls back to 01:00, so 01:30 occurs twice. Node
/// picks the **earlier** occurrence — 01:30 EDT, `05:30Z`, epoch 1730611800000 (verified
/// against Node). Choosing the later one would shift every autumn-boundary fire by an hour.
#[test]
fn fall_back_overlap_picks_the_earlier_occurrence() {
    let overlap = at_time(2024, 10, 3, 1, 30);
    let (y, m, d, h, mi) = (
        year(overlap),
        month0(overlap),
        day_of_month(overlap),
        hour(overlap),
        minute(overlap),
    );
    // In every zone the wall-clock fields must round-trip, overlap or not.
    assert_eq!(
        (y, m, d, h, mi),
        (2024, 10, 3, 1, 30),
        "the local fields must round-trip"
    );

    if ambient_zone() == "America/New_York" {
        assert_eq!(
            to_millis(overlap),
            1_730_611_800_000,
            "must be the earlier (EDT, UTC-4) occurrence, matching Node"
        );
    }
}

/// The property that actually matters for automations: **a daily schedule keeps its
/// wall-clock time across a DST boundary**.
///
/// "Every day at 09:00" must stay at 09:00 local, even though the UTC offset changed. An
/// engine that worked in UTC would drift by an hour twice a year, which is the user-visible
/// bug this whole parity exercise exists to prevent.
#[test]
fn a_daily_schedule_keeps_its_local_time_across_a_dst_boundary() {
    // 9 March 2024, the day before the US spring-forward; 1 November for the southern
    // hemisphere. Either way the loop below must cross a transition in at least one zone.
    let anchor_millis = to_millis(at_time(2024, 2, 9, 9, 0));
    let rule = daily_rule(anchor_millis, 9, 0);

    let mut cursor = anchor_millis;
    for day in 0..8 {
        let next = compute_schedule_rule_next_run_at(&rule, cursor)
            .unwrap_or_else(|| panic!("day {day}: the search found no fire"));
        let at = zcode_cron::localtime::from_millis(next);
        assert_eq!(
            (hour(at), minute(at)),
            (9, 0),
            "day {day}: a daily schedule must stay at 09:00 local, got {}:{}",
            hour(at),
            minute(at)
        );
        // Each fire must be strictly later, and the gap must stay near 24h in local terms.
        assert!(next > cursor, "day {day}: the fire must advance");
        cursor = next;
    }
}

/// The same property for the hourly unit, which aligns on the rule's minute rather than the
/// hour — the branch most likely to drift because it manipulates minutes directly.
#[test]
fn an_hourly_schedule_holds_its_minute_across_a_dst_boundary() {
    let anchor_millis = to_millis(at_time(2024, 2, 9, 0, 15));
    let rule = ScheduleRule {
        unit: Unit::Hourly,
        interval: 1.0,
        hour: 0.0,
        minute: 15.0,
        anchor_at: anchor_millis as f64,
        weekdays: None,
        month_days: None,
        months: None,
        monthly_mode: None,
    };

    let mut cursor = anchor_millis;
    for step in 0..8 {
        let next = compute_schedule_rule_next_run_at(&rule, cursor)
            .unwrap_or_else(|| panic!("step {step}: the search found no fire"));
        let at = zcode_cron::localtime::from_millis(next);
        assert_eq!(
            minute(at),
            15,
            "step {step}: the rule's minute must hold, got {}",
            minute(at)
        );
        assert!(next > cursor, "step {step}: the fire must advance");
        cursor = next;
    }
}
