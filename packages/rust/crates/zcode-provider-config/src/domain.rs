//! Provider config domain overlays and maps.
//!
//! Rust analog of the TypeScript overlay/class machinery in
//! `packages/provider/src/config/provider-config.ts` and `model-config.ts`.
//! The overlay rule is identical everywhere: fields the overlay leaves
//! `undefined` inherit from the base; `null` replaces; a value replaces —
//! except nested overlayable configs (access/api/properties/option specs),
//! which recurse. Byte-parity with TS relies on struct field order matching
//! the zod schemas, which is pinned by decode/encode round-trip tests.

use crate::schema::{
    EnumOptionSpecData, LimitOptionSpecData, ManualProviderModelRuleData, ModelApiMatchRuleData,
    ModelConfigData, ModelInputFormatData, ModelMatchRuleData, ModelOptionSpecsData,
    ModelOutputFormatData, ModelPropertiesData, ProviderAccessData, ProviderApiData,
    ProviderConfigData, ProviderConfigRuleData, ProviderModelRuleData, ProviderSiteMatchRuleData,
    ProviderTemplateRuleData, TemplateConfigData, TemplateModelRuleData,
};

/// `overlayValue`: undefined/absent inherits, anything else replaces
/// (including null).
fn overlay_value<T: Clone>(
    base: &Option<Option<T>>,
    next: &Option<Option<T>>,
) -> Option<Option<T>> {
    match next {
        None => base.clone(),
        some => some.clone(),
    }
}

/// Nested config overlay: absent inherits, null wins, object merges recursively.
fn overlay_sparse<T: Overlay>(
    base: &Option<Option<T>>,
    next: &Option<Option<T>>,
) -> Option<Option<T>> {
    match (base, next) {
        (_, None) => base.clone(),
        (_, Some(None)) => Some(None),
        (None, Some(Some(n))) | (Some(None), Some(Some(n))) => Some(Some(n.clone())),
        (Some(Some(b)), Some(Some(n))) => Some(Some(b.overlay(n))),
    }
}

pub trait Overlay: Clone {
    fn overlay(&self, next: &Self) -> Self;
}

impl Overlay for EnumOptionSpecData {
    fn overlay(&self, next: &Self) -> Self {
        Self {
            values: overlay_value(&self.values, &next.values),
            map: overlay_value(&self.map, &next.map),
        }
    }
}

impl Overlay for LimitOptionSpecData {
    fn overlay(&self, next: &Self) -> Self {
        Self {
            max: overlay_value(&self.max, &next.max),
            map: overlay_value(&self.map, &next.map),
        }
    }
}

impl Overlay for ModelInputFormatData {
    fn overlay(&self, next: &Self) -> Self {
        Self {
            supports_text: overlay_value(&self.supports_text, &next.supports_text),
            supports_image: overlay_value(&self.supports_image, &next.supports_image),
            supports_video: overlay_value(&self.supports_video, &next.supports_video),
            supports_audio: overlay_value(&self.supports_audio, &next.supports_audio),
            supports_pdf: overlay_value(&self.supports_pdf, &next.supports_pdf),
        }
    }
}

impl Overlay for ModelOutputFormatData {
    fn overlay(&self, next: &Self) -> Self {
        Self {
            supports_text: overlay_value(&self.supports_text, &next.supports_text),
        }
    }
}

impl Overlay for ModelPropertiesData {
    fn overlay(&self, next: &Self) -> Self {
        Self {
            requires_mfjs_tool_schema: overlay_value(
                &self.requires_mfjs_tool_schema,
                &next.requires_mfjs_tool_schema,
            ),
            context_window: overlay_value(&self.context_window, &next.context_window),
            input_format: overlay_sparse(&self.input_format, &next.input_format),
            output_format: overlay_sparse(&self.output_format, &next.output_format),
            supports_tool_call: overlay_value(&self.supports_tool_call, &next.supports_tool_call),
            supports_json_schema_output: overlay_value(
                &self.supports_json_schema_output,
                &next.supports_json_schema_output,
            ),
            supports_native_web_search: overlay_value(
                &self.supports_native_web_search,
                &next.supports_native_web_search,
            ),
            supports_mid_conversation_system: overlay_value(
                &self.supports_mid_conversation_system,
                &next.supports_mid_conversation_system,
            ),
        }
    }
}

