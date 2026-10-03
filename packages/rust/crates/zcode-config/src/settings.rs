//! `parse_settings_content` / `parse_settings_patch` — the AppSettings schema
//! and its preprocess chain, ported from `packages/shared/src/validationAppSettings.ts`.
//!
//! Spec: `docs/specs/rust-native-config.md` §3.4, rows T26–T41. The design
//! notes that pin the hard parts:
//!
//! - **Order is load-bearing twice.** The preprocess chain runs in a fixed
//!   six-step order before validation (each step a whole-object rewrite), and
//!   issue collection follows the *schema shape* order, not the input's key
//!   order — pinned by probes where reversed input emits the same sequence.
//! - **Unknown keys are stripped, never rejected** (`z.object` strip mode,
//!   T28/T40) — except inside `.strict()` sub-objects (viewport preference,
//!   the family-selection members), where they surface as `unrecognized_keys`.
//! - **zod v4 messages are the contract** (§5's differential): every string in
//!   this file was captured from the live schema, e.g. `expected int` (not
//!   "integer"), `Invalid option: expected one of "a"|"b"` for enums (quoted,
//!   no spaces) versus `Expected 'a' | 'b'` for discriminators (single quotes,
//!   spaces), and `Invalid input: expected record, received number`.
//! - The three sanitizers **delete** a field rather than failing the file
//!   (T29/T30), the two migrations **inject** a field pair (T31/T32), and
//!   `needsMigrationPersist` is computed from the **raw** pre-preprocess value
//!   (otherwise an injected tag would hide its own migration).

use serde::Serialize;
use serde_json::{Map, Value};

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// One `{ path, message }` issue as §3.4 defines it. `path` is dotted; the
/// empty string is the root, which `formatZodError` renders as `<root>`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingsIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsParseResult {
    /// `"ok"`, `"invalid-json"` or `"schema-invalid"`.
    pub status: &'static str,
    /// Present only on `ok`; `null` otherwise (T26).
    pub settings: Option<Value>,
    /// The raw-value migration predicate (T33/T34); `false` unless `ok`,
    /// because a caller that quarantines never persists.
    pub needs_migration_persist: bool,
    pub issues: Vec<SettingsIssue>,
}

impl SettingsParseResult {
    fn invalid_json() -> Self {
        Self {
            status: "invalid-json",
            settings: None,
            needs_migration_persist: false,
            issues: Vec::new(),
        }
    }

    fn schema_invalid(issues: Vec<SettingsIssue>) -> Self {
        Self {
            status: "schema-invalid",
            settings: None,
            needs_migration_persist: false,
            issues,
        }
    }
}

// ---------------------------------------------------------------------------
// Message vocabulary (zod v4, captured — see module docs)
// ---------------------------------------------------------------------------

fn received_name(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::String(_)) => "string",
        Some(Value::Number(_)) => "number",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Null) => "null",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// The `{path, message}` issue shape, in zod v4's spelling.
pub fn invalid_type_issue(path: &str, expected: &str, value: &Value) -> SettingsIssue {
    invalid_type(path, expected, Some(value))
}

/// The `unrecognized_keys` issue, singular/plural per zod v4.
pub fn unrecognized_keys_issue(path: &str, keys: &[String]) -> SettingsIssue {
    SettingsIssue {
        path: path.to_string(),
        message: unrecognized_keys(keys),
    }
}

fn invalid_type(path: &str, expected: &str, value: Option<&Value>) -> SettingsIssue {
    SettingsIssue {
        path: path.to_string(),
        message: format!(
            "Invalid input: expected {expected}, received {}",
            received_name(value)
        ),
    }
}

fn enum_message(values: &[&str]) -> String {
    format!(
        "Invalid option: expected one of {}",
        values
            .iter()
            .map(|value| format!("\"{value}\""))
            .collect::<Vec<_>>()
            .join("|")
    )
}

fn discriminator_message(values: &[&str]) -> String {
    format!(
        "Invalid discriminator value. Expected {}",
        values
            .iter()
            .map(|value| format!("'{value}'"))
            .collect::<Vec<_>>()
            .join(" | ")
    )
}

fn too_small_count() -> String {
    "Too small: expected string to have >=1 characters".to_string()
}

fn too_small_number(comparison: &str) -> String {
    format!("Too small: expected number to be {comparison}")
}

fn too_big_number(comparison: &str) -> String {
    format!("Too big: expected number to be {comparison}")
}

fn unrecognized_keys(keys: &[String]) -> String {
    let quoted = keys
        .iter()
        .map(|key| format!("\"{key}\""))
        .collect::<Vec<_>>()
        .join(", ");
    if keys.len() == 1 {
        format!("Unrecognized key: {quoted}")
    } else {
        format!("Unrecognized keys: {quoted}")
    }
}

// ---------------------------------------------------------------------------
// Value predicates
// ---------------------------------------------------------------------------

/// `z.number().int()` — an integer within JSON's exact range. Values arrive as
/// JSON text, so integers are `u64`/`i64`; the f64 arm exists for callers that
/// pass a parsed JS number (the patch path over the napi boundary).
fn as_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                return Some(int);
            }
            if let Some(uint) = number.as_u64() {
                return i64::try_from(uint).ok();
            }
            let float = number.as_f64()?;
            if float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_992.0 {
                Some(float as i64)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn is_number(value: &Value) -> bool {
    value.is_number()
}

/// `z.string().trim().min(1)`: trim first (the live schema rejects `"   "`),
/// and the OUTPUT is the trimmed text (`dataBaseDir: " /data "` → `"/data"`).
fn non_empty_string(value: &Value) -> Result<String, SettingsIssue> {
    let text = value
        .as_str()
        .ok_or_else(|| invalid_type("", "string", Some(value)))?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(SettingsIssue {
            path: String::new(),
            message: too_small_count(),
        });
    }
    Ok(trimmed.to_string())
}

const OCCUPATIONS: [&str; 14] = [
    "office",
    "developer",
    "independent",
    "infrastructure",
    "product",
    "design",
    "student",
    "creator",
    "operations",
    "marketing",
    "finance",
    "accounting",
    "legal",
    "other",
];
const FAMILY_DOMAINS: [&str; 2] = ["zai", "bigmodel"];
const INTERACTION_BEHAVIORS: [&str; 2] = ["queue", "guide"];
const ELECTRON_CHANNELS: [&str; 2] = ["stable", "preview"];
const WORKSPACE_PURPOSES: [&str; 2] = ["project", "conversation"];
const CONNECTION_STATUSES: [&str; 2] = ["connected", "failed"];
const ASSET_INSTALL_MODES: [&str; 2] = ["local-download-upload", "remote-download"];
const SHELL_DIALECTS: [&str; 2] = ["cmd", "git-bash"];
const SHELL_MODES: [&str; 2] = ["auto", "shell"];
const VIEWPORT_MODES: [&str; 2] = ["normal", "responsive"];
const VIEWPORT_ZOOMS: [&str; 7] = ["fit", "50", "75", "100", "125", "150", "200"];
const SESSION_KINDS: [&str; 2] = ["local", "remote"];
const SSH_KINDS: [&str; 1] = ["ssh"];
const SELECTION_KINDS: [&str; 3] = ["start-plan", "individual-coding-plan", "team-coding-plan"];
const REMOTE_RESOURCE_PACKAGE_IDS: [&str; 7] = [
    "server-bundle",
    "node-runtime",
    "node-pty",
    "glm",
    "bfs",
    "ripgrep",
    "ugrep",
];

