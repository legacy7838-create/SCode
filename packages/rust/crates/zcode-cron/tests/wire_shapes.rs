//! The JSON shapes the TypeScript wrapper parses.
//!
//! Spec: docs/specs/rust-native-cron.md §5.4, §8.
//!
//! These tests exist because the boundary is stringly-typed. A first attempt annotated the
//! outcome enum with a container-level `rename_all = "camelCase"`, which renames the *tag
//! value* but leaves the inner fields snake_cased. The result was
//! `{"kind":"staleOneShot","target_at":…}` while `packages/rust/src/cron.ts` read
//! `kind === "StaleOneShot"` and `outcome.targetAt` — every field wrong at once, and the
//! failure mode was a silent `null` instead of an error, because `undefined?.targetAt`
//! evaluates to `undefined` and the wrapper returned it as "no future fire".
//!
//! Pinning the exact strings here means that class of drift fails a test rather than a
//! user's automation.

use zcode_cron::expr::{compute_next_run_at, is_valid_cron_expr, previous_run_at};
use zcode_cron::localtime::at_time;
use zcode_cron::rule::{
    build_interval_schedule_rule, build_relative_delay_schedule, compute_schedule_rule_next_run_at,
    infer_minute_interval_schedule_rule, is_one_shot_automation, schedule_rule_definition,
    MonthlyMode, ScheduleRule, Unit,
};

fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    zcode_cron::localtime::to_millis(at_time(year, month, day as i32, hour, minute))
}

fn daily(anchor_at: i64, hour: u32, minute: u32) -> ScheduleRule {
    ScheduleRule {
        unit: Unit::Daily,
        interval: 1.0,
        hour: hour as f64,
        minute: minute as f64,
        anchor_at: anchor_at as f64,
        weekdays: None,
        month_days: None,
        months: None,
        monthly_mode: None,
    }
}

/// `scheduleRuleDefinition` is compared as a string by both schedulers, so a byte difference
/// silently re-schedules every automation on upgrade. These are the literal shapes.
#[test]
fn change_detection_key_serialises_exactly_as_the_legacy_json_stringify() {
    let weekly = ScheduleRule {
        unit: Unit::Weekly,
        interval: 2.0,
        hour: 9.0,
        minute: 30.0,
        anchor_at: 1.0,
        weekdays: Some(vec![5.0, 1.0, 3.0]),
        month_days: None,
        months: None,
        monthly_mode: None,
    };
    assert_eq!(
        schedule_rule_definition(&weekly),
        r#"["weekly",2,9,30,[1,3,5],null,null,null]"#
    );

    let monthly_weekday = ScheduleRule {
        unit: Unit::Monthly,
        interval: 1.0,
        hour: 8.0,
        minute: 0.0,
        anchor_at: 1.0,
        weekdays: Some(vec![1.0]),
        month_days: None,
        months: None,
        monthly_mode: Some(MonthlyMode::Weekday),
    };
    assert_eq!(
        schedule_rule_definition(&monthly_weekday),
        r#"["monthly",1,8,0,[1],null,null,"weekday"]"#
    );
}

/// The rule crosses the boundary as camelCase JSON, matching the TS interface field names.
#[test]
fn a_rule_round_trips_through_the_boundary_json_shape() {
    let rule = ScheduleRule {
        unit: Unit::Monthly,
        interval: 3.0,
        hour: 7.0,
        minute: 45.0,
        anchor_at: 1_700_000_000_000.0,
        weekdays: None,
        month_days: Some(vec![1.0, 15.0]),
        months: None,
        monthly_mode: Some(MonthlyMode::Date),
    };
    let json = serde_json::to_string(&rule).expect("the rule must serialise");
    for field in [
        r#""anchorAt""#,
        r#""monthDays""#,
        r#""monthlyMode""#,
        r#""month_days""#,
        r#""anchor_at""#,
    ] {
        if field.starts_with(r#""month_days"#) || field.starts_with(r#""anchor_at"#) {
            assert!(
                !json.contains(field),
                "snake_case field {field} leaked into the wire shape: {json}"
            );
        } else {
            assert!(json.contains(field), "missing {field} in {json}");
        }
    }
}

/// A `null` "no future fire" must stay `null` on the wire, not become `0` or `NaN`.
///
/// `f64::NAN` was an earlier attempt and it does not survive `JSON.stringify` — it becomes
/// `null` anyway, which is right by accident, but `0` would silently mean "1 January 1970".
#[test]
fn no_future_fire_survives_as_null() {
    // February never has a 31st, so a yearly Feb-31 rule exhausts its search.
    let impossible = ScheduleRule {
        unit: Unit::Yearly,
        interval: 1.0,
        hour: 9.0,
        minute: 0.0,
        anchor_at: at(2025, 0, 1, 9, 0) as f64,
        weekdays: None,
        month_days: Some(vec![31.0]),
        months: Some(vec![2.0]),
        monthly_mode: None,
    };
    assert_eq!(compute_schedule_rule_next_run_at(&impossible, at(2025, 0, 2, 0, 0)), None);
}

