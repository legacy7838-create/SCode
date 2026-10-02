//! Provider config resolution into the Registry's complete-type view.
//!
//! Rust port of `packages/provider/src/resolver.ts` (`ProviderConfigResolver`)
//! and `registry.ts` (`ProviderRegistry`). The resolver merges the Built-in,
//! Personal, template, and account layers into one effective provider set,
//! re-checks every leaf against the *complete* schemas, and publishes only
//! providers whose config and models are provably complete (the Registry type
//! proof). Anything incomplete stays visible in `resolvedProviders` with its
//! `providerIssues` but is excluded from `registryProviders` — the Registry is
//! never handed a config a caller would have to defend against.

use crate::account::AccountProviderState;
use crate::config_service::BuiltinSnapshot;
use crate::domain::{
    ModelConfigRules, ProviderConfigMap, ProviderConfigRule, ProviderTemplateMap, ResolutionInput,
};
use crate::schema::{ProviderAccessData, ProviderApiType, ProviderConfigData};

/// A validation issue on a provider or model config. Mirrors
/// `ConfigValidationIssue` (code + path + message).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigValidationIssue {
    pub code: IssueCode,
    pub path: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IssueCode {
    RequiredFieldMissing,
    DuplicateKey,
    InvalidOptionSpec,
    InvalidConfig,
    InvalidUrl,
    MissingTemplate,
}

/// A model published to the Registry: id plus a *complete* config.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub model_id: String,
    pub model_config: RegistryModelConfig,
}

/// A provider published to the Registry: id plus a *complete* config.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub provider_id: String,
    pub provider_name: Option<String>,
    pub template_id: Option<String>,
    pub registry_config: RegistryProviderConfig,
    pub models: Vec<ProviderModel>,
}

/// The Registry view the Renderer consumes.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRegistryView {
    pub revision: u64,
    pub providers: Vec<Provider>,
}

