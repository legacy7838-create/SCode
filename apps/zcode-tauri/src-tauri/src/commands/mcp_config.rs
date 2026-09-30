//! Tauri commands for the three `PlatformChannels` that the MCP user-directory module served.
//!
//! Spec: docs/specs/rust-native-mcp-config.md §4.4.
//!
//! These three channels had no Rust implementation, so `createTauriPlatform()` fell back to the
//! `@zcode/web` shape — a silent wrong answer rather than a degraded one, which umbrella
//! invariant 1 forbids. They now call the ported engine directly.
//!
//! The error mapping is the load-bearing part: `saveCliMcpToUserDirectory` in the TypeScript
//! returned `{ success: false, error }` rather than throwing, and the renderer branches on
//! `success`, so a Tauri error must be shaped the same way rather than becoming a rejected
//! promise.

use serde::{Deserialize, Serialize};
use tauri::State;

use zcode_mcp_config::{
    load_from_user_directory, resolve_user_home_dir, set_server_enabled_in_file, upsert_server,
    SetEnabledRequest, UpsertAction, UpsertRequest,
};

use crate::AppState;

/// The `{ success: false, error }` envelope the renderer already handles.
///
/// Matches the legacy `saveCliMcpToUserDirectory` catch block verbatim, because the renderer
/// checks `success` before reading `error` (spec invariant 5).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SaveOutcome {
    fn ok() -> Self {
        SaveOutcome { success: true, error: None }
    }

    fn failed(error: impl std::fmt::Display) -> Self {
        SaveOutcome {
            success: false,
            error: Some(error.to_string()),
        }
    }
}

/// One server as the renderer receives it. Field names match `NativeMcpServerRecord` on the
/// TypeScript side so no renderer change is needed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRecordWire {
    pub name: String,
    pub config: serde_json::Value,
    pub source: String,
    pub scope: String,
}

/// `zcode:load-mcp-from-user-directory` — workspace scope first, then user.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoadRequest {
    /// When present, the workspace directory is read before the user directory.
    pub workspace_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub servers: Vec<ServerRecordWire>,
}

/// The home directory, resolved the same way the TypeScript did: `HOME`, then `USERPROFILE`,
/// then the OS account's home. Whitespace-only values fall through rather than producing a path
/// under a directory named " ".
/// `services::paths::homedir` already implements the `$HOME` then `%USERPROFILE%` chain with
/// the same whitespace rejection as the TypeScript, so it is reused as the fallback rather than
/// re-derived — a second home-resolution rule in this crate would be one more thing to keep in
/// step. The ported `resolve_user_home_dir` then applies the same chain again over it, which is
/// harmless and keeps the ported function the single definition of the rule.
fn home_dir() -> String {
    resolve_user_home_dir(
        std::env::var("HOME").ok().as_deref(),
        std::env::var("USERPROFILE").ok().as_deref(),
        &crate::services::paths::homedir(),
    )
}

/// `zcode:load-mcp-from-user-directory`
#[tauri::command]
pub fn load_mcp_from_user_directory(
    _state: State<'_, Arc<AppState>>,
    request: Option<LoadRequest>,
) -> Result<LoadResult, String> {
    let workspace_path = request.and_then(|r| r.workspace_path);
    let records = load_from_user_directory(workspace_path.as_deref(), &home_dir())
        .map_err(|error| error.to_string())?;
    Ok(LoadResult {
        servers: records
            .into_iter()
            .map(|record| ServerRecordWire {
                name: record.name,
                config: serde_json::Value::Object(record.config),
                source: record.source.to_string(),
                scope: record.scope.to_string(),
            })
            .collect(),
    })
}

/// `zcode:save-mcp-to-user-directory` — the `set-enabled` action.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum SaveRequest {
    #[serde(rename = "set-enabled")]
    SetEnabled {
        name: String,
        /// The legacy threw on a missing value; returning the failure shape keeps the renderer's
        /// single error path instead of adding a second one.
        enabled: Option<bool>,
        #[serde(rename = "projectPath")]
        project_path: Option<String>,
    },
    /// Upsert or remove a whole server entry.
    #[serde(rename = "upsert")]
    Upsert {
        name: String,
        config: Option<serde_json::Value>,
        #[serde(rename = "projectPath")]
        project_path: Option<String>,
    },
    #[serde(rename = "delete")]
    Delete {
        name: String,
        #[serde(rename = "projectPath")]
        project_path: Option<String>,
    },
}

