//! Legacy Built-in reasoning-level compatibility.
//!
//! Rust port of `packages/provider-node/src/legacy-reasoning-level.ts` and
//! `legacy-reasoning-level-renames.ts`. Exists only to restore the known legacy
//! Built-in value range for historic Selections; it does not migrate Personal
//! config nor relax validation in the execution layer.

use crate::domain::{ModelConfigRule, ModelConfigRules, Overlay, ResolutionInput};
use crate::schema::{
    builtin_model_rules_to_domain, personal_model_rules_to_domain, BuiltinModelConfigRulesData,
    EnumOptionSpecData, ModelConfigData, ModelOptionSpecsData, ModelSelection,
    PersonalModelConfigRulesData,
};

/// One-time rename list, transcribed 1:1 from `legacy-reasoning-level-renames.ts`.
/// The selector must exactly match the original Built-in rules; no guessing
/// based on the model name is allowed.
pub const LEGACY_REASONING_LEVEL_RENAMES: &[(&str, &str)] = &[
    (".*glm-5(?:[.\\-:/\\[].*)?", "off"),
    (".*GLM-5\\.2(?:[.\\-:/\\[].*)?", "nothink"),
    (".*GLM-5-Turbo(?:[.\\-:/\\[].*)?", "off"),
    (".*glm-5\\.1(?:[.\\-:/\\[].*)?", "off"),
    (".*glm-5\\.1-highspeed(?:[.\\-:/\\[].*)?", "off"),
    (".*glm-5v-turbo(?:[.\\-:/\\[].*)?", "off"),
    (".*glm-4\\.7(?:[.\\-:/\\[].*)?", "off"),
    (".*glm-4\\.7-flashx(?:[.\\-:/\\[].*)?", "off"),
    (".*glm-4\\.7-flash(?:[.\\-:/\\[].*)?", "off"),
    (".*glm-4\\.6(?:[.\\-:/\\[].*)?", "off"),
    (".*glm-4\\.5(?:[.\\-:/\\[].*)?", "off"),
    (".*glm-4\\.5-air(?:[.\\-:/\\[].*)?", "off"),
    (".*kimi-k2\\.7-code(?:[.\\-:/\\[].*)?", "off"),
    (".*kimi-k2\\.6(?:[.\\-:/\\[].*)?", "off"),
    (".*kimi-k2\\.5(?:[.\\-:/\\[].*)?", "off"),
    (".*deepseek-v4-flash(?:[.\\-:/\\[].*)?", "off"),
    (".*deepseek-v4-pro(?:[.\\-:/\\[].*)?", "off"),
    (".*qwen3\\.5-plus(?:[.\\-:/\\[].*)?", "off"),
    (".*qwen3\\.5-flash(?:[.\\-:/\\[].*)?", "off"),
    (".*qwen-plus(?:[.\\-:/\\[].*)?", "off"),
    (".*qwen-flash(?:[.\\-:/\\[].*)?", "off"),
    (".*qwen3-vl-plus(?:[.\\-:/\\[].*)?", "off"),
    (".*mimo-v2\\.5(?:[.\\-:/\\[].*)?", "off"),
    (".*mimo-v2\\.5-pro(?:[.\\-:/\\[].*)?", "off"),
    (".*mimo-v2-flash(?:[.\\-:/\\[].*)?", "off"),
];

/// The provider facts the resolver needs from the Registry's effective
/// providers. `api_type`/`base_url` come from the effective provider config;
/// `template_id` from its rule.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyReasoningProviderInput {
    pub provider_id: String,
    pub template_id: Option<String>,
    pub api_type: Option<String>,
    pub base_url: Option<String>,
}

