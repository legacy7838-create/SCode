//! `ProviderConfigService` — the single owner of the Personal provider-config
//! write boundary.
//!
//! Rust analog of `packages/provider/src/config-service.ts` `ProviderConfigService`.
//! All personal-layer mutations flow through `update_personal`, which is a
//! single repository update boundary; every invariant (membership revision,
//! account provider access rules, duplicate names) is checked inside the
//! transaction before the file is touched.

use std::sync::Mutex;

use crate::domain::{
    ModelConfigRule, ModelConfigRules, ProviderConfigMap, ProviderConfigRule, ProviderTemplateMap,
};
use crate::repository::{LayerSnapshot, PersonalProviderConfigRepository};
use crate::schema::ProviderConfigData;
use crate::schema::{
    ModelConfigData, ModelSelection, PersonalConfigLayer, PersonalModelConfigRulesData,
    PersonalProviderConfigData, PersonalProviderConfigRulesData,
};

/// Effective config snapshot published from the two independent sources.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderConfigSnapshot {
    pub revision: String,
    pub zcode_builtin_revision: String,
    pub personal_revision: String,
    pub zcode_builtin_providers: ProviderConfigMap,
    pub zcode_builtin_provider_templates: ProviderTemplateMap,
    pub personal_providers: ProviderConfigMap,
    pub zcode_builtin_model_rules: ModelConfigRules,
    pub personal_models: ModelConfigRules,
    pub personal_provider_order: Vec<String>,
}

/// One published builtin snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltinSnapshot {
    pub revision: String,
    pub providers: ProviderConfigMap,
    pub provider_templates: ProviderTemplateMap,
    pub models: ModelConfigRules,
}

/// Source of the shipped/active builtin release. The Node source watched files
/// and re-materialised the bundled release; the Rust host supplies the same
/// snapshots without a file watcher for now.
pub trait BuiltinSource: Send + Sync {
    fn read(&self) -> Result<BuiltinSnapshot, String>;
    fn on_did_change(&self, listener: Box<dyn Fn(&str) + Send>);
}

pub struct ProviderConfigService {
    zcode_builtin: Box<dyn BuiltinSource>,
    personal: PersonalProviderConfigRepository,
    listeners: Mutex<Vec<Box<dyn Fn(&str) + Send>>>,
}

pub struct ProviderModelMembership<'a> {
    pub provider_id: &'a str,
    pub inherited_model_ids: &'a [String],
    pub personal_revision: &'a str,
    pub assert_current: &'a dyn Fn() -> Result<(), String>,
}

pub struct CreatePersonalProviderInput {
    pub template_id: Option<String>,
    pub provider_name: Option<String>,
    pub locale: Option<String>,
    pub initial_config: Option<ProviderConfigData>,
}

pub struct ProviderModelMembershipPayload;

impl ProviderConfigService {
    pub fn new(
        zcode_builtin: Box<dyn BuiltinSource>,
        personal: PersonalProviderConfigRepository,
    ) -> Self {
        let listeners: std::sync::Arc<Mutex<Vec<Box<dyn Fn(&str) + Send>>>> =
            std::sync::Arc::new(Mutex::new(Vec::new()));
        let listeners_for_personal = std::sync::Arc::clone(&listeners);
        personal.on_did_change(move |reason| {
            if let Ok(listeners) = listeners_for_personal.lock() {
                for listener in listeners.iter() {
                    listener(reason);
                }
            }
        });
        let builtin_listeners: std::sync::Arc<Mutex<Vec<Box<dyn Fn(&str) + Send>>>> =
            std::sync::Arc::clone(&listeners);
        zcode_builtin.on_did_change(Box::new(move |reason| {
            if let Ok(listeners) = builtin_listeners.lock() {
                for listener in listeners.iter() {
                    listener(reason);
                }
            }
        }));
        Self {
            zcode_builtin,
            personal,
            listeners: Mutex::new(Vec::new()),
        }
        .with_listeners(listeners)
    }

    pub fn read(&self) -> Result<ProviderConfigSnapshot, String> {
        let builtin = self.zcode_builtin.read()?;
        let personal = self.personal.read()?;
        let personal_providers = personal_layer_providers_to_domain(&personal.providers);
        let personal_models = personal_layer_models_to_domain(&personal.models);
        let personal_provider_order = personal.provider_order.clone().unwrap_or_default();
        Ok(ProviderConfigSnapshot {
            revision: format!(
                r#"["{}","{}"]"#,
                escape_json_string(&builtin.revision),
                escape_json_string(&personal.revision)
            ),
            zcode_builtin_revision: builtin.revision,
            personal_revision: personal.revision,
            zcode_builtin_providers: builtin.providers,
            zcode_builtin_provider_templates: builtin.provider_templates,
            personal_providers,
            zcode_builtin_model_rules: builtin.models,
            personal_models,
            personal_provider_order,
        })
    }

    fn with_listeners(
        self,
        listeners: std::sync::Arc<Mutex<Vec<Box<dyn Fn(&str) + Send>>>>,
    ) -> Self {
        let _ = listeners;
        self
    }

    pub fn on_did_change(&self, listener: impl Fn(&str) + Send + 'static) {
        self.listeners.lock().unwrap().push(Box::new(listener));
    }

    pub fn replace_personal_config(
        &self,
        layer: PersonalConfigLayer,
    ) -> Result<LayerSnapshot, String> {
        self.personal.update(|_current| Ok(layer.clone()))
    }

