//! ZCode Built-in / Personal Config runtime boundary.
//!
//! Rust port of `provider-config-runtime.ts`
//! (`packages/provider-node/src/provider-config-runtime.ts`): the assembly and
//! lifecycle shared inside one process. The config *service* stays with
//! `@zcode/provider`'s TypeScript `ProviderConfigService` (spec §2) — this type
//! owns what provider-node owned: the sources, the refresh cadence, the
//! periodic check task, and the start/stop order.
//!
//! # Ownership
//!
//! One runtime per config-file pair. `start` is single-flight, the check task is
//! one per runtime and coalesces concurrent rounds, and `dispose` stops the
//! task, the synchronizer and the sources before the config service releases.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::builtin_source::FileBuiltinSource;
use crate::endpoint_scoped::{
    EndpointScopedBuiltinSource, EndpointScopedOptions, EndpointScopedSourceKind,
};
use crate::remote_sync::{
    RemoteSynchronizerOptions, ZCodeBuiltinRefreshEvent, ZCodeBuiltinRefreshResult,
    ZCodeBuiltinRemoteSynchronizer, REFRESH_DISPOSED, REFRESH_SKIPPED,
};
use crate::repository::{PersonalProviderConfigRepository, PersonalRepositoryOptions};

/// The 60 s periodic check cadence (TS `setInterval(..., 60_000)`).
pub const CHECK_INTERVAL: Duration = Duration::from_secs(60);

pub type ResolveEndpointKey = Arc<dyn Fn() -> Result<String, String> + Send + Sync>;
pub type FetchRelease =
    Arc<dyn Fn(&str) -> Result<Option<crate::schema::BuiltinRelease>, String> + Send + Sync>;
pub type OnRefreshResult = Arc<dyn Fn(&ZCodeBuiltinRefreshEvent) + Send + Sync>;
/// The one-shot legacy import. It receives the current builtin release encoded
/// as its file JSON, like the TS `importLegacy(await builtin.read())`.
pub type ImportLegacy = Arc<dyn Fn(Option<String>) -> Result<Option<String>, String> + Send + Sync>;
pub type OnRefreshError = Arc<dyn Fn(&str) + Send + Sync>;
/// A periodic-check listener: re-reads the config and does whatever the host
/// needs (services refresh the account overlay; the CLI re-checks credentials).
pub type CheckListener = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

/// `zcodeBuiltinRemote` — the shared control file plus the network edge.
pub struct RuntimeRemoteOptions {
    pub control_file_path: PathBuf,
    pub resolve_endpoint_key: ResolveEndpointKey,
    pub fetch_release: FetchRelease,
    pub on_refresh_result: Option<OnRefreshResult>,
    pub success_interval_ms: Option<u64>,
    pub lease_duration_ms: Option<u64>,
    pub failure_base_delay_ms: Option<u64>,
    pub failure_max_delay_ms: Option<u64>,
}

/// `zcodeBuiltinEnvironment` — the endpoint decides the cache paths itself.
pub struct RuntimeBuiltinEnvironmentOptions {
    pub environment_config_root: PathBuf,
    pub platform: String,
    pub app_version: String,
    pub resolve_endpoint_origin: Arc<dyn Fn() -> Result<String, String> + Send + Sync>,
}

pub struct ProviderConfigRuntimeOptions {
    pub zcode_builtin_file_path: PathBuf,
    pub zcode_builtin_active_file_path: Option<PathBuf>,
    pub remote: Option<RuntimeRemoteOptions>,
    pub environment: Option<RuntimeBuiltinEnvironmentOptions>,
    pub on_remote_refresh_error: Option<OnRefreshError>,
    pub on_personal_recovery: Option<OnRefreshError>,
    pub on_personal_polling_error: Option<OnRefreshError>,
    pub personal_file_path: PathBuf,
    pub personal_polling_interval_ms: Option<u64>,
    pub import_legacy: Option<ImportLegacy>,
    pub watch: bool,
}

