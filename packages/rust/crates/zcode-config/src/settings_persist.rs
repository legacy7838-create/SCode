//! Settings core: legacy-account fields, patch normalisation, the migration
//! persistence predicate and the persisted-document builder.
//!
//! Port of `packages/services/src/setting/legacyAccountConnectionSettings.ts`,
//! `packages/services/src/setting/normalizeSettingsPatch.ts` and the pure cores
//! of `settingService.ts` (`shouldPersistSettingsMigrations`, the merge step of
//! `update`, and `writeSettings`). Spec: `docs/specs/rust-native-config.md`
//! §3.4/§3.5, rows T33–T39 and T44–T47.
//!
//! Everything here is a pure function over values the caller already holds —
//! the file read, the retry ladder, the quarantine rename and the atomic write
//! stay in TypeScript (§2.2). No `undefined` ever crosses the boundary: a
//! "cleared" patch key is *removed* from the JSON object, which is what the TS
//! `undefined` becomes after RPC anyway (T35's note: "RPC swallows undefined"),
//! and `merge_settings` applies the removal to the merged result so the
//! in-process spread semantics of `{...current, ...patch}` are reproduced
//! exactly — a cleared font must override the current value, not disappear.

use serde_json::{Map, Value};

fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn has_own(object: &Map<String, Value>, key: &str) -> bool {
    object.contains_key(key)
}

// ---------------------------------------------------------------------------
// Legacy account-connection fields (T33, T34, T44)
// ---------------------------------------------------------------------------

/// The legacy keys exist only for rollback; they must never be exposed back
/// into AppSettings or take part in current runtime decisions.
fn needs_legacy_account_connection_migration(value: &Value) -> bool {
    let Some(raw) = as_object(value) else {
        return false;
    };
    !has_own(raw, "providerFamilyConnectionSelections")
        && (has_own(raw, "modelProviderFamilySelectedKeys")
            || has_own(raw, "modelProviderFamilyModes"))
}

/// A decoded `team-plan:builtin:<family>-coding-plan:<productId>:<projectId>`
/// legacy selection. Only the migrator interprets the legacy keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyTeamConnection {
    pub family: &'static str,
    pub product_id: String,
    pub project_id: String,
}

/// Strict `decodeURIComponent` for one segment: percent sequences decode to
/// bytes, the result must be valid UTF-8, and any malformed sequence is a
/// `URIError` — which the predecessor's `try` turns into "no connection for
/// this family". Copied semantics, not approximated: `+` is NOT a space here.
fn decode_uri_component(segment: &str) -> Result<String, String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                if index + 2 >= bytes.len() {
                    return Err("URI malformed".into());
                }
                let high = (bytes[index + 1] as char)
                    .to_digit(16)
                    .ok_or_else(|| "URI malformed".to_string())?;
                let low = (bytes[index + 2] as char)
                    .to_digit(16)
                    .ok_or_else(|| "URI malformed".to_string())?;
                out.push((high * 16 + low) as u8);
                index += 3;
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| "URI malformed".to_string())
}

const LEGACY_FAMILIES: [&str; 2] = ["zai", "bigmodel"];

/// `readIncompleteLegacyTeamConnections`: a team key that parses to exactly two
/// non-empty parts; an `apiKey` mode skips the family (the old API model is not
/// an account package); a broken encoding skips only that family.
pub fn read_incomplete_legacy_team_connections(value: &Value) -> Vec<LegacyTeamConnection> {
    if !needs_legacy_account_connection_migration(value) {
        return Vec::new();
    }
    let Some(raw) = as_object(value) else {
        return Vec::new();
    };
    let modes = raw
        .get("modelProviderFamilyModes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let keys = raw
        .get("modelProviderFamilySelectedKeys")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut connections = Vec::new();
    for family in LEGACY_FAMILIES {
        if modes.get(family).and_then(Value::as_str) == Some("apiKey") {
            continue;
        }
        let key = keys
            .get(family)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let prefix = format!("team-plan:builtin:{family}-coding-plan:");
        if !key.starts_with(&prefix) {
            continue;
        }
        let parts: Vec<String> = match key[prefix.len()..]
            .split(':')
            .map(|part| decode_uri_component(part).map(|decoded| decoded.trim().to_string()))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(parts) => parts,
            Err(_) => continue,
        };
        if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
            continue;
        }
        connections.push(LegacyTeamConnection {
            family,
            product_id: parts[0].clone(),
            project_id: parts[1].clone(),
        });
    }
    connections
}

