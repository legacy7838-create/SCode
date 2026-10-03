//! Workspace-hook compute: bundle snapshots, trust projection, event/config
//! assembly, the writable partition and the runtime root.
//!
//! Port of `packages/shared/src/workspace-hook-digest.ts`,
//! `packages/services/src/hooks/workspaceHookSettingsModel.ts`, and the pure
//! cores of `hooksService.ts`. Spec: `docs/specs/rust-native-config.md` §3.3,
//! rows T7–T11 and T48–T58.
//!
//! The four `shared/src/workspace-hook-*.ts` modules stay TypeScript (spec
//! §9.3 — renderer/CLI side); this module is the HOST's single implementation,
//! called only from `hooksService.ts`. File reads, the atomic write and the
//! discovery orchestration stay in TypeScript (§2.2).
//!
//! # Digest parity
//!
//! Both digests are `sha256(JSON.stringify(payload))` over payloads made ONLY
//! of arrays of scalars (no objects), so `serde_json`'s byte output matches
//! `JSON.stringify` for every value class these payloads carry: integers
//! (`Math.max(1, Math.round(x))` is applied before they land here), booleans,
//! `null`, and strings. The hooks' entry JSON mirrors the predecessor's
//! insertion order field-for-field, because the snapshot crosses the wire for
//! review UIs and byte order is part of "the same snapshot".

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const DIGEST_SCHEMA_VERSION: u64 = 1;
const DEFAULT_TIMEOUT_MS: f64 = 60_000.0;
const DEFAULT_MAX_OUTPUT_BYTES: f64 = 32_768.0;
const EVENTS: [&str; 7] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
];

