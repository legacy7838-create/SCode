//! Rows T7–T11 and T48–T58 of `docs/specs/rust-native-config.md`, replayed
//! against vectors captured from the LIVE TypeScript predecessor
//! (`workspace-hook-digest.ts`, `workspace-hook-config.ts`,
//! `workspaceHookSettingsModel.ts` and the two inline service merges).
//!
//! The comparison is byte-level: the expected side is the predecessor's
//! `JSON.stringify` output parsed back with `preserve_order`, and the native
//! side is re-serialized through the same format — so a key that moves, a
//! number that grows a fraction (`60000.0`) or a digest that changes by one
//! byte fails the test. The capture script was throwaway (the model-side
//! functions it imported are deleted with `workspaceHookSettingsModel.ts`);
//! the fixture is the record.

use serde_json::Value;

fn fixture() -> Value {
    let text = std::fs::read_to_string(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hook-config-expected.json"),
    )
    .expect("fixture");
    serde_json::from_str(&text).expect("fixture JSON")
}

fn byte_string(value: &Value) -> String {
    serde_json::to_string(value).expect("serialise")
}

fn sources_of(fixture: &Value) -> Vec<zcode_config::hooks::SourceInput> {
    serde_json::from_value(fixture["inputs"]["sources"].clone()).expect("sources")
}

fn runtime_root(fixture: &Value) -> zcode_config::hooks::RuntimeRootInput {
    serde_json::from_value(fixture["expected"]["runtimeRoot"].clone()).expect("runtime root")
}

#[test]
fn t7_bundle_snapshot_is_byte_identical_to_the_predecessor() {
    let fixture = fixture();
    let input: zcode_config::hooks::BundleSnapshotInput = serde_json::from_value(
        serde_json::json!({
            "workspaceIdentity": fixture["inputs"]["workspaceIdentity"],
            "workspacePath": fixture["inputs"]["workspacePath"],
            "sources": fixture["inputs"]["sources"],
            "runtimeRoot": fixture["expected"]["runtimeRoot"],
            "discoveredAt": fixture["inputs"]["discoveredAt"],
        }),
    )
    .expect("input");
    let native = zcode_config::hooks::build_workspace_hook_bundle_snapshot(&input)
        .expect("snapshot");
    assert_eq!(
        native,
        byte_string(&fixture["expected"]["snapshot"]),
        "T7: the whole snapshot, including both digests, byte-identical"
    );
    // …and the digest itself is stable across runs.
    let again = zcode_config::hooks::build_workspace_hook_bundle_snapshot(&input).expect("again");
    assert_eq!(native, again, "the digest is deterministic");
}

#[test]
fn t8_a_source_set_without_hooks_has_no_snapshot() {
    let fixture = fixture();
    let mut sources = sources_of(&fixture);
    sources[0].hooks.events = None;
    sources[1].hooks.events = None;
    let input = zcode_config::hooks::BundleSnapshotInput {
        workspace_identity: "ws-id".into(),
        workspace_path: fixture["inputs"]["workspacePath"].as_str().unwrap().into(),
        sources,
        runtime_root: runtime_root(&fixture),
        discovered_at: Some(fixture["inputs"]["discoveredAt"].as_str().unwrap().into()),
    };
    assert!(
        zcode_config::hooks::build_workspace_hook_bundle_snapshot(&input).is_none(),
        "T8: the predecessor returns undefined"
    );
}

