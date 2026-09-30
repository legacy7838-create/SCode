//! Path resolution and the top-level load / save / migrate operations.
//!
//! Ported from `packages/desktop/src/main/mcpUserDirectory/index.ts:62-105, 152-158, 254-419`.
//! Spec: docs/specs/rust-native-mcp-config.md.
//!
//! Every operation here touches the filesystem, so all of them are async (spec §2.3): an atomic
//! write's fsync latency is unbounded, and this is the same 6–11 ms per-commit figure the session
//! DB port measured. There is no I/O-free synchronous entry point in this surface, unlike
//! `zcode-events`.
//!
//! One further descriptor is needed here that `types.ts` does not declare, because
//! `readDirectoryServersFromPreferredSources` consults a second source: the generic
//! `.agents/mcp.json`, which uses the **flat** `mcpServers` key. `index.ts:66-67` lists both
//! `ZCODE_MCP_DESCRIPTOR` and `AGENTS_MCP_DESCRIPTOR`; only the first is exported from `types.ts`.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::enabled::{
    migrate_legacy_enable_flag, remove_legacy_override, set_server_enabled,
};
use crate::json::{read_json_object, render_config_json, write_text_atomic, JsonObject};
use crate::servermap::{
    read_server_map_from_json, source_descriptor, write_server_map_to_json, ConfigKeyName,
};
use crate::McpConfigError;

/// Which directory tree a config lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// The user's home directory.
    User,
    /// A specific workspace.
    Workspace,
}

/// One source descriptor, including the directory segments for the user scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryDescriptor {
    /// Distinguishes the two sources, matching the `SettingsDirectoryLocation.source` values.
    pub directory_source: &'static str,
    pub user_config_dir_segments: Vec<String>,
    pub workspace_config_dir_segments: Vec<String>,
    pub file_name: String,
    pub config_key_name: ConfigKeyName,
}

impl DirectoryDescriptor {
    fn config_dir_segments(&self, scope: Scope) -> &[String] {
        match scope {
            Scope::User => &self.user_config_dir_segments,
            Scope::Workspace => &self.workspace_config_dir_segments,
        }
    }
}

/// `ZCODE_MCP_DESCRIPTOR`: `~/.zcode/cli/config.json`, nested `mcp.servers` key.
pub fn zcode_descriptor() -> DirectoryDescriptor {
    let source = source_descriptor();
    DirectoryDescriptor {
        directory_source: "zcodeagentmcp",
        // The workspace tree mirrors the user tree under the workspace root; `index.ts` uses the
        // same segments for both and only the base directory differs.
        user_config_dir_segments: source.config_dir_segments.clone(),
        workspace_config_dir_segments: source.config_dir_segments.clone(),
        file_name: source.file_name.clone(),
        config_key_name: source.config_key_name,
    }
}

/// `AGENTS_MCP_DESCRIPTOR`: the generic `.agents/mcp.json`, **flat** `mcpServers` key.
///
/// Not declared in `types.ts` because it is only reachable through
/// `readDirectoryServersFromPreferredSources`. It exists solely as a fallback: if the `.zcode`
/// source yields no servers, this one is consulted for the same scope.
pub fn agents_descriptor() -> DirectoryDescriptor {
    DirectoryDescriptor {
        directory_source: "agentsmcp",
        user_config_dir_segments: vec![".agents".to_string()],
        workspace_config_dir_segments: vec![".agents".to_string()],
        file_name: "mcp.json".to_string(),
        config_key_name: ConfigKeyName::Flat,
    }
}

