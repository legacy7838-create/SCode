//! Enabled-flag handling and the legacy migration.
//!
//! Ported from `packages/desktop/src/main/mcpUserDirectory/index.ts:160-252`.
//! Spec: docs/specs/rust-native-mcp-config.md §3.5.
//!
//! This is the least obvious part of the surface, and the part where a port is most likely to be
//! subtly wrong: a migration that is not idempotent will re-run on every save, and a migration
//! with the wrong conflict rule will silently re-enable a server the user deliberately switched
//! off. Both directions are fixture-tested.

use serde_json::Value;

use crate::json::JsonObject;

/// The current key: a server is enabled unless this is explicitly `false`.
pub const ENABLED_KEY: &str = "enabled";
/// The deprecated key the migration moves state out of.
pub const LEGACY_ENABLE_KEY: &str = "mcpEnabled";

/// `readServerEnabled` (`index.ts:160`): enabled is the default, so only an explicit `false`
/// disables. Note this is a loose comparison — any value other than boolean `false` reads as
/// enabled, including a missing key, a string, or `0`.
pub fn read_server_enabled(config: &JsonObject) -> bool {
    !matches!(config.get(ENABLED_KEY), Some(Value::Bool(false)))
}

/// `setServerEnabled` (`index.ts:164`): write the flag without leaving a contradiction behind.
///
/// Two behaviours are deliberate and preserved:
///
/// * **Enable writes nothing.** `enabled` is the default, so writing `enabled: true` would be a
///   redundant field in the user's file. The key is removed instead.
/// * **Both keys are always removed first.** Leaving a stale `mcpEnabled: false` next to
///   `enabled: true` is exactly the contradictory configuration the original comment warns about.
///
/// The rest of the object keeps its key order, with `enabled` appended last when written — again
/// matching an object spread.
pub fn set_server_enabled(config: &JsonObject, enabled: bool) -> JsonObject {
    let mut next = JsonObject::new();
    for (key, value) in config {
        if key == LEGACY_ENABLE_KEY || key == ENABLED_KEY {
            continue;
        }
        next.insert(key.clone(), value.clone());
    }
    if !enabled {
        next.insert(ENABLED_KEY.to_string(), Value::Bool(false));
    }
    next
}

/// The outcome of a legacy migration pass.
#[derive(Debug, Clone, PartialEq)]
pub struct MigrationResult {
    pub servers: JsonObject,
    /// Whether anything actually changed, so the caller only writes when it must.
    pub changed: bool,
}

/// `migrateLegacyEnableFlag` (`index.ts:177-197`): move `mcpEnabled` into `enabled`.
///
/// The conflict rule is the important part and is preserved verbatim: when the two fields
/// disagree, **disable wins**. Enabling here would restart a server the user deliberately
/// switched off, and — per the original comment — writing `enable: false` elsewhere would not
/// clean up the remaining external imports, so the disagreement has to resolve towards off.
///
/// Idempotent by construction: the legacy key is removed on the first pass, so a second pass
/// finds nothing to do and reports `changed: false`.
pub fn migrate_legacy_enable_flag(server_map: &JsonObject) -> MigrationResult {
    let mut changed = false;
    let mut migrated = JsonObject::new();

    for (name, config) in server_map {
        let Some(record) = config.as_object() else {
            // Not an object: the original copies it through untouched and does not count it as
            // a change, so a malformed entry is never "repaired" by rewriting it.
            migrated.insert(name.clone(), config.clone());
            continue;
        };
        if !record.contains_key(LEGACY_ENABLE_KEY) {
            migrated.insert(name.clone(), config.clone());
            continue;
        }
        changed = true;
        let disabled = record.get(LEGACY_ENABLE_KEY) == Some(&Value::Bool(false))
            || record.get(ENABLED_KEY) == Some(&Value::Bool(false));
        migrated.insert(name.clone(), Value::Object(set_server_enabled(record, !disabled)));
    }

    MigrationResult {
        servers: migrated,
        changed,
    }
}