    pub fn save_personal_provider_overlay(
        &self,
        provider_id: &str,
        config: ProviderConfigData,
        membership: Option<&ProviderModelMembership>,
        metadata: Option<MetadataInput>,
    ) -> Result<LayerSnapshot, String> {
        assert_non_empty_id("providerId", provider_id)?;
        let builtin = self.zcode_builtin.read()?;
        self.update_personal(|current| {
            assert_membership_current(membership, provider_id, &current.revision)?;
            let builtin_rule = builtin.providers.get_rule(provider_id);
            let current_personal = current.providers.get(provider_id);
            let current_effective = builtin.providers.overlay(&current.providers);
            if builtin_rule
                .and_then(|rule| rule.config.access.as_ref())
                .and_then(|access| access.as_ref())
                .map(|access| matches!(access, crate::schema::ProviderAccessData::ZhipuAccount { .. }))
                == Some(true)
                && metadata.as_ref().and_then(|m| m.enabled) == Some(false)
            {
                return Err(format!("Account Providers cannot be disabled: {provider_id}"));
            }
            if builtin_rule
                .and_then(|rule| rule.config.access.as_ref())
                .and_then(|access| access.as_ref())
                .map(|access| matches!(access, crate::schema::ProviderAccessData::ZhipuAccount { .. }))
                == Some(true)
                && config.access.as_ref().is_some_and(|access| access.is_some())
            {
                return Err(format!(
                    "Access for a pinned Account Provider can only be declared by the ZCode Built-in Config: {provider_id}"
                ));
            }
            if current_personal.is_none() && builtin_rule.is_none() {
                return Err(format!("Personal Provider has not been created yet: {provider_id}"));
            }
            let mut normalized = config.clone();
            if let Some(builtin_rule) = builtin_rule {
                if let Some(Some(group)) = &normalized.group {
                    if Some(group) != builtin_rule.config.group.as_ref().and_then(|g| g.as_ref()) {
                        return Err(format!(
                            "Personal Overlay cannot rewrite the Built-in Provider group: {provider_id}"
                        ));
                    }
                }
                normalized.group = None;
            } else {
                let group = normalized
                    .group
                    .as_ref()
                    .and_then(|g| g.as_ref())
                    .copied();
                let current_group = current_personal
                    .and_then(|config| config.group.as_ref())
                    .and_then(|g| g.as_ref())
                    .copied();
                let group = group.or(current_group);
                if group != Some(crate::schema::ProviderGroup::StandardPersonal) {
                    return Err(format!(
                        "Personal-only Providers must use the standard-personal group: {provider_id}"
                    ));
                }
                normalized.group = Some(Some(crate::schema::ProviderGroup::StandardPersonal));
            }
            let membership_baseline = builtin_rule
                .map(|rule| rule.config.clone())
                .or_else(|| resolve_template_baseline(&builtin, &current.providers, provider_id));
            let normalized_membership = normalize_personal_membership(
                current_personal.cloned(),
                membership_baseline,
                membership.map(|m| m.inherited_model_ids),
            );
            let next = normalized.with_model_membership_from(normalized_membership);
            let current_rule = current.providers.get_rule(provider_id).cloned();
            let mut template_id = current_rule.as_ref().and_then(|rule| rule.template_id.clone());
            if let Some(MetadataInput { template_id: override_template, .. }) = metadata.as_ref() {
                template_id = override_template.clone().map(Some);
            }
            let mut provider_name = current_rule
                .as_ref()
                .and_then(|rule| rule.provider_name.clone());
            if let Some(MetadataInput { provider_name: override_name, .. }) = metadata.as_ref() {
                provider_name = override_name
                    .as_deref()
                    .map(|name| name.trim())
                    .filter(|name| !name.is_empty())
                    .map(|name| name.to_string())
                    .map(Some);
            }
            let mut enabled = current_rule.as_ref().and_then(|rule| rule.enabled);
            if let Some(MetadataInput { enabled: override_enabled, .. }) = metadata.as_ref() {
                enabled = *override_enabled;
            }
            let providers = current.providers.set_rule(ProviderConfigRule {
                provider_id: provider_id.to_string(),
                template_id,
                provider_name,
                enabled,
                config: next,
            });
            let _ = &metadata;
            let next_effective = builtin.providers.overlay(&providers);
            assert_provider_label_unique(provider_id, &current_effective, &next_effective)?;
            Ok(PersonalConfigLayer {
                providers: domain_providers_to_personal(&providers)?,
                models: domain_models_to_personal(&current.models),
                provider_order: current.provider_order.clone(),
                default_model_selection: current.default_model_selection.clone(),
            })
        })
    }