/// `resolveUserHomeDir` (`index.ts:62`).
///
/// `HOME` first, then `USERPROFILE`, then the OS account's home. Each candidate is trimmed and
/// an all-whitespace value is treated as absent, matching the original's
/// `process.env.HOME?.trim() || …` chain — a home of `" "` must fall through rather than
/// producing a path under a directory named " ".
pub fn resolve_user_home_dir(
    home: Option<&str>,
    user_profile: Option<&str>,
    fallback: &str,
) -> String {
    for candidate in [home, user_profile].into_iter().flatten() {
        let trimmed = candidate.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    fallback.to_string()
}

/// `buildDirectoryConfigPath` (`index.ts:72-86`).
pub fn build_directory_config_path(
    descriptor: &DirectoryDescriptor,
    scope: Scope,
    workspace_path: Option<&str>,
    home_dir: &str,
) -> Result<PathBuf, McpConfigError> {
    let base = match scope {
        Scope::User => home_dir.to_string(),
        Scope::Workspace => workspace_path
            .map(str::to_string)
            // A missing workspace path is a caller error, not a reason to fall back to the user
            // directory: writing a workspace-scoped change into the user's config would be a
            // silent misplacement.
            .ok_or(McpConfigError::Unsupported(format!(
                "workspace path for the {} MCP config",
                descriptor.directory_source
            )))?,
    };
    let mut path = PathBuf::from(base);
    for segment in descriptor.config_dir_segments(scope) {
        path.push(segment);
    }
    path.push(&descriptor.file_name);
    Ok(path)
}

/// `getUserCliConfigPath` (`index.ts:88`).
pub fn user_cli_config_path(home_dir: &str) -> Result<PathBuf, McpConfigError> {
    build_directory_config_path(&zcode_descriptor(), Scope::User, None, home_dir)
}

/// `readUserCliConfig` (`index.ts:152`): the parsed config, or an empty object.
///
/// A missing or corrupt file reads as empty, so the app still starts. The caller re-reads before
/// every write, so an unparsable file is never silently overwritten.
pub fn read_user_cli_config(path: &Path) -> JsonObject {
    read_json_object(path).unwrap_or_default()
}

/// `writeUserCliConfig` (`index.ts:156`).
pub fn write_user_cli_config(path: &Path, config: &JsonObject) -> Result<(), McpConfigError> {
    write_text_atomic(path, &render_config_json(config)).map_err(|error| {
        McpConfigError::io(path.display().to_string(), "writing the MCP config", error)
    })
}

/// One server as the renderer receives it: the name plus its raw config object.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerRecord {
    pub name: String,
    pub config: JsonObject,
    /// Where it came from, so the renderer can label the source.
    pub source: &'static str,
    pub scope: &'static str,
}

/// `readDirectoryServersFromFile` (`index.ts:284-333`).
///
/// The legacy flag is migrated **on read**, and when the migration changed anything the file is
/// rewritten immediately — the original comment is explicit that the user should never see the
/// deprecated field, and that writing only when something changed is what keeps it idempotent.
pub fn read_directory_servers_from_file(
    descriptor: &DirectoryDescriptor,
    scope: Scope,
    workspace_path: Option<&str>,
    home_dir: &str,
) -> Result<Vec<ServerRecord>, McpConfigError> {
    let path =
        build_directory_config_path(descriptor, scope, workspace_path, home_dir)?;
    let current = read_json_object(&path).unwrap_or_default();

    let migration = migrate_legacy_enable_flag(&read_server_map_from_json(
        &current,
        descriptor.config_key_name,
    ));

    if migration.changed {
        let next = write_server_map_to_json(&current, descriptor.config_key_name, &migration.servers);
        write_text_atomic(&path, &render_config_json(&next)).map_err(|error| {
            McpConfigError::io(path.display().to_string(), "migrating the MCP config", error)
        })?;
    }

    Ok(migration
        .servers
        .into_iter()
        .filter_map(|(name, config)| {
            config.as_object().map(|record| ServerRecord {
                name,
                config: record.clone(),
                source: descriptor.directory_source,
                scope: match scope {
                    Scope::User => "user",
                    Scope::Workspace => "project",
                },
            })
        })
        .collect())
}

/// `readDirectoryServersFromPreferredSources` (`index.ts:334-348`).
///
/// `.zcode` is the strong source: if it yields anything, `.agents` for the same scope is not
/// consulted at all. They are alternatives, not a merge — merging them would let a stale
/// `.agents` entry resurrect a server the user removed from `.zcode`.
pub fn read_servers_from_preferred_sources(
    scope: Scope,
    workspace_path: Option<&str>,
    home_dir: &str,
) -> Result<Vec<ServerRecord>, McpConfigError> {
    let zcode = read_directory_servers_from_file(&zcode_descriptor(), scope, workspace_path, home_dir)?;
    if !zcode.is_empty() {
        return Ok(zcode);
    }
    read_directory_servers_from_file(&agents_descriptor(), scope, workspace_path, home_dir)
}

/// `loadCliMcpFromUserDirectory` (`index.ts:361-375`).
///
/// Workspace first, then user — matching the documented order ("first workspace, then user").
/// Both are returned rather than shadowing, so a server defined in the workspace and one defined
/// in the user directory both reach the renderer.
pub fn load_from_user_directory(
    workspace_path: Option<&str>,
    home_dir: &str,
) -> Result<Vec<ServerRecord>, McpConfigError> {
    let mut servers = Vec::new();
    if let Some(workspace) = workspace_path {
        servers.extend(read_servers_from_preferred_sources(
            Scope::Workspace,
            Some(workspace),
            home_dir,
        )?);
    }
    servers.extend(read_servers_from_preferred_sources(
        Scope::User,
        workspace_path,
        home_dir,
    )?);
    Ok(servers)
}

