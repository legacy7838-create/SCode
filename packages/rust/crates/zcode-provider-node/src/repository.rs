//! `NodePersonalProviderConfigRepository` over the native boundary.
//!
//! Spec: docs/specs/rust-native-provider-node.md §3.8/§3.9.
//!
//! # The lock and the callback
//!
//! `update(transform)` is the one place a JS callback runs *inside* the file
//! lock, and that is deliberate: the transform must see the locked current
//! content, and its answer must be validated before anything touches the disk,
//! or two writers would lose an update. The task runs on a blocking thread and
//! drives the JS promise to completion from there — the JS main thread executes
//! the callback, so no deadlock is possible.
//!
//! The callback receives the current snapshot JSON and answers the update JSON;
//! the answer is decoded through the strict file shape and canonically
//! re-encoded before the write, exactly as the deleted TS `#writeLocked` did.

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{AsyncTask, Promise};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Result, Status, Task};
use napi_derive::napi;

use zcode_provider_config::repository::{
    PersonalProviderConfigRepository, PersonalRepositoryOptions,
};
use zcode_provider_config::schema::PersonalConfigLayer;

use crate::json::{snapshot_to_json, update_to_layer, LayerUpdateJson};

/// `(current snapshot JSON) => Promise<update JSON | null>`. `null` cancels the
/// update, as a transform returning nothing did in TS.
type TransformTsfn = ThreadsafeFunction<String, Promise<String>, String, Status, false, true>;

/// `(builtin release JSON | "") => Promise<import JSON | null>`.
type ImportLegacyTsfn = ThreadsafeFunction<String, Promise<String>, String, Status, false, true>;

/// A reason or an error message, delivered as one string.
type ObserverTsfn = ThreadsafeFunction<String, (), String, Status, false, true>;

type ListenerRegistry = Arc<Mutex<Vec<(u32, ObserverTsfn)>>>;

/// TSFN is not `Clone` (napi 3.13), so anything that must outlive its call site
/// is stored behind a lock and used by reference. One entry per subscription.

#[napi]
pub struct NativePersonalProviderConfigRepository {
    repository: Arc<PersonalProviderConfigRepository>,
    listeners: ListenerRegistry,
    next_listener_id: Arc<Mutex<u32>>,
}

#[napi]
impl NativePersonalProviderConfigRepository {
    /// `pollingIntervalMs: null` disables the background poller — the CLI's
    /// login path writes once and exits, and it passed `false` in TS.
    #[napi(constructor)]
    pub fn new(
        file_path: String,
        polling_interval_ms: Option<f64>,
        import_legacy: Option<ImportLegacyTsfn>,
        on_recovery: Option<ObserverTsfn>,
        on_polling_error: Option<ObserverTsfn>,
    ) -> Result<Self> {
        let listeners: ListenerRegistry = Arc::new(Mutex::new(Vec::new()));
        let polling_interval = match polling_interval_ms {
            Some(ms) => Some(std::time::Duration::from_millis(ms.max(0.0) as u64)),
            None => Some(std::time::Duration::from_secs(1)),
        };
        if polling_interval == Some(std::time::Duration::ZERO) {
            return Err(napi::Error::new(
                Status::InvalidArg,
                "Personal Provider Config pollingIntervalMs must be greater than 0",
            ));
        }
        let import_legacy = Arc::new(Mutex::new(import_legacy));
        let recovery_sink = on_recovery;
        let polling_sink = on_polling_error;
        let repository = PersonalProviderConfigRepository::new(PersonalRepositoryOptions {
            file_path: std::path::PathBuf::from(file_path),
            // The import runs while the file is missing, inside the lock, and
            // answers the file form — decoded here by the strict decoder.
            import_legacy: Some({
                let import_legacy = Arc::clone(&import_legacy);
                Box::new(move || {
                    let slot = import_legacy.lock().unwrap();
                    let callback = slot.as_ref()?;
                    // A callback that could not be invoked, or that rejected,
                    // leaves the file absent: the import is a one-shot, and a
                    // failure is not a read failure.
                    let answered = match call_js_callback(callback, String::new()) {
                        Ok(Ok(Some(answered))) => answered,
                        _ => return None,
                    };
                    let update: LayerUpdateJson = serde_json::from_str(&answered).ok()?;
                    update_to_layer(&update).ok()
                })
            }),
            on_recovery: recovery_sink.map(observer_closure),
            on_polling_error: polling_sink.map(observer_closure),
            polling_interval,
        })
        .map_err(to_napi_error)?;

        // One native listener fans out to every wrapper subscription, so an
        // unsubscribe never has to reach back into the repository.
        let fanout: ListenerRegistry = Arc::clone(&listeners);
        repository.on_did_change(move |reason: &str| {
            let reason = reason.to_string();
            for (_, listener) in fanout.lock().unwrap().iter() {
                let _ = listener.call(reason.clone(), ThreadsafeFunctionCallMode::NonBlocking);
            }
        });

        Ok(Self {
            repository: Arc::new(repository),
            listeners,
            next_listener_id: Arc::new(Mutex::new(1)),
        })
    }

    #[napi]
    pub fn read(&self) -> AsyncTask<AsyncRead> {
        AsyncTask::new(AsyncRead {
            repository: Arc::clone(&self.repository),
        })
    }

    #[napi]
    pub fn update(&self, transform: TransformTsfn) -> AsyncTask<AsyncUpdate> {
        AsyncTask::new(AsyncUpdate {
            repository: Arc::clone(&self.repository),
            transform,
        })
    }

