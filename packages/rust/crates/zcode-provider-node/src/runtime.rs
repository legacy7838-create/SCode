//! `NodeProviderConfigRuntime` over the native boundary.
//!
//! The runtime owns the parts provider-node owned — the sources, the refresh
//! cadence, the periodic check task, and the start/stop order (spec §3.7). The
//! config service itself stays `@zcode/provider`'s TypeScript; the wrapper
//! composes it over the native repository and the native builtin snapshot,
//! both of which this class exposes.
//!
//! # Why the runtime also exposes the personal repository and the builtin
//! source
//!
//! `@zcode/provider`'s `ProviderConfigService` takes a `ProviderSource` and a
//! `PersonalProviderConfigRepository`. Those must be adapters over *this*
//! runtime's state — not over a second repository — or the service would read a
//! file through one owner while the runtime refreshed another. So the runtime
//! is the single owner and hands out read/update/subscribe against its own
//! repository, plus the builtin snapshot for the current endpoint.

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{AsyncTask, Promise};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Result, Status, Task};
use napi_derive::napi;

use zcode_provider_config::builtin_source::FileBuiltinSource;
use zcode_provider_config::runtime::{
    CheckListener, ProviderConfigRuntime, ProviderConfigRuntimeOptions, RuntimeBuiltinEnvironmentOptions,
    RuntimeRemoteOptions,
};
use zcode_provider_config::schema::BuiltinRelease;

use crate::json::{builtin_snapshot_to_json, snapshot_to_json, LayerUpdateJson};
use crate::repository::call_js_callback as call_js_string;

type RefreshFetchTsfn = ThreadsafeFunction<String, Promise<String>, String, Status, false, true>;
type EndpointResolverTsfn = ThreadsafeFunction<String, Promise<String>, String, Status, false, true>;
type ImportLegacyTsfn = ThreadsafeFunction<String, Promise<String>, String, Status, false, true>;
type ObserverTsfn = ThreadsafeFunction<String, (), String, Status, false, true>;
type CheckListenerTsfn = ThreadsafeFunction<String, Promise<String>, String, Status, false, true>;

type ObserverRegistry = Arc<Mutex<Vec<(u32, ObserverTsfn)>>>;
type CheckRegistry = Arc<Mutex<Vec<(u32, CheckListenerTsfn)>>>;

/// The options the wrapper assembles. Every callback is injected by the host;
/// this crate never provides a default implementation for one.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeOptionsJson {
    zcode_builtin_file_path: String,
    #[serde(default)]
    zcode_builtin_active_file_path: Option<String>,
    #[serde(default)]
    remote: Option<RemoteJson>,
    #[serde(default)]
    environment: Option<EnvironmentJson>,
    #[serde(default)]
    personal_file_path: String,
    #[serde(default)]
    personal_polling_interval_ms: Option<f64>,
    #[serde(default)]
    watch: Option<bool>,
    #[serde(default)]
    success_interval_ms: Option<f64>,
    #[serde(default)]
    lease_duration_ms: Option<f64>,
    #[serde(default)]
    failure_base_delay_ms: Option<f64>,
    #[serde(default)]
    failure_max_delay_ms: Option<f64>,
}

/// Data only: napi's `ThreadsafeFunction` cannot be a serde field, so every
/// injected callback is a separate constructor argument.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RemoteJson {
    control_file_path: String,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EnvironmentJson {
    environment_config_root: String,
    platform: String,
    app_version: String,
}

#[napi]
pub struct NativeProviderConfigRuntime {
    runtime: Arc<ProviderConfigRuntime>,
    /// Kept for the plain-source case so the wrapper can read the builtin
    /// snapshot through the same owner the synchronizer writes through.
    builtin_snapshot: BuiltinSnapshotSource,
    observers: ObserverRegistry,
    checks: CheckRegistry,
    next_id: Arc<Mutex<u32>>,
    listeners_registered: Arc<Mutex<bool>>,
}

/// How the builtin snapshot is read for the config service.
#[derive(Clone)]
enum BuiltinSnapshotSource {
    /// A plain source owned by the runtime (it exposes it directly).
    Plain(Arc<FileBuiltinSource>),
    /// Endpoint-scoped: the runtime resolves the endpoint, then reads.
    EndpointScoped,
}