    pub fn create_personal_provider(
        &self,
        input: CreatePersonalProviderInput,
    ) -> Result<String, String> {
        let builtin = self.zcode_builtin.read()?;
        let template_id = input
            .template_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(template_id) = template_id {
            if builtin.provider_templates.get(template_id).is_none() {
                return Err(format!("Provider Template does not exist: {template_id}"));
            }
        }
        if input
            .initial_config
            .as_ref()
            .and_then(|config| config.group.as_ref())
            .is_some()
        {
            return Err("initialConfig must not contain group".into());
        }
        if input
            .initial_config
            .as_ref()
            .and_then(|config| config.builtin_model_ids.as_ref())
            .is_some()
        {
            return Err("initialConfig must not contain builtinModelIds".into());
        }
        let provider_id_holder: std::sync::Arc<Mutex<Option<String>>> =
            std::sync::Arc::new(Mutex::new(None));
        let created: String = self
            .personal
            .update(|current| {
                let current = personal_layer_snapshot_to_domain(current);
                let occupied: std::collections::HashSet<String> = builtin
                    .providers
                    .keys()
                    .iter()
                    .map(|key| key.to_string())
                    .chain(current.providers.keys().into_iter().map(str::to_string))
                    .collect();
                let provider_id = next_personal_provider_id(&occupied, template_id);
                let effective = resolve_personal_provider_baselines(&builtin, &current.providers);
                let _ = effective;
                let next_label = {
                    let effective =
                        resolve_personal_provider_baselines(&builtin, &current.providers);
                    let preferred_label = input.provider_name.clone().or_else(|| {
                        template_id.map(|template_id| {
                            let template = builtin.provider_templates.get(template_id);
                            match template {
                                Some(template) => {
                                    let locale = input.locale.as_deref().unwrap_or("en-US");
                                    template_name_for_locale(template, locale)
                                }
                                None => "new-provider".into(),
                            }
                        })
                    });
                    let effective = effective;
                    next_personal_provider_label(
                        preferred_label.as_deref().unwrap_or("new-provider"),
                        &effective,
                    )
                };
                let template = template_id.and_then(|id| builtin.provider_templates.get(id));
                let provider = ProviderConfigData {
                    group: Some(Some(crate::schema::ProviderGroup::StandardPersonal)),
                    logo: None,
                    access: match template {
                        Some(_) => None,
                        None => Some(Some(crate::schema::ProviderAccessData::ApiKey {
                            api_key: None,
                            api_key_management_url: None,
                            api_key_editable: None,
                        })),
                    },
                    api: None,
                    builtin_model_ids: None,
                    personal_model_ids: Some(Some(Vec::new())),
                    model_order: Some(Some(Vec::new())),
                    visibility: None,
                };
                let initial = input.initial_config.clone().unwrap_or_default();
                let providers = current.providers.set_rule(ProviderConfigRule {
                    provider_id: provider_id.clone(),
                    template_id: template_id.map(|id| Some(id.to_string())),
                    provider_name: Some(Some(next_label)),
                    enabled: None,
                    config: provider.overlay(&initial),
                });
                let next_order = append_current_provider_order(
                    &builtin.providers,
                    &providers,
                    current.provider_order.as_deref(),
                    &provider_id,
                );
                *provider_id_holder.lock().unwrap() = Some(provider_id.clone());
                Ok(PersonalConfigLayer {
                    providers: domain_providers_to_personal(&providers)?,
                    models: domain_models_to_personal(&current.models),
                    provider_order: Some(next_order),
                    default_model_selection: current.default_model_selection.clone(),
                })
            })
            .ok()
            .and_then(|_| provider_id_holder.lock().unwrap().clone())
            .ok_or_else(|| "Failed to create the Personal Provider".to_string())?;
        let _ = created;
        let created_id = provider_id_holder
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "Failed to create the Personal Provider".to_string())?;
        Ok(created_id)
    }

    pub fn delete_personal_provider(&self, provider_id: &str) -> Result<LayerSnapshot, String> {
        assert_non_empty_id("providerId", provider_id)?;
        self.personal.update(|current| {
            let snapshot = personal_layer_snapshot_to_domain(current);
            let providers = snapshot.providers.delete(provider_id);
            let models = snapshot.models.delete_exact_for_provider(provider_id);
            let provider_order = current.provider_order.clone().map(|order| {
                order
                    .into_iter()
                    .filter(|id| id != provider_id)
                    .collect::<Vec<_>>()
            });
            Ok(PersonalConfigLayer {
                providers: domain_providers_to_personal(&providers)?,
                models: domain_models_to_personal(&models),
                provider_order,
                default_model_selection: current.default_model_selection.clone(),
            })
        })
    }

    pub fn reorder_personal_providers(
        &self,
        provider_ids: &[String],
    ) -> Result<LayerSnapshot, String> {
        let builtin = self.zcode_builtin.read()?;
        self.personal.update(|current| {
            let snapshot = personal_layer_snapshot_to_domain(current);
            let provider_order =
                normalize_provider_order(&builtin.providers, &snapshot.providers, provider_ids);
            Ok(PersonalConfigLayer {
                providers: current.providers.clone(),
                models: current.models.clone(),
                provider_order: Some(provider_order),
                default_model_selection: current.default_model_selection.clone(),
            })
        })
    }

    pub fn reorder_personal_models(
        &self,
        provider_id: &str,
        model_ids: &[String],
        membership: Option<&ProviderModelMembership>,
    ) -> Result<LayerSnapshot, String> {
        assert_non_empty_id("providerId", provider_id)?;
        let builtin = self.zcode_builtin.read()?;
        self.personal.update(|current| {
            assert_membership_current(membership, provider_id, &current.revision)?;
            let snapshot = personal_layer_snapshot_to_domain(current);
            let builtin_provider =
                builtin.providers.get(provider_id).cloned().or_else(|| {
                    resolve_template_baseline(&builtin, &snapshot.providers, provider_id)
                });
            let provider = writable_personal_overlay(&builtin, current, provider_id)?;
            let model_order = normalize_model_order(
                membership
                    .map(|m| m.inherited_model_ids)
                    .or(builtin_provider.as_ref().and_then(|config| {
                        config
                            .builtin_model_ids
                            .as_ref()
                            .and_then(|list| list.as_ref())
                            .map(|list| list.as_slice())
                    }))
                    .unwrap_or(&[]),
                provider
                    .personal_model_ids
                    .as_ref()
                    .and_then(|list| list.as_ref())
                    .map(|list| list.as_slice())
                    .unwrap_or(&[]),
                model_ids,
            );
            let providers = snapshot
                .providers
                .set(provider_id, provider.with_model_order(model_order));
            Ok(PersonalConfigLayer {
                providers: domain_providers_to_personal(&providers)?,
                models: current.models.clone(),
                provider_order: current.provider_order.clone(),
                default_model_selection: current.default_model_selection.clone(),
            })
        })
    }

    pub fn add_personal_model(
        &self,
        provider_id: &str,
        model_id: &str,
        config: ModelConfigData,
        membership: Option<&ProviderModelMembership>,
        use_recommended_config: Option<bool>,
    ) -> Result<LayerSnapshot, String> {
        let provider_id = normalize_id("providerId", provider_id)?;
        let model_id = normalize_id("modelId", model_id)?;
        let builtin = self.zcode_builtin.read()?;
        self.personal.update(|current| {
            assert_membership_current(membership, &provider_id, &current.revision)?;
            let snapshot = personal_layer_snapshot_to_domain(current);
            let provider = writable_personal_overlay(&builtin, current, &provider_id)?;
            let builtin_model_ids = membership
                .map(|m| m.inherited_model_ids)
                .map(|ids| ids.to_vec())
                .or_else(|| {
                    resolve_provider_builtin_model_ids(&builtin, &snapshot.providers, &provider_id)
                })
                .unwrap_or_default();
            if builtin_model_ids
                .iter()
                .any(|candidate| candidate == &model_id)
            {
                return Err(format!("Model already exists: {provider_id}/{model_id}"));
            }
            let current_ids = provider
                .personal_model_ids
                .as_ref()
                .and_then(|ids| ids.as_ref())
                .cloned()
                .unwrap_or_default();
            if current_ids.iter().any(|candidate| candidate == &model_id) {
                return Err(format!("Model already exists: {provider_id}/{model_id}"));
            }
            let mut next_ids = current_ids.clone();
            next_ids.push(model_id.clone());
            let existing_order = provider
                .model_order
                .as_ref()
                .and_then(|order| order.as_ref())
                .cloned()
                .unwrap_or_default();
            let providers = snapshot.providers.set(
                &provider_id,
                provider
                    .with_personal_model_ids(next_ids.clone())
                    .with_model_order(normalize_model_order(
                        &builtin_model_ids,
                        &next_ids,
                        &existing_order,
                    )),
            );
            let enabled_true = ModelConfigData {
                enabled: Some(Some(true)),
                properties: None,
                option_specs: None,
            };
            let models = snapshot.models.set_exact(
                &provider_id,
                &model_id,
                config.overlay(&enabled_true),
                use_recommended_config,
            )?;
            Ok(PersonalConfigLayer {
                providers: domain_providers_to_personal(&providers)?,
                models: domain_models_to_personal(&models),
                provider_order: current.provider_order.clone(),
                default_model_selection: current.default_model_selection.clone(),
            })
        })
    }

    pub fn rename_personal_model(
        &self,
        provider_id: &str,
        current_model_id: &str,
        next_model_id: &str,
        membership: Option<&ProviderModelMembership>,
    ) -> Result<LayerSnapshot, String> {
        let provider_id = normalize_id("providerId", provider_id)?;
        let current_id = normalize_id("modelId", current_model_id)?;
        let next_id = normalize_id("modelId", next_model_id)?;
        if current_id == next_id {
            return self.personal.read();
        }
        let builtin = self.zcode_builtin.read()?;
        self.personal.update(|current| {
            assert_membership_current(membership, &provider_id, &current.revision)?;
            let snapshot = personal_layer_snapshot_to_domain(current);
            let provider = snapshot.providers.get(&provider_id).cloned();
            let builtin_model_ids = membership
                .map(|m| m.inherited_model_ids)
                .map(|ids| ids.to_vec())
                .or_else(|| {
                    resolve_provider_builtin_model_ids(&builtin, &snapshot.providers, &provider_id)
                })
                .unwrap_or_default();
            if builtin_model_ids
                .iter()
                .any(|candidate| candidate == &current_id)
            {
                return Err(format!(
                    "Built-in Models cannot be renamed: {provider_id}/{current_id}"
                ));
            }
            let personal_ids: Vec<String> = provider
                .as_ref()
                .and_then(|p| p.personal_model_ids.as_ref())
                .and_then(|ids| ids.as_ref())
                .cloned()
                .unwrap_or_default();
            if !personal_ids
                .iter()
                .any(|candidate| candidate == &current_id)
            {
                return Err(format!(
                    "Personal Model does not exist: {provider_id}/{current_id}"
                ));
            }
            if personal_ids.iter().any(|candidate| candidate == &next_id)
                || builtin_model_ids
                    .iter()
                    .any(|candidate| candidate == &next_id)
            {
                return Err(format!("Model already exists: {provider_id}/{next_id}"));
            }
            let model_ids: Vec<String> = personal_ids
                .iter()
                .map(|candidate| {
                    if candidate == &current_id {
                        next_id.clone()
                    } else {
                        candidate.clone()
                    }
                })
                .collect();
            let requested_order: Vec<String> = provider
                .as_ref()
                .and_then(|p| p.model_order.as_ref())
                .and_then(|order| order.as_ref())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|candidate| {
                    if candidate == current_id {
                        next_id.clone()
                    } else {
                        candidate
                    }
                })
                .collect();
            let provider = provider.ok_or_else(|| {
                format!("Personal Model does not exist: {provider_id}/{current_id}")
            })?;
            let providers = snapshot.providers.set(
                &provider_id,
                provider
                    .with_personal_model_ids(model_ids.clone())
                    .with_model_order(normalize_model_order(
                        &builtin_model_ids,
                        &model_ids,
                        &requested_order,
                    )),
            );
            let models = snapshot
                .models
                .rename_exact_model(&provider_id, &current_id, &next_id);
            Ok(PersonalConfigLayer {
                providers: domain_providers_to_personal(&providers)?,
                models: domain_models_to_personal(&models),
                provider_order: current.provider_order.clone(),
                default_model_selection: current.default_model_selection.clone(),
            })
        })
    }

    pub fn set_personal_model_enabled(
        &self,
        provider_id: &str,
        model_id: &str,
        enabled: bool,
        membership: Option<&ProviderModelMembership>,
    ) -> Result<LayerSnapshot, String> {
        let provider_id = normalize_id("providerId", provider_id)?;
        let model_id = normalize_id("modelId", model_id)?;
        let builtin = self.zcode_builtin.read()?;
        self.personal.update(|current| {
            assert_membership_current(membership, &provider_id, &current.revision)?;
            let snapshot = personal_layer_snapshot_to_domain(current);
            let provider = snapshot.providers.get(&provider_id).cloned();
            let inherited = membership
                .map(|m| m.inherited_model_ids)
                .map(|ids| ids.to_vec())
                .or_else(|| {
                    resolve_provider_builtin_model_ids(&builtin, &snapshot.providers, &provider_id)
                })
                .unwrap_or_default();
            let exists = inherited.iter().any(|candidate| candidate == &model_id)
                || provider
                    .as_ref()
                    .and_then(|p| p.personal_model_ids.as_ref())
                    .and_then(|ids| ids.as_ref())
                    .map(|ids| ids.iter().any(|candidate| candidate == &model_id))
                    .unwrap_or(false);
            if !exists {
                return Err(format!("Model does not exist: {provider_id}/{model_id}"));
            }
            let mut config = snapshot
                .models
                .get_exact(&provider_id, &model_id)
                .unwrap_or(ModelConfigData {
                    enabled: None,
                    properties: None,
                    option_specs: None,
                });
            config = config.overlay(&ModelConfigData {
                enabled: Some(Some(enabled)),
                properties: None,
                option_specs: None,
            });
            let models = snapshot
                .models
                .set_exact(&provider_id, &model_id, config, None)?;
            Ok(PersonalConfigLayer {
                providers: current.providers.clone(),
                models: domain_models_to_personal(&models),
                provider_order: current.provider_order.clone(),
                default_model_selection: current.default_model_selection.clone(),
            })
        })
    }

    pub fn save_personal_model_draft(
        &self,
        provider_id: &str,
        original_model_id: &str,
        next_model_id: &str,
        config: ModelConfigData,
        expected_personal_revision: &str,
        use_recommended_config: Option<bool>,
        membership: Option<&ProviderModelMembership>,
    ) -> Result<LayerSnapshot, String> {
        let provider_id = normalize_id("providerId", provider_id)?;
        let original_id = normalize_id("modelId", original_model_id)?;
        let next_id = normalize_id("modelId", next_model_id)?;
        let builtin = self.zcode_builtin.read()?;
        self.personal.update(|current| {
            assert_membership_current(membership, &provider_id, &current.revision)?;
            if current.revision != expected_personal_revision {
                return Err(format!(
                    "Personal Provider Config revision conflict: expected {expected_personal_revision}, current {}",
                    current.revision
                ));
            }
            let snapshot = personal_layer_snapshot_to_domain(current);
            let recommended = use_recommended_config.unwrap_or_else(|| {
                !matches!(
                    snapshot.models.get_exact_rule(&provider_id, &original_id),
                    Some(ModelConfigRule::ManualProviderModel(_))
                )
            });
            let provider = snapshot.providers.get(&provider_id).cloned();
            let builtin_model_ids = membership
                .map(|m| m.inherited_model_ids)
                .map(|ids| ids.to_vec())
                .or_else(|| resolve_provider_builtin_model_ids(&builtin, &snapshot.providers, &provider_id))
                .unwrap_or_default();
            let builtin_set: std::collections::HashSet<&String> = builtin_model_ids.iter().collect();
            if original_id != next_id && builtin_set.contains(&original_id) {
                return Err(format!("Built-in Models cannot be renamed: {provider_id}/{original_id}"));
            }
            if original_id != next_id && builtin_set.contains(&next_id) {
                return Err(format!("Model already exists: {provider_id}/{next_id}"));
            }
            let personal_model_ids: Vec<String> = provider
                .as_ref()
                .and_then(|p| p.personal_model_ids.as_ref())
                .and_then(|ids| ids.as_ref())
                .cloned()
                .unwrap_or_default();
            let original_exists = builtin_set.contains(&original_id)
                || personal_model_ids.iter().any(|candidate| candidate == &original_id);
            if !original_exists {
                return Err(format!("Model does not exist: {provider_id}/{original_id}"));
            }
            if original_id != next_id
                && (personal_model_ids.iter().any(|candidate| candidate == &next_id)
                    || builtin_set.contains(&next_id))
            {
                return Err(format!("Model already exists: {provider_id}/{next_id}"));
            }
            let mut providers = snapshot.providers.clone();
            let mut models = snapshot.models.clone();
            if original_id != next_id {
                let provider = provider
                    .clone()
                    .ok_or_else(|| format!("Personal Model does not exist: {provider_id}/{original_id}"))?;
                if !provider
                    .personal_model_ids
                    .as_ref()
                    .and_then(|ids| ids.as_ref())
                    .map(|ids| ids.iter().any(|candidate| candidate == &original_id))
                    .unwrap_or(false)
                {
                    return Err(format!("Personal Model does not exist: {provider_id}/{original_id}"));
                }
                let model_ids: Vec<String> = provider
                    .personal_model_ids
                    .as_ref()
                    .and_then(|ids| ids.as_ref())
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|candidate| {
                        if candidate == original_id {
                            next_id.clone()
                        } else {
                            candidate
                        }
                    })
                    .collect();
                let requested_order: Vec<String> = provider
                    .model_order
                    .as_ref()
                    .and_then(|order| order.as_ref())
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|candidate| {
                        if candidate == original_id {
                            next_id.clone()
                        } else {
                            candidate
                        }
                    })
                    .collect();
                providers = providers.set(
                    &provider_id,
                    provider
                        .with_personal_model_ids(model_ids.clone())
                        .with_model_order(normalize_model_order(&builtin_model_ids, &model_ids, &requested_order)),
                );
                models = models.rename_exact_model(&provider_id, &original_id, &next_id);
            }
            models = if recommended && is_structurally_empty(&config) {
                models.delete_exact(&provider_id, &next_id)
            } else {
                models.set_exact(&provider_id, &next_id, config, Some(recommended))?
            };
            Ok(PersonalConfigLayer {
                providers: domain_providers_to_personal(&providers)?,
                models: domain_models_to_personal(&models),
                provider_order: current.provider_order.clone(),
                default_model_selection: current.default_model_selection.clone(),
            })
        })
    }

    pub fn delete_personal_model(
        &self,
        provider_id: &str,
        model_id: &str,
        membership: Option<&ProviderModelMembership>,
    ) -> Result<LayerSnapshot, String> {
        let provider_id = normalize_id("providerId", provider_id)?;
        let model_id = normalize_id("modelId", model_id)?;
        let builtin = self.zcode_builtin.read()?;
        self.personal.update(|current| {
            assert_membership_current(membership, &provider_id, &current.revision)?;
            let snapshot = personal_layer_snapshot_to_domain(current);
            let provider = snapshot.providers.get(&provider_id).cloned();
            let inherited = membership
                .map(|m| m.inherited_model_ids)
                .map(|ids| ids.to_vec())
                .or_else(|| {
                    resolve_provider_builtin_model_ids(&builtin, &snapshot.providers, &provider_id)
                })
                .unwrap_or_default();
            if inherited.iter().any(|candidate| candidate == &model_id) {
                return Err(format!(
                    "Built-in Models cannot be deleted: {provider_id}/{model_id}"
                ));
            }
            let personal_ids: Vec<String> = provider
                .as_ref()
                .and_then(|p| p.personal_model_ids.as_ref())
                .and_then(|ids| ids.as_ref())
                .cloned()
                .unwrap_or_default();
            if !personal_ids.iter().any(|candidate| candidate == &model_id) {
                return Err(format!(
                    "Personal Model does not exist: {provider_id}/{model_id}"
                ));
            }
            let remaining: Vec<String> = personal_ids
                .iter()
                .filter(|candidate| candidate != &&model_id)
                .cloned()
                .collect();
            let models = snapshot.models.delete_exact(&provider_id, &model_id);
            let providers = match provider {
                Some(provider) => {
                    let existing_order = provider_model_order(&provider).to_vec();
                    snapshot.providers.set(
                        &provider_id,
                        provider
                            .with_personal_model_ids(remaining.clone())
                            .with_model_order(normalize_model_order(
                                &inherited,
                                &remaining,
                                &existing_order,
                            )),
                    )
                }
                None => snapshot.providers,
            };
            Ok(PersonalConfigLayer {
                providers: domain_providers_to_personal(&providers)?,
                models: domain_models_to_personal(&models),
                provider_order: current.provider_order.clone(),
                default_model_selection: current.default_model_selection.clone(),
            })
        })
    }

    fn update_personal(
        &self,
        transform: impl FnOnce(&PersonalConfigLayerSnapshot) -> Result<PersonalConfigLayer, String>,
    ) -> Result<LayerSnapshot, String> {
        self.personal.update(|current| {
            let view = personal_layer_snapshot_to_domain(current);
            let default_selection = current.default_model_selection.clone();
            let mut layer = match transform(&view) {
                Ok(layer) => layer,
                Err(error) => return Err(error),
            };
            layer.default_model_selection = default_selection;
            Ok(layer)
        })
    }

    pub fn personal_snapshot(&self) -> Result<LayerSnapshot, String> {
        self.personal.read()
    }
}

