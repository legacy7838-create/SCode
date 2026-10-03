//! Personal Provider Config — strict on-disk schema.
//!
//! Rust port of `packages/provider/src/config/rule-data-schema.ts`,
//! `provider-data-schema.ts`, `manual-model-config.ts`, and
//! `packages/shared/src/model-config.ts`. The zod schemas are translated to
//! serde structs with identical key order (load-bearing for the config
//! revision CAS, which hashes the serialised bytes), identical strictness
//! (`deny_unknown_fields`), identical optionality (`nullable` + `optional`
//! becomes `Sparse<T>`), and the same super-refinements (duplicate ids,
//! smart/manual identity collision, account-access rule rejection, pattern and
//! option-map compilation).

use serde::{Deserialize, Serialize};

/// Zod `.nullable().optional()` on an object field: absent, JSON null, or a
/// value are all legal, and the absence/null distinction must survive a
/// decode→encode round trip (encoding strips only absent keys).
pub type Sparse<T> = Option<Option<T>>;

/// Serializer/deserializer that keeps the three possible meanings of a sparse
/// field distinct: absent (None), explicit null (Some(None)), or a concrete
/// value (Some(Some(v))). serde's blanket `Option::deserialize` collapses
/// absent and null into the same state, which would drop explicit `null` keys
/// from files the TS side round-trips with `null` intact.
pub(crate) mod sparse_opt {
    use serde::Deserialize as _;