enum Builtin {
    Plain {
        source: FileBuiltinSource,
        synchronizer: Option<Arc<ZCodeBuiltinRemoteSynchronizer>>,
        active_file_path: PathBuf,
    },
    EndpointScoped(Arc<EndpointScopedBuiltinSource>),
}

impl Builtin {
    /// The builtin snapshot as the wrapper rehydrates it: `{ revision, release }`.
    fn snapshot_json(&self) -> Option<String> {
        match self {
            Builtin::Plain { source, .. } => {
                let release = source.read_release().ok()?;
                let revision = format!(
                    "zcode-builtin:{}:{}",
                    release.revision,
                    crate::schema::source_key_for_active_path(source.active_file_path())
                );
                crate::builtin_snapshot_wire(&revision, &release).ok()
            }
            Builtin::EndpointScoped(source) => {
                let release = source.current_release()?;
                let active = source.resolve_active_file_path().ok()?;
                let revision = format!(
                    "zcode-builtin:{}:{}",
                    release.revision,
                    crate::schema::source_key_for_active_path(&active)
                );
                crate::builtin_snapshot_wire(&revision, &release).ok()
            }
        }
    }

    /// Change events from whichever builtin source is active.
    fn on_did_change(&self, listener: Box<dyn Fn(&str) + Send + Sync>) {
        use crate::config_service::BuiltinSource;
        match self {
            Builtin::Plain { source, .. } => source.on_did_change(listener),
            Builtin::EndpointScoped(endpoint) => endpoint.on_did_change(listener),
        }
    }

    fn kind(&self) -> EndpointScopedSourceKind {
        match self {
            Builtin::Plain { .. } => EndpointScopedSourceKind::Plain,
            Builtin::EndpointScoped(_) => EndpointScopedSourceKind::EndpointScoped,
        }
    }

    fn refresh(&self, force: bool) -> Result<ZCodeBuiltinRefreshResult, String> {
        match self {
            Builtin::Plain { synchronizer, .. } => match synchronizer {
                Some(synchronizer) => synchronizer.refresh(force),
                None => Ok(REFRESH_SKIPPED),
            },
            Builtin::EndpointScoped(source) => source.refresh(force),
        }
    }

    fn active_file_path(&self) -> Result<PathBuf, String> {
        match self {
            Builtin::Plain { active_file_path, .. } => Ok(active_file_path.clone()),
            Builtin::EndpointScoped(source) => source.resolve_active_file_path(),
        }
    }

    fn dispose(&self) {
        match self {
            Builtin::Plain {
                source, synchronizer, ..
            } => {
                if let Some(synchronizer) = synchronizer {
                    synchronizer.dispose();
                }
                source.dispose();
            }
            Builtin::EndpointScoped(source) => source.dispose(),
        }
    }
}

pub struct ProviderConfigRuntime {
    builtin: Arc<Builtin>,
    personal: PersonalProviderConfigRepository,
    on_remote_refresh_error: Option<OnRefreshError>,
    check_listeners: Arc<Mutex<Vec<CheckListener>>>,
    check_stop: Arc<AtomicBool>,
    check_wake: Arc<(Mutex<bool>, Condvar)>,
    check_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    check_started: AtomicBool,
    started: AtomicBool,
    disposed: AtomicBool,
}