fn check_enum(
    issues: &mut Vec<SettingsIssue>,
    path: &str,
    value: &Value,
    allowed: &[&'static str],
) -> bool {
    let matches = value.as_str().is_some_and(|text| allowed.contains(&text));
    if !matches {
        issues.push(SettingsIssue {
            path: path.to_string(),
            message: enum_message(allowed),
        });
    }
    matches
}

/// `z.number().int()` + optional bounds, in zod's order: the type first
/// (`expected number`), then intness (`expected int`), then the range — and an
/// intness failure suppresses the range issues (probe: `0.5` emits one issue).
/// `z.number().int()` with optional bounds, in zod's order: the type first
/// (`expected number`), then intness (`expected int`), then ONE range issue —
/// an intness failure suppresses the range issues (probe: `0.5` emits one).
///
/// Each bound carries its comparison token because zod spells `positive()`
/// as `>0` and `.min(480)` as `>=480`: `min = (bound, ">=" | ">")` fails when
/// `int < bound` (inclusive) or `int <= bound` (exclusive), mirrored for max.
fn check_int(
    issues: &mut Vec<SettingsIssue>,
    path: &str,
    value: &Value,
    min: Option<(i64, &'static str)>,
    max: Option<(i64, &'static str)>,
) -> bool {
    if !is_number(value) {
        issues.push(invalid_type(path, "number", Some(value)));
        return false;
    }
    let Some(int) = as_int(value) else {
        issues.push(SettingsIssue {
            path: path.to_string(),
            message: "Invalid input: expected int, received number".to_string(),
        });
        return false;
    };
    if let Some((bound, comparison)) = min {
        let failed = if comparison == ">" { int <= bound } else { int < bound };
        if failed {
            issues.push(SettingsIssue {
                path: path.to_string(),
                message: too_small_number(&format!("{comparison}{bound}")),
            });
            return false;
        }
    }
    if let Some((bound, comparison)) = max {
        if int > bound {
            issues.push(SettingsIssue {
                path: path.to_string(),
                message: too_big_number(&format!("{comparison}{bound}")),
            });
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Preprocess chain (six steps, fixed order)
// ---------------------------------------------------------------------------

fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn strip_historical_remote_resource_packages(target: &Value) -> Value {
    if !target.is_object() {
        return target.clone();
    }
    let object = target.as_object().expect("object");
    if object.get("kind").and_then(Value::as_str) != Some("ssh")
        || !object.contains_key("resourcePackages")
    {
        return target.clone();
    }
    let mut next = object.clone();
    // SSH deployment always uses the complete active resource set; the
    // resourcePackages in an old setting.json are historical clippings.
    next.remove("resourcePackages");
    Value::Object(next)
}

fn legacy_history_entry_valid(entry: &Value) -> bool {
    let Some(object) = as_record(entry) else {
        return false;
    };
    let id_ok = non_empty_string(object.get("id").unwrap_or(&Value::Null)).is_ok();
    let path_ok = non_empty_string(object.get("workspacePath").unwrap_or(&Value::Null)).is_ok();
    let target_ok = ssh_target_shape_ok(object.get("target").unwrap_or(&Value::Null));
    let opened_ok = check_int(&mut Vec::new(), "", object.get("lastOpenedAt").unwrap_or(&Value::Null), Some((0, ">=")), None);
    let status_ok = object
        .get("lastConnectionStatus")
        .is_some_and(|value| CONNECTION_STATUSES.contains(&value.as_str().unwrap_or("")));
    let optional_strings_ok = ["localWorkspacePath", "workspaceIdentity"]
        .iter()
        .all(|key| match object.get(*key) {
            None => true,
            Some(value) => non_empty_string(value).is_ok(),
        });
    let error_ok = match object.get("lastConnectionError") {
        None => true,
        Some(value) => value.is_string(),
    };
    id_ok && path_ok && target_ok && opened_ok && status_ok && optional_strings_ok && error_ok
}

/// The ssh target shape check used by the legacy-history migration (the
/// `safeParse` in the predecessor drops entries whose target no longer
/// validates).
fn ssh_target_shape_ok(target: &Value) -> bool {
    let Some(object) = as_record(target) else {
        return false;
    };
    if object.get("kind").and_then(Value::as_str) != Some("ssh") {
        return false;
    }
    if non_empty_string(object.get("host").unwrap_or(&Value::Null)).is_err()
        || non_empty_string(object.get("username").unwrap_or(&Value::Null)).is_err()
        || non_empty_string(object.get("sshConfigAlias").unwrap_or(&Value::Null)).is_err()
    {
        return false;
    }
    match object.get("port") {
        None => true,
        Some(port) => {
            check_int(&mut Vec::new(), "", port, Some((0, ">")), Some((65535, "<=")))
        }
    }
}

/// Step 1: `migrateLegacyWorkspaceSession` — merges the three legacy
/// homes of the session list (local tabs, remote history, combined session)
/// into `lastWorkspaceSession`, then removes the legacy fields.
fn migrate_legacy_workspace_session(value: Value) -> Value {
    let Some(raw) = as_record(&value).cloned() else {
        return value;
    };
    let mut migrated = raw.clone();

    let last_workspace_session = migrated
        .get("lastWorkspaceSession")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_legacy_remote_entries = last_workspace_session.iter().any(|entry| {
        as_record(entry).is_some_and(|object| object.contains_key("historyId"))
    });

    let legacy_remote_history = migrated
        .get("remoteWorkspaceHistory")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut legacy_remote_history_by_id: Map<String, Value> = Map::new();
    for entry in legacy_remote_history {
        let sanitized = match as_record(&entry) {
            Some(object) => {
                let mut next = object.clone();
                if let Some(target) = object.get("target") {
                    next.insert(
                        "target".to_string(),
                        strip_historical_remote_resource_packages(target),
                    );
                }
                Value::Object(next)
            }
            None => entry,
        };
        if legacy_history_entry_valid(&sanitized) {
            if let Some(id) = sanitized.get("id").and_then(Value::as_str).map(str::to_string) {
                legacy_remote_history_by_id.insert(id, sanitized);
            }
        }
    }

    let mut migrated_entries: Vec<Value> = Vec::new();
    for entry in &last_workspace_session {
        let Some(object) = as_record(entry) else {
            continue;
        };
        if object.get("kind").and_then(Value::as_str) == Some("local") {
            if object.get("workspacePath").is_some_and(Value::is_string) {
                let purpose = match object.get("workspacePurpose").and_then(Value::as_str) {
                    Some("conversation") => "conversation",
                    _ => "project",
                };
                migrated_entries.push(serde_json::json!({
                    "kind": "local",
                    "workspacePath": object["workspacePath"],
                    "workspacePurpose": purpose,
                }));
            }
            continue;
        }
        if object.get("kind").and_then(Value::as_str) == Some("remote") {
            if object.get("workspacePath").is_some_and(Value::is_string)
                && object.contains_key("target")
            {
                let mut next = object.clone();
                next.insert(
                    "target".to_string(),
                    strip_historical_remote_resource_packages(&object["target"]),
                );
                migrated_entries.push(Value::Object(next));
                continue;
            }
            if let Some(history_id) = object.get("historyId").and_then(Value::as_str) {
                if let Some(legacy) = legacy_remote_history_by_id.get(history_id) {
                    let legacy_object = as_record(legacy).expect("validated");
                    let mut next = Map::new();
                    next.insert("kind".to_string(), Value::String("remote".into()));
                    next.insert(
                        "workspacePath".to_string(),
                        legacy_object["workspacePath"].clone(),
                    );
                    for key in ["localWorkspacePath", "workspaceIdentity"] {
                        if let Some(field) = legacy_object.get(key) {
                            next.insert(key.to_string(), field.clone());
                        }
                    }
                    next.insert(
                        "target".to_string(),
                        strip_historical_remote_resource_packages(&legacy_object["target"]),
                    );
                    next.insert("lastOpenedAt".to_string(), legacy_object["lastOpenedAt"].clone());
                    next.insert(
                        "lastConnectionStatus".to_string(),
                        legacy_object["lastConnectionStatus"].clone(),
                    );
                    if let Some(error) = legacy_object.get("lastConnectionError") {
                        next.insert("lastConnectionError".to_string(), error.clone());
                    }
                    migrated_entries.push(Value::Object(next));
                }
            }
        }
    }

    let legacy_local_entries: Vec<String> = migrated
        .get("lastOpenTabs")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let existing_local_paths: std::collections::HashSet<String> = migrated_entries
        .iter()
        .filter_map(|entry| {
            let object = as_record(entry)?;
            if object.get("kind").and_then(Value::as_str) == Some("local") {
                object.get("workspacePath").and_then(Value::as_str).map(str::to_string)
            } else {
                None
            }
        })
        .collect();

    let mut next_workspace_session = migrated_entries;
    for workspace_path in legacy_local_entries {
        if existing_local_paths.contains(&workspace_path) {
            continue;
        }
        next_workspace_session.push(serde_json::json!({
            "kind": "local",
            "workspacePath": workspace_path,
            "workspacePurpose": "project",
        }));
    }

    let last_open_tabs_was_array = migrated.get("lastOpenTabs").is_some_and(Value::is_array);
    if !next_workspace_session.is_empty() || has_legacy_remote_entries || last_open_tabs_was_array {
        migrated.insert(
            "lastWorkspaceSession".to_string(),
            Value::Array(next_workspace_session),
        );
    }
    migrated.remove("lastOpenTabs");
    migrated.remove("remoteWorkspaceHistory");
    Value::Object(migrated)
}

fn normalize_endpoint_origin(value: &str) -> Result<String, ()> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| ())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(());
    }
    Ok(parsed.origin().ascii_serialization())
}

/// Step 2: an endpoint that does not normalise to an http(s) origin is
/// **deleted**, never a parse failure (T30).
fn sanitize_zcode_endpoint_origin(value: Value) -> Value {
    let Some(object) = as_record(&value).cloned() else {
        return value;
    };
    if !object.contains_key("zcodeEndpointOrigin") {
        return value;
    }
    let mut next = object;
    let normalized = next
        .get("zcodeEndpointOrigin")
        .and_then(Value::as_str)
        .and_then(|text| normalize_endpoint_origin(text).ok());
    match normalized {
        Some(origin) => {
            next.insert("zcodeEndpointOrigin".to_string(), Value::String(origin));
        }
        None => {
            next.remove("zcodeEndpointOrigin");
        }
    }
    Value::Object(next)
}

fn desktop_window_size_valid(value: &Value) -> bool {
    let Some(object) = as_record(value) else {
        return false;
    };
    let mut issues = Vec::new();
    check_int(&mut issues, "", object.get("width").unwrap_or(&Value::Null), Some((480, ">=")), None);
    check_int(&mut issues, "", object.get("height").unwrap_or(&Value::Null), Some((640, ">=")), None);
    let maximized_ok = object
        .get("maximized")
        .is_some_and(|value| value.is_boolean());
    issues.is_empty() && maximized_ok
}

/// Step 5: a broken window size is dropped so one bad field cannot quarantine
/// the whole file (T29).
fn sanitize_desktop_window_size(value: Value) -> Value {
    let Some(object) = as_record(&value).cloned() else {
        return value;
    };
    if !object.contains_key("desktopWindowSize") {
        return value;
    }
    let mut next = object;
    if !desktop_window_size_valid(&next["desktopWindowSize"]) {
        next.remove("desktopWindowSize");
    }
    Value::Object(next)
}

fn viewport_preference_valid(value: &Value) -> bool {
    let Some(object) = as_record(value) else {
        return false;
    };
    // `.strict()`: an unknown inner key invalidates it (which the sanitiser
    // then deletes — the strictness never surfaces as a file failure on read).
    let known = ["mode", "viewport", "zoom"];
    if object.keys().any(|key| !known.contains(&key.as_str())) {
        return false;
    }
    let mut issues = Vec::new();
    check_enum(&mut issues, "", object.get("mode").unwrap_or(&Value::Null), &VIEWPORT_MODES);
    check_enum(&mut issues, "", object.get("zoom").unwrap_or(&Value::Null), &VIEWPORT_ZOOMS);
    let viewport_ok = match object.get("viewport") {
        Some(Value::Object(viewport)) => {
            check_int(&mut issues, "", viewport.get("width").unwrap_or(&Value::Null), Some((320, ">=")), Some((3840, "<=")));
            check_int(&mut issues, "", viewport.get("height").unwrap_or(&Value::Null), Some((320, ">=")), Some((2160, "<=")));
            viewport.keys().all(|key| key == "width" || key == "height") && issues.is_empty()
        }
        _ => false,
    };
    issues.is_empty() && viewport_ok
}

/// Step 6: same deletion contract as the window size (T29's sibling).
fn sanitize_embedded_browser_viewport_preference(value: Value) -> Value {
    let Some(object) = as_record(&value).cloned() else {
        return value;
    };
    if !object.contains_key("embeddedBrowserViewportPreference") {
        return value;
    }
    let mut next = object;
    if !viewport_preference_valid(&next["embeddedBrowserViewportPreference"]) {
        next.remove("embeddedBrowserViewportPreference");
    }
    Value::Object(next)
}

/// Step 3 / Step 4: the one-shot migration injections (T31/T32). The pair is
/// written together because the old default could not distinguish a migrated
/// false from an untouched field.
fn migrate_tagged_default(
    value: Value,
    tag_key: &str,
    value_key: &str,
) -> Value {
    let Some(object) = as_record(&value).cloned() else {
        return value;
    };
    if object.get(tag_key).and_then(Value::as_bool) == Some(true) {
        return value;
    }
    let mut next = object;
    next.insert(value_key.to_string(), Value::Bool(true));
    next.insert(tag_key.to_string(), Value::Bool(true));
    Value::Object(next)
}

/// The six steps in the predecessor's order (`validationAppSettings.ts:439`).
fn preprocess(value: Value) -> Value {
    let value = migrate_legacy_workspace_session(value);
    let value = sanitize_zcode_endpoint_origin(value);
    let value = migrate_tagged_default(value, "closeToTrayOnWindowsMigrationInitialized", "closeToTrayOnWindows");
    let value = migrate_tagged_default(value, "messageStreamShowReasoningMigrationInitialized", "messageStreamShowReasoning");
    let value = sanitize_desktop_window_size(value);
    sanitize_embedded_browserViewport_preference(value)
}

// (The sanitizer chain's step-6 name is spelled below to keep the call site
// aligned with the predecessor's function name.)
fn sanitize_embedded_browserViewport_preference(value: Value) -> Value {
    sanitize_embedded_browser_viewport_preference(value)
}

/// `shouldPersistSettingsMigrations` — evaluated on the RAW value (T33/T34).
fn needs_migration_persist(raw: &Value) -> bool {
    crate::settings_persist::needs_migration_persist(raw)
}

// ---------------------------------------------------------------------------
// Validation (shape order, both modes)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// `appSettingsSchema`: defaults applied, sanitised fields already present.
    Read,
    /// `appSettingsPatchSchema`: everything optional, no defaults, the widened
    /// `providerFamilyDomain` union (T41), unknown keys stripped (T40).
    Patch,
}

struct Collector<'a> {
    issues: &'a mut Vec<SettingsIssue>,
    mode: Mode,
}

impl Collector<'_> {
    fn issue(&mut self, path: String, message: String) {
        self.issues.push(SettingsIssue { path, message });
    }

    fn type_issue(&mut self, path: &str, expected: &str, value: Option<&Value>) {
        self.issue(path.to_string(), invalid_type("", expected, value).message);
    }

    fn string_field(
        &mut self,
        out: &mut Map<String, Value>,
        input: &Map<String, Value>,
        prefix: &str,
        key: &str,
        required_default: Option<&str>,
        trim: bool,
    ) {
        let path = field_path(prefix, key);
        match input.get(key) {
            None => {
                if self.mode == Mode::Read {
                    if let Some(default) = required_default {
                        out.insert(key.to_string(), Value::String(default.to_string()));
                    }
                }
            }
            Some(value) => match non_empty_string(value) {
                Ok(text) => {
                    let _ = trim;
                    out.insert(key.to_string(), Value::String(text));
                }
                Err(mut issue) => {
                    issue.path = path.clone();
                    self.issues.push(issue);
                }
            },
        }
    }

    fn optional_plain_string(&mut self, out: &mut Map<String, Value>, input: &Map<String, Value>, prefix: &str, key: &str) {
        let path = field_path(prefix, key);
        match input.get(key) {
            None => {}
            Some(Value::String(text)) => {
                out.insert(key.to_string(), Value::String(text.clone()));
            }
            Some(value) => self.type_issue(&path, "string", Some(value)),
        }
    }

    fn bool_default(&mut self, out: &mut Map<String, Value>, input: &Map<String, Value>, prefix: &str, key: &str, default: bool) {
        match input.get(key) {
            None => {
                if self.mode == Mode::Read {
                    out.insert(key.to_string(), Value::Bool(default));
                }
            }
            Some(Value::Bool(flag)) => {
                out.insert(key.to_string(), Value::Bool(*flag));
            }
            Some(value) => {
                let path = field_path(prefix, key);
                self.type_issue(&path, "boolean", Some(value));
            }
        }
    }

    fn bool_optional(&mut self, out: &mut Map<String, Value>, input: &Map<String, Value>, prefix: &str, key: &str) {
        match input.get(key) {
            None => {}
            Some(Value::Bool(flag)) => {
                out.insert(key.to_string(), Value::Bool(*flag));
            }
            Some(value) => {
                let path = field_path(prefix, key);
                self.type_issue(&path, "boolean", Some(value));
            }
        }
    }

    fn int_optional(
        &mut self,
        out: &mut Map<String, Value>,
        input: &Map<String, Value>,
        prefix: &str,
        key: &str,
        min: Option<(i64, &'static str)>,
        max: Option<(i64, &'static str)>,
        default: Option<i64>,
    ) {
        match input.get(key) {
            None => {
                if self.mode == Mode::Read {
                    if let Some(default) = default {
                        out.insert(key.to_string(), Value::Number(default.into()));
                    }
                }
            }
            Some(value) => {
                let path = field_path(prefix, key);
                if check_int(self.issues, &path, value, min, max) {
                    out.insert(key.to_string(), value.clone());
                }
            }
        }
    }

    fn enum_optional(
        &mut self,
        out: &mut Map<String, Value>,
        input: &Map<String, Value>,
        prefix: &str,
        key: &str,
        allowed: &[&'static str],
        default: Option<&str>,
        nullish: bool,
    ) {
        match input.get(key) {
            None => {
                if self.mode == Mode::Read {
                    if let Some(default) = default {
                        out.insert(key.to_string(), Value::String(default.to_string()));
                    }
                }
            }
            Some(Value::Null) if nullish => {
                out.insert(key.to_string(), Value::Null);
            }
            Some(value) => {
                let path = field_path(prefix, key);
                if check_enum(self.issues, &path, value, allowed) {
                    out.insert(key.to_string(), value.clone());
                }
            }
        }
    }
}

fn field_path(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.to_string()
    } else {
        format!("{prefix}.{key}")
    }
}

// ---------------------------------------------------------------------------
// Nested composite validators
// ---------------------------------------------------------------------------

/// `appWorkspaceSessionEntrySchema` — a `local`/`remote` discriminated union.
/// A bad discriminator emits exactly one issue at `<path>.kind` (pinned), and
/// a matching discriminator validates that variant in shape order.
fn validate_session_entry(
    collector: &mut Collector,
    input: &Value,
    path: &str,
) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "object", Some(input));
        return None;
    };
    let kind = object.get("kind").and_then(Value::as_str);
    match kind {
        Some("local") => {
            let mut out = Map::new();
            out.insert("kind".to_string(), Value::String("local".into()));
            // Every field is validated even after a failure: zod collects the
            // member's full issue list (pinned: the four missing shell fields).
            let mut ok = true;
            match object.get("workspacePath") {
                None => {
                    collector.type_issue(&field_path(path, "workspacePath"), "string", None);
                    ok = false;
                }
                Some(value) => match non_empty_string(value) {
                    Ok(text) => {
                        out.insert("workspacePath".to_string(), Value::String(text));
                    }
                    Err(mut issue) => {
                        issue.path = field_path(path, "workspacePath");
                        collector.issues.push(issue);
                        ok = false;
                    }
                },
            }
            // `default("project")`: absent inserts, present must be one of the
            // two — the preprocess already normalised legacy purposes.
            match object.get("workspacePurpose") {
                None => {
                    out.insert("workspacePurpose".to_string(), Value::String("project".into()));
                }
                Some(value) => {
                    let issue_path = field_path(path, "workspacePurpose");
                    if check_enum(collector.issues, &issue_path, value, &WORKSPACE_PURPOSES) {
                        out.insert("workspacePurpose".to_string(), value.clone());
                    } else {
                        ok = false;
                    }
                }
            }
            if ok {
                Some(Value::Object(out))
            } else {
                None
            }
        }
        Some("remote") => {
            let mut out = Map::new();
            out.insert("kind".to_string(), Value::String("remote".into()));
            let mut ok = true;
            match object.get("workspacePath") {
                None => {
                    collector.type_issue(&field_path(path, "workspacePath"), "string", None);
                    ok = false;
                }
                Some(value) => match non_empty_string(value) {
                    Ok(text) => {
                        out.insert("workspacePath".to_string(), Value::String(text));
                    }
                    Err(mut issue) => {
                        issue.path = field_path(path, "workspacePath");
                        collector.issues.push(issue);
                        ok = false;
                    }
                },
            }
            for key in ["localWorkspacePath", "workspaceIdentity"] {
                let issue_path = field_path(path, key);
                match object.get(key) {
                    None => {}
                    Some(value) => match non_empty_string(value) {
                        Ok(text) => {
                            out.insert(key.to_string(), Value::String(text));
                        }
                        Err(mut issue) => {
                            issue.path = issue_path;
                            collector.issues.push(issue);
                        }
                    },
                }
            }
            // target
            match object.get("target") {
                Some(target) => {
                    if let Some(target) = validate_ssh_target(collector, target, &field_path(path, "target"))
                    {
                        out.insert("target".to_string(), target);
                    } else {
                        ok = false;
                    }
                }
                None => {
                    collector.type_issue(&field_path(path, "target"), "object", None);
                    ok = false;
                }
            }
            // lastOpenedAt / lastConnectionStatus — shape order, both collected.
            {
                let issue_path = field_path(path, "lastOpenedAt");
                match object.get("lastOpenedAt") {
                    None => {
                        collector.type_issue(&issue_path, "number", None);
                        ok = false;
                    }
                    Some(value) => {
                        if check_int(collector.issues, &issue_path, value, Some((0, ">=")), None) {
                            out.insert("lastOpenedAt".to_string(), value.clone());
                        } else {
                            ok = false;
                        }
                    }
                }
            }
            {
                let issue_path = field_path(path, "lastConnectionStatus");
                match object.get("lastConnectionStatus") {
                    None => {
                        collector.type_issue(&issue_path, "string", None);
                        ok = false;
                    }
                    Some(value) => {
                        if check_enum(collector.issues, &issue_path, value, &CONNECTION_STATUSES) {
                            out.insert("lastConnectionStatus".to_string(), value.clone());
                        } else {
                            ok = false;
                        }
                    }
                }
            }
            match object.get("lastConnectionError") {
                None => {}
                Some(Value::String(text)) => {
                    out.insert("lastConnectionError".to_string(), Value::String(text.clone()));
                }
                Some(value) => {
                    collector.type_issue(&field_path(path, "lastConnectionError"), "string", Some(value));
                    ok = false;
                }
            }
            if ok && out.contains_key("target") {
                // Re-order the emitted issues into shape order for this entry:
                // validation above pushed them in execution order, which for the
                // remote variant is already shape order (target, openedAt, status,
                // error). Keep the insertion order of `out` aligned with the
                // variant shape:
                let mut shaped = Map::new();
                for key in [
                    "kind",
                    "workspacePath",
                    "localWorkspacePath",
                    "workspaceIdentity",
                    "target",
                    "lastOpenedAt",
                    "lastConnectionStatus",
                    "lastConnectionError",
                ] {
                    if let Some(value) = out.remove(key) {
                        shaped.insert(key.to_string(), value);
                    }
                }
                return Some(Value::Object(shaped));
            }
            None
        }
        _ => {
            collector.issue(
                field_path(path, "kind"),
                discriminator_message(&SESSION_KINDS),
            );
            None
        }
    }
}

