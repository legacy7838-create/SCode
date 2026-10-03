//! Endpoint-scoped builtin source.
//!
//! Rust port of `EndpointScopedZCodeBuiltinSource`
//! (`packages/provider-node/src/endpoint-scoped-zcode-builtin-source.ts`).
//!
//! The Environment's ZCode control-plane Endpoint determines both the
//! Active/LKG pair and the refresh control path. Switching Endpoints only
//! replaces the current source; the previous Endpoint's cache is never read.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::builtin_source::FileBuiltinSource;
use crate::cache_paths::{normalize_endpoint_origin, resolve_cache_paths};
use crate::config_service::{BuiltinSnapshot, BuiltinSource};
use crate::remote_sync::{
    RemoteSynchronizerOptions, ZCodeBuiltinRefreshEvent, ZCodeBuiltinRefreshResult,
    ZCodeBuiltinRemoteSynchronizer, REFRESH_DISPOSED, REFRESH_SKIPPED,
};
use crate::schema::BuiltinRelease;

/// Which source kind the environment selected. The runtime reads this to decide
/// where a refresh goes and whether a periodic check task is needed at all (a
/// managed Worker neither downloads nor restores ownership).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointScopedSourceKind {
    /// `NodeZCodeBuiltinProviderConfigSource` + optional remote synchronizer.
    Plain,
    /// `EndpointScopedZCodeBuiltinSource`.
    EndpointScoped,
}

/// Resolve the current control-plane origin (normalised inside).
pub type ResolveEndpointOrigin = Arc<dyn Fn() -> Result<String, String> + Send + Sync>;
/// Fetch the release for an endpoint key. `Ok(None)` = nothing published.
pub type FetchRelease = Arc<dyn Fn(&str) -> Result<Option<BuiltinRelease>, String> + Send + Sync>;
pub type OnRefreshResult = Arc<dyn Fn(&ZCodeBuiltinRefreshEvent) + Send + Sync>;

pub struct EndpointScopedOptions {
    pub bundled_file_path: PathBuf,
    pub environment_config_root: PathBuf,
    pub platform: String,
    pub app_version: String,
    pub watch: bool,
}

struct CurrentEndpoint {
    active_file_path: PathBuf,
    source: FileBuiltinSource,
    synchronizer: Option<Arc<ZCodeBuiltinRemoteSynchronizer>>,
    /// Set on dispose so a replaced endpoint's late events cannot reach the
    /// wrapper's listeners.
    subscribed: Arc<AtomicBool>,
}

pub struct EndpointScopedBuiltinSource {
    options: EndpointScopedOptions,
    resolve_endpoint_origin: ResolveEndpointOrigin,
    fetch_release: FetchRelease,
    on_refresh_result: OnRefreshResult,
    listeners: Arc<Mutex<Vec<Box<dyn Fn(&str) + Send + Sync>>>>,
    current: Mutex<Option<Arc<CurrentEndpoint>>>,
    disposed: AtomicBool,
}

impl EndpointScopedBuiltinSource {
    pub fn new(
        options: EndpointScopedOptions,
        resolve_endpoint_origin: ResolveEndpointOrigin,
        fetch_release: FetchRelease,
        on_refresh_result: OnRefreshResult,
    ) -> Self {
        Self {
            options,
            resolve_endpoint_origin,
            fetch_release,
            on_refresh_result,
            listeners: Arc::new(Mutex::new(Vec::new())),
            current: Mutex::new(None),
            disposed: AtomicBool::new(false),
        }
    }