impl ProviderConfigRuntime {
    pub fn new(options: ProviderConfigRuntimeOptions) -> Result<Self, String> {
        let watch = options.watch;
        let builtin = match &options.environment {
            Some(environment) => {
                // The endpoint-scoped source derives the Active path AND owns
                // the synchronizer, so the plain remote options contribute only
                // their network edge — as the TS runtime did.
                let fetch_release: FetchRelease = match &options.remote {
                    Some(remote) => Arc::clone(&remote.fetch_release),
                    None => Arc::new(|_: &str| Ok(None)),
                };
                let on_refresh_result: OnRefreshResult = match options
                    .remote
                    .as_ref()
                    .and_then(|remote| remote.on_refresh_result.clone())
                {
                    Some(callback) => callback,
                    None => Arc::new(|_: &ZCodeBuiltinRefreshEvent| {}),
                };
                Builtin::EndpointScoped(Arc::new(EndpointScopedBuiltinSource::new(
                    EndpointScopedOptions {
                        bundled_file_path: options.zcode_builtin_file_path.clone(),
                        environment_config_root: environment.environment_config_root.clone(),
                        platform: environment.platform.clone(),
                        app_version: environment.app_version.clone(),
                        watch,
                    },
                    Arc::clone(&environment.resolve_endpoint_origin),
                    fetch_release,
                    on_refresh_result,
                )))
            }
            None => {
                let source = FileBuiltinSource::with_watch(
                    options.zcode_builtin_file_path.clone(),
                    options.zcode_builtin_active_file_path.clone(),
                    watch,
                )?;
                let active_file_path = source.active_file_path().clone();
                let synchronizer = options.remote.as_ref().map(|remote| {
                    let defaults = RemoteSynchronizerOptions::default();
                    let resolve_endpoint_key = Arc::clone(&remote.resolve_endpoint_key);
                    let fetch_release = Arc::clone(&remote.fetch_release);
                    let on_refresh_result = remote.on_refresh_result.clone();
                    Arc::new(ZCodeBuiltinRemoteSynchronizer::new(
                        source.clone(),
                        RemoteSynchronizerOptions {
                            control_file_path: remote.control_file_path.clone(),
                            success_interval_ms: remote
                                .success_interval_ms
                                .unwrap_or(defaults.success_interval_ms),
                            lease_duration_ms: remote
                                .lease_duration_ms
                                .unwrap_or(defaults.lease_duration_ms),
                            failure_base_delay_ms: remote
                                .failure_base_delay_ms
                                .unwrap_or(defaults.failure_base_delay_ms),
                            failure_max_delay_ms: remote
                                .failure_max_delay_ms
                                .unwrap_or(defaults.failure_max_delay_ms),
                        },
                        move || resolve_endpoint_key(),
                        move |endpoint_key: &str| fetch_release(endpoint_key),
                        on_refresh_result.map(|callback| {
                            Box::new(move |event: &ZCodeBuiltinRefreshEvent| callback(event))
                                as Box<dyn Fn(&ZCodeBuiltinRefreshEvent) + Send + Sync>
                        }),
                    ))
                });
                Builtin::Plain {
                    source,
                    synchronizer,
                    active_file_path,
                }
            }
        };

        let builtin = Arc::new(builtin);
        // The legacy import receives the builtin snapshot, exactly like the TS
        // `importLegacy: async () => options.importLegacy(await builtin.read())`.
        let import_builtin = Arc::clone(&builtin);
        let personal = PersonalProviderConfigRepository::new(PersonalRepositoryOptions {
            file_path: options.personal_file_path,
            import_legacy: options.import_legacy.map(|import| {
                let builtin = Arc::clone(&import_builtin);
                Box::new(move || {
                    // The import receives the current builtin snapshot, exactly
                    // as the TS `importLegacy(await builtinSource.read())`.
                    let snapshot = builtin.snapshot_json();
                    // The answer is the file form of an update (what the
                    // deleted codec's caller held), so it is decoded by the
                    // same strict decoder. A malformed answer is not an import:
                    // the repository stays empty and recovers.
                    import(snapshot)
                        .ok()
                        .flatten()
                        .and_then(|json| layer_from_update_wire(&json).ok())
                })
                    as Box<
                        dyn Fn() -> Option<crate::schema::PersonalConfigLayer> + Send + Sync,
                    >
            }),
            on_recovery: options.on_personal_recovery.map(|callback| {
                Box::new(move |event: crate::repository::PersonalProviderConfigRecoveryEvent| {
                    callback(&event.error)
                })
                    as Box<
                        dyn Fn(crate::repository::PersonalProviderConfigRecoveryEvent)
                            + Send
                            + Sync,
                    >
            }),
            on_polling_error: options.on_personal_polling_error.map(|callback| {
                Box::new(move |event: crate::repository::PersonalProviderConfigRecoveryEvent| {
                    callback(&event.error)
                })
                    as Box<
                        dyn Fn(crate::repository::PersonalProviderConfigRecoveryEvent)
                            + Send
                            + Sync,
                    >
            }),
            polling_interval: options
                .personal_polling_interval_ms
                .map(Duration::from_millis),
        })?;

        Ok(Self {
            builtin,
            personal,
            on_remote_refresh_error: options.on_remote_refresh_error,
            check_listeners: Arc::new(Mutex::new(Vec::new())),
            check_stop: Arc::new(AtomicBool::new(false)),
            check_wake: Arc::new((Mutex::new(false), Condvar::new())),
            check_thread: Mutex::new(None),
            check_started: AtomicBool::new(false),
            started: AtomicBool::new(false),
            disposed: AtomicBool::new(false),
        })
    }

