//! Account provider facts and their third-layer config overlay.
//!
//! Rust port of `packages/provider/src/sources.ts` (account snapshots,
//! fail-closed snapshot, mutable account source) and
//! `packages/provider/src/account-provider-resolution.ts`
//! (`resolveAccountProviderConfigs`).
//!
//! Account facts are live runtime state, not config: tokens, API keys, headers
//! and the account identity never land in the config files. The overlay this
//! module produces only carries `access.entitled` (and, for a Start plan, the
//! authoritative model list), so a wrong overlay can hide models, never leak a
//! secret.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::config_service::BuiltinSnapshot;
use crate::domain::ProviderConfigMap;
use crate::schema::ProviderConfigData;
use crate::schema::{ProviderAccessData, ZhipuAccountMode};

/// `not-authenticated | not-connected | credential-failed | not-entitled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum AccountProviderUnavailableReason {
    #[serde(rename = "not-authenticated")]
    NotAuthenticated,
    #[serde(rename = "not-connected")]
    NotConnected,
    #[serde(rename = "credential-failed")]
    CredentialFailed,
    #[serde(rename = "not-entitled")]
    NotEntitled,
}
/// Live account facts for one provider.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProviderState {
    pub availability: Availability,
    pub entitled: bool,
    /// Only meaningful when `availability` is `Unavailable`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<AccountProviderUnavailableReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<bool>,
    /// Identity of the same snapshot, used only to isolate state changes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_key: Option<String>,
    /// Unix seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Availability {
    Available,
    Pending,
    Unavailable,
    #[default]
    Unknown,
}

impl Availability {
    fn as_str(self) -> &'static str {
        match self {
            Availability::Available => "available",
            Availability::Pending => "pending",
            Availability::Unavailable => "unavailable",
            Availability::Unknown => "unknown",
        }
    }
}

/// One round's connection outcome for an account provider.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountProviderConnectionResult {
    pub provider_id: String,
    pub status: ConnectionStatus,
    /// `resetPrevious` forbids reusing the previous snapshot once the account
    /// or organization identity changes.
    pub reset_previous: Option<bool>,
    /// Only present for `StartPlan` connections.
    pub models: Option<Vec<String>>,
    pub unavailable_reason: Option<AccountProviderUnavailableReason>,
    pub current: Option<bool>,
    pub connection_key: Option<String>,
    pub effective_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Available,
    Pending,
    Unavailable,
    Unknown,
}

/// The per-provider account states keyed by provider id.
pub type AccountProviderStates = Vec<(String, AccountProviderState)>;

/// The account layer snapshot the registry consumes.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountProviderConfigSnapshot {
    pub revision: String,
    pub based_on_zcode_builtin_revision: String,
    pub providers: ProviderConfigMap,
    pub states: Option<Vec<(String, AccountProviderState)>>,
}

fn entitlement_overlay(entitled: bool) -> ProviderConfigData {
    ProviderConfigData {
        group: None,
        logo: None,
        access: Some(Some(ProviderAccessData::ZhipuAccount {
            account_type: None,
            mode: None,
            entitled: Some(Some(entitled)),
        })),
        api: None,
        builtin_model_ids: None,
        personal_model_ids: None,
        model_order: None,
        visibility: None,
    }
}

