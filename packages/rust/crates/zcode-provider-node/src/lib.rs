//! zcode-provider-node — the Node consumer surface of `packages/provider-node`,
//! in Rust.
//!
//! Spec: docs/specs/rust-native-provider-node.md. This crate is the **only**
//! Node ABI surface; every implementation lives in `zcode-provider-config`, and
//! `@zcode/rust/provider-node` is the TypeScript wrapper over these bindings.
//!
//! # Boundary rules
//!
//! - **JSON strings, never JS objects.** napi converts between `serde_json` and
//!   JS objects on every call, and the ported code must see the same bytes the
//!   deleted TS codec saw. `json.rs` is the single definition of that shape.
//! - **Injected callbacks are the host's, not ours.** The network (`request`),
//!   the legacy import, the endpoint resolver, the refresh fetch, the change
//!   listeners: each arrives as a `ThreadsafeFunction` and is awaited, never
//!   replaced by a Rust implementation. What Rust owns is the URL, the budget,
//!   the schema and the decision.
//! - **No fallback.** A missing binary throws in the wrapper's loader; nothing
//!   here degrades to a JavaScript implementation, because there is none left.

use napi_derive::napi;

pub mod builtin_source;
pub mod download;
pub mod json;
pub mod repository;
pub mod runtime;

pub use builtin_source::NativeZCodeBuiltinProviderConfigSource;
pub use download::{download_zcode_builtin_release, DownloadOptionsJson};
pub use repository::NativePersonalProviderConfigRepository;
pub use runtime::NativeProviderConfigRuntime;

use zcode_provider_config::{
    cache_paths, materialize as materialize_builtin, schema,
};

// ---------------------------------------------------------------------------
// Environment contract
// ---------------------------------------------------------------------------

/// `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`. Exported natively so the constant has
/// exactly one definition on both sides of the boundary.
#[napi]
pub const ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV: &str = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";

#[napi]
pub const ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV: &str =
    "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";

#[napi]
pub const ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV: &str = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";

#[napi]
pub const PERSONAL_PROVIDER_CONFIG_FILE_NAME: &str = "provider_config.json";

// ---------------------------------------------------------------------------
// The personal-config file codec
// ---------------------------------------------------------------------------

/// `decodeProviderConfigFile`. Strict schema, version gate, legacy manual-rule
/// narrowing — one implementation, shared with the Tauri host.
#[napi]
pub fn decode_provider_config_file(input_json: String) -> napi::Result<String> {
    let layer = json::decode_layer_json(&input_json)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error))?;
    let update = json::layer_to_update(&layer)
        .map_err(|error| napi::Error::new(napi::Status::GenericFailure, error))?;
    serde_json::to_string(&update).map_err(|error| {
        napi::Error::new(napi::Status::GenericFailure, error.to_string())
    })
}

/// `encodeProviderConfigFile`: the file form the repository writes.
#[napi]
pub fn encode_provider_config_file(input_json: String) -> napi::Result<String> {
    let update: json::LayerUpdateJson = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))?;
    let layer = json::update_to_layer(&update)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error))?;
    serde_json::to_string(&schema::encode_provider_config_file(&layer)).map_err(|error| {
        napi::Error::new(napi::Status::GenericFailure, error.to_string())
    })
}

// ---------------------------------------------------------------------------
// The builtin release codec
// ---------------------------------------------------------------------------

/// `decodeZCodeBuiltinRelease`, returning the release envelope so the wrapper
/// hydrates the domain objects with the same parsers the TS decode used.
#[napi]
pub fn decode_zcode_builtin_release(input_json: String) -> napi::Result<String> {
    let release = json::decode_release_json(&input_json)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error))?;
    json::release_to_json(&release)
        .map_err(|error| napi::Error::new(napi::Status::GenericFailure, error))
}

/// `serializeZCodeBuiltinRelease`.
#[napi]
pub fn serialize_zcode_builtin_release(input_json: String) -> napi::Result<String> {
    let release = json::decode_release_json(&input_json)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error))?;
    json::release_to_json(&release)
        .map_err(|error| napi::Error::new(napi::Status::GenericFailure, error))
}

// ---------------------------------------------------------------------------
// Materialisation
// ---------------------------------------------------------------------------

/// `materializeZCodeBuiltinProviderConfig`: validate, normalise, atomically
/// place the bundled release under the environment config root. Returns the
/// file path.
#[napi]
pub fn materialize_zcode_builtin_provider_config(
    environment_config_root: String,
    content: String,
) -> napi::Result<String> {
    let path = materialize_builtin(
        std::path::Path::new(&environment_config_root),
        &content,
    )
    .map_err(|error| napi::Error::new(napi::Status::GenericFailure, error))?;
    Ok(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Cache paths and the client platform
// ---------------------------------------------------------------------------

/// `resolveZCodeBuiltinClientPlatform`.
#[napi]
pub fn resolve_zcode_builtin_client_platform() -> String {
    cache_paths::resolve_client_platform()
}

#[napi]
pub fn create_zcode_builtin_endpoint_key(zcode_endpoint_origin: String) -> napi::Result<String> {
    cache_paths::create_endpoint_key(&zcode_endpoint_origin)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error))
}

#[napi]
pub fn normalize_zcode_builtin_endpoint_origin(value: String) -> napi::Result<String> {
    cache_paths::normalize_endpoint_origin(&value)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error))
}

