//! Parity against JavaScript `Date`, verified against Node itself.
//!
//! Spec: docs/specs/rust-native-cron.md §3 and §6.1.
//!
//! The fixtures in `tests/fixtures/date-ground-truth.json` were **captured from Node**, not
//! written from memory. That distinction matters: two of the original hand-written
//! expectations in this port were wrong (`new Date(2025, 1, 0).getDate()` is 31, not 28, and
//! `new Date(2025, 0, -3)` is 28 December, not 29 December), and only running Node caught it.
//!
//! Regenerate the fixture with:
//!   TZ=UTC node scripts/capture-date-ground-truth.mjs
//!
//! Every test here is single-zone on purpose. The host `TZ` is process-global, so the DST cases
//! live in `parity_dst.rs`, which is run with an explicit zone.

use serde::Deserialize;

use zcode_cron::localtime::{
    at_time, day_in_month, days_in_month, month0_after_shift, to_millis, Millis,
};

#[derive(Debug, Deserialize)]
struct Row {
    name: String,
    input: Input,
    expect: Expect,
}

#[derive(Debug, Deserialize)]
struct Input {
    year: i32,
    month0: u32,
    day: i32,
    hour: u32,
    minute: u32,
}

#[derive(Debug, Deserialize)]
struct Expect {
    year: i32,
    month0: u32,
    day: u32,
    hour: u32,
    minute: u32,
    #[serde(rename = "epochMs")]
    epoch_ms: i64,
}

fn rows() -> Vec<Row> {
    let raw = include_str!("fixtures/date-ground-truth.json");
    serde_json::from_str(raw).expect("ground-truth fixture must parse")
}

/// The fixture is captured with `TZ=UTC` (see `scripts/capture-date-ground-truth.mjs`), so
/// the recorded `epochMs` is only comparable when the test also runs in UTC.
///
/// The zone-independent claim is the **local field** tuple, which is what the legacy
/// `Date`-based code actually depends on: `getFullYear`/`getMonth`/`getDate`/`getHours`/
/// `getMinutes` after a normalising construction. The epoch is asserted additionally when the
/// zone is UTC, so a `cargo test` run on a developer machine in another zone still checks the
/// behaviour that matters instead of failing on a timezone artefact.
fn running_in_utc() -> bool {
    std::env::var("TZ").map(|zone| zone == "UTC").unwrap_or(false)
}

#[test]
fn every_captured_date_behaviour_is_reproduced() {
    let utc = running_in_utc();
    let mut checked = 0;
    for row in rows() {
        let at = at_time(
            row.input.year,
            row.input.month0,
            row.input.day,
            row.input.hour,
            row.input.minute,
        );
        assert_eq!(
            (
                zcode_cron::localtime::year(at),
                zcode_cron::localtime::month0(at),
                zcode_cron::localtime::day_of_month(at),
                zcode_cron::localtime::hour(at),
                zcode_cron::localtime::minute(at),
            ),
            (
                row.expect.year,
                row.expect.month0,
                row.expect.day,
                row.expect.hour,
                row.expect.minute,
            ),
            "local fields differ for `{}`",
            row.name
        );
        if utc {
            assert_eq!(
                to_millis(at),
                row.expect.epoch_ms,
                "epoch differs for `{}` (TZ=UTC)",
                row.name
            );
        }
        checked += 1;
    }
    assert!(
        checked >= 11,
        "fixture lost rows; parity would be weaker than intended"
    );
}

#[test]
fn the_fixture_is_internally_consistent() {
    // Guards the fixture itself: the recorded local fields must reconstruct the recorded epoch
    // when read as UTC. Without this, a mis-captured fixture would silently weaken every other
    // assertion in this file.
    for row in rows() {
        let as_utc = chrono::DateTime::parse_from_rfc3339(&format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:00Z",
            row.expect.year,
            row.expect.month0 + 1,
            row.expect.day,
            row.expect.hour,
            row.expect.minute
        ))
        .unwrap_or_else(|error| panic!("`{}` is not a valid UTC timestamp: {error}", row.name));
        assert_eq!(
            as_utc.timestamp_millis(),
            row.expect.epoch_ms,
            "fixture row `{}` has fields that disagree with its epoch",
            row.name
        );
    }
}

#[test]
fn day_in_month_matches_node_for_every_captured_row() {
    for row in rows() {
        // The day shift must be computed from the *date* fields only. Rows whose hour or minute
        // overflows intentionally roll the date further, so those are excluded: `day_in_month`
        // answers "what day does `new Date(y, m, d)` land on", which is independent of the time.
        if row.input.hour % 24 != row.input.hour || row.input.minute % 60 != row.input.minute {
            continue;
        }
        assert_eq!(
            day_in_month(row.input.year, row.input.month0, row.input.day),
            row.expect.day,
            "day_in_month differs for `{}`",
            row.name
        );
        assert_eq!(
            month0_after_shift(row.input.year, row.input.month0, row.input.day),
            row.expect.month0,
            "the month must roll too, for `{}`",
            row.name
        );
    }
}

/// The two cases that a naive port gets wrong, named so a future refactor cannot regress them
/// silently. Both were caught by the Node capture, not by reasoning.
#[test]
fn hour_overflow_must_roll_the_day_not_be_reduced_away() {
    // `hour % 24` would silently drop a whole day here.
    let at = at_time(2025, 0, 1, 25, 0);
    assert_eq!(
        (
            zcode_cron::localtime::day_of_month(at),
            zcode_cron::localtime::hour(at)
        ),
        (2, 1)
    );
}

#[test]
fn february_29_must_roll_into_march_rather_than_clamp() {
    // Clamping to 28 February would make the yearly branch's `getMonth() !== targetMonth`
    // guard stop matching, and a Feb-29 automation would fire in March.
    assert_eq!(month0_after_shift(2025, 1, 29), 2);
    assert_eq!(day_in_month(2025, 1, 29), 1);
    // The leap year is unaffected.
    assert_eq!(month0_after_shift(2024, 1, 29), 1);
    assert_eq!(day_in_month(2024, 1, 29), 29);
}

#[test]
fn leap_year_rule_matches_node() {
    for (year, expected) in [(2024, 29), (2025, 28), (2000, 29), (1900, 28), (2100, 28)] {
        assert_eq!(
            days_in_month(year, 2),
            expected,
            "days_in_month({year}, 2) must be {expected}"
        );
    }
}

/// `Date` construction is the only place the port normalises, so the epoch a search candidate
/// lands on must round-trip through millis unchanged.
#[test]
fn epoch_round_trips_without_drift() {
    // Zone-independent: an instant must survive `from_millis`/`to_millis` unchanged.
    for row in rows() {
        let millis: Millis = row.expect.epoch_ms;
        let at = zcode_cron::localtime::from_millis(millis);
        assert_eq!(to_millis(at), millis, "round trip drifted for `{}`", row.name);
    }
}