/// `zcode:save-mcp-to-user-directory`
///
/// Returns the `{ success, error }` envelope rather than `Result`, because that is the shape the
/// TypeScript returned and the renderer branches on it. A transport-level failure (bad arguments)
/// still surfaces as an `Err`, which is a genuinely different condition.
#[tauri::command]
pub fn save_mcp_to_user_directory(
    _state: State<'_, Arc<AppState>>,
    payload: SaveRequest,
) -> Result<SaveOutcome, String> {
    let home = home_dir();
    let outcome = match payload {
        SaveRequest::SetEnabled {
            name,
            enabled,
            project_path,
        } => {
            let Some(enabled) = enabled else {
                return Ok(SaveOutcome::failed(
                    "Missing enabled value for MCP set-enabled action",
                ));
            };
            set_server_enabled_in_file(
                &SetEnabledRequest { name, enabled, project_path },
                &home,
            )
        }
        SaveRequest::Upsert { name, config, project_path } => {
            let Some(config) = config.and_then(|value| match value {
                serde_json::Value::Object(map) => Some(map),
                // The legacy checked `if (!payload.config)`, so a non-object config is
                // indistinguishable from a missing one here.
                _ => None,
            }) else {
                return Ok(SaveOutcome::failed("Missing MCP config for upsert action"));
            };
            upsert_server(
                &UpsertRequest {
                    action: UpsertAction::Upsert,
                    name,
                    config: Some(config),
                    project_path,
                },
                &home,
            )
        }
        SaveRequest::Delete { name, project_path } => upsert_server(
            &UpsertRequest {
                action: UpsertAction::Remove,
                name,
                config: None,
                project_path,
            },
            &home,
        ),
    };

    match outcome {
        Ok(()) => Ok(SaveOutcome::ok()),
        // A filesystem failure is a save failure, not a transport failure: the renderer already
        // handles this branch and shows the message.
        Err(error) => Ok(SaveOutcome::failed(error)),
    }
}

/// `zcode:migrate-legacy-common-mcp` — imports servers out of a legacy storage location.
///
/// The third channel, and a genuinely different operation from the other two: it mines an old
/// store.json or a LevelDB directory rather than reading or writing the current config. A first
/// draft re-read the current config under this name, which would have been a silently different
/// feature behind a familiar channel name — so it is now the real thing.
///
/// Candidate order and the store.json-first dispatch are the original's
/// (`legacy.ts:195-243`): the caller's `legacyStorageDir`, then `%APPDATA%\ai.z.zcode\store.json`,
/// then five LevelDB directories, deduped with first-occurrence order kept.
///
/// "Nothing found" is an empty result, not an error — most machines have no legacy data, and it
/// must not look like a failure.
#[tauri::command]
pub fn migrate_legacy_common_mcp(
    _state: State<'_, Arc<AppState>>,
    request: Option<MigrateRequest>,
) -> Result<MigrateOutcome, String> {
    let request = request.unwrap_or_default();
    let home = crate::services::paths::homedir();
    let result = zcode_mcp_config::migrate_legacy_common_mcp(
        request.legacy_storage_dir.as_deref(),
        // `??` semantics, reproduced: an empty-but-present variable is used, not skipped, so a
        // misconfigured machine searches the same (relative) place the TypeScript would have.
        std::env::var("LOCALAPPDATA").ok().as_deref(),
        std::env::var("APPDATA").ok().as_deref(),
        &home,
    )
    .map_err(|error| error.to_string())?;

    Ok(MigrateOutcome {
        servers: serde_json::Value::Object(result.servers),
        source_path: if result.source_path.is_empty() {
            None
        } else {
            Some(result.source_path)
        },
        total_count: result.total_count,
        imported_count: result.imported_count,
        skipped_count: result.skipped_count,
    })
}

/// `MigrateLegacyCommonMcpRequest`.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MigrateRequest {
    /// An explicit legacy directory to search before the derived candidates.
    pub legacy_storage_dir: Option<String>,
}

/// `MigrateLegacyCommonMcpResult`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateOutcome {
    pub servers: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    pub total_count: usize,
    pub imported_count: usize,
    pub skipped_count: usize,
}

use std::sync::Arc;