/// `resolveLegacyReasoningLevel`. Returns `Some("disabled")` when the legacy
/// level is a known alias of `disabled` for this model, otherwise `None`.
pub fn resolve_legacy_reasoning_level(
    selection: &ModelSelection,
    personal_model_rules: &PersonalModelConfigRulesData,
    builtin_model_rules: &BuiltinModelConfigRulesData,
    providers: &[LegacyReasoningProviderInput],
) -> Option<String> {
    let old_level = selection
        .options
        .as_ref()
        .and_then(|options| options.reasoning_level.as_deref())?;
    if old_level != "off" && old_level != "nothink" {
        return None;
    }
    let personal = personal_model_rules_to_domain(personal_model_rules);
    if let Some(rule) = personal.get_exact_rule(&selection.provider_id, &selection.model_id) {
        let escapes = match &rule {
            ModelConfigRule::ManualProviderModel(_) => true,
            ModelConfigRule::ProviderModel(rule) => {
                let reasoning = rule
                    .config
                    .option_specs
                    .as_ref()
                    .and_then(|specs| specs.as_ref())
                    .and_then(|specs| specs.reasoning_level.as_ref())
                    .and_then(|spec| spec.as_ref());
                reasoning.is_some_and(|spec| spec.values.is_some() || spec.map.is_some())
            }
            _ => false,
        };
        if escapes {
            return None;
        }
    }
    let provider = providers
        .iter()
        .find(|provider| provider.provider_id == selection.provider_id)?;

    let builtin = builtin_model_rules_to_domain(builtin_model_rules);
    // Rebuild the old rules: only the original adjudicated no-site/no-API
    // restriction rules (`type === "model"` with a rename entry and a values
    // list containing "disabled") inherit the old alias; newly added site
    // rules with the same name cannot.
    let old_rules: Vec<ModelConfigRule> = builtin
        .rules()
        .iter()
        .map(|rule| match rule {
            ModelConfigRule::Model(model_rule) => {
                let rename = LEGACY_REASONING_LEVEL_RENAMES
                    .iter()
                    .find(|(model_match, _)| *model_match == model_rule.model_match);
                let values = model_rule
                    .config
                    .option_specs
                    .as_ref()
                    .and_then(|specs| specs.as_ref())
                    .and_then(|specs| specs.reasoning_level.as_ref())
                    .and_then(|spec| spec.as_ref())
                    .and_then(|spec| spec.values.as_ref())
                    .and_then(|values| values.as_ref());
                match (rename, values) {
                    (Some((_, old_level)), Some(values)) if values.iter().any(|v| v == "disabled") => {
                        let mapped: Vec<String> = values
                            .iter()
                            .map(|value| {
                                if value == "disabled" {
                                    (*old_level).to_string()
                                } else {
                                    value.clone()
                                }
                            })
                            .collect();
                        let overlay = ModelConfigData {
                            enabled: None,
                            properties: None,
                            option_specs: Some(Some(ModelOptionSpecsData {
                                reasoning_level: Some(Some(EnumOptionSpecData {
                                    values: Some(Some(mapped)),
                                    map: None,
                                })),
                                max_output_tokens: None,
                            })),
                        };
                        let mut renamed = model_rule.clone();
                        renamed.config = renamed.config.overlay(&overlay);
                        ModelConfigRule::Model(renamed)
                    }
                    _ => rule.clone(),
                }
            }
            _ => rule.clone(),
        })
        .collect();
    let old_rules = ModelConfigRules::new(old_rules);
    // Use the original rule engine to handle case, suffix, API/site and
    // subsequent coverage, without duplicating the second set of matching logic.
    let resolved = old_rules.resolve(&ResolutionInput {
        provider_id: selection.provider_id.clone(),
        model_id: selection.model_id.clone(),
        template_id: provider.template_id.clone(),
        api_type: provider.api_type.clone(),
        base_url: provider.base_url.clone(),
    });
    let values = resolved
        .option_specs
        .as_ref()
        .and_then(|specs| specs.as_ref())
        .and_then(|specs| specs.reasoning_level.as_ref())
        .and_then(|spec| spec.as_ref())
        .and_then(|spec| spec.values.as_ref())
        .and_then(|values| values.as_ref())?;
    if values.iter().any(|value| value == old_level) {
        Some("disabled".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{
        BuiltinModelConfigRulesData, ModelMatchRuleData, ModelSelectionOptions,
        PersonalModelConfigRulesData,
    };

    fn builtin_with_disabled(model_match: &str) -> BuiltinModelConfigRulesData {
        BuiltinModelConfigRulesData {
            model_rules: vec![ModelMatchRuleData {
                model_match: model_match.to_string(),
                config: ModelConfigData {
                    enabled: None,
                    properties: None,
                    option_specs: Some(Some(ModelOptionSpecsData {
                        reasoning_level: Some(Some(EnumOptionSpecData {
                            values: Some(Some(vec![
                                "low".to_string(),
                                "disabled".to_string(),
                            ])),
                            map: None,
                        })),
                        max_output_tokens: None,
                    })),
                },
            }],
            model_api_rules: vec![],
            provider_site_rules: vec![],
            template_model_rules: vec![],
            builtin_provider_model_rules: vec![],
        }
    }

    fn selection(provider: &str, model: &str, level: &str) -> ModelSelection {
        ModelSelection {
            provider_id: provider.to_string(),
            model_id: model.to_string(),
            options: Some(ModelSelectionOptions {
                reasoning_level: Some(level.to_string()),
            }),
        }
    }

    fn providers() -> Vec<LegacyReasoningProviderInput> {
        vec![LegacyReasoningProviderInput {
            provider_id: "builtin:zai".into(),
            template_id: None,
            api_type: Some("anthropic-messages".into()),
            base_url: Some("https://api.z.ai".into()),
        }]
    }

    fn empty_personal() -> PersonalModelConfigRulesData {
        PersonalModelConfigRulesData {
            provider_model_rules: vec![],
            manual_provider_model_rules: vec![],
        }
    }

    #[test]
    fn a_legacy_off_selection_maps_back_to_disabled() {
        let result = resolve_legacy_reasoning_level(
            &selection("builtin:zai", "glm-5", "off"),
            &empty_personal(),
            &builtin_with_disabled(".*glm-5(?:[.\\-:/\\[].*)?"),
            &providers(),
        );
        assert_eq!(result.as_deref(), Some("disabled"));
    }

    #[test]
    fn a_non_legacy_level_is_untouched() {
        let result = resolve_legacy_reasoning_level(
            &selection("builtin:zai", "glm-5", "high"),
            &empty_personal(),
            &builtin_with_disabled(".*glm-5(?:[.\\-:/\\[].*)?"),
            &providers(),
        );
        assert_eq!(result, None);
    }

    #[test]
    fn a_rename_entry_without_disabled_in_values_does_not_apply() {
        let mut builtin = builtin_with_disabled(".*glm-5(?:[.\\-:/\\[].*)?");
        builtin.model_rules[0]
            .config
            .option_specs
            .as_mut()
            .unwrap()
            .as_mut()
            .unwrap()
            .reasoning_level
            .as_mut()
            .unwrap()
            .as_mut()
            .unwrap()
            .values = Some(Some(vec!["low".to_string(), "high".to_string()]));
        let result = resolve_legacy_reasoning_level(
            &selection("builtin:zai", "glm-5", "off"),
            &empty_personal(),
            &builtin,
            &providers(),
        );
        assert_eq!(result, None);
    }

    #[test]
    fn the_rename_table_matches_the_ts_row_count() {
        assert_eq!(LEGACY_REASONING_LEVEL_RENAMES.len(), 25);
    }
}