impl Overlay for ModelOptionSpecsData {
    fn overlay(&self, next: &Self) -> Self {
        Self {
            reasoning_level: overlay_sparse(&self.reasoning_level, &next.reasoning_level),
            max_output_tokens: overlay_sparse(&self.max_output_tokens, &next.max_output_tokens),
        }
    }
}

impl Overlay for ModelConfigData {
    fn overlay(&self, next: &Self) -> Self {
        Self {
            enabled: overlay_value(&self.enabled, &next.enabled),
            properties: overlay_sparse(&self.properties, &next.properties),
            option_specs: overlay_sparse(&self.option_specs, &next.option_specs),
        }
    }
}

impl Overlay for ProviderApiData {
    fn overlay(&self, next: &Self) -> Self {
        Self {
            kind: overlay_value(&self.kind, &next.kind),
            base_url: overlay_value(&self.base_url, &next.base_url),
            headers: overlay_value(&self.headers, &next.headers),
        }
    }
}

/// ProviderAccessConfig overlay: same variant recurses, type change replaces,
/// null replaces.
fn overlay_access(
    base: &Option<Option<ProviderAccessData>>,
    next: &Option<Option<ProviderAccessData>>,
) -> Option<Option<ProviderAccessData>> {
    match (base, next) {
        (_, None) => base.clone(),
        (_, Some(None)) => Some(None),
        (None, Some(Some(n))) | (Some(None), Some(Some(n))) => Some(Some(n.clone())),
        (Some(Some(b)), Some(Some(n))) => Some(Some(overlay_access_layer(b, n))),
    }
}

fn overlay_access_layer(
    base: &ProviderAccessData,
    next: &ProviderAccessData,
) -> ProviderAccessData {
    use ProviderAccessData::*;
    match (base, next) {
        (ApiKey { .. }, ApiKey { .. })
        | (ZhipuCodingPlanApiKey { .. }, ZhipuCodingPlanApiKey { .. }) => match (base, next) {
            (
                ApiKey {
                    api_key,
                    api_key_management_url,
                    api_key_editable,
                },
                ApiKey {
                    api_key: n_api_key,
                    api_key_management_url: n_url,
                    api_key_editable: n_editable,
                },
            )
            | (
                ZhipuCodingPlanApiKey {
                    api_key,
                    api_key_management_url,
                    api_key_editable,
                },
                ZhipuCodingPlanApiKey {
                    api_key: n_api_key,
                    api_key_management_url: n_url,
                    api_key_editable: n_editable,
                },
            ) => {
                let access = if matches!(base, ApiKey { .. }) {
                    ApiKey {
                        api_key: overlay_value(api_key, n_api_key),
                        api_key_management_url: overlay_value(api_key_management_url, n_url),
                        api_key_editable: overlay_value(api_key_editable, n_editable),
                    }
                } else {
                    ZhipuCodingPlanApiKey {
                        api_key: overlay_value(api_key, n_api_key),
                        api_key_management_url: overlay_value(api_key_management_url, n_url),
                        api_key_editable: overlay_value(api_key_editable, n_editable),
                    }
                };
                access
            }
            _ => unreachable!(),
        },
        (
            ZhipuAccount {
                account_type,
                mode,
                entitled,
            },
            ZhipuAccount {
                account_type: n_at,
                mode: n_mode,
                entitled: n_entitled,
            },
        ) => ZhipuAccount {
            account_type: overlay_value(account_type, n_at),
            mode: overlay_value(mode, n_mode),
            entitled: overlay_value(entitled, n_entitled),
        },
        _ => next.clone(),
    }
}

impl Overlay for ProviderConfigData {
    fn overlay(&self, next: &Self) -> Self {
        Self {
            group: overlay_value(&self.group, &next.group),
            logo: overlay_value(&self.logo, &next.logo),
            access: overlay_access(&self.access, &next.access),
            api: overlay_sparse(&self.api, &next.api),
            builtin_model_ids: overlay_value(&self.builtin_model_ids, &next.builtin_model_ids),
            personal_model_ids: overlay_value(&self.personal_model_ids, &next.personal_model_ids),
            model_order: overlay_value(&self.model_order, &next.model_order),
            visibility: overlay_value(&self.visibility, &next.visibility),
        }
    }
}

// ---------------------------------------------------------------------------
// ProviderConfigMap — ordered, duplicate-checked rule index.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderConfigRule {
    pub provider_id: String,
    pub template_id: Option<Option<String>>,
    pub provider_name: Option<Option<String>>,
    pub enabled: Option<bool>,
    pub config: ProviderConfigData,
}

