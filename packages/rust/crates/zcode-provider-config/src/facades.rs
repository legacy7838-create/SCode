//! Registry→Renderer view assembly.
//!
//! Rust port of `packages/provider/src/facades.ts` (`createProviderSettingsView`,
//! `ModelSelectionFacade.getView`, `projectModelSelectionProviderView`),
//! `model-selection-config.ts` (`resolveInitialModelSelection`,
//! `completeNewModelSelection`, `isSelectable`), and
//! `effective-model-selection.ts` (`resolveEffectiveModelSelection`).
//!
//! These are pure functions over the resolver output: they never read the disk
//! or the network. The config objects they emit are the sparse
//! `ProviderConfigData` / `ModelConfigData` serialised with the exact key order
//! (absent keys dropped, explicit nulls preserved) the TS `toJSON` produces, so
//! the Renderer's parsers see the same bytes they always did.

use serde_json::Value as JsonValue;

use crate::account::AccountProviderState;
use crate::domain::{ModelConfigRules, ProviderConfigMap};
use crate::resolver::{
    ConfigValidationIssue, Provider, ProviderConfigResolution, RegistryModelConfig,
    RegistryProviderConfig,
};
use crate::schema::ProviderConfigData;
use crate::schema::ProviderTemplateNameMap;

// ---------------------------------------------------------------------------
// ProviderSettingsView
// ---------------------------------------------------------------------------

/// One model candidate in the settings view.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsModelView {
    pub kind: String,
    pub model_id: String,
    pub builtin: bool,
    pub effective_builtin_config: JsonValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub personal_exact_config: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_recommended_config: Option<bool>,
    pub effective_config: JsonValue,
    pub enabled: bool,
    pub executable: bool,
    pub selectable: bool,
    pub issues: Vec<ConfigValidationIssue>,
}

/// One provider in the settings view.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsProviderView {
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_state: Option<AccountProviderState>,
    pub executable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_config: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_builtin_config: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub personal_config: Option<JsonValue>,
    pub effective_config: JsonValue,
    pub issues: Vec<ConfigValidationIssue>,
    pub models: Vec<ProviderSettingsModelView>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsTemplateView {
    pub template_id: String,
    pub template_name_map: ProviderTemplateNameMap,
    pub config: JsonValue,
}

/// The `provider-settings` channel's `getView()` payload.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsView {
    pub revision: u64,
    pub provider_templates: Vec<ProviderSettingsTemplateView>,
    pub provider_order: Vec<String>,
    pub providers: Vec<ProviderSettingsProviderView>,
}

pub struct ProviderSettingsViewInput<'a> {
    pub revision: u64,
    pub builtin_providers: &'a ProviderConfigMap,
    pub builtin_provider_templates: &'a crate::domain::ProviderTemplateMap,
    pub personal_providers: &'a ProviderConfigMap,
    pub personal_models: &'a ModelConfigRules,
    pub resolution: &'a ProviderConfigResolution,
    pub account_states: Option<&'a [(String, AccountProviderState)]>,
}

fn config_json(config: &ProviderConfigData) -> JsonValue {
    serde_json::to_value(config).unwrap_or(JsonValue::Null)
}

fn model_config_json(config: &crate::schema::ModelConfigData) -> JsonValue {
    serde_json::to_value(config).unwrap_or(JsonValue::Null)
}

