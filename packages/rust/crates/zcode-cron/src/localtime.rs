//! Local-time calendar arithmetic that reproduces JavaScript `Date` semantics.
//!
//! Spec: docs/specs/rust-native-cron.md §3.
//!
//! The legacy `automationCron.ts` does not do arithmetic on timestamps — it does local-time
//! calendar arithmetic through `Date`, and `Date` normalises aggressively. Each helper here
//! exists because a specific `Date` behaviour in the legacy code needs it:
//!
//! | Legacy | Line | Behaviour reproduced here |
//! |---|---|---|
//! | `new Date(y, m, d, hour, minute, 0, 0)` | `:129` | [`at_time`] — out-of-range fields normalise (month 13 → +1y, day 32 → +1mo, hour 25 → +1d) |
//! | `new Date(y, m + offset, 1)` | `:189` | [`date_in_month`] — same, with large offsets |
//! | `new Date(y, m, 0)` / `new Date(y, m, -3)` | `:195`, `:213` | [`day_in_month`] — day 0 is the last day of the previous month; negatives roll back |
//! | `setDate(getDate() - n)` | `:170` | [`add_days`] — may cross a month boundary |
//! | `setMinutes(m, 0, 0)` | `:150` | [`set_minutes`] — sets minutes+seconds+ms together; `setMinutes(70)` rolls the hour |
//! | `getDay()` | `:171`, `:196` | [`weekday_sunday_based`] / [`days_since_monday`] |
//!
//! Two behaviours deserve their own note because they are the ones a naive port gets wrong:
//!
//! * **February overflow.** `new Date(2025, 1, 29)` is 1 March, not 28 February. The legacy
//!   yearly branch relies on this: it constructs the date and then guards with
//!   `if (date.getMonth() !== targetMonth) continue;` (`automationCron.ts:214`). If the port
//!   clamped instead of rolling, the guard would stop matching and a Feb-29 automation would
//!   silently fire in March.
//! * **DST.** A local time inside a spring-forward gap does not exist, and one inside a
//!   fall-back overlap happens twice. `chrono`'s `Local` resolves both the same way `Date`
//!   does; spec §6.1 pins it with fixtures rather than trusting it.

use chrono::{DateTime, Datelike, Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike};

/// Milliseconds since the epoch, the representation the contract uses everywhere.
pub type Millis = i64;

/// Converts epoch milliseconds to a local `DateTime`.
///
/// The legacy code uses `new Date(ms)`, which is exactly this.
pub fn from_millis(millis: Millis) -> DateTime<Local> {
    Local.timestamp_millis_opt(millis)
        .single()
        .expect("epoch milliseconds are always a representable local instant")
}

/// Epoch milliseconds back out, the legacy `date.getTime()`.
pub fn to_millis(date: DateTime<Local>) -> Millis {
    date.timestamp_millis()
}

/// `new Date(y, m, d, hour, minute, 0, 0)` — local construction with JS normalisation.
///
/// `chrono`'s `with_ymd_and_hms` returns `None` for an out-of-range *day of month* rather than
/// rolling it, so the day is resolved through [`day_in_month`] first. That is deliberate: it
/// is the only way to reproduce `new Date(2025, 1, 29) === 1 March`.
/// The date `new Date(y, m, day)` denotes, after JS normalisation.
///
/// `new Date(y, m, 1).getDate()` is `1`, so the whole rule is "first of the month, shifted by
/// `day - 1` days". That single expression covers every case the legacy code relies on:
///
/// * `day == 0`  → last day of the previous month
/// * `day < 0`   → rolls further back
/// * `day == 29` in February 2025 → 1 March (2025 is not a leap year)
///
/// Verified against Node (`TZ=UTC node -e 'new Date(2025,1,29)'` → `2025-03-01`,
/// `new Date(2025,1,0).getDate()` → `31`, `new Date(2025,0,-3)` → `2024-12-28`).
///
/// The February case is the one a naive port gets wrong: clamping to 28 would make the legacy
/// `getMonth() !== targetMonth` guard stop matching, and a Feb-29 automation would silently
/// fire in March instead of skipping to the next leap year.
fn shifted_date(year: i32, month0: u32, day: i32) -> NaiveDate {
    // The month is normalised first, because `new Date(2025, 12, 1)` is January 2026 and the
    // fixture covers that case. `from_ymd_opt` rejects month 13 outright, so the wrap has to
    // happen before the date is built rather than being left to the caller.
    let total = (year as i64) * 12 + (month0 as i64);
    let resolved_year = total.div_euclid(12) as i32;
    let resolved_month = total.rem_euclid(12) as u32;
    NaiveDate::from_ymd_opt(resolved_year, resolved_month + 1, 1)
        .expect("the month has been wrapped into 0..=11 above")
        .checked_add_signed(chrono::Duration::days((day as i64) - 1))
        .expect("day offsets from a calendar date stay representable")
}

