//! The `setting` channel, checked against the TypeScript defaults.
//!
//! Two things are pinned here. First, the default settings object is compared
//! byte-for-byte against `tests/settings-defaults.json`, which is generated from
//! the zod schema — so a schema change that is not mirrored in Rust fails here
//! instead of booting the app with different defaults than the other builds.
//! Second, the persistence behaviours that are easy to get subtly wrong:
//! merging, clearing, quarantining a corrupt file, and the concurrency guard.

use std::path::{Path, PathBuf};

use serde_json::{json, Value as JsonValue};
use zcode_rpc_server::channel::ChannelHandler;
use zcode_tauri_lib::services::SettingService;

/// Run `body` with `ZCODE_DATA_BASE_DIR`-style isolation.
///
/// The settings path is derived from `$HOME`, so a test that does not redirect
/// it would read and write the developer's real `~/.zcode/v2/setting.json`.
/// Serialised because `$HOME` is process-global and Rust runs tests in threads.
fn with_isolated_home<T>(body: impl FnOnce(&PathBuf) -> T) -> T {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let previous = std::env::var("HOME").ok();
    let dir = std::env::temp_dir().join(format!(
        "zcode-setting-test-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp home");
    std::env::set_var("HOME", &dir);

    let result = body(&dir);

    std::env::set_var("HOME", previous.unwrap_or_default());
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn settings_path(home: &Path) -> PathBuf {
    home.join(".zcode").join("v2").join("setting.json")
}

fn call(service: &SettingService, method: &str, args: Vec<JsonValue>) -> Result<JsonValue, String> {
    service
        .call("ctx", method, &args)
        .map_err(|error| error.to_string())
}

fn get(service: &SettingService) -> JsonValue {
    call(service, "get", Vec::new()).expect("get")
}

#[test]
fn the_defaults_match_the_typescript_schema() {
    with_isolated_home(|_home| {
        let service = SettingService::new();
        let defaults = get(&service);

        let expected: JsonValue = serde_json::from_str(include_str!("settings-defaults.json"))
            .expect("the generated defaults fixture must be valid JSON");

        assert_eq!(
            defaults, expected,
            "Rust defaults diverged from appSettingsSchema.parse({{}}) — \
             re-run `pnpm exec tsx scripts/gen-settings-defaults.ts > \
             apps/zcode-tauri/src-tauri/tests/settings-defaults.json`"
        );
    });
}

#[test]
fn a_fresh_install_gets_every_field() {
    with_isolated_home(|_home| {
        let settings = get(&SettingService::new());
        // The UI reads these without a guard, so a missing key is a crash.
        for key in [
            "recentProjects",
            "embeddedBrowserViewportPreference",
            "lastWorkspaceSession",
            "providerFamilyConnectionSelections",
            "skippedElectronUpdateVersions",
            "zcodeInteractionBehavior",
        ] {
            assert!(
                settings.get(key).is_some(),
                "a default must include `{key}`"
            );
        }
        assert_eq!(settings["recentProjects"], json!([]));
        assert_eq!(settings["zcodeInteractionBehavior"], "queue");
        assert_eq!(settings["taskAutoArchiveOlderThanDays"], 7);
        assert_eq!(
            settings["embeddedBrowserViewportPreference"]["viewport"]["width"],
            393
        );
    });
}

#[test]
fn update_merges_and_persists() {
    with_isolated_home(|home| {
        let service = SettingService::new();
        call(
            &service,
            "update",
            vec![json!({ "keepAwakeWhileRunning": true, "recentProjects": ["/tmp/a"] })],
        )
        .expect("update");

        let reloaded = get(&service);
        assert_eq!(reloaded["keepAwakeWhileRunning"], true);
        assert_eq!(reloaded["recentProjects"], json!(["/tmp/a"]));
        // Untouched defaults must survive the write.
        assert_eq!(reloaded["zcodeInteractionBehavior"], "queue");

        // And the file itself must contain it, not just the in-memory value.
        let raw = std::fs::read_to_string(settings_path(home)).expect("settings file");
        let on_disk: JsonValue = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(on_disk["keepAwakeWhileRunning"], true);
    });
}

#[test]
fn a_null_in_a_patch_clears_the_value_so_the_default_returns() {
    with_isolated_home(|_home| {
        let service = SettingService::new();
        call(&service, "update", vec![json!({ "keepAwakeWhileRunning": true })]).expect("set");
        assert_eq!(get(&service)["keepAwakeWhileRunning"], true);

        // The original normalises an empty string to undefined; null is the wire
        // form of that and must remove the key, not store a literal null.
        call(&service, "update", vec![json!({ "keepAwakeWhileRunning": null })]).expect("clear");
        let settings = get(&service);
        assert_eq!(
            settings["keepAwakeWhileRunning"], false,
            "a cleared value must fall back to the default"
        );
    });
}

#[test]
fn recent_projects_is_capped_and_deduplicated() {
    with_isolated_home(|_home| {
        let service = SettingService::new();
        let many: Vec<String> = (0..15).map(|i| format!("/tmp/p{i}")).collect();
        call(
            &service,
            "update",
            vec![json!({ "recentProjects": many })],
        )
        .expect("update");

        let kept = get(&service)["recentProjects"]
            .as_array()
            .cloned()
            .expect("array");
        assert_eq!(kept.len(), 10, "the cap is ten entries");
        // The most recent entries are the ones kept.
        assert_eq!(kept.last().unwrap(), "/tmp/p14");

        call(
            &service,
            "update",
            vec![json!({ "recentProjects": ["/tmp/x", "/tmp/x"] })],
        )
        .expect("update");
        let deduped = get(&service)["recentProjects"].as_array().cloned().unwrap();
        assert_eq!(deduped.len(), 1, "duplicates must collapse");
    });
}

#[test]
fn blank_project_paths_are_dropped() {
    with_isolated_home(|_home| {
        let service = SettingService::new();
        call(
            &service,
            "update",
            vec![json!({ "recentProjects": ["  ", "/tmp/real", ""] })],
        )
        .expect("update");
        assert_eq!(get(&service)["recentProjects"], json!(["/tmp/real"]));
    });
}

#[test]
fn a_corrupt_file_is_quarantined_and_defaults_are_returned() {
    with_isolated_home(|home| {
        let path = settings_path(home);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        // Not JSON at all — the hand-edited-file case the original describes.
        std::fs::write(&path, "not json at all").expect("write");

        let settings = get(&SettingService::new());
        let expected: JsonValue = serde_json::from_str(include_str!("settings-defaults.json"))
            .expect("fixture");
        assert_eq!(settings, expected, "a corrupt file must yield defaults");

        assert!(
            !path.exists(),
            "the corrupt file must be moved aside, not left to fail again"
        );
        let quarantined: Vec<_> = std::fs::read_dir(path.parent().expect("parent"))
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("setting.json.corrupt-"))
            .collect();
        assert_eq!(
            quarantined.len(),
            1,
            "the user's data must be preserved in a .corrupt- backup, found {quarantined:?}"
        );
    });
}

#[test]
fn a_partial_file_is_completed_from_the_defaults() {
    with_isolated_home(|home| {
        let path = settings_path(home);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        // An older settings file missing most fields must still yield a complete
        // object, which is what the schema's defaults do in the original.
        std::fs::write(&path, r#"{"keepAwakeWhileRunning":true}"#).expect("write");

        let settings = get(&SettingService::new());
        assert_eq!(settings["keepAwakeWhileRunning"], true);
        assert_eq!(settings["zcodeInteractionBehavior"], "queue");
        assert_eq!(settings["recentProjects"], json!([]));
    });
}

#[test]
fn an_unknown_field_is_preserved_across_a_write() {
    with_isolated_home(|_home| {
        let service = SettingService::new();
        call(
            &service,
            "update",
            vec![json!({ "someFutureField": "written-by-a-newer-build" })],
        )
        .expect("update");
        call(&service, "update", vec![json!({ "keepAwakeWhileRunning": true })]).expect("update");

        assert_eq!(
            get(&service)["someFutureField"], "written-by-a-newer-build",
            "a field this build does not understand must not be silently dropped"
        );
    });
}

#[test]
fn a_concurrent_account_mismatch_is_rejected_rather_than_overwriting() {
    with_isolated_home(|_home| {
        let service = SettingService::new();
        call(
            &service,
            "update",
            vec![json!({ "providerFamilyDomain": "zai" })],
        )
        .expect("first write");

        // The caller believes the domain is still `bigmodel`; it is not, so the
        // update must be refused rather than clobbering the newer value.
        let error = call(
            &service,
            "update",
            vec![
                json!({ "keepAwakeWhileRunning": true }),
                json!({ "providerFamilyDomain": "bigmodel" }),
            ],
        )
        .expect_err("must refuse");
        assert!(
            error.contains("providerFamilyDomain"),
            "the failure must name the field that moved on, got: {error}"
        );
        assert_eq!(
            get(&service)["providerFamilyDomain"], "zai",
            "the stored value must be untouched"
        );
    });
}

#[test]
fn an_unimplemented_method_names_itself_in_the_error() {
    with_isolated_home(|_home| {
        let error = call(&SettingService::new(), "updateDataBaseDir", vec![json!("/tmp")])
            .expect_err("not ported");
        assert!(error.contains("updateDataBaseDir"), "got: {error}");
    });
}

#[test]
fn the_channel_publishes_no_events() {
    assert!(SettingService::new()
        .subscribe("ctx", "onDidChange", None)
        .is_none());
}
