//! Personal Provider Config repository.
//!
//! Port of `NodePersonalProviderConfigRepository`
//! (`packages/provider-node/src/personal-provider-config-repository.ts`).
//!
//! # Single owner
//!
//! Every reader — poller, `read`, `update` — observes the same JSON document,
//! and every writer goes through `update` under the file lock. The poll loop is
//! the only second observer, and its revision CAS means it can never notify on
//! a state the owner already reported.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::schema::{
    decode_provider_config_file, encode_provider_config_file, ModelSelection, PersonalConfigLayer,
    PersonalModelConfigRulesData, PersonalProviderConfigRulesData,
};

/// The layer snapshot — content plus its revision, which is the CAS token the
/// runtime later passes to `savePersonalModelDraft`.
#[derive(Debug, Clone, PartialEq)]
pub struct LayerSnapshot {
    pub revision: String,
    pub providers: PersonalProviderConfigRulesData,
    pub models: PersonalModelConfigRulesData,
    pub provider_order: Option<Vec<String>>,
    pub default_model_selection: Option<ModelSelection>,
}

pub struct PersonalRepositoryOptions {
    pub file_path: PathBuf,
    /// One-shot legacy import used when the file does not exist yet.
    pub import_legacy: Option<Box<dyn Fn() -> Option<PersonalConfigLayer> + Send + Sync>>,
    pub on_recovery: Option<Box<dyn Fn(PersonalProviderConfigRecoveryEvent) + Send + Sync>>,
    pub on_polling_error: Option<Box<dyn Fn(PersonalProviderConfigRecoveryEvent) + Send + Sync>>,
    /// Polling interval, or `None` to disable the background poller (tests).
    pub polling_interval: Option<Duration>,
}

#[derive(Debug, Clone)]
pub struct PersonalProviderConfigRecoveryEvent {
    pub error: String,
}

struct Shared {
    file_path: PathBuf,
    import_legacy: Option<Box<dyn Fn() -> Option<PersonalConfigLayer> + Send + Sync>>,
    on_recovery: Option<Box<dyn Fn(PersonalProviderConfigRecoveryEvent) + Send + Sync>>,
    on_polling_error: Option<Box<dyn Fn(PersonalProviderConfigRecoveryEvent) + Send + Sync>>,
    listeners: Mutex<Vec<Box<dyn Fn(&str) + Send + Sync>>>,
    observed_revision: Mutex<Option<String>>,
    write_generation: AtomicU64,
    polling_error_active: AtomicBool,
    disposed: AtomicBool,
    poller_started: AtomicBool,
    wake: (Mutex<bool>, Condvar),
}

pub struct PersonalProviderConfigRepository {
    shared: Arc<Shared>,
    polling_interval: Option<Duration>,
}

impl PersonalProviderConfigRepository {
    pub fn new(options: PersonalRepositoryOptions) -> Result<Self, String> {
        if options.file_path.as_os_str().is_empty() {
            return Err("Personal Provider Config filePath must not be empty".into());
        }
        if let Some(interval) = options.polling_interval {
            if interval.is_zero() {
                return Err(
                    "Personal Provider Config pollingIntervalMs must be greater than 0".into(),
                );
            }
        }
        Ok(Self {
            shared: Arc::new(Shared {
                file_path: options.file_path,
                import_legacy: options.import_legacy,
                on_recovery: options.on_recovery,
                on_polling_error: options.on_polling_error,
                listeners: Mutex::new(Vec::new()),
                observed_revision: Mutex::new(None),
                write_generation: AtomicU64::new(0),
                polling_error_active: AtomicBool::new(false),
                disposed: AtomicBool::new(false),
                poller_started: AtomicBool::new(false),
                wake: (Mutex::new(false), Condvar::new()),
            }),
            polling_interval: options.polling_interval,
        })
    }

    pub fn read(&self) -> Result<LayerSnapshot, String> {
        self.assert_not_disposed()?;
        let result = match self.read_current() {
            Ok(snapshot) => snapshot,
            Err(error) => self.recover_invalid(error),
        };
        {
            let mut observed = self.shared.observed_revision.lock().unwrap();
            if observed.is_none() {
                *observed = Some(result.revision.clone());
            }
        }
        self.start_poller_once();
        Ok(result)
    }