/// Assembles the `ProviderSettingsView`. Mirrors `createProviderSettingsView`.
pub fn create_provider_settings_view(input: ProviderSettingsViewInput<'_>) -> ProviderSettingsView {
    let executable_provider_ids: std::collections::HashSet<&String> = input
        .resolution
        .registry_providers
        .iter()
        .map(|provider| &provider.provider_id)
        .collect();

    let project_provider = |provider: &crate::resolver::ResolvedProvider| {
        let personal_config = input.personal_providers.get(&provider.provider_id).cloned();
        let account_state = input
            .account_states
            .and_then(|states| {
                states
                    .iter()
                    .find(|(id, _)| id == &provider.provider_id)
                    .map(|(_, state)| state)
            })
            .cloned();
        let models = provider
            .models
            .iter()
            .map(|model| {
                let personal_model_config = input
                    .personal_models
                    .get_exact(&provider.provider_id, &model.model_id);
                let personal_model_rule = input
                    .personal_models
                    .get_exact_rule(&provider.provider_id, &model.model_id);
                ProviderSettingsModelView {
                    kind: "candidate".to_string(),
                    model_id: model.model_id.clone(),
                    builtin: model.source == "builtin",
                    effective_builtin_config: model_config_json(&model.effective_builtin_config),
                    personal_exact_config: personal_model_config.as_ref().map(model_config_json),
                    use_recommended_config: personal_model_rule.map(|rule| {
                        !matches!(rule, crate::domain::ModelConfigRule::ManualProviderModel(_))
                    }),
                    effective_config: model_config_json(&model.config),
                    enabled: model.enabled,
                    executable: model.executable,
                    selectable: model.selectable,
                    issues: model.issues.clone(),
                }
            })
            .collect::<Vec<_>>();
        ProviderSettingsProviderView {
            provider_id: provider.provider_id.clone(),
            provider_name: provider.provider_name.clone(),
            template_id: provider.template_id.clone(),
            enabled: provider.enabled,
            account_state,
            executable: executable_provider_ids.contains(&provider.provider_id),
            template_config: provider.template_config.as_ref().map(config_json),
            effective_builtin_config: provider.effective_builtin_config.as_ref().map(config_json),
            personal_config: personal_config.as_ref().map(config_json),
            effective_config: config_json(&provider.provider_config),
            issues: provider.provider_issues.clone(),
            models,
        }
    };

    let visible_providers: Vec<&crate::resolver::ResolvedProvider> = input
        .resolution
        .resolved_providers
        .iter()
        .filter(|provider| {
            provider
                .provider_config
                .visibility
                .as_ref()
                .and_then(|v| v.as_ref())
                != Some(&crate::schema::ProviderVisibility::Hidden)
        })
        .collect();

    let provider_order = visible_providers
        .iter()
        .filter(|provider| {
            provider
                .provider_config
                .group
                .as_ref()
                .and_then(|g| g.as_ref())
                == Some(&crate::schema::ProviderGroup::StandardPersonal)
        })
        .map(|provider| provider.provider_id.clone())
        .collect();

    ProviderSettingsView {
        revision: input.revision,
        provider_templates: input
            .builtin_provider_templates
            .entries()
            .iter()
            .map(|template| ProviderSettingsTemplateView {
                template_id: template.template_id.clone(),
                template_name_map: ProviderTemplateNameMap {
                    zh_cn: template.template_name_map.zh_cn.clone(),
                    en_us: template.template_name_map.en_us.clone(),
                },
                config: config_json(&template.config),
            })
            .collect(),
        provider_order,
        providers: visible_providers
            .iter()
            .map(|p| project_provider(p))
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// ModelSelectionView
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelectionModelView {
    pub model_id: String,
    pub config: RegistryModelConfig,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelectionProviderView {
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    pub config: RegistryProviderConfig,
    pub models: Vec<ModelSelectionModelView>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveModelSelectionResult {
    pub effective_selection: Option<crate::schema::ModelSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_issue: Option<SelectionIssue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SelectionIssue {
    SelectionMissing,
    AccountConnectionUnavailable,
    ProviderNotFound,
    ModelNotFound,
    ReasoningLevelMissing,
    ReasoningLevelNotSupported,
}

/// The `model-selection` channel's `getView()` payload.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelectionView {
    pub revision: u64,
    pub providers: Vec<ModelSelectionProviderView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_selection: Option<crate::schema::ModelSelection>,
    #[serde(flatten)]
    pub effective: EffectiveModelSelectionResult,
}

/// Projects a Registry provider as a model-selection candidate.
pub fn project_model_selection_provider_view(provider: &Provider) -> ModelSelectionProviderView {
    ModelSelectionProviderView {
        provider_id: provider.provider_id.clone(),
        provider_name: provider.provider_name.clone(),
        template_id: provider.template_id.clone(),
        config: provider.registry_config.clone(),
        models: provider
            .models
            .iter()
            .map(|model| ModelSelectionModelView {
                model_id: model.model_id.clone(),
                config: model.model_config.clone(),
            })
            .collect(),
    }
}

/// `resolveInitialModelSelection`: builds the host's initial recommendation.
/// Only the final reasoning level is picked for a brand-new draft; an
/// unresolvable default falls through to a registry-order fallback.
pub fn resolve_initial_model_selection(
    registry: &crate::resolver::ProviderRegistryView,
    configured_default: Option<&crate::schema::ModelSelection>,
) -> Option<crate::schema::ModelSelection> {
    if let Some(default) = configured_default {
        if is_selectable(registry, default) {
            return Some(default.clone());
        }
    }
    for provider in &registry.providers {
        if provider.registry_config.visibility.as_deref() == Some("hidden") {
            continue;
        }
        for model in &provider.models {
            if let Some(selection) =
                complete_new_model_selection(registry, &provider.provider_id, &model.model_id)
            {
                return Some(selection);
            }
        }
    }
    None
}

/// Picks the top reasoning level for a brand-new selection.
pub fn complete_new_model_selection(
    registry: &crate::resolver::ProviderRegistryView,
    provider_id: &str,
    model_id: &str,
) -> Option<crate::schema::ModelSelection> {
    let provider = registry
        .providers
        .iter()
        .find(|p| p.provider_id == provider_id)?;
    let model = provider.models.iter().find(|m| m.model_id == model_id)?;
    let reasoning_level = model
        .model_config
        .option_specs
        .reasoning_level
        .values
        .last()?;
    Some(crate::schema::ModelSelection {
        provider_id: provider_id.to_string(),
        model_id: model_id.to_string(),
        options: Some(crate::schema::ModelSelectionOptions {
            reasoning_level: Some(reasoning_level.clone()),
        }),
    })
}

fn is_selectable(
    registry: &crate::resolver::ProviderRegistryView,
    selection: &crate::schema::ModelSelection,
) -> bool {
    let Some(provider) = registry
        .providers
        .iter()
        .find(|p| p.provider_id == selection.provider_id)
    else {
        return false;
    };
    if provider.registry_config.visibility.as_deref() == Some("hidden") {
        return false;
    }
    let Some(model) = provider
        .models
        .iter()
        .find(|m| m.model_id == selection.model_id)
    else {
        return false;
    };
    validate_model_selection_options(model, selection).is_none()
}

/// Validates a selection against a model's reasoning-level spec. `None` = ok,
/// `Some(issue)` = the reason it is not complete.
pub fn validate_model_selection_options(
    model: &crate::resolver::ProviderModel,
    selection: &crate::schema::ModelSelection,
) -> Option<SelectionIssue> {
    let reasoning_level = selection.options.as_ref()?.reasoning_level.as_ref();
    let Some(reasoning_level) = reasoning_level else {
        return Some(SelectionIssue::ReasoningLevelMissing);
    };
    if !model
        .model_config
        .option_specs
        .reasoning_level
        .values
        .contains(reasoning_level)
    {
        return Some(SelectionIssue::ReasoningLevelNotSupported);
    }
    None
}

/// `resolveEffectiveModelSelection`: resolves the intent for a future execution
/// without mutating the selection. Account-plan providers map to the single
/// current connection; a missing or incomplete selection yields the issue.
pub fn resolve_effective_model_selection(
    selection: Option<&crate::schema::ModelSelection>,
    registry: &crate::resolver::ProviderRegistryView,
    account_states: Option<&[(String, AccountProviderState)]>,
    classify_provider: impl Fn(&str) -> ProviderKind,
    resolve_legacy_reasoning_level: Option<
        &dyn Fn(&crate::schema::ModelSelection) -> Option<String>,
    >,
) -> EffectiveModelSelectionResult {
    let Some(original) = selection else {
        return EffectiveModelSelectionResult {
            effective_selection: None,
            selection_issue: Some(SelectionIssue::SelectionMissing),
        };
    };
    let kind = classify_provider(&original.provider_id);
    let mut provider_id = original.provider_id.clone();
    if kind == ProviderKind::AccountPlan {
        let current: Vec<(&String, &AccountProviderState)> = account_states
            .map(|states| {
                states
                    .iter()
                    .filter(|(id, state)| {
                        state.current == Some(true)
                            && classify_provider(id) == ProviderKind::AccountPlan
                    })
                    .map(|(id, state)| (id, state))
                    .collect()
            })
            .unwrap_or_default();
        if current.len() != 1 {
            return EffectiveModelSelectionResult {
                effective_selection: None,
                selection_issue: Some(SelectionIssue::AccountConnectionUnavailable),
            };
        }
        provider_id = current[0].0.clone();
    }
    let Some(provider) = registry
        .providers
        .iter()
        .find(|p| p.provider_id == provider_id)
    else {
        return EffectiveModelSelectionResult {
            effective_selection: None,
            selection_issue: Some(SelectionIssue::ProviderNotFound),
        };
    };
    if provider.registry_config.visibility.as_deref() == Some("hidden")
        && kind != ProviderKind::AccountOffpeak
    {
        return EffectiveModelSelectionResult {
            effective_selection: None,
            selection_issue: Some(SelectionIssue::ProviderNotFound),
        };
    }
    let Some(model) = provider
        .models
        .iter()
        .find(|m| m.model_id == original.model_id)
    else {
        return EffectiveModelSelectionResult {
            effective_selection: None,
            selection_issue: Some(SelectionIssue::ModelNotFound),
        };
    };
    let mut normalized = original.clone();
    let mut validation = validate_model_selection_options(model, &normalized);
    if validation == Some(SelectionIssue::ReasoningLevelNotSupported) {
        if let Some(resolve) = resolve_legacy_reasoning_level {
            if let Some(level) = resolve(&original) {
                let candidate = crate::schema::ModelSelection {
                    provider_id: original.provider_id.clone(),
                    model_id: original.model_id.clone(),
                    options: Some(crate::schema::ModelSelectionOptions {
                        reasoning_level: Some(level),
                    }),
                };
                let checked = validate_model_selection_options(model, &candidate);
                if checked.is_none() {
                    normalized = candidate;
                    validation = None;
                }
            }
        }
    }
    let selection = crate::schema::ModelSelection {
        provider_id,
        model_id: original.model_id.clone(),
        options: normalized.options.clone().filter(|_| validation.is_none()),
    };
    let selection_issue = match validation {
        Some(SelectionIssue::ReasoningLevelMissing)
        | Some(SelectionIssue::ReasoningLevelNotSupported) => validation,
        _ => None,
    };
    EffectiveModelSelectionResult {
        effective_selection: Some(selection),
        selection_issue,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Ordinary,
    AccountPlan,
    AccountOffpeak,
}

/// The `model-selection` channel's `getView()` payload builder.
pub struct ModelSelectionViewInput<'a> {
    pub revision: u64,
    pub registry: &'a crate::resolver::ProviderRegistryView,
    pub configured_default: Option<&'a crate::schema::ModelSelection>,
    pub input_selection: Option<&'a crate::schema::ModelSelection>,
    pub account_states: Option<&'a [(String, AccountProviderState)]>,
    pub classify_provider: Option<Box<dyn Fn(&str) -> ProviderKind + 'a>>,
    pub resolve_legacy_reasoning_level:
        Option<Box<dyn Fn(&crate::schema::ModelSelection) -> Option<String> + 'a>>,
}

/// Assembles the `ModelSelectionView`. Mirrors `ModelSelectionFacade.getView`.
pub fn create_model_selection_view(input: ModelSelectionViewInput<'_>) -> ModelSelectionView {
    let classify = |id: &str| -> ProviderKind {
        match &input.classify_provider {
            Some(f) => f(id),
            None => ProviderKind::Ordinary,
        }
    };
    let normalized_default = input.configured_default.and_then(|default| {
        let effective = resolve_effective_model_selection(
            Some(default),
            input.registry,
            None,
            |_id| ProviderKind::Ordinary,
            input.resolve_legacy_reasoning_level.as_deref(),
        );
        effective
            .effective_selection
            .or_else(|| Some(default.clone()))
    });
    let initial = resolve_initial_model_selection(input.registry, normalized_default.as_ref());
    ModelSelectionView {
        revision: input.revision,
        providers: input
            .registry
            .providers
            .iter()
            .filter(|provider| provider.registry_config.visibility.as_deref() != Some("hidden"))
            .map(project_model_selection_provider_view)
            .collect(),
        preferred_selection: initial,
        effective: resolve_effective_model_selection(
            input.input_selection,
            input.registry,
            input.account_states,
            classify,
            input.resolve_legacy_reasoning_level.as_deref(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolver::{
        ProviderModel, RegistryEnumOptionSpec, RegistryLimitOptionSpec, RegistryModelConfig,
        RegistryModelOptionSpecs,
    };

    fn complete_provider_config() -> RegistryProviderConfig {
        RegistryProviderConfig {
            group: None,
            logo: None,
            access: crate::resolver::RegistryProviderAccess::ApiKey {
                api_key: Some("k".into()),
                api_key_management_url: None,
                api_key_editable: None,
            },
            api: crate::resolver::RegistryProviderApi {
                kind: "anthropic-messages".into(),
                base_url: Some("https://api.example.com".into()),
                headers: None,
            },
            builtin_model_ids: None,
            personal_model_ids: None,
            model_order: None,
            visibility: None,
        }
    }

    fn model(provider_id: &str, model_id: &str) -> ProviderModel {
        ProviderModel {
            model_id: model_id.to_string(),
            model_config: RegistryModelConfig {
                enabled: true,
                properties: crate::resolver::RegistryModelProperties {
                    requires_mfjs_tool_schema: false,
                    context_window: 200000,
                    input_format: crate::resolver::RegistryModelInputFormat {
                        supports_text: true,
                        supports_image: true,
                        supports_video: false,
                        supports_audio: false,
                        supports_pdf: true,
                    },
                    output_format: crate::resolver::RegistryModelOutputFormat {
                        supports_text: true,
                    },
                    supports_tool_call: true,
                    supports_json_schema_output: true,
                    supports_native_web_search: false,
                    supports_mid_conversation_system: true,
                },
                option_specs: RegistryModelOptionSpecs {
                    reasoning_level: RegistryEnumOptionSpec {
                        values: vec!["low".into(), "high".into()],
                        map: String::new(),
                    },
                    max_output_tokens: RegistryLimitOptionSpec {
                        max: 0,
                        map: String::new(),
                    },
                },
            },
        }
    }

    #[test]
    fn the_initial_selection_picks_the_top_reasoning_level() {
        let provider = Provider {
            provider_id: "p".into(),
            provider_name: None,
            template_id: None,
            registry_config: complete_provider_config(),
            models: vec![model("p", "m")],
        };
        let registry = crate::resolver::ProviderRegistryView {
            revision: 1,
            providers: vec![provider],
        };
        let selection = resolve_initial_model_selection(&registry, None).expect("a selection");
        assert_eq!(selection.model_id, "m");
        assert_eq!(
            selection
                .options
                .as_ref()
                .and_then(|o| o.reasoning_level.as_ref()),
            Some(&"high".to_string())
        );
    }

    #[test]
    fn a_missing_selection_reports_selection_missing() {
        let registry = crate::resolver::ProviderRegistryView {
            revision: 1,
            providers: vec![],
        };
        let result = resolve_effective_model_selection(
            None,
            &registry,
            None,
            |_| ProviderKind::Ordinary,
            None,
        );
        assert_eq!(
            result.selection_issue,
            Some(SelectionIssue::SelectionMissing)
        );
    }

    #[test]
    fn an_unsupported_reasoning_level_is_reported() {
        let provider = Provider {
            provider_id: "p".into(),
            provider_name: None,
            template_id: None,
            registry_config: complete_provider_config(),
            models: vec![model("p", "m")],
        };
        let registry = crate::resolver::ProviderRegistryView {
            revision: 1,
            providers: vec![provider],
        };
        let selection = crate::schema::ModelSelection {
            provider_id: "p".into(),
            model_id: "m".into(),
            options: Some(crate::schema::ModelSelectionOptions {
                reasoning_level: Some("bogus".into()),
            }),
        };
        let result = resolve_effective_model_selection(
            Some(&selection),
            &registry,
            None,
            |_| ProviderKind::Ordinary,
            None,
        );
        assert_eq!(
            result.selection_issue,
            Some(SelectionIssue::ReasoningLevelNotSupported)
        );
    }
}
