//! `provider-settings` channel — provider/model settings read + write surface.
//!
//! Replaces the `@zcode/server` `provider-settings` channel. The handler holds
//! one `ProviderRegistryService` (the provider-config runtime: built-in source,
//! personal repository, account source, resolver, facades) and dispatches each
//! channel method to the matching operation, then re-publishes the settings
//! view. Membership is computed host-side from the current snapshot exactly as
//! the TS facade does — the renderer never supplies it.

use serde_json::Value as JsonValue;
use zcode_provider_config::account::MutableAccountProviderConfigSource;
use zcode_provider_config::builtin_source::FileBuiltinSource;
use zcode_provider_config::config_service::{
    CreatePersonalProviderInput, MetadataInput, ProviderConfigService, ProviderModelMembership,
};
use zcode_provider_config::schema::{ModelConfigData, ProviderConfigData};
use zcode_provider_config::registry_service::ProviderRegistryService;
use zcode_provider_config::repository::{PersonalProviderConfigRepository, PersonalRepositoryOptions};
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

use crate::services::{builtin_provider_config, paths};

/// Builds the provider runtime from the host's config directory: the
/// materialised built-in release is the bundled source (no remote sync in the
/// desktop host), and the personal config lives beside it. Both are the same
/// files `@zcode/server` used, so a pre-cutover personal config is read as-is.
pub fn build_provider_registry() -> Result<ProviderRegistryService, String> {
    let config_dir = paths::app_config_dir();
    let bundled_path = builtin_provider_config::bundled_config_path(&config_dir);
    let personal_path = config_dir.join("provider_config.json");
    let builtin_source = FileBuiltinSource::new(bundled_path.clone(), Some(bundled_path))?;
    let repository = PersonalProviderConfigRepository::new(PersonalRepositoryOptions {
        file_path: personal_path,
        import_legacy: None,
        on_recovery: None,
        on_polling_error: None,
        polling_interval: None,
    })?;
    let config_service = ProviderConfigService::new(Box::new(builtin_source), repository);
    let account = std::sync::Arc::new(MutableAccountProviderConfigSource::new());
    Ok(ProviderRegistryService::new(config_service, account))
}

pub struct ProviderSettingsService {
    registry: ProviderRegistryService,
}

impl ProviderSettingsService {
    pub fn new() -> Result<Self, String> {
        Ok(Self { registry: build_provider_registry()? })
    }

    fn view(&self) -> Result<JsonValue, HandlerError> {
        let view = self.registry.get_settings_view().map_err(handler_error)?;
        serde_json::to_value(&view).map_err(handler_error)
    }

    /// Compute the host-side model membership for a provider and run a
    /// membership-requiring mutation, then re-publish the view. Mirrors the TS
    /// facade's `#mutateProvider` + `#modelMembership`.
    fn mutate_with_membership(
        &self,
        provider_id: &str,
        operation: impl FnOnce(
            &ProviderConfigService,
            Option<&ProviderModelMembership>,
        ) -> Result<(), String>,
    ) -> Result<JsonValue, HandlerError> {
        let snapshot = self
            .registry
            .get_snapshot()
            .ok_or_else(|| handler_error("ProviderRegistryService has not started() yet"))?;
        let inherited: Vec<String> = snapshot
            .resolution
            .resolved_providers
            .iter()
            .find(|p| p.provider_id == provider_id)
            .map(|p| {
                p.models
                    .iter()
                    .filter(|m| m.source == "builtin")
                    .map(|m| m.model_id.clone())
                    .collect()
            })
            .ok_or_else(|| handler_error(format!("Provider does not exist: {provider_id}")))?;
        let personal_revision = snapshot.config.personal_revision.clone();
        let assert_current = || Ok(());
        let membership = ProviderModelMembership {
            provider_id,
            inherited_model_ids: &inherited,
            personal_revision: &personal_revision,
            assert_current: &assert_current,
        };
        operation(self.registry.config(), Some(&membership)).map_err(handler_error)?;
        self.registry.refresh("mutate").map_err(handler_error)?;
        self.view()
    }

    fn mutate_plain(
        &self,
        operation: impl FnOnce(&ProviderConfigService) -> Result<(), String>,
    ) -> Result<JsonValue, HandlerError> {
        operation(self.registry.config()).map_err(handler_error)?;
        self.registry.refresh("mutate").map_err(handler_error)?;
        self.view()
    }
}

impl Default for ProviderSettingsService {
    fn default() -> Self {
        Self::new().expect("provider runtime must build at construction")
    }
}