fn normalize_model_ids(values: Option<&Vec<String>>) -> Vec<String> {
    values
        .map(|values| {
            values
                .iter()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Converts account connection results into the third-layer Account Provider
/// Config the registry overlays. Mirrors `resolveAccountProviderConfigs`.
pub fn resolve_account_provider_configs(
    configured_providers: &ProviderConfigMap,
    previous_providers: &ProviderConfigMap,
    connections: &[AccountProviderConnectionResult],
) -> Result<ProviderConfigMap, String> {
    let mut connection_by_provider: std::collections::HashMap<
        String,
        &AccountProviderConnectionResult,
    > = std::collections::HashMap::new();
    for connection in connections {
        if connection_by_provider.contains_key(&connection.provider_id) {
            return Err(format!(
                "Duplicate Account Provider connection result: {}",
                connection.provider_id
            ));
        }
        let Some(configured) = configured_providers.get(&connection.provider_id) else {
            return Err(format!(
                "Account connection points to unconfigured Provider: {}",
                connection.provider_id
            ));
        };
        if !is_account_constrained(configured) {
            return Err(format!(
                "Account connection points to non-Account Provider: {}",
                connection.provider_id
            ));
        }
        connection_by_provider.insert(connection.provider_id.clone(), connection);
    }

    let mut resolved: Vec<(String, ProviderConfigData)> = Vec::new();
    for (provider_id, configured) in configured_providers.entries() {
        if !is_account_constrained(configured) {
            continue;
        }
        let status = connection_by_provider
            .get(provider_id)
            .map(|connection| connection.status)
            .unwrap_or(ConnectionStatus::Unknown);
        let reset_previous = connection_by_provider
            .get(provider_id)
            .and_then(|connection| connection.reset_previous)
            .unwrap_or(false);

        match status {
            ConnectionStatus::Available | ConnectionStatus::Pending => {
                let entitled = status == ConnectionStatus::Available;
                let is_start_plan = matches!(
                    configured
                        .access
                        .as_ref()
                        .and_then(|access| access.as_ref()),
                    Some(ProviderAccessData::ZhipuAccount {
                        mode: Some(Some(ZhipuAccountMode::StartPlan)),
                        ..
                    })
                );
                let mut overlay = entitlement_overlay(entitled);
                if is_start_plan {
                    let models = normalize_model_ids(
                        connection_by_provider
                            .get(provider_id)
                            .and_then(|connection| connection.models.as_ref()),
                    );
                    // An empty list is this round's authoritative answer: an
                    // expired whitelist must not be retained.
                    overlay.builtin_model_ids = Some(Some(models));
                }
                resolved.push((provider_id.to_string(), overlay));
            }
            ConnectionStatus::Unavailable => {
                resolved.push((provider_id.to_string(), entitlement_overlay(false)));
            }
            ConnectionStatus::Unknown => {
                let previous = if reset_previous {
                    None
                } else {
                    previous_providers.get(provider_id).cloned()
                };
                resolved.push((
                    provider_id.to_string(),
                    previous.unwrap_or_else(|| entitlement_overlay(false)),
                ));
            }
        }
    }

    ProviderConfigMap::from_rules(
        resolved
            .into_iter()
            .map(|(provider_id, config)| crate::domain::ProviderConfigRule {
                provider_id,
                template_id: None,
                provider_name: None,
                enabled: None,
                config,
            })
            .collect(),
    )
}

fn is_account_constrained(config: &ProviderConfigData) -> bool {
    matches!(
        config.access.as_ref().and_then(|access| access.as_ref()),
        Some(ProviderAccessData::ZhipuAccount { .. })
    )
}

/// Produces the publishable fail-closed overlay based on the current Built-in,
/// for the case where the first Account facts have not arrived yet.
pub fn create_fail_closed_account_provider_config_snapshot(
    builtin: &BuiltinSnapshot,
) -> AccountProviderConfigSnapshot {
    let mut rules = Vec::new();
    for (provider_id, config) in builtin.providers.entries() {
        if is_account_constrained(config) {
            rules.push(crate::domain::ProviderConfigRule {
                provider_id: provider_id.to_string(),
                template_id: None,
                provider_name: None,
                enabled: None,
                config: entitlement_overlay(false),
            });
        }
    }
    create_account_provider_config_snapshot(
        builtin.revision.clone(),
        ProviderConfigMap::from_rules(rules).unwrap_or_default(),
        None,
    )
}

/// Revision string: `account:{basedOnBuiltinRevision}:{providers}:{states}`.
pub fn create_account_provider_config_snapshot(
    based_on_zcode_builtin_revision: String,
    providers: ProviderConfigMap,
    states: Option<Vec<(String, AccountProviderState)>>,
) -> AccountProviderConfigSnapshot {
    let providers_json = serde_json::to_string(&providers.to_data()).unwrap_or_default();
    let states_json = states
        .as_ref()
        .map(|states| {
            let ordered: Vec<serde_json::Value> = states
                .iter()
                .map(|(provider_id, state)| serde_json::json!([provider_id, state_json(state)]))
                .collect();
            serde_json::to_string(&ordered).unwrap_or_default()
        })
        .unwrap_or_else(|| "null".to_string());
    AccountProviderConfigSnapshot {
        revision: format!(
            "account:{based_on_zcode_builtin_revision}:{providers_json}:{states_json}"
        ),
        based_on_zcode_builtin_revision,
        providers,
        states,
    }
}

fn state_json(state: &AccountProviderState) -> serde_json::Value {
    serde_json::json!({
        "availability": state.availability.as_str(),
        "entitled": state.entitled,
        "unavailableReason": state.unavailable_reason.map(reason_str),
        "current": state.current,
        "connectionKey": state.connection_key,
        "effectiveAt": state.effective_at,
    })
}

fn reason_str(reason: AccountProviderUnavailableReason) -> &'static str {
    match reason {
        AccountProviderUnavailableReason::NotAuthenticated => "not-authenticated",
        AccountProviderUnavailableReason::NotConnected => "not-connected",
        AccountProviderUnavailableReason::CredentialFailed => "credential-failed",
        AccountProviderUnavailableReason::NotEntitled => "not-entitled",
    }
}

/// Build the per-provider states for this round. Mirrors the state loop in
/// `createAccountProviderConfigResolver`.
pub fn resolve_account_provider_states(
    providers: &ProviderConfigMap,
    connections: &[AccountProviderConnectionResult],
    previous_states: Option<&Vec<(String, AccountProviderState)>>,
) -> Vec<(String, AccountProviderState)> {
    let mut states = Vec::new();
    for connection in connections {
        let previous = if connection.reset_previous.unwrap_or(false) {
            None
        } else {
            previous_states.and_then(|states| {
                states
                    .iter()
                    .find(|(provider_id, _)| provider_id == &connection.provider_id)
                    .map(|(_, state)| state)
            })
        };
        let access = providers
            .get(&connection.provider_id)
            .and_then(|config| config.access.as_ref().and_then(|access| access.as_ref()));
        let entitled = matches!(
            access,
            Some(ProviderAccessData::ZhipuAccount {
                entitled: Some(Some(true)),
                ..
            })
        );
        // `unknown` only retains the last displayed fact; `current` is always
        // from this round and cannot resurrect an old connection.
        let unavailable_reason = if connection.status == ConnectionStatus::Unknown {
            previous.and_then(|previous| previous.unavailable_reason)
        } else if connection.status == ConnectionStatus::Unavailable {
            connection.unavailable_reason
        } else {
            None
        };
        let availability = if connection.status == ConnectionStatus::Unknown {
            previous
                .map(|previous| previous.availability)
                .unwrap_or(Availability::Unknown)
        } else {
            match connection.status {
                ConnectionStatus::Available => Availability::Available,
                ConnectionStatus::Pending => Availability::Pending,
                ConnectionStatus::Unavailable => Availability::Unavailable,
                ConnectionStatus::Unknown => Availability::Unknown,
            }
        };
        states.push((
            connection.provider_id.clone(),
            AccountProviderState {
                availability,
                entitled,
                unavailable_reason,
                current: connection.current,
                connection_key: connection.connection_key.clone(),
                effective_at: connection.effective_at,
            },
        ));
    }
    states
}

/// The account overlay source. The only mutable state is the current snapshot;
/// `replace` is a no-op when the revision has not changed, which is what keeps
/// a repeated poll from re-rendering the settings page.
pub trait AccountSource: Send + Sync {
    fn read(&self) -> AccountProviderConfigSnapshot;
    fn on_did_change(&self, listener: Box<dyn Fn(&str) + Send>);
}

/// Holds the account snapshot and notifies on change. Mirrors
/// `MutableAccountProviderConfigSource`.
pub struct MutableAccountProviderConfigSource {
    snapshot: Mutex<AccountProviderConfigSnapshot>,
    listeners: Mutex<Vec<Box<dyn Fn(&str) + Send>>>,
    disposed: AtomicBool,
}

const EMPTY_ACCOUNT_REVISION: &str = "empty-account-config-v1";

impl Default for MutableAccountProviderConfigSource {
    fn default() -> Self {
        Self::new()
    }
}

impl MutableAccountProviderConfigSource {
    pub fn new() -> Self {
        Self {
            snapshot: Mutex::new(AccountProviderConfigSnapshot {
                revision: EMPTY_ACCOUNT_REVISION.to_string(),
                based_on_zcode_builtin_revision: "uninitialized".to_string(),
                providers: ProviderConfigMap::empty(),
                states: None,
            }),
            listeners: Mutex::new(Vec::new()),
            disposed: AtomicBool::new(false),
        }
    }

    /// Replace the snapshot; returns false when the revision is unchanged.
    pub fn replace(&self, snapshot: AccountProviderConfigSnapshot, reason: &str) -> bool {
        if self.disposed.load(Ordering::SeqCst) {
            return false;
        }
        let mut current = self.snapshot.lock().unwrap();
        if snapshot.revision == current.revision {
            return false;
        }
        *current = snapshot;
        drop(current);
        for listener in self.listeners.lock().unwrap().iter() {
            listener(reason);
        }
        true
    }

    pub fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        self.listeners.lock().unwrap().clear();
    }
}

impl AccountSource for MutableAccountProviderConfigSource {
    fn read(&self) -> AccountProviderConfigSnapshot {
        self.snapshot.lock().unwrap().clone()
    }

    fn on_did_change(&self, listener: Box<dyn Fn(&str) + Send>) {
        self.listeners.lock().unwrap().push(listener);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account_provider(mode: Option<ZhipuAccountMode>) -> ProviderConfigData {
        ProviderConfigData {
            group: None,
            logo: None,
            access: Some(Some(ProviderAccessData::ZhipuAccount {
                account_type: None,
                mode: mode.map(Some),
                entitled: None,
            })),
            api: None,
            builtin_model_ids: None,
            personal_model_ids: None,
            model_order: None,
            visibility: None,
        }
    }

    #[test]
    fn an_available_start_plan_publishes_the_authoritative_model_list() {
        let configured = ProviderConfigMap::from_rules(vec![crate::domain::ProviderConfigRule {
            provider_id: "account:zai".into(),
            template_id: None,
            provider_name: None,
            enabled: None,
            config: account_provider(Some(ZhipuAccountMode::StartPlan)),
        }])
        .unwrap();
        let connections = vec![AccountProviderConnectionResult {
            provider_id: "account:zai".into(),
            status: ConnectionStatus::Available,
            reset_previous: None,
            models: Some(vec![" glm-5 ".into(), "glm-5-flash".into(), "  ".into()]),
            unavailable_reason: None,
            current: Some(true),
            connection_key: Some("acct-1".into()),
            effective_at: Some(1_700_000_000),
        }];
        let resolved = resolve_account_provider_configs(
            &configured,
            &ProviderConfigMap::empty(),
            &connections,
        )
        .unwrap();
        let config = resolved.get("account:zai").unwrap();
        assert_eq!(
            config
                .builtin_model_ids
                .as_ref()
                .and_then(|ids| ids.as_ref()),
            Some(&vec!["glm-5".to_string(), "glm-5-flash".to_string()])
        );
        assert!(matches!(
            config.access.as_ref().and_then(|access| access.as_ref()),
            Some(ProviderAccessData::ZhipuAccount {
                entitled: Some(Some(true)),
                ..
            })
        ));
    }

    #[test]
    fn an_unknown_connection_keeps_the_previous_overlay_and_otherwise_fails_closed() {
        let configured = ProviderConfigMap::from_rules(vec![crate::domain::ProviderConfigRule {
            provider_id: "account:zai".into(),
            template_id: None,
            provider_name: None,
            enabled: None,
            config: account_provider(None),
        }])
        .unwrap();
        let previous = ProviderConfigMap::from_rules(vec![crate::domain::ProviderConfigRule {
            provider_id: "account:zai".into(),
            template_id: None,
            provider_name: None,
            enabled: None,
            config: entitlement_overlay(true),
        }])
        .unwrap();
        let unknown = [AccountProviderConnectionResult {
            provider_id: "account:zai".into(),
            status: ConnectionStatus::Unknown,
            reset_previous: None,
            models: None,
            unavailable_reason: None,
            current: None,
            connection_key: None,
            effective_at: None,
        }];
        let kept = resolve_account_provider_configs(&configured, &previous, &unknown).unwrap();
        assert!(matches!(
            kept.get("account:zai")
                .and_then(|config| config.access.as_ref())
                .and_then(|access| access.as_ref()),
            Some(ProviderAccessData::ZhipuAccount {
                entitled: Some(Some(true)),
                ..
            })
        ));

        let reset = [AccountProviderConnectionResult {
            reset_previous: Some(true),
            ..unknown[0].clone()
        }];
        let closed = resolve_account_provider_configs(&configured, &previous, &reset).unwrap();
        assert!(matches!(
            closed
                .get("account:zai")
                .and_then(|config| config.access.as_ref())
                .and_then(|access| access.as_ref()),
            Some(ProviderAccessData::ZhipuAccount {
                entitled: Some(Some(false)),
                ..
            })
        ));
    }

    #[test]
    fn a_connection_for_an_unconfigured_provider_is_rejected() {
        let configured = ProviderConfigMap::empty();
        let connections = [AccountProviderConnectionResult {
            provider_id: "account:missing".into(),
            status: ConnectionStatus::Available,
            reset_previous: None,
            models: None,
            unavailable_reason: None,
            current: None,
            connection_key: None,
            effective_at: None,
        }];
        let error = resolve_account_provider_configs(
            &configured,
            &ProviderConfigMap::empty(),
            &connections,
        )
        .unwrap_err();
        assert!(error.contains("unconfigured Provider"), "{error}");
    }

    #[test]
    fn replacing_with_the_same_revision_is_a_no_op() {
        let source = MutableAccountProviderConfigSource::new();
        let snapshot = create_account_provider_config_snapshot(
            "builtin:1".into(),
            ProviderConfigMap::empty(),
            None,
        );
        assert!(source.replace(snapshot.clone(), "replace"));
        assert!(!source.replace(snapshot, "replace"));
    }
}