fn validate_ssh_target(collector: &mut Collector, input: &Value, path: &str) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "object", Some(input));
        return None;
    };
    if object.get("kind").and_then(Value::as_str) != Some("ssh") {
        collector.issue(
            field_path(path, "kind"),
            discriminator_message(&SSH_KINDS),
        );
        return None;
    }
    let mut out = Map::new();
    out.insert("kind".to_string(), Value::String("ssh".into()));
    let mut ok = true;
    // Shape order: kind, host, port, username, sshConfigAlias, privateKeyPath,
    // assetInstallMode, resourcePackages, passwordCredentialKey,
    // privateKeyPassphraseCredentialKey — issue order follows it.
    match object.get("host") {
        None => {
            collector.type_issue(&field_path(path, "host"), "string", None);
            ok = false;
        }
        Some(value) => match non_empty_string(value) {
            Ok(text) => {
                out.insert("host".to_string(), Value::String(text));
            }
            Err(mut issue) => {
                issue.path = field_path(path, "host");
                collector.issues.push(issue);
                ok = false;
            }
        },
    }
    if let Some(port) = object.get("port") {
        let issue_path = field_path(path, "port");
        if check_int(collector.issues, &issue_path, port, Some((0, ">")), Some((65535, "<="))) {
            out.insert("port".to_string(), port.clone());
        } else {
            ok = false;
        }
    }
    for key in ["username", "sshConfigAlias"] {
        let issue_path = field_path(path, key);
        match object.get(key) {
            None => {
                collector.type_issue(&issue_path, "string", None);
                ok = false;
            }
            Some(value) => match non_empty_string(value) {
                Ok(text) => {
                    out.insert(key.to_string(), Value::String(text));
                }
                Err(mut issue) => {
                    issue.path = issue_path;
                    collector.issues.push(issue);
                    ok = false;
                }
            },
        }
    }
    match object.get("privateKeyPath") {
        None => {}
        Some(Value::String(text)) => {
            out.insert("privateKeyPath".to_string(), Value::String(text.clone()));
        }
        Some(value) => {
            collector.type_issue(&field_path(path, "privateKeyPath"), "string", Some(value));
            ok = false;
        }
    }
    if let Some(mode) = object.get("assetInstallMode") {
        let issue_path = field_path(path, "assetInstallMode");
        if check_enum(collector.issues, &issue_path, mode, &ASSET_INSTALL_MODES) {
            out.insert("assetInstallMode".to_string(), mode.clone());
        } else {
            ok = false;
        }
    }
    if let Some(packages) = object.get("resourcePackages") {
        let issue_path = field_path(path, "resourcePackages");
        if let Some(validated) = validate_resource_packages(collector, packages, &issue_path) {
            out.insert("resourcePackages".to_string(), validated);
        } else {
            ok = false;
        }
    }
    for key in ["passwordCredentialKey", "privateKeyPassphraseCredentialKey"] {
        let issue_path = field_path(path, key);
        match object.get(key) {
            None => {}
            Some(value) => match non_empty_string(value) {
                Ok(text) => {
                    out.insert(key.to_string(), Value::String(text));
                }
                Err(mut issue) => {
                    issue.path = issue_path;
                    collector.issues.push(issue);
                    ok = false;
                }
            },
        }
    }
    if ok {
        // Shape order: kind, host, port, username, sshConfigAlias,
        // privateKeyPath, assetInstallMode, resourcePackages, password…,
        // privateKeyPassphrase…
        let mut shaped = Map::new();
        for key in [
            "kind",
            "host",
            "port",
            "username",
            "sshConfigAlias",
            "privateKeyPath",
            "assetInstallMode",
            "resourcePackages",
            "passwordCredentialKey",
            "privateKeyPassphraseCredentialKey",
        ] {
            if let Some(value) = out.remove(key) {
                shaped.insert(key.to_string(), value);
            }
        }
        Some(Value::Object(shaped))
    } else {
        None
    }
}