/// `retainLegacyAccountConnectionFields`: only the two legacy keys, only when
/// present, in the predecessor's fixed order.
pub fn retain_legacy_account_connection_fields(value: &Value) -> Value {
    let empty = Map::new();
    let raw = value.as_object().unwrap_or(&empty);
    let mut out = Map::new();
    for key in ["modelProviderFamilyModes", "modelProviderFamilySelectedKeys"] {
        if let Some(field) = raw.get(key) {
            out.insert(key.to_string(), field.clone());
        }
    }
    Value::Object(out)
}

/// `shouldPersistSettingsMigrations`: the `||` of three clauses — the eager
/// rewrite is blocked entirely while a team migration is pending (T34).
pub fn needs_migration_persist(raw: &Value) -> bool {
    let Some(object) = as_object(raw) else {
        return false;
    };
    (needs_legacy_account_connection_migration(raw)
        && read_incomplete_legacy_team_connections(raw).is_empty())
        || object
            .get("closeToTrayOnWindowsMigrationInitialized")
            .and_then(Value::as_bool)
            != Some(true)
        || object
            .get("messageStreamShowReasoningMigrationInitialized")
            .and_then(Value::as_bool)
            != Some(true)
}

// ---------------------------------------------------------------------------
// Patch normalisation (T35–T39)
// ---------------------------------------------------------------------------

/// Trims a clearable string field: an empty-after-trim value removes the key
/// (the TS `undefined`, which RPC would swallow anyway); a non-empty value is
/// kept as the TRIMMED text.
fn clearable_string(object: &mut Map<String, Value>, key: &str) {
    if let Some(Value::String(value)) = object.get(key).cloned() {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            object.remove(key);
        } else {
            object.insert(key.to_string(), Value::String(trimmed.to_string()));
        }
    }
}

/// `normalizeSettingsPatch`, operating on a JSON object.
///
/// Rules kept verbatim from the predecessor, including its documented quirk:
/// `providerFamilyDomain` clears on whitespace-only, but the keep branch
/// assigns the **untrimmed** value (`normalizeSettingsPatch.ts:79`) — fixing it
/// would be a behaviour fork (T38).
pub fn normalize_settings_patch(mut patch: Value) -> Value {
    let Some(object) = patch.as_object_mut() else {
        return patch;
    };

    clearable_string(object, "terminalFontFamily");
    clearable_string(object, "httpProxy");
    clearable_string(object, "httpProxyNoProxy");
    clearable_string(object, "httpProxyCaCertPath");
    clearable_string(object, "zcodeEndpointOrigin");

    // Provider family: clear on empty-after-trim, but keep the ORIGINAL text.
    if let Some(Value::String(value)) = object.get("providerFamilyDomain").cloned() {
        if value.trim().is_empty() {
            object.remove("providerFamilyDomain");
        }
        // keep branch: the value already stored is the untrimmed original.
    }

    // Terminal shell: "auto" removes the user override so platform detection
    // resumes; "shell" trims the identity fields without deleting them (a
    // whitespace-only value becomes "" and is rejected downstream by the patch
    // schema — the normaliser does not delete, that split is deliberate).
    if let Some(selection) = object.get("integratedTerminalShell").cloned() {
        let mode = selection.get("mode").and_then(Value::as_str);
        match mode {
            Some("auto") => {
                object.remove("integratedTerminalShell");
            }
            Some("shell") => {
                if let Some(mut shell) = selection.as_object().cloned() {
                    for key in ["id", "label", "path"] {
                        if let Some(Value::String(text)) = shell.get(key).cloned() {
                            shell.insert(key.to_string(), Value::String(text.trim().to_string()));
                        }
                    }
                    object.insert("integratedTerminalShell".to_string(), Value::Object(shell));
                }
            }
            _ => {}
        }
    }

    Value::Object(std::mem::take(object))
}

// ---------------------------------------------------------------------------
// Merge and persist (T42–T47)
// ---------------------------------------------------------------------------

/// `writeSettings`'s persisted document: legacy rollback fields first, settings
/// winning on collision (JS spread keeps the FIRST insertion position and the
/// LATER value — `preserve_order` matches that), then the conditional delete
/// that stops an ordinary preference save from committing a pending team plan.
///
/// Returns the exact bytes `JSON.stringify(persisted, null, 2)` writes: two
/// spaces, **no trailing newline** (T47 — deliberately unlike the hooks and
/// trust-store writes).
pub fn build_persisted_settings(
    raw_on_disk: &Value,
    settings: &Value,
    commit_account_selection: bool,
) -> Result<String, String> {
    if !settings.is_object() {
        return Err("settings must be an object".into());
    }
    let mut persisted = match retain_legacy_account_connection_fields(raw_on_disk) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if let Some(settings_object) = settings.as_object() {
        for (key, value) in settings_object {
            persisted.insert(key.clone(), value.clone());
        }
    }
    if !commit_account_selection && !read_incomplete_legacy_team_connections(raw_on_disk).is_empty()
    {
        persisted.remove("providerFamilyConnectionSelections");
    }
    serde_json::to_string_pretty(&Value::Object(persisted)).map_err(|error| error.to_string())
}