impl ChannelHandler for ProviderSettingsService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        // Ensure a snapshot exists so every read path has a registry.
        if self.registry.get_snapshot().is_none() {
            self.registry.start().map_err(handler_error)?;
        }
        let first = args.first();
        match method {
            "getView" => self.view(),
            "refresh" => {
                let reason = first.and_then(JsonValue::as_str).unwrap_or("explicit");
                self.registry.refresh(reason).map_err(handler_error)?;
                self.view()
            }
            "createPersonalProvider" => {
                let input = first.cloned().unwrap_or(JsonValue::Null);
                let create = CreatePersonalProviderInput {
                    template_id: input.get("templateId").and_then(JsonValue::as_str).map(str::to_string),
                    provider_name: input.get("providerName").and_then(JsonValue::as_str).map(str::to_string),
                    locale: input.get("locale").and_then(JsonValue::as_str).map(str::to_string),
                    initial_config: input
                        .get("initialConfig")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .map(serde_json::from_value)
                        .transpose()
                        .map_err(handler_error)?,
                };
                let provider_id = self
                    .registry
                    .config()
                    .create_personal_provider(create)
                    .map_err(handler_error)?;
                self.registry.refresh("create-provider").map_err(handler_error)?;
                let view = self.registry.get_settings_view().map_err(handler_error)?;
                Ok(serde_json::json!({ "providerId": provider_id, "view": view }))
            }
            "savePersonalProviderOverlay" => {
                let provider_id = required_str(first, "providerId")?;
                let config: ProviderConfigData =
                    serde_json::from_value(args.get(1).cloned().unwrap_or(JsonValue::Null))
                        .map_err(handler_error)?;
                let metadata = args.get(2).filter(|v| !v.is_null()).map(|v| MetadataInput {
                    provider_name: v.get("providerName").and_then(JsonValue::as_str).map(str::to_string),
                    template_id: v.get("templateId").and_then(JsonValue::as_str).map(str::to_string),
                    enabled: v.get("enabled").and_then(JsonValue::as_bool),
                });
                self.mutate_with_membership(provider_id, |service, membership| {
                    service
                        .save_personal_provider_overlay(provider_id, config, membership, metadata)
                        .map(|_| ())
                })
            }
            "deletePersonalProvider" => {
                let provider_id = required_str(first, "providerId")?;
                self.mutate_plain(|service| service.delete_personal_provider(provider_id).map(|_| ()))
            }
            "reorderPersonalProviders" => {
                let provider_ids = str_array(first, "providerIds")?;
                self.mutate_plain(|service| service.reorder_personal_providers(&provider_ids).map(|_| ()))
            }
            "reorderPersonalModels" => {
                let provider_id = required_str(first, "providerId")?;
                let model_ids = str_array(args.get(1), "modelIds")?;
                self.mutate_with_membership(provider_id, |service, membership| {
                    service
                        .reorder_personal_models(provider_id, &model_ids, membership)
                        .map(|_| ())
                })
            }
            "addPersonalModel" => {
                let provider_id = required_str(first, "providerId")?;
                let model_id = required_str(args.get(1), "modelId")?;
                let config: ModelConfigData =
                    serde_json::from_value(args.get(2).cloned().unwrap_or(JsonValue::Null))
                        .map_err(handler_error)?;
                let use_recommended = args.get(3).and_then(JsonValue::as_bool);
                self.mutate_with_membership(provider_id, |service, membership| {
                    service
                        .add_personal_model(provider_id, model_id, config, membership, use_recommended)
                        .map(|_| ())
                })
            }
            "renamePersonalModel" => {
                let provider_id = required_str(first, "providerId")?;
                let current_id = required_str(args.get(1), "currentModelId")?;
                let next_id = required_str(args.get(2), "nextModelId")?;
                self.mutate_with_membership(provider_id, |service, membership| {
                    service
                        .rename_personal_model(provider_id, current_id, next_id, membership)
                        .map(|_| ())
                })
            }
            "deletePersonalModel" => {
                let provider_id = required_str(first, "providerId")?;
                let model_id = required_str(args.get(1), "modelId")?;
                self.mutate_with_membership(provider_id, |service, membership| {
                    service
                        .delete_personal_model(provider_id, model_id, membership)
                        .map(|_| ())
                })
            }
            "savePersonalModelDraft" => {
                let input = first.ok_or_else(|| handler_error("savePersonalModelDraft requires an input object"))?;
                let provider_id = required_str(Some(input), "providerId")?;
                let original_id = required_str(Some(input), "originalModelId")?;
                let next_id = required_str(Some(input), "nextModelId")?;
                let config: ModelConfigData = serde_json::from_value(
                    input.get("personalConfig").cloned().unwrap_or(JsonValue::Null),
                )
                .map_err(handler_error)?;
                let expected_revision = required_str(Some(input), "basedOnRevision")?;
                let use_recommended = input.get("useRecommendedConfig").and_then(JsonValue::as_bool);
                self.mutate_with_membership(provider_id, |service, membership| {
                    service
                        .save_personal_model_draft(
                            provider_id,
                            original_id,
                            next_id,
                            config,
                            expected_revision,
                            use_recommended,
                            membership,
                        )
                        .map(|_| ())
                })
            }
            "setPersonalModelEnabled" => {
                let provider_id = required_str(first, "providerId")?;
                let model_id = required_str(args.get(1), "modelId")?;
                let enabled = args
                    .get(2)
                    .and_then(JsonValue::as_bool)
                    .ok_or_else(|| handler_error("setPersonalModelEnabled requires a boolean enabled"))?;
                self.mutate_with_membership(provider_id, |service, membership| {
                    service
                        .set_personal_model_enabled(provider_id, model_id, enabled, membership)
                        .map(|_| ())
                })
            }
            "resolveModelConfig" => {
                let input = first.ok_or_else(|| handler_error("resolveModelConfig requires an input"))?;
                let provider_id = required_str(Some(input), "providerId")?;
                let model_id = input
                    .get("modelId")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string)
                    .or_else(|| input.get("originalModelId").and_then(JsonValue::as_str).map(str::to_string))
                    .ok_or_else(|| handler_error("resolveModelConfig requires modelId"))?;
                resolve_model_config(&self.registry, provider_id, &model_id)
            }
            "testModelConnectivity" => {
                // Deliberate, loud: the connectivity test spawns the agent and
                // waits for rung 5. Returning an error is the specified
                // behavior — never a silent empty success.
                Err(HandlerError::message(
                    "provider-settings.testModelConnectivity is unsupported on the native host until the agent plane lands",
                ))
            }
            other => Err(HandlerError::message(format!(
                "provider-settings.{other} is not implemented by the Rust host"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        _event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        None
    }
}

fn resolve_model_config(
    registry: &ProviderRegistryService,
    provider_id: &str,
    model_id: &str,
) -> Result<JsonValue, HandlerError> {
    let snapshot = registry
        .get_snapshot()
        .ok_or_else(|| handler_error("ProviderRegistryService has not started() yet"))?;
    let provider = snapshot
        .resolution
        .effective_providers
        .get_rule(provider_id)
        .ok_or_else(|| handler_error(format!("Provider does not exist: {provider_id}")))?
        .clone();
    let rules = zcode_provider_config::domain::ModelConfigRules::compose_effective(
        &snapshot.config.zcode_builtin_model_rules,
        &snapshot.config.personal_models,
    );
    let api_type = provider
        .config
        .api
        .as_ref()
        .and_then(|a| a.as_ref())
        .and_then(|a| a.kind.as_ref().and_then(|k| k.as_ref()))
        .map(|k| match k {
            zcode_provider_config::schema::ProviderApiType::AnthropicMessages => "anthropic-messages",
            zcode_provider_config::schema::ProviderApiType::OpenaiChatCompletions => "openai-chat-completions",
            zcode_provider_config::schema::ProviderApiType::OpenaiResponses => "openai-responses",
        }
        .to_string());
    let base_url = provider
        .config
        .api
        .as_ref()
        .and_then(|a| a.as_ref())
        .and_then(|a| a.base_url.as_ref().and_then(|b| b.as_ref()))
        .cloned();
    let config = rules.resolve(&zcode_provider_config::domain::ResolutionInput {
        provider_id: provider_id.to_string(),
        template_id: provider.template_id.as_ref().and_then(|t| t.as_ref()).cloned(),
        model_id: model_id.to_string(),
        api_type,
        base_url,
    });
    let inherited_config = serde_json::to_value(&config).map_err(handler_error)?;
    Ok(serde_json::json!({
        "inheritedConfig": inherited_config,
        "effectiveConfig": inherited_config,
        "issues": [],
    }))
}

fn required_str<'a>(value: Option<&'a JsonValue>, field: &str) -> Result<&'a str, HandlerError> {
    value
        .and_then(|v| v.get(field))
        .and_then(JsonValue::as_str)
        .ok_or_else(|| handler_error(format!("missing required string argument `{field}`")))
}

fn str_array(value: Option<&JsonValue>, field: &str) -> Result<Vec<String>, HandlerError> {
    value
        .and_then(|v| v.get(field))
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .ok_or_else(|| handler_error(format!("missing required string array `{field}`")))
}

fn handler_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::message(error.to_string())
}