fn validate_resource_packages(collector: &mut Collector, input: &Value, path: &str) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "object", Some(input));
        return None;
    };
    let mut out = Map::new();
    let mut ok = true;
    if let Some(ids) = object.get("selectedPackageIds") {
        let issue_path = field_path(path, "selectedPackageIds");
        match ids.as_array() {
            None => {
                collector.type_issue(&issue_path, "array", Some(ids));
                ok = false;
            }
            Some(entries) => {
                let mut validated = Vec::new();
                for (index, entry) in entries.iter().enumerate() {
                    let element_path = format!("{issue_path}.{index}");
                    match entry.as_str() {
                        Some(id) if REMOTE_RESOURCE_PACKAGE_IDS.contains(&id) => {
                            validated.push(entry.clone());
                        }
                        // `.refine` on a non-string also reports the custom
                        // issue (the refine runs after array item coercion, and
                        // the element type is z.string() — so a non-string fails
                        // the item first).
                        _ => {
                            if !entry.is_string() {
                                collector.type_issue(&element_path, "string", Some(entry));
                            } else {
                                collector.issue(element_path, "Invalid input".to_string());
                            }
                            ok = false;
                        }
                    }
                }
                if ok {
                    out.insert("selectedPackageIds".to_string(), Value::Array(validated));
                }
            }
        }
    }
    // `.object(...)` — non-strict: unknown inner keys are stripped.
    if ok {
        Some(Value::Object(out))
    } else {
        None
    }
}

/// `integratedTerminalShell` — discriminated on `mode` (not `kind`); a missing
/// or wrong discriminator is the same single union issue at `<path>.mode`.
fn validate_integrated_terminal_shell(
    collector: &mut Collector,
    input: &Value,
    path: &str,
) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "object", Some(input));
        return None;
    };
    match object.get("mode").and_then(Value::as_str) {
        Some("auto") => {
            let mut out = Map::new();
            out.insert("mode".to_string(), Value::String("auto".into()));
            Some(Value::Object(out))
        }
        Some("shell") => {
            let mut out = Map::new();
            out.insert("mode".to_string(), Value::String("shell".into()));
            let mut ok = true;
            match object.get("dialect") {
                None => {
                    let issue_path = field_path(path, "dialect");
                    collector.issue(issue_path, enum_message(&SHELL_DIALECTS));
                    ok = false;
                }
                Some(value) => {
                    let issue_path = field_path(path, "dialect");
                    if check_enum(collector.issues, &issue_path, value, &SHELL_DIALECTS) {
                        out.insert("dialect".to_string(), value.clone());
                    } else {
                        ok = false;
                    }
                }
            }
            for key in ["id", "label", "path"] {
                let issue_path = field_path(path, key);
                match object.get(key) {
                    None => {
                        collector.type_issue(&issue_path, "string", None);
                        ok = false;
                    }
                    Some(value) => match non_empty_string(value) {
                        Ok(text) => {
                            out.insert(key.to_string(), Value::String(text));
                        }
                        Err(mut issue) => {
                            issue.path = issue_path;
                            collector.issues.push(issue);
                            ok = false;
                        }
                    },
                }
            }
            if ok {
                let mut shaped = Map::new();
                for key in ["mode", "dialect", "id", "label", "path"] {
                    shaped.insert(key.to_string(), out.remove(key).expect("present"));
                }
                Some(Value::Object(shaped))
            } else {
                None
            }
        }
        // A missing `mode` reports the same discriminator issue (probe: `{}`).
        _ => {
            collector.issue(
                field_path(path, "mode"),
                discriminator_message(&SHELL_MODES),
            );
            None
        }
    }
}