/// The view the config-service domain logic works against: the personal layer
/// projected onto the domain map types.
#[derive(Debug, Clone, PartialEq)]
pub struct PersonalConfigLayerSnapshot {
    pub revision: String,
    pub providers: ProviderConfigMap,
    pub models: ModelConfigRules,
    pub provider_order: Option<Vec<String>>,
    pub default_model_selection: Option<ModelSelection>,
}

pub struct MetadataInput {
    pub provider_name: Option<String>,
    pub template_id: Option<String>,
    pub enabled: Option<bool>,
}

/// Checks that the caller's membership baseline is the same personal state we
/// are about to mutate. Reproduces `assertMembershipCurrent`.
fn assert_membership_current(
    membership: Option<&ProviderModelMembership>,
    provider_id: &str,
    current_revision: &str,
) -> Result<(), String> {
    if let Some(membership) = membership {
        (membership.assert_current)()?;
        if membership.provider_id != provider_id || membership.personal_revision != current_revision
        {
            return Err("Provider Settings membership revision conflict".into());
        }
    }
    Ok(())
}

fn personal_layer_snapshot_to_domain(current: &LayerSnapshot) -> PersonalConfigLayerSnapshot {
    PersonalConfigLayerSnapshot {
        revision: current.revision.clone(),
        providers: personal_providers_to_domain(&current.providers),
        models: personal_models_to_domain(&current.models),
        provider_order: current.provider_order.clone(),
        default_model_selection: current.default_model_selection.clone(),
    }
}

