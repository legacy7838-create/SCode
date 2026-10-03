//! Personal Provider Config file plane.
//!
//! Port of `packages/provider-node` file-side modules for the personal config:
//! `NodePersonalProviderConfigRepository`, the config file codec, and the
//! schema it decodes against. The TS side owns the same responsibilities
//! under `packages/provider-node/src/`; the Rust host must reproduce them
//! because `@zcode/server` — its only previous host — is being deleted.
//!
//! Owner: one `PersonalProviderConfigRepository` per config file. `read`,
//! `update`, and poll notifications all go through it; no second writer.

pub mod account;
pub mod builtin_source;
pub mod cache_paths;
pub mod config_service;
pub mod domain;
pub mod download;
pub mod endpoint_scoped;
pub mod facades;
pub mod legacy_reasoning;
pub mod materialize;
pub mod registry_service;
pub mod remote_sync;
pub mod repository;
pub mod resolver;
pub mod runtime;
pub mod schema;

/// The `{ revision, release }` snapshot the wrapper rehydrates, as one string.
pub fn builtin_snapshot_wire(
    revision: &str,
    release: &schema::BuiltinRelease,
) -> Result<String, String> {
    let bytes = schema::encode_builtin_release(release).map_err(|error| error.to_string())?;
    let envelope: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    serde_json::to_string(&serde_json::json!({
        "revision": revision,
        "release": envelope,
    }))
    .map_err(|error| error.to_string())
}

pub use builtin_source::{ApplyRemoteReleaseResult, FileBuiltinSource};
pub use cache_paths::{
    create_endpoint_key, normalize_endpoint_origin, resolve_cache_paths, resolve_client_platform,
    resolve_runtime_paths, NodeProviderRuntimePaths, ZCodeBuiltinCachePaths,
};
pub use config_service::{BuiltinSnapshot, BuiltinSource, ProviderConfigService};
pub use download::{download_builtin_release, DownloadOutcome, DownloadRequest, DownloadRequestError};
pub use endpoint_scoped::{
    EndpointScopedBuiltinSource, EndpointScopedOptions, EndpointScopedSourceKind,
};
pub use legacy_reasoning::{resolve_legacy_reasoning_level, LegacyReasoningProviderInput};
pub use materialize::materialize;
pub use repository::{PersonalProviderConfigRepository, PersonalRepositoryOptions};
pub use resolver::{ProviderConfigResolution, ProviderRegistryView};
pub use runtime::{
    CheckListener, FetchRelease, ImportLegacy, OnRefreshError, OnRefreshResult,
    ProviderConfigRuntime, ProviderConfigRuntimeOptions, ResolveEndpointKey,
    RuntimeBuiltinEnvironmentOptions, RuntimeRemoteOptions,
};
pub use schema::{
    decode_builtin_release, decode_provider_config_file, encode_builtin_release,
    encode_provider_config_file, BuiltinRelease, ModelSelection, PersonalConfigLayer,
    PersonalModelConfigRulesData, PersonalProviderConfigData, PersonalProviderConfigRulesData,
    ProviderConfigFileError,
};