/// `providerFamilyConnectionSelectionSchema` — strict members; the unknown key
/// surfaces at the MEMBER path (probe: `.zai`, not `.zai.extra`).
fn validate_family_selection(collector: &mut Collector, input: &Value, path: &str) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "object", Some(input));
        return None;
    };
    let mut unknown: Vec<String> = Vec::new();
    let kind = match object.get("kind").and_then(Value::as_str) {
        Some("start-plan") | Some("individual-coding-plan") => {
            for key in object.keys() {
                if key != "kind" {
                    unknown.push(key.clone());
                }
            }
            "single"
        }
        Some("team-coding-plan") => {
            for key in object.keys() {
                if key != "kind" && !["productId", "organizationId", "projectId"].contains(&key.as_str()) {
                    unknown.push(key.clone());
                }
            }
            "team"
        }
        _ => {
            collector.issue(
                field_path(path, "kind"),
                discriminator_message(&SELECTION_KINDS),
            );
            return None;
        }
    };
    if !unknown.is_empty() {
        collector.issue(path.to_string(), unrecognized_keys(&unknown));
        return None;
    }
    let mut out = Map::new();
    out.insert("kind".to_string(), object["kind"].clone());
    if kind == "team" {
        let mut ok = true;
        for key in ["productId", "organizationId", "projectId"] {
            let issue_path = field_path(path, key);
            match object.get(key) {
                None => {
                    collector.type_issue(&issue_path, "string", None);
                    ok = false;
                }
                Some(value) => match non_empty_string(value) {
                    Ok(text) => {
                        out.insert(key.to_string(), Value::String(text));
                    }
                    Err(mut issue) => {
                        issue.path = issue_path;
                        collector.issues.push(issue);
                        ok = false;
                    }
                },
            }
        }
        if !ok {
            return None;
        }
    }
    Some(Value::Object(out))
}

fn validate_family_connection_selections(
    collector: &mut Collector,
    input: &Value,
    path: &str,
) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "object", Some(input));
        return None;
    };
    let mut out = Map::new();
    for family in FAMILY_DOMAINS {
        let Some(value) = object.get(family) else {
            continue;
        };
        let member_path = field_path(path, family);
        if let Some(validated) = validate_family_selection(collector, value, &member_path) {
            out.insert(family.to_string(), validated);
        }
    }
    // `.partial()` on the outer object — unknown families are stripped (probe:
    // `{ warp: … }` succeeds).
    Some(Value::Object(out))
}

fn validate_post_update_notes(collector: &mut Collector, input: &Value, path: &str) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "object", Some(input));
        return None;
    };
    let mut out = Map::new();
    let mut ok = true;
    for key in ["version", "title", "markdown"] {
        let issue_path = field_path(path, key);
        match object.get(key) {
            None => {
                collector.type_issue(&issue_path, "string", None);
                ok = false;
            }
            Some(value) => match non_empty_string(value) {
                Ok(text) => {
                    out.insert(key.to_string(), Value::String(text));
                }
                Err(mut issue) => {
                    issue.path = issue_path;
                    collector.issues.push(issue);
                    ok = false;
                }
            },
        }
    }
    match object.get("releaseDate") {
        None => {}
        Some(value) => {
            let issue_path = field_path(path, "releaseDate");
            match non_empty_string(value) {
                Ok(text) => {
                    out.insert("releaseDate".to_string(), Value::String(text));
                }
                Err(mut issue) => {
                    issue.path = issue_path;
                    collector.issues.push(issue);
                    ok = false;
                }
            }
        }
    }
    if let Some(by_locale) = object.get("releaseNotesByLocale") {
        let issue_path = field_path(path, "releaseNotesByLocale");
        match as_record(by_locale) {
            None => {
                collector.type_issue(&issue_path, "object", Some(by_locale));
                ok = false;
            }
            Some(by_locale_object) => {
                let unknown: Vec<String> = by_locale_object
                    .keys()
                    .filter(|key| *key != "en-US")
                    .cloned()
                    .collect();
                let mut locale_out = Map::new();
                let mut locale_ok = true;
                if !unknown.is_empty() {
                    collector.issue(issue_path.clone(), unrecognized_keys(&unknown));
                    ok = false;
                    locale_ok = false;
                }
                if let Some(entry) = by_locale_object.get("en-US") {
                    match as_record(entry) {
                        None => {
                            collector.type_issue(&field_path(&issue_path, "en-US"), "object", Some(entry));
                            ok = false;
                            locale_ok = false;
                        }
                        Some(entry_object) => {
                            let mut entry_ok = true;
                            let mut entry_out = Map::new();
                            for key in ["title", "markdown"] {
                                let entry_path = field_path(&field_path(&issue_path, "en-US"), key);
                                match entry_object.get(key) {
                                    None => {
                                        collector.type_issue(&entry_path, "string", None);
                                        entry_ok = false;
                                    }
                                    Some(value) => match non_empty_string(value) {
                                        Ok(text) => {
                                            entry_out.insert(key.to_string(), Value::String(text));
                                        }
                                        Err(mut issue) => {
                                            issue.path = entry_path;
                                            collector.issues.push(issue);
                                            entry_ok = false;
                                        }
                                    },
                                }
                            }
                            if entry_ok {
                                locale_out.insert("en-US".to_string(), Value::Object(entry_out));
                            } else {
                                ok = false;
                                locale_ok = false;
                            }
                        }
                    }
                }
                if locale_ok {
                    out.insert("releaseNotesByLocale".to_string(), Value::Object(locale_out));
                }
            }
        }
    }
    if ok {
        Some(Value::Object(out))
    } else {
        None
    }
}


// ---------------------------------------------------------------------------
// Remaining field validators
// ---------------------------------------------------------------------------

/// `z.record(key, value)` on a non-object: `expected record, received …`.
/// Valid keys keep insertion order; each bad value reports at `<path>.<key>`
/// (probe: `lastActiveTaskByWorkspace./a`).
fn validate_record_of(
    collector: &mut Collector,
    input: &Value,
    path: &str,
    value_kind: RecordValue,
) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "record", Some(input));
        return None;
    };
    let mut out = Map::new();
    let mut ok = true;
    for (key, value) in object {
        let issue_path = field_path(path, key);
        match value_kind {
            RecordValue::StringArray => match value.as_array() {
                None => {
                    collector.type_issue(&issue_path, "array", Some(value));
                    ok = false;
                }
                Some(entries) => {
                    let mut validated = Vec::new();
                    for (index, entry) in entries.iter().enumerate() {
                        match entry.as_str() {
                            Some(text) => validated.push(Value::String(text.to_string())),
                            None => {
                                collector.type_issue(
                                    &format!("{issue_path}.{index}"),
                                    "string",
                                    Some(entry),
                                );
                                ok = false;
                            }
                        }
                    }
                    out.insert(key.clone(), Value::Array(validated));
                }
            },
            RecordValue::String => match value.as_str() {
                Some(text) => {
                    out.insert(key.clone(), Value::String(text.to_string()));
                }
                None => {
                    collector.type_issue(&issue_path, "string", Some(value));
                    ok = false;
                }
            },
        }
    }
    let _ = ok;
    Some(Value::Object(out))
}

enum RecordValue {
    StringArray,
    String,
}

/// `partialRecord(enum keys, value)` — one `unrecognized_keys` issue listing
/// every unknown key, then the known values (probe: `"nightly", "beta"`).
fn validate_partial_record(
    collector: &mut Collector,
    input: &Value,
    path: &str,
    allowed_keys: &[&'static str],
) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "record", Some(input));
        return None;
    };
    let unknown: Vec<String> = object
        .keys()
        .filter(|key| !allowed_keys.contains(&key.as_str()))
        .cloned()
        .collect();
    let mut out = Map::new();
    let mut ok = true;
    if !unknown.is_empty() {
        collector.issue(path.to_string(), unrecognized_keys(&unknown));
        ok = false;
    }
    for key in allowed_keys {
        let Some(value) = object.get(*key) else {
            continue;
        };
        let issue_path = field_path(path, key);
        match non_empty_string(value) {
            Ok(text) => {
                out.insert(key.to_string(), Value::String(text));
            }
            Err(mut issue) => {
                issue.path = issue_path;
                collector.issues.push(issue);
                ok = false;
            }
        }
    }
    if ok {
        Some(Value::Object(out))
    } else {
        None
    }
}