/// `removeLegacyMcpEnabledOverride` (`index.ts:199`): drop the legacy key from one named server,
/// in whichever config object it is nested under.
///
/// Returns the (possibly unchanged) config and whether anything moved, so the caller only writes
/// when it must. Removing the key is idempotent, and because the caller reads the file immediately
/// before writing, a user who re-adds the field by hand gets it cleaned up again.
pub fn remove_legacy_override(
    config: &JsonObject,
    config_key_name: crate::servermap::ConfigKeyName,
    name: &str,
) -> MigrationResult {
    let mut next = config.clone();
    // Set only where a change is actually made, so the value is never a dead store.
    let changed: bool;

    let target_map = match config_key_name {
        crate::servermap::ConfigKeyName::Nested => match next.get_mut("mcp") {
            Some(Value::Object(mcp)) => {
                let servers = mcp
                    .entry("servers".to_string())
                    .or_insert_with(|| Value::Object(JsonObject::new()));
                if !servers.is_object() {
                    *servers = Value::Object(JsonObject::new());
                }
                servers.as_object_mut().expect("just ensured it is an object")
            }
            _ => return MigrationResult { servers: next, changed: false },
        },
        crate::servermap::ConfigKeyName::Flat => match next.get_mut(config_key_name.as_str()) {
            Some(Value::Object(map)) => map,
            _ => return MigrationResult { servers: next, changed: false },
        },
    };

    let Some(Value::Object(server)) = target_map.get(name) else {
        return MigrationResult { servers: next, changed: false };
    };
    if !server.contains_key(LEGACY_ENABLE_KEY) {
        return MigrationResult { servers: next, changed: false };
    }

    // Keep the current enabled value if there is one; otherwise the legacy value decides.
    let enabled = match server.get(ENABLED_KEY) {
        Some(value) => !matches!(value, Value::Bool(false)),
        None => !matches!(server.get(LEGACY_ENABLE_KEY), Some(Value::Bool(false))),
    };
    let cleaned = set_server_enabled(server, enabled);
    target_map.insert(name.to_string(), Value::Object(cleaned));
    changed = true;

    MigrationResult {
        servers: next,
        changed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(value: serde_json::Value) -> JsonObject {
        value.as_object().cloned().expect("an object")
    }

    /// Enabled is the default: anything but boolean `false` reads as enabled.
    #[test]
    fn enabled_is_the_default() {
        assert!(read_server_enabled(&obj(json!({}))));
        assert!(read_server_enabled(&obj(json!({ "enabled": true }))));
        assert!(read_server_enabled(&obj(json!({ "enabled": "false" }))));
        assert!(read_server_enabled(&obj(json!({ "enabled": 0 }))));
        assert!(!read_server_enabled(&obj(json!({ "enabled": false }))));
    }

    /// Enabling writes nothing — `enabled: true` would be a redundant field in the user's file.
    #[test]
    fn enabling_writes_nothing_and_keeps_order() {
        let config = obj(json!({ "command": "npx", "args": [] }));
        let next = set_server_enabled(&config, true);
        assert_eq!(next, config, "an enabled server must be byte-identical to the original");
        assert!(!next.contains_key(ENABLED_KEY));
    }

    /// Disabling appends `enabled: false` last, and strips both keys first so no contradiction
    /// can survive.
    #[test]
    fn disabling_appends_the_flag_last_and_clears_the_legacy_key() {
        let config = obj(json!({ "command": "npx", "mcpEnabled": true, "enabled": true }));
        let next = set_server_enabled(&config, false);
        let keys: Vec<&String> = next.keys().collect();
        assert_eq!(
            keys,
            vec!["command", "enabled"],
            "the legacy key must go and `enabled` must be appended last"
        );
        assert_eq!(next[ENABLED_KEY], json!(false));
    }

    /// The conflict rule: when the two fields disagree, disable wins.
    #[test]
    fn a_disagreeing_legacy_flag_resolves_to_disabled() {
        let server_map = obj(json!({ "s": { "mcpEnabled": true, "enabled": false } }));
        let result = migrate_legacy_enable_flag(&server_map);
        assert!(result.changed);
        assert_eq!(
            result.servers["s"][ENABLED_KEY],
            json!(false),
            "`enabled: false` must win over `mcpEnabled: true`"
        );
    }

    #[test]
    fn a_disagreeing_legacy_false_resolves_to_disabled() {
        let server_map = obj(json!({ "s": { "mcpEnabled": false, "enabled": true } }));
        let result = migrate_legacy_enable_flag(&server_map);
        assert_eq!(result.servers["s"][ENABLED_KEY], json!(false));
    }

    #[test]
    fn a_migrated_enabled_server_writes_no_redundant_flag() {
        let server_map = obj(json!({ "s": { "mcpEnabled": true, "command": "npx" } }));
        let result = migrate_legacy_enable_flag(&server_map);
        assert!(result.changed);
        assert!(
            !result.servers["s"].as_object().unwrap().contains_key(ENABLED_KEY),
            "an enabled server must not gain a redundant `enabled: true`"
        );
        assert!(!result.servers["s"].as_object().unwrap().contains_key(LEGACY_ENABLE_KEY));
        assert_eq!(result.servers["s"]["command"], json!("npx"));
    }

    /// §3.5 — the migration must be idempotent, or it rewrites the file on every save.
    #[test]
    fn the_migration_is_idempotent() {
        let original = obj(json!({ "s": { "mcpEnabled": false, "command": "npx" } }));
        let first = migrate_legacy_enable_flag(&original);
        assert!(first.changed);

        let second = migrate_legacy_enable_flag(&first.servers);
        assert!(!second.changed, "a second pass must find nothing to do");
        assert_eq!(second.servers, first.servers, "and must not alter the result");
    }

    /// A file with no legacy field is never marked changed, so no write happens.
    #[test]
    fn a_clean_config_is_not_marked_changed() {
        let clean = obj(json!({ "s": { "command": "npx" }, "t": { "enabled": false } }));
        let result = migrate_legacy_enable_flag(&clean);
        assert!(!result.changed);
        assert_eq!(result.servers, clean);
    }

    /// A malformed entry is copied through untouched and does not count as a change — the
    /// original does the same, so a bad entry is never silently "repaired" by a rewrite.
    #[test]
    fn a_non_object_entry_is_copied_through_without_being_a_change() {
        let mixed = obj(json!({ "good": { "mcpEnabled": true }, "bad": 5 }));
        let result = migrate_legacy_enable_flag(&mixed);
        assert!(result.changed, "the good entry did change");
        assert_eq!(result.servers["bad"], json!(5), "the malformed entry must survive verbatim");
    }

    /// Removing the override is idempotent too.
    #[test]
    fn removing_the_override_is_idempotent_and_order_preserving() {
        let config = obj(json!({ "mcp": { "servers": { "s": { "mcpEnabled": false, "command": "npx" } } }, "tail": 1 }));

        let first = remove_legacy_override(
            &config,
            crate::servermap::ConfigKeyName::Nested,
            "s",
        );
        assert!(first.changed);
        let server = first.servers["mcp"]["servers"]["s"].as_object().unwrap();
        assert!(!server.contains_key(LEGACY_ENABLE_KEY));
        assert_eq!(server[ENABLED_KEY], json!(false), "the legacy value decides when there is no `enabled`");

        let second = remove_legacy_override(
            &first.servers,
            crate::servermap::ConfigKeyName::Nested,
            "s",
        );
        assert!(!second.changed, "a second removal must be a no-op");
        assert_eq!(second.servers, first.servers);
    }

    /// An explicit `enabled` wins over the legacy value when both are present.
    #[test]
    fn an_explicit_enabled_wins_over_the_legacy_value_on_removal() {
        let config = obj(json!({ "mcp": { "servers": { "s": { "mcpEnabled": false, "enabled": true } } } }));
        let result = remove_legacy_override(
            &config,
            crate::servermap::ConfigKeyName::Nested,
            "s",
        );
        assert!(result.changed);
        let server = result.servers["mcp"]["servers"]["s"].as_object().unwrap();
        assert!(!server.contains_key(ENABLED_KEY), "enabled:true is the default, so nothing is written");
    }

    /// Removing an absent server, or from a config with no such nesting, changes nothing.
    #[test]
    fn removing_an_absent_server_or_nesting_is_a_no_op() {
        let empty = JsonObject::new();
        let result = remove_legacy_override(&empty, crate::servermap::ConfigKeyName::Nested, "s");
        assert!(!result.changed);

        let no_mcp = obj(json!({ "tail": 1 }));
        let result = remove_legacy_override(&no_mcp, crate::servermap::ConfigKeyName::Nested, "s");
        assert!(!result.changed);
        assert_eq!(result.servers, no_mcp, "a config without `mcp` must be untouched");
    }
}