    pub fn update(
        &self,
        transform: impl FnOnce(&LayerSnapshot) -> Result<PersonalConfigLayer, String>,
    ) -> Result<LayerSnapshot, String> {
        self.assert_not_disposed()?;
        let snapshot = zcode_private_file::with_file_lock(&self.shared.file_path, || {
            let current = self.read_locked()?;
            let next = match transform(&current) {
                Ok(next) => next,
                Err(error) => return Err(error),
            };
            let committed = self.write_locked(&next)?;
            let snapshot = snapshot_from_layer(&committed);
            // Record the written revision before the poller reads it back, so
            // the poller cannot emit a duplicate "changed" for our own write.
            *self.shared.observed_revision.lock().unwrap() = Some(snapshot.revision.clone());
            Ok(snapshot)
        })?;
        self.emit("updated");
        self.start_poller_once();
        Ok(snapshot)
    }

    pub fn on_did_change(&self, listener: impl Fn(&str) + Send + Sync + 'static) {
        self.shared
            .listeners
            .lock()
            .unwrap()
            .push(Box::new(listener));
    }

    pub fn dispose(&self) {
        if self.shared.disposed.swap(true, Ordering::SeqCst) {
            return;
        }
        *self.shared.wake.0.lock().unwrap() = true;
        self.shared.wake.1.notify_all();
        self.shared.listeners.lock().unwrap().clear();
    }

    // --- internals ---

    fn assert_not_disposed(&self) -> Result<(), String> {
        if self.shared.disposed.load(Ordering::SeqCst) {
            Err("PersonalProviderConfigRepository has been disposed".into())
        } else {
            Ok(())
        }
    }

    fn read_current(&self) -> Result<LayerSnapshot, String> {
        match read_json_file_if_exists(&self.shared.file_path) {
            None => {
                if self.shared.import_legacy.is_none() {
                    return Ok(snapshot_from_layer(&empty_layer()));
                }
                // The import normalises and writes, so it happens under the
                // lock after a re-read: another writer's content must never be
                // overwritten with what this process read before the lock.
                self.read_locked()
            }
            Some(Err(error)) => Err(error),
            Some(Ok(value)) => {
                let layer = decode_provider_config_file(&value).map_err(|e| e.to_string())?;
                if is_canonical(&value, &layer) {
                    return Ok(snapshot_from_layer(&layer));
                }
                zcode_private_file::with_file_lock(&self.shared.file_path, || self.read_locked())
            }
        }
    }

    fn read_locked(&self) -> Result<LayerSnapshot, String> {
        match read_json_file_if_exists(&self.shared.file_path) {
            None => {
                let Some(imported) = (self.shared.import_legacy)
                    .as_ref()
                    .and_then(|import| import())
                else {
                    return Ok(snapshot_from_layer(&empty_layer()));
                };
                let committed = self.write_locked(&imported)?;
                Ok(snapshot_from_layer(&committed))
            }
            Some(Err(error)) => Err(error),
            Some(Ok(value)) => {
                let layer = decode_provider_config_file(&value).map_err(|e| e.to_string())?;
                if !is_canonical(&value, &layer) {
                    let committed = self.write_locked(&layer)?;
                    return Ok(snapshot_from_layer(&committed));
                }
                Ok(snapshot_from_layer(&layer))
            }
        }
    }

