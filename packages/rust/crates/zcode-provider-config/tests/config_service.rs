use zcode_provider_config::config_service::{
    BuiltinSnapshot, BuiltinSource, CreatePersonalProviderInput, ProviderConfigService,
};
use zcode_provider_config::domain::{
    ModelConfigRule, ModelConfigRules, ProviderConfigMap, ProviderConfigRule, ProviderTemplateMap,
};
use zcode_provider_config::repository::{
    PersonalProviderConfigRepository, PersonalRepositoryOptions,
};
use zcode_provider_config::schema::ProviderConfigData;
use zcode_provider_config::schema::{ModelConfigData, ProviderModelRuleData};

struct FakeBuiltin {
    snapshot: BuiltinSnapshot,
}

struct ListenerSlot {
    callback: std::sync::Mutex<Option<Box<dyn Fn(&str) + Send>>>,
}

impl BuiltinSource for FakeBuiltin {
    fn read(&self) -> Result<BuiltinSnapshot, String> {
        Ok(self.snapshot.clone())
    }
    fn on_did_change(&self, _listener: Box<dyn Fn(&str) + Send + Sync>) {}
}

fn base_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("zcode-config-service-{}", std::process::id()))
}

fn write_empty_personal(path: &std::path::Path) {
    let layer = serde_json::json!({
        "schemaVersion": 1,
        "config": {
            "providerConfigRules": { "providerRules": [] },
            "modelConfigRules": { "providerModelRules": [], "manualProviderModelRules": [] }
        }
    });
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec_pretty(&layer).unwrap()).unwrap();
}

#[test]
fn create_add_rename_set_delete_roundtrip() {
    let dir = base_dir();
    let file_path = dir.join("provider_config.json");
    write_empty_personal(&file_path);

    let builtin = FakeBuiltin {
        snapshot: BuiltinSnapshot {
            revision: "zcode-builtin:32:abc".into(),
            providers: ProviderConfigMap::from_rules(vec![ProviderConfigRule {
                provider_id: "builtin-p".into(),
                template_id: None,
                provider_name: Some(Some("Built-in".into())),
                enabled: None,
                config: ProviderConfigData {
                    group: Some(Some(
                        zcode_provider_config::schema::ProviderGroup::ZaiFamily,
                    )),
                    logo: None,
                    access: None,
                    api: None,
                    builtin_model_ids: Some(Some(vec!["gpt-5".into()])),
                    personal_model_ids: None,
                    model_order: None,
                    visibility: None,
                },
            }])
            .unwrap(),
            provider_templates: ProviderTemplateMap::empty(),
            models: ModelConfigRules::new(vec![ModelConfigRule::ProviderModel(
                ProviderModelRuleData {
                    provider_id: "builtin-p".into(),
                    model_id: "gpt-5".into(),
                    config: ModelConfigData {
                        enabled: Some(Some(true)),
                        properties: None,
                        option_specs: None,
                    },
                },
            )]),
        },
    };
    let repository = PersonalProviderConfigRepository::new(PersonalRepositoryOptions {
        file_path: file_path.clone(),
        import_legacy: None,
        on_recovery: None,
        on_polling_error: None,
        polling_interval: None,
    })
    .unwrap();
    let service = ProviderConfigService::new(Box::new(builtin), repository);
    let provider_id = service
        .create_personal_provider(CreatePersonalProviderInput {
            template_id: None,
            provider_name: None,
            locale: None,
            initial_config: None,
        })
        .unwrap();
    assert_eq!(provider_id, "new-provider");

    service
        .add_personal_model(
            &provider_id,
            "my-model",
            ModelConfigData {
                enabled: Some(Some(true)),
                properties: None,
                option_specs: None,
            },
            None,
            None, // recommended config applies: smart rule, manual-only
                  // fields (contextWindow etc.) are not supplied.
        )
        .unwrap();

    service
        .rename_personal_model(&provider_id, "my-model", "my-model-2", None)
        .unwrap();

    service
        .set_personal_model_enabled(&provider_id, "my-model-2", false, None)
        .unwrap();

    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file_path).unwrap()).unwrap();
    let provider_rules = file
        .pointer("/config/providerConfigRules/providerRules")
        .unwrap()
        .as_array()
        .unwrap();
    assert_eq!(
        provider_rules[0]["config"]["personalModelIds"],
        serde_json::json!(["my-model-2"])
    );
    let model_rules = file
        .pointer("/config/modelConfigRules/providerModelRules")
        .unwrap()
        .as_array()
        .unwrap();
    assert_eq!(model_rules.len(), 1);
    assert_eq!(model_rules[0]["modelId"], serde_json::json!("my-model-2"));
    // Recommended config applies, so the rule is a smart rule; no manual rule was created.
    let manual = file
        .pointer("/config/modelConfigRules/manualProviderModelRules")
        .unwrap()
        .as_array()
        .unwrap();
    assert_eq!(manual.len(), 0);
    assert_eq!(
        model_rules[0]["config"]["enabled"],
        serde_json::json!(false)
    );

    service
        .delete_personal_model(&provider_id, "my-model-2", None)
        .unwrap();
    let snapshot = service.read().unwrap();
    assert!(
        snapshot
            .personal_models
            .rules()
            .iter()
            .filter(|rule| matches!(rule, ModelConfigRule::ManualProviderModel(_)))
            .count()
            == 0
    );

    let _ = std::fs::remove_dir_all(&dir);
}