#[test]
fn t9_t10_t11_projection_marks_trust_from_the_digest_set() {
    let fixture = fixture();
    let trusted = fixture["inputs"]["trustedDigest"].as_str().expect("digest").to_string();
    let projection_input: zcode_config::hooks::ProjectionInput = serde_json::from_value(
        serde_json::json!({
            "sources": fixture["inputs"]["sources"],
            "snapshot": fixture["expected"]["snapshot"],
            "workspaceIdentity": fixture["inputs"]["workspaceIdentity"],
            "workspacePath": fixture["inputs"]["workspacePath"],
            "persistentTrustedDigests": [trusted],
        }),
    )
    .expect("projection input");
    let native = zcode_config::hooks::project_hooks_to_service_hooks(&projection_input)
        .expect("projection");
    assert_eq!(
        native,
        byte_string(&fixture["expected"]["projection"]),
        "T9: full projection, byte-identical — first hook trusted, the rest pending"
    );
    let hooks: Value = serde_json::from_str(&native).unwrap();
    let trust_states: Vec<&str> = hooks
        .as_array()
        .expect("array")
        .iter()
        .map(|hook| hook["workspaceHook"]["trustState"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(trust_states[0], "trusted_persistent", "T9");
    assert!(
        trust_states[1..].iter().all(|state| *state == "pending_trust"),
        "T9: the others are pending"
    );

    // T10: an EMPTY set (the corrupt-store outcome) can never trust anything.
    let empty_input: zcode_config::hooks::ProjectionInput = serde_json::from_value(
        serde_json::json!({
            "sources": fixture["inputs"]["sources"],
            "snapshot": fixture["expected"]["snapshot"],
            "workspaceIdentity": fixture["inputs"]["workspaceIdentity"],
            "workspacePath": fixture["inputs"]["workspacePath"],
            "persistentTrustedDigests": [],
        }),
    )
    .expect("projection input");
    let empty = zcode_config::hooks::project_hooks_to_service_hooks(&empty_input).expect("projection");
    let hooks: Value = serde_json::from_str(&empty).unwrap();
    assert!(
        hooks
            .as_array()
            .expect("array")
            .iter()
            .all(|hook| hook["workspaceHook"]["trustState"] == "pending_trust"),
        "T10: no path to trusted_persistent with an empty set"
    );

    // T11: no snapshot → [].
    let no_snapshot: zcode_config::hooks::ProjectionInput = serde_json::from_value(
        serde_json::json!({
            "sources": fixture["inputs"]["sources"],
            "snapshot": null,
            "workspaceIdentity": "ws-id",
            "workspacePath": "/ws",
        }),
    )
    .expect("projection input");
    assert_eq!(
        zcode_config::hooks::project_hooks_to_service_hooks(&no_snapshot).unwrap(),
        "[]",
        "T11"
    );
}

#[test]
fn the_user_and_legacy_projections_match_the_predecessor() {
    let fixture = fixture();
    let sources = sources_of(&fixture);
    let location: Value = fixture["inputs"]["userLocation"].clone();
    let user = zcode_config::hooks::hooks_from_user_source(
        &sources[..1],
        &runtime_root(&fixture),
        fixture["inputs"]["workspacePath"].as_str().unwrap(),
        &location,
    )
    .expect("user hooks");
    assert_eq!(
        user,
        byte_string(&fixture["expected"]["userHooks"]),
        "fromUserZCodeSource, byte-identical (ids, timeouts, no trust state)"
    );

    let legacy_location: Value = fixture["inputs"]["legacyLocation"].clone();
    let legacy =
        zcode_config::hooks::hooks_from_legacy_config(&fixture["inputs"]["legacyConfig"], &legacy_location)
            .expect("legacy hooks");
    assert_eq!(
        legacy,
        byte_string(&fixture["expected"]["legacyHooks"]),
        "fromLegacyHooksConfig, byte-identical (empty matcher dropped, timeoutMs→seconds)"
    );
}

#[test]
fn t48_t50_events_grouping_and_writable_declarations() {
    let fixture = fixture();
    let projection: Value = fixture["expected"]["projection"].clone();
    let user: Value = fixture["expected"]["userHooks"].clone();
    let mut all: Vec<Value> = projection.as_array().unwrap().clone();
    all.extend(user.as_array().unwrap().iter().cloned());
    let native = zcode_config::hooks::hooks_to_zcode_events(&all);
    assert_eq!(
        native,
        byte_string(&fixture["expected"]["events"]),
        "T48/T49/T50: grouping, seconds↔ms and the declaration-enabled rewrite, byte-identical"
    );
    let events: Value = serde_json::from_str(&native).unwrap();
    assert_eq!(
        events.as_object().unwrap().keys().collect::<Vec<_>>(),
        vec!["PreToolUse", "Stop", "PostToolUse"],
        "T48: first-encounter event order"
    );
    // T49: the process hook's seconds become timeoutMs on the way back out.
    let stop = &events["Stop"][0]["hooks"][0];
    assert_eq!(stop["timeoutMs"], serde_json::json!(2500), "T49");
    // T49: the command hook keeps its seconds field.
    let command = &events["PreToolUse"][0]["hooks"][0];
    assert_eq!(command["timeout"], serde_json::json!(5), "T49");
    // T50: declaration enabled wins when the runtime value matches its state.
    assert_eq!(
        command["enabled"],
        serde_json::json!(true),
        "T50: the declaration's enabled is written"
    );
}

#[test]
fn t51_build_zcode_hooks_config_keeps_other_keys_and_overwrites_events() {
    let fixture = fixture();
    let native = zcode_config::hooks::build_zcode_hooks_config(
        &fixture["inputs"]["existingConfig"],
        fixture["inputs"]["buildEnabled"].as_bool(),
        &fixture["inputs"]["buildEvents"].to_string(),
    )
    .expect("build");
    assert_eq!(
        native,
        fixture["expected"]["buildConfig"].as_str().expect("string"),
        "T51: sibling keys survive, events overwritten, enabled only when resolved"
    );
}

#[test]
fn t52_t53_next_root_enabled_passes_through_unchanged() {
    let fixture = fixture();
    // T52: no deviation → the existing value (undefined) is returned AS IS.
    assert_eq!(
        zcode_config::hooks::resolve_next_root_enabled(None, &[]),
        None,
        "T52: undefined passes through"
    );
    // T53: a deviating hook forces true.
    let deviating: Vec<Value> = fixture["inputs"]["deviatingHooks"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(
        zcode_config::hooks::resolve_next_root_enabled(Some(false), &deviating),
        Some(true),
        "T53"
    );
    // …and a non-deviating hook keeps the existing value.
    let passive: Vec<Value> = fixture["inputs"]["passiveHooks"].as_array().unwrap().clone();
    assert_eq!(
        zcode_config::hooks::resolve_next_root_enabled(Some(true), &passive),
        Some(true),
        "T52: unchanged"
    );
}

#[test]
fn t54_the_partition_matches_the_service_filters() {
    let fixture = fixture();
    let native = zcode_config::hooks::partition_writable_hooks(
        fixture["inputs"]["partitionHooks"].as_array().unwrap(),
        fixture["inputs"]["currentProjectConfigPath"].as_str().unwrap(),
    );
    let expected = serde_json::json!({
        "currentProjectConfigPath": fixture["inputs"]["currentProjectConfigPath"],
        "user": fixture["expected"]["partition"]["user"],
        "project": fixture["expected"]["partition"]["project"],
    });
    let native_value: Value = serde_json::from_str(&native).unwrap();
    assert_eq!(
        native_value["user"], expected["user"],
        "T54: user = editable AND (no location OR zcode+user)"
    );
    assert_eq!(
        native_value["project"], expected["project"],
        "T54: project = editable AND zcode+project AND sourcePath matches"
    );
}

#[test]
fn t55_t56_t57_runtime_root_merges_with_or_and_last_defined_wins() {
    let fixture = fixture();
    let roots = fixture["inputs"]["roots"].to_string();
    let native = zcode_config::hooks::resolve_workspace_hook_runtime_root(&roots).expect("root");
    assert_eq!(
        native,
        byte_string(&fixture["expected"]["runtimeRoot"]),
        "T55 enabled is an OR, T56 the LAST defined timeoutMs/maxOutputBytes wins \
         (the 0.4 root is overwritten by 60000), T57 max(1, round(…))"
    );
    let root: Value = serde_json::from_str(&native).unwrap();
    assert_eq!(root["enabled"], serde_json::json!(true), "T55");
    assert_eq!(root["timeoutMs"], serde_json::json!(60000), "T56");
    assert_eq!(root["maxOutputBytes"], serde_json::json!(1235), "T57: round(1234.6)");
}

#[test]
fn t57_timeout_resolution_rounds_like_math_round() {
    let fixture = fixture();
    let probes = &fixture["expected"]["timeoutProbes"];
    assert_eq!(
        zcode_config::hooks::resolve_workspace_hook_timeout_ms(
            serde_json::json!({ "type": "command", "timeoutMs": 0.4 }).as_object().unwrap(),
            60_000.0
        ),
        probes["roundDown"].as_f64().unwrap(),
        "T57: Math.round(0.4).max(1) = 1, not truncated to 0"
    );
    assert_eq!(
        zcode_config::hooks::resolve_workspace_hook_timeout_ms(
            serde_json::json!({ "type": "command", "timeout": 5 }).as_object().unwrap(),
            60_000.0
        ),
        probes["commandSeconds"].as_f64().unwrap(),
        "a command's seconds become milliseconds"
    );
    assert_eq!(
        zcode_config::hooks::resolve_workspace_hook_timeout_ms(
            serde_json::json!({ "type": "process" }).as_object().unwrap(),
            60_000.0
        ),
        probes["default"].as_f64().unwrap()
    );
}

#[test]
fn t58_the_hooks_config_is_strict_at_both_levels() {
    // An unknown key directly under the root.
    let result: Value =
        serde_json::from_str(&zcode_config::hooks::validate_workspace_hooks_config(
            r#"{"enabled": true, "surprise": 1}"#,
        ))
        .unwrap();
    assert_eq!(result["ok"], serde_json::json!(false), "T58 root strict");
    assert_eq!(
        result["issues"][0]["message"],
        serde_json::json!("Unrecognized key: \"surprise\"")
    );

    // An unknown key under `events`.
    let result: Value =
        serde_json::from_str(&zcode_config::hooks::validate_workspace_hooks_config(
            r#"{"events": {"Wednesdays": []}}"#,
        ))
        .unwrap();
    assert_eq!(result["ok"], serde_json::json!(false), "T58 events strict");
    assert_eq!(result["issues"][0]["path"], "events");

    // An unknown key under a matcher.
    let result: Value =
        serde_json::from_str(&zcode_config::hooks::validate_workspace_hooks_config(
            r#"{"events": {"Stop": [{"matcher": "x", "hooks": [{"type": "command", "command": "c"}], "surprise": 1}]}}"#,
        ))
        .unwrap();
    assert_eq!(result["ok"], serde_json::json!(false), "T58 matcher strict");
    assert_eq!(result["issues"][0]["path"], "events.Stop.0");

    // A valid config passes.
    let result: Value =
        serde_json::from_str(&zcode_config::hooks::validate_workspace_hooks_config(
            r#"{"enabled": true, "events": {"Stop": [{"matcher": "x", "hooks": [{"type": "command", "command": "c", "timeout": 5}]}]}}"#,
        ))
        .unwrap();
    assert_eq!(result["ok"], serde_json::json!(true));

    // The discriminator message is zod's spelling.
    let result: Value =
        serde_json::from_str(&zcode_config::hooks::validate_workspace_hooks_config(
            r#"{"events": {"Stop": [{"hooks": [{"type": "magic", "command": "c"}]}]}}"#,
        ))
        .unwrap();
    assert_eq!(result["ok"], serde_json::json!(false));
    assert_eq!(
        result["issues"][0]["message"],
        serde_json::json!("Invalid discriminator value. Expected 'process' | 'command'")
    );
}
