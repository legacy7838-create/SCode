use std::sync::{Arc, Mutex};

use zcode_provider_config::repository::{
    PersonalProviderConfigRepository, PersonalRepositoryOptions,
};
use zcode_provider_config::schema::{
    decode_provider_config_file, encode_provider_config_file, PersonalConfigLayer,
    PersonalModelConfigRulesData, PersonalProviderConfigData, PersonalProviderConfigRulesData,
};

fn write_layer(path: &std::path::Path, layer: &PersonalConfigLayer) {
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&encode_provider_config_file(layer)).unwrap(),
    )
    .unwrap();
}

fn temp_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "zcode-provider-config-{name}-{}",
        std::process::id()
    ))
}

#[test]
fn an_invalid_file_recovers_to_empty_and_reports_recovery() {
    let path = temp_path("corrupt.json");
    std::fs::write(&path, "{ not json").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_clone = Arc::clone(&events);
    let repo = PersonalProviderConfigRepository::new(PersonalRepositoryOptions {
        file_path: path.clone(),
        import_legacy: None,
        on_recovery: Some(Box::new(move |event| {
            events_clone.lock().unwrap().push(event.error)
        })),
        on_polling_error: None,
        polling_interval: None,
    })
    .unwrap();
    let snapshot = repo.read().unwrap();
    assert!(snapshot.providers.provider_rules.is_empty());
    assert_eq!(
        events.lock().unwrap().len(),
        1,
        "recovery event must be reported"
    );
    // The corrupt file must NOT be touched (user repairs manually).
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn update_rewrites_the_file_and_returns_the_new_snapshot() {
    let path = temp_path("update.json");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&encode_provider_config_file(&PersonalConfigLayer {
            providers: PersonalProviderConfigRulesData {
                provider_rules: vec![],
            },
            models: PersonalModelConfigRulesData {
                provider_model_rules: vec![],
                manual_provider_model_rules: vec![],
            },
            provider_order: None,
            default_model_selection: None,
        }))
        .unwrap(),
    )
    .unwrap();
    let repo = PersonalProviderConfigRepository::new(PersonalRepositoryOptions {
        file_path: path.clone(),
        import_legacy: None,
        on_recovery: None,
        on_polling_error: None,
        polling_interval: None,
    })
    .unwrap();
    let snapshot = repo
        .update(|_current| {
            Ok(PersonalConfigLayer {
                providers: PersonalProviderConfigRulesData {
                    provider_rules: vec![
                        zcode_provider_config::schema::PersonalProviderConfigRuleData {
                            provider_id: "p1".into(),
                            template_id: None,
                            provider_name: None,
                            enabled: None,
                            config: PersonalProviderConfigData {
                                group: None,
                                logo: None,
                                access: None,
                                api: None,
                                personal_model_ids: None,
                                model_order: None,
                                visibility: None,
                            },
                        },
                    ],
                },
                models: PersonalModelConfigRulesData {
                    provider_model_rules: vec![],
                    manual_provider_model_rules: vec![],
                },
                provider_order: Some(vec!["p1".into()]),
                default_model_selection: None,
            })
        })
        .unwrap();
    let file: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let file_config = file.get("config").unwrap();
    let reparsed = decode_provider_config_file(&file).unwrap();
    assert_eq!(reparsed.providers.provider_rules.len(), 1);
    assert_eq!(reparsed.provider_order, Some(vec!["p1".to_string()]));
    assert!(!snapshot.revision.is_empty());
    assert!(serde_json::to_string(&file_config).unwrap().contains('['));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_version_newer_than_supported_is_rejected() {
    let value = serde_json::json!({"schemaVersion": 99, "config": {}});
    let error = decode_provider_config_file(&value).unwrap_err();
    assert!(error.to_string().contains("newer than"), "{error}");
}

#[test]
fn unknown_config_keys_are_rejected() {
    let value = serde_json::json!({
        "schemaVersion": 1,
        "config": {
            "providerConfigRules": { "providerRules": [] },
            "modelConfigRules": { "providerModelRules": [], "manualProviderModelRules": [] },
            "mystery": true
        }
    });
    let error = decode_provider_config_file(&value).unwrap_err();
    assert!(
        error.to_string().contains("unknown") || error.to_string().contains("mystery"),
        "{error}"
    );
}

#[test]
fn duplicate_provider_ids_are_rejected() {
    let value = serde_json::json!({
        "schemaVersion": 1,
        "config": {
            "providerConfigRules": { "providerRules": [
                {"providerId": "p", "config": {}},
                {"providerId": "p", "config": {}}
            ] },
            "modelConfigRules": { "providerModelRules": [], "manualProviderModelRules": [] }
        }
    });
    let error = decode_provider_config_file(&value).unwrap_err();
    assert!(error.to_string().contains("Duplicate"), "{error}");
}

#[test]
fn a_manual_rule_duplicating_a_smart_identity_is_rejected() {
    let value = serde_json::json!({
        "schemaVersion": 1,
        "config": {
            "providerConfigRules": { "providerRules": [] },
            "modelConfigRules": {
                "providerModelRules": [{"providerId": "p", "modelId": "m", "config": {}}],
                "manualProviderModelRules": [{"providerId": "p", "modelId": "m", "config": {
                    "enabled": true,
                    "properties": {"contextWindow": 1000, "supportsJsonSchemaOutput": true, "supportsNativeWebSearch": false, "supportsMidConversationSystem": false, "inputFormat": {"supportsImage": false, "supportsVideo": false, "supportsPdf": false}},
                    "optionSpecs": {"reasoningLevel": {"values": ["high"], "map": "{\"thinking\": {}}"}, "maxOutputTokens": {"max": 1000}}
                }}]
            }
        }
    });
    let error = decode_provider_config_file(&value).unwrap_err();
    assert!(
        error.to_string().contains("both smart and manual"),
        "{error}"
    );
}

#[test]
fn account_provider_rules_must_not_declare_access() {
    let value = serde_json::json!({
        "schemaVersion": 1,
        "config": {
            "providerConfigRules": { "providerRules": [{"providerId": "account:x", "config": {"access": {"type": "api-key"}}}] },
            "modelConfigRules": { "providerModelRules": [], "manualProviderModelRules": [] }
        }
    });
    let error = decode_provider_config_file(&value).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Access for a pinned Account Provider"),
        "{error}"
    );
}