/// The day component of `new Date(y, m, day)` **after** JS normalisation.
pub fn day_in_month(year: i32, month0: u32, day: i32) -> u32 {
    shifted_date(year, month0, day).day()
}

/// The month component of `new Date(y, m, day)`, which differs from `month0` when the day
/// overflowed. The yearly branch reads this through the constructed date instead, but it is
/// exposed because a caller holding only a day needs to be able to detect the rollover.
pub fn month0_after_shift(year: i32, month0: u32, day: i32) -> u32 {
    shifted_date(year, month0, day).month0()
}

/// `new Date(y, m, d, hour, minute, 0, 0)` — local construction with JS normalisation.
///
/// The hour and minute are *added as durations* rather than reduced into range, because JS
/// propagates the overflow: `new Date(2025, 0, 1, 25, 0)` is 2 January at 01:00, not 1 January
/// at 01:00 (verified against Node). Reducing with `% 24` would silently drop a whole day.
pub fn at_time(year: i32, month0: u32, day: i32, hour: u32, minute: u32) -> DateTime<Local> {
    let date = shifted_date(year, month0, day);
    let naive = date
        .and_hms_opt(0, 0, 0)
        .expect("midnight is always representable")
        + chrono::Duration::hours(hour as i64)
        + chrono::Duration::minutes(minute as i64);
    local_from_naive(naive)
}

/// Resolves a naive local datetime to an instant the way `Date` does.
///
/// A time inside a spring-forward gap has no unique instant, and one inside a fall-back
/// overlap has two. `Date` resolves the gap forward out of it and the overlap to the earlier
/// (pre-transition) offset, which is exactly `LocalResult::None -> earliest after` and
/// `Ambiguous(a, _) -> a`. Spec §6.1 pins both with fixtures rather than trusting this.
fn local_from_naive(naive: NaiveDateTime) -> DateTime<Local> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(at) => at,
        LocalResult::Ambiguous(first, second) => {
            // `Date` resolves an overlap to the **earlier** occurrence: `new Date(2024, 10, 3,
            // 1, 30)` in America/New_York is 01:30 EDT (05:30Z, epoch 1730611800000), verified
            // against Node. `LocalResult::Ambiguous`'s element order is not specified, so the
            // earlier one is chosen by comparing epochs rather than by position — trusting the
            // order picked the *later* (EST) occurrence and shifted every autumn-boundary
            // automation by an hour.
            if to_millis(first) <= to_millis(second) {
                first
            } else {
                second
            }
        }
        LocalResult::None => resolve_gap_forward(naive),
    }
}