impl ProviderConfigRule {
    pub fn to_data(&self) -> ProviderConfigRuleData {
        ProviderConfigRuleData {
            provider_id: self.provider_id.clone(),
            template_id: self.template_id.clone(),
            provider_name: self.provider_name.clone(),
            enabled: self.enabled,
            config: self.config.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProviderConfigMap {
    rules: Vec<ProviderConfigRule>,
}

impl ProviderConfigMap {
    pub fn from_rules(rules: Vec<ProviderConfigRule>) -> Result<Self, String> {
        let mut seen = std::collections::HashSet::new();
        for rule in &rules {
            if !seen.insert(rule.provider_id.clone()) {
                return Err(format!("Duplicate Provider key: {}", rule.provider_id));
            }
        }
        Ok(Self { rules })
    }

    pub fn empty() -> Self {
        Self { rules: Vec::new() }
    }

    pub fn get(&self, provider_id: &str) -> Option<&ProviderConfigData> {
        self.get_rule(provider_id).map(|rule| &rule.config)
    }

    pub fn get_rule(&self, provider_id: &str) -> Option<&ProviderConfigRule> {
        self.rules
            .iter()
            .find(|rule| rule.provider_id == provider_id)
    }

    pub fn has(&self, provider_id: &str) -> bool {
        self.rules
            .iter()
            .any(|rule| rule.provider_id == provider_id)
    }

    pub fn keys(&self) -> Vec<&str> {
        self.rules
            .iter()
            .map(|rule| rule.provider_id.as_str())
            .collect()
    }

    pub fn rules(&self) -> &[ProviderConfigRule] {
        &self.rules
    }

    pub fn entries(&self) -> Vec<(&str, &ProviderConfigData)> {
        self.rules
            .iter()
            .map(|rule| (rule.provider_id.as_str(), &rule.config))
            .collect()
    }

    pub fn set(&self, provider_id: &str, config: ProviderConfigData) -> Self {
        let existing = self.get_rule(provider_id).cloned();
        self.set_rule(ProviderConfigRule {
            provider_id: provider_id.to_string(),
            template_id: existing.as_ref().and_then(|rule| rule.template_id.clone()),
            provider_name: existing
                .as_ref()
                .and_then(|rule| rule.provider_name.clone()),
            enabled: existing.and_then(|rule| rule.enabled),
            config,
        })
    }

    pub fn set_rule(&self, rule: ProviderConfigRule) -> Self {
        let mut rules = self.rules.clone();
        match rules
            .iter_mut()
            .find(|candidate| candidate.provider_id == rule.provider_id)
        {
            Some(slot) => *slot = rule,
            None => rules.push(rule),
        }
        Self { rules }
    }

    pub fn delete(&self, provider_id: &str) -> Self {
        Self {
            rules: self
                .rules
                .iter()
                .filter(|rule| rule.provider_id != provider_id)
                .cloned()
                .collect(),
        }
    }

    pub fn overlay(&self, next: &ProviderConfigMap) -> Self {
        let mut result = self.rules.clone();
        for rule in &next.rules {
            match result
                .iter_mut()
                .find(|candidate| candidate.provider_id == rule.provider_id)
            {
                Some(current) => {
                    current.config = current.config.overlay(&rule.config);
                    current.template_id = overlay_value(&current.template_id, &rule.template_id);
                    current.provider_name =
                        overlay_value(&current.provider_name, &rule.provider_name);
                    current.enabled =
                        overlay_value(&current.enabled.map(Some), &rule.enabled.map(Some))
                            .flatten();
                }
                None => result.push(rule.clone()),
            }
        }
        Self { rules: result }
    }

    pub fn reorder(&self, provider_ids: &[String]) -> Self {
        let mut result = Vec::new();
        for provider_id in provider_ids {
            if let Some(rule) = self.get_rule(provider_id) {
                if !result
                    .iter()
                    .any(|candidate: &ProviderConfigRule| &candidate.provider_id == provider_id)
                {
                    result.push(rule.clone());
                }
            }
        }
        for rule in &self.rules {
            if !result
                .iter()
                .any(|candidate| candidate.provider_id == rule.provider_id)
            {
                result.push(rule.clone());
            }
        }
        Self { rules: result }
    }

    pub fn map_configs(
        &self,
        transform: impl Fn(&ProviderConfigData, &str, &ProviderConfigRule) -> ProviderConfigData,
    ) -> Self {
        Self {
            rules: self
                .rules
                .iter()
                .map(|rule| ProviderConfigRule {
                    provider_id: rule.provider_id.clone(),
                    template_id: rule.template_id.clone(),
                    provider_name: rule.provider_name.clone(),
                    enabled: rule.enabled,
                    config: transform(&rule.config, &rule.provider_id, rule),
                })
                .collect(),
        }
    }

    pub fn to_data(&self) -> Vec<ProviderConfigRuleData> {
        self.rules.iter().map(|rule| rule.to_data()).collect()
    }
}

// ---------------------------------------------------------------------------
// ProviderTemplateMap
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProviderTemplate {
    pub template_id: String,
    pub template_name_map: ProviderTemplateNameMap,
    pub config: ProviderConfigData,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProviderTemplateNameMap {
    pub zh_cn: Option<String>,
    pub en_us: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProviderTemplateMap {
    templates: Vec<ProviderTemplate>,
}

impl ProviderTemplateMap {
    pub fn from_templates(templates: Vec<ProviderTemplate>) -> Result<Self, String> {
        let mut seen = std::collections::HashSet::new();
        for template in &templates {
            if !seen.insert(template.template_id.clone()) {
                return Err(format!(
                    "Duplicate Provider Template key: {}",
                    template.template_id
                ));
            }
        }
        Ok(Self { templates })
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn get(&self, template_id: &str) -> Option<&ProviderTemplate> {
        self.templates
            .iter()
            .find(|template| template.template_id == template_id)
    }

    pub fn has(&self, template_id: &str) -> bool {
        self.templates
            .iter()
            .any(|template| template.template_id == template_id)
    }

    pub fn keys(&self) -> Vec<&str> {
        self.templates
            .iter()
            .map(|template| template.template_id.as_str())
            .collect()
    }

    pub fn entries(&self) -> &[ProviderTemplate] {
        &self.templates
    }

    pub fn overlay(&self, next: &ProviderTemplateMap) -> Self {
        let mut result = self.templates.clone();
        for template in &next.templates {
            match result
                .iter_mut()
                .find(|candidate| candidate.template_id == template.template_id)
            {
                Some(slot) => *slot = template.clone(),
                None => result.push(template.clone()),
            }
        }
        Self { templates: result }
    }

    pub fn to_data(&self) -> Vec<ProviderTemplateRuleData> {
        self.templates
            .iter()
            .map(|template| ProviderTemplateRuleData {
                template_id: template.template_id.clone(),
                template_name_map: crate::schema::ProviderTemplateNameMap {
                    zh_cn: template.template_name_map.zh_cn.clone(),
                    en_us: template.template_name_map.en_us.clone(),
                },
                config: TemplateConfigData::from_provider_config(&template.config),
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// ModelConfigRules — typed ordered rules with effective/resolve/personal split.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum ModelConfigRule {
    Model(ModelMatchRuleData),
    ModelApi(ModelApiMatchRuleData),
    ProviderSite(ProviderSiteMatchRuleData),
    TemplateModel(TemplateModelRuleData),
    ProviderModel(ProviderModelRuleData),
    ManualProviderModel(ManualProviderModelRuleData),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelConfigRules {
    rules: Vec<ModelConfigRule>,
}

impl ModelConfigRules {
    pub fn new(rules: Vec<ModelConfigRule>) -> Self {
        Self { rules }
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn compose_effective(builtin: &Self, personal: &Self) -> Self {
        let mut rules = builtin.rules.clone();
        rules.extend(
            personal
                .rules
                .iter()
                .filter(|rule| is_exact_model_rule(rule))
                .cloned(),
        );
        Self { rules }
    }

    pub fn rules(&self) -> &[ModelConfigRule] {
        &self.rules
    }

    pub fn get_exact(&self, provider_id: &str, model_id: &str) -> Option<ModelConfigData> {
        let mut result: Option<ModelConfigData> = None;
        for rule in &self.rules {
            if !is_exact_model_rule(rule) {
                continue;
            }
            let matches = match rule {
                ModelConfigRule::ProviderModel(rule) => {
                    rule.provider_id == provider_id && rule.model_id == model_id
                }
                ModelConfigRule::ManualProviderModel(rule) => {
                    rule.provider_id == provider_id && rule.model_id == model_id
                }
                _ => false,
            };
            if !matches {
                continue;
            }
            let config = match rule {
                ModelConfigRule::ProviderModel(rule) => rule.config.clone(),
                ModelConfigRule::ManualProviderModel(rule) => {
                    manual_config_projection(&rule.config)
                }
                _ => unreachable!(),
            };
            result = Some(match result {
                Some(base) => base.overlay(&config),
                None => config,
            });
        }
        result
    }

    pub fn get_exact_rule(&self, provider_id: &str, model_id: &str) -> Option<ModelConfigRule> {
        let mut result = None;
        for rule in &self.rules {
            let matches = match rule {
                ModelConfigRule::ProviderModel(rule) => {
                    rule.provider_id == provider_id && rule.model_id == model_id
                }
                ModelConfigRule::ManualProviderModel(rule) => {
                    rule.provider_id == provider_id && rule.model_id == model_id
                }
                _ => false,
            };
            if matches {
                result = Some(rule.clone());
            }
        }
        result
    }

    pub fn set_exact(
        &self,
        provider_id: &str,
        model_id: &str,
        config: ModelConfigData,
        use_recommended_config: Option<bool>,
    ) -> Result<Self, String> {
        // TS parity: setExact re-parses the whole rule through the strict rule
        // schemas, so an invalid manual config or a broken option map is a
        // write-time rejection, never a silent compile-time omission.
        config.validate()?;
        let previous = self.get_exact_rule(provider_id, model_id);
        let manual = match use_recommended_config {
            Some(recommended) => !recommended,
            None => matches!(previous, Some(ModelConfigRule::ManualProviderModel(_))),
        };
        let replacement = if manual {
            ModelConfigRule::ManualProviderModel(ManualProviderModelRuleData {
                provider_id: provider_id.into(),
                model_id: model_id.into(),
                config: projection_manual(&config)?,
            })
        } else {
            ModelConfigRule::ProviderModel(ProviderModelRuleData {
                provider_id: provider_id.into(),
                model_id: model_id.into(),
                config,
            })
        };
        let mut replaced = false;
        let mut rules: Vec<ModelConfigRule> = Vec::new();
        for rule in &self.rules {
            let is_match = match rule {
                ModelConfigRule::ProviderModel(rule) => {
                    rule.provider_id == provider_id && rule.model_id == model_id
                }
                ModelConfigRule::ManualProviderModel(rule) => {
                    rule.provider_id == provider_id && rule.model_id == model_id
                }
                _ => false,
            };
            if is_match {
                if !replaced {
                    rules.push(replacement.clone());
                }
                replaced = true;
            } else {
                rules.push(rule.clone());
            }
        }
        if !replaced {
            rules.push(replacement);
        }
        Ok(Self { rules })
    }

    pub fn delete_exact(&self, provider_id: &str, model_id: &str) -> Self {
        Self {
            rules: self
                .rules
                .iter()
                .filter(|rule| match rule {
                    ModelConfigRule::ProviderModel(rule) => {
                        !(rule.provider_id == provider_id && rule.model_id == model_id)
                    }
                    ModelConfigRule::ManualProviderModel(rule) => {
                        !(rule.provider_id == provider_id && rule.model_id == model_id)
                    }
                    _ => true,
                })
                .cloned()
                .collect(),
        }
    }

    pub fn rename_exact_model(
        &self,
        provider_id: &str,
        current_model_id: &str,
        next_model_id: &str,
    ) -> Self {
        if current_model_id == next_model_id {
            return self.clone();
        }
        Self {
            rules: self
                .rules
                .iter()
                .map(|rule| match rule {
                    ModelConfigRule::ProviderModel(rule)
                        if rule.provider_id == provider_id && rule.model_id == current_model_id =>
                    {
                        ModelConfigRule::ProviderModel(ProviderModelRuleData {
                            provider_id: rule.provider_id.clone(),
                            model_id: next_model_id.into(),
                            config: rule.config.clone(),
                        })
                    }
                    ModelConfigRule::ManualProviderModel(rule)
                        if rule.provider_id == provider_id && rule.model_id == current_model_id =>
                    {
                        ModelConfigRule::ManualProviderModel(ManualProviderModelRuleData {
                            provider_id: rule.provider_id.clone(),
                            model_id: next_model_id.into(),
                            config: rule.config.clone(),
                        })
                    }
                    other => other.clone(),
                })
                .collect(),
        }
    }

    pub fn delete_exact_for_provider(&self, provider_id: &str) -> Self {
        Self {
            rules: self
                .rules
                .iter()
                .filter(|rule| match rule {
                    ModelConfigRule::ProviderModel(rule) => rule.provider_id != provider_id,
                    ModelConfigRule::ManualProviderModel(rule) => rule.provider_id != provider_id,
                    _ => true,
                })
                .cloned()
                .collect(),
        }
    }

    /// Resolves the effective model config for one provider/model pair, given
    /// optional template and apiType/baseUrl hints — the same precedence as the
    /// TypeScript `ModelConfigRules.resolve`.
    pub fn resolve(&self, input: &ResolutionInput) -> ModelConfigData {
        let mut result = ModelConfigData {
            enabled: None,
            properties: None,
            option_specs: None,
        };
        let base_url = input.base_url.as_deref().and_then(normalize_base_url);
        for rule in &self.rules {
            match rule {
                ModelConfigRule::ProviderModel(rule) => {
                    if rule.provider_id != input.provider_id || rule.model_id != input.model_id {
                        continue;
                    }
                    result = result.overlay(&rule.config);
                }
                ModelConfigRule::ManualProviderModel(rule) => {
                    if rule.provider_id != input.provider_id || rule.model_id != input.model_id {
                        continue;
                    }
                    // Manual rules require complete editable leaves, so they can
                    // replace the weak baseline rather than merge into it.
                    let projected = ModelConfigData {
                        enabled: result.enabled.clone(),
                        properties: clear_manual_properties(&result.properties),
                        option_specs: clear_manual_option_specs(&result.option_specs),
                    };
                    let manual_projection = manual_config_projection(&rule.config);
                    result = projected.overlay(&manual_projection);
                }
                ModelConfigRule::TemplateModel(rule) => {
                    if Some(&rule.template_id[..]) == input.template_id.as_deref()
                        && rule.model_id == input.model_id
                    {
                        result = result.overlay(&rule.config);
                    }
                }
                ModelConfigRule::Model(rule) => {
                    if !matches_rule(&rule.model_match, &input.model_id, true) {
                        continue;
                    }
                    result = result.overlay(&rule.config);
                }
                ModelConfigRule::ModelApi(rule) => {
                    if !matches_rule(&rule.model_match, &input.model_id, true) {
                        continue;
                    }
                    if let Some(api_type) = &input.api_type {
                        if !matches_rule(&rule.api_type_match, api_type, false) {
                            continue;
                        }
                    } else {
                        continue;
                    }
                    result = result.overlay(&rule.config);
                }
                ModelConfigRule::ProviderSite(rule) => {
                    if !matches_rule(&rule.model_match, &input.model_id, true) {
                        continue;
                    }
                    if let Some(api_type_match) = &rule.api_type_match {
                        match &input.api_type {
                            Some(api_type) => {
                                if !matches_rule(api_type_match, api_type, false) {
                                    continue;
                                }
                            }
                            None => continue,
                        }
                    }
                    match &base_url {
                        Some(base_url) => {
                            if !matches_rule(&rule.base_url_match, base_url, false) {
                                continue;
                            }
                        }
                        None => continue,
                    }
                    result = result.overlay(&rule.config);
                }
            }
        }
        result
    }

    fn project_personal(&self) -> crate::schema::PersonalModelConfigRulesData {
        let mut provider_model_rules = Vec::new();
        let mut manual_provider_model_rules = Vec::new();
        for rule in &self.rules {
            match rule {
                ModelConfigRule::ProviderModel(rule) => provider_model_rules.push(rule.clone()),
                ModelConfigRule::ManualProviderModel(rule) => {
                    manual_provider_model_rules.push(rule.clone())
                }
                _ => {}
            }
        }
        crate::schema::PersonalModelConfigRulesData {
            provider_model_rules,
            manual_provider_model_rules,
        }
    }

    pub fn to_personal_data(&self) -> Result<crate::schema::PersonalModelConfigRulesData, String> {
        let projected = self.project_personal();
        projected.validate()?;
        Ok(projected)
    }

    pub fn to_builtin_data(&self) -> Result<crate::schema::BuiltinModelConfigRulesData, String> {
        let mut model_rules = Vec::new();
        let mut model_api_rules = Vec::new();
        let mut provider_site_rules = Vec::new();
        let mut template_model_rules = Vec::new();
        let mut builtin_provider_model_rules = Vec::new();
        for rule in &self.rules {
            match rule {
                ModelConfigRule::Model(rule) => model_rules.push(rule.clone()),
                ModelConfigRule::ModelApi(rule) => model_api_rules.push(rule.clone()),
                ModelConfigRule::ProviderSite(rule) => provider_site_rules.push(rule.clone()),
                ModelConfigRule::TemplateModel(rule) => template_model_rules.push(rule.clone()),
                ModelConfigRule::ProviderModel(rule) => {
                    builtin_provider_model_rules.push(rule.clone())
                }
                ModelConfigRule::ManualProviderModel(_) => {}
            }
        }
        let data = crate::schema::BuiltinModelConfigRulesData {
            model_rules,
            model_api_rules,
            provider_site_rules,
            template_model_rules,
            builtin_provider_model_rules,
        };
        data.validate()?;
        Ok(data)
    }
}

pub struct ResolutionInput {
    pub provider_id: String,
    pub template_id: Option<String>,
    pub model_id: String,
    pub api_type: Option<String>,
    pub base_url: Option<String>,
}

fn is_exact_model_rule(rule: &ModelConfigRule) -> bool {
    matches!(
        rule,
        ModelConfigRule::ProviderModel(_) | ModelConfigRule::ManualProviderModel(_)
    )
}

fn matches_rule(pattern: &str, value: &str, ignore_case: bool) -> bool {
    let compiled = if ignore_case {
        regex::RegexBuilder::new(&format!("^(?:{pattern})$"))
            .case_insensitive(true)
            .build()
    } else {
        regex::Regex::new(&format!("^(?:{pattern})$"))
    };
    compiled.map(|re| re.is_match(value)).unwrap_or(false)
}

fn normalize_base_url(value: &str) -> Option<String> {
    let parsed = url::Url::parse(value).ok()?;
    let mut serialized = parsed.to_string();
    let suffix_len = parsed.query().map(|q| q.len() + 1).unwrap_or(0)
        + parsed.fragment().map(|f| f.len() + 1).unwrap_or(0);
    let suffix;
    if suffix_len > 0 {
        suffix = serialized.split_off(serialized.len() - suffix_len);
    } else {
        suffix = String::new();
    }
    let stripped = serialized.trim_end_matches('/');
    Some(format!("{stripped}{suffix}"))
}

fn manual_config_projection(config: &crate::schema::ManualModelConfig) -> ModelConfigData {
    let manual = config.clone();
    ModelConfigData {
        enabled: manual.enabled,
        properties: Some(Some(ModelPropertiesData {
            requires_mfjs_tool_schema: None,
            context_window: Some(Some(manual.properties.context_window)),
            input_format: Some(Some(ModelInputFormatData {
                supports_text: None,
                supports_image: Some(Some(manual.properties.input_format.supports_image)),
                supports_video: Some(Some(manual.properties.input_format.supports_video)),
                supports_audio: None,
                supports_pdf: Some(Some(manual.properties.input_format.supports_pdf)),
            })),
            output_format: None,
            supports_tool_call: None,
            supports_json_schema_output: Some(Some(manual.properties.supports_json_schema_output)),
            supports_native_web_search: Some(Some(manual.properties.supports_native_web_search)),
            supports_mid_conversation_system: Some(Some(
                manual.properties.supports_mid_conversation_system,
            )),
        })),
        option_specs: Some(Some(ModelOptionSpecsData {
            reasoning_level: Some(Some(EnumOptionSpecData {
                values: Some(Some(manual.option_specs.reasoning_level.values)),
                map: Some(Some(manual.option_specs.reasoning_level.map)),
            })),
            max_output_tokens: Some(Some(LimitOptionSpecData {
                max: Some(Some(manual.option_specs.max_output_tokens.max)),
                map: None,
            })),
        })),
    }
}

fn projection_manual(config: &ModelConfigData) -> Result<crate::schema::ManualModelConfig, String> {
    let missing = |leaf: &str| format!("Manual Model Config is missing required leaf: {leaf}");
    let pick_properties = config
        .properties
        .as_ref()
        .and_then(|p| p.as_ref())
        .ok_or_else(|| missing("properties"))?;
    let pick_options = config
        .option_specs
        .as_ref()
        .and_then(|o| o.as_ref())
        .ok_or_else(|| missing("optionSpecs"))?;
    let reasoning = pick_options
        .reasoning_level
        .as_ref()
        .and_then(|l| l.as_ref())
        .ok_or_else(|| missing("optionSpecs.reasoningLevel"))?;
    // Required leaves must be actually present in the draft, not merely absent-tolerant.
    let inclusive = |field: &Option<Option<bool>>| -> Option<bool> {
        field.as_ref().and_then(|f| f.as_ref()).copied()
    };
    let manual = crate::schema::ManualModelConfig {
        enabled: config.enabled.clone(),
        properties: crate::schema::ManualModelProperties {
            context_window: pick_properties
                .context_window
                .as_ref()
                .and_then(|w| w.as_ref())
                .copied()
                .ok_or_else(|| missing("properties.contextWindow"))?,
            supports_json_schema_output: inclusive(&pick_properties.supports_json_schema_output)
                .ok_or_else(|| missing("properties.supportsJsonSchemaOutput"))?,
            supports_native_web_search: inclusive(&pick_properties.supports_native_web_search)
                .ok_or_else(|| missing("properties.supportsNativeWebSearch"))?,
            supports_mid_conversation_system: inclusive(
                &pick_properties.supports_mid_conversation_system,
            )
            .ok_or_else(|| missing("properties.supportsMidConversationSystem"))?,
            input_format: crate::schema::ManualModelInputFormat {
                supports_image: pick_properties
                    .input_format
                    .as_ref()
                    .and_then(|i| i.as_ref())
                    .and_then(|input| input.supports_image.as_ref())
                    .and_then(|value| value.as_ref())
                    .copied()
                    .ok_or_else(|| missing("properties.inputFormat.supportsImage"))?,
                supports_video: pick_properties
                    .input_format
                    .as_ref()
                    .and_then(|i| i.as_ref())
                    .and_then(|input| input.supports_video.as_ref())
                    .and_then(|value| value.as_ref())
                    .copied()
                    .ok_or_else(|| missing("properties.inputFormat.supportsVideo"))?,
                supports_pdf: pick_properties
                    .input_format
                    .as_ref()
                    .and_then(|i| i.as_ref())
                    .and_then(|input| input.supports_pdf.as_ref())
                    .and_then(|value| value.as_ref())
                    .copied()
                    .ok_or_else(|| missing("properties.inputFormat.supportsPdf"))?,
            },
        },
        option_specs: crate::schema::ManualModelOptionSpecs {
            reasoning_level: crate::schema::CompleteEnumOptionSpec {
                values: reasoning
                    .values
                    .as_ref()
                    .and_then(|v| v.as_ref())
                    .cloned()
                    .ok_or_else(|| missing("optionSpecs.reasoningLevel.values"))?,
                map: reasoning
                    .map
                    .as_ref()
                    .and_then(|m| m.as_ref())
                    .cloned()
                    .ok_or_else(|| missing("optionSpecs.reasoningLevel.map"))?,
            },
            max_output_tokens: crate::schema::ManualMaxOutputTokens {
                max: pick_options
                    .max_output_tokens
                    .as_ref()
                    .and_then(|l| l.as_ref())
                    .and_then(|l| l.max.as_ref())
                    .and_then(|m| m.as_ref())
                    .copied()
                    .ok_or_else(|| missing("optionSpecs.maxOutputTokens.max"))?,
            },
        },
    };
    manual.validate()?;
    Ok(manual)
}

fn clear_manual_properties(
    properties: &Option<Option<ModelPropertiesData>>,
) -> Option<Option<ModelPropertiesData>> {
    match properties {
        None | Some(None) => properties.clone(),
        Some(Some(properties)) => {
            let mut cleared = properties.clone();
            // Mirrors TS omitSchemaFields: remove every key the manual schema owns.
            cleared.context_window = None;
            cleared.supports_json_schema_output = None;
            cleared.supports_native_web_search = None;
            cleared.supports_mid_conversation_system = None;
            if let Some(Some(input)) = &mut cleared.input_format {
                input.supports_image = None;
                input.supports_video = None;
                input.supports_pdf = None;
                // An input format left with no fields is as absent as the manual schema
                // would have left it.
                if input.supports_text.is_none() && input.supports_audio.is_none() {
                    cleared.input_format = None;
                }
            }
            if cleared == ModelPropertiesData::default() {
                return Some(None);
            }
            Some(Some(cleared))
        }
    }
}

fn clear_manual_option_specs(
    specs: &Option<Option<ModelOptionSpecsData>>,
) -> Option<Option<ModelOptionSpecsData>> {
    match specs {
        None | Some(None) => specs.clone(),
        Some(Some(specs)) => {
            let mut cleared = specs.clone();
            cleared.reasoning_level = None;
            if let Some(Some(limit)) = &mut cleared.max_output_tokens {
                limit.max = None;
                if limit.map.is_none() {
                    cleared.max_output_tokens = None;
                }
            }
            if cleared == ModelOptionSpecsData::default() {
                return Some(None);
            }
            Some(Some(cleared))
        }
    }
}