impl BuiltinSnapshotSource {
    fn read(&self, runtime: &ProviderConfigRuntime) -> std::result::Result<String, String> {
        match self {
            BuiltinSnapshotSource::Plain(source) => {
                let release = source.read_release()?;
                builtin_snapshot_to_json(
                    format!(
                        "zcode-builtin:{}:{}",
                        release.revision,
                        zcode_provider_config::schema::source_key_for_active_path(
                            source.active_file_path()
                        )
                    ),
                    &release,
                )
            }
            BuiltinSnapshotSource::EndpointScoped => {
                let active = runtime.resolve_zcode_builtin_active_file_path()?;
                let release: BuiltinRelease = {
                    let bytes = std::fs::read(&active)
                        .map_err(|error| format!("cannot read the Active release: {error}"))?;
                    let value: serde_json::Value = serde_json::from_slice(&bytes)
                        .map_err(|error| format!("the Active release is not JSON: {error}"))?;
                    zcode_provider_config::schema::decode_builtin_release(&value)
                        .map_err(|error| error.to_string())?
                };
                builtin_snapshot_to_json(
                    format!(
                        "zcode-builtin:{}:{}",
                        release.revision,
                        zcode_provider_config::schema::source_key_for_active_path(&active)
                    ),
                    &release,
                )
            }
        }
    }
}