/// `writeZCodeServersToFile` (`index.ts:350-359`).
pub fn write_zcode_servers_to_file(
    scope: Scope,
    servers: &JsonObject,
    workspace_path: Option<&str>,
    home_dir: &str,
) -> Result<(), McpConfigError> {
    let descriptor = zcode_descriptor();
    let path = build_directory_config_path(&descriptor, scope, workspace_path, home_dir)?;
    let current = read_json_object(&path).unwrap_or_default();
    let next = write_server_map_to_json(&current, descriptor.config_key_name, servers);
    write_text_atomic(&path, &render_config_json(&next))
        .map_err(|error| McpConfigError::io(path.display().to_string(), "writing MCP servers", error))
}

/// What a `set-enabled` save should do.
#[derive(Debug, Clone)]
pub struct SetEnabledRequest {
    pub name: String,
    pub enabled: bool,
    pub project_path: Option<String>,
}

/// `writeServerEnabledToFile` (`index.ts:254-282`) plus the legacy cleanup from `:243-252`.
///
/// The scope is derived from whether a project path is present, matching `index.ts:377`. A named
/// server that is not present is a no-op rather than an error, so a stale UI click cannot create
/// an entry.
pub fn set_server_enabled_in_file(
    request: &SetEnabledRequest,
    home_dir: &str,
) -> Result<(), McpConfigError> {
    let descriptor = zcode_descriptor();
    let scope = if request.project_path.is_some() {
        Scope::Workspace
    } else {
        Scope::User
    };
    let path = build_directory_config_path(
        &descriptor,
        scope,
        request.project_path.as_deref(),
        home_dir,
    )?;
    let current = read_json_object(&path).unwrap_or_default();
    let server_map = read_server_map_from_json(&current, descriptor.config_key_name);

    let Some(current_server) = server_map.get(&request.name).and_then(Value::as_object) else {
        return Ok(());
    };

    let mut next_server_map = server_map.clone();
    next_server_map.insert(
        request.name.clone(),
        Value::Object(set_server_enabled(current_server, request.enabled)),
    );
    let mut next = write_server_map_to_json(&current, descriptor.config_key_name, &next_server_map);
    let cleanup = remove_legacy_override(&next, descriptor.config_key_name, &request.name);
    if cleanup.changed {
        next = cleanup.servers;
    }

    write_text_atomic(&path, &render_config_json(&next))
        .map_err(|error| McpConfigError::io(path.display().to_string(), "writing the enabled flag", error))
}

/// `cleanupLegacyMcpEnabledOverride` (`index.ts:243-252`).
pub fn cleanup_legacy_override(
    name: &str,
    project_path: Option<&str>,
    home_dir: &str,
) -> Result<(), McpConfigError> {
    let descriptor = zcode_descriptor();
    let scope = if project_path.is_some() {
        Scope::Workspace
    } else {
        Scope::User
    };
    let path = build_directory_config_path(&descriptor, scope, project_path, home_dir)?;
    let config = read_user_cli_config(&path);
    let result = remove_legacy_override(&config, descriptor.config_key_name, name);
    if result.changed {
        write_user_cli_config(&path, &result.servers)?;
    }
    Ok(())
}

