//! `zcode-mcp-config` — MCP user-directory configuration.
//!
//! Spec: docs/specs/rust-native-mcp-config.md.
//!
//! Ported from `packages/desktop/src/main/mcpUserDirectory/` (751 lines of TypeScript across
//! four files) because the Tauri host cannot serve the three `PlatformChannels` that depend on
//! it, and currently falls back to the `@zcode/web` implementation — a silent wrong answer
//! rather than a degraded one, which umbrella invariant 1 forbids.
//!
//! This crate is **rlib-only**: the consumer is the Tauri host, a Rust process that cannot
//! `require()` a `.node`, and there is no Node consumer, so no cdylib is produced and nothing is
//! staged into the desktop or SEA payload (spec D2).
//!
//! The risk in this port is not speed and not an ABI — it is **the bytes written to a config
//! file the user edits by hand**. Key order, the two-space indent, the trailing newline and the
//! same-directory temp file are all load-bearing, and each has a byte-level test.

pub mod config;
pub mod enabled;
pub mod json;
pub mod servermap;

pub use config::{
    agents_descriptor, build_directory_config_path, cleanup_legacy_override, load_from_user_directory,
    read_directory_servers_from_file, read_servers_from_preferred_sources, read_user_cli_config,
    resolve_user_home_dir, set_server_enabled_in_file, upsert_server, user_cli_config_path,
    write_user_cli_config, write_zcode_servers_to_file, DirectoryDescriptor, Scope, ServerRecord,
    SetEnabledRequest, UpsertAction, UpsertRequest,
};
pub use enabled::{
    migrate_legacy_enable_flag, read_server_enabled, remove_legacy_override, set_server_enabled,
    MigrationResult, ENABLED_KEY, LEGACY_ENABLE_KEY,
};
pub use json::{
    is_record, normalize_server_map, read_json_object, render_config_json, write_text_atomic,
    JsonObject,
};
pub use servermap::{
    read_server_map_from_json, source_descriptor, write_server_map_to_json, ConfigKeyName,
    SourceDescriptor,
};

/// Failures the surface can produce.
///
/// Typed rather than stringly-typed so the Tauri command layer can map them to the
/// `{ success: false, error }` shape the renderer branches on, without matching on message text
/// (spec §6, invariant 5).
#[derive(Debug)]
pub enum McpConfigError {
    /// A read or write failed at the OS level.
    Io {
        path: String,
        operation: &'static str,
        source: std::io::Error,
    },
    /// A caller supplied a source or scope this build does not know about.
    Unsupported(String),
    /// A required environment value (the home directory) was unavailable.
    MissingEnv(&'static str),
}

impl std::fmt::Display for McpConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpConfigError::Io {
                path,
                operation,
                source,
            } => write!(f, "{operation} failed for {path}: {source}"),
            McpConfigError::Unsupported(what) => write!(f, "unsupported MCP {what}"),
            McpConfigError::MissingEnv(name) => write!(f, "{name} is not set"),
        }
    }
}

impl std::error::Error for McpConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            McpConfigError::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl McpConfigError {
    /// Attach path and operation context to an IO error.
    pub fn io(path: impl Into<String>, operation: &'static str, source: std::io::Error) -> Self {
        McpConfigError::Io {
            path: path.into(),
            operation,
            source,
        }
    }
}