    fn write_locked(&self, layer: &PersonalConfigLayer) -> Result<PersonalConfigLayer, String> {
        // Validate the entire layer before anything touches the disk; a bad
        // leaf must never land in the user's config file.
        let canonical = decode_provider_config_file(
            &serde_json::to_value(encode_provider_config_file(layer)).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        // TS parity: the file lands exactly as JSON.stringify(..., null, 2),
        // with no trailing newline; the revision CAS hashes the compact form.
        let bytes = serde_json::to_vec_pretty(&encode_provider_config_file(&canonical))
            .map_err(|e| e.to_string())?;
        zcode_private_file::atomic_write_private_text_file(
            &self.shared.file_path,
            std::str::from_utf8(&bytes).map_err(|e| e.to_string())?,
        )?;
        self.shared.write_generation.fetch_add(1, Ordering::SeqCst);
        Ok(canonical)
    }

    fn recover_invalid(&self, error: String) -> LayerSnapshot {
        // TS parity: the official file is left as-is; only the in-memory view
        // degrades to empty until the user repairs the file.
        if let Some(on_recovery) = &self.shared.on_recovery {
            on_recovery(PersonalProviderConfigRecoveryEvent { error });
        }
        snapshot_from_layer(&empty_layer())
    }

    fn emit(&self, reason: &str) {
        if self.shared.disposed.load(Ordering::SeqCst) {
            return;
        }
        for listener in self.shared.listeners.lock().unwrap().iter() {
            listener(reason);
        }
    }

    fn start_poller_once(&self) {
        let Some(interval) = self.polling_interval else {
            return;
        };
        if self.shared.disposed.load(Ordering::SeqCst)
            || self.shared.poller_started.swap(true, Ordering::SeqCst)
        {
            return;
        }
        let shared = Arc::clone(&self.shared);
        let interval_ms = interval.as_millis() as u64;
        std::thread::spawn(move || loop {
            {
                let (lock, cvar) = &shared.wake;
                let guard = lock.lock().unwrap();
                let (guard, _) = cvar
                    .wait_timeout_while(guard, Duration::from_millis(interval_ms), |woke| !*woke)
                    .unwrap();
                if *guard {
                    break;
                }
            }
            if shared.disposed.load(Ordering::SeqCst) {
                break;
            }
            poll_once(&shared);
        });
    }
}

fn poll_once(shared: &Shared) {
    let generation = shared.write_generation.load(Ordering::SeqCst);
    match read_json_file_if_exists(&shared.file_path) {
        None => {
            finish_poll(shared, generation, &snapshot_from_layer(&empty_layer()));
        }
        Some(Err(error)) => report_polling_error(shared, generation, error),
        Some(Ok(value)) => match decode_provider_config_file(&value) {
            Ok(layer) => finish_poll(shared, generation, &snapshot_from_layer(&layer)),
            Err(error) => report_polling_error(shared, generation, error.to_string()),
        },
    }
}

fn report_polling_error(shared: &Shared, generation: u64, error: String) {
    if shared.disposed.load(Ordering::SeqCst)
        || generation != shared.write_generation.load(Ordering::SeqCst)
    {
        return;
    }
    if !shared.polling_error_active.swap(true, Ordering::SeqCst) {
        if let Some(on_error) = &shared.on_polling_error {
            on_error(PersonalProviderConfigRecoveryEvent { error });
        }
        for listener in shared.listeners.lock().unwrap().iter() {
            listener("poll-error");
        }
    }
}

fn finish_poll(shared: &Shared, generation: u64, snapshot: &LayerSnapshot) {
    if generation != shared.write_generation.load(Ordering::SeqCst) {
        return;
    }
    shared.polling_error_active.store(false, Ordering::SeqCst);
    let changed = {
        let mut observed = shared.observed_revision.lock().unwrap();
        if observed.as_deref() == Some(snapshot.revision.as_str()) {
            false
        } else {
            *observed = Some(snapshot.revision.clone());
            true
        }
    };
    if changed && !shared.disposed.load(Ordering::SeqCst) {
        for listener in shared.listeners.lock().unwrap().iter() {
            listener("poll-changed");
        }
    }
}

fn is_canonical(value: &serde_json::Value, layer: &PersonalConfigLayer) -> bool {
    let canonical = match serde_json::to_value(encode_provider_config_file(layer)) {
        Ok(canonical) => canonical,
        Err(_) => return false,
    };
    serde_json::to_string(value).ok() == serde_json::to_string(&canonical).ok()
}

fn empty_layer() -> PersonalConfigLayer {
    PersonalConfigLayer {
        providers: PersonalProviderConfigRulesData {
            provider_rules: Vec::new(),
        },
        models: PersonalModelConfigRulesData {
            provider_model_rules: Vec::new(),
            manual_provider_model_rules: Vec::new(),
        },
        provider_order: None,
        default_model_selection: None,
    }
}

pub fn snapshot_from_layer(layer: &PersonalConfigLayer) -> LayerSnapshot {
    let content = serde_json::to_string(&encode_provider_config_file(layer))
        .expect("encode is infallible for a validated layer");
    LayerSnapshot {
        revision: hex_sha256(content.as_bytes()),
        providers: layer.providers.clone(),
        models: layer.models.clone(),
        provider_order: layer.provider_order.clone(),
        default_model_selection: layer.default_model_selection.clone(),
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_json_file_if_exists(path: &std::path::Path) -> Option<Result<serde_json::Value, String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            Some(serde_json::from_str(&text).map_err(|error| format!("invalid JSON: {error}")))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => Some(Err(error.to_string())),
    }
}