fn personal_layer_providers_to_domain(
    providers: &PersonalProviderConfigRulesData,
) -> ProviderConfigMap {
    personal_providers_to_domain(providers)
}

fn personal_layer_models_to_domain(models: &PersonalModelConfigRulesData) -> ModelConfigRules {
    personal_models_to_domain(models)
}

fn personal_providers_to_domain(data: &PersonalProviderConfigRulesData) -> ProviderConfigMap {
    let rules = data
        .provider_rules
        .iter()
        .map(|rule| ProviderConfigRule {
            provider_id: rule.provider_id.clone(),
            template_id: rule.template_id.clone(),
            provider_name: rule.provider_name.clone(),
            enabled: rule.enabled,
            config: ProviderConfigData {
                group: rule.config.group.clone(),
                logo: rule.config.logo.clone(),
                access: rule.config.access.clone(),
                api: rule.config.api.clone(),
                builtin_model_ids: None,
                personal_model_ids: rule.config.personal_model_ids.clone(),
                model_order: rule.config.model_order.clone(),
                visibility: rule.config.visibility.clone(),
            },
        })
        .collect::<Vec<_>>();
    ProviderConfigMap::from_rules(rules).unwrap_or_default()
}

fn personal_models_to_domain(data: &PersonalModelConfigRulesData) -> ModelConfigRules {
    let mut rules: Vec<ModelConfigRule> = Vec::new();
    rules.extend(
        data.provider_model_rules
            .iter()
            .map(|rule| ModelConfigRule::ProviderModel(rule.clone())),
    );
    rules.extend(
        data.manual_provider_model_rules
            .iter()
            .map(|rule| ModelConfigRule::ManualProviderModel(rule.clone())),
    );
    ModelConfigRules::new(rules)
}

