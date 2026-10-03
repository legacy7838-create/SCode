//! `NodeZCodeBuiltinProviderConfigSource` over the native boundary.
//!
//! Spec: docs/specs/rust-native-provider-node.md §3.3/§3.9. Bundled, Active/LKG
//! and Remote share one release, published as the config snapshot the service
//! reads. The source itself is the rlib's `FileBuiltinSource`; this class is
//! the JSON-string boundary around it, plus the change-subscription fan-out.

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::AsyncTask;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Result, Status, Task};
use napi_derive::napi;

use zcode_provider_config::builtin_source::{ApplyRemoteReleaseResult, FileBuiltinSource};
use zcode_provider_config::config_service::BuiltinSource;

use crate::json::{builtin_snapshot_to_json, decode_release_json};

type ObserverTsfn = ThreadsafeFunction<String, (), String, Status, false, true>;
type ListenerRegistry = Arc<Mutex<Vec<(u32, ObserverTsfn)>>>;

#[napi]
pub struct NativeZCodeBuiltinProviderConfigSource {
    source: FileBuiltinSource,
    listeners: ListenerRegistry,
    next_listener_id: Arc<Mutex<u32>>,
}

#[napi]
impl NativeZCodeBuiltinProviderConfigSource {
    /// `activeFilePath: null` means "the bundled file is the active file" —
    /// the same as the TS default. `watch: false` disables the change watcher,
    /// which is how the CLI entry does its one-shot materialisation read.
    #[napi(constructor)]
    pub fn new(
        bundled_file_path: String,
        active_file_path: Option<String>,
        watch: bool,
    ) -> Result<Self> {
        let source = FileBuiltinSource::with_watch(
            std::path::PathBuf::from(bundled_file_path),
            active_file_path.map(std::path::PathBuf::from),
            watch,
        )
        .map_err(|error| napi::Error::new(Status::InvalidArg, error))?;
        let listeners: ListenerRegistry = Arc::new(Mutex::new(Vec::new()));
        // One native listener for the lifetime of the class; subscriptions only
        // add and remove entries in the fan-out list.
        source.on_did_change(forward(Arc::clone(&listeners)));
        Ok(Self {
            source,
            listeners,
            next_listener_id: Arc::new(Mutex::new(1)),
        })
    }

    /// The Active path the source resolves, materialised on first read.
    #[napi(getter)]
    pub fn active_file_path(&self) -> String {
        self.source.active_file_path().to_string_lossy().to_string()
    }

    /// Reads the release: Active when it is valid and newer, otherwise the
    /// bundled baseline. Active is a cache, never a startup gate.
    #[napi]
    pub fn read(&self) -> AsyncTask<AsyncRead> {
        AsyncTask::new(AsyncRead {
            source: self.source.clone(),
        })
    }

    /// Publishes a downloaded release as the new Active, if it is newer.
    #[napi]
    pub fn apply_remote_release(&self, release_json: String) -> AsyncTask<AsyncApplyRelease> {
        AsyncTask::new(AsyncApplyRelease {
            source: self.source.clone(),
            release_json,
        })
    }

    /// Change reasons: `file-changed`, `remote-updated`, `watch-error`.
    #[napi]
    pub fn subscribe(&self, listener: ObserverTsfn) -> u32 {
        let mut next = self.next_listener_id.lock().unwrap();
        let id = *next;
        *next += 1;
        // The source already fans out its own list through one native listener
        // registered at construction; this slot only holds the wrapper's list.
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
        self.source.dispose();
    }
}

/// Fans the source's own change reasons out to every wrapper subscription.
fn forward(listeners: ListenerRegistry) -> Box<dyn Fn(&str) + Send + Sync> {
    Box::new(move |reason: &str| {
        let reason = reason.to_string();
        for (_, listener) in listeners.lock().unwrap().iter() {
            let _ = listener.call(reason.clone(), ThreadsafeFunctionCallMode::NonBlocking);
        }
    })
}

pub struct AsyncRead {
    source: FileBuiltinSource,
}

impl Task for AsyncRead {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let release = self
            .source
            .read_release()
            .map_err(|error| napi::Error::new(Status::GenericFailure, error))?;
        let revision = format!(
            "zcode-builtin:{}:{}",
            release.revision,
            zcode_provider_config::schema::source_key_for_active_path(
                self.source.active_file_path()
            )
        );
        builtin_snapshot_to_json(revision, &release)
            .map_err(|error| napi::Error::new(Status::GenericFailure, error))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct AsyncApplyRelease {
    source: FileBuiltinSource,
    release_json: String,
}

impl Task for AsyncApplyRelease {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let release = decode_release_json(&self.release_json)
            .map_err(|error| napi::Error::new(Status::InvalidArg, error))?;
        let result = self
            .source
            .apply_remote_release(release)
            .map_err(|error| napi::Error::new(Status::GenericFailure, error))?;
        Ok(match result {
            ApplyRemoteReleaseResult::Updated => "updated",
            ApplyRemoteReleaseResult::Unchanged => "unchanged",
            ApplyRemoteReleaseResult::Stale => "stale",
        }
        .to_string())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