/// Resolves a local time that falls inside a spring-forward gap.
///
/// ECMAScript builds the instant as `MakeDate(MakeDay(y,m,d), MakeTime(h,mi,0,0))` and then
/// applies the UTC offset that was **in effect before** the transition. For a one-hour gap
/// that means a requested 02:30 becomes 03:30, not 03:00 — the minutes are carried across the
/// transition rather than snapped to its far edge.
///
/// Verified against Node: `TZ=America/New_York node -e 'console.log(new Date(2024,2,10,2,30)
/// .toString())'` → `Sun Mar 10 2024 03:30:00 GMT-0400`.
///
/// A naive "search outward for the nearest valid local time" returns 03:00, because that is
/// the first representable instant, and silently fires the automation half an hour early.
fn resolve_gap_forward(naive: NaiveDateTime) -> DateTime<Local> {
    // The offset in effect before the gap is the one an hour earlier, which is always a valid
    // local time for a gap of at most a couple of hours (Lord Howe Island shifts by 30 min,
    // and even there the probe lands on a real instant).
    for probe_hours in 1..=3 {
        let probe = naive - chrono::Duration::hours(probe_hours);
        if let LocalResult::Single(at) = Local.from_local_datetime(&probe) {
            // `naive.and_utc()` treats the wall clock as if it were UTC; subtracting the
            // pre-transition offset yields the instant ECMAScript would have built.
            // `- offset` yields a `DateTime<Utc>`, which converts straight to local.
            return (naive.and_utc() - *at.offset()).with_timezone(&Local);
        }
    }
    // Unreachable for any real zone; fall back to the naive interpretation rather than panic
    // inside a scheduler.
    naive.and_utc().with_timezone(&Local)
}

/// `new Date(year, month0 + offset, 1)` — the monthly search step (`automationCron.ts:189`).
///
/// Month arithmetic wraps, so offset 12 from January is January next year, exactly as JS does.
pub fn date_in_month(year: i32, month0: i32, day: u32) -> DateTime<Local> {
    let total = (year as i64) * 12 + month0 as i64;
    let resolved_year = total.div_euclid(12) as i32;
    let resolved_month = total.rem_euclid(12) as u32;
    let resolved_day = day.clamp(1, days_in_month(resolved_year, resolved_month));
    at_time(resolved_year, resolved_month, resolved_day as i32, 0, 0)
}

/// The day component of `new Date(y, m, day)` **after** JS normalisation.
///
/// `new Date(y, m, 1).getDate()` is `1`, and the remaining `day - 1` is a plain day offset, so
/// the whole rule is "first of the month, shifted by `day - 1` days". That single expression
/// covers every case the legacy code relies on:
///
/// * `day == 0`  → last day of the previous month
/// * `day < 0`   → rolls further back
/// * `day == 29` in February 2025 (a non-leap year) → 1 March
///
/// The February case is the one a naive port gets wrong: clamping to 28 would make the legacy
/// `getMonth() !== targetMonth` guard stop matching, and a Feb-29 automation would silently
/// fire in March instead of skipping to the next leap year.
pub fn day_in_month_legacy(year: i32, month0: u32, day: i32) -> u32 {
    shifted_date(year, month0, day).day()
}

/// Days in a 1-based month, honouring leap years.
pub fn days_in_month(year: i32, month1: u32) -> u32 {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    match month1 {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 30,
    }
}

/// `date.setDate(date.getDate() + delta)` — may cross a month or year boundary.
pub fn add_days(date: DateTime<Local>, delta: i32) -> DateTime<Local> {
    let naive = date
        .date_naive()
        .checked_add_signed(chrono::Duration::days(delta as i64))
        .expect("day offset stays in chrono::NaiveDate's supported range")
        // Keep the original wall-clock time; `setDate` does the same.
        .and_time(date.time());
    local_from_naive(naive)
}