/// `desktopWindowSizeSchema` — non-strict (the sanitiser only keeps it when
/// valid; the output is shaped by this validator).
fn validate_desktop_window_size(collector: &mut Collector, input: &Value, path: &str) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "object", Some(input));
        return None;
    };
    let mut out = Map::new();
    let mut ok = true;
    for (key, min) in [("width", 480i64), ("height", 640i64)] {
        let issue_path = field_path(path, key);
        match object.get(key) {
            None => {
                collector.type_issue(&issue_path, "number", None);
                ok = false;
            }
            Some(value) => {
                if !check_int(collector.issues, &issue_path, value, Some((min, ">=")), None) {
                    ok = false;
                } else {
                    out.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    let maximized_path = field_path(path, "maximized");
    match object.get("maximized") {
        None => {
            collector.type_issue(&maximized_path, "boolean", None);
            ok = false;
        }
        Some(Value::Bool(flag)) => {
            out.insert("maximized".to_string(), Value::Bool(*flag));
        }
        Some(value) => {
            collector.type_issue(&maximized_path, "boolean", Some(value));
            ok = false;
        }
    }
    if ok {
        Some(Value::Object(out))
    } else {
        None
    }
}

/// `embeddedBrowserViewportPreferenceSchema` — `.strict()`: an unknown inner
/// key reports ONE issue at the object path (probe), then the fields.
fn validate_viewport_preference(collector: &mut Collector, input: &Value, path: &str) -> Option<Value> {
    let Some(object) = as_record(input) else {
        collector.type_issue(path, "object", Some(input));
        return None;
    };
    let mut out = Map::new();
    let mut ok = true;
    let unknown: Vec<String> = object
        .keys()
        .filter(|key| !["mode", "viewport", "zoom"].contains(&key.as_str()))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        collector.issue(path.to_string(), unrecognized_keys(&unknown));
        ok = false;
    }
    let mode_path = field_path(path, "mode");
    match object.get("mode") {
        None => {
            collector.issue(mode_path, enum_message(&VIEWPORT_MODES));
            ok = false;
        }
        Some(value) => {
            if check_enum(collector.issues, &mode_path, value, &VIEWPORT_MODES) {
                out.insert("mode".to_string(), value.clone());
            } else {
                ok = false;
            }
        }
    }
    let viewport_path = field_path(path, "viewport");
    match object.get("viewport") {
        None => {
            collector.type_issue(&viewport_path, "object", None);
            ok = false;
        }
        Some(viewport) => match as_record(viewport) {
            None => {
                collector.type_issue(&viewport_path, "object", Some(viewport));
                ok = false;
            }
            Some(viewport_object) => {
                let mut viewport_out = Map::new();
                let mut viewport_ok = true;
                let viewport_unknown: Vec<String> = viewport_object
                    .keys()
                    .filter(|key| !["width", "height"].contains(&key.as_str()))
                    .cloned()
                    .collect();
                if !viewport_unknown.is_empty() {
                    collector.issue(viewport_path.clone(), unrecognized_keys(&viewport_unknown));
                    viewport_ok = false;
                    ok = false;
                }
                for (key, max) in [("width", 3840i64), ("height", 2160i64)] {
                    let issue_path = field_path(&viewport_path, key);
                    match viewport_object.get(key) {
                        None => {
                            collector.type_issue(&issue_path, "number", None);
                            viewport_ok = false;
                            ok = false;
                        }
                        Some(value) => {
                            if !check_int(
                                collector.issues,
                                &issue_path,
                                value,
                                Some((320, ">=")),
                                Some((max, "<=")),
                            ) {
                                viewport_ok = false;
                                ok = false;
                            } else {
                                viewport_out.insert(key.to_string(), value.clone());
                            }
                        }
                    }
                }
                if viewport_ok {
                    out.insert("viewport".to_string(), Value::Object(viewport_out));
                }
            }
        },
    }
    let zoom_path = field_path(path, "zoom");
    match object.get("zoom") {
        None => {
            collector.issue(zoom_path, enum_message(&VIEWPORT_ZOOMS));
            ok = false;
        }
        Some(value) => {
            if check_enum(collector.issues, &zoom_path, value, &VIEWPORT_ZOOMS) {
                out.insert("zoom".to_string(), value.clone());
            } else {
                ok = false;
            }
        }
    }
    if ok {
        // shape order: mode, viewport, zoom
        let mut shaped = Map::new();
        for key in ["mode", "viewport", "zoom"] {
            shaped.insert(key.to_string(), out.remove(key).expect("present"));
        }
        Some(Value::Object(shaped))
    } else {
        None
    }
}

fn validate_session_array(collector: &mut Collector, input: &Value, path: &str) -> Option<Value> {
    let Some(entries) = input.as_array() else {
        collector.type_issue(path, "array", Some(input));
        return None;
    };
    let mut out = Vec::new();
    let mut ok = true;
    for (index, entry) in entries.iter().enumerate() {
        let entry_path = format!("{path}.{index}");
        match validate_session_entry(collector, entry, &entry_path) {
            Some(validated) => out.push(validated),
            None => ok = false,
        }
    }
    if ok {
        Some(Value::Array(out))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// The object schemas (shape order)
// ---------------------------------------------------------------------------

fn validate_settings_object(
    collector: &mut Collector,
    input: &Map<String, Value>,
) -> Map<String, Value> {
    let mut out = Map::new();
    let prefix = "";
    let mode = collector.mode;

    // recentProjects: z.array(z.string()).default([])
    match input.get("recentProjects") {
        None => {
            if mode == Mode::Read {
                out.insert("recentProjects".to_string(), Value::Array(Vec::new()));
            }
        }
        Some(Value::Array(entries)) => {
            let mut validated = Vec::new();
            let mut ok = true;
            for (index, entry) in entries.iter().enumerate() {
                match entry.as_str() {
                    Some(text) => validated.push(Value::String(text.to_string())),
                    None => {
                        collector.type_issue(&format!("recentProjects.{index}"), "string", Some(entry));
                        ok = false;
                    }
                }
            }
            out.insert("recentProjects".to_string(), Value::Array(validated));
        }
        Some(value) => collector.type_issue("recentProjects", "array", Some(value)),
    }

    // shortcutBindings: z.record(z.string(), z.array(z.string())).optional()
    if let Some(value) = input.get("shortcutBindings") {
        if let Some(validated) = validate_record_of(collector, value, "shortcutBindings", RecordValue::StringArray)
        {
            out.insert("shortcutBindings".to_string(), validated);
        }
    }

    // Booleans-with-defaults and optionals, in shape order.
    macro_rules! bool_default {
        ($key:literal, $default:expr) => {
            collector.bool_default(&mut out, input, prefix, $key, $default)
        };
    }
    macro_rules! bool_opt {
        ($key:literal) => {
            collector.bool_optional(&mut out, input, prefix, $key)
        };
    }
    macro_rules! nonempty_opt {
        ($key:literal) => {
            collector.string_field(&mut out, input, prefix, $key, None, true)
        };
    }

    bool_default!("terminalInheritSystemProfile", true);
    nonempty_opt!("terminalFontFamily");

    if let Some(value) = input.get("integratedTerminalShell") {
        if let Some(validated) =
            validate_integrated_terminal_shell(collector, value, "integratedTerminalShell")
        {
            out.insert("integratedTerminalShell".to_string(), validated);
        }
    }
    nonempty_opt!("httpProxy");
    nonempty_opt!("httpProxyNoProxy");
    nonempty_opt!("httpProxyCaCertPath");
    bool_default!("embeddedBrowserAllowInsecureCertificates", false);

    // embeddedBrowserViewportPreference: strict object, defaulted on read.
    match input.get("embeddedBrowserViewportPreference") {
        None => {
            if mode == Mode::Read {
                out.insert(
                    "embeddedBrowserViewportPreference".to_string(),
                    serde_json::json!({
                        "mode": "normal",
                        "viewport": { "width": 393, "height": 852 },
                        "zoom": "fit",
                    }),
                );
            }
        }
        Some(value) => {
            if let Some(validated) = validate_viewport_preference(collector, value, "embeddedBrowserViewportPreference")
            {
                out.insert("embeddedBrowserViewportPreference".to_string(), validated);
            }
        }
    }

    bool_default!("computerUseComposerEntryHidden", true);
    bool_default!("taskAutoArchiveEnabled", false);
    collector.int_optional(&mut out, input, prefix, "taskAutoArchiveOlderThanDays", Some((0, ">")), Some((365, "<=")), Some(7));
    bool_default!("closeToTrayOnWindows", true);
    bool_default!("closeToTrayOnWindowsMigrationInitialized", true);
    bool_default!("keepAwakeWhileRunning", false);
    collector.int_optional(&mut out, input, prefix, "desktopZoomLevel", Some((-3, ">=")), Some((5, "<=")), None);

    if let Some(value) = input.get("desktopWindowSize") {
        if let Some(validated) = validate_desktop_window_size(collector, value, "desktopWindowSize") {
            out.insert("desktopWindowSize".to_string(), validated);
        }
    }

    bool_default!("desktopChromiumHardwareAccelerationEnabled", true);
    bool_default!("messageStreamShowReasoning", true);
    bool_default!("messageStreamShowReasoningMigrationInitialized", true);
    bool_default!("messageStreamShowTodos", false);
    bool_default!("toolGroupingExploreEnabled", true);
    bool_default!("toolGroupingTerminalEnabled", true);
    bool_default!("toolGroupingChangesEnabled", false);
    collector.enum_optional(&mut out, input, prefix, "zcodeInteractionBehavior", &INTERACTION_BEHAVIORS, Some("queue"), false);
    bool_default!("askUserQuestionAutoResolutionEnabled", true);
    bool_default!("modelIoFullRetentionEnabled", false);
    bool_default!("startPlanRecommendationDismissed", false);

    // providerFamilyConnectionSelections: partial object, default {}
    match input.get("providerFamilyConnectionSelections") {
        None => {
            if mode == Mode::Read {
                out.insert("providerFamilyConnectionSelections".to_string(), Value::Object(Map::new()));
            }
        }
        Some(value) => {
            if let Some(validated) =
                validate_family_connection_selections(collector, value, "providerFamilyConnectionSelections")
            {
                out.insert("providerFamilyConnectionSelections".to_string(), validated);
            }
        }
    }

    // providerFamilyDomain: enum (Read) / union(enum, "") (Patch — T41)
    match input.get("providerFamilyDomain") {
        None => {}
        Some(value) => {
            let path = "providerFamilyDomain";
            if mode == Mode::Patch {
                let text_ok = value.as_str().is_some_and(|text| FAMILY_DOMAINS.contains(&text));
                let empty_ok = value.as_str() == Some("");
                if text_ok || empty_ok {
                    out.insert(path.to_string(), value.clone());
                } else {
                    // zod's non-discriminated union: one top-level issue with
                    // message "Invalid input" (the leaves live in `errors`,
                    // which the wire type does not carry — §3.4).
                    collector.issue(path.to_string(), "Invalid input".to_string());
                }
            } else if check_enum(collector.issues, path, value, &FAMILY_DOMAINS) {
                out.insert(path.to_string(), value.clone());
            }
        }
    }

    collector.int_optional(&mut out, input, prefix, "providerFamilyDomainUpdatedAt", Some((0, ">=")), None, None);
    bool_default!("providerFamilyDomainMigrated", false);
    bool_default!("nativeSearchEnhancementsEnabled", true);
    collector.enum_optional(&mut out, input, prefix, "onboardingOccupation", &OCCUPATIONS, None, true);
    bool_opt!("proactiveSuggestionsEnabled");

    if let Some(value) = input.get("lastWorkspaceSession") {
        if let Some(validated) = validate_session_array(collector, value, "lastWorkspaceSession") {
            out.insert("lastWorkspaceSession".to_string(), validated);
        }
    } else if mode == Mode::Read {
        out.insert("lastWorkspaceSession".to_string(), Value::Array(Vec::new()));
    }

    collector.int_optional(&mut out, input, prefix, "lastActiveTabIndex", Some((0, ">=")), None, Some(0));

    if let Some(value) = input.get("lastActiveTaskByWorkspace") {
        if let Some(validated) =
            validate_record_of(collector, value, "lastActiveTaskByWorkspace", RecordValue::String)
        {
            out.insert("lastActiveTaskByWorkspace".to_string(), validated);
        }
    }

    nonempty_opt!("dataBaseDir");

    if let Some(value) = input.get("pendingPostUpdateReleaseNotes") {
        if let Some(validated) =
            validate_post_update_notes(collector, value, "pendingPostUpdateReleaseNotes")
        {
            out.insert("pendingPostUpdateReleaseNotes".to_string(), validated);
        }
    }

    bool_default!("receivePreviewUpdates", false);
    bool_default!("autoDownloadAndInstallUpdates", false);

    match input.get("skippedElectronUpdateVersions") {
        None => {
            if mode == Mode::Read {
                out.insert("skippedElectronUpdateVersions".to_string(), Value::Object(Map::new()));
            }
        }
        Some(value) => {
            if let Some(validated) =
                validate_partial_record(collector, value, "skippedElectronUpdateVersions", &ELECTRON_CHANNELS)
            {
                out.insert("skippedElectronUpdateVersions".to_string(), validated);
            }
        }
    }

    bool_opt!("settingsSyncFirstRunPromptHandled");

    // zcodeEndpointOrigin: after the field-level preprocess the value is a
    // normalised origin or absent; a value that fails normalisation DROPS the
    // key (the predecessor's `undefined` — the JSON form of "cleared").
    match input.get("zcodeEndpointOrigin") {
        None => {}
        Some(value) => match value.as_str().and_then(|text| normalize_endpoint_origin(text).ok()) {
            Some(origin) => {
                out.insert("zcodeEndpointOrigin".to_string(), Value::String(origin));
            }
            None => {}
        },
    }

    out
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// `appSettingsSchema` over file text — the host's read boundary (§3.4).
pub fn parse_settings_content(content: &str) -> SettingsParseResult {
    let raw: Value = match serde_json::from_str(content) {
        Ok(value) => value,
        Err(_) => return SettingsParseResult::invalid_json(),
    };
    // The predicate reads the RAW value: an injected migration tag must not
    // hide its own migration (T31/T33).
    let needs_migration_persist = needs_migration_persist(&raw);
    if !raw.is_object() {
        return SettingsParseResult::schema_invalid(vec![invalid_type(
            "",
            "object",
            Some(&raw),
        )]);
    }
    let preprocessed = preprocess(raw);
    let object = as_record(&preprocessed).expect("object").clone();
    let mut issues = Vec::new();
    let mut collector = Collector {
        issues: &mut issues,
        mode: Mode::Read,
    };
    let out = validate_settings_object(&mut collector, &object);
    drop(collector);
    if !issues.is_empty() {
        return SettingsParseResult::schema_invalid(issues);
    }
    SettingsParseResult {
        status: "ok",
        settings: Some(Value::Object(out)),
        needs_migration_persist,
        issues,
    }
}

/// `appSettingsPatchSchema` — strip mode (unknown keys dropped, T40), the
/// widened `providerFamilyDomain` union (T41), and no preprocess: a bad
/// nested value is rejected here rather than deleted (T40's counterpart).
/// The returned object omits keys the predecessor parsed as `undefined`,
/// which is its JSON spelling of "cleared".
pub fn parse_settings_patch(patch: &Value) -> Result<Value, Vec<SettingsIssue>> {
    let Some(object) = as_record(patch) else {
        return Err(vec![invalid_type("", "object", Some(patch))]);
    };
    let mut issues = Vec::new();
    let mut collector = Collector {
        issues: &mut issues,
        mode: Mode::Patch,
    };
    let out = validate_settings_object(&mut collector, object);
    drop(collector);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(content: Value) -> SettingsParseResult {
        parse_settings_content(&content.to_string())
    }

    fn issues_of(content: Value) -> Vec<(String, String)> {
        parse_settings_content(&content.to_string())
            .issues
            .into_iter()
            .map(|issue| (issue.path, issue.message))
            .collect()
    }

    #[test]
    fn t26_invalid_json_is_the_invalid_json_status() {
        let result = parse_settings_content("{ not json");
        assert_eq!(result.status, "invalid-json");
        assert!(result.settings.is_none());
        assert!(!result.needs_migration_persist);
    }

    #[test]
    fn t27_a_scalar_is_schema_invalid_with_a_root_issue() {
        for (value, received) in [
            (json_scalar("5"), "number"),
            (json_scalar("[1,2]"), "array"),
            (json_scalar("null"), "null"),
            (json_scalar("\"x\""), "string"),
        ] {
            let result = parse_settings_content(&value);
            assert_eq!(result.status, "schema-invalid", "{value}");
            assert_eq!(
                result.issues,
                vec![SettingsIssue {
                    path: String::new(),
                    message: format!("Invalid input: expected object, received {received}"),
                }],
                "{value}"
            );
        }
    }

    fn json_scalar(text: &str) -> String {
        text.to_string()
    }

    #[test]
    fn t28_unknown_keys_are_stripped_not_rejected() {
        let result = ok(serde_json::json!({ "totallyUnknown": 1, "keepAwakeWhileRunning": false }));
        assert_eq!(result.status, "ok");
        let settings = result.settings.unwrap();
        assert!(settings.get("totallyUnknown").is_none());
        assert_eq!(settings["keepAwakeWhileRunning"], serde_json::json!(false));
        assert_eq!(settings["terminalInheritSystemProfile"], serde_json::json!(true), "default");
    }

    #[test]
    fn t29_a_broken_window_size_is_deleted_and_the_rest_validates() {
        for content in [
            serde_json::json!({ "desktopWindowSize": "big" }),
            serde_json::json!({ "desktopWindowSize": { "width": 479, "height": 640, "maximized": false } }),
            serde_json::json!({ "desktopWindowSize": { "width": 480.5, "height": 640, "maximized": false } }),
            serde_json::json!({ "desktopWindowSize": { "width": 800, "height": 700 } }),
        ] {
            let result = ok(content.clone());
            assert_eq!(result.status, "ok", "{content}");
            assert!(
                result.settings.unwrap().get("desktopWindowSize").is_none(),
                "deleted: {content}"
            );
        }
        // A valid size survives (and inner unknown keys are stripped).
        let result = ok(serde_json::json!({ "desktopWindowSize": { "width": 800, "height": 700, "maximized": true, "extra": 1 } }));
        assert_eq!(
            result.settings.unwrap()["desktopWindowSize"],
            serde_json::json!({ "width": 800, "height": 700, "maximized": true })
        );
    }

    #[test]
    fn t30_bad_endpoints_are_deleted_and_valid_ones_normalise() {
        for origin in ["", "   ", "ftp://x", "not a url", "zcode.z.ai"] {
            let result = ok(serde_json::json!({ "zcodeEndpointOrigin": origin }));
            assert_eq!(result.status, "ok", "{origin}");
            assert!(
                result.settings.unwrap().get("zcodeEndpointOrigin").is_none(),
                "deleted: {origin}"
            );
        }
        let result = ok(serde_json::json!({ "zcodeEndpointOrigin": "https://zcode.z.ai:8443/ignored/path" }));
        assert_eq!(
            result.settings.unwrap()["zcodeEndpointOrigin"],
            serde_json::json!("https://zcode.z.ai:8443"),
            "origin keeps the port, drops the path"
        );
    }

    #[test]
    fn t31_missing_tray_tag_injects_the_pair_and_needs_persist() {
        let result = ok(serde_json::json!({ "closeToTrayOnWindows": false }));
        assert!(result.needs_migration_persist, "T31");
        let settings = result.settings.unwrap();
        assert_eq!(settings["closeToTrayOnWindows"], serde_json::json!(true));
        assert_eq!(settings["closeToTrayOnWindowsMigrationInitialized"], serde_json::json!(true));
    }

    #[test]
    fn t32_missing_reasoning_tag_injects_the_pair() {
        let result = ok(serde_json::json!({ "messageStreamShowReasoning": false }));
        assert!(result.needs_migration_persist, "T32");
        let settings = result.settings.unwrap();
        assert_eq!(settings["messageStreamShowReasoning"], serde_json::json!(true));
        assert_eq!(settings["messageStreamShowReasoningMigrationInitialized"], serde_json::json!(true));
    }

    #[test]
    fn t33_both_tags_present_never_persists() {
        let result = ok(serde_json::json!({
            "closeToTrayOnWindowsMigrationInitialized": true,
            "messageStreamShowReasoningMigrationInitialized": true
        }));
        assert!(!result.needs_migration_persist, "T33");
    }

    #[test]
    fn t34_pending_team_blocks_but_a_complete_team_still_needs_the_tags() {
        // Pending team (1 part) → legacy clause false, tags missing → persist.
        let result = ok(serde_json::json!({
            "closeToTrayOnWindowsMigrationInitialized": true,
            "messageStreamShowReasoningMigrationInitialized": true,
            "modelProviderFamilySelectedKeys": { "zai": "team-plan:builtin:zai-coding-plan:prod:proj" }
        }));
        assert!(
            !result.needs_migration_persist,
            "T34 a PARSED (product+project, no org) team blocks the eager rewrite: {:#?}",
            result.issues
        );
        // …and a COMPLETE team with the tags set reads as a connection.
        let complete = ok(serde_json::json!({
            "closeToTrayOnWindowsMigrationInitialized": true,
            "messageStreamShowReasoningMigrationInitialized": true,
            "modelProviderFamilyModes": { "zai": "team" },
            "modelProviderFamilySelectedKeys": { "zai": "team-plan:builtin:zai-coding-plan:prod:proj" }
        }));
        assert!(!complete.needs_migration_persist);
        // The legacy clause fires only when the team parses clean (0 parts) —
        // covered by settings_persist::tests.
    }

    #[test]
    fn messages_match_zod_v4_shape() {
        // The exact strings were captured from the live schema (§5 probes).
        assert_eq!(
            issues_of(serde_json::json!({ "terminalInheritSystemProfile": "yes" })),
            vec![(
                "terminalInheritSystemProfile".to_string(),
                "Invalid input: expected boolean, received string".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "lastActiveTabIndex": 1.5 })),
            vec![(
                "lastActiveTabIndex".to_string(),
                "Invalid input: expected int, received number".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "providerFamilyDomain": "warp" })),
            vec![(
                "providerFamilyDomain".to_string(),
                "Invalid option: expected one of \"zai\"|\"bigmodel\"".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "taskAutoArchiveOlderThanDays": 0.5 })),
            vec![(
                "taskAutoArchiveOlderThanDays".to_string(),
                "Invalid input: expected int, received number".to_string()
            )],
            "intness failure suppresses the range issues"
        );
        assert_eq!(
            issues_of(serde_json::json!({ "taskAutoArchiveOlderThanDays": 0 })),
            vec![(
                "taskAutoArchiveOlderThanDays".to_string(),
                "Too small: expected number to be >0".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "desktopZoomLevel": 9 })),
            vec![(
                "desktopZoomLevel".to_string(),
                "Too big: expected number to be <=5".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "terminalFontFamily": "   " })),
            vec![(
                "terminalFontFamily".to_string(),
                "Too small: expected string to have >=1 characters".to_string()
            )]
        );
    }

    #[test]
    fn discriminators_report_at_the_discriminator_path() {
        assert_eq!(
            issues_of(serde_json::json!({ "lastWorkspaceSession": [{ "kind": "weird" }] })),
            vec![(
                "lastWorkspaceSession.0.kind".to_string(),
                "Invalid discriminator value. Expected 'local' | 'remote'".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "integratedTerminalShell": {} })),
            vec![(
                "integratedTerminalShell.mode".to_string(),
                "Invalid discriminator value. Expected 'auto' | 'shell'".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "providerFamilyConnectionSelections": { "zai": {} } })),
            vec![(
                "providerFamilyConnectionSelections.zai.kind".to_string(),
                "Invalid discriminator value. Expected 'start-plan' | 'individual-coding-plan' | 'team-coding-plan'".to_string()
            )]
        );
    }

    #[test]
    fn shell_member_collects_every_missing_field_in_shape_order() {
        assert_eq!(
            issues_of(serde_json::json!({ "integratedTerminalShell": { "mode": "shell" } })),
            vec![
                ("integratedTerminalShell.dialect".to_string(), "Invalid option: expected one of \"cmd\"|\"git-bash\"".to_string()),
                ("integratedTerminalShell.id".to_string(), "Invalid input: expected string, received undefined".to_string()),
                ("integratedTerminalShell.label".to_string(), "Invalid input: expected string, received undefined".to_string()),
                ("integratedTerminalShell.path".to_string(), "Invalid input: expected string, received undefined".to_string()),
            ]
        );
    }

    #[test]
    fn issues_follow_the_schema_shape_order_not_the_input_order() {
        let reversed = issues_of(serde_json::json!({
            "lastWorkspaceSession": [{
                "kind": "remote", "workspacePath": "/x",
                "target": { "kind": "ssh", "host": "h", "username": "u", "sshConfigAlias": "a" },
                "lastConnectionStatus": "maybe", "lastOpenedAt": -1
            }]
        }));
        assert_eq!(
            reversed,
            vec![
                ("lastWorkspaceSession.0.lastOpenedAt".to_string(), "Too small: expected number to be >=0".to_string()),
                ("lastWorkspaceSession.0.lastConnectionStatus".to_string(), "Invalid option: expected one of \"connected\"|\"failed\"".to_string()),
            ]
        );
        let mixed = issues_of(serde_json::json!({
            "terminalInheritSystemProfile": "x",
            "taskAutoArchiveOlderThanDays": 0,
            "desktopZoomLevel": 9,
            "providerFamilyDomain": "warp",
        }));
        assert_eq!(
            mixed.iter().map(|(path, _)| path.as_str()).collect::<Vec<_>>(),
            vec!["terminalInheritSystemProfile", "taskAutoArchiveOlderThanDays", "desktopZoomLevel", "providerFamilyDomain"],
            "shape order"
        );
    }

    #[test]
    fn record_and_partial_record_shapes() {
        assert_eq!(
            issues_of(serde_json::json!({ "lastActiveTaskByWorkspace": 5 })),
            vec![(
                "lastActiveTaskByWorkspace".to_string(),
                "Invalid input: expected record, received number".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "lastActiveTaskByWorkspace": { "/a": 5 } })),
            vec![(
                "lastActiveTaskByWorkspace./a".to_string(),
                "Invalid input: expected string, received number".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "skippedElectronUpdateVersions": { "nightly": "1", "beta": "2" } })),
            vec![(
                "skippedElectronUpdateVersions".to_string(),
                "Unrecognized keys: \"nightly\", \"beta\"".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "skippedElectronUpdateVersions": { "stable": "" } })),
            vec![(
                "skippedElectronUpdateVersions.stable".to_string(),
                "Too small: expected string to have >=1 characters".to_string()
            )]
        );
        assert_eq!(
            issues_of(serde_json::json!({ "pendingPostUpdateReleaseNotes": { "releaseNotesByLocale": { "fr-FR": { "title": "x", "markdown": "y" } }, "version": "1", "title": "t", "markdown": "m" } })),
            vec![(
                "pendingPostUpdateReleaseNotes.releaseNotesByLocale".to_string(),
                "Unrecognized key: \"fr-FR\"".to_string()
            )]
        );
    }

    #[test]
    fn mixed_valid_full_input_matches_the_success_shape() {
        let result = ok(serde_json::json!({
            "recentProjects": ["/a"], "terminalInheritSystemProfile": false, "desktopZoomLevel": 2,
            "desktopWindowSize": { "width": 1200, "height": 800, "maximized": false },
            "zcodeEndpointOrigin": "https://zcode.z.ai:8443/ignored/path",
            "closeToTrayOnWindows": false, "closeToTrayOnWindowsMigrationInitialized": false,
            "messageStreamShowReasoning": false, "messageStreamShowReasoningMigrationInitialized": false,
            "providerFamilyDomain": "zai", "lastActiveTabIndex": 3,
            "dataBaseDir": "/data", "taskAutoArchiveOlderThanDays": 30,
            "lastWorkspaceSession": [{ "kind": "remote", "workspacePath": "/r",
                "target": { "kind": "ssh", "host": "h", "username": "u", "sshConfigAlias": "a", "assetInstallMode": "remote-download" },
                "lastOpenedAt": 5, "lastConnectionStatus": "failed", "lastConnectionError": "x" }]
        }));
        assert_eq!(result.status, "ok");
        assert!(
            result.needs_migration_persist,
            "the probe fixture carries tag=false, so the eager rewrite fires"
        );
        let settings = result.settings.unwrap();
        assert_eq!(settings["zcodeEndpointOrigin"], serde_json::json!("https://zcode.z.ai:8443"));
        assert_eq!(settings["closeToTrayOnWindows"], serde_json::json!(true), "migration injects over the input false");
        assert_eq!(settings["dataBaseDir"], serde_json::json!("/data"), "trimmed output");
        assert_eq!(settings["desktopWindowSize"]["width"], serde_json::json!(1200));
        assert_eq!(settings["lastWorkspaceSession"][0]["target"]["assetInstallMode"], serde_json::json!("remote-download"));
        // Shape order of the output: recentProjects first, providerFamilyDomain far in.
        let keys = settings.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        let first = keys.iter().position(|key| key == "recentProjects").unwrap();
        let second = keys.iter().position(|key| key == "providerFamilyDomain").unwrap();
        assert!(first < second, "shape order");
    }

    #[test]
    fn patch_mode_strips_unknown_and_widens_the_domain_union() {
        let patch = serde_json::json!({ "unknownKey": 1 });
        let validated = parse_settings_patch(&patch).expect("patch parses");
        assert!(validated.get("unknownKey").is_none(), "T40 stripped");

        let patch = serde_json::json!({ "providerFamilyDomain": "" });
        let validated = parse_settings_patch(&patch).expect("T41 accepted");
        assert_eq!(validated["providerFamilyDomain"], serde_json::json!(""));

        let patch = serde_json::json!({ "providerFamilyDomain": "  zai  " });
        let errors = parse_settings_patch(&patch).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].path, "providerFamilyDomain");
        assert_eq!(errors[0].message, "Invalid input");

        let patch = serde_json::json!({ "lastActiveTabIndex": "3" });
        let errors = parse_settings_patch(&patch).unwrap_err();
        assert_eq!(errors[0].message, "Invalid input: expected number, received string");
    }

    #[test]
    fn patch_rejects_what_read_sanitises() {
        // The patch path has NO preprocess: a small window is an error here
        // while the read path deletes the field (the T29/T40 pair).
        let patch = serde_json::json!({ "desktopWindowSize": { "width": 479, "height": 700, "maximized": false } });
        let errors = parse_settings_patch(&patch).unwrap_err();
        assert_eq!(errors[0].path, "desktopWindowSize.width");
        assert_eq!(errors[0].message, "Too small: expected number to be >=480");

        // …and the strict viewport object reports its unknown key at the
        // object path (probe: patch-viewport-unknown).
        let patch = serde_json::json!({ "embeddedBrowserViewportPreference": {
            "mode": "normal", "viewport": { "width": 393, "height": 852 }, "zoom": "fit", "extra": 1
        } });
        let errors = parse_settings_patch(&patch).unwrap_err();
        assert_eq!(errors[0].path, "embeddedBrowserViewportPreference");
        assert_eq!(errors[0].message, "Unrecognized key: \"extra\"");
    }
}