fn sha256_hex(json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `Math.max(1, Math.round(x))`.
fn round_at_least_one(value: f64) -> f64 {
    value.round().max(1.0)
}

/// `path.resolve` semantics, sufficient for the two comparisons this module
/// makes against absolute config paths: absolutise (against the process cwd,
/// as TS does) and collapse `.` / `..`.
fn resolve_path(path: &str) -> std::path::PathBuf {
    let candidate = std::path::Path::new(path);
    let base = if candidate.is_absolute() {
        std::path::PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_default()
    };
    let mut out = base;
    for component in candidate.components() {
        use std::path::Component;
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn normalize_relative_source_path(workspace_path: &str, source_path: &str) -> String {
    let base = resolve_path(workspace_path);
    let target = resolve_path(source_path);
    let relative = pathdiff_simple(&base, &target);
    let normalized = relative.replace('\\', "/");
    if normalized.is_empty() {
        target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        normalized
    }
}

/// Minimal path difference: both inputs are already resolved absolutes.
fn pathdiff_simple(base: &std::path::Path, target: &std::path::Path) -> String {
    let base_components: Vec<_> = base.components().collect();
    let target_components: Vec<_> = target.components().collect();
    let shared = base_components
        .iter()
        .zip(target_components.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut out = std::path::PathBuf::new();
    for _ in shared..base_components.len() {
        out.push("..");
    }
    for component in &target_components[shared..] {
        out.push(component.as_os_str());
    }
    out.to_string_lossy().to_string()
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRootInput {
    pub enabled: bool,
    pub timeout_ms: f64,
    pub max_output_bytes: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHooksConfigInput {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub timeout_ms: Option<f64>,
    #[serde(default)]
    pub max_output_bytes: Option<f64>,
    #[serde(default)]
    pub events: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
    pub canonical_path: String,
    pub base_dir: String,
    pub discovery_order: u64,
    pub config_file_kind: String,
    pub explicit_project_config: bool,
    pub editable: bool,
    pub hooks: WorkspaceHooksConfigInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleSnapshotInput {
    pub workspace_identity: String,
    pub workspace_path: String,
    pub sources: Vec<SourceInput>,
    pub runtime_root: RuntimeRootInput,
    /// Injected by the caller (the TS `new Date().toISOString()` default lives
    /// in the wrapper): the sync native side owns no clock (§3.6).
    #[serde(default)]
    pub discovered_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionInput {
    pub sources: Vec<SourceInput>,
    pub snapshot: Option<Value>,
    pub workspace_identity: String,
    pub workspace_path: String,
    #[serde(default)]
    pub persistent_trusted_digests: Vec<String>,
}

// ---------------------------------------------------------------------------
// Gates, timeouts (T52–T57 helpers)
// ---------------------------------------------------------------------------

/// `resolveWorkspaceHookConfiguredGates`.
fn configured_gates(source_enabled: Option<bool>, declaration_enabled: Option<bool>, runtime_enabled: bool) -> Value {
    let source_root = source_enabled != Some(false);
    let declaration = declaration_enabled != Some(false);
    serde_json::json!({
        "sourceRootEnabled": source_root,
        "declarationEnabled": declaration,
        "runtimeHooksEnabled": runtime_enabled,
        "configuredEnabled": source_root && declaration && runtime_enabled,
    })
}

/// `resolveWorkspaceHookTimeoutMs`: `timeoutMs`, else a command's `timeout`
/// seconds, else the default — then `Math.max(1, Math.round(…))` (T57).
pub fn resolve_workspace_hook_timeout_ms(hook: &Map<String, Value>, default_timeout_ms: f64) -> f64 {
    let timeout_ms = hook
        .get("timeoutMs")
        .and_then(Value::as_f64)
        .or_else(|| {
            let command_timeout = hook.get("timeout").and_then(Value::as_f64);
            (hook.get("type").and_then(Value::as_str) == Some("command"))
                .then_some(command_timeout)
                .flatten()
                .map(|seconds| seconds * 1000.0)
        })
        .unwrap_or(default_timeout_ms);
    round_at_least_one(timeout_ms)
}

// ---------------------------------------------------------------------------
// Declaration digest + entries + bundle snapshot (T7, T8)
// ---------------------------------------------------------------------------

fn declaration_payload_json(
    source_relative_path: &str,
    source_discovery_order: u64,
    event: &str,
    matcher: Option<&str>,
    matcher_index: usize,
    hook_index: usize,
    hook: &Map<String, Value>,
    resolved_timeout_ms: f64,
    resolved_max_output_bytes: f64,
) -> String {
    let execution = if hook.get("type").and_then(Value::as_str) == Some("process") {
        serde_json::json!([
            "process",
            hook.get("command").and_then(Value::as_str).unwrap_or_default(),
            hook.get("args").and_then(Value::as_array).cloned().unwrap_or_default(),
        ])
    } else {
        let shell = match hook.get("shell") {
            None => serde_json::json!(["unset"]),
            Some(Value::Bool(true)) => serde_json::json!(["true"]),
            Some(Value::String(text)) => serde_json::json!(["string", text]),
            Some(_) => serde_json::json!(["unset"]),
        };
        serde_json::json!([
            "command",
            hook.get("command").and_then(Value::as_str).unwrap_or_default(),
            hook.get("async").and_then(Value::as_bool).unwrap_or(false),
            shell,
        ])
    };
    // The payload is arrays of scalars — field order is literal here.
    serde_json::json!([
        "workspace-hook-declaration",
        DIGEST_SCHEMA_VERSION,
        source_relative_path,
        source_discovery_order,
        event,
        matcher,
        matcher_index,
        hook_index,
        execution,
        js_number(resolved_timeout_ms),
        js_number(resolved_max_output_bytes),
    ])
    .to_string()
}

/// `createWorkspaceHookDeclarationDigest`.
fn declaration_digest(
    source_relative_path: &str,
    source_discovery_order: u64,
    event: &str,
    matcher: Option<&str>,
    matcher_index: usize,
    hook_index: usize,
    hook: &Map<String, Value>,
    default_timeout_ms: f64,
    resolved_max_output_bytes: f64,
) -> String {
    let resolved_timeout_ms = resolve_workspace_hook_timeout_ms(hook, default_timeout_ms);
    sha256_hex(&declaration_payload_json(
        source_relative_path,
        source_discovery_order,
        event,
        matcher,
        matcher_index,
        hook_index,
        hook,
        resolved_timeout_ms,
        resolved_max_output_bytes,
    ))
}

/// `JSON.stringify`'s spelling for numbers: an integer-valued double prints
/// without a fraction (`60000`, not `60000.0`), and everything else uses the
/// shared shortest round-trip form.
fn js_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_992.0 {
        Value::Number(serde_json::Number::from(value as i64))
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

fn optional_bool(value: Option<bool>) -> Value {
    match value {
        None => serde_json::json!(["unset"]),
        Some(flag) => serde_json::json!(["set", flag]),
    }
}

fn optional_number(value: Option<f64>) -> Value {
    match value {
        None => serde_json::json!(["unset"]),
        Some(number) => Value::Array(vec![
            serde_json::json!("set"),
            js_number(number),
        ]),
    }
}

/// `resolveWorkspaceHookEntries` — sources × events × matchers × hooks, in the
/// predecessor's loop order, with the canonical entry field order.
fn resolve_entries(
    workspace_path: &str,
    sources: &[SourceInput],
    runtime_root: &RuntimeRootInput,
) -> Vec<Value> {
    let mut entries = Vec::new();
    for (source_index, source) in sources.iter().enumerate() {
        let relative_path = normalize_relative_source_path(workspace_path, &source.canonical_path);
        let Some(events) = source.hooks.events.as_ref() else {
            continue;
        };
        for event in EVENTS {
            let Some(matchers) = events.get(event).and_then(Value::as_array) else {
                continue;
            };
            for (matcher_index, matcher_value) in matchers.iter().enumerate() {
                let Some(matcher_object) = matcher_value.as_object() else {
                    continue;
                };
                let matcher = matcher_object
                    .get("matcher")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let Some(hooks) = matcher_object.get("hooks").and_then(Value::as_array) else {
                    continue;
                };
                for (hook_index, hook_value) in hooks.iter().enumerate() {
                    let Some(hook) = hook_value.as_object() else {
                        continue;
                    };
                    let gates = configured_gates(
                        source.hooks.enabled,
                        hook.get("enabled").and_then(Value::as_bool),
                        runtime_root.enabled,
                    );
                    let resolved_timeout_ms = resolve_workspace_hook_timeout_ms(hook, runtime_root.timeout_ms);
                    let declaration_digest = declaration_digest(
                        &relative_path,
                        source.discovery_order,
                        event,
                        matcher.as_deref(),
                        matcher_index,
                        hook_index,
                        hook,
                        runtime_root.timeout_ms,
                        runtime_root.max_output_bytes,
                    );
                    let mut entry = Map::new();
                    entry.insert(
                        "reviewItemId".into(),
                        serde_json::json!(format!(
                            "workspace-hook-{source_index}-{event}-{matcher_index}-{hook_index}"
                        )),
                    );
                    entry.insert("event".into(), serde_json::json!(event));
                    entry.insert("matcherIndex".into(), serde_json::json!(matcher_index));
                    entry.insert("hookIndex".into(), serde_json::json!(hook_index));
                    entry.insert("sourceFileIndex".into(), serde_json::json!(source_index));
                    entry.insert("sourceRelativePath".into(), serde_json::json!(relative_path));
                    entry.insert("matcher".into(), matcher.clone().map(Value::String).unwrap_or(Value::Null));
                    entry.insert(
                        "command".into(),
                        hook.get("command").cloned().unwrap_or(Value::Null),
                    );
                    entry.insert("resolvedTimeoutMs".into(), js_number(resolved_timeout_ms));
                    entry.insert(
                        "resolvedMaxOutputBytes".into(),
                        js_number(runtime_root.max_output_bytes),
                    );
                    if let Some(status) = hook.get("statusMessage") {
                        entry.insert("statusMessage".into(), status.clone());
                    }
                    for (key, value) in gates.as_object().expect("gates") {
                        entry.insert(key.clone(), value.clone());
                    }
                    entry.insert("editable".into(), serde_json::json!(source.editable));
                    entry.insert("declarationDigestAlgorithm".into(), serde_json::json!("sha256"));
                    entry.insert("hookDeclarationDigest".into(), serde_json::json!(declaration_digest));
                    entry.insert(
                        "type".into(),
                        hook.get("type").cloned().unwrap_or(Value::Null),
                    );
                    let hook_type = hook.get("type").and_then(Value::as_str);
                    if hook_type == Some("process") {
                        if let Some(args) = hook
                            .get("args")
                            .and_then(Value::as_array)
                            .filter(|args| !args.is_empty())
                        {
                            entry.insert("args".into(), Value::Array(args.clone()));
                        }
                    } else if hook_type == Some("command") {
                        if hook.get("async").and_then(Value::as_bool) == Some(true) {
                            entry.insert("async".into(), serde_json::json!(true));
                        }
                        if let Some(shell) = hook.get("shell") {
                            if !shell.is_null() {
                                entry.insert("shell".into(), shell.clone());
                            }
                        }
                    }
                    entries.push(Value::Object(entry));
                }
            }
        }
    }
    entries
}

/// `buildWorkspaceHookBundleSnapshot` — `undefined` (None) when no hooks exist
/// (T8).
pub fn build_workspace_hook_bundle_snapshot(input: &BundleSnapshotInput) -> Option<String> {
    let hooks = resolve_entries(&input.workspace_path, &input.sources, &input.runtime_root);
    if hooks.is_empty() {
        return None;
    }
    let source_files: Vec<Value> = input
        .sources
        .iter()
        .map(|source| {
            let mut hooks_root = Map::new();
            if let Some(enabled) = source.hooks.enabled {
                hooks_root.insert("enabled".into(), serde_json::json!(enabled));
            }
            if let Some(timeout) = source.hooks.timeout_ms {
                hooks_root.insert("timeoutMs".into(), js_number(timeout));
            }
            if let Some(max_output) = source.hooks.max_output_bytes {
                hooks_root.insert("maxOutputBytes".into(), js_number(max_output));
            }
            serde_json::json!({
                "canonicalPath": source.canonical_path,
                "baseDir": source.base_dir,
                "discoveryOrder": source.discovery_order,
                "configFileKind": source.config_file_kind,
                "explicitProjectConfig": source.explicit_project_config,
                "editable": source.editable,
                "hooksRoot": hooks_root,
            })
        })
        .collect();

    let bundle_payload = serde_json::json!([
        "workspace-hook-bundle",
        DIGEST_SCHEMA_VERSION,
        input.sources.iter().map(|source| serde_json::json!([
            normalize_relative_source_path(&input.workspace_path, &source.canonical_path),
            source.discovery_order,
            source.config_file_kind,
            source.explicit_project_config,
            optional_bool(source.hooks.enabled),
            optional_number(source.hooks.timeout_ms),
            optional_number(source.hooks.max_output_bytes),
        ])).collect::<Vec<_>>(),
        hooks.iter().map(|hook| serde_json::json!([
            hook["hookDeclarationDigest"],
            hook["sourceRootEnabled"],
            hook["declarationEnabled"],
            hook["runtimeHooksEnabled"],
            hook["configuredEnabled"],
        ])).collect::<Vec<_>>(),
    ]);
    let bundle_digest = sha256_hex(&bundle_payload.to_string());

    let snapshot = serde_json::json!({
        "schemaVersion": DIGEST_SCHEMA_VERSION,
        "workspaceIdentity": input.workspace_identity,
        "discoveredAt": input.discovered_at.clone().unwrap_or_default(),
        "sourceFiles": source_files,
        "hooks": hooks,
        "digestAlgorithm": "sha256",
        "bundleDigest": bundle_digest,
    });
    serde_json::to_string(&snapshot).ok()
}

// ---------------------------------------------------------------------------
// Trust projection (T9–T11): fromProjectSnapshot / fromUserZCodeSource /
// fromLegacyHooksConfig
// ---------------------------------------------------------------------------

fn get_custom_hook_fields(hook: &Map<String, Value>) -> Option<Value> {
    const KNOWN: [&str; 9] = [
        "type",
        "command",
        "args",
        "async",
        "enabled",
        "shell",
        "statusMessage",
        "timeout",
        "timeoutMs",
    ];
    let custom: Map<String, Value> = hook
        .iter()
        .filter(|(key, _)| !KNOWN.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if custom.is_empty() {
        None
    } else {
        Some(Value::Object(custom))
    }
}

/// The raw hook a canonical entry came from; TS throws when provenance is
/// missing, and the message is part of the contract.
fn raw_hook<'a>(source: &'a SourceInput, event: &str, matcher_index: usize, hook_index: usize) -> Result<&'a Map<String, Value>, String> {
    source
        .hooks
        .events
        .as_ref()
        .and_then(|events| events.get(event))
        .and_then(Value::as_array)
        .and_then(|matchers| matchers.get(matcher_index))
        .and_then(Value::as_object)
        .and_then(|matcher| matcher.get("hooks"))
        .and_then(Value::as_array)
        .and_then(|hooks| hooks.get(hook_index))
        .and_then(Value::as_object)
        .ok_or_else(|| String::new())
}

/// `toHook` — the canonical entry turned into the service's `Hook`, in the
/// predecessor's field order.
fn to_hook(
    entry: &Map<String, Value>,
    source: &SourceInput,
    id: String,
    location: Value,
    workspace_hook: Option<Value>,
    source_path: &str,
) -> Result<Value, String> {
    let event = entry["event"].as_str().unwrap_or_default().to_string();
    let matcher_index = entry["matcherIndex"].as_u64().unwrap_or_default() as usize;
    let hook_index = entry["hookIndex"].as_u64().unwrap_or_default() as usize;
    let review_item_id = entry["reviewItemId"].as_str().unwrap_or_default().to_string();
    let raw = raw_hook(source, &event, matcher_index, hook_index)
        .map_err(|_| format!("Workspace Hook provenance is incomplete for {review_item_id}"))?;

    let configured_state = serde_json::json!({
        "sourceRootEnabled": entry["sourceRootEnabled"],
        "declarationEnabled": entry["declarationEnabled"],
        "runtimeHooksEnabled": entry["runtimeHooksEnabled"],
        "configuredEnabled": entry["configuredEnabled"],
        "sourcePath": source_path,
    });

    let mut out = Map::new();
    out.insert("id".into(), serde_json::json!(id));
    out.insert("event".into(), serde_json::json!(event));
    // `matcher ?? undefined` — absent, not null.
    if let Some(matcher) = entry.get("matcher").and_then(Value::as_str) {
        out.insert("matcher".into(), serde_json::json!(matcher));
    }
    out.insert("type".into(), entry["type"].clone());
    out.insert("command".into(), entry["command"].clone());
    let hook_type = entry.get("type").and_then(Value::as_str);
    if hook_type == Some("process") {
        if let Some(args) = entry
            .get("args")
            .and_then(Value::as_array)
            .filter(|args| !args.is_empty())
        {
            out.insert("args".into(), Value::Array(args.clone()));
        }
    } else if hook_type == Some("command") {
        if entry.get("async").and_then(Value::as_bool) == Some(true) {
            out.insert("async".into(), serde_json::json!(true));
        }
        if let Some(shell) = entry.get("shell") {
            if !shell.is_null() {
                out.insert("shell".into(), shell.clone());
            }
        }
    }
    if let Some(status) = entry.get("statusMessage").and_then(Value::as_str) {
        out.insert("statusMessage".into(), serde_json::json!(status));
    }
    // timeout: (command ? raw.timeout : undefined) ?? (timeoutMs present ?
    // Math.round(timeoutMs) / 1000 : undefined) — seconds, omitted when unset.
    let timeout = if hook_type == Some("command") {
        raw.get("timeout").and_then(Value::as_f64)
    } else {
        None
    }
    .or_else(|| {
        raw.get("timeoutMs")
            .and_then(Value::as_f64)
            .map(|ms| (ms as f64).round() / 1000.0)
    });
    if let Some(timeout) = timeout {
        out.insert("timeout".into(), js_number(timeout));
    }
    out.insert("enabled".into(), entry["configuredEnabled"].clone());
    out.insert("editable".into(), entry["editable"].clone());
    out.insert("configuredState".into(), configured_state);
    if let Some(workspace_hook) = workspace_hook {
        out.insert("workspaceHook".into(), workspace_hook);
    }
    if let Some(custom) = get_custom_hook_fields(&raw) {
        out.insert("custom".into(), custom);
    }
    out.insert("location".into(), location);
    Ok(Value::Object(out))
}

/// `fromProjectSnapshot` (T9–T11): the digest set arrives as data, so a corrupt
/// store (empty set) has no path to `trusted_persistent`.
pub fn project_hooks_to_service_hooks(input: &ProjectionInput) -> Result<String, String> {
    let Some(snapshot) = &input.snapshot else {
        // `if (!snapshot) return []` — T11.
        return Ok("[]".to_string());
    };
    let trusted: HashSet<&str> = input
        .persistent_trusted_digests
        .iter()
        .map(String::as_str)
        .collect();
    let snapshot_object = snapshot
        .as_object()
        .ok_or_else(|| "snapshot must be an object".to_string())?;
    let bundle_digest = snapshot_object
        .get("bundleDigest")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let entries = snapshot_object
        .get("hooks")
        .and_then(Value::as_array)
        .ok_or_else(|| "snapshot.hooks must be an array".to_string())?;

    let mut hooks = Vec::new();
    for value in entries {
        let entry = value
            .as_object()
            .ok_or_else(|| "entry must be an object".to_string())?;
        let source_file_index = entry
            .get("sourceFileIndex")
            .and_then(Value::as_u64)
            .unwrap_or_default() as usize;
        let review_item_id = entry
            .get("reviewItemId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let source = input.sources.get(source_file_index).ok_or_else(|| {
            format!("Workspace Hook source is missing for {review_item_id}")
        })?;
        let declaration_digest = entry
            .get("hookDeclarationDigest")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let trust_state = if trusted.contains(declaration_digest) {
            "trusted_persistent"
        } else {
            "pending_trust"
        };
        let location = serde_json::json!({
            "source": "zcode",
            "scope": "project",
            "directoryPath": std::path::Path::new(&source.canonical_path)
                .parent()
                .map(|parent| parent.to_string_lossy().to_string())
                .unwrap_or_default(),
            "projectPath": input.workspace_path,
        });
        let workspace_hook = {
            let mut state = Map::new();
            for key in [
                "sourceRootEnabled",
                "declarationEnabled",
                "runtimeHooksEnabled",
                "configuredEnabled",
            ] {
                state.insert(key.to_string(), entry.get(key).cloned().unwrap_or(Value::Null));
            }
            state.insert(
                "sourcePath".into(),
                serde_json::json!(source.canonical_path),
            );
            state.insert("reviewItemId".into(), serde_json::json!(review_item_id));
            state.insert(
                "sourceFileIndex".into(),
                serde_json::json!(source_file_index),
            );
            state.insert(
                "workspaceIdentity".into(),
                serde_json::json!(input.workspace_identity),
            );
            state.insert("bundleDigest".into(), serde_json::json!(bundle_digest));
            state.insert("hookDeclarationDigest".into(), serde_json::json!(declaration_digest));
            state.insert("trustState".into(), serde_json::json!(trust_state));
            Value::Object(state)
        };
        hooks.push(to_hook(
            entry,
            source,
            review_item_id.to_string(),
            location,
            Some(workspace_hook),
            &source.canonical_path,
        )?);
    }
    serde_json::to_string(&Value::Array(hooks)).map_err(|error| error.to_string())
}

/// `fromUserZCodeSource`: entries for exactly one source, ids `hook-zcode-user-<i>`,
/// no workspace-hook trust state.
pub fn hooks_from_user_source(
    sources: &[SourceInput],
    runtime_root: &RuntimeRootInput,
    workspace_path: &str,
    location: &Value,
) -> Result<String, String> {
    let Some(first_source) = sources.first() else {
        return Ok("[]".to_string());
    };
    let mut hooks = Vec::new();
    for (index, entry_value) in resolve_entries(workspace_path, sources, runtime_root)
        .into_iter()
        .enumerate()
    {
        let entry = entry_value
            .as_object()
            .ok_or_else(|| "entry must be an object".to_string())?;
        hooks.push(to_hook(
            entry,
            first_source,
            format!("hook-zcode-user-{index}"),
            location.clone(),
            None,
            &first_source.canonical_path,
        )?);
    }
    serde_json::to_string(&Value::Array(hooks)).map_err(|error| error.to_string())
}

/// `fromLegacyHooksConfig`: the agents/claude `.json` files, disabled and
/// non-editable by construction.
pub fn hooks_from_legacy_config(
    legacy_config: &Value,
    location: &Value,
) -> Result<String, String> {
    let empty = Map::new();
    let root = legacy_config.as_object().unwrap_or(&empty);
    let mut hooks = Vec::new();
    let mut id_counter = 0usize;
    let Some(legacy_hooks) = root.get("hooks").and_then(Value::as_object) else {
        return Ok("[]".to_string());
    };
    for (event_name, matchers_value) in legacy_hooks {
        if !EVENTS.contains(&event_name.as_str()) {
            continue;
        }
        let Some(matchers) = matchers_value.as_array() else {
            continue;
        };
        for matcher_value in matchers {
            let Some(matcher_object) = matcher_value.as_object() else {
                continue;
            };
            // `matcher: matcher.matcher` — kept verbatim (an empty string
            // survives); only an absent key drops the field.
            let matcher = matcher_object
                .get("matcher")
                .and_then(Value::as_str)
                .map(str::to_string);
            let Some(hook_list) = matcher_object.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for hook_value in hook_list {
                let Some(hook) = hook_value.as_object() else {
                    continue;
                };
                let hook_type = hook.get("type").and_then(Value::as_str);
                if !matches!(hook_type, Some("command") | Some("process")) {
                    continue;
                }
                if hook.get("command").and_then(Value::as_str).map_or(true, str::is_empty) {
                    continue;
                }
                let source = location
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let scope = location
                    .get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let mut out = Map::new();
                out.insert(
                    "id".into(),
                    serde_json::json!(format!("hook-{source}-{scope}-{id_counter}")),
                );
                id_counter += 1;
                out.insert("event".into(), serde_json::json!(event_name));
                if let Some(matcher) = &matcher {
                    out.insert("matcher".into(), serde_json::json!(matcher));
                }
                out.insert("type".into(), serde_json::json!(hook_type.unwrap_or_default()));
                out.insert("command".into(), hook["command"].clone());
                if hook_type == Some("process") {
                    out.insert(
                        "args".into(),
                        Value::Array(
                            hook.get("args").and_then(Value::as_array).cloned().unwrap_or_default(),
                        ),
                    );
                }
                if let Some(flag) = hook.get("async") {
                    out.insert("async".into(), flag.clone());
                }
                if let Some(shell) = hook.get("shell") {
                    out.insert("shell".into(), shell.clone());
                }
                if let Some(status) = hook.get("statusMessage") {
                    out.insert("statusMessage".into(), status.clone());
                }
                let timeout = hook.get("timeout").and_then(Value::as_f64).or_else(|| {
                    hook
                        .get("timeoutMs")
                        .and_then(Value::as_f64)
                        .map(|ms| (ms as f64).round() / 1000.0)
                });
                if let Some(timeout) = timeout {
                    out.insert("timeout".into(), js_number(timeout));
                }
                out.insert("enabled".into(), serde_json::json!(false));
                out.insert("editable".into(), serde_json::json!(false));
                out.insert("location".into(), location.clone());
                hooks.push(Value::Object(out));
            }
        }
    }
    Ok(serde_json::to_string(&Value::Array(hooks)).map_err(|error| error.to_string())?)
}

// ---------------------------------------------------------------------------
// Events, root enablement, partition, config build (T48–T55)
// ---------------------------------------------------------------------------

/// `resolveWritableDeclarationEnabled` (T50): the DECLARATION's enabled wins
/// when the runtime value still equals its configured state.
fn writable_declaration_enabled(hook: &Map<String, Value>) -> Value {
    let enabled = hook.get("enabled").cloned().unwrap_or(Value::Bool(false));
    let Some(configured) = hook.get("configuredState").and_then(Value::as_object) else {
        return enabled;
    };
    let configured_enabled = configured
        .get("configuredEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if enabled.as_bool() == Some(configured_enabled) {
        configured
            .get("declarationEnabled")
            .cloned()
            .unwrap_or(Value::Bool(false))
    } else {
        enabled
    }
}

/// `getWritableHook`: custom fields first, then the base shape, then the
/// type-specific fields — command `timeout` stays seconds, process becomes
/// `timeoutMs` (T49).
fn writable_hook(hook: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    if let Some(Value::Object(custom)) = hook.get("custom").cloned() {
        for (key, value) in custom {
            out.insert(key, value);
        }
    }
    out.insert("type".into(), hook.get("type").cloned().unwrap_or(Value::Null));
    out.insert("command".into(), hook.get("command").cloned().unwrap_or(Value::Null));
    let enabled = writable_declaration_enabled(hook);
    out.insert("enabled".into(), enabled);
    if let Some(status) = hook.get("statusMessage").and_then(Value::as_str) {
        if !status.is_empty() {
            out.insert("statusMessage".into(), serde_json::json!(status));
        }
    }
    let hook_type = hook.get("type").and_then(Value::as_str);
    if hook_type == Some("command") {
        if hook.get("async").and_then(Value::as_bool) == Some(true) {
            out.insert("async".into(), serde_json::json!(true));
        }
        if let Some(shell) = hook.get("shell") {
            if shell.as_bool() == Some(true) || shell.as_str().is_some_and(|s| !s.is_empty()) {
                out.insert("shell".into(), shell.clone());
            }
        }
        if let Some(timeout) = hook.get("timeout").and_then(Value::as_f64) {
            if timeout != 0.0 {
                out.insert("timeout".into(), js_number(timeout));
            }
        }
    } else {
        let args = hook.get("args").and_then(Value::as_array);
        if let Some(args) = args.filter(|args| !args.is_empty()) {
            out.insert("args".into(), Value::Array(args.clone()));
        }
        if let Some(timeout) = hook.get("timeout").and_then(Value::as_f64) {
            if timeout != 0.0 {
                out.insert("timeoutMs".into(), js_number(timeout * 1000.0));
            }
        }
    }
    Value::Object(out)
}

/// `toZCodeHooksEvents` (T48): grouping by the first matching matcher value;
/// `undefined` matcher is ONE group. Emission order = first-encounter order of
/// events and matchers.
pub fn hooks_to_zcode_events(hooks: &[Value]) -> String {
    // Event keys in first-encounter order; each group holds its matcher value
    // as emitted (the first matcher value defines the group — T48).
    let mut events: Vec<(String, Vec<Value>)> = Vec::new();
    for hook in hooks {
        let Some(hook_object) = hook.as_object() else {
            continue;
        };
        let event = hook_object
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let matcher = hook_object
            .get("matcher")
            .and_then(Value::as_str)
            .map(str::to_string);
        let event_entry = match events.iter_mut().find(|(name, _)| *name == event) {
            Some(entry) => entry,
            None => {
                events.push((event, Vec::new()));
                events.last_mut().expect("just pushed")
            }
        };
        let groups = &mut event_entry.1;
        let group_index = groups.iter().position(|group| {
            group
                .get("matcher")
                .and_then(Value::as_str)
                .map(str::to_string)
                == matcher
        });
        let group_index = match group_index {
            Some(index) => index,
            None => {
                let mut group = Map::new();
                if let Some(matcher) = &matcher {
                    group.insert("matcher".into(), Value::String(matcher.clone()));
                }
                group.insert("hooks".into(), Value::Array(Vec::new()));
                groups.push(Value::Object(group));
                groups.len() - 1
            }
        };
        let Value::Object(group) = &mut groups[group_index] else {
            continue;
        };
        let mut group_hooks = match group.get("hooks").cloned().unwrap_or(Value::Array(Vec::new())) {
            Value::Array(hooks) => hooks,
            _ => Vec::new(),
        };
        group_hooks.push(writable_hook(hook_object));
        group.insert("hooks".into(), Value::Array(group_hooks));
    }
    let out: Map<String, Value> = events
        .into_iter()
        .map(|(event, groups)| (event, Value::Array(groups)))
        .collect();
    serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".into())
}

/// `resolveNextRootEnabled` (T52/T53): a deviating hook forces `true`;
/// otherwise the existing root value passes through UNCHANGED (including
/// `undefined`).
pub fn resolve_next_root_enabled(existing: Option<bool>, hooks: &[Value]) -> Option<bool> {
    let deviates = hooks.iter().any(|hook| {
        let Some(hook_object) = hook.as_object() else {
            return false;
        };
        let enabled = hook_object
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !enabled {
            return false;
        }
        match hook_object.get("configuredState").and_then(Value::as_object) {
            None => true,
            Some(configured) => {
                enabled != configured.get("configuredEnabled").and_then(Value::as_bool).unwrap_or(false)
            }
        }
    });
    if deviates {
        Some(true)
    } else {
        existing
    }
}

/// `saveHooksImpl`'s partition (T54): user vs project config, each with the
/// exact editable/location/sourcePath gates. The current project config path
/// is resolved by the caller (it owns the workspace path).
pub fn partition_writable_hooks(hooks: &[Value], current_project_config_path: &str) -> String {
    let current = resolve_path(current_project_config_path);
    let mut user = Vec::new();
    let mut project = Vec::new();
    for hook in hooks {
        let Some(hook_object) = hook.as_object() else {
            continue;
        };
        let editable = hook_object
            .get("editable")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if !editable {
            continue;
        }
        let location = hook_object.get("location").and_then(Value::as_object);
        let source = location.and_then(|l| l.get("source").and_then(Value::as_str));
        let scope = location.and_then(|l| l.get("scope").and_then(Value::as_str));
        let no_location = location.is_none();
        if no_location || (source == Some("zcode") && scope == Some("user")) {
            user.push(hook.clone());
            continue;
        }
        if source == Some("zcode") && scope == Some("project") {
            let source_path_matches = hook_object
                .get("configuredState")
                .and_then(Value::as_object)
                .and_then(|state| state.get("sourcePath"))
                .and_then(Value::as_str)
                .map(|path| resolve_path(path) == current)
                .unwrap_or(true);
            if source_path_matches {
                project.push(hook.clone());
            }
        }
    }
    serde_json::to_string(&serde_json::json!({ "user": user, "project": project }))
        .unwrap_or_else(|_| "{}".into())
}

/// `writeZCodeHooksConfig`'s merge (T51): `events` always overwritten,
/// `enabled` only when resolved, every other `hooks` key survives.
pub fn build_zcode_hooks_config(
    existing: &Value,
    enabled: Option<bool>,
    events_json: &str,
) -> Result<String, String> {
    let events: Value = serde_json::from_str(events_json).map_err(|e| e.to_string())?;
    let empty = Map::new();
    let existing_object = existing.as_object().unwrap_or(&empty);
    let existing_hooks = existing_object
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut hooks = existing_hooks;
    if let Some(enabled) = enabled {
        hooks.insert("enabled".into(), serde_json::json!(enabled));
    }
    hooks.insert("events".into(), events);

    let mut out = existing_object.clone();
    out.insert("hooks".into(), Value::Object(hooks));
    serde_json::to_string(&Value::Object(out)).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Runtime root (T55–T57) and the strict config validation (T58)
// ---------------------------------------------------------------------------

/// `resolveWorkspaceHookRuntimeRoot`: `enabled` is a logical OR across roots,
/// the timeout/maxOutputBytes take the LAST defined value, undefined roots do
/// not reset, and both are `max(1, round(x))`.
pub fn resolve_workspace_hook_runtime_root(roots_json: &str) -> Result<String, String> {
    let roots: Value = serde_json::from_str(roots_json).map_err(|error| error.to_string())?;
    let roots_array = roots
        .as_array()
        .ok_or_else(|| "roots must be an array".to_string())?;
    let mut enabled = false;
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    let mut max_output_bytes = DEFAULT_MAX_OUTPUT_BYTES;
    for root in roots_array {
        if !root.is_object() && !root.is_null() {
            continue;
        }
        if root.get("enabled").and_then(Value::as_bool) == Some(true) {
            enabled = true;
        }
        if let Some(timeout) = root.get("timeoutMs").and_then(Value::as_f64) {
            timeout_ms = timeout;
        }
        if let Some(max_output) = root.get("maxOutputBytes").and_then(Value::as_f64) {
            max_output_bytes = max_output;
        }
    }
    let out = serde_json::json!({
        "enabled": enabled,
        "timeoutMs": js_number(round_at_least_one(timeout_ms)),
        "maxOutputBytes": js_number(round_at_least_one(max_output_bytes)),
    });
    serde_json::to_string(&out).map_err(|error| error.to_string())
}

/// `workspaceHooksConfigSchema` — `.strict()` at both levels (T58): an unknown
/// key under `events`, or under a matcher, is rejected. Returns
/// `{ok, issues}` in the zod vocabulary of `settings.rs`.
pub fn validate_workspace_hooks_config(config_json: &str) -> String {
    let config: Value = match serde_json::from_str(config_json) {
        Ok(value) => value,
        Err(error) => {
            return serde_json::json!({
                "ok": false,
                "issues": [{ "path": "", "message": format!("Invalid JSON: {error}") }],
            })
            .to_string()
        }
    };
    let mut issues: Vec<crate::settings::SettingsIssue> = Vec::new();
    let Some(object) = config.as_object() else {
        issues.push(crate::settings::invalid_type_issue("", "object", &config));
        return serde_json::json!({ "ok": false, "issues": issues }).to_string();
    };
    const KNOWN: [&str; 4] = ["enabled", "timeoutMs", "maxOutputBytes", "events"];
    const EVENT_KEYS: [&str; 7] = EVENTS;
    let unknown: Vec<String> = object
        .keys()
        .filter(|key| !KNOWN.contains(&key.as_str()))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        issues.push(crate::settings::unrecognized_keys_issue("", &unknown));
    }
    for key in ["timeoutMs", "maxOutputBytes"] {
        if let Some(value) = object.get(key) {
            if !value.is_number() {
                issues.push(crate::settings::invalid_type_issue(key, "number", value));
            } else if value.as_f64().is_some_and(|n| n <= 0.0 || n.is_nan()) {
                issues.push(crate::settings::SettingsIssue {
                    path: key.to_string(),
                    message: "Too small: expected number to be >0".to_string(),
                });
            }
        }
    }
    if let Some(enabled) = object.get("enabled") {
        if !enabled.is_boolean() {
            issues.push(crate::settings::invalid_type_issue("enabled", "boolean", enabled));
        }
    }
    if let Some(events) = object.get("events") {
        let Some(events_object) = events.as_object() else {
            issues.push(crate::settings::invalid_type_issue("events", "object", events));
            return serde_json::json!({ "ok": false, "issues": issues }).to_string();
        };
        let unknown_events: Vec<String> = events_object
            .keys()
            .filter(|key| !EVENT_KEYS.contains(&key.as_str()))
            .cloned()
            .collect();
        if !unknown_events.is_empty() {
            issues.push(crate::settings::unrecognized_keys_issue("events", &unknown_events));
        }
        for (event, matchers) in events_object {
            let Some(matchers_array) = matchers.as_array() else {
                issues.push(crate::settings::invalid_type_issue(
                    &format!("events.{event}"),
                    "array",
                    matchers,
                ));
                continue;
            };
            for (index, matcher_value) in matchers_array.iter().enumerate() {
                let matcher_path = format!("events.{event}.{index}");
                let Some(matcher) = matcher_value.as_object() else {
                    issues.push(crate::settings::invalid_type_issue(&matcher_path, "object", matcher_value));
                    continue;
                };
                let matcher_unknown: Vec<String> = matcher
                    .keys()
                    .filter(|key| *key != "matcher" && *key != "hooks")
                    .cloned()
                    .collect();
                if !matcher_unknown.is_empty() {
                    issues.push(crate::settings::unrecognized_keys_issue(&matcher_path, &matcher_unknown));
                }
                if let Some(matcher_name) = matcher.get("matcher") {
                    if matcher_name.as_str().is_some_and(str::is_empty) {
                        issues.push(crate::settings::SettingsIssue {
                            path: format!("{matcher_path}.matcher"),
                            message: "Too small: expected string to have >=1 characters".to_string(),
                        });
                    }
                }
                let hooks_path = format!("{matcher_path}.hooks");
                match matcher.get("hooks").and_then(Value::as_array) {
                    None => {
                        issues.push(crate::settings::invalid_type_issue(&hooks_path, "array", matcher.get("hooks").unwrap_or(&Value::Null)));
                    }
                    Some(hooks) => {
                        if hooks.is_empty() {
                            issues.push(crate::settings::SettingsIssue {
                                path: hooks_path.clone(),
                                message: "Too small: expected array to have >=1 elements".to_string(),
                            });
                        }
                        for (hook_index, hook) in hooks.iter().enumerate() {
                            validate_hook_definition(hook, &format!("{hooks_path}.{hook_index}"), &mut issues);
                        }
                    }
                }
            }
        }
    }
    let result = if issues.is_empty() {
        serde_json::json!({ "ok": true })
    } else {
        serde_json::json!({ "ok": false, "issues": issues })
    };
    result.to_string()
}

fn validate_hook_definition(hook: &Value, path: &str, issues: &mut Vec<crate::settings::SettingsIssue>) {
    let Some(object) = hook.as_object() else {
        issues.push(crate::settings::invalid_type_issue(path, "object", hook));
        return;
    };
    let hook_type = object.get("type");
    // discriminated on `type`: 'process' | 'command' (schema order).
    let discriminant = match hook_type.and_then(Value::as_str) {
        Some("process") | Some("command") => true,
        _ => false,
    };
    if !discriminant {
        issues.push(crate::settings::SettingsIssue {
            path: format!("{path}.type"),
            message: "Invalid discriminator value. Expected 'process' | 'command'".to_string(),
        });
        return;
    }
    let is_process = hook_type.and_then(Value::as_str) == Some("process");
    // `.passthrough()` — unknown keys allowed here (unlike the strict matcher).
    let command_path = format!("{path}.command");
    match object.get("command") {
        None => {
            issues.push(crate::settings::SettingsIssue {
                path: command_path.clone(),
                message: "Invalid input: expected string, received undefined".to_string(),
            });
        }
        Some(Value::String(text)) => {
            if text.is_empty() {
                issues.push(crate::settings::SettingsIssue {
                    path: command_path.clone(),
                    message: "Too small: expected string to have >=1 characters".to_string(),
                });
            }
        }
        Some(value) => {
            issues.push(crate::settings::invalid_type_issue(&command_path, "string", value));
        }
    }
    let enabled_path = format!("{path}.enabled");
    if let Some(enabled) = object.get("enabled") {
        if !enabled.is_boolean() {
            issues.push(crate::settings::invalid_type_issue(&enabled_path, "boolean", enabled));
        }
    }
    let args_path = format!("{path}.args");
    if let Some(args) = object.get("args") {
        if !is_process {
            // schema has no args for command — passthrough allows it; skip.
        }
        match args.as_array() {
            None => issues.push(crate::settings::invalid_type_issue(&args_path, "array", args)),
            Some(entries) => {
                for (index, entry) in entries.iter().enumerate() {
                    if !entry.is_string() {
                        issues.push(crate::settings::invalid_type_issue(&format!("{args_path}.{index}"), "string", entry));
                    }
                }
            }
        }
    }
    for key in ["timeout", "timeoutMs"] {
        if let Some(value) = object.get(key) {
            if !value.is_number() {
                issues.push(crate::settings::invalid_type_issue(&format!("{path}.{key}"), "number", value));
            } else if value.as_f64().is_some_and(|n| n <= 0.0) {
                issues.push(crate::settings::SettingsIssue {
                    path: format!("{path}.{key}"),
                    message: "Too small: expected number to be >0".to_string(),
                });
            }
        }
    }
    if let Some(status) = object.get("statusMessage") {
        if status.as_str().is_some_and(str::is_empty) {
            issues.push(crate::settings::SettingsIssue {
                path: format!("{path}.statusMessage"),
                message: "Too small: expected string to have >=1 characters".to_string(),
            });
        } else if !status.is_string() {
            issues.push(crate::settings::invalid_type_issue(&format!("{path}.statusMessage"), "string", status));
        }
    }
    if let Some(shell) = object.get("shell") {
        // union: true | non-empty string
        let valid = shell.as_bool() == Some(true)
            || shell.as_str().is_some_and(|text| !text.is_empty());
        if !valid {
            if shell.is_string() {
                issues.push(crate::settings::SettingsIssue {
                    path: format!("{path}.shell"),
                    message: "Too small: expected string to have >=1 characters".to_string(),
                });
            } else {
                issues.push(crate::settings::invalid_type_issue(&format!("{path}.shell"), "boolean", shell));
            }
        }
    }
    if !is_process {
        if let Some(async_flag) = object.get("async") {
            if !async_flag.is_boolean() {
                issues.push(crate::settings::invalid_type_issue(&format!("{path}.async"), "boolean", async_flag));
            }
        }
    }
}