fn domain_providers_to_personal(
    providers: &ProviderConfigMap,
) -> Result<PersonalProviderConfigRulesData, String> {
    let mut rules = Vec::new();
    for rule in providers.rules() {
        if rule
            .config
            .builtin_model_ids
            .as_ref()
            .is_some_and(|ids| ids.is_some())
        {
            return Err(format!(
                "Personal provider {} cannot carry builtinModelIds",
                rule.provider_id
            ));
        }
        rules.push(crate::schema::PersonalProviderConfigRuleData {
            provider_id: rule.provider_id.clone(),
            template_id: rule.template_id.clone(),
            provider_name: rule.provider_name.clone(),
            enabled: rule.enabled,
            config: PersonalProviderConfigData {
                group: rule.config.group.clone(),
                logo: rule.config.logo.clone(),
                access: rule.config.access.clone(),
                api: rule.config.api.clone(),
                personal_model_ids: rule.config.personal_model_ids.clone(),
                model_order: rule.config.model_order.clone(),
                visibility: rule.config.visibility.clone(),
            },
        });
    }
    Ok(PersonalProviderConfigRulesData {
        provider_rules: rules,
    })
}

fn domain_models_to_personal(models: &ModelConfigRules) -> PersonalModelConfigRulesData {
    models
        .to_personal_data()
        .unwrap_or_else(|_| PersonalModelConfigRulesData {
            provider_model_rules: Vec::new(),
            manual_provider_model_rules: Vec::new(),
        })
}

fn writable_personal_overlay(
    builtin: &BuiltinSnapshot,
    current: &LayerSnapshot,
    provider_id: &str,
) -> Result<ProviderConfigData, String> {
    let snapshot = personal_layer_snapshot_to_domain(current);
    match snapshot.providers.get(provider_id) {
        Some(provider) => Ok(provider.clone()),
        None if builtin.providers.has(provider_id) => Ok(ProviderConfigData {
            group: None,
            logo: None,
            access: None,
            api: None,
            builtin_model_ids: None,
            personal_model_ids: None,
            model_order: None,
            visibility: None,
        }),
        None => Err(format!("Provider does not exist: {provider_id}")),
    }
}