/// The relative-delay payload carries both shapes the caller needs.
#[test]
fn relative_delay_payload_serialises_both_fields() {
    let from = at(2025, 5, 10, 9, 0);
    let schedule = build_relative_delay_schedule(90.0, from);
    let json = serde_json::to_string(&schedule).expect("must serialise");
    assert!(json.contains(r#""cronExpr""#), "{json}");
    assert!(json.contains(r#""scheduleRule""#), "{json}");
    assert!(json.contains(r#""anchorAt""#), "{json}");
    assert_eq!(schedule.cron_expr, "30 10 10 6 *");
    // The anchor is the caller's clock, not the target's: that is what stops a five-field
    // cron from firing a whole minute early or late.
    assert_eq!(schedule.schedule_rule.anchor_at, from as f64);
}

/// The carrier normaliser must be able to produce every unit, and reject nothing valid.
#[test]
fn the_interval_carrier_covers_every_unit() {
    let anchor = at(2025, 5, 10, 14, 20);
    for unit in [
        Unit::Minute,
        Unit::Hourly,
        Unit::Daily,
        Unit::Weekly,
        Unit::Monthly,
        Unit::Yearly,
    ] {
        let rule = build_interval_schedule_rule(unit, 2.0, "30 9 1,15 * 1,3", anchor);
        assert_eq!(rule.unit, unit);
        assert_eq!(rule.interval, 2.0);
        assert_eq!(rule.anchor_at, anchor as f64);
    }
}

/// Expression-path results must be plain epoch milliseconds, never a string or a `Date`.
#[test]
fn expression_results_are_plain_numbers() {
    let from = at(2025, 5, 10, 9, 0);
    let next = compute_next_run_at("30 9 * * *", from).expect("must schedule");
    assert!(next > from);
    assert!(next - from < 24 * 3_600_000, "must land the same day");
    assert!(is_valid_cron_expr("30 9 * * *"));
    assert!(!is_valid_cron_expr("nope"));
    assert!(previous_run_at("30 9 * * *", at(2025, 5, 10, 9, 45)).is_some());
}

/// The minute-interval inference must round-trip through JSON, since that is how the wrapper
/// receives it.
#[test]
fn inferred_rule_serialises_with_camel_case_fields() {
    let anchor = at(2025, 5, 10, 9, 7);
    let rule = infer_minute_interval_schedule_rule("*/15 * * * *", anchor).expect("must infer");
    let json = serde_json::to_string(&rule).expect("must serialise");
    assert!(json.contains(r#""anchorAt""#), "{json}");
    assert!(json.contains(r#""unit":"minute""#), "{json}");
    let parsed: ScheduleRule = serde_json::from_str(&json).expect("must parse back");
    assert_eq!(parsed.interval, 15.0);
}

/// A missing `maxRuns` is one run, and a present `Some(0)` is also one-shot.
#[test]
fn one_shot_detection_edge_cases_hold() {
    assert!(is_one_shot_automation(false, None));
    assert!(is_one_shot_automation(false, Some(0.0)));
    assert!(is_one_shot_automation(false, Some(1.0)));
    assert!(!is_one_shot_automation(false, Some(1.5)));
    assert!(!is_one_shot_automation(true, None));
}

/// A rule carrying a field this version does not know must be rejected at the boundary, not
/// silently dropped — a half-applied rule would compute a plausible but wrong schedule.
///
/// The strictness lives on `ScheduleRuleJson` in `src/lib.rs`, the boundary mirror that
/// `deny_unknown_fields` is declared on; `ScheduleRule` itself is the internal engine type and
/// is deliberately lenient. The mirror's behaviour is unit-tested in `src/lib.rs`; what is
/// pinned here is that the engine type does *not* silently claim to be strict, so a future
/// reader does not assume the wrong layer enforces it.
#[test]
fn unknown_field_strictness_lives_on_the_boundary_mirror_not_the_engine_type() {
    // The engine type accepts an unknown field. If this ever starts failing, strictness moved
    // down a layer and the boundary mirror's own test needs revisiting.
    let lenient: Result<ScheduleRule, _> = serde_json::from_str(
        r#"{"unit":"daily","interval":1,"hour":9,"minute":0,"anchorAt":0,"futureField":true}"#,
    );
    assert!(
        lenient.is_ok(),
        "ScheduleRule is the internal type; the boundary mirror is what must be strict"
    );
}