    /// The default selection is one field of the personal file, so the
    /// transform that sets it runs natively — no layer round-trip through JS.
    #[napi]
    pub fn save_configured_default(
        &self,
        selection_json: Option<String>,
    ) -> AsyncTask<AsyncSaveDefault> {
        AsyncTask::new(AsyncSaveDefault {
            repository: Arc::clone(&self.repository),
            selection: selection_json,
        })
    }

    /// Registers a change observer; the returned id is the unsubscribe handle.
    #[napi]
    pub fn subscribe(&self, listener: ObserverTsfn) -> u32 {
        let mut next = self.next_listener_id.lock().unwrap();
        let id = *next;
        *next += 1;
        self.listeners.lock().unwrap().push((id, listener));
        id
    }

    #[napi]
    pub fn unsubscribe(&self, id: u32) {
        self.listeners
            .lock()
            .unwrap()
            .retain(|(listener_id, _)| *listener_id != id);
    }

    #[napi]
    pub fn dispose(&self) {
        self.listeners.lock().unwrap().clear();
        self.repository.dispose();
    }
}

/// Bridges a repository event to one JS observer. A dead observer must not stop
/// the repository from notifying the others, so the call result is ignored —
/// the same reason the TS `#report` swallowed observer errors.
fn observer_closure(
    sink: ObserverTsfn,
) -> Box<dyn Fn(zcode_provider_config::repository::PersonalProviderConfigRecoveryEvent) + Send + Sync>
{
    Box::new(move |event: zcode_provider_config::repository::PersonalProviderConfigRecoveryEvent| {
        let _ = sink.call(event.error, ThreadsafeFunctionCallMode::NonBlocking);
    })
}

/// Calls a JS callback and waits for its answer. Used from a blocking thread
/// (never the JS thread); the JS main thread runs the callback and settles its
/// promise, so driving it here cannot deadlock.
pub fn call_js_callback(
    callback: &TransformTsfn,
    argument: String,
) -> napi::Result<std::result::Result<Option<String>, String>> {
    match napi::bindgen_prelude::block_on(callback.call_async(argument)) {
        Ok(promise) => match napi::bindgen_prelude::block_on(promise) {
                    Ok(answer) => {
                if answer.trim().is_empty() {
                    Ok(Ok(None))
                } else {
                    Ok(Ok(Some(answer)))
                }
            }
            Err(error) => Ok(Err(format!("the injected callback rejected: {}", error.reason))),
        },
        Err(error) => Ok(Err(format!(
            "the injected callback could not be invoked: {}",
            error.reason
        ))),
    }
}

/// The repository's recovery/polling observer bridge, for the runtime which
/// builds its own repository.
pub fn observer_closure_public(
    sink: ObserverTsfn,
) -> Box<dyn Fn(zcode_provider_config::repository::PersonalProviderConfigRecoveryEvent) + Send + Sync>
{
    observer_closure(sink)
}

/// The same bridge for a plain string observer (refresh errors).
pub fn observer_string_closure(sink: ObserverTsfn) -> zcode_provider_config::runtime::OnRefreshError {
    Arc::new(move |message: &str| {
        let _ = sink.call(message.to_string(), ThreadsafeFunctionCallMode::NonBlocking);
    })
}

/// The `Err(_)` arm's value: the callback could not be invoked at all.
fn error_or_default() -> String {
    "the injected callback could not be invoked".to_string()
}

fn to_napi_error(error: String) -> napi::Error {
    napi::Error::new(Status::GenericFailure, error)
}

// ---------------------------------------------------------------------------
// Async tasks
// ---------------------------------------------------------------------------

pub struct AsyncRead {
    repository: Arc<PersonalProviderConfigRepository>,
}

impl Task for AsyncRead {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let snapshot = self.repository.read().map_err(to_napi_error)?;
        snapshot_to_json(&snapshot).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct AsyncUpdate {
    repository: Arc<PersonalProviderConfigRepository>,
    transform: TransformTsfn,
}

impl Task for AsyncUpdate {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let transform = &self.transform;
        let snapshot = self
            .repository
            .update(|current| {
                let current_json = snapshot_to_json(current)?;
                let answered = match call_js_callback(transform, current_json) {
                    Ok(Ok(Some(answered))) => answered,
                    Ok(Ok(None)) => return Err("the update transform answered nothing".to_string()),
                    Ok(Err(error)) => return Err(error),
                    Err(_) => return Err(error_or_default()),
                };
                let update: LayerUpdateJson = serde_json::from_str(&answered)
                    .map_err(|error| format!("the update transform answered invalid JSON: {error}"))?;
                update_to_layer(&update)
            })
            .map_err(to_napi_error)?;
        snapshot_to_json(&snapshot).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct AsyncSaveDefault {
    repository: Arc<PersonalProviderConfigRepository>,
    selection: Option<String>,
}

impl Task for AsyncSaveDefault {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let selection = self
            .selection
            .as_deref()
            .map(|json| {
                serde_json::from_str::<zcode_provider_config::schema::ModelSelection>(json)
                    .map_err(|error| format!("invalid model selection: {error}"))
            })
            .transpose()
            .map_err(to_napi_error)?;
        let repository = Arc::clone(&self.repository);
        let snapshot = repository
            .update(move |current| {
                // One field changes; the rest of the locked layer is carried
                // through untouched, and the repository validates the whole
                // result before the write.
                Ok(PersonalConfigLayer {
                    providers: current.providers.clone(),
                    models: current.models.clone(),
                    provider_order: current.provider_order.clone(),
                    default_model_selection: selection.clone(),
                })
            })
            .map_err(to_napi_error)?;
        snapshot_to_json(&snapshot).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