    pub fn personal_repository(&self) -> &PersonalProviderConfigRepository {
        &self.personal
    }

    /// A managed Worker downloads nothing and restores no owner, so it gets no
    /// periodic task — the TS guard on `remoteSynchronizer || endpointScoped ||
    // checkListeners.size`.
    fn needs_check_task(&self) -> bool {
        !self.check_listeners.lock().unwrap().is_empty()
            || match &*self.builtin {
                Builtin::Plain { synchronizer, .. } => synchronizer.is_some(),
                Builtin::EndpointScoped(_) => true,
            }
    }

    /// `start()`. The config read belongs to the config service (the caller
    /// performs it, as the TS runtime's caller did); this arms the background
    /// work, single-flight.
    pub fn start(&self) -> Result<(), String> {
        self.assert_not_disposed()?;
        if self.started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        if !self.needs_check_task() {
            return Ok(());
        }
        self.ensure_check_thread();
        // The first round runs right away, as the TS `.then(() => { void
        // this.#checkBackground(); ... })` did.
        *self.check_wake.0.lock().unwrap() = true;
        self.check_wake.1.notify_all();
        Ok(())
    }

    pub fn refresh_zcode_builtin(&self, force: bool) -> Result<ZCodeBuiltinRefreshResult, String> {
        if self.disposed.load(Ordering::SeqCst) {
            return Ok(REFRESH_DISPOSED);
        }
        self.builtin.refresh(force)
    }

    /// The Active Config path of the current Environment Endpoint,
    /// materialised.
    pub fn resolve_zcode_builtin_active_file_path(&self) -> Result<PathBuf, String> {
        self.builtin.active_file_path()
    }

    pub fn builtin_kind(&self) -> EndpointScopedSourceKind {
        self.builtin.kind()
    }

    /// Subscribes to the active builtin source's change reasons
    /// (`file-changed`, `remote-updated`, `watch-error`, `endpoint-changed`).
    pub fn on_builtin_did_change(&self, listener: Box<dyn Fn(&str) + Send + Sync>) {
        self.builtin.on_did_change(listener);
    }

    /// The plain source this runtime owns, so a caller can read the builtin
    /// snapshot through the same owner the synchronizer applies releases to.
    /// Endpoint-scoped runtimes resolve their endpoint instead and answer
    /// `None`.
    pub fn plain_builtin_source(&self) -> Option<FileBuiltinSource> {
        match &*self.builtin {
            Builtin::Plain { source, .. } => Some(source.clone()),
            Builtin::EndpointScoped(_) => None,
        }
    }

    /// Environment restores unaligned dependencies within the same periodic
    /// check — not blocked by the download TTL or by a failure.
    pub fn on_did_check_zcode_builtin(&self, listener: CheckListener) {
        self.check_listeners.lock().unwrap().push(listener);
        // A listener added after `start` must still get the cadence.
        if self.started.load(Ordering::SeqCst) {
            self.ensure_check_thread();
        }
    }