    /// The Environment Endpoint decides both the Active path and the control
    /// path. When the derived Active path is unchanged the current source is
    /// reused, so per-operation locking here doubles as the coalescing the TS
    /// `#ensureInFlight` promise provided.
    fn ensure_current(&self) -> Result<Arc<CurrentEndpoint>, String> {
        self.assert_not_disposed()?;
        let origin = normalize_endpoint_origin(&(&self.resolve_endpoint_origin)()?)?;
        let paths = resolve_cache_paths(
            &self.options.environment_config_root,
            &self.options.platform,
            &self.options.app_version,
            &origin,
        )?;
        // Holding this lock across the switch is what coalesces concurrent
        // resolutions into one, the way the TS `#ensureInFlight` promise did.
        let mut slot = self.current.lock().unwrap();
        if let Some(current) = slot.as_ref() {
            if current.active_file_path == paths.active_file_path {
                return Ok(Arc::clone(current));
            }
        }

        let source = FileBuiltinSource::with_watch(
            self.options.bundled_file_path.clone(),
            Some(paths.active_file_path.clone()),
            self.options.watch,
        )?;
        // Forward this endpoint's events, but only while it is still current.
        let subscribed = Arc::new(AtomicBool::new(true));
        {
            let listeners = Arc::clone(&self.listeners);
            let subscribed_flag = Arc::clone(&subscribed);
            source.on_did_change(Box::new(move |reason: &str| {
                if subscribed_flag.load(Ordering::SeqCst) {
                    for listener in listeners.lock().unwrap().iter() {
                        listener(reason);
                    }
                }
            }));
        }
        let synchronizer = {
            let resolve_endpoint_origin = Arc::clone(&self.resolve_endpoint_origin);
            let fetch_release = Arc::clone(&self.fetch_release);
            let on_refresh_result = Arc::clone(&self.on_refresh_result);
            Arc::new(ZCodeBuiltinRemoteSynchronizer::new(
                source.clone(),
                RemoteSynchronizerOptions {
                    control_file_path: paths.control_file_path.clone(),
                    ..Default::default()
                },
                move || normalize_endpoint_origin(&resolve_endpoint_origin()?),
                move |endpoint_key: &str| fetch_release(endpoint_key),
                Some(Box::new(move |event: &ZCodeBuiltinRefreshEvent| {
                    on_refresh_result(event)
                })),
            ))
        };
        // Materialise before publishing, so a broken bundled release fails the
        // switch instead of leaving a half-built cache behind.
        source.read_release()?;

        let previous = slot.replace(Arc::new(CurrentEndpoint {
            active_file_path: paths.active_file_path,
            source,
            synchronizer: Some(synchronizer),
            subscribed,
        }));
        let current = Arc::clone(slot.as_ref().expect("just published"));
        drop(slot);
        if let Some(previous) = previous {
            // Switching Endpoints only replaces the current source; the
            // previous Endpoint's cache is never read again.
            previous.dispose();
            self.emit("endpoint-changed");
        }
        Ok(current)
    }

    pub fn read_snapshot(&self) -> Result<BuiltinSnapshot, String> {
        use crate::config_service::BuiltinSource;
        let current = self.ensure_current()?;
        current.source.read()
    }

    pub fn refresh(&self, force: bool) -> Result<ZCodeBuiltinRefreshResult, String> {
        if self.disposed.load(Ordering::SeqCst) {
            return Ok(REFRESH_DISPOSED);
        }
        let current = self.ensure_current()?;
        match current.synchronizer.clone() {
            Some(synchronizer) => synchronizer.refresh(force),
            None => Ok(REFRESH_SKIPPED),
        }
    }

    /// The fully materialised Active Config path for the current Endpoint.
    pub fn resolve_active_file_path(&self) -> Result<PathBuf, String> {
        let current = self.ensure_current()?;
        Ok(current.active_file_path.clone())
    }

    /// The release the current Endpoint serves, or `None` once disposed. Used
    /// by the runtime's legacy import, which needs the same snapshot the TS
    /// `importLegacy(await builtinSource.read())` received.
    pub fn current_release(&self) -> Option<BuiltinRelease> {
        let source = self
            .current
            .lock()
            .ok()
            .and_then(|current| current.as_ref().map(|current| current.source.clone()))?;
        source.read_release().ok()
    }

    pub fn on_did_change(&self, listener: Box<dyn Fn(&str) + Send + Sync>) {
        if let Ok(mut listeners) = self.listeners.lock() {
            listeners.push(listener);
        }
    }

    pub fn dispose(&self) {
        if self.disposed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(current) = self.current.lock().unwrap().take() {
            current.dispose();
        }
        if let Ok(mut listeners) = self.listeners.lock() {
            listeners.clear();
        }
    }

    fn emit(&self, reason: &str) {
        if self.disposed.load(Ordering::SeqCst) {
            return;
        }
        for listener in self.listeners.lock().unwrap().iter() {
            listener(reason);
        }
    }