/// `date.setMinutes(minute, 0, 0)` — sets minutes, seconds and milliseconds together.
///
/// `setMinutes(70)` makes `MakeTime` compute `70 * 60000`, i.e. it **adds 70 minutes to
/// midnight**, so 09:00 becomes 10:10. That is an hours carry, not a minutes one: verified
/// against Node (`TZ=UTC node -e 'const x=new Date(2025,5,15,9,0,0,0); x.setMinutes(70,0,0);
/// console.log(x.getHours()+":"+x.getMinutes())'` → `10:10`). Reducing to `70 % 60 === 10` and
/// then adding one *minute* would give 09:11.
pub fn set_minutes(date: DateTime<Local>, minute: u32) -> DateTime<Local> {
    let naive = date
        .date_naive()
        .and_time(date.time())
        .with_minute(minute % 60)
        .expect("minutes are reduced above")
        + chrono::Duration::hours((minute / 60) as i64);
    local_from_naive(naive)
}

/// `date.getDay()` — 0 = Sunday.
pub fn weekday_sunday_based(date: DateTime<Local>) -> u32 {
    date.weekday().num_days_from_sunday()
}

/// `(date.getDay() + 6) % 7` — converts to 0 = Monday, which the weekly branch uses
/// (`automationCron.ts:171`).
pub fn days_since_monday(date: DateTime<Local>) -> u32 {
    (weekday_sunday_based(date) + 6) % 7
}

/// `new Date(year, month, 1)` then `getDay()` — the first `weekday` of a month, for
/// `monthlyMode: "weekday"` (`automationCron.ts:135-138`).
pub fn first_weekday_of_month(year: i32, month0: u32, weekday: u32) -> DateTime<Local> {
    let first = at_time(year, month0, 1, 0, 0);
    let offset = (weekday + 7 - weekday_sunday_based(first)) % 7;
    at_time(year, month0, 1 + offset as i32, 0, 0)
}

/// `date.getFullYear()`, kept as a function so the call sites read like the legacy ones.
pub fn year(date: DateTime<Local>) -> i32 {
    date.year()
}

/// `date.getMonth()` — 0-based.
pub fn month0(date: DateTime<Local>) -> u32 {
    date.month0()
}

/// `date.getDate()` — 1-based.
pub fn day_of_month(date: DateTime<Local>) -> u32 {
    date.day()
}

/// `date.getHours()`.
pub fn hour(date: DateTime<Local>) -> u32 {
    date.hour()
}

/// `date.getMinutes()`.
pub fn minute(date: DateTime<Local>) -> u32 {
    date.minute()
}

/// A `NaiveDateTime` at midnight local, for building search candidates cheaply.
pub fn midnight(year: i32, month0: u32, day: i32) -> DateTime<Local> {
    at_time(year, month0, day, 0, 0)
}