fn resolve_template_baseline(
    builtin: &BuiltinSnapshot,
    providers: &ProviderConfigMap,
    provider_id: &str,
) -> Option<ProviderConfigData> {
    let template_id = providers
        .get_rule(provider_id)
        .and_then(|rule| rule.template_id.clone())
        .flatten();
    template_id.and_then(|id| {
        builtin
            .provider_templates
            .get(&id)
            .map(|template| template.config.clone())
    })
}

fn resolve_personal_provider_baselines(
    builtin: &BuiltinSnapshot,
    personal: &ProviderConfigMap,
) -> ProviderConfigMap {
    let personal = personal.map_configs(|config, _, rule| {
        let template = rule
            .template_id
            .as_ref()
            .and_then(|template_id| template_id.as_ref())
            .and_then(|template_id| builtin.provider_templates.get(template_id));
        match template {
            Some(template) => template.config.overlay(config),
            None => config.clone(),
        }
    });
    builtin.providers.overlay(&personal)
}

fn resolve_provider_builtin_model_ids(
    builtin: &BuiltinSnapshot,
    personal: &ProviderConfigMap,
    provider_id: &str,
) -> Option<Vec<String>> {
    builtin
        .providers
        .get(provider_id)
        .and_then(|config| config.builtin_model_ids.as_ref())
        .and_then(|ids| ids.as_ref())
        .cloned()
        .or_else(|| {
            resolve_template_baseline(builtin, personal, provider_id)
                .and_then(|config| config.builtin_model_ids)
                .and_then(|ids| ids)
        })
}

fn normalize_personal_membership(
    personal: Option<ProviderConfigData>,
    builtin: Option<ProviderConfigData>,
    inherited_model_ids: Option<&[String]>,
) -> Option<ProviderConfigData> {
    let mut personal = personal?;
    let builtin_model_ids = unique_in_order(
        inherited_model_ids
            .map(|ids| ids.to_vec())
            .or_else(|| {
                builtin
                    .as_ref()
                    .and_then(|config| config.builtin_model_ids.as_ref())
                    .and_then(|ids| ids.as_ref())
                    .cloned()
            })
            .unwrap_or_default(),
    );
    let builtin_set: std::collections::HashSet<&String> = builtin_model_ids.iter().collect();
    let personal_model_ids = unique_in_order(
        personal
            .personal_model_ids
            .as_ref()
            .and_then(|ids| ids.as_ref())
            .cloned()
            .unwrap_or_default(),
    )
    .into_iter()
    .filter(|id| !builtin_set.contains(id))
    .collect::<Vec<_>>();
    personal.personal_model_ids = Some(Some(personal_model_ids.clone()));
    if personal
        .model_order
        .as_ref()
        .is_some_and(|order| order.is_some())
    {
        personal.model_order = Some(Some(normalize_model_order(
            &builtin_model_ids,
            &personal_model_ids,
            personal
                .model_order
                .as_ref()
                .and_then(|order| order.as_ref())
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        )));
    }
    Some(personal)
}

impl ProviderConfigData {
    pub fn with_personal_model_ids(mut self, model_ids: Vec<String>) -> Self {
        self.personal_model_ids = Some(Some(model_ids));
        self
    }

    pub fn with_model_order(mut self, model_order: Vec<String>) -> Self {
        self.model_order = Some(Some(model_order));
        self
    }

    pub fn with_model_membership_from(mut self, source: Option<ProviderConfigData>) -> Self {
        if let Some(source) = source {
            self.builtin_model_ids = source.builtin_model_ids;
            self.personal_model_ids = source.personal_model_ids;
            self.model_order = source.model_order;
        }
        self
    }
}