/// The complete model config the Registry proves is safe to hand a renderer.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryModelConfig {
    pub enabled: bool,
    pub properties: RegistryModelProperties,
    pub option_specs: RegistryModelOptionSpecs,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryModelProperties {
    pub requires_mfjs_tool_schema: bool,
    pub context_window: u64,
    pub input_format: RegistryModelInputFormat,
    pub output_format: RegistryModelOutputFormat,
    pub supports_tool_call: bool,
    pub supports_json_schema_output: bool,
    pub supports_native_web_search: bool,
    pub supports_mid_conversation_system: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryModelInputFormat {
    pub supports_text: bool,
    pub supports_image: bool,
    pub supports_video: bool,
    pub supports_audio: bool,
    pub supports_pdf: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryModelOutputFormat {
    pub supports_text: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryModelOptionSpecs {
    pub reasoning_level: RegistryEnumOptionSpec,
    pub max_output_tokens: RegistryLimitOptionSpec,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEnumOptionSpec {
    pub values: Vec<String>,
    pub map: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryLimitOptionSpec {
    pub max: u64,
    pub map: String,
}

/// The complete provider config the Registry proves is safe to hand a renderer.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryProviderConfig {
    pub group: Option<String>,
    pub logo: Option<crate::schema::ProviderLogo>,
    pub access: RegistryProviderAccess,
    pub api: RegistryProviderApi,
    pub builtin_model_ids: Option<Vec<String>>,
    pub personal_model_ids: Option<Vec<String>>,
    pub model_order: Option<Vec<String>>,
    pub visibility: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RegistryProviderAccess {
    #[serde(rename = "api-key")]
    ApiKey {
        api_key: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key_management_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key_editable: Option<bool>,
    },
    #[serde(rename = "zhipu-coding-plan-api-key")]
    ZhipuCodingPlanApiKey {
        api_key: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key_management_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key_editable: Option<bool>,
    },
    #[serde(rename = "zhipu-account")]
    ZhipuAccount {
        account_type: Option<String>,
        mode: Option<String>,
        entitled: Option<bool>,
    },
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryProviderApi {
    #[serde(rename = "type")]
    pub kind: String,
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<Vec<(String, String)>>,
}

/// A resolved provider, kept with its issues even when excluded from the
/// Registry, so the UI can explain *why* a provider is not selectable.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedProvider {
    pub provider_id: String,
    pub enabled: bool,
    pub provider_name: Option<String>,
    pub template_id: Option<String>,
    pub provider_config: ProviderConfigData,
    pub template_config: Option<ProviderConfigData>,
    pub effective_builtin_config: Option<ProviderConfigData>,
    pub provider_issues: Vec<ConfigValidationIssue>,
    pub models: Vec<ResolvedProviderModel>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedProviderModel {
    pub model_id: String,
    pub source: &'static str,
    pub config: crate::schema::ModelConfigData,
    pub effective_builtin_config: crate::schema::ModelConfigData,
    pub issues: Vec<ConfigValidationIssue>,
    pub enabled: bool,
    pub executable: bool,
    pub selectable: bool,
}

/// The resolution result the facades and channel handlers consume.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderConfigResolution {
    pub effective_builtin_providers: ProviderConfigMap,
    pub effective_providers: ProviderConfigMap,
    pub resolved_providers: Vec<ResolvedProvider>,
    pub registry_providers: Vec<Provider>,
    pub issues: Vec<ConfigValidationIssue>,
}

#[derive(Debug, Clone)]
pub struct ResolverInput<'a> {
    pub zcode_builtin: &'a BuiltinSnapshot,
    pub account_providers: &'a ProviderConfigMap,
    pub account_states: Option<&'a [(String, AccountProviderState)]>,
    pub personal_providers: &'a ProviderConfigMap,
    pub personal_models: &'a ModelConfigRules,
    pub personal_provider_order: &'a [String],
}

/// Validates a model config against the complete model schema and returns the
/// typed Registry object when it is complete.
pub fn create_registry_model_config(
    config: &crate::schema::ModelConfigData,
    path: &[String],
) -> Result<RegistryModelConfig, Vec<ConfigValidationIssue>> {
    let mut issues = Vec::new();
    let enabled = match &config.enabled {
        Some(Some(enabled)) => Some(*enabled),
        _ => {
            issues.push(issue(
                path,
                IssueCode::RequiredFieldMissing,
                "model.enabled",
            ));
            None
        }
    };
    let properties = config.properties.as_ref().and_then(|p| p.as_ref());
    let (registry_properties, property_issues) = build_registry_properties(properties, path);
    issues.extend(property_issues);
    let option_specs = config.option_specs.as_ref().and_then(|o| o.as_ref());
    let (registry_specs, spec_issues) = build_registry_specs(option_specs, path);
    issues.extend(spec_issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(RegistryModelConfig {
        enabled: enabled.unwrap_or(false),
        properties: registry_properties.unwrap(),
        option_specs: registry_specs.unwrap(),
    })
}

fn build_registry_properties(
    properties: Option<&crate::schema::ModelPropertiesData>,
    path: &[String],
) -> (Option<RegistryModelProperties>, Vec<ConfigValidationIssue>) {
    fn missing_bool(path: &[String], issues: &mut Vec<ConfigValidationIssue>, leaf: &str) -> bool {
        issues.push(issue(path, IssueCode::RequiredFieldMissing, leaf));
        false
    }
    fn pick_bool(value: &Option<Option<bool>>) -> Option<bool> {
        value.as_ref().and_then(|v| v.as_ref()).copied()
    }

    let mut issues = Vec::new();
    let Some(properties) = properties else {
        issues.push(issue(path, IssueCode::RequiredFieldMissing, "properties"));
        return (None, issues);
    };
    let requires_mfjs = pick_bool(&properties.requires_mfjs_tool_schema)
        .unwrap_or_else(|| missing_bool(path, &mut issues, "requiresMfjsToolSchema"));
    let context_window = properties
        .context_window
        .as_ref()
        .and_then(|w| w.as_ref())
        .copied()
        .unwrap_or_else(|| {
            issues.push(issue(
                path,
                IssueCode::RequiredFieldMissing,
                "contextWindow",
            ));
            0
        });
    let supports_tool_call = pick_bool(&properties.supports_tool_call)
        .unwrap_or_else(|| missing_bool(path, &mut issues, "supportsToolCall"));
    let supports_json = pick_bool(&properties.supports_json_schema_output)
        .unwrap_or_else(|| missing_bool(path, &mut issues, "supportsJsonSchemaOutput"));
    let supports_web = pick_bool(&properties.supports_native_web_search)
        .unwrap_or_else(|| missing_bool(path, &mut issues, "supportsNativeWebSearch"));
    let supports_mid = pick_bool(&properties.supports_mid_conversation_system)
        .unwrap_or_else(|| missing_bool(path, &mut issues, "supportsMidConversationSystem"));

    let input = match properties.input_format.as_ref().and_then(|i| i.as_ref()) {
        Some(input) => RegistryModelInputFormat {
            supports_text: pick_bool(&input.supports_text)
                .unwrap_or_else(|| missing_bool(path, &mut issues, "inputFormat.supportsText")),
            supports_image: pick_bool(&input.supports_image)
                .unwrap_or_else(|| missing_bool(path, &mut issues, "inputFormat.supportsImage")),
            supports_video: pick_bool(&input.supports_video)
                .unwrap_or_else(|| missing_bool(path, &mut issues, "inputFormat.supportsVideo")),
            supports_audio: pick_bool(&input.supports_audio)
                .unwrap_or_else(|| missing_bool(path, &mut issues, "inputFormat.supportsAudio")),
            supports_pdf: pick_bool(&input.supports_pdf)
                .unwrap_or_else(|| missing_bool(path, &mut issues, "inputFormat.supportsPdf")),
        },
        None => {
            issues.push(issue(path, IssueCode::RequiredFieldMissing, "inputFormat"));
            RegistryModelInputFormat {
                supports_text: false,
                supports_image: false,
                supports_video: false,
                supports_audio: false,
                supports_pdf: false,
            }
        }
    };

    let supports_text_out = match properties.output_format.as_ref().and_then(|o| o.as_ref()) {
        Some(output) => pick_bool(&output.supports_text)
            .unwrap_or_else(|| missing_bool(path, &mut issues, "outputFormat.supportsText")),
        None => {
            issues.push(issue(path, IssueCode::RequiredFieldMissing, "outputFormat"));
            false
        }
    };

    if issues.is_empty() {
        (
            Some(RegistryModelProperties {
                requires_mfjs_tool_schema: requires_mfjs,
                context_window,
                input_format: input,
                output_format: RegistryModelOutputFormat {
                    supports_text: supports_text_out,
                },
                supports_tool_call,
                supports_json_schema_output: supports_json,
                supports_native_web_search: supports_web,
                supports_mid_conversation_system: supports_mid,
            }),
            issues,
        )
    } else {
        (None, issues)
    }
}

fn build_registry_specs(
    specs: Option<&crate::schema::ModelOptionSpecsData>,
    path: &[String],
) -> (Option<RegistryModelOptionSpecs>, Vec<ConfigValidationIssue>) {
    fn missing_leaf(path: &[String], issues: &mut Vec<ConfigValidationIssue>, leaf: &str) {
        issues.push(issue(path, IssueCode::RequiredFieldMissing, leaf));
    }

    let mut issues = Vec::new();
    let Some(specs) = specs else {
        missing_leaf(path, &mut issues, "optionSpecs");
        return (None, issues);
    };
    let reasoning = match specs.reasoning_level.as_ref().and_then(|l| l.as_ref()) {
        Some(level) => match (&level.values, &level.map) {
            (Some(Some(values)), Some(Some(map))) => RegistryEnumOptionSpec {
                values: values.clone(),
                map: map.clone(),
            },
            _ => {
                missing_leaf(path, &mut issues, "reasoningLevel");
                RegistryEnumOptionSpec {
                    values: Vec::new(),
                    map: String::new(),
                }
            }
        },
        None => {
            missing_leaf(path, &mut issues, "reasoningLevel");
            RegistryEnumOptionSpec {
                values: Vec::new(),
                map: String::new(),
            }
        }
    };
    let max_tokens = match specs.max_output_tokens.as_ref().and_then(|l| l.as_ref()) {
        Some(limit) => match (&limit.max, &limit.map) {
            (Some(Some(max)), Some(Some(map))) => RegistryLimitOptionSpec {
                max: *max,
                map: map.clone(),
            },
            _ => {
                missing_leaf(path, &mut issues, "maxOutputTokens");
                RegistryLimitOptionSpec {
                    max: 0,
                    map: String::new(),
                }
            }
        },
        None => {
            missing_leaf(path, &mut issues, "maxOutputTokens");
            RegistryLimitOptionSpec {
                max: 0,
                map: String::new(),
            }
        }
    };
    if issues.is_empty() {
        (
            Some(RegistryModelOptionSpecs {
                reasoning_level: reasoning,
                max_output_tokens: max_tokens,
            }),
            issues,
        )
    } else {
        (None, issues)
    }
}

/// Validates a provider config against the complete provider schema and
/// returns the typed Registry object when it is complete.
pub fn create_registry_provider_config(
    config: &ProviderConfigData,
    path: &[String],
) -> Result<RegistryProviderConfig, Vec<ConfigValidationIssue>> {
    let mut issues = Vec::new();
    let access = match config.access.as_ref().and_then(|a| a.as_ref()) {
        Some(access) => match access {
            ProviderAccessData::ApiKey {
                api_key,
                api_key_management_url,
                api_key_editable,
            } => Some(RegistryProviderAccess::ApiKey {
                api_key: api_key.as_ref().and_then(|k| k.as_ref()).cloned(),
                api_key_management_url: api_key_management_url
                    .as_ref()
                    .and_then(|k| k.as_ref())
                    .cloned(),
                api_key_editable: api_key_editable.as_ref().and_then(|k| k.as_ref()).copied(),
            }),
            ProviderAccessData::ZhipuCodingPlanApiKey {
                api_key,
                api_key_management_url,
                api_key_editable,
            } => Some(RegistryProviderAccess::ZhipuCodingPlanApiKey {
                api_key: api_key.as_ref().and_then(|k| k.as_ref()).cloned(),
                api_key_management_url: api_key_management_url
                    .as_ref()
                    .and_then(|k| k.as_ref())
                    .cloned(),
                api_key_editable: api_key_editable.as_ref().and_then(|k| k.as_ref()).copied(),
            }),
            ProviderAccessData::ZhipuAccount {
                account_type,
                mode,
                entitled,
            } => Some(RegistryProviderAccess::ZhipuAccount {
                account_type: account_type.as_ref().and_then(|t| t.as_ref()).cloned(),
                mode: mode.as_ref().and_then(|m| m.as_ref()).map(|m| {
                    match m {
                        crate::schema::ZhipuAccountMode::StartPlan => "start-plan",
                        crate::schema::ZhipuAccountMode::IndividualCodingPlan => {
                            "individual-coding-plan"
                        }
                        crate::schema::ZhipuAccountMode::TeamCodingPlan => "team-coding-plan",
                        crate::schema::ZhipuAccountMode::OffPeak => "off-peak",
                    }
                    .to_string()
                }),
                entitled: entitled.as_ref().and_then(|e| e.as_ref()).copied(),
            }),
        },
        None => {
            issues.push(issue(path, IssueCode::RequiredFieldMissing, "access"));
            None
        }
    };
    let api = build_registry_api(config, path, &mut issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(RegistryProviderConfig {
        group: config
            .group
            .as_ref()
            .and_then(|g| g.as_ref())
            .map(group_str),
        logo: config.logo.as_ref().and_then(|l| l.as_ref()).cloned(),
        access: access.unwrap(),
        api: api.unwrap(),
        builtin_model_ids: config
            .builtin_model_ids
            .as_ref()
            .and_then(|m| m.as_ref())
            .cloned(),
        personal_model_ids: config
            .personal_model_ids
            .as_ref()
            .and_then(|m| m.as_ref())
            .cloned(),
        model_order: config
            .model_order
            .as_ref()
            .and_then(|m| m.as_ref())
            .cloned(),
        visibility: config
            .visibility
            .as_ref()
            .and_then(|v| v.as_ref())
            .map(|v| {
                match v {
                    crate::schema::ProviderVisibility::Visible => "visible",
                    crate::schema::ProviderVisibility::Hidden => "hidden",
                }
                .to_string()
            }),
    })
}

fn build_registry_api(
    config: &ProviderConfigData,
    path: &[String],
    issues: &mut Vec<ConfigValidationIssue>,
) -> Option<RegistryProviderApi> {
    let Some(api) = config.api.as_ref().and_then(|a| a.as_ref()) else {
        issues.push(issue(path, IssueCode::RequiredFieldMissing, "api"));
        return None;
    };
    let Some(kind) = api.kind.as_ref().and_then(|k| k.as_ref()) else {
        issues.push(issue(path, IssueCode::RequiredFieldMissing, "api.type"));
        return None;
    };
    let base_url = api.base_url.as_ref().and_then(|b| b.as_ref()).cloned();
    let Some(base_url_value) = base_url.as_deref() else {
        issues.push(issue(path, IssueCode::RequiredFieldMissing, "api.baseUrl"));
        return None;
    };
    if base_url_value.trim().is_empty() || url::Url::parse(base_url_value).is_err() {
        issues.push(issue(path, IssueCode::InvalidUrl, "api.baseUrl"));
        return None;
    }
    Some(RegistryProviderApi {
        kind: api_kind_str(kind).to_string(),
        base_url,
        headers: api
            .headers
            .as_ref()
            .and_then(|h| h.as_ref())
            .map(|h| h.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
    })
}

fn group_str(group: &crate::schema::ProviderGroup) -> String {
    match group {
        crate::schema::ProviderGroup::StandardPersonal => "standard-personal",
        crate::schema::ProviderGroup::ZaiFamily => "zai-family",
        crate::schema::ProviderGroup::BigmodelFamily => "bigmodel-family",
    }
    .to_string()
}

fn api_kind_str(kind: &ProviderApiType) -> &'static str {
    match kind {
        ProviderApiType::AnthropicMessages => "anthropic-messages",
        ProviderApiType::OpenaiChatCompletions => "openai-chat-completions",
        ProviderApiType::OpenaiResponses => "openai-responses",
    }
}

fn issue(path: &[String], code: IssueCode, leaf: &str) -> ConfigValidationIssue {
    let mut full = path.to_vec();
    full.push(leaf.to_string());
    let joined = full.join(".");
    ConfigValidationIssue {
        code,
        path: full,
        message: format!("Missing required config {joined}"),
    }
}

fn issue_with_message(path: &[String], code: IssueCode, message: String) -> ConfigValidationIssue {
    ConfigValidationIssue {
        code,
        path: path.to_vec(),
        message,
    }
}

fn unique_in_order(values: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .iter()
        .filter(|value| seen.insert((*value).clone()))
        .cloned()
        .collect()
}

fn resolve_owned_order(
    builtin_ids: &[String],
    personal_ids: &[String],
    requested: &[String],
) -> Vec<String> {
    crate::config_service::resolve_owned_order_pub(builtin_ids, personal_ids, requested)
}

fn resolve_provider_order(input: &ResolverInput, effective: &ProviderConfigMap) -> Vec<String> {
    let source_ids: Vec<String> = effective.keys().into_iter().map(str::to_string).collect();
    let family_ids: Vec<String> = source_ids
        .iter()
        .filter(|provider_id| {
            matches!(
                effective
                    .get(provider_id)
                    .and_then(|c| c.group.as_ref())
                    .and_then(|g| g.as_ref()),
                Some(
                    crate::schema::ProviderGroup::ZaiFamily
                        | crate::schema::ProviderGroup::BigmodelFamily
                )
            )
        })
        .cloned()
        .collect();
    let family_set: std::collections::HashSet<&String> = family_ids.iter().collect();
    let builtin_ids: Vec<String> = input
        .zcode_builtin
        .providers
        .keys()
        .into_iter()
        .map(str::to_string)
        .filter(|id| !family_set.contains(id))
        .collect();
    let builtin_set: std::collections::HashSet<&String> = builtin_ids.iter().collect();
    let personal_ids: Vec<String> = input
        .personal_providers
        .keys()
        .into_iter()
        .map(str::to_string)
        .filter(|id| !builtin_set.contains(id) && !family_set.contains(id))
        .collect();
    let mut result = family_ids;
    result.extend(resolve_owned_order(
        &builtin_ids,
        &personal_ids,
        input.personal_provider_order,
    ));
    result
}

/// The Registry resolution engine. Mirrors `ProviderConfigResolver.resolve`.
pub fn resolve(input: &ResolverInput) -> ProviderConfigResolution {
    let templates: &ProviderTemplateMap = &input.zcode_builtin.provider_templates;
    // Account overlay is filtered to the built-in providers and loses group.
    let account_filtered: Vec<(String, ProviderConfigData)> = input
        .account_providers
        .entries()
        .iter()
        .filter(|(provider_id, _)| input.zcode_builtin.providers.has(provider_id))
        .map(|(provider_id, config)| (provider_id.to_string(), without_group(config)))
        .collect();
    let account_overlay = ProviderConfigMap::from_rules(
        account_filtered
            .into_iter()
            .map(|(provider_id, config)| ProviderConfigRule {
                provider_id,
                template_id: None,
                provider_name: None,
                enabled: None,
                config,
            })
            .collect(),
    )
    .unwrap_or_default();
    let concrete_builtin = input.zcode_builtin.providers.overlay(&account_overlay);
    let effective_builtin = concrete_builtin.map_configs(|concrete, _id, rule| {
        let template = rule
            .template_id
            .as_ref()
            .and_then(|t| t.as_ref())
            .and_then(|t| templates.get(t))
            .map(|t| &t.config);
        match template {
            Some(template) => overlay(template, concrete),
            None => concrete.clone(),
        }
    });
    let personal = input
        .personal_providers
        .map_configs(|config, provider_id, _rule| {
            if effective_builtin.has(provider_id) {
                without_group(config)
            } else {
                config.clone()
            }
        });
    let template_personal = personal.map_configs(|personal_config, provider_id, rule| {
        if effective_builtin.has(provider_id) {
            return personal_config.clone();
        }
        let template = rule
            .template_id
            .as_ref()
            .and_then(|t| t.as_ref())
            .and_then(|t| templates.get(t))
            .map(|t| &t.config);
        match template {
            Some(template) => overlay(template, personal_config),
            None => personal_config.clone(),
        }
    });
    let effective = effective_builtin.overlay(&template_personal);
    let effective_model_rules =
        ModelConfigRules::compose_effective(&input.zcode_builtin.models, input.personal_models);

    let mut issues: Vec<ConfigValidationIssue> = Vec::new();
    let mut resolved_providers = Vec::new();
    let mut registry_providers = Vec::new();

    for provider_id in resolve_provider_order(input, &effective) {
        let Some(rule) = effective.get_rule(&provider_id) else {
            continue;
        };
        let config = &rule.config;
        // Accounts do not support a global disable.
        let enabled = matches!(
            config.access.as_ref().and_then(|a| a.as_ref()),
            Some(ProviderAccessData::ZhipuAccount { .. })
        ) || rule.enabled.unwrap_or(true);
        let provider_path = vec!["providers".to_string(), provider_id.clone()];
        let registry_result = create_registry_provider_config(config, &provider_path);
        let mut provider_issues = registry_result.as_ref().err().cloned().unwrap_or_default();
        let template_id = rule.template_id.as_ref().and_then(|t| t.as_ref()).cloned();
        let template_config = template_id
            .as_ref()
            .and_then(|t| templates.get(t))
            .map(|t| t.config.clone());
        if template_id.is_some() && template_config.is_none() {
            provider_issues.push(issue_with_message(
                &provider_path,
                IssueCode::MissingTemplate,
                format!(
                    "Provider Template does not exist: {}",
                    template_id.as_deref().unwrap_or("")
                ),
            ));
        }
        issues.extend(provider_issues.iter().cloned());

        let builtin_model_ids = config
            .builtin_model_ids
            .as_ref()
            .and_then(|m| m.as_ref())
            .cloned()
            .unwrap_or_default();
        let builtin_ids_in_order = unique_in_order(&builtin_model_ids);
        let builtin_ids: std::collections::HashSet<&String> = builtin_ids_in_order.iter().collect();
        let personal_model_ids = config
            .personal_model_ids
            .as_ref()
            .and_then(|m| m.as_ref())
            .cloned()
            .unwrap_or_default();
        let personal_ids_in_order = unique_in_order(&personal_model_ids)
            .into_iter()
            .filter(|id| !builtin_ids.contains(id))
            .collect::<Vec<_>>();
        let model_order = config
            .model_order
            .as_ref()
            .and_then(|m| m.as_ref())
            .cloned()
            .unwrap_or_default();
        let ordered_model_ids =
            resolve_owned_order(&builtin_ids_in_order, &personal_ids_in_order, &model_order);

        let access_entitled = match config.access.as_ref().and_then(|a| a.as_ref()) {
            Some(ProviderAccessData::ZhipuAccount { entitled, .. }) => entitled
                .as_ref()
                .and_then(|e| e.as_ref())
                .copied()
                .unwrap_or(false),
            _ => true,
        };
        // Non-current accounts retain settings display but publish no models.
        let account_current = input
            .account_states
            .and_then(|states| states.iter().find(|(id, _)| id == &provider_id))
            .map(|(_, state)| state.current.unwrap_or(true))
            .unwrap_or(true);
        let provider_executable =
            enabled && access_entitled && account_current && provider_issues.is_empty();

        let api_type = config.api.as_ref().and_then(|a| a.as_ref()).and_then(|a| {
            a.kind
                .as_ref()
                .and_then(|k| k.as_ref())
                .map(api_kind_str)
                .map(str::to_string)
        });
        let api_base_url = config
            .api
            .as_ref()
            .and_then(|a| a.as_ref())
            .and_then(|a| a.base_url.as_ref().and_then(|b| b.as_ref()).cloned());

        let models = ordered_model_ids
            .iter()
            .map(|model_id| {
                let model_config = effective_model_rules.resolve(&ResolutionInput {
                    provider_id: provider_id.clone(),
                    template_id: template_id.clone(),
                    model_id: model_id.clone(),
                    api_type: api_type.clone(),
                    base_url: api_base_url.clone(),
                });
                let effective_builtin_config =
                    input.zcode_builtin.models.resolve(&ResolutionInput {
                        provider_id: provider_id.clone(),
                        template_id: template_id.clone(),
                        model_id: model_id.clone(),
                        api_type: api_type.clone(),
                        base_url: api_base_url.clone(),
                    });
                let mut model_path = provider_path.clone();
                model_path.push("models".to_string());
                model_path.push(model_id.clone());
                let registry_result = create_registry_model_config(&model_config, &model_path);
                let model_issues = registry_result.err().unwrap_or_default();
                issues.extend(model_issues.iter().cloned());
                let model_enabled = model_config.enabled == Some(Some(true));
                let executable = provider_executable && model_enabled && model_issues.is_empty();
                let selectable = executable
                    && config.visibility.as_ref().and_then(|v| v.as_ref())
                        != Some(&crate::schema::ProviderVisibility::Hidden);
                ResolvedProviderModel {
                    model_id: model_id.clone(),
                    source: if builtin_ids.contains(model_id) {
                        "builtin"
                    } else {
                        "personal"
                    },
                    config: model_config,
                    effective_builtin_config,
                    issues: model_issues,
                    enabled: model_enabled,
                    executable,
                    selectable,
                }
            })
            .collect::<Vec<_>>();

        let effective_builtin_config = effective_builtin.get(&provider_id).cloned();

        resolved_providers.push(ResolvedProvider {
            provider_id: provider_id.clone(),
            enabled,
            provider_name: rule
                .provider_name
                .as_ref()
                .and_then(|n| n.as_ref())
                .cloned(),
            template_id: template_id.clone(),
            provider_config: config.clone(),
            template_config,
            effective_builtin_config,
            provider_issues: provider_issues.clone(),
            models,
        });

        if let Err(_provider_issue_list) = &registry_result {
            continue;
        }
        if !provider_issues.is_empty() {
            continue;
        }
        let valid_models = resolved_providers
            .last()
            .map(|p| {
                p.models
                    .iter()
                    .filter(|m| m.executable)
                    .map(|m| {
                        let mut path = provider_path.clone();
                        path.push("models".to_string());
                        path.push(m.model_id.clone());
                        let result = create_registry_model_config(&m.config, &path);
                        match result {
                            Ok(config) => Some(ProviderModel {
                                model_id: m.model_id.clone(),
                                model_config: config,
                            }),
                            Err(_) => None,
                        }
                    })
                    .collect::<Vec<_>>()
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if valid_models.is_empty() {
            continue;
        }
        registry_providers.push(Provider {
            provider_id: provider_id.clone(),
            provider_name: rule
                .provider_name
                .as_ref()
                .and_then(|n| n.as_ref())
                .cloned(),
            template_id: template_id.clone(),
            registry_config: registry_result.unwrap(),
            models: valid_models,
        });
    }

    ProviderConfigResolution {
        effective_builtin_providers: effective_builtin.clone(),
        effective_providers: effective,
        resolved_providers,
        registry_providers,
        issues,
    }
}

fn without_group(config: &ProviderConfigData) -> ProviderConfigData {
    ProviderConfigData {
        group: None,
        ..config.clone()
    }
}

/// Overlay helper mirroring `ProviderConfig.overlay` for the resolution paths
/// that use raw sparse config data (group inherits unless present, nested
/// configs merge).
fn overlay(base: &ProviderConfigData, next: &ProviderConfigData) -> ProviderConfigData {
    use crate::domain::Overlay as _;
    base.overlay(next)
}

pub fn registry_view_from_resolution(
    resolution: &ProviderConfigResolution,
    revision: u64,
) -> ProviderRegistryView {
    ProviderRegistryView {
        revision,
        providers: resolution.registry_providers.clone(),
    }
}

/// Publishes a validation message for the `invalid-option-spec` classification
/// used when the config issue path touches `optionSpecs`.
pub fn classification_for_path(path: &[String]) -> IssueCode {
    if path.iter().any(|p| p == "optionSpecs") {
        IssueCode::InvalidOptionSpec
    } else {
        IssueCode::InvalidConfig
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ModelConfigRule, ProviderConfigRule};

    fn empty_resolution() -> ProviderConfigResolution {
        ProviderConfigResolution {
            effective_builtin_providers: ProviderConfigMap::empty(),
            effective_providers: ProviderConfigMap::empty(),
            resolved_providers: Vec::new(),
            registry_providers: Vec::new(),
            issues: Vec::new(),
        }
    }

    #[test]
    fn an_incomplete_model_config_is_excluded_from_the_registry() {
        let incomplete = crate::schema::ModelConfigData {
            enabled: Some(Some(true)),
            properties: None,
            option_specs: None,
        };
        let error = create_registry_model_config(&incomplete, &["providers".into(), "p".into()])
            .unwrap_err();
        assert!(!error.is_empty());
    }

    #[test]
    fn a_complete_model_config_produces_a_registry_object() {
        let complete = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "properties": {
                "requiresMfjsToolSchema": false,
                "contextWindow": 200000,
                "inputFormat": {"supportsText": true, "supportsImage": true, "supportsVideo": false, "supportsAudio": false, "supportsPdf": true},
                "outputFormat": {"supportsText": true},
                "supportsToolCall": true,
                "supportsJsonSchemaOutput": true,
                "supportsNativeWebSearch": false,
                "supportsMidConversationSystem": true
            },
            "optionSpecs": {
                "reasoningLevel": {"values": ["low", "high"], "map": "{\"thinking\": reasoningLevel}"},
                "maxOutputTokens": {"max": 4096, "map": "{\"max_tokens\": maxOutputTokens}"}
            }
        }))
        .unwrap();
        let registry = create_registry_model_config(&complete, &[]).expect("complete config");
        assert_eq!(registry.enabled, true);
        assert_eq!(registry.properties.context_window, 200000);
        assert_eq!(
            registry.option_specs.reasoning_level.values,
            vec!["low", "high"]
        );
    }

    #[test]
    fn a_provider_with_an_incomplete_api_is_excluded() {
        let incomplete = serde_json::from_value(serde_json::json!({
            "access": {"type": "api-key", "apiKey": "k"},
            "api": {"type": "anthropic-messages", "baseUrl": ""}
        }))
        .unwrap();
        let error = create_registry_provider_config(&incomplete, &["providers".into(), "p".into()])
            .unwrap_err();
        assert!(
            error
                .iter()
                .any(|i| i.code == IssueCode::InvalidUrl
                    || i.code == IssueCode::RequiredFieldMissing),
            "{error:?}"
        );
    }

    #[test]
    fn an_empty_resolution_holds_no_providers() {
        let result = empty_resolution();
        assert!(result.registry_providers.is_empty());
        assert!(result.issues.is_empty());
    }
}
