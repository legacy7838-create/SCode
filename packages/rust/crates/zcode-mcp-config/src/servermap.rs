//! The MCP server map: reading it out of a config and writing it back without disturbing
//! anything else in the file.
//!
//! Ported from `packages/desktop/src/main/mcpUserDirectory/index.ts:106-150`.
//! Spec: docs/specs/rust-native-mcp-config.md §3.
//!
//! Two properties are load-bearing and are the reason this is a port rather than a rewrite:
//!
//! * **Key order.** `{ ...current, [key]: servers }` keeps every existing key in place and
//!   appends only new ones. Getting this wrong re-sorts the user's config.
//! * **The `mcp.servers` special case.** That key nests one level (`{ mcp: { servers } }`)
//!   while every other key is flat. Getting it backwards writes a literal `"mcp.servers"` key
//!   that nothing reads — silent loss of the user's MCP setup.

use crate::json::JsonObject;

/// Which key inside a config file holds the server map.
///
/// `mcp.servers` is the `zcode` CLI `config.json` shape (nested); `mcpServers` is the generic
/// directory format `.agents/mcp.json` (flat). Mirrors `McpConfigKeyName` in `types.ts:12`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigKeyName {
    /// Nested one level under `mcp`.
    Nested,
    /// A flat top-level key.
    Flat,
}

impl ConfigKeyName {
    /// The literal key as it appears in the file, for logs and error messages.
    pub fn as_str(self) -> &'static str {
        match self {
            ConfigKeyName::Nested => "mcp.servers",
            ConfigKeyName::Flat => "mcpServers",
        }
    }
}

/// The segment path under a scope directory, and the file name, for one MCP source.
///
/// Mirrors `McpSourceDescriptor` (`types.ts:16-22`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceDescriptor {
    /// Directory segments below the scope root, e.g. `[".zcode", "cli"]`.
    pub config_dir_segments: Vec<String>,
    pub file_name: String,
    pub config_key_name: ConfigKeyName,
}

/// The one source this build ships, matching `MCP_SOURCE_DESCRIPTORS` (`types.ts:24-32`).
///
/// A `const fn` cannot build a `Vec`, so this is a function. It returns a fresh value per call
/// because the caller may move the segments into a path.
pub fn source_descriptor() -> SourceDescriptor {
    SourceDescriptor {
        config_dir_segments: vec![".zcode".to_string(), "cli".to_string()],
        file_name: "config.json".to_string(),
        config_key_name: ConfigKeyName::Nested,
    }
}

/// `readServerMapFromJson` (`index.ts:106-123`): pull the server map out of a parsed config.
///
/// Every failure path yields an empty map rather than an error, matching the original: a config
/// whose `mcp` key is an array, a string, or absent simply has no servers. Note the original
/// returns the *raw* nested object without the per-entry `isRecord` filter that
/// `normalizeServerMap` applies elsewhere; that asymmetry is preserved, because changing it would
/// change which keys survive a round trip.
pub fn read_server_map_from_json(
    parsed: &JsonObject,
    config_key_name: ConfigKeyName,
) -> JsonObject {
    match config_key_name {
        ConfigKeyName::Nested => {
            let Some(mcp) = parsed.get("mcp") else {
                return JsonObject::new();
            };
            if !mcp.is_object() {
                return JsonObject::new();
            }
            match mcp.as_object().and_then(|m| m.get("servers")) {
                Some(serde_json::Value::Object(servers)) => servers.clone(),
                _ => JsonObject::new(),
            }
        }
        ConfigKeyName::Flat => match parsed.get(config_key_name.as_str()) {
            Some(serde_json::Value::Object(map)) => map.clone(),
            _ => JsonObject::new(),
        },
    }
}

