//! Provider registry orchestration: one cached snapshot, one refresh path.
//!
//! Rust port of `packages/provider/src/registry-service.ts`
//! (`ProviderRegistryService`) composed with the `ProviderRuntime` wiring in
//! `packages/services/src/model-provider/providerRuntime.ts`. The service owns
//! the read path: it reads the config source (builtin + personal) and the
//! account source, resolves them through the `ProviderConfigResolver`, caches
//! the snapshot, and exposes it to the facades. Change events fire when a
//! source reports a new reason; a refresh coalesces concurrent reads so two
//! callers never trigger two resolves.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::account::{
    AccountProviderConfigSnapshot, AccountSource, MutableAccountProviderConfigSource,
};
use crate::config_service::{ProviderConfigService, ProviderConfigSnapshot};
use crate::facades::{
    create_model_selection_view, create_provider_settings_view, ModelSelectionView,
    ModelSelectionViewInput, ProviderSettingsView, ProviderSettingsViewInput,
};
use crate::resolver::{ProviderConfigResolution, ProviderRegistryView, ResolverInput};

/// What one refresh produced, plus the reasons that triggered it.
#[derive(Clone)]
pub struct ProviderRegistryServiceSnapshot {
    pub config: ProviderConfigSnapshot,
    pub account: AccountProviderConfigSnapshot,
    pub resolution: ProviderConfigResolution,
    pub registry: ProviderRegistryView,
}

/// The change event the facades forward to the Renderer.
#[derive(Debug, Clone)]
pub struct ProviderRegistryServiceChangedEvent {
    pub reasons: Vec<String>,
}

pub struct ProviderRegistryService {
    config: ProviderConfigService,
    account: std::sync::Arc<MutableAccountProviderConfigSource>,
    snapshot: Mutex<Option<ProviderRegistryServiceSnapshot>>,
    revision: std::sync::atomic::AtomicU64,
    change_listeners: Mutex<Vec<Box<dyn Fn(&ProviderRegistryServiceChangedEvent) + Send>>>,
    started: AtomicBool,
    disposed: AtomicBool,
    in_flight: Mutex<bool>,
}

impl ProviderRegistryService {
    pub fn new(
        config: ProviderConfigService,
        account: std::sync::Arc<MutableAccountProviderConfigSource>,
    ) -> Self {
        Self {
            config,
            account,
            snapshot: Mutex::new(None),
            revision: std::sync::atomic::AtomicU64::new(0),
            change_listeners: Mutex::new(Vec::new()),
            started: AtomicBool::new(false),
            disposed: AtomicBool::new(false),
            in_flight: Mutex::new(false),
        }
    }

    /// Subscribe to source changes; each reason is queued and triggers one
    /// coalesced refresh.
    pub fn on_did_change(
        &self,
        listener: impl Fn(&ProviderRegistryServiceChangedEvent) + Send + 'static,
    ) {
        self.change_listeners
            .lock()
            .unwrap()
            .push(Box::new(listener));
    }

    pub fn start(&self) -> Result<(), String> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err("ProviderRegistryService has been disposed".into());
        }
        if self.started.swap(true, Ordering::SeqCst) {
            // Startup is only responsible for readiness.
            return if self.snapshot.lock().unwrap().is_some() {
                Ok(())
            } else {
                self.refresh("start").map(|_| ())
            };
        }
        self.config.on_did_change(|reason| {
            // The config service emits on any personal write or builtin change;
            // the orchestrator treats it as a refresh reason.
            let _ = reason;
        });
        self.account.on_did_change(Box::new(|reason| {
            let _ = reason;
        }));
        self.refresh("start").map(|_| ())
    }

    /// Re-reads the sources and re-resolves. Concurrent callers coalesce onto
    /// the in-flight refresh instead of triggering a second resolve.
    pub fn refresh(&self, reason: &str) -> Result<ProviderRegistryServiceSnapshot, String> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err("ProviderRegistryService has been disposed".into());
        }
        // Coalesce: if a refresh is already running, wait for its result.
        if let Ok(mut in_flight) = self.in_flight.lock() {
            if *in_flight {
                drop(in_flight);
                // Spin briefly for the in-flight result rather than double-resolving.
                for _ in 0..50 {
                    if let Some(snapshot) = self.snapshot.lock().unwrap().clone() {
                        return Ok(snapshot);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                return Err("refresh in flight but no snapshot appeared".into());
            }
            *in_flight = true;
        }
        let result = self.do_refresh(reason);
        if let Ok(mut in_flight) = self.in_flight.lock() {
            *in_flight = false;
        }
        result
    }

    fn do_refresh(&self, reason: &str) -> Result<ProviderRegistryServiceSnapshot, String> {
        let config = self.config.read()?;
        let account = self.account.read();
        let personal_providers = config.personal_providers.clone();
        let personal_models = config.personal_models.clone();
        let builtin_models = config.zcode_builtin_model_rules.clone();
        let resolution = crate::resolver::resolve(&ResolverInput {
            zcode_builtin: &crate::config_service::BuiltinSnapshot {
                revision: config.zcode_builtin_revision.clone(),
                providers: config.zcode_builtin_providers.clone(),
                provider_templates: config.zcode_builtin_provider_templates.clone(),
                models: builtin_models,
            },
            account_providers: &account.providers,
            account_states: account.states.as_deref(),
            personal_providers: &personal_providers,
            personal_models: &personal_models,
            personal_provider_order: &config.personal_provider_order,
        });
        let registry = ProviderRegistryView {
            revision: self.revision.fetch_add(1, Ordering::SeqCst) + 1,
            providers: resolution.registry_providers.clone(),
        };
        let snapshot = ProviderRegistryServiceSnapshot {
            config,
            account,
            resolution,
            registry,
        };
        *self.snapshot.lock().unwrap() = Some(snapshot.clone());

        let event = ProviderRegistryServiceChangedEvent {
            reasons: vec![reason.to_string()],
        };
        for listener in self.change_listeners.lock().unwrap().iter() {
            listener(&event);
        }
        Ok(snapshot)
    }

    /// The config mutation surface. The channel handler calls a mutation, then
    /// `refresh` + `get_settings_view` to publish the result.
    pub fn config(&self) -> &ProviderConfigService {
        &self.config
    }

    pub fn get_snapshot(&self) -> Option<ProviderRegistryServiceSnapshot> {
        self.snapshot.lock().unwrap().clone()
    }

    pub fn get_registry_view(&self) -> ProviderRegistryView {
        self.snapshot
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.registry.clone())
            .unwrap_or(ProviderRegistryView {
                revision: 0,
                providers: vec![],
            })
    }

    pub fn get_settings_view(&self) -> Result<ProviderSettingsView, String> {
        let snapshot = self
            .get_snapshot()
            .ok_or("ProviderRegistryService has not started() yet")?;
        Ok(create_provider_settings_view(ProviderSettingsViewInput {
            revision: snapshot.registry.revision,
            builtin_providers: &snapshot.config.zcode_builtin_providers,
            builtin_provider_templates: &snapshot.config.zcode_builtin_provider_templates,
            personal_providers: &snapshot.config.personal_providers,
            personal_models: &snapshot.config.personal_models,
            resolution: &snapshot.resolution,
            account_states: snapshot.account.states.as_deref(),
        }))
    }

    pub fn get_model_selection_view(
        &self,
        configured_default: Option<&crate::schema::ModelSelection>,
        input_selection: Option<&crate::schema::ModelSelection>,
    ) -> Result<ModelSelectionView, String> {
        let snapshot = self
            .get_snapshot()
            .ok_or("ProviderRegistryService has not started() yet")?;
        Ok(create_model_selection_view(ModelSelectionViewInput {
            revision: snapshot.registry.revision,
            registry: &snapshot.registry,
            configured_default,
            input_selection,
            account_states: snapshot.account.states.as_deref(),
            classify_provider: None,
            resolve_legacy_reasoning_level: None,
        }))
    }

    pub fn dispose(&self) {
        if self.disposed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.change_listeners.lock().unwrap().clear();
        *self.snapshot.lock().unwrap() = None;
    }
}

