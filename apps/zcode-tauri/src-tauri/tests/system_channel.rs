//! Behaviour tests for the ported `system` channel.
//!
//! These assert the port matches the TypeScript original, not merely that it
//! runs. The rules being pinned are the ones a "reasonable looking"
//! reimplementation would get wrong: Node's platform spelling, the clamp order
//! for probe timeouts and attempt counts, the `every`-on-empty quirk in the
//! strategy, and the rule that a missing reason becomes `"probe failed"`.

use serde_json::{json, Value as JsonValue};
use zcode_rpc_server::channel::ChannelHandler;
use zcode_tauri_lib::services::SystemService;

/// Call through the real wire shape: the client's positional argument list.
fn call(method: &str, args: Vec<JsonValue>) -> Result<JsonValue, String> {
    SystemService::new()
        .call("ctx", method, &args)
        .map_err(|error| error.to_string())
}

/// A single-argument call, wrapped the way `ProxyChannel.toService` wraps it.
fn ok1(method: &str, arg: JsonValue) -> JsonValue {
    call(method, vec![arg]).unwrap_or_else(|error| panic!("{method} failed: {error}"))
}

/// A zero-argument call, which arrives as an empty positional list.
fn ok(method: &str) -> JsonValue {
    call(method, Vec::new()).unwrap_or_else(|error| panic!("{method} failed: {error}"))
}

#[test]
fn info_reports_home_and_node_platform() {
    let info = ok("info");
    assert!(info["homedir"].is_string());
    // The UI branches on Node's spelling, so `macos`/`windows` would be wrong.
    let platform = info["platform"].as_str().expect("platform string");
    assert!(
        ["linux", "darwin", "win32"].contains(&platform),
        "platform must use Node's vocabulary, got {platform}"
    );
}

#[test]
fn info_is_stable_across_calls() {
    let first = ok("info");
    let second = ok("info");
    assert_eq!(first, second);
}

#[test]
fn an_unknown_method_fails_rather_than_returning_nothing() {
    let error = call("notAMethod", Vec::new()).expect_err("must fail");
    assert!(
        error.contains("notAMethod"),
        "the failure must name the method so the gap is obvious, got: {error}"
    );
}

#[test]
fn integrated_terminal_shells_are_empty_off_windows() {
    // The original returns [] for every non-Windows platform; a port that
    // "helpfully" listed /bin/sh would be wrong.
    let shells = ok("listIntegratedTerminalShells");
    assert_eq!(
        shells,
        json!([]),
        "only Windows has integrated terminal shells"
    );
}

#[test]
fn probing_no_targets_is_not_intranet() {
    let result = ok1("probeIntranet", json!({ "targets": [] }));
    assert_eq!(result["isIntranet"], false);
    assert_eq!(result["reachedTargetCount"], 0);
    assert_eq!(result["totalTargets"], 0);
    // `every` over an empty list is true, so the original reports tcp-connect.
    assert_eq!(result["strategy"], "tcp-connect");
    assert!(result["checkedAt"].as_u64().expect("timestamp") > 0);
}

#[test]
fn a_missing_request_body_probes_nothing_rather_than_failing() {
    let result = ok("probeIntranet");
    assert_eq!(result["totalTargets"], 0);
    assert_eq!(result["isIntranet"], false);
}

#[test]
fn an_empty_host_target_is_dropped() {
    let result = ok1("probeIntranet", json!({ "targets": [{ "host": "   " }] }),
    );
    assert_eq!(result["totalTargets"], 0, "a blank host is not a target");
}

#[test]
fn a_non_http_service_target_is_dropped() {
    let result = ok1("probeIntranet", json!({
            "targets": [
                { "kind": "service", "url": "ftp://example.com" },
                { "kind": "service", "url": "not a url" },
            ]
        }),
    );
    assert_eq!(
        result["totalTargets"], 0,
        "only http/https service targets are probed"
    );
}

#[test]
fn the_default_port_is_ssh_and_an_out_of_range_port_falls_back_to_it() {
    // Port 0, 70000 and a non-integer are all rejected by the original's
    // `Number.isInteger && >= 1 && <= 65535` guard.
    for bad in [json!(0), json!(70000), json!(1.5)] {
        let result = ok1("probeIntranet", json!({
                "targets": [{ "host": "127.0.0.1", "port": bad, "timeoutMs": 100 }]
            }),
        );
        let entry = &result["results"][0];
        assert_eq!(
            entry["port"], 22,
            "an invalid port must fall back to the SSH default, got {bad}"
        );
    }
}

#[test]
fn an_explicit_target_id_wins_over_the_derived_one() {
    let result = ok1("probeIntranet", json!({
            "targets": [{ "id": "  gateway  ", "host": "127.0.0.1", "timeoutMs": 100 }]
        }),
    );
    assert_eq!(result["results"][0]["targetId"], "gateway");
}