    fn ensure_check_thread(&self) {
        if self.check_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let builtin = Arc::clone(&self.builtin);
        let listeners = Arc::clone(&self.check_listeners);
        let stop = Arc::clone(&self.check_stop);
        let wake = Arc::clone(&self.check_wake);
        let on_error = self.on_remote_refresh_error.clone();
        let in_flight = Arc::new(AtomicBool::new(false));
        let handle = std::thread::spawn(move || loop {
            {
                let (lock, cvar) = &*wake;
                let guard = lock.lock().unwrap();
                // The flag requests a round (armed by `start` and by a test
                // that wants a round sooner); the stop flag ends the thread.
                let (mut guard, _) = cvar
                    .wait_timeout_while(guard, CHECK_INTERVAL, |requested| !*requested)
                    .unwrap();
                if *guard {
                    *guard = false;
                }
            }
            if stop.load(Ordering::SeqCst) {
                break;
            }
            // One refresh plus every check listener, all settled; rejections
            // reach the refresh-error observer and never abort the round.
            if in_flight.swap(true, Ordering::SeqCst) {
                continue;
            }
            let mut failures: Vec<String> = Vec::new();
            if let Err(error) = builtin.refresh(false) {
                failures.push(error);
            }
            for listener in listeners.lock().unwrap().iter() {
                if let Err(error) = listener() {
                    failures.push(error);
                }
            }
            if stop.load(Ordering::SeqCst) {
                in_flight.store(false, Ordering::SeqCst);
                break;
            }
            if let Some(on_error) = &on_error {
                for failure in failures {
                    on_error(&failure);
                }
            }
            in_flight.store(false, Ordering::SeqCst);
        });
        *self.check_thread.lock().unwrap() = Some(handle);
    }

    pub fn dispose(&self) {
        if self.disposed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.check_stop.store(true, Ordering::SeqCst);
        *self.check_wake.0.lock().unwrap() = true;
        self.check_wake.1.notify_all();
        if let Some(handle) = self.check_thread.lock().unwrap().take() {
            let _ = handle.join();
        }
        self.check_listeners.lock().unwrap().clear();
        self.builtin.dispose();
        self.personal.dispose();
    }

    fn assert_not_disposed(&self) -> Result<(), String> {
        if self.disposed.load(Ordering::SeqCst) {
            Err("NodeProviderConfigRuntime has been disposed".into())
        } else {
            Ok(())
        }
    }
}