/// The `Date` a bare `new Date(ms)` yields, exposed for the fixture corpus.
pub fn naive_from_millis(millis: Millis) -> NaiveDateTime {
    from_millis(millis).naive_local()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These tests pin the `Date` behaviours from spec §3. They are the difference between a
    /// port that is safe and one that fires automations on the wrong day.

    #[test]
    fn at_time_normalises_out_of_range_fields_like_date() {
        // new Date(2025, 0, 1, 25, 0) === 2025-01-02T01:00 local
        let rolled = at_time(2025, 0, 1, 25, 0);
        assert_eq!((day_of_month(rolled), hour(rolled)), (2, 1));

        // Minutes roll the hour: new Date(2025, 0, 1, 0, 70) === 01:10
        let minutes = at_time(2025, 0, 1, 0, 70);
        assert_eq!((hour(minutes), minute(minutes)), (1, 10));
    }

    /// The behaviour the yearly branch's `getMonth() !== targetMonth` guard depends on.
    #[test]
    fn february_29_in_a_non_leap_year_rolls_into_march() {
        assert_eq!(day_in_month(2025, 1, 29), 1);
        let date = at_time(2025, 1, 29, 0, 0);
        assert_eq!(month0(date), 2, "must be March, which the legacy guard then skips");
        // A leap year keeps it in February.
        assert_eq!(day_in_month(2024, 1, 29), 29);
        let leap = at_time(2024, 1, 29, 0, 0);
        assert_eq!(month0(leap), 1);
    }

    #[test]
    fn day_zero_and_negative_days_roll_backwards() {
        // Node: new Date(2025, 1, 0).getDate() === 31 — day 0 of February is the last day of
        // *January*, not of February. Verified against Node, not assumed.
        assert_eq!(day_in_month(2025, 1, 0), 31);
        // Day 0 of March is the last day of February.
        assert_eq!(day_in_month(2025, 2, 0), 28);
        assert_eq!(day_in_month(2024, 2, 0), 29);
        // Node: new Date(2025, 0, -3) === 2024-12-28, because the offset is `day - 1`.
        let back = at_time(2025, 0, -3, 0, 0);
        assert_eq!((year(back), month0(back), day_of_month(back)), (2024, 11, 28));
    }

    #[test]
    fn days_in_month_honours_the_leap_rule() {
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2025, 2), 28);
        assert_eq!(days_in_month(2000, 2), 29); // divisible by 400
        assert_eq!(days_in_month(1900, 2), 28); // divisible by 100 but not 400
        assert_eq!(days_in_month(2025, 1), 31);
        assert_eq!(days_in_month(2025, 4), 30);
    }

    #[test]
    fn date_in_month_wraps_the_year() {
        let jan_next = date_in_month(2025, 0 + 12, 1);
        assert_eq!((year(jan_next), month0(jan_next)), (2026, 0));
        // The monthly search uses offsets up to 1200, i.e. 100 years.
        let far = date_in_month(2025, 0 + 1200, 1);
        assert_eq!(year(far), 2125);
    }

    #[test]
    fn add_days_crosses_month_and_year_boundaries() {
        let new_year_eve = at_time(2024, 11, 31, 12, 0);
        let next = add_days(new_year_eve, 1);
        assert_eq!((year(next), month0(next), day_of_month(next)), (2025, 0, 1));
        // Backwards across a month boundary, as the weekly branch does.
        let first = at_time(2025, 0, 1, 8, 0);
        let back = add_days(first, -1);
        assert_eq!((year(back), month0(back), day_of_month(back)), (2024, 11, 31));
    }

    #[test]
    fn set_minutes_carries_into_hours() {
        // Node: setMinutes(70, 0, 0) on 09:00 -> 10:10, because MakeTime treats the argument
        // as minutes-since-midnight rather than a field to clamp.
        let date = at_time(2025, 5, 15, 9, 0);
        let rolled = set_minutes(date, 70);
        assert_eq!((hour(rolled), minute(rolled)), (10, 10));
        // An in-range value replaces the minute outright.
        let replaced = set_minutes(date, 5);
        assert_eq!((hour(replaced), minute(replaced)), (9, 5));
    }

    #[test]
    fn monday_based_conversion_matches_the_legacy_formula() {
        // 2025-06-15 is a Sunday -> getDay() 0 -> (0 + 6) % 7 === 6
        let sunday = at_time(2025, 5, 15, 0, 0);
        assert_eq!(weekday_sunday_based(sunday), 0);
        assert_eq!(days_since_monday(sunday), 6);
        // 2025-06-16 is a Monday -> getDay() 1 -> (1 + 6) % 7 === 0
        let monday = at_time(2025, 5, 16, 0, 0);
        assert_eq!(days_since_monday(monday), 0);
    }

    #[test]
    fn first_weekday_of_month_finds_the_requested_weekday() {
        // September 2025 starts on a Monday, so the first Monday is the 1st.
        let first_monday = first_weekday_of_month(2025, 8, 1);
        assert_eq!(day_of_month(first_monday), 1);
        // September 2025 Fridays: 5, 12, 19, 26
        let first_friday = first_weekday_of_month(2025, 8, 5);
        assert_eq!(day_of_month(first_friday), 5);
        // A month starting on Saturday: August 2025 starts Friday, so first Sunday is the 3rd.
        let first_sunday = first_weekday_of_month(2025, 7, 0);
        assert_eq!(day_of_month(first_sunday), 3);
    }
}
