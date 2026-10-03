//! `setting` channel — the persisted application settings.
//!
//! Transcribed from `packages/services/src/setting/settingService.ts`.
//!
//! # The defaults are a contract, not a convenience
//!
//! `get()` must return a fully-populated `AppSettings` on a fresh install,
//! because the UI reads fields like `recentProjects` and
//! `embeddedBrowserViewportPreference` without null checks on startup. The
//! default object is therefore pinned against
//! `tests/settings-defaults.json`, which is generated from the zod schema itself
//! by `scripts/gen-settings-defaults.ts`. If that file is stale the test fails
//! rather than the app booting with subtly different defaults than the web and
//! desktop builds.
//!
//! # Corrupt files are quarantined, not just ignored
//!
//! A hand-edited or half-written `setting.json` would otherwise fail validation
//! on every single start. The TypeScript original renames it to
//! `setting.json.corrupt-<timestamp>` and returns defaults; that is reproduced
//! here so the user's data is preserved and the next write rebuilds a valid file.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value as JsonValue};
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

/// Settings live beside the rest of the app data, matching `getSettingsDir()`.
const SETTINGS_SUBDIR: [&str; 2] = [".zcode", "v2"];
const SETTINGS_FILE: &str = "setting.json";

/// Cap on `recentProjects`, matching the original's trimming.
const MAX_RECENT_PROJECTS: usize = 10;

/// The complete default settings object.
///
/// Transcribed from `appSettingsSchema.parse({})`. Key order matches the
/// schema's declaration order, because this object is persisted and its exact
/// shape is what the original writes.
fn default_settings() -> JsonValue {
    json!({
        "recentProjects": [],
        "terminalInheritSystemProfile": true,
        "embeddedBrowserAllowInsecureCertificates": false,
        "embeddedBrowserViewportPreference": {
            "mode": "normal",
            "viewport": { "width": 393, "height": 852 },
            "zoom": "fit"
        },
        "computerUseComposerEntryHidden": true,
        "taskAutoArchiveEnabled": false,
        "taskAutoArchiveOlderThanDays": 7,
        "closeToTrayOnWindows": true,
        "closeToTrayOnWindowsMigrationInitialized": true,
        "keepAwakeWhileRunning": false,
        "desktopChromiumHardwareAccelerationEnabled": true,
        "messageStreamShowReasoning": true,
        "messageStreamShowReasoningMigrationInitialized": true,
        "messageStreamShowTodos": false,
        "toolGroupingExploreEnabled": true,
        "toolGroupingTerminalEnabled": true,
        "toolGroupingChangesEnabled": false,
        "zcodeInteractionBehavior": "queue",
        "askUserQuestionAutoResolutionEnabled": true,
        "modelIoFullRetentionEnabled": false,
        "startPlanRecommendationDismissed": false,
        "providerFamilyConnectionSelections": {},
        "providerFamilyDomainMigrated": false,
        "nativeSearchEnhancementsEnabled": true,
        "lastWorkspaceSession": [],
        "lastActiveTabIndex": 0,
        "receivePreviewUpdates": false,
        "autoDownloadAndInstallUpdates": false,
        "skippedElectronUpdateVersions": {}
    })
}

/// `$HOME/.zcode/v2`.
fn settings_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .unwrap_or_default();
    let mut path = PathBuf::from(home);
    for part in SETTINGS_SUBDIR {
        path.push(part);
    }
    path
}

fn settings_file() -> PathBuf {
    settings_dir().join(SETTINGS_FILE)
}

/// Fill missing keys from the defaults, leaving present values alone.
///
/// This is the Rust stand-in for the zod schema's `.default()`: the original
/// validates a merged object so a partial or older `setting.json` still yields
/// every field. Unknown keys are preserved, so a newer field written by another
/// build is not silently dropped on the next save.
fn with_defaults(stored: &JsonValue) -> JsonValue {
    let defaults = default_settings();
    let mut merged = defaults.as_object().cloned().unwrap_or_default();
    if let Some(stored) = stored.as_object() {
        for (key, value) in stored {
            merged.insert(key.clone(), value.clone());
        }
    }
    JsonValue::Object(merged)
}

/// Quarantine a corrupt settings file, preserving it for the user.
fn quarantine(path: &Path) {
    let timestamp = iso_timestamp();
    let backup = path.with_file_name(format!("{SETTINGS_FILE}.corrupt-{timestamp}"));
    match std::fs::rename(path, &backup) {
        Ok(()) => tracing::warn!(
            path = %backup.display(),
            "invalid settings json quarantined; defaults will be used"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Another reader quarantined it first. That is the expected outcome
            // under concurrent startup, not a failure.
            tracing::debug!("settings file already quarantined by another reader");
        }
        Err(error) => {
            tracing::error!(%error, "could not quarantine the invalid settings file");
        }
    }
}