#[napi]
impl NativeProviderConfigRuntime {
    #[napi(constructor)]
    pub fn new(
        options_json: String,
        import_legacy: Option<ImportLegacyTsfn>,
        resolve_endpoint_key: Option<EndpointResolverTsfn>,
        resolve_endpoint_origin: Option<EndpointResolverTsfn>,
        fetch_release: Option<RefreshFetchTsfn>,
        on_remote_refresh_error: Option<ObserverTsfn>,
        on_personal_recovery: Option<ObserverTsfn>,
        on_personal_polling_error: Option<ObserverTsfn>,
        on_refresh_result: Option<ObserverTsfn>,
    ) -> Result<Self> {
        let options: RuntimeOptionsJson = serde_json::from_str(&options_json)
            .map_err(|error| napi::Error::new(Status::InvalidArg, error.to_string()))?;

        // Every injected JS callback becomes a blocking-boundary bridge: the
        // runtime runs on its own threads, so a callback is invoked and its
        // promise driven to completion from that thread.
        let resolve_endpoint_key = Arc::new(Mutex::new(resolve_endpoint_key));
        let fetch_release = Arc::new(Mutex::new(fetch_release));
        let remote = options.remote.map(|remote| RuntimeRemoteOptions {
            control_file_path: std::path::PathBuf::from(remote.control_file_path),
            resolve_endpoint_key: Arc::new({
                let slot = Arc::clone(&resolve_endpoint_key);
                move || {
                    // The host injected the resolver; there is no Rust default
                    // for it, because the Endpoint is the Environment's fact.
                    // It is borrowed per call, not consumed: the lease re-checks
                    // it after every network round.
                    let slot = slot.lock().unwrap();
                    let callback = slot
                        .as_ref()
                        .ok_or("no endpoint resolver was injected".to_string())?;
                    match call_js_string(callback, String::new()) {
                        Ok(Ok(Some(value))) => Ok(value),
                        Ok(Ok(None)) => Err("the endpoint resolver answered nothing".to_string()),
                        _ => Err("the endpoint resolver could not be invoked".into()),
                    }
                }
            }),
            fetch_release: Arc::new({
                let slot = Arc::clone(&fetch_release);
                move |_endpoint_key: &str| {
                    // A failed fetch is the synchronizer's failure path: it
                    // applies the backoff and reports through the observer, so
                    // this answers "no release" rather than raising.
                    let slot = slot.lock().unwrap();
                    let Some(callback) = slot.as_ref() else {
                        return Ok(None);
                    };
                    let release = match call_js_string(callback, String::new()) {
                        Ok(Ok(Some(json))) if json != "null" => {
                            crate::json::decode_release_json(&json).ok()
                        }
                        _ => None,
                    };
                    Ok(release)
                }
            }),
            on_refresh_result: on_refresh_result.map(|callback| {
                Arc::new(move |event: &zcode_provider_config::remote_sync::ZCodeBuiltinRefreshEvent| {
                    let payload = serde_json::json!({
                        "result": event.result,
                        "reason": event.reason.map(|reason| match reason {
                            zcode_provider_config::remote_sync::SkipReason::LeaseHeld => "lease-held",
                            zcode_provider_config::remote_sync::SkipReason::NotDue => "not-due",
                            zcode_provider_config::remote_sync::SkipReason::EndpointChanged => "endpoint-changed",
                        }),
                        "revision": event.revision,
                    });
                    let _ = callback.call(
                        payload.to_string(),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }) as zcode_provider_config::runtime::OnRefreshResult
            }),
            success_interval_ms: options.success_interval_ms.map(|value| value as u64),
            lease_duration_ms: options.lease_duration_ms.map(|value| value as u64),
            failure_base_delay_ms: options.failure_base_delay_ms.map(|value| value as u64),
            failure_max_delay_ms: options.failure_max_delay_ms.map(|value| value as u64),
        });

        let environment = options.environment.map(|environment| RuntimeBuiltinEnvironmentOptions {
            environment_config_root: std::path::PathBuf::from(environment.environment_config_root),
            platform: environment.platform,
            app_version: environment.app_version,
            resolve_endpoint_origin: Arc::new({
                let slot = Arc::new(Mutex::new(resolve_endpoint_origin));
                move || {
                    let slot = slot.lock().unwrap();
                    let callback = slot
                        .as_ref()
                        .ok_or("no endpoint resolver was injected".to_string())?;
                    match call_js_string(callback, String::new()) {
                        Ok(Ok(Some(value))) => Ok(value),
                        Ok(Ok(None)) => Err("the endpoint resolver answered nothing".to_string()),
                        // Either the callback failed or none was injected; both
                        // are "the Environment could not name its Endpoint".
                        _ => Err("the endpoint resolver could not be invoked".to_string()),
                    }
                }
            }),
        });

        // One runtime, one repository, one builtin source: the napi layer
        // passes the callbacks into the rlib instead of building a second
        // owner beside it.
        let observers: ObserverRegistry = Arc::new(Mutex::new(Vec::new()));
        let runtime = ProviderConfigRuntime::new(ProviderConfigRuntimeOptions {
            zcode_builtin_file_path: std::path::PathBuf::from(&options.zcode_builtin_file_path),
            zcode_builtin_active_file_path: options
                .zcode_builtin_active_file_path
                .as_ref()
                .map(std::path::PathBuf::from),
            remote,
            environment,
            on_remote_refresh_error: on_remote_refresh_error
                .map(crate::repository::observer_string_closure),
            on_personal_recovery: on_personal_recovery.map(
                crate::repository::observer_string_closure,
            ),
            on_personal_polling_error: on_personal_polling_error
                .map(crate::repository::observer_string_closure),
            personal_file_path: std::path::PathBuf::from(&options.personal_file_path),
            personal_polling_interval_ms: options
                .personal_polling_interval_ms
                .map(|ms| ms as u64),
            // The import receives the current builtin snapshot from the rlib,
            // exactly as the TS runtime passed `await builtinSource.read()`.
            import_legacy: import_legacy.map(|callback| {
                Arc::new(move |snapshot: Option<String>| {
                    let slot = call_js_string(&callback, snapshot.unwrap_or_default());
                    match slot {
                        Ok(Ok(Some(answered))) => Ok(Some(answered)),
                        // A rejected or unusable import is not a read failure:
                        // the file stays absent and the repository stays empty.
                        _ => Ok(None),
                    }
                })
                    as zcode_provider_config::runtime::ImportLegacy
            }),
            watch: options.watch.unwrap_or(true),
        })
        .map_err(|error| napi::Error::new(Status::GenericFailure, error))?;

        // Both sources fan into the one registry; the wrapper dispatches by
        // reason so a personal subscriber never sees a builtin reason.
        {
            let listeners = Arc::clone(&observers);
            runtime.personal_repository().on_did_change(Box::new(
                move |reason: &str| fan_out(&listeners, reason),
            ));
            let listeners = Arc::clone(&observers);
            runtime.on_builtin_did_change(Box::new(move |reason: &str| {
                fan_out(&listeners, reason)
            }));
        }

        let builtin_snapshot = match runtime.builtin_kind() {
            zcode_provider_config::endpoint_scoped::EndpointScopedSourceKind::EndpointScoped => {
                BuiltinSnapshotSource::EndpointScoped
            }
            zcode_provider_config::endpoint_scoped::EndpointScopedSourceKind::Plain => {
                BuiltinSnapshotSource::Plain(Arc::new(runtime.plain_builtin_source().ok_or_else(|| {
                    napi::Error::new(
                        Status::GenericFailure,
                        "the runtime has no plain builtin source to read",
                    )
                })?))
            }
        };

        let runtime = Arc::new(runtime);
        let checks: CheckRegistry = Arc::new(Mutex::new(Vec::new()));
        let listeners_registered = Arc::new(Mutex::new(false));

        Ok(Self {
            runtime,
            builtin_snapshot,
            observers,
            checks,
            next_id: Arc::new(Mutex::new(1)),
            listeners_registered,
        })
    }

    /// The builtin snapshot for the config service: `{ revision, release }`.
    #[napi]
    pub fn read_builtin_snapshot(&self) -> AsyncTask<AsyncBuiltinSnapshot> {
        AsyncTask::new(AsyncBuiltinSnapshot {
            runtime: Arc::clone(&self.runtime),
            source: self.builtin_snapshot.clone(),
        })
    }

    /// `start()`. The config service's first read belongs to the caller (the
    /// TS runtime read through its own service before arming checks); this arms
    /// the background work.
    #[napi]
    pub fn start(&self) -> Result<()> {
        self.register_listeners_once()?;
        self.runtime.start().map_err(napi_error)
    }

    #[napi]
    pub fn refresh_zcode_builtin(&self, force: Option<bool>) -> AsyncTask<AsyncRefresh> {
        AsyncTask::new(AsyncRefresh {
            runtime: Arc::clone(&self.runtime),
            force: force.unwrap_or(false),
        })
    }

    #[napi]
    pub fn resolve_zcode_builtin_active_file_path(&self) -> AsyncTask<AsyncActivePath> {
        AsyncTask::new(AsyncActivePath {
            runtime: Arc::clone(&self.runtime),
        })
    }

    /// Personal-repository access for the wrapper's adapter. Reads and updates
    /// go through the runtime's own repository, so there is one owner.
    #[napi]
    pub fn read_personal_snapshot(&self) -> AsyncTask<AsyncReadPersonal> {
        AsyncTask::new(AsyncReadPersonal {
            runtime: Arc::clone(&self.runtime),
        })
    }

    #[napi]
    pub fn update_personal(
        &self,
        transform: ThreadsafeFunction<String, Promise<String>, String, Status, false, true>,
    ) -> AsyncTask<AsyncUpdatePersonal> {
        AsyncTask::new(AsyncUpdatePersonal {
            runtime: Arc::clone(&self.runtime),
            transform,
        })
    }

    #[napi]
    pub fn save_configured_default(&self, selection_json: Option<String>) -> AsyncTask<AsyncSaveDefault> {
        AsyncTask::new(AsyncSaveDefault {
            runtime: Arc::clone(&self.runtime),
            selection: selection_json,
        })
    }

    /// Config-service change events, forwarded from the personal repository's
    /// own listener (`updated`, `poll-changed`, `poll-error`) and the builtin
    /// source's (`remote-updated`, `file-changed`, `watch-error`).
    #[napi]
    pub fn subscribe(&self, listener: ObserverTsfn) -> u32 {
        let id = self.next_id();
        self.observers.lock().unwrap().push((id, listener));
        id
    }

    #[napi]
    pub fn unsubscribe(&self, id: u32) {
        self.observers
            .lock()
            .unwrap()
            .retain(|(listener_id, _)| *listener_id != id);
    }

    /// Registers a periodic check listener. It returns nothing: the round's
    /// result reaches the observer as an error string, like the TS
    /// `Promise.allSettled` fan-out.
    #[napi]
    pub fn on_did_check_zcode_builtin(&self, listener: CheckListenerTsfn) -> u32 {
        let id = self.next_id();
        self.checks.lock().unwrap().push((id, listener));
        let checks: CheckRegistry = Arc::clone(&self.checks);
        let check: CheckListener = Arc::new(move || {
            let listeners = checks.lock().unwrap();
            for (_, listener) in listeners.iter() {
                // A listener that could not be invoked is a failed round for
                // that listener, not a stopped task: the observer reports it.
                match call_js_string(listener, String::new()) {
                    Ok(Ok(Some(error))) if error != "null" => return Err(error),
                    Ok(_) => {}
                    Err(error) => {
                        return Err(format!(
                            "the check listener could not be invoked: {}",
                            error.reason
                        ))
                    }
                }
            }
            Ok(())
        });
        self.runtime.on_did_check_zcode_builtin(check);
        id
    }

    #[napi]
    pub fn dispose(&self) {
        self.observers.lock().unwrap().clear();
        self.checks.lock().unwrap().clear();
        self.runtime.dispose();
    }

    fn next_id(&self) -> u32 {
        let mut next = self.next_id.lock().unwrap();
        let id = *next;
        *next += 1;
        id
    }

    /// The repository and the builtin source each own a listener list; the
    /// runtime registers one fan-out for both, once.
    fn register_listeners_once(&self) -> Result<()> {
        let mut registered = self.listeners_registered.lock().unwrap();
        if *registered {
            return Ok(());
        }
        *registered = true;
        Ok(())
    }
}

/// Dispatches one change reason to every wrapper subscription. The wrappers'
/// listener registry is the single fan-out target for both sources.
fn fan_out(listeners: &ObserverRegistry, reason: &str) {
    let reason = reason.to_string();
    for (_, listener) in listeners.lock().unwrap().iter() {
        let _ = listener.call(reason.clone(), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

fn napi_error(error: String) -> napi::Error {
    napi::Error::new(Status::GenericFailure, error)
}

// ---------------------------------------------------------------------------
// Async tasks
// ---------------------------------------------------------------------------

pub struct AsyncBuiltinSnapshot {
    runtime: Arc<ProviderConfigRuntime>,
    source: BuiltinSnapshotSource,
}

impl Task for AsyncBuiltinSnapshot {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        self.source.read(&self.runtime).map_err(napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct AsyncRefresh {
    runtime: Arc<ProviderConfigRuntime>,
    force: bool,
}

impl Task for AsyncRefresh {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        self.runtime
            .refresh_zcode_builtin(self.force)
            .map(|result| result.to_string())
            .map_err(napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct AsyncActivePath {
    runtime: Arc<ProviderConfigRuntime>,
}

impl Task for AsyncActivePath {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        self.runtime
            .resolve_zcode_builtin_active_file_path()
            .map(|path| path.to_string_lossy().to_string())
            .map_err(napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct AsyncReadPersonal {
    runtime: Arc<ProviderConfigRuntime>,
}

impl Task for AsyncReadPersonal {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let snapshot = self.runtime.personal_repository().read().map_err(napi_error)?;
        snapshot_to_json(&snapshot).map_err(napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct AsyncUpdatePersonal {
    runtime: Arc<ProviderConfigRuntime>,
    transform: ThreadsafeFunction<String, Promise<String>, String, Status, false, true>,
}

impl Task for AsyncUpdatePersonal {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let transform = &self.transform;
        let snapshot = self
            .runtime
            .personal_repository()
            .update(|current| {
                let current_json = snapshot_to_json(current)?;
                let answered = match call_js_string(transform, current_json) {
                    Ok(Ok(Some(answered))) => answered,
                    Ok(Ok(None)) => {
                        return Err("the update transform answered nothing".to_string())
                    }
                    Ok(Err(error)) => return Err(error),
                    Err(error) => {
                        return Err(format!(
                            "the update transform could not be invoked: {}",
                            error.reason
                        ))
                    }
                };
                let update: LayerUpdateJson = serde_json::from_str(&answered).map_err(|error| {
                    format!("the update transform answered invalid JSON: {error}")
                })?;
                crate::json::update_to_layer(&update)
            })
            .map_err(napi_error)?;
        snapshot_to_json(&snapshot).map_err(napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct AsyncSaveDefault {
    runtime: Arc<ProviderConfigRuntime>,
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
            .map_err(napi_error)?;
        let repository = self.runtime.personal_repository();
        let snapshot = repository
            .update(move |current| {
                Ok(zcode_provider_config::schema::PersonalConfigLayer {
                    providers: current.providers.clone(),
                    models: current.models.clone(),
                    provider_order: current.provider_order.clone(),
                    default_model_selection: selection.clone(),
                })
            })
            .map_err(napi_error)?;
        snapshot_to_json(&snapshot).map_err(napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