#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zcode-runtime-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    const RELEASE: &str = include_str!("../tests/_fixture_canonical_builtin.json");

    fn base_options(dir: &Path, bundled: PathBuf) -> ProviderConfigRuntimeOptions {
        ProviderConfigRuntimeOptions {
            zcode_builtin_file_path: bundled,
            zcode_builtin_active_file_path: Some(dir.join("active.json")),
            remote: None,
            environment: None,
            on_remote_refresh_error: None,
            on_personal_recovery: None,
            on_personal_polling_error: None,
            personal_file_path: dir.join("provider_config.json"),
            personal_polling_interval_ms: Some(1_000),
            import_legacy: None,
            watch: false,
        }
    }

    #[test]
    fn without_a_remote_the_refresh_is_skipped_and_no_task_is_armed() {
        let dir = temp_dir("no-remote");
        let bundled = dir.join("bundled.json");
        std::fs::write(&bundled, RELEASE).unwrap();
        let mut options = base_options(&dir, bundled);
        options.personal_polling_interval_ms = Some(1_000);
        let runtime = ProviderConfigRuntime::new(options).expect("runtime");
        runtime.start().expect("start");
        assert_eq!(
            runtime.refresh_zcode_builtin(false).expect("refresh"),
            REFRESH_SKIPPED
        );
        assert_eq!(
            runtime.resolve_zcode_builtin_active_file_path().unwrap(),
            dir.join("active.json")
        );
        runtime.dispose();
        assert!(runtime.start().is_err(), "a disposed runtime refuses to start");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_legacy_import_runs_once_and_only_while_the_file_is_missing() {
        let dir = temp_dir("import");
        let bundled = dir.join("bundled.json");
        std::fs::write(&bundled, RELEASE).unwrap();
        let personal = dir.join("provider_config.json");
        let calls = Arc::new(Mutex::new(0u32));
        let counter = Arc::clone(&calls);
        let mut options = base_options(&dir, bundled);
        options.personal_polling_interval_ms = None;
        options.import_legacy = Some(Arc::new(move |snapshot: Option<String>| {
            *counter.lock().unwrap() += 1;
            // The import receives the current builtin release's file JSON.
            let snapshot = snapshot.expect("the builtin snapshot reaches the import");
            assert!(snapshot.contains("providerConfigRules"), "{snapshot}");
            assert!(snapshot.contains("revision"), "{snapshot}");
            Ok(Some(
                r#"{"providerConfigRules":{"providerRules":[]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]},"providerOrder":["legacy-provider"]}"#
                    .to_string(),
            ))
        }));
        let runtime = ProviderConfigRuntime::new(options).expect("runtime");
        let snapshot = runtime.personal_repository().read().expect("read");
        assert_eq!(*calls.lock().unwrap(), 1);
        assert!(personal.exists(), "the import is materialised on disk");
        runtime.personal_repository().read().expect("read again");
        assert_eq!(*calls.lock().unwrap(), 1, "the file exists, no second import");
        assert_eq!(
            snapshot.provider_order.as_deref(),
            Some(&["legacy-provider".to_string()][..]),
            "the import answer landed verbatim"
        );
        assert_eq!(snapshot.revision.len(), 64);
        runtime.dispose();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_environment_endpoint_decides_the_active_path() {
        let dir = temp_dir("environment");
        let bundled = dir.join("bundled.json");
        std::fs::write(&bundled, RELEASE).unwrap();
        let mut options = base_options(&dir, bundled);
        options.zcode_builtin_active_file_path = None;
        options.personal_polling_interval_ms = None;
        options.environment = Some(RuntimeBuiltinEnvironmentOptions {
            environment_config_root: dir.clone(),
            platform: "linux-x86_64".into(),
            app_version: "2.0.0".into(),
            resolve_endpoint_origin: Arc::new(|| Ok("https://api.z.ai".into())),
        });
        let runtime = ProviderConfigRuntime::new(options).expect("runtime");
        assert_eq!(
            runtime.builtin_kind(),
            EndpointScopedSourceKind::EndpointScoped
        );
        let active = runtime.resolve_zcode_builtin_active_file_path().unwrap();
        assert!(
            active
                .to_string_lossy()
                .starts_with(dir.join("runtime/provider/linux-x86_64/2.0.0").to_string_lossy().as_ref()),
            "{active:?}"
        );
        runtime.start().expect("start");
        runtime.dispose();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_remote_refresh_reports_missing_then_updated_and_writes_the_active_cache() {
        let dir = temp_dir("remote");
        let bundled = dir.join("bundled.json");
        std::fs::write(&bundled, RELEASE).unwrap();
        let published = Arc::new(Mutex::new(None::<serde_json::Value>));
        let fetch_source = Arc::clone(&published);
        let mut options = base_options(&dir, bundled);
        options.personal_polling_interval_ms = None;
        options.remote = Some(RuntimeRemoteOptions {
            control_file_path: dir.join("refresh.json"),
            resolve_endpoint_key: Arc::new(|| Ok("https://api.z.ai".into())),
            fetch_release: Arc::new(move |_: &str| {
                Ok(fetch_source
                    .lock()
                    .unwrap()
                    .clone()
                    .and_then(|value| crate::schema::decode_builtin_release(&value).ok()))
            }),
            on_refresh_result: None,
            success_interval_ms: None,
            lease_duration_ms: Some(1_000),
            failure_base_delay_ms: None,
            failure_max_delay_ms: None,
        });
        let runtime = ProviderConfigRuntime::new(options).expect("runtime");
        // Nothing published yet: the boundary answers "missing".
        assert_eq!(
            runtime.refresh_zcode_builtin(true).expect("refresh"),
            "missing"
        );

        let mut value: serde_json::Value = serde_json::from_str(RELEASE).unwrap();
        value["revision"] = serde_json::json!(99);
        *published.lock().unwrap() = Some(value);
        assert_eq!(
            runtime.refresh_zcode_builtin(true).expect("refresh"),
            "updated"
        );
        let active: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("active.json")).unwrap()).unwrap();
        assert_eq!(active["revision"], serde_json::json!(99));
        runtime.dispose();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failing_check_listener_reaches_the_refresh_error_observer() {
        let dir = temp_dir("check-failure");
        let bundled = dir.join("bundled.json");
        std::fs::write(&bundled, RELEASE).unwrap();
        let failures = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&failures);
        let mut options = base_options(&dir, bundled);
        options.personal_polling_interval_ms = None;
        options.on_remote_refresh_error = Some(Arc::new(move |error| {
            sink.lock().unwrap().push(error.to_string())
        }));
        // A remote edge is what arms the check task.
        options.remote = Some(RuntimeRemoteOptions {
            control_file_path: dir.join("refresh.json"),
            resolve_endpoint_key: Arc::new(|| Ok("https://api.z.ai".into())),
            fetch_release: Arc::new(|_: &str| Ok(None)),
            on_refresh_result: None,
            success_interval_ms: None,
            lease_duration_ms: Some(1_000),
            failure_base_delay_ms: None,
            failure_max_delay_ms: None,
        });
        let runtime = ProviderConfigRuntime::new(options).expect("runtime");
        runtime.on_did_check_zcode_builtin(Arc::new(|| Err("account overlay is stale".into())));
        runtime.start().expect("start");
        // The first round runs immediately, not after the 60 s cadence.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline
            && failures.lock().unwrap().is_empty()
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        runtime.dispose();
        assert_eq!(
            failures.lock().unwrap().as_slice(),
            ["account overlay is stale".to_string()],
            "the rejection reaches the observer"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The wire shape of a legacy-import answer: the same update form the deleted
/// `encodeProviderConfigFile` produced, without the envelope. Decoded here so
/// the layer arrives at the repository through the strict file shape.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerUpdateWire {
    #[serde(rename = "providerConfigRules")]
    provider_config_rules: serde_json::Value,
    #[serde(rename = "modelConfigRules")]
    model_config_rules: serde_json::Value,
    #[serde(rename = "providerOrder")]
    provider_order: Option<Vec<String>>,
    #[serde(rename = "defaultModelSelection")]
    default_model_selection: Option<crate::schema::ModelSelection>,
}

impl LayerUpdateWire {
    fn to_layer(&self) -> Result<crate::schema::PersonalConfigLayer, String> {
        let mut config = serde_json::Map::new();
        if let Some(order) = &self.provider_order {
            config.insert(
                "providerOrder".to_string(),
                serde_json::to_value(order).map_err(|e| e.to_string())?,
            );
        }
        config.insert("providerConfigRules".to_string(), self.provider_config_rules.clone());
        config.insert("modelConfigRules".to_string(), self.model_config_rules.clone());
        if let Some(selection) = &self.default_model_selection {
            config.insert(
                "defaultModelSelection".to_string(),
                serde_json::to_value(selection).map_err(|e| e.to_string())?,
            );
        }
        let file = serde_json::json!({ "schemaVersion": 1, "config": serde_json::Value::Object(config) });
        crate::schema::decode_provider_config_file(&file).map_err(|error| error.to_string())
    }
}

fn layer_from_update_wire(json: &str) -> Result<crate::schema::PersonalConfigLayer, String> {
    let update: LayerUpdateWire = serde_json::from_str(json).map_err(|error| error.to_string())?;
    update.to_layer()
}