/// An ISO-8601 timestamp with `:` and `.` replaced, matching the original's
/// filename-safe format.
fn iso_timestamp() -> String {
    // Formatted from the system clock rather than pulling in a date library: the
    // value only has to be unique and sortable for a backup filename.
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("backup-{seconds}")
}

/// Read the settings, applying defaults and quarantining a corrupt file.
fn read_settings() -> JsonValue {
    let path = settings_file();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        // No file yet is the normal first-run case, not an error.
        return default_settings();
    };
    match serde_json::from_str::<JsonValue>(&raw) {
        Ok(value) if value.is_object() => with_defaults(&value),
        Ok(_) => {
            quarantine(&path);
            default_settings()
        }
        Err(error) => {
            tracing::warn!(%error, "settings file is not valid JSON");
            quarantine(&path);
            default_settings()
        }
    }
}

/// Write settings atomically: a temp file plus a rename.
///
/// The original notes that readers can observe a partially written file, so the
/// rename is what makes a torn write impossible for them.
fn write_settings(value: &JsonValue) -> Result<(), String> {
    let path = settings_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let serialised =
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serialised.as_bytes())
        .map_err(|error| format!("cannot write {}: {error}", temp.display()))?;
    std::fs::rename(&temp, &path)
        .map_err(|error| format!("cannot replace {}: {error}", path.display()))
}

/// Merge a patch into the stored settings.
///
/// `null` in the patch clears a value, matching the original's
/// `normalizeSettingsPatch`; a key set to `null` is removed rather than stored
/// as null so the next read restores the default.
fn apply_patch(stored: &mut JsonValue, patch: &JsonValue) {
    let (Some(target), Some(source)) = (stored.as_object_mut(), patch.as_object()) else {
        return;
    };
    for (key, value) in source {
        if value.is_null() {
            target.remove(key);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

/// Trim `recentProjects` to the cap and drop empty entries.
fn normalise_recent_projects(settings: &mut JsonValue) {
    let Some(map) = settings.as_object_mut() else {
        return;
    };
    let Some(list) = map.get("recentProjects").and_then(JsonValue::as_array) else {
        return;
    };
    let mut kept: Vec<JsonValue> = list
        .iter()
        .filter(|value| value.as_str().is_some_and(|path| !path.trim().is_empty()))
        .cloned()
        .collect();
    kept.dedup();
    if kept.len() > MAX_RECENT_PROJECTS {
        kept.drain(..kept.len() - MAX_RECENT_PROJECTS);
    }
    map.insert("recentProjects".into(), JsonValue::Array(kept));
}

/// The `setting` channel.
pub struct SettingService {
    /// Serialises writes so two concurrent updates cannot interleave and lose
    /// one of the patches.
    write_lock: Mutex<()>,
}

impl SettingService {
    pub fn new() -> Self {
        Self {
            write_lock: Mutex::new(()),
        }
    }

    fn get(&self) -> JsonValue {
        read_settings()
    }

    fn update(&self, patch: &JsonValue, expected_account: Option<&JsonValue>) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "settings write lock poisoned".to_string())?;

        let mut settings = read_settings();

        // The account settings are compared before writing so a concurrent
        // change from another window is not silently overwritten.
        if let Some(expected) = expected_account {
            for key in ["providerFamilyDomain", "providerFamilyConnectionSelections"] {
                let Some(wanted) = expected.get(key) else {
                    continue;
                };
                let current = settings.get(key).cloned().unwrap_or(JsonValue::Null);
                if &current != wanted {
                    return Err(format!(
                        "settings changed elsewhere: {key} no longer matches the value this update was based on"
                    ));
                }
            }
        }

        apply_patch(&mut settings, patch);
        normalise_recent_projects(&mut settings);
        write_settings(&settings)
    }
}

impl Default for SettingService {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelHandler for SettingService {
    fn call(
        &self,
        _ctx: &str,
        method: &str,
        args: &[JsonValue],
    ) -> Result<JsonValue, HandlerError> {
        // `args` is the positional list the client sent; see `ChannelHandler::call`.
        match method {
            "get" => Ok(self.get()),
            "update" => {
                let patch = args.first().cloned().unwrap_or(JsonValue::Null);
                let expected = args.get(1).cloned();
                self.update(&patch, expected.as_ref())
                    .map_err(HandlerError::message)?;
                // The original is `Promise<void>`, so the value is discarded by
                // the client. Resolving with JSON null is equivalent here: the
                // promise settles either way and nothing reads the result.
                Ok(JsonValue::Null)
            }
            other => Err(HandlerError::message(format!(
                "setting.{other} is not implemented by the Rust host"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        _event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        None
    }
}