    fn assert_not_disposed(&self) -> Result<(), String> {
        if self.disposed.load(Ordering::SeqCst) {
            Err("EndpointScopedZCodeBuiltinSource has been disposed".into())
        } else {
            Ok(())
        }
    }
}

impl CurrentEndpoint {
    fn dispose(&self) {
        self.subscribed.store(false, Ordering::SeqCst);
        if let Some(synchronizer) = &self.synchronizer {
            synchronizer.dispose();
        }
        self.source.dispose();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELEASE: &str = include_str!("../tests/_fixture_canonical_builtin.json");

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zcode-endpoint-scoped-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn the_active_path_follows_the_endpoint_and_a_switch_re_reads() {
        let dir = temp_dir("switch");
        let bundled = dir.join("bundled.json");
        std::fs::write(&bundled, RELEASE).unwrap();
        let endpoint = Arc::new(Mutex::new("https://api.z.ai".to_string()));
        let resolver: ResolveEndpointOrigin = {
            let endpoint = Arc::clone(&endpoint);
            Arc::new(move || Ok(endpoint.lock().unwrap().clone()))
        };
        let source = EndpointScopedBuiltinSource::new(
            EndpointScopedOptions {
                bundled_file_path: bundled,
                environment_config_root: dir.clone(),
                platform: "linux-x86_64".into(),
                app_version: "1.0.0".into(),
                watch: false,
            },
            resolver,
            Arc::new(|_: &str| Ok(None)),
            Arc::new(|_: &ZCodeBuiltinRefreshEvent| {}),
        );
        let first = source.resolve_active_file_path().expect("first");
        assert!(
            first
                .to_string_lossy()
                .starts_with(dir.join("runtime/provider/linux-x86_64/1.0.0").to_string_lossy().as_ref()),
            "{first:?}"
        );
        assert_eq!(
            source.resolve_active_file_path().expect("same"),
            first,
            "the same endpoint reuses the source"
        );

        // A different host is a different origin; a path on the same host is not.
        *endpoint.lock().unwrap() = "https://staging.z.ai".to_string();
        let second = source.resolve_active_file_path().expect("second");
        assert_ne!(first, second, "a different origin is a different cache");
        assert_eq!(
            second,
            source.resolve_active_file_path().expect("stable"),
            "the switched endpoint stays current until the origin changes again"
        );
        // Both endpoints materialise the same bundled baseline.
        assert!(std::fs::read_to_string(&second).unwrap().contains("\"revision\": 32"));
        source.dispose();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_disposed_source_refuses_further_work() {
        let source = EndpointScopedBuiltinSource::new(
            EndpointScopedOptions {
                bundled_file_path: PathBuf::from("/nonexistent/bundled.json"),
                environment_config_root: PathBuf::from("/tmp"),
                platform: "linux-x86_64".into(),
                app_version: "1.0.0".into(),
                watch: false,
            },
            Arc::new(|| Ok("https://api.z.ai".to_string())),
            Arc::new(|_: &str| Ok(None)),
            Arc::new(|_: &ZCodeBuiltinRefreshEvent| {}),
        );
        source.dispose();
        assert!(source.read_snapshot().is_err());
        assert_eq!(
            source.refresh(false).expect("refresh"),
            crate::remote_sync::REFRESH_DISPOSED,
            "a disposed source answers \"disposed\", like the TS runtime"
        );
        assert!(source.resolve_active_file_path().is_err());
    }

    #[test]
    fn an_empty_endpoint_is_rejected_before_any_io() {
        let dir = temp_dir("empty-endpoint");
        let source = EndpointScopedBuiltinSource::new(
            EndpointScopedOptions {
                bundled_file_path: dir.join("bundled.json"),
                environment_config_root: dir.clone(),
                platform: "linux-x86_64".into(),
                app_version: "1.0.0".into(),
                watch: false,
            },
            Arc::new(|| Ok("   ".to_string())),
            Arc::new(|_: &str| Ok(None)),
            Arc::new(|_: &ZCodeBuiltinRefreshEvent| {}),
        );
        let error = source.resolve_active_file_path().unwrap_err();
        assert!(error.contains("must not be empty"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