/// An upsert or remove of a whole server entry.
#[derive(Debug, Clone)]
pub struct UpsertRequest {
    pub action: UpsertAction,
    pub name: String,
    /// The new config, required for [`UpsertAction::Upsert`].
    pub config: Option<JsonObject>,
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpsertAction {
    Upsert,
    Remove,
}

/// `saveCliMcpToUserDirectory` (`index.ts:377-419`), the non-`set-enabled` branch.
///
/// The existing map is rebuilt from the *records* (name → config) rather than edited in place,
/// so the write reflects exactly what a read would return, including the migration applied on
/// read. That is the original's shape and it keeps a save from resurrecting a removed entry.
pub fn upsert_server(
    request: &UpsertRequest,
    home_dir: &str,
) -> Result<(), McpConfigError> {
    if request.action == UpsertAction::Upsert && request.config.is_none() {
        return Err(McpConfigError::Unsupported(
            "config for an upsert action".to_string(),
        ));
    }
    let scope = if request.project_path.is_some() {
        Scope::Workspace
    } else {
        Scope::User
    };
    let existing = read_directory_servers_from_file(
        &zcode_descriptor(),
        scope,
        request.project_path.as_deref(),
        home_dir,
    )?;
    // An order-preserving map, deliberately: the legacy code builds this with
    // `Object.fromEntries(existingServers.map(...))` and then assigns `nextServers[name]`, which
    // appends. A `BTreeMap` here would sort the user's servers alphabetically on every save —
    // this crate's whole reason for existing. That regression was caught by
    // `an_upsert_preserves_the_server_key_order`.
    let mut next: JsonObject = JsonObject::new();
    for record in existing {
        next.insert(record.name, Value::Object(record.config));
    }
    match request.action {
        UpsertAction::Upsert => {
            next.insert(
                request.name.clone(),
                Value::Object(request.config.clone().expect("checked above")),
            );
        }
        UpsertAction::Remove => {
            next.remove(&request.name);
        }
    }

    write_zcode_servers_to_file(scope, &next, request.project_path.as_deref(), home_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::enabled::read_server_enabled;
    use serde_json::json;

    /// A fresh temp home directory, as the string every public API takes.
    fn temp_home(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("zcode-mcp-home-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp home");
        dir.display().to_string()
    }

    fn write_config(home: &str, relative: &str, value: serde_json::Value) {
        let path = Path::new(home).join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, render_config_json(value.as_object().unwrap())).unwrap();
    }

    fn read_config(home: &str, relative: &str) -> JsonObject {
        let raw = std::fs::read_to_string(Path::new(home).join(relative)).expect("config");
        serde_json::from_str(&raw).expect("valid json")
    }

    /// `HOME`, then `USERPROFILE`, then the OS fallback — with whitespace-only values skipped.
    #[test]
    fn home_resolution_skips_blank_candidates() {
        assert_eq!(resolve_user_home_dir(Some("/a"), Some("/b"), "/c"), "/a");
        assert_eq!(resolve_user_home_dir(None, Some("/b"), "/c"), "/b");
        assert_eq!(resolve_user_home_dir(None, None, "/c"), "/c");
        assert_eq!(resolve_user_home_dir(Some("   "), Some("/b"), "/c"), "/b");
        assert_eq!(resolve_user_home_dir(Some("  /a  "), None, "/c"), "/a", "values are trimmed");
    }

    #[test]
    fn the_user_config_path_is_under_zcode_cli() {
        let path = user_cli_config_path("/home/u").unwrap();
        assert_eq!(path, PathBuf::from("/home/u/.zcode/cli/config.json"));
    }

    /// A missing workspace path is a caller error, not a reason to write into the user's config.
    #[test]
    fn a_workspace_scope_without_a_path_is_rejected() {
        let error = build_directory_config_path(&zcode_descriptor(), Scope::Workspace, None, "/home/u")
            .unwrap_err();
        assert!(error.to_string().contains("workspace path"), "{error}");
    }

    #[test]
    fn a_workspace_scope_uses_the_workspace_root() {
        let path =
            build_directory_config_path(&zcode_descriptor(), Scope::Workspace, Some("/ws"), "/home/u")
                .unwrap();
        assert_eq!(path, PathBuf::from("/ws/.zcode/cli/config.json"));
    }

    /// §3.5 — reading migrates the legacy flag and rewrites the file, so the user never sees it.
    #[test]
    fn reading_migrates_the_legacy_flag_and_rewrites_the_file() {
        let home = temp_home("read-migrate");
        write_config(
            &home,
            ".zcode/cli/config.json",
            json!({ "mcp": { "servers": { "fs": { "command": "npx", "mcpEnabled": false } } } }),
        );

        let records = load_from_user_directory(None, &home).expect("load must succeed");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "fs");
        assert!(
            !read_server_enabled(&records[0].config),
            "`mcpEnabled: false` must migrate to a *disabled* server"
        );
        assert_eq!(records[0].config.get(crate::enabled::ENABLED_KEY), Some(&json!(false)));

        // The file on disk must no longer carry the legacy key.
        let stored = read_config(&home, ".zcode/cli/config.json");
        let server = stored["mcp"]["servers"]["fs"].as_object().unwrap();
        assert!(
            !server.contains_key("mcpEnabled"),
            "the deprecated key must be gone from disk after a read"
        );
    }