/// `resolveZCodeBuiltinCachePaths`: `{ activeFilePath, controlFilePath }`.
#[napi]
pub fn resolve_zcode_builtin_cache_paths(options_json: String) -> napi::Result<String> {
    #[derive(serde::Deserialize)]
    struct Options {
        #[serde(rename = "environmentConfigRoot")]
        environment_config_root: String,
        platform: String,
        #[serde(rename = "appVersion")]
        app_version: String,
        #[serde(rename = "zcodeEndpointOrigin")]
        zcode_endpoint_origin: String,
    }
    let options: Options = serde_json::from_str(&options_json)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))?;
    let paths = cache_paths::resolve_cache_paths(
        std::path::Path::new(&options.environment_config_root),
        &options.platform,
        &options.app_version,
        &options.zcode_endpoint_origin,
    )
    .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error))?;
    serde_json::to_string(&serde_json::json!({
        "activeFilePath": paths.active_file_path.to_string_lossy(),
        "controlFilePath": paths.control_file_path.to_string_lossy(),
    }))
    .map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()))
}

// ---------------------------------------------------------------------------
// Runtime path env
// ---------------------------------------------------------------------------

/// `createNodeProviderRuntimePathEnv`.
#[napi]
pub fn create_node_provider_runtime_path_env(paths_json: String) -> napi::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Paths {
        zcode_builtin_file_path: String,
        personal_file_path: String,
    }
    let paths: Paths = serde_json::from_str(&paths_json)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))?;
    serde_json::to_string(&serde_json::json!({
        cache_paths::ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV: paths.zcode_builtin_file_path,
        cache_paths::ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV: paths.personal_file_path,
    }))
    .map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()))
}

/// `resolveNodeProviderRuntimePaths`. `envJson` is the two-variable subset the
/// TS read: an object of `string | undefined`; a missing key and an explicit
/// `null` both read as absent.
#[napi]
pub fn resolve_node_provider_runtime_paths(env_json: String) -> napi::Result<String> {
    let env: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&env_json)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))?;
    let lookup = |name: &str| -> Option<String> {
        env.get(name)
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let paths = cache_paths::resolve_runtime_paths(&lookup)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error))?;
    match paths {
        None => Ok("null".to_string()),
        Some(paths) => serde_json::to_string(&serde_json::json!({
            "zcodeBuiltinFilePath": paths.zcode_builtin_file_path,
            "personalFilePath": paths.personal_file_path,
        }))
        .map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string())),
    }
}

// ---------------------------------------------------------------------------
// Model-selection classification and the legacy reasoning level
// ---------------------------------------------------------------------------

/// The `account:…` provider ids the built-in Config publishes, mirrored from
/// `@zcode/shared`'s `BUILTIN_MODEL_PROVIDER_IDS`. A mirror, not a copy of the
/// derivation: the table is closed and the wrapper asserts the two agree.
const BUILTIN_MODEL_PROVIDER_IDS: &[&str] = &[
    "account:zai-individual-coding-plan",
    "account:zai-team-coding-plan",
    "account:zai-start-plan",
    "account:bigmodel-individual-coding-plan",
    "account:bigmodel-team-coding-plan",
    "account:bigmodel-start-plan",
];

const START_PLAN_PROVIDER_IDS: &[&str] = &["account:zai-start-plan", "account:bigmodel-start-plan"];

const OFF_PEAK_PROVIDER_IDS: &[&str] = &[
    "account:zai-offpeak-idle-plan",
    "account:bigmodel-offpeak-idle-plan",
];

/// The classification the model-selection facade needs: `ordinary`,
/// `account-plan` or `account-offpeak`.
///
/// Start Plan resolves by its real id and cannot participate in the paid
/// connection uniqueness judgment, so it is checked before the account-plan
/// branch — the same order the TS closure used.
#[napi]
pub fn classify_model_provider_kind(provider_id: String) -> String {
    if START_PLAN_PROVIDER_IDS.contains(&provider_id.as_str()) {
        return "ordinary".to_string();
    }
    if BUILTIN_MODEL_PROVIDER_IDS.contains(&provider_id.as_str()) {
        return "account-plan".to_string();
    }
    if OFF_PEAK_PROVIDER_IDS.contains(&provider_id.as_str()) {
        return "account-offpeak".to_string();
    }
    "ordinary".to_string()
}

/// `resolveLegacyReasoningLevel`. Input:
/// `{ selection, personalModelRules, builtinModelRules, providers }`, where the
/// two rule maps are the **file form** and `providers` carries the effective
/// provider facts. Output: `"disabled"` or `null`.
#[napi]
pub fn resolve_legacy_reasoning_level(input_json: String) -> napi::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        selection: schema::ModelSelection,
        personal_model_rules: schema::PersonalModelConfigRulesData,
        builtin_model_rules: schema::BuiltinModelConfigRulesData,
        providers: Vec<zcode_provider_config::legacy_reasoning::LegacyReasoningProviderInput>,
    }
    let input: Input = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))?;
    let resolved = zcode_provider_config::legacy_reasoning::resolve_legacy_reasoning_level(
        &input.selection,
        &input.personal_model_rules,
        &input.builtin_model_rules,
        &input.providers,
    );
    Ok(resolved.unwrap_or_else(|| "null".to_string()))
}