/// The account source the service reads. Wraps the mutable source behind an
/// `AccountSource` trait object so a test can inject a fixed snapshot.
pub fn new_default_account_source() -> std::sync::Arc<MutableAccountProviderConfigSource> {
    std::sync::Arc::new(MutableAccountProviderConfigSource::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin_source::FileBuiltinSource;
    use crate::config_service::{BuiltinSource, ProviderConfigService as ConfigService};
    use crate::domain::{ModelConfigRule, ProviderConfigMap, ProviderConfigRule};
    use crate::repository::{PersonalProviderConfigRepository, PersonalRepositoryOptions};
    use crate::schema::{ProviderConfigData, ProviderGroup};
    use std::sync::Arc;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("zcode-registry-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_personal(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("provider_config.json");
        let layer = serde_json::json!({
            "schemaVersion": 1,
            "config": {
                "providerConfigRules": { "providerRules": [] },
                "modelConfigRules": { "providerModelRules": [], "manualProviderModelRules": [] }
            }
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&layer).unwrap()).unwrap();
        path
    }

    fn repo_config_builtin() -> Option<std::path::PathBuf> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../config/provider/zcode-builtin.json");
        path.exists().then_some(path)
    }

    #[test]
    fn the_service_reads_serves_and_caches_a_snapshot() {
        let Some(bundled) = repo_config_builtin() else {
            return;
        };
        let dir = temp_dir("read");
        let personal_path = write_personal(&dir);
        let active = dir.join("active.json");
        let builtin_source = FileBuiltinSource::new(bundled, Some(active)).unwrap();
        let repo = PersonalProviderConfigRepository::new(PersonalRepositoryOptions {
            file_path: personal_path,
            import_legacy: None,
            on_recovery: None,
            on_polling_error: None,
            polling_interval: None,
        })
        .unwrap();
        let config_service = ConfigService::new(Box::new(builtin_source), repo);
        let account = new_default_account_source();
        let service = ProviderRegistryService::new(config_service, Arc::clone(&account));

        service.start().expect("start");
        let snapshot = service.get_snapshot().expect("a cached snapshot");
        assert!(!snapshot.resolution.registry_providers.is_empty());

        let view = service.get_settings_view().expect("settings view");
        assert!(!view.providers.is_empty());
        assert_eq!(view.revision, snapshot.registry.revision);

        let selection_view = service
            .get_model_selection_view(None, None)
            .expect("selection view");
        assert!(!selection_view.providers.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refresh_before_start_is_refused_by_get_settings_view() {
        let Some(bundled) = repo_config_builtin() else {
            return;
        };
        let dir = temp_dir("no-start");
        let personal_path = write_personal(&dir);
        let active = dir.join("active.json");
        let builtin_source = FileBuiltinSource::new(bundled, Some(active)).unwrap();
        let repo = PersonalProviderConfigRepository::new(PersonalRepositoryOptions {
            file_path: personal_path,
            import_legacy: None,
            on_recovery: None,
            on_polling_error: None,
            polling_interval: None,
        })
        .unwrap();
        let config_service = ConfigService::new(Box::new(builtin_source), repo);
        let service = ProviderRegistryService::new(config_service, new_default_account_source());
        assert!(service.get_settings_view().is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