    pub fn serialize<S, T>(value: &Option<Option<T>>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
        T: serde::Serialize,
    {
        match value {
            // None means the key was absent; it is only serialised when the
            // caller explicitly asks for it, never silently coerced to null.
            None => unreachable!("absent sparse field is skipped"),
            Some(None) => serializer.serialize_none(),
            Some(Some(value)) => value.serialize(serializer),
        }
    }

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: serde::de::DeserializeOwned,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        match value {
            serde_json::Value::Null => Ok(Some(None)),
            other => {
                let typed = serde_json::from_value::<T>(other).map_err(serde::de::Error::custom)?;
                Ok(Some(Some(typed)))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Model config data (packages/shared/src/model-config.ts)
// ---------------------------------------------------------------------------

fn non_empty(value: &str) -> bool {
    !value.trim().is_empty()
}

fn check_model_option_map(map: &str, variable: &str) -> Result<(), String> {
    let variable_name: zcode_model_option_map::ModelOptionName = variable
        .parse()
        .map_err(|_| format!("unknown model option name: {variable}"))?;
    zcode_model_option_map::compile_model_option_map(map, variable_name)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnumOptionSpecData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Sparse<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map: Sparse<String>,
}

impl EnumOptionSpecData {
    pub fn validate(&self) -> Result<(), String> {
        match &self.values {
            Some(Some(values)) => {
                if values.is_empty() {
                    return Err("reasoningLevel.values must not be empty".into());
                }
                let mut seen = std::collections::HashSet::new();
                for value in values {
                    if !non_empty(value) {
                        return Err("reasoningLevel.values must be non-empty strings".into());
                    }
                    if !seen.insert(value) {
                        return Err("reasoningLevel.values must not contain duplicates".into());
                    }
                }
            }
            _ => {}
        }
        if let Some(Some(map)) = &self.map {
            check_model_option_map(map, "reasoningLevel")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LimitOptionSpecData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Sparse<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map: Sparse<String>,
}

impl LimitOptionSpecData {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(Some(max)) = &self.max {
            if *max == 0 {
                return Err("maxOutputTokens.max must be positive".into());
            }
        }
        if let Some(Some(map)) = &self.map {
            check_model_option_map(map, "maxOutputTokens")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelInputFormatData {
    #[serde(
        rename = "supportsText",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_text: Sparse<bool>,
    #[serde(
        rename = "supportsImage",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_image: Sparse<bool>,
    #[serde(
        rename = "supportsVideo",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_video: Sparse<bool>,
    #[serde(
        rename = "supportsAudio",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_audio: Sparse<bool>,
    #[serde(
        rename = "supportsPdf",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_pdf: Sparse<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModelOutputFormatData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_text: Sparse<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelPropertiesData {
    #[serde(
        rename = "requiresMfjsToolSchema",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub requires_mfjs_tool_schema: Sparse<bool>,
    #[serde(
        rename = "contextWindow",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_window: Sparse<u64>,
    #[serde(
        rename = "inputFormat",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_format: Sparse<ModelInputFormatData>,
    #[serde(
        rename = "outputFormat",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub output_format: Sparse<ModelOutputFormatData>,
    #[serde(
        rename = "supportsToolCall",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_tool_call: Sparse<bool>,
    #[serde(
        rename = "supportsJsonSchemaOutput",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_json_schema_output: Sparse<bool>,
    #[serde(
        rename = "supportsNativeWebSearch",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_native_web_search: Sparse<bool>,
    #[serde(
        rename = "supportsMidConversationSystem",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_mid_conversation_system: Sparse<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelOptionSpecsData {
    #[serde(
        rename = "reasoningLevel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub reasoning_level: Sparse<EnumOptionSpecData>,
    #[serde(
        rename = "maxOutputTokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub max_output_tokens: Sparse<LimitOptionSpecData>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelConfigData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Sparse<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub properties: Sparse<ModelPropertiesData>,
    #[serde(
        default,
        rename = "optionSpecs",
        skip_serializing_if = "Option::is_none"
    )]
    pub option_specs: Sparse<ModelOptionSpecsData>,
}

impl ModelConfigData {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(Some(properties)) = &self.properties {
            if let Some(Some(window)) = &properties.context_window {
                if *window == 0 {
                    return Err("properties.contextWindow must be positive".into());
                }
            }
        }
        if let Some(Some(option_specs)) = &self.option_specs {
            if let Some(Some(spec)) = &option_specs.reasoning_level {
                spec.validate()?;
            }
            if let Some(Some(spec)) = &option_specs.max_output_tokens {
                spec.validate()?;
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Manual model config (packages/provider/src/config/manual-model-config.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManualModelProperties {
    #[serde(rename = "contextWindow")]
    pub context_window: u64,
    #[serde(rename = "supportsJsonSchemaOutput")]
    pub supports_json_schema_output: bool,
    #[serde(rename = "supportsNativeWebSearch")]
    pub supports_native_web_search: bool,
    #[serde(rename = "supportsMidConversationSystem")]
    pub supports_mid_conversation_system: bool,
    #[serde(rename = "inputFormat")]
    pub input_format: ManualModelInputFormat,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManualModelInputFormat {
    #[serde(rename = "supportsImage")]
    pub supports_image: bool,
    #[serde(rename = "supportsVideo")]
    pub supports_video: bool,
    #[serde(rename = "supportsPdf")]
    pub supports_pdf: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManualModelOptionSpecs {
    #[serde(rename = "reasoningLevel")]
    pub reasoning_level: CompleteEnumOptionSpec,
    #[serde(rename = "maxOutputTokens")]
    pub max_output_tokens: ManualMaxOutputTokens,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManualMaxOutputTokens {
    pub max: u64,
}

// completeEnumOptionSpecDataSchema shape: values required + map required.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteEnumOptionSpec {
    pub values: Vec<String>,
    pub map: String,
}

impl CompleteEnumOptionSpec {
    pub fn validate(&self) -> Result<(), String> {
        if self.values.is_empty() {
            return Err("reasoningLevel.values must not be empty".into());
        }
        let mut seen = std::collections::HashSet::new();
        for value in &self.values {
            if !non_empty(value) {
                return Err("reasoningLevel.values must be non-empty strings".into());
            }
            if !seen.insert(value) {
                return Err("reasoningLevel.values must not contain duplicates".into());
            }
        }
        check_model_option_map(&self.map, "reasoningLevel")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManualModelConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Sparse<bool>,
    pub properties: ManualModelProperties,
    #[serde(rename = "optionSpecs")]
    pub option_specs: ManualModelOptionSpecs,
}

impl ManualModelConfig {
    pub fn validate(&self) -> Result<(), String> {
        self.option_specs.reasoning_level.validate()?;
        if self.properties.context_window == 0 {
            return Err("properties.contextWindow must be positive".into());
        }
        if self.option_specs.max_output_tokens.max == 0 {
            return Err("optionSpecs.maxOutputTokens.max must be positive".into());
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Provider data (packages/provider/src/config/provider-data-schema.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderApiType {
    AnthropicMessages,
    #[serde(rename = "openai-chat-completions")]
    OpenaiChatCompletions,
    #[serde(rename = "openai-responses")]
    OpenaiResponses,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderGroup {
    StandardPersonal,
    ZaiFamily,
    BigmodelFamily,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ZhipuAccountMode {
    StartPlan,
    IndividualCodingPlan,
    TeamCodingPlan,
    OffPeak,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderVisibility {
    Visible,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderLogo {
    #[serde(rename = "type")]
    pub kind: String,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiKeyAccessData {
    #[serde(rename = "type")]
    pub kind: ApiKeyAccessType,
    #[serde(
        default,
        rename = "apiKey",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub api_key: Option<Option<String>>,
    #[serde(
        default,
        rename = "apiKeyManagementUrl",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub api_key_management_url: Option<Option<String>>,
    #[serde(
        default,
        rename = "apiKeyEditable",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub api_key_editable: Option<Option<bool>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApiKeyAccessType {
    #[serde(rename = "api-key")]
    ApiKey,
    #[serde(rename = "zhipu-coding-plan-api-key")]
    ZhipuCodingPlanApiKey,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ZhipuAccountAccessData {
    #[serde(rename = "type")]
    pub kind: ZhipuAccountAccessType,
    #[serde(
        default,
        rename = "accountType",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub account_type: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub mode: Option<Option<ZhipuAccountMode>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub entitled: Option<Option<bool>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ZhipuAccountAccessType {
    #[serde(rename = "zhipu-account")]
    ZhipuAccount,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ProviderAccessData {
    #[serde(rename = "api-key")]
    ApiKey {
        #[serde(
            default,
            rename = "apiKey",
            skip_serializing_if = "Option::is_none",
            with = "crate::schema::sparse_opt"
        )]
        api_key: Option<Option<String>>,
        #[serde(
            default,
            rename = "apiKeyManagementUrl",
            skip_serializing_if = "Option::is_none",
            with = "crate::schema::sparse_opt"
        )]
        api_key_management_url: Option<Option<String>>,
        #[serde(
            default,
            rename = "apiKeyEditable",
            skip_serializing_if = "Option::is_none",
            with = "crate::schema::sparse_opt"
        )]
        api_key_editable: Option<Option<bool>>,
    },
    #[serde(rename = "zhipu-coding-plan-api-key")]
    ZhipuCodingPlanApiKey {
        #[serde(
            default,
            rename = "apiKey",
            skip_serializing_if = "Option::is_none",
            with = "crate::schema::sparse_opt"
        )]
        api_key: Option<Option<String>>,
        #[serde(
            default,
            rename = "apiKeyManagementUrl",
            skip_serializing_if = "Option::is_none",
            with = "crate::schema::sparse_opt"
        )]
        api_key_management_url: Option<Option<String>>,
        #[serde(
            default,
            rename = "apiKeyEditable",
            skip_serializing_if = "Option::is_none",
            with = "crate::schema::sparse_opt"
        )]
        api_key_editable: Option<Option<bool>>,
    },
    #[serde(rename = "zhipu-account")]
    ZhipuAccount {
        #[serde(
            default,
            rename = "accountType",
            skip_serializing_if = "Option::is_none",
            with = "crate::schema::sparse_opt"
        )]
        account_type: Option<Option<String>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "crate::schema::sparse_opt"
        )]
        mode: Option<Option<ZhipuAccountMode>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "crate::schema::sparse_opt"
        )]
        entitled: Option<Option<bool>>,
    },
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderApiData {
    #[serde(
        default,
        rename = "type",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub kind: Option<Option<ProviderApiType>>,
    #[serde(
        default,
        rename = "baseUrl",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub base_url: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub headers: Option<Option<std::collections::BTreeMap<String, String>>>,
}

// providerConfigDataSchema (providerConfigDataSchema used as the personal config payload).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfigData {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub group: Option<Option<ProviderGroup>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub logo: Option<Option<ProviderLogo>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub access: Option<Option<ProviderAccessData>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub api: Option<Option<ProviderApiData>>,
    #[serde(
        default,
        rename = "builtinModelIds",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub builtin_model_ids: Option<Option<Vec<String>>>,
    #[serde(
        default,
        rename = "personalModelIds",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub personal_model_ids: Option<Option<Vec<String>>>,
    #[serde(
        default,
        rename = "modelOrder",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub model_order: Option<Option<Vec<String>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub visibility: Option<Option<ProviderVisibility>>,
}

// ---------------------------------------------------------------------------
// Rule data (packages/provider/src/config/rule-data-schema.ts)
// ---------------------------------------------------------------------------

fn valid_pattern(pattern: &str) -> bool {
    regex::Regex::new(&format!("^(?:{pattern})$")).is_ok()
}

fn valid_url(value: &str) -> bool {
    url::Url::parse(value).is_ok()
}

fn validate_access_fields(access: &Option<Option<ProviderAccessData>>) -> Result<(), String> {
    match access {
        Some(Some(ProviderAccessData::ApiKey {
            api_key_management_url: Some(Some(url)),
            ..
        }))
        | Some(Some(ProviderAccessData::ZhipuCodingPlanApiKey {
            api_key_management_url: Some(Some(url)),
            ..
        })) => {
            if !valid_url(url) {
                return Err(format!("{url} is not a valid URL"));
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_provider_config_data(config: &ProviderConfigData) -> Result<(), String> {
    if let Some(Some(logo)) = &config.logo {
        if logo.kind != "builtin" || logo.key.is_empty() {
            return Err("logo must be a builtin reference with a non-empty key".into());
        }
    }
    validate_access_fields(&config.access)?;
    if let Some(Some(api)) = &config.api {
        if let Some(Some(base_url)) = &api.base_url {
            if !valid_url(base_url) {
                return Err(format!("{base_url} is not a valid URL"));
            }
        }
    }
    for models in [
        &config.builtin_model_ids,
        &config.personal_model_ids,
        &config.model_order,
    ]
    .into_iter()
    .flatten()
    .flatten()
    {
        for id in models {
            if id.is_empty() {
                return Err("model id must not be empty".into());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfigRuleData {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(
        default,
        rename = "templateId",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub template_id: Option<Option<String>>,
    #[serde(
        default,
        rename = "providerName",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub provider_name: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub config: ProviderConfigData,
}

impl ProviderConfigRuleData {
    pub fn validate(&self) -> Result<(), String> {
        if self.provider_id.is_empty() {
            return Err("providerId must not be empty".into());
        }
        validate_provider_config_data(&self.config)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTemplateRuleData {
    #[serde(rename = "templateId")]
    pub template_id: String,
    #[serde(rename = "templateNameMap")]
    pub template_name_map: ProviderTemplateNameMap,
    pub config: TemplateConfigData,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProviderTemplateNameMap {
    #[serde(rename = "zh-CN", default, skip_serializing_if = "Option::is_none")]
    pub zh_cn: Option<String>,
    #[serde(rename = "en-US", default, skip_serializing_if = "Option::is_none")]
    pub en_us: Option<String>,
}

fn check_unique(ids: &[String], group: &str, key: &str) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(format!("Duplicate {key}: {id}"));
        }
    }
    let _ = group;
    Ok(())
}

// Template schema: access may only be the "public" anonymous marker.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateConfigData {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub logo: Option<Option<ProviderLogo>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub access: Option<Option<TemplateAccessData>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub api: Option<Option<ProviderApiData>>,
    #[serde(
        default,
        rename = "builtinModelIds",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub builtin_model_ids: Option<Option<Vec<String>>>,
}

impl TemplateConfigData {
    /// Converts the strict template projection to the full ProviderConfigData
    /// shape consumed by the domain overlay layer.
    pub fn to_provider_config(&self) -> ProviderConfigData {
        ProviderConfigData {
            group: None,
            logo: self.logo.clone(),
            access: match &self.access {
                None => None,
                Some(None) => Some(None),
                Some(Some(access)) => Some(Some(match access.kind {
                    ApiKeyAccessType::ApiKey => ProviderAccessData::ApiKey {
                        api_key: access.api_key.clone(),
                        api_key_management_url: access.api_key_management_url.clone(),
                        api_key_editable: access.api_key_editable.clone(),
                    },
                    ApiKeyAccessType::ZhipuCodingPlanApiKey => {
                        ProviderAccessData::ZhipuCodingPlanApiKey {
                            api_key: access.api_key.clone(),
                            api_key_management_url: access.api_key_management_url.clone(),
                            api_key_editable: access.api_key_editable.clone(),
                        }
                    }
                })),
            },
            api: self.api.clone(),
            builtin_model_ids: self.builtin_model_ids.clone(),
            personal_model_ids: None,
            model_order: None,
            visibility: None,
        }
    }

    pub fn from_provider_config(config: &ProviderConfigData) -> Self {
        Self {
            logo: config.logo.clone(),
            access: match &config.access {
                None => None,
                Some(None) => Some(None),
                Some(Some(access)) => Some(Some(match access {
                    ProviderAccessData::ApiKey {
                        api_key,
                        api_key_management_url,
                        api_key_editable,
                    } => TemplateAccessData {
                        kind: ApiKeyAccessType::ApiKey,
                        api_key: api_key.clone(),
                        api_key_management_url: api_key_management_url.clone(),
                        api_key_editable: api_key_editable.clone(),
                    },
                    ProviderAccessData::ZhipuCodingPlanApiKey {
                        api_key,
                        api_key_management_url,
                        api_key_editable,
                    } => TemplateAccessData {
                        kind: ApiKeyAccessType::ZhipuCodingPlanApiKey,
                        api_key: api_key.clone(),
                        api_key_management_url: api_key_management_url.clone(),
                        api_key_editable: api_key_editable.clone(),
                    },
                    ProviderAccessData::ZhipuAccount { .. } => {
                        // The Zhipu-account variant is not a legal Template access
                        // schema; decode should reject it first.
                        TemplateAccessData {
                            kind: ApiKeyAccessType::ApiKey,
                            api_key: None,
                            api_key_management_url: None,
                            api_key_editable: None,
                        }
                    }
                })),
            },
            api: config.api.clone(),
            builtin_model_ids: config.builtin_model_ids.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateAccessData {
    #[serde(rename = "type")]
    pub kind: ApiKeyAccessType,
    #[serde(
        default,
        rename = "apiKey",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub api_key: Option<Option<String>>,
    #[serde(
        default,
        rename = "apiKeyManagementUrl",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub api_key_management_url: Option<Option<String>>,
    #[serde(
        default,
        rename = "apiKeyEditable",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub api_key_editable: Option<Option<bool>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelMatchRuleData {
    #[serde(rename = "modelMatch")]
    pub model_match: String,
    pub config: ModelConfigData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelApiMatchRuleData {
    #[serde(rename = "modelMatch")]
    pub model_match: String,
    #[serde(rename = "apiTypeMatch")]
    pub api_type_match: String,
    pub config: ModelConfigData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderSiteMatchRuleData {
    #[serde(rename = "modelMatch")]
    pub model_match: String,
    #[serde(rename = "baseUrlMatch")]
    pub base_url_match: String,
    #[serde(
        default,
        rename = "apiTypeMatch",
        skip_serializing_if = "Option::is_none"
    )]
    pub api_type_match: Option<String>,
    pub config: ModelConfigData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateModelRuleData {
    #[serde(rename = "templateId")]
    pub template_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub config: ModelConfigData,
}

// providerModelConfigRuleSchema — zod key order: modelId, config, providerId.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderModelRuleData {
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub config: ModelConfigData,
    #[serde(rename = "providerId")]
    pub provider_id: String,
}

// manualProviderModelConfigRuleSchema — zod key order: modelId, config, providerId.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManualProviderModelRuleData {
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub config: ManualModelConfig,
    #[serde(rename = "providerId")]
    pub provider_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuiltinModelConfigRulesData {
    #[serde(rename = "modelRules")]
    pub model_rules: Vec<ModelMatchRuleData>,
    #[serde(rename = "modelApiRules")]
    pub model_api_rules: Vec<ModelApiMatchRuleData>,
    #[serde(rename = "providerSiteRules")]
    pub provider_site_rules: Vec<ProviderSiteMatchRuleData>,
    #[serde(rename = "templateModelRules")]
    pub template_model_rules: Vec<TemplateModelRuleData>,
    #[serde(rename = "builtinProviderModelRules")]
    pub builtin_provider_model_rules: Vec<ProviderModelRuleData>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersonalModelConfigRulesData {
    #[serde(rename = "providerModelRules")]
    pub provider_model_rules: Vec<ProviderModelRuleData>,
    #[serde(rename = "manualProviderModelRules")]
    pub manual_provider_model_rules: Vec<ManualProviderModelRuleData>,
}

impl BuiltinModelConfigRulesData {
    pub fn validate(&self) -> Result<(), String> {
        for rule in &self.model_rules {
            if !valid_pattern(&rule.model_match) {
                return Err("Invalid match pattern: modelMatch".into());
            }
            rule.config.validate()?;
        }
        for rule in &self.model_api_rules {
            if !valid_pattern(&rule.model_match) || !valid_pattern(&rule.api_type_match) {
                return Err("Invalid match pattern".into());
            }
            rule.config.validate()?;
        }
        for rule in &self.provider_site_rules {
            if !valid_pattern(&rule.model_match) || !valid_pattern(&rule.base_url_match) {
                return Err("Invalid match pattern".into());
            }
            if let Some(api_type_match) = &rule.api_type_match {
                if !valid_pattern(api_type_match) {
                    return Err("Invalid match pattern: apiTypeMatch".into());
                }
            }
            rule.config.validate()?;
        }
        for rule in &self.template_model_rules {
            rule.config.validate()?;
        }
        for rule in &self.builtin_provider_model_rules {
            rule.config.validate()?;
        }
        Ok(())
    }
}

impl PersonalModelConfigRulesData {
    pub fn validate(&self) -> Result<(), String> {
        // Contradictory patterns cannot be masked by the last override.
        let mut smart_ids = std::collections::HashSet::new();
        for rule in &self.provider_model_rules {
            smart_ids.insert((rule.provider_id.clone(), rule.model_id.clone()));
        }
        for rule in &self.manual_provider_model_rules {
            if smart_ids.contains(&(rule.provider_id.clone(), rule.model_id.clone())) {
                return Err(format!(
                    "The same Provider/Model cannot declare both smart and manual config: {}/{}",
                    rule.provider_id, rule.model_id
                ));
            }
            rule.config.validate()?;
        }
        for rule in &self.provider_model_rules {
            rule.config.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersonalProviderConfigRulesData {
    #[serde(rename = "providerRules")]
    pub provider_rules: Vec<PersonalProviderConfigRuleData>,
}

impl PersonalProviderConfigRulesData {
    pub fn validate(&self) -> Result<(), String> {
        let mut ids = std::collections::HashSet::new();
        for rule in &self.provider_rules {
            if !ids.insert(&rule.provider_id) {
                return Err(format!("Duplicate providerId: {}", rule.provider_id));
            }
            if rule.provider_id.starts_with("account:") && rule.config.access.is_some() {
                return Err(
                    "Access for a pinned Account Provider can only be declared by the ZCode Built-in Config"
                        .into(),
                );
            }
            validate_personal_provider_config_data(&rule.config)?;
        }
        Ok(())
    }
}

fn validate_personal_provider_config_data(
    config: &PersonalProviderConfigData,
) -> Result<(), String> {
    if let Some(Some(logo)) = &config.logo {
        if logo.kind != "builtin" || logo.key.is_empty() {
            return Err("logo must be a builtin reference with a non-empty key".into());
        }
    }
    validate_access_fields(&config.access)?;
    if let Some(Some(api)) = &config.api {
        if let Some(Some(base_url)) = &api.base_url {
            if !valid_url(base_url) {
                return Err(format!("{base_url} is not a valid URL"));
            }
        }
    }
    for models in [&config.personal_model_ids, &config.model_order]
        .into_iter()
        .flatten()
        .flatten()
    {
        for id in models {
            if id.is_empty() {
                return Err("model id must not be empty".into());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersonalProviderConfigRuleData {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(
        default,
        rename = "templateId",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub template_id: Option<Option<String>>,
    #[serde(
        default,
        rename = "providerName",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub provider_name: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub config: PersonalProviderConfigData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersonalProviderConfigData {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub group: Option<Option<ProviderGroup>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub logo: Option<Option<ProviderLogo>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub access: Option<Option<ProviderAccessData>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub api: Option<Option<ProviderApiData>>,
    #[serde(
        default,
        rename = "personalModelIds",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub personal_model_ids: Option<Option<Vec<String>>>,
    #[serde(
        default,
        rename = "modelOrder",
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub model_order: Option<Option<Vec<String>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::schema::sparse_opt"
    )]
    pub visibility: Option<Option<ProviderVisibility>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTemplateConfigRulesData {
    #[serde(rename = "templateRules")]
    pub template_rules: Vec<ProviderTemplateRuleData>,
    #[serde(rename = "providerRules")]
    pub provider_rules: Vec<ProviderConfigRuleData>,
}

impl ProviderTemplateConfigRulesData {
    pub fn validate(&self) -> Result<(), String> {
        let template_ids: Vec<String> = self
            .template_rules
            .iter()
            .map(|rule| rule.template_id.clone())
            .collect();
        check_unique(&template_ids, "templateRules", "templateId")?;
        let provider_ids: Vec<String> = self
            .provider_rules
            .iter()
            .map(|rule| rule.provider_id.clone())
            .collect();
        check_unique(&provider_ids, "providerRules", "providerId")?;
        for rule in &self.template_rules {
            let provider = rule.config.to_provider_config();
            validate_provider_config_data(&provider)?;
        }
        for rule in &self.provider_rules {
            rule.validate()?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Codec (packages/provider-node/src/provider-config-file-codec.ts)
// ---------------------------------------------------------------------------

const CURRENT_SCHEMA_VERSION: u64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum ProviderConfigFileError {
    #[error("Provider Config is missing schemaVersion")]
    MissingSchemaVersion,
    #[error("Provider Config schemaVersion {0} is newer than the currently supported {CURRENT_SCHEMA_VERSION}")]
    UnsupportedNewerVersion(u64),
    #[error("Provider Config schemaVersion must be a non-negative integer")]
    InvalidSchemaVersion,
    #[error("Missing Provider Config migrator from schemaVersion {0} to {1}")]
    MissingMigrator(u64, u64),
    #[error("Provider Config file failed validation: {0}")]
    Invalid(String),
    #[error("Provider Config is not valid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfigFile {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u64,
    pub config: ProviderConfigFileConfig,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfigFileConfig {
    #[serde(
        default,
        rename = "providerOrder",
        skip_serializing_if = "Option::is_none"
    )]
    pub provider_order: Option<Vec<String>>,
    #[serde(rename = "providerConfigRules")]
    pub provider_config_rules: PersonalProviderConfigRulesData,
    #[serde(rename = "modelConfigRules")]
    pub model_config_rules: PersonalModelConfigRulesData,
    #[serde(
        default,
        rename = "defaultModelSelection",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_model_selection: Option<ModelSelection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSelection {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<ModelSelectionOptions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSelectionOptions {
    #[serde(
        default,
        rename = "reasoningLevel",
        skip_serializing_if = "Option::is_none"
    )]
    pub reasoning_level: Option<String>,
}

impl ModelSelection {
    pub fn validate(&self) -> Result<(), String> {
        if self.provider_id.trim().is_empty() || self.model_id.trim().is_empty() {
            return Err("ModelSelection requires providerId and modelId".into());
        }
        if let Some(options) = &self.options {
            if let Some(level) = &options.reasoning_level {
                if level.trim().is_empty() {
                    return Err("reasoningLevel must not be blank".into());
                }
            }
        }
        Ok(())
    }
}

/// The decoded, validated personal file.
#[derive(Debug, Clone, PartialEq)]
pub struct PersonalConfigLayer {
    pub providers: PersonalProviderConfigRulesData,
    pub models: PersonalModelConfigRulesData,
    pub provider_order: Option<Vec<String>>,
    pub default_model_selection: Option<ModelSelection>,
}

/// Decode + normalise the stored JSON bytes. Legacy manual rules with the old
/// complete shape are narrowed to the editable subset before validation.
pub fn decode_provider_config_file(
    input: &serde_json::Value,
) -> Result<PersonalConfigLayer, ProviderConfigFileError> {
    let version = read_schema_version(input)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(ProviderConfigFileError::UnsupportedNewerVersion(version));
    }
    if version < CURRENT_SCHEMA_VERSION {
        return Err(ProviderConfigFileError::MissingMigrator(
            version,
            version + 1,
        ));
    }
    if let Some(unknown) = input
        .as_object()
        .map(|object| {
            object
                .keys()
                .find(|key| key.as_str() != "schemaVersion" && key.as_str() != "config")
        })
        .flatten()
    {
        return Err(ProviderConfigFileError::Invalid(format!(
            "unknown key: {unknown}"
        )));
    }
    let config = input
        .get("config")
        .ok_or_else(|| ProviderConfigFileError::Invalid("missing config".into()))?;
    if let Some(unknown) = config
        .as_object()
        .map(|object| {
            object.keys().find(|key| {
                !matches!(
                    key.as_str(),
                    "providerOrder"
                        | "providerConfigRules"
                        | "modelConfigRules"
                        | "defaultModelSelection"
                )
            })
        })
        .flatten()
    {
        return Err(ProviderConfigFileError::Invalid(format!(
            "unknown key: {unknown}"
        )));
    }
    let provider_config_rules = config
        .get("providerConfigRules")
        .ok_or_else(|| ProviderConfigFileError::Invalid("missing providerConfigRules".into()))?;
    let model_config_rules = config
        .get("modelConfigRules")
        .ok_or_else(|| ProviderConfigFileError::Invalid("missing modelConfigRules".into()))?;

    let providers: PersonalProviderConfigRulesData =
        serde_json::from_value(provider_config_rules.clone())
            .map_err(|error| ProviderConfigFileError::Invalid(error.to_string()))?;
    providers
        .validate()
        .map_err(ProviderConfigFileError::Invalid)?;

    let mut models_value = model_config_rules.clone();
    normalize_legacy_manual_rules(&mut models_value);
    let models: PersonalModelConfigRulesData = serde_json::from_value(models_value)
        .map_err(|error| ProviderConfigFileError::Invalid(error.to_string()))?;
    models
        .validate()
        .map_err(ProviderConfigFileError::Invalid)?;

    let mut provider_order = None;
    if let Some(order_value) = config.get("providerOrder") {
        let order: Vec<String> = serde_json::from_value(order_value.clone())
            .map_err(|error| ProviderConfigFileError::Invalid(error.to_string()))?;
        for id in &order {
            if id.is_empty() {
                return Err(ProviderConfigFileError::Invalid(
                    "providerOrder ids must not be empty".into(),
                ));
            }
        }
        provider_order = Some(order);
    }
    let mut default_model_selection = None;
    if let Some(selection_value) = config.get("defaultModelSelection") {
        let selection: ModelSelection = serde_json::from_value(selection_value.clone())
            .map_err(|error| ProviderConfigFileError::Invalid(error.to_string()))?;
        selection
            .validate()
            .map_err(ProviderConfigFileError::Invalid)?;
        default_model_selection = Some(selection);
    }

    Ok(PersonalConfigLayer {
        providers,
        models,
        provider_order,
        default_model_selection,
    })
}

fn read_schema_version(input: &serde_json::Value) -> Result<u64, ProviderConfigFileError> {
    let version = input
        .get("schemaVersion")
        .ok_or(ProviderConfigFileError::MissingSchemaVersion)?;
    version
        .as_u64()
        .ok_or(ProviderConfigFileError::InvalidSchemaVersion)
}

/// TS `normalizeLegacyManualRules`: a manual rule whose `config` matches neither
/// the current editable schema nor the legacy complete shapes is left untouched
/// and will fail the strict personal parse (recovery then triggers).
fn normalize_legacy_manual_rules(rules: &mut serde_json::Value) {
    let Some(manual_rules) = rules
        .get_mut("manualProviderModelRules")
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    for rule in manual_rules {
        let Some(config) = rule.get("config") else {
            continue;
        };
        if serde_json::from_value::<ManualModelConfig>(config.clone()).is_ok() {
            continue;
        }
        if let Some(extracted) = extract_legacy_manual_config(config) {
            if let Some(config_slot) = rule.get_mut("config") {
                *config_slot = serde_json::to_value(extracted).unwrap_or(serde_json::Value::Null);
            }
        }
    }
}

/// Extract the editable leaves from a legacy complete config shape, so a file
/// written by the old editor does not lose the whole personal configuration.
fn extract_legacy_manual_config(config: &serde_json::Value) -> Option<ManualModelConfig> {
    let enabled = config.get("enabled")?;
    let properties = config.get("properties")?;
    let option_specs = config.get("optionSpecs")?;

    let extract = |value: &serde_json::Value, keys: &[&str]| -> Option<serde_json::Value> {
        value.as_object().map(|object| {
            serde_json::Value::Object(
                object
                    .iter()
                    .filter(|(key, _)| keys.contains(&key.as_str()))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            )
        })
    };

    let input_format = properties.get("inputFormat")?;
    let manual_properties = serde_json::json!({
        "contextWindow": properties.get("contextWindow")?,
        "supportsJsonSchemaOutput": properties.get("supportsJsonSchemaOutput")?,
        "supportsNativeWebSearch": properties.get("supportsNativeWebSearch")?,
        "supportsMidConversationSystem": properties.get("supportsMidConversationSystem")?,
        "inputFormat": extract(input_format, &["supportsImage", "supportsVideo", "supportsPdf"])?,
    });
    let manual_option_specs = serde_json::json!({
        "reasoningLevel": option_specs.get("reasoningLevel")?,
        "maxOutputTokens": extract(option_specs.get("maxOutputTokens")?, &["max"])?,
    });
    let candidate = serde_json::json!({
        "enabled": enabled,
        "properties": manual_properties,
        "optionSpecs": manual_option_specs,
    });
    serde_json::from_value(candidate).ok()
}

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

pub fn encode_provider_config_file(layer: &PersonalConfigLayer) -> ProviderConfigFile {
    ProviderConfigFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        config: ProviderConfigFileConfig {
            provider_order: layer.provider_order.clone(),
            provider_config_rules: layer.providers.clone(),
            model_config_rules: layer.models.clone(),
            default_model_selection: layer.default_model_selection.clone(),
        },
    }
}

/// Canonical bytes compared by the file revision CAS and written to disk.
pub fn encode_provider_config_file_bytes(
    layer: &PersonalConfigLayer,
) -> Result<Vec<u8>, ProviderConfigFileError> {
    let file = encode_provider_config_file(layer);
    serde_json::to_vec_pretty(&file).map_err(ProviderConfigFileError::InvalidJson)
}

pub fn decode_provider_config_file_bytes(
    bytes: &[u8],
) -> Result<PersonalConfigLayer, ProviderConfigFileError> {
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    decode_provider_config_file(&value)
}

// ---------------------------------------------------------------------------
// Builtin release codec (packages/provider-node/src/zcode-builtin-release.ts)
// ---------------------------------------------------------------------------

const ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION: u64 = 1;
const RETIRED_ZAPI_PROVIDER_ID: &str = "builtin:zapi";

#[derive(Debug, Clone, thiserror::Error)]
pub enum BuiltinReleaseError {
    #[error("Builtin Provider Release is not valid JSON")]
    InvalidJson,
    #[error("Builtin Provider Release must have schemaVersion 1")]
    UnsupportedSchemaVersion,
    #[error("Builtin Provider Release decode failed: {0}")]
    Decode(String),
    #[error("ZCode Built-in Release contains a retired Provider: {RETIRED_ZAPI_PROVIDER_ID}")]
    RetiredProvider,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuiltinConfigEnvelope {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u64,
    pub revision: u64,
    pub config: BuiltinConfigEnvelopeConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuiltinConfigEnvelopeConfig {
    #[serde(rename = "providerConfigRules")]
    pub provider_config_rules: ProviderTemplateConfigRulesData,
    #[serde(rename = "modelConfigRules")]
    pub model_config_rules: BuiltinModelConfigRulesData,
}

/// Decoded builtin release: content plus providers/templates/models ready for
/// the config-service. The original assembles zod-parsed shapes; this port
/// keeps the same checks.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltinRelease {
    pub revision: u64,
    pub providers: crate::domain::ProviderConfigMap,
    pub provider_templates: crate::domain::ProviderTemplateMap,
    pub models: crate::domain::ModelConfigRules,
}

pub fn decode_builtin_release(
    input: &serde_json::Value,
) -> Result<BuiltinRelease, BuiltinReleaseError> {
    let envelope: BuiltinConfigEnvelope = serde_json::from_value(input.clone())
        .map_err(|error| BuiltinReleaseError::Decode(error.to_string()))?;
    if envelope.schema_version != ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION {
        return Err(BuiltinReleaseError::UnsupportedSchemaVersion);
    }
    envelope
        .config
        .provider_config_rules
        .validate()
        .map_err(BuiltinReleaseError::Decode)?;
    envelope
        .config
        .model_config_rules
        .validate()
        .map_err(BuiltinReleaseError::Decode)?;

    let providers = crate::domain::ProviderConfigMap::from_rules(
        envelope
            .config
            .provider_config_rules
            .provider_rules
            .iter()
            .map(|rule| crate::domain::ProviderConfigRule {
                provider_id: rule.provider_id.clone(),
                template_id: rule.template_id.clone(),
                provider_name: rule.provider_name.clone(),
                enabled: rule.enabled,
                config: rule.config.clone(),
            })
            .collect(),
    )
    .map_err(BuiltinReleaseError::Decode)?;
    if providers
        .rules()
        .iter()
        .any(|rule| rule.provider_id == RETIRED_ZAPI_PROVIDER_ID)
    {
        return Err(BuiltinReleaseError::RetiredProvider);
    }
    let provider_templates = crate::domain::ProviderTemplateMap::from_templates(
        envelope
            .config
            .provider_config_rules
            .template_rules
            .iter()
            .map(|rule| crate::domain::ProviderTemplate {
                template_id: rule.template_id.clone(),
                template_name_map: crate::domain::ProviderTemplateNameMap {
                    zh_cn: rule.template_name_map.zh_cn.clone(),
                    en_us: rule.template_name_map.en_us.clone(),
                },
                config: rule.config.to_provider_config(),
            })
            .collect(),
    )
    .map_err(BuiltinReleaseError::Decode)?;

    let models = {
        let mut rules = Vec::new();
        for rule in envelope.config.model_config_rules.model_rules {
            rules.push(crate::domain::ModelConfigRule::Model(rule));
        }
        for rule in envelope.config.model_config_rules.model_api_rules {
            rules.push(crate::domain::ModelConfigRule::ModelApi(rule));
        }
        for rule in envelope.config.model_config_rules.provider_site_rules {
            rules.push(crate::domain::ModelConfigRule::ProviderSite(rule));
        }
        for rule in envelope.config.model_config_rules.template_model_rules {
            rules.push(crate::domain::ModelConfigRule::TemplateModel(rule));
        }
        for rule in envelope
            .config
            .model_config_rules
            .builtin_provider_model_rules
        {
            rules.push(crate::domain::ModelConfigRule::ProviderModel(rule));
        }
        crate::domain::ModelConfigRules::new(rules)
    };
    Ok(BuiltinRelease {
        revision: envelope.revision,
        providers,
        provider_templates,
        models,
    })
}

/// Build the domain rule list from the file-form builtin model rules — the
/// same construction `decode_builtin_release` performs, exposed so the legacy
/// reasoning-level resolver can rebuild it from raw rule JSON.
pub fn builtin_model_rules_to_domain(
    data: &BuiltinModelConfigRulesData,
) -> crate::domain::ModelConfigRules {
    let mut rules = Vec::new();
    for rule in &data.model_rules {
        rules.push(crate::domain::ModelConfigRule::Model(rule.clone()));
    }
    for rule in &data.model_api_rules {
        rules.push(crate::domain::ModelConfigRule::ModelApi(rule.clone()));
    }
    for rule in &data.provider_site_rules {
        rules.push(crate::domain::ModelConfigRule::ProviderSite(rule.clone()));
    }
    for rule in &data.template_model_rules {
        rules.push(crate::domain::ModelConfigRule::TemplateModel(rule.clone()));
    }
    for rule in &data.builtin_provider_model_rules {
        rules.push(crate::domain::ModelConfigRule::ProviderModel(rule.clone()));
    }
    crate::domain::ModelConfigRules::new(rules)
}

/// Build the domain rule list from the file-form personal model rules.
pub fn personal_model_rules_to_domain(
    data: &PersonalModelConfigRulesData,
) -> crate::domain::ModelConfigRules {
    let mut rules: Vec<crate::domain::ModelConfigRule> = Vec::new();
    rules.extend(
        data.provider_model_rules
            .iter()
            .map(|rule| crate::domain::ModelConfigRule::ProviderModel(rule.clone())),
    );
    rules.extend(
        data.manual_provider_model_rules
            .iter()
            .map(|rule| crate::domain::ModelConfigRule::ManualProviderModel(rule.clone())),
    );
    crate::domain::ModelConfigRules::new(rules)
}

pub fn encode_builtin_release(release: &BuiltinRelease) -> Result<Vec<u8>, BuiltinReleaseError> {
    let provider_rules: Vec<ProviderConfigRuleData> = release
        .providers
        .rules()
        .iter()
        .map(|rule| rule.to_data())
        .collect();
    let template_rules: Vec<ProviderTemplateRuleData> = release
        .provider_templates
        .entries()
        .iter()
        .map(|template| ProviderTemplateRuleData {
            template_id: template.template_id.clone(),
            template_name_map: crate::schema::ProviderTemplateNameMap {
                zh_cn: template.template_name_map.zh_cn.clone(),
                en_us: template.template_name_map.en_us.clone(),
            },
            config: TemplateConfigData::from_provider_config(&template.config),
        })
        .collect();
    let model_config_rules = release
        .models
        .to_builtin_data()
        .map_err(BuiltinReleaseError::Decode)?;
    let envelope = BuiltinConfigEnvelope {
        schema_version: ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
        revision: release.revision,
        config: BuiltinConfigEnvelopeConfig {
            provider_config_rules: ProviderTemplateConfigRulesData {
                template_rules,
                provider_rules,
            },
            model_config_rules,
        },
    };
    serde_json::to_vec(&envelope)
        .map_err(|_| BuiltinReleaseError::Decode("builtin release encode failed".into()))
}

pub fn encode_builtin_release_pretty(
    release: &BuiltinRelease,
) -> Result<Vec<u8>, BuiltinReleaseError> {
    let provider_rules: Vec<ProviderConfigRuleData> = release
        .providers
        .rules()
        .iter()
        .map(|rule| rule.to_data())
        .collect();
    let template_rules: Vec<ProviderTemplateRuleData> = release
        .provider_templates
        .entries()
        .iter()
        .map(|template| ProviderTemplateRuleData {
            template_id: template.template_id.clone(),
            template_name_map: crate::schema::ProviderTemplateNameMap {
                zh_cn: template.template_name_map.zh_cn.clone(),
                en_us: template.template_name_map.en_us.clone(),
            },
            config: TemplateConfigData::from_provider_config(&template.config),
        })
        .collect();
    let model_config_rules = release
        .models
        .to_builtin_data()
        .map_err(BuiltinReleaseError::Decode)?;
    let envelope = BuiltinConfigEnvelope {
        schema_version: ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
        revision: release.revision,
        config: BuiltinConfigEnvelopeConfig {
            provider_config_rules: ProviderTemplateConfigRulesData {
                template_rules,
                provider_rules,
            },
            model_config_rules,
        },
    };
    serde_json::to_vec_pretty(&envelope)
        .map_err(|_| BuiltinReleaseError::Decode("builtin release encode failed".into()))
}

/// The Active file's cache identity. Mirrors the TS
/// `createHash("sha256").update(resolve(activeFilePath)).digest("hex")`.
pub fn source_key_for_active_path(active_file_path: &std::path::Path) -> String {
    let absolute = if active_file_path.is_absolute() {
        active_file_path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(active_file_path)
    };
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(absolute.to_string_lossy().as_bytes());
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod builtin_release_tests {
    use super::*;

    fn repo_config_builtin() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../config/provider/zcode-builtin.json")
    }

    #[test]
    fn builtin_release_round_trips_canonically() {
        let path = repo_config_builtin();
        if !path.exists() {
            eprintln!("skipping canonical builtin release test: {path:?} missing");
            return;
        }
        let bytes = std::fs::read(&path).unwrap();
        let input: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let release = decode_builtin_release(&input).unwrap();
        let encoded = encode_builtin_release(&release).unwrap();
        let ts_canonical: String = {
            // TS output is JSON.stringify(encodeZCodeBuiltinRelease(decode(...))),
            // a compact single-line JSON identical to `encoded` — produced once by
            // scripts/compare-ts.mjs and embedded here for fast verification.
            let Ok(ts) = std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/_fixture_canonical_builtin.json"),
            ) else {
                eprintln!("ts canonical fixture not present; checking internal round-trip only");
                let decoded_again: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
                let re_encoded =
                    encode_builtin_release(&decode_builtin_release(&decoded_again).unwrap())
                        .unwrap();
                assert_eq!(
                    String::from_utf8(encoded).unwrap(),
                    String::from_utf8(re_encoded).unwrap()
                );
                return;
            };
            ts
        };
        assert_eq!(String::from_utf8(encoded).unwrap(), ts_canonical);
    }
}