/// `writeServerMapToJson` (`index.ts:127-150`): put the server map back, leaving everything
/// else in the file exactly where it was.
///
/// The nested branch is the reason this function exists in its own right: `mcp.servers` must be
/// written as `{ mcp: { ...currentMcp, servers } }`, and getting it backwards produces a config
/// no reader understands.
pub fn write_server_map_to_json(
    current: &JsonObject,
    config_key_name: ConfigKeyName,
    servers: &JsonObject,
) -> JsonObject {
    let servers_value = serde_json::Value::Object(servers.clone());
    match config_key_name {
        // A flat key: spread the current object, then set it.
        ConfigKeyName::Flat => {
            let mut next = current.clone();
            next.insert(config_key_name.as_str().to_string(), servers_value);
            next
        }
        // Nested: spread the current object, then merge one level down.
        ConfigKeyName::Nested => {
            let mut next = current.clone();
            // `current.mcp` is used only when it is a plain object; anything else (array, null,
            // scalar) is replaced by a fresh object, exactly as the original's
            // `Array.isArray` guard does.
            let mut mcp = next
                .get("mcp")
                .and_then(|value| value.as_object())
                .cloned()
                .unwrap_or_default();
            mcp.insert("servers".to_string(), servers_value);
            next.insert("mcp".to_string(), serde_json::Value::Object(mcp));
            next
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(value: serde_json::Value) -> JsonObject {
        value.as_object().cloned().expect("an object")
    }

    /// §3.4 — the nested key must nest. A flat `"mcp.servers"` key is unreadable corruption.
    #[test]
    fn the_nested_key_is_written_under_mcp() {
        let current = obj(json!({ "other": 1 }));
        let servers = obj(json!({ "fs": { "command": "npx" } }));
        let next = write_server_map_to_json(&current, ConfigKeyName::Nested, &servers);

        assert!(next.contains_key("mcp"), "must nest under `mcp`");
        assert!(
            !next.contains_key("mcp.servers"),
            "a literal \"mcp.servers\" key is the corruption this guards against"
        );
        assert_eq!(next["mcp"]["servers"], json!({ "fs": { "command": "npx" } }));
        assert_eq!(next["other"], json!(1), "unrelated keys must survive");
    }

    /// The flat key is genuinely flat.
    #[test]
    fn the_flat_key_is_written_at_the_top_level() {
        let current = obj(json!({ "other": 1 }));
        let servers = obj(json!({ "fs": {} }));
        let next = write_server_map_to_json(&current, ConfigKeyName::Flat, &servers);
        assert!(next.contains_key("mcpServers"));
        assert!(!next.contains_key("mcp"), "the flat format must not nest");
    }

    /// §3.1 — writing must not reorder the user's keys.
    #[test]
    fn writing_preserves_the_existing_key_order() {
        let current = obj(json!({ "zebra": 1, "alpha": 2, "mango": 3 }));
        let servers = obj(json!({ "fs": {} }));
        let next = write_server_map_to_json(&current, ConfigKeyName::Flat, &servers);
        let keys: Vec<&String> = next.keys().collect();
        assert_eq!(
            keys,
            vec!["zebra", "alpha", "mango", "mcpServers"],
            "existing keys must keep their positions and the new one must append"
        );
    }

    /// The nested branch must likewise leave the outer order alone and only append `mcp`.
    #[test]
    fn the_nested_branch_also_preserves_outer_order() {
        let current = obj(json!({ "zebra": 1, "alpha": 2 }));
        let servers = obj(json!({ "fs": {} }));
        let next = write_server_map_to_json(&current, ConfigKeyName::Nested, &servers);
        let keys: Vec<&String> = next.keys().collect();
        assert_eq!(keys, vec!["zebra", "alpha", "mcp"]);
    }

    /// Sibling keys inside `mcp` must survive, in order.
    #[test]
    fn sibling_keys_inside_mcp_survive() {
        let current = obj(json!({ "mcp": { "zeta": 1, "beta": 2 } }));
        let servers = obj(json!({ "fs": {} }));
        let next = write_server_map_to_json(&current, ConfigKeyName::Nested, &servers);
        let mcp_keys: Vec<&String> = next["mcp"].as_object().unwrap().keys().collect();
        assert_eq!(
            mcp_keys,
            vec!["zeta", "beta", "servers"],
            "siblings keep their order and `servers` appends"
        );
    }

    /// A `mcp` value of the wrong shape is replaced, not merged into — matching the original's
    /// `Array.isArray(mcp)` guard.
    #[test]
    fn a_non_object_mcp_value_is_replaced() {
        for wrong in [json!([]), json!("nope"), json!(5), serde_json::Value::Null] {
            let current = obj(json!({ "mcp": wrong.clone() }));
            let servers = obj(json!({ "fs": {} }));
            let next = write_server_map_to_json(&current, ConfigKeyName::Nested, &servers);
            assert_eq!(
                next["mcp"].as_object().map(|m| m.len()),
                Some(1),
                "`mcp` was {wrong} and must be replaced by a fresh object"
            );
        }
    }

    /// Reading tolerates every malformed shape and yields an empty map, never an error.
    #[test]
    fn reading_tolerates_malformed_shapes() {
        let empty = JsonObject::new();
        assert_eq!(read_server_map_from_json(&empty, ConfigKeyName::Nested).len(), 0);
        assert_eq!(read_server_map_from_json(&empty, ConfigKeyName::Flat).len(), 0);

        for wrong in [json!([]), json!("x"), json!(1), serde_json::Value::Null] {
            let current = obj(json!({ "mcp": wrong.clone() }));
            assert_eq!(
                read_server_map_from_json(&current, ConfigKeyName::Nested).len(),
                0,
                "`mcp` = {wrong} must read as empty"
            );
        }
        // `servers` present but of the wrong type.
        let current = obj(json!({ "mcp": { "servers": [] } }));
        assert_eq!(read_server_map_from_json(&current, ConfigKeyName::Nested).len(), 0);
    }

    /// Reading preserves file order, which is what makes a later write order-stable.
    #[test]
    fn reading_preserves_file_order() {
        let current = obj(json!({ "mcp": { "servers": { "z": {}, "a": {}, "m": {} } } }));
        let map = read_server_map_from_json(&current, ConfigKeyName::Nested);
        let keys: Vec<&String> = map.keys().collect();
        assert_eq!(keys, vec!["z", "a", "m"]);
    }

    /// A full read → write → read round trip must be a fixed point.
    #[test]
    fn a_round_trip_is_a_fixed_point() {
        let raw = r#"{"mcp":{"other":true,"servers":{"z":{"command":"a"},"a":{"command":"b"}}},"tail":1}"#;
        let current: JsonObject = serde_json::from_str(raw).expect("valid json");
        let servers = read_server_map_from_json(&current, ConfigKeyName::Nested);
        let next = write_server_map_to_json(&current, ConfigKeyName::Nested, &servers);

        assert_eq!(next, current, "an unchanged read/write cycle must be byte-identical");
        let rendered_before = crate::json::render_config_json(&current);
        let rendered_after = crate::json::render_config_json(&next);
        assert_eq!(rendered_before, rendered_after, "and so must the rendered bytes");
    }

    /// The descriptor matches the single shipped source.
    #[test]
    fn the_source_descriptor_matches_the_shipped_source() {
        let descriptor = source_descriptor();
        assert_eq!(descriptor.config_dir_segments, vec![".zcode", "cli"]);
        assert_eq!(descriptor.file_name, "config.json");
        assert_eq!(descriptor.config_key_name, ConfigKeyName::Nested);
    }
}