/// `appSettingsSchema.parse({...current, ...validatedPatch})` with the recent
/// cap, minus the schema itself (which lands with the settings parse — the
/// caller routes through `parse_settings_content`/`parse_settings_patch` for
/// validation).
///
/// The `recentProjects` step is the merge's own (T42/T43): deduplicated by
/// first occurrence and capped at 10, and only when the PATCH carried the key —
/// an absent patch field never truncates the current ten.
pub fn merge_settings(current: &Value, patch: &Value) -> Result<Value, String> {
    if !current.is_object() || !patch.is_object() {
        return Err("current and patch must be objects".into());
    }
    let patch_object = patch.as_object().expect("checked");
    let current_object = current.as_object().expect("checked");

    // The normalised patch wins key-for-key; keys the normaliser removed are
    // ABSENT from `patch`, but the TS flow overrode the current value with
    // `undefined` — so the clearable keys must be removed from the merge too
    // when the patch mentioned them.
    let normalized = normalize_settings_patch(patch.clone());
    let normalized_object = normalized.as_object().expect("object in");
    let mut merged = current_object.clone();
    for (key, value) in normalized_object {
        merged.insert(key.clone(), value.clone());
    }
    for clearable in [
        "terminalFontFamily",
        "httpProxy",
        "httpProxyNoProxy",
        "httpProxyCaCertPath",
        "zcodeEndpointOrigin",
        "providerFamilyDomain",
        "integratedTerminalShell",
    ] {
        if patch_object.contains_key(clearable) && !normalized_object.contains_key(clearable) {
            merged.remove(clearable);
        }
    }

    if let Some(Value::Array(projects)) = merged.get("recentProjects").cloned() {
        let mut seen = std::collections::HashSet::new();
        let deduped: Vec<Value> = projects
            .into_iter()
            .filter(|project| match project.as_str() {
                Some(name) => seen.insert(name.to_string()),
                None => true,
            })
            .take(10)
            .collect();
        merged.insert("recentProjects".to_string(), Value::Array(deduped));
    }
    Ok(Value::Object(merged))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn t33_both_tags_present_and_no_legacy_keys_never_persists() {
        let raw = json!({
            "closeToTrayOnWindowsMigrationInitialized": true,
            "messageStreamShowReasoningMigrationInitialized": true
        });
        assert!(!needs_migration_persist(&raw), "T33");
    }

    #[test]
    fn t33_a_missing_tag_eagerly_persists() {
        let raw = json!({ "messageStreamShowReasoningMigrationInitialized": true });
        assert!(needs_migration_persist(&raw), "T33 closeToTray tag missing");
        let raw = json!({ "closeToTrayOnWindowsMigrationInitialized": true });
        assert!(needs_migration_persist(&raw), "T33 messageStream tag missing");
    }

    #[test]
    fn t34_a_pending_team_migration_blocks_the_eager_rewrite() {
        // Legacy keys present AND a complete team connection pending: the
        // legacy clause must not fire, and both tags are set.
        let raw = json!({
            "closeToTrayOnWindowsMigrationInitialized": true,
            "messageStreamShowReasoningMigrationInitialized": true,
            "modelProviderFamilyModes": { "zai": "team" },
            "modelProviderFamilySelectedKeys": {
                "zai": "team-plan:builtin:zai-coding-plan:prod-1:proj-1"
            }
        });
        assert_eq!(
            read_incomplete_legacy_team_connections(&raw),
            vec![LegacyTeamConnection {
                family: "zai",
                product_id: "prod-1".into(),
                project_id: "proj-1".into(),
            }],
            "the pending team connection is read"
        );
        assert!(!needs_migration_persist(&raw), "T34 the pending team blocks");

        // Same, but nothing parses as a complete team: the legacy clause fires.
        let raw = json!({
            "closeToTrayOnWindowsMigrationInitialized": true,
            "messageStreamShowReasoningMigrationInitialized": true,
            "modelProviderFamilyModes": { "zai": "team" },
            "modelProviderFamilySelectedKeys": { "zai": "team-plan:builtin:zai-coding-plan:only-one-part" }
        });
        assert!(needs_migration_persist(&raw));
    }

    #[test]
    fn t34_api_key_mode_is_not_an_account_package() {
        let raw = json!({
            "modelProviderFamilyModes": { "zai": "apiKey" },
            "modelProviderFamilySelectedKeys": {
                "zai": "team-plan:builtin:zai-coding-plan:prod:proj"
            }
        });
        assert!(
            read_incomplete_legacy_team_connections(&raw).is_empty(),
            "apiKey mode skips the family"
        );
    }

    #[test]
    fn a_percent_encoded_team_key_decodes_like_decode_uri_component() {
        let raw = json!({
            "modelProviderFamilyModes": { "bigmodel": "team" },
            "modelProviderFamilySelectedKeys": {
                "bigmodel": "team-plan:builtin:bigmodel-coding-plan:p%20ro%3Aduct:proj"
            }
        });
        assert_eq!(
            read_incomplete_legacy_team_connections(&raw),
            vec![LegacyTeamConnection {
                family: "bigmodel",
                product_id: "p ro:duct".into(),
                project_id: "proj".into(),
            }]
        );
    }

    #[test]
    fn a_malformed_encoding_skips_only_that_family() {
        let raw = json!({
            "modelProviderFamilyModes": { "zai": "team", "bigmodel": "team" },
            "modelProviderFamilySelectedKeys": {
                "zai": "team-plan:builtin:zai-coding-plan:%zz:p",
                "bigmodel": "team-plan:builtin:bigmodel-coding-plan:p:j"
            }
        });
        let connections = read_incomplete_legacy_team_connections(&raw);
        assert_eq!(connections.len(), 1, "only the well-formed family parses");
        assert_eq!(connections[0].family, "bigmodel");
    }

    #[test]
    fn t35_clearing_a_font_deletes_the_patch_key() {
        let patch = normalize_settings_patch(json!({ "terminalFontFamily": "   " }));
        assert!(
            !patch.as_object().unwrap().contains_key("terminalFontFamily"),
            "T35: {patch}"
        );
        let patch = normalize_settings_patch(json!({ "terminalFontFamily": "  JetBrains Mono " }));
        assert_eq!(
            patch["terminalFontFamily"],
            json!("JetBrains Mono"),
            "non-empty values are trimmed"
        );
    }

    #[test]
    fn t36_auto_shell_mode_is_deleted_and_not_rewritten() {
        let patch = normalize_settings_patch(
            json!({ "integratedTerminalShell": { "mode": "auto" } }),
        );
        assert!(
            !patch.as_object().unwrap().contains_key("integratedTerminalShell"),
            "T36: {patch}"
        );
    }

    #[test]
    fn t37_shell_mode_trims_the_identity_fields_without_deleting() {
        let patch = normalize_settings_patch(json!({ "integratedTerminalShell": {
            "mode": "shell", "dialect": "cmd", "id": "  work  ", "label": " L ", "path": " /bin/sh "
        }}));
        let shell = &patch["integratedTerminalShell"];
        assert_eq!(shell["id"], json!("work"));
        assert_eq!(shell["label"], json!("L"));
        assert_eq!(shell["path"], json!("/bin/sh"));
        assert_eq!(shell["dialect"], json!("cmd"));
    }

    #[test]
    fn t38_family_domain_clears_on_whitespace_but_keeps_untrimmed_text() {
        let cleared = normalize_settings_patch(json!({ "providerFamilyDomain": "  " }));
        assert!(
            !cleared.as_object().unwrap().contains_key("providerFamilyDomain"),
            "T38 whitespace-only clears"
        );
        let kept = normalize_settings_patch(json!({ "providerFamilyDomain": "  zai  " }));
        assert_eq!(
            kept["providerFamilyDomain"], json!("  zai  "),
            "T38 the keep branch uses the UNTRIMMED value — the predecessor quirk, preserved"
        );
    }

    #[test]
    fn t39_an_unrecognised_patch_passes_through_unchanged() {
        let patch = json!({ "someFutureKey": 1, "anotherKey": { "a": 1 } });
        assert_eq!(
            normalize_settings_patch(patch.clone()),
            patch,
            "T39 the normaliser touches only its eight keys; the patch schema is what rejects"
        );
    }

    #[test]
    fn t42_recent_projects_deduplicate_by_first_occurrence_and_cap_at_ten() {
        let current = json!({ "keepAwakeWhileRunning": false });
        let patch = json!({
            "recentProjects": ["/p0", "/p0", "/p1", "/p2", "/p3", "/p4", "/p5", "/p6", "/p7", "/p8", "/p9", "/p10", "/p11"]
        });
        let merged = merge_settings(&current, &patch).unwrap();
        assert_eq!(
            merged["recentProjects"],
            json!(["/p0", "/p1", "/p2", "/p3", "/p4", "/p5", "/p6", "/p7", "/p8", "/p9"]),
            "T42 first occurrence wins, then the cap"
        );
    }

    #[test]
    fn t43_an_absent_patch_field_never_truncates_the_current_ten() {
        let projects: Vec<String> = (0..10).map(|i| format!("/p{i}")).collect();
        let current = json!({ "recentProjects": projects });
        let merged = merge_settings(&current, &json!({ "keepAwakeWhileRunning": true })).unwrap();
        assert_eq!(
            merged["recentProjects"].as_array().map(|a| a.len()),
            Some(10),
            "T43"
        );
    }

    #[test]
    fn a_cleared_field_overrides_the_current_value_in_the_merge() {
        // The TS flow set the normalised key to `undefined`, which the spread
        // used to override the current value; the JSON form of that is removal.
        let current = json!({ "terminalFontFamily": "Fira Code", "httpProxy": "http://old:1" });
        let merged = merge_settings(&current, &json!({ "terminalFontFamily": "  " })).unwrap();
        assert!(
            !merged.as_object().unwrap().contains_key("terminalFontFamily"),
            "the clear must win over the current value: {merged}"
        );
        assert_eq!(merged["httpProxy"], json!("http://old:1"), "untouched key survives");
    }

    #[test]
    fn t44_legacy_fields_are_written_back_and_settings_win_collisions() {
        let raw = json!({
            "modelProviderFamilyModes": { "zai": "team" },
            "modelProviderFamilySelectedKeys": { "zai": "team-plan:builtin:zai-coding-plan:p:j" },
            "modelProviderFamilyExtra": { "ignored": true },
            "keepAwakeWhileRunning": false
        });
        let settings = json!({ "keepAwakeWhileRunning": true, "desktopZoomLevel": 2 });
        let persisted =
            build_persisted_settings(&raw, &settings, false).expect("T44 build");
        let document: Value = serde_json::from_str(&persisted).unwrap();
        assert_eq!(
            document["modelProviderFamilyModes"],
            json!({ "zai": "team" }),
            "legacy field rolled back"
        );
        assert_eq!(
            document["modelProviderFamilySelectedKeys"],
            json!({ "zai": "team-plan:builtin:zai-coding-plan:p:j" })
        );
        assert!(
            document.get("modelProviderFamilyExtra").is_none(),
            "only the two legacy keys are retained"
        );
        assert_eq!(
            document["keepAwakeWhileRunning"],
            json!(true),
            "T44 settings win on collision"
        );
        assert_eq!(document["desktopZoomLevel"], json!(2));
    }

    #[test]
    fn t45_a_pending_team_deletes_the_selection_key_even_though_settings_carries_it() {
        let raw = json!({
            "modelProviderFamilySelectedKeys": { "zai": "team-plan:builtin:zai-coding-plan:prod:proj" }
        });
        let settings = json!({ "providerFamilyConnectionSelections": { "zai": { "kind": "team-coding-plan" } } });
        let persisted = build_persisted_settings(&raw, &settings, false).unwrap();
        let document: Value = serde_json::from_str(&persisted).unwrap();
        assert!(
            document.get("providerFamilyConnectionSelections").is_none(),
            "T45: {persisted}"
        );

        let committed = build_persisted_settings(&raw, &settings, true).unwrap();
        let document: Value = serde_json::from_str(&committed).unwrap();
        assert!(
            document.get("providerFamilyConnectionSelections").is_some(),
            "T46 commitAccountSelection: true keeps it"
        );
    }

    #[test]
    fn t47_the_persisted_bytes_have_two_space_indent_and_no_trailing_newline() {
        let raw = json!({});
        let settings = json!({ "desktopZoomLevel": 2 });
        let persisted = build_persisted_settings(&raw, &settings, false).unwrap();
        assert!(
            persisted.ends_with('}'),
            "T47 no trailing newline (unlike the hooks/trust writes): {persisted:?}"
        );
        assert!(
            persisted.contains("\n  \"desktopZoomLevel\": 2"),
            "JSON.stringify(obj, null, 2) indent: {persisted}"
        );
    }
}