fn provider_model_order(provider: &ProviderConfigData) -> &[String] {
    provider
        .model_order
        .as_ref()
        .and_then(|order| order.as_ref())
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn normalize_model_order(
    builtin_model_ids: &[String],
    personal_model_ids: &[String],
    requested: &[String],
) -> Vec<String> {
    resolve_owned_order(builtin_model_ids, personal_model_ids, requested)
}

fn normalize_provider_order(
    _builtin: &ProviderConfigMap,
    personal: &ProviderConfigMap,
    requested: &[String],
) -> Vec<String> {
    let personal_ids: Vec<String> = personal
        .entries()
        .iter()
        .filter_map(|&(id, config)| {
            let is_personal = config
                .group
                .as_ref()
                .and_then(|group| group.as_ref())
                .map(|group| *group == crate::schema::ProviderGroup::StandardPersonal)
                .unwrap_or(false);
            if is_personal {
                Some(id.to_string())
            } else {
                None
            }
        })
        .collect();
    resolve_owned_order(&[], &personal_ids, requested)
}

fn append_current_provider_order(
    builtin: &ProviderConfigMap,
    personal: &ProviderConfigMap,
    current: Option<&[String]>,
    added: &str,
) -> Vec<String> {
    let current = normalize_provider_order(builtin, personal, current.unwrap_or(&[]));
    let mut combined: Vec<String> = current
        .into_iter()
        .filter(|candidate| candidate != added)
        .collect();
    combined.push(added.to_string());
    normalize_provider_order(builtin, personal, &combined)
}

/// `resolveOwnedOrder` — shared with the resolver so model order and provider
/// order normalise the same way a write and a read do. One implementation.
pub fn resolve_owned_order_pub(
    builtin_ids: &[String],
    personal_ids: &[String],
    requested: &[String],
) -> Vec<String> {
    resolve_owned_order(builtin_ids, personal_ids, requested)
}

fn resolve_owned_order(
    builtin_ids: &[String],
    personal_ids: &[String],
    requested: &[String],
) -> Vec<String> {
    let builtin = unique_in_order(builtin_ids.iter().cloned().collect());
    let builtin_set: std::collections::HashSet<&String> = builtin.iter().collect();
    let personal = unique_in_order(personal_ids.iter().cloned().collect())
        .into_iter()
        .filter(|id| !builtin_set.contains(id))
        .collect::<Vec<_>>();
    let member_set: std::collections::HashSet<&String> =
        builtin.iter().chain(personal.iter()).collect();
    let mut ordered = unique_in_order(requested.iter().cloned().collect());
    ordered.retain(|id| member_set.contains(id));
    let ordered_set: std::collections::HashSet<String> = ordered.iter().cloned().collect();
    let mut result = Vec::new();
    result.extend(
        builtin
            .iter()
            .filter(|id| !ordered_set.contains(*id))
            .cloned(),
    );
    result.extend(ordered);
    result.extend(
        personal
            .iter()
            .filter(|id| !ordered_set.contains(*id))
            .cloned(),
    );
    result
}

fn unique_in_order(values: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for value in values {
        if seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

fn next_personal_provider_id(
    occupied: &std::collections::HashSet<String>,
    template_id: Option<&str>,
) -> String {
    let base = template_id
        .map(normalize_provider_id_seed)
        .unwrap_or_else(|| "new-provider".into());
    if !occupied.contains(&base) {
        return base;
    }
    for suffix in 2.. {
        let candidate = format!("{base}-{suffix}");
        if !occupied.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn normalize_provider_id_seed(value: &str) -> String {
    let lowered = value.trim().to_lowercase();
    let mut out = String::new();
    let mut last_dash = true;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "new-provider".into()
    } else {
        out
    }
}

fn next_personal_provider_label(seed: &str, providers: &ProviderConfigMap) -> String {
    let base = if seed.trim().is_empty() {
        "new-provider".to_string()
    } else {
        seed.trim().to_string()
    };
    let labels: std::collections::HashSet<String> = providers
        .rules()
        .iter()
        .filter_map(|rule| rule.provider_name.as_ref())
        .filter_map(|name| name.as_ref())
        .map(|name| name.trim().to_lowercase())
        .collect();
    if !labels.contains(&base.to_lowercase()) {
        return base;
    }
    for suffix in 2.. {
        let candidate = format!("{base} {suffix}");
        if !labels.contains(&candidate.to_lowercase()) {
            return candidate;
        }
    }
    unreachable!()
}

fn assert_provider_label_unique(
    provider_id: &str,
    current: &ProviderConfigMap,
    next: &ProviderConfigMap,
) -> Result<(), String> {
    let current_label = current
        .get_rule(provider_id)
        .and_then(|rule| rule.provider_name.as_ref())
        .and_then(|name| name.as_ref())
        .map(|name| name.trim().to_lowercase());
    let next_label = next
        .get_rule(provider_id)
        .and_then(|rule| rule.provider_name.as_ref())
        .and_then(|name| name.as_ref())
        .map(|name| name.trim().to_lowercase());
    let Some(next_label) = next_label else {
        return Ok(());
    };
    if Some(next_label.clone()) == current_label {
        return Ok(());
    }
    for candidate in next.rules() {
        if candidate.provider_id == provider_id {
            continue;
        }
        if candidate
            .provider_name
            .as_ref()
            .and_then(|name| name.as_ref())
            .map(|name| name.trim().to_lowercase())
            .as_deref()
            == Some(next_label.as_str())
        {
            return Err(format!("Provider name already exists: {next_label}"));
        }
    }
    Ok(())
}

fn is_structurally_empty(config: &ModelConfigData) -> bool {
    let Ok(value) = serde_json::to_value(config) else {
        return false;
    };
    value_is_structurally_empty(&value)
}

fn value_is_structurally_empty(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Array(items) => items.is_empty(),
        serde_json::Value::Object(map) => map.values().all(value_is_structurally_empty),
        serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => false,
    }
}

fn escape_json_string(value: &str) -> String {
    let escaped = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into());
    escaped[1..escaped.len() - 1].to_string()
}

fn template_name_for_locale(template: &crate::domain::ProviderTemplate, locale: &str) -> String {
    let locale_key = locale;
    let from_locale = match locale_key {
        "zh-CN" => template.template_name_map.zh_cn.as_deref(),
        _ => template.template_name_map.en_us.as_deref(),
    };
    from_locale
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            template
                .template_name_map
                .en_us
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| template.template_id.clone())
}

fn assert_non_empty_id(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(())
    }
}

fn normalize_id(label: &str, value: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(normalized.to_string())
    }
}

impl Default for PersonalProviderConfigRulesData {
    fn default() -> Self {
        Self {
            provider_rules: Vec::new(),
        }
    }
}

impl Default for PersonalModelConfigRulesData {
    fn default() -> Self {
        Self {
            provider_model_rules: Vec::new(),
            manual_provider_model_rules: Vec::new(),
        }
    }
}

// The merge helper used by the domain layer; re-exported for callers that
// operate on raw ModelConfigData directly.
pub use crate::domain::Overlay as ProviderConfigWorkflowOverlay;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{
        ModelSelection, PersonalProviderConfigRuleData,
        ProviderConfigData as _ProviderConfigDataAlias,
    };

    #[test]
    fn resolve_owned_order_places_unsorted_builtin_first_and_personal_last() {
        let builtin = vec!["a".to_string(), "b".to_string()];
        let personal = vec!["c".to_string(), "d".to_string()];
        let requested = vec!["c".to_string(), "a".to_string()];
        let resolved = resolve_owned_order(&builtin, &personal, &requested);
        // Unsorted builtin members come first, then the user's requested order,
        // then unsorted personal members (see owned-order.ts).
        assert_eq!(resolved, vec!["b", "c", "a", "d"]);
    }

    #[test]
    fn owned_order_drops_foreign_and_duplicate_requests() {
        let builtin = vec!["a".to_string()];
        let personal = vec!["c".to_string()];
        let requested = vec!["c".to_string(), "x".to_string(), "c".to_string()];
        let resolved = resolve_owned_order(&builtin, &personal, &requested);
        assert_eq!(resolved, vec!["a", "c"]);
    }

    #[test]
    fn structurally_empty_config_is_detected() {
        let empty = ModelConfigData {
            enabled: None,
            properties: None,
            option_specs: None,
        };
        assert!(is_structurally_empty(&empty));
        let not_empty = ModelConfigData {
            enabled: Some(Some(true)),
            properties: None,
            option_specs: None,
        };
        assert!(!is_structurally_empty(&not_empty));
    }
}