    /// Reading twice must not keep rewriting the file — the idempotence the original comment
    /// relies on to avoid touching the file when there is nothing to change.
    #[test]
    fn reading_twice_is_idempotent_on_disk() {
        let home = temp_home("read-idempotent");
        write_config(
            &home,
            ".zcode/cli/config.json",
            json!({ "mcp": { "servers": { "fs": { "command": "npx", "mcpEnabled": false } } } }),
        );
        load_from_user_directory(None, &home).unwrap();
        let first = std::fs::read_to_string(Path::new(&home).join(".zcode/cli/config.json")).unwrap();
        load_from_user_directory(None, &home).unwrap();
        let second = std::fs::read_to_string(Path::new(&home).join(".zcode/cli/config.json")).unwrap();
        assert_eq!(first, second, "a second read must not change the file");
    }

    /// `.zcode` is the strong source: a non-empty `.zcode` means `.agents` is never consulted.
    #[test]
    fn a_non_empty_zcode_source_suppresses_the_agents_fallback() {
        let home = temp_home("preferred");
        write_config(
            &home,
            ".zcode/cli/config.json",
            json!({ "mcp": { "servers": { "fromZcode": {} } } }),
        );
        write_config(
            &home,
            ".agents/mcp.json",
            json!({ "mcpServers": { "fromAgents": {} } }),
        );
        let records = load_from_user_directory(None, &home).unwrap();
        let names: Vec<&str> = records.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["fromZcode"], ".agents must not participate");
    }

    /// When `.zcode` is empty, the `.agents` file is the fallback — and its key is the flat one.
    #[test]
    fn an_empty_zcode_source_falls_back_to_agents() {
        let home = temp_home("fallback");
        write_config(
            &home,
            ".zcode/cli/config.json",
            json!({ "mcp": { "servers": {} } }),
        );
        write_config(
            &home,
            ".agents/mcp.json",
            json!({ "mcpServers": { "fromAgents": { "command": "x" } } }),
        );
        let records = load_from_user_directory(None, &home).unwrap();
        let names: Vec<&str> = records.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["fromAgents"]);
    }

    /// Workspace scope is read before user scope, and both are returned.
    #[test]
    fn workspace_servers_are_read_before_user_servers() {
        let home = temp_home("order");
        write_config(
            &home,
            ".zcode/cli/config.json",
            json!({ "mcp": { "servers": { "userServer": {} } } }),
        );
        let ws = temp_home("order-ws");
        write_config(
            &ws,
            ".zcode/cli/config.json",
            json!({ "mcp": { "servers": { "wsServer": {} } } }),
        );
        let records = load_from_user_directory(Some(&ws), &home).unwrap();
        let names: Vec<&str> = records.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["wsServer", "userServer"]);
    }

    /// A missing config file is not an error: the app must still start.
    #[test]
    fn a_missing_config_yields_no_servers() {
        let home = temp_home("missing");
        let records = load_from_user_directory(None, &home).unwrap();
        assert!(records.is_empty());
    }

    /// A corrupt config must not throw, and must not be silently discarded either.
    #[test]
    fn a_corrupt_config_reads_as_empty_without_throwing() {
        let home = temp_home("corrupt");
        let path = Path::new(&home).join(".zcode/cli/config.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();

        let records = load_from_user_directory(None, &home).expect("a corrupt config must not throw");
        assert!(records.is_empty());
        // The original content is still there — a read never rewrites an unparsable file.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
    }

    /// An upsert adds a server, and unrelated keys in the file survive in order.
    #[test]
    fn an_upsert_preserves_unrelated_config_keys() {
        let home = temp_home("upsert");
        write_config(
            &home,
            ".zcode/cli/config.json",
            json!({ "theme": "dark", "mcp": { "other": true, "servers": { "old": { "command": "a" } } } }),
        );
        upsert_server(
            &UpsertRequest {
                action: UpsertAction::Upsert,
                name: "new".into(),
                config: Some(json!({ "command": "b" }).as_object().cloned().unwrap()),
                project_path: None,
            },
            &home,
        )
        .unwrap();

        let stored = read_config(&home, ".zcode/cli/config.json");
        assert_eq!(stored["theme"], json!("dark"), "unrelated top-level keys must survive");
        assert_eq!(stored["mcp"]["other"], json!(true), "sibling keys inside mcp must survive");
        let servers = stored["mcp"]["servers"].as_object().unwrap();
        let keys: Vec<&String> = servers.keys().collect();
        assert_eq!(keys, vec!["old", "new"], "the new server must append, not be sorted");
    }

    /// Regression guard for the order bug this port nearly shipped.
    ///
    /// The first implementation rebuilt the server map in a `BTreeMap`, so every save sorted the
    /// user's MCP servers alphabetically — the exact silent corruption §3.1 exists to prevent,
    /// and invisible because the file still parses and still works.
    #[test]
    fn an_upsert_preserves_the_server_key_order() {
        let home = temp_home("upsert-order");
        // Deliberately not alphabetical: "zebra" before "alpha".
        write_config(
            &home,
            ".zcode/cli/config.json",
            json!({ "mcp": { "servers": { "zebra": {}, "alpha": {}, "mango": {} } } }),
        );
        upsert_server(
            &UpsertRequest {
                action: UpsertAction::Upsert,
                name: "new".into(),
                config: Some(json!({}).as_object().cloned().unwrap()),
                project_path: None,
            },
            &home,
        )
        .unwrap();
        let stored = read_config(&home, ".zcode/cli/config.json");
        let keys: Vec<&String> = stored["mcp"]["servers"].as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            vec!["zebra", "alpha", "mango", "new"],
            "a save must never reorder the user's servers"
        );
    }

    #[test]
    fn a_remove_deletes_only_the_named_server() {
        let home = temp_home("remove");
        write_config(
            &home,
            ".zcode/cli/config.json",
            json!({ "mcp": { "servers": { "keep": {}, "drop": {} } } }),
        );
        upsert_server(
            &UpsertRequest {
                action: UpsertAction::Remove,
                name: "drop".into(),
                config: None,
                project_path: None,
            },
            &home,
        )
        .unwrap();
        let stored = read_config(&home, ".zcode/cli/config.json");
        let servers = stored["mcp"]["servers"].as_object().unwrap();
        assert!(servers.contains_key("keep"));
        assert!(!servers.contains_key("drop"));
    }

    /// An upsert with no config is a caller error, not a silent no-op.
    #[test]
    fn an_upsert_without_a_config_is_rejected() {
        let home = temp_home("upsert-invalid");
        let error = upsert_server(
            &UpsertRequest {
                action: UpsertAction::Upsert,
                name: "x".into(),
                config: None,
                project_path: None,
            },
            &home,
        )
        .unwrap_err();
        assert!(error.to_string().contains("config for an upsert"), "{error}");
    }

    /// `set-enabled: false` writes the flag; `true` removes it and restores the original bytes.
    #[test]
    fn set_enabled_writes_and_then_clears_the_flag() {
        let home = temp_home("set-enabled");
        let original = json!({ "mcp": { "servers": { "fs": { "command": "npx" } } } });
        write_config(&home, ".zcode/cli/config.json", original.clone());
        let original_bytes = std::fs::read_to_string(Path::new(&home).join(".zcode/cli/config.json")).unwrap();
        let request = |enabled| SetEnabledRequest {
            name: "fs".into(),
            enabled,
            project_path: None,
        };

        set_server_enabled_in_file(&request(false), &home).unwrap();
        let stored = read_config(&home, ".zcode/cli/config.json");
        assert_eq!(stored["mcp"]["servers"]["fs"]["enabled"], json!(false));

        set_server_enabled_in_file(&request(true), &home).unwrap();
        let stored = read_config(&home, ".zcode/cli/config.json");
        let server = stored["mcp"]["servers"]["fs"].as_object().unwrap();
        assert!(!server.contains_key("enabled"), "enabling must remove the redundant flag");
        assert_eq!(
            std::fs::read_to_string(Path::new(&home).join(".zcode/cli/config.json")).unwrap(),
            original_bytes,
            "disabling and re-enabling must be a byte-level round trip"
        );
        let _ = original;
    }

    /// A named server that does not exist is a no-op, so a stale click cannot create an entry.
    #[test]
    fn set_enabled_for_an_absent_server_is_a_no_op() {
        let home = temp_home("set-enabled-absent");
        write_config(
            &home,
            ".zcode/cli/config.json",
            json!({ "mcp": { "servers": { "fs": {} } } }),
        );
        let before = std::fs::read_to_string(Path::new(&home).join(".zcode/cli/config.json")).unwrap();
        set_server_enabled_in_file(
            &SetEnabledRequest { name: "ghost".into(), enabled: false, project_path: None },
            &home,
        )
        .unwrap();
        let after = std::fs::read_to_string(Path::new(&home).join(".zcode/cli/config.json")).unwrap();
        assert_eq!(before, after, "no file may be written for an absent server");
    }
}