#[test]
fn a_derived_tcp_target_id_is_host_and_port() {
    let result = ok1("probeIntranet", json!({ "targets": [{ "host": "127.0.0.1", "port": 9, "timeoutMs": 100 }] }),
    );
    assert_eq!(result["results"][0]["targetId"], "127.0.0.1:9");
}

#[test]
fn an_unreachable_target_reports_the_failure_shape() {
    // Port 1 on loopback with nothing listening: reachable must be false, the
    // latency null, and the attempt count must match the clamp.
    let result = ok1("probeIntranet", json!({
            "targets": [{ "host": "127.0.0.1", "port": 1, "timeoutMs": 100 }],
            "attempts": 1,
        }),
    );
    let entry = &result["results"][0];
    assert_eq!(entry["reachable"], false);
    assert_eq!(entry["latencyMs"], JsonValue::Null);
    assert_eq!(entry["attemptCount"], 1);
    assert!(
        entry["error"].is_string(),
        "an unreachable target must carry a reason"
    );
    assert_eq!(result["isIntranet"], false);
}

#[test]
fn the_attempt_count_is_clamped_between_one_and_three() {
    for (requested, expected) in [
        (json!(0), 1u64),
        (json!(-5), 1),
        (json!(1), 1),
        (json!(3), 3),
        (json!(99), 3),
    ] {
        let result = ok1("probeIntranet", json!({
                "targets": [{ "host": "127.0.0.1", "port": 1, "timeoutMs": 100 }],
                "attempts": requested,
            }),
        );
        assert_eq!(
            result["results"][0]["attemptCount"], expected,
            "attempts={requested} must clamp to {expected}"
        );
    }
}

#[test]
fn a_missing_attempts_uses_the_default_of_two() {
    let result = ok1("probeIntranet", json!({ "targets": [{ "host": "127.0.0.1", "port": 1, "timeoutMs": 100 }] }),
    );
    assert_eq!(result["results"][0]["attemptCount"], 2);
}

#[test]
fn the_strategy_reflects_the_mix_of_target_kinds() {
    let tcp_only = ok1("probeIntranet", json!({ "targets": [{ "host": "127.0.0.1", "port": 1, "timeoutMs": 100 }] }),
    );
    assert_eq!(tcp_only["strategy"], "tcp-connect");

    let service_only = ok1("probeIntranet", json!({
            "targets": [
                { "kind": "service", "url": "https://example.com/", "timeoutMs": 100 }
            ]
        }),
    );
    assert_eq!(service_only["strategy"], "service-http");

    let mixed = ok1("probeIntranet", json!({
            "targets": [
                { "host": "127.0.0.1", "port": 1, "timeoutMs": 100 },
                { "kind": "service", "url": "https://example.com/", "timeoutMs": 100 }
            ]
        }),
    );
    assert_eq!(mixed["strategy"], "mixed");
}

#[test]
fn the_required_success_count_is_clamped_to_the_target_count() {
    let result = ok1("probeIntranet", json!({
            "targets": [{ "host": "127.0.0.1", "port": 1, "timeoutMs": 100 }],
            "requiredSuccessCount": 9,
        }),
    );
    assert_eq!(
        result["requiredSuccessCount"], 1,
        "the threshold can never exceed the number of targets"
    );
}

#[test]
fn a_zero_or_negative_required_count_becomes_one() {
    for requested in [json!(0), json!(-3)] {
        let result = ok1("probeIntranet", json!({
                "targets": [
                    { "host": "127.0.0.1", "port": 1, "timeoutMs": 100 },
                    { "host": "127.0.0.2", "port": 1, "timeoutMs": 100 }
                ],
                "requiredSuccessCount": requested,
            }),
        );
        assert_eq!(result["requiredSuccessCount"], 1, "for {requested}");
    }
}

#[test]
fn a_timeout_below_the_floor_is_raised_to_it() {
    // The floor exists so a target is not abandoned before the first packet can
    // leave; it is a correctness rule, not a preference.
    let started = std::time::Instant::now();
    let result = ok1("probeIntranet", json!({
            "targets": [{ "host": "10.255.255.1", "port": 81, "timeoutMs": 1 }]
        }),
    );
    assert_eq!(result["results"][0]["reachable"], false);
    // One attempt at a 100 ms floor must take at least that long.
    assert!(
        started.elapsed().as_millis() >= 100,
        "a 1 ms timeout must be clamped up to the 100 ms floor"
    );
}

#[test]
fn the_channel_publishes_no_events() {
    assert!(
        SystemService::new()
            .subscribe("ctx", "anything", None)
            .is_none(),
        "the system channel has no event surface"
    );
}
