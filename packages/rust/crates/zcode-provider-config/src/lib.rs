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
pub mod config_service;
pub mod domain;
pub mod facades;
pub mod registry_service;
pub mod remote_sync;
pub mod repository;
pub mod resolver;
pub mod schema;

pub use builtin_source::{ApplyRemoteReleaseResult, FileBuiltinSource};
pub use config_service::{BuiltinSnapshot, BuiltinSource, ProviderConfigService};
pub use repository::{PersonalProviderConfigRepository, PersonalRepositoryOptions};
pub use resolver::{ProviderConfigResolution, ProviderRegistryView};
pub use schema::{
    decode_builtin_release, decode_provider_config_file, encode_builtin_release,
    encode_provider_config_file, BuiltinRelease, ModelSelection, PersonalConfigLayer,
    PersonalModelConfigRulesData, PersonalProviderConfigData, PersonalProviderConfigRulesData,
    ProviderConfigFileError,
};
