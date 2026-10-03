//! Bundled + Active builtin release source for the in-process host.
//!
//! Rust port of `NodeZCodeBuiltinProviderConfigSource`
//! (`packages/provider-node/src/zcode-builtin-provider-config-source.ts`):
//! the bundled release embedded in the host is the baseline, and a cached,
//! monotonically-upgraded "active" copy wins when it is newer and valid.
//! Remote sync writes the active copy through `apply_remote_release`.
//!
//! # Watcher
//!
//! TS watched the active file's directory with `fs.watch`. The Rust port polls
//! the file's metadata (len + mtime) on a 250 ms cadence and, on a change,
//! re-reads **under the same file lock** and compares the release signature —
//! so an identical rewrite emits nothing and only a real content change
//! produces `file-changed`. That preserves the event contract; only the
//! detection latency differs (bounded at 250 ms instead of ~ms).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use crate::config_service::{BuiltinSnapshot, BuiltinSource};
use crate::schema::BuiltinRelease;

/// Watch poll cadence. Bounds how long an out-of-process writer's update takes
/// to surface, in exchange for not platform-watching a directory.
const WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// The source is a handle over shared state, so cloning it hands out another
/// view of the *same* source — that is what lets the endpoint-scoped wrapper
/// and the remote synchronizer write through one owner.
#[derive(Clone)]
pub struct FileBuiltinSource {
    shared: Arc<Shared>,
}

struct Shared {
    bundled_file_path: PathBuf,
    active_file_path: PathBuf,
    source_key: String,
    watch_enabled: bool,
    listeners: Mutex<Vec<Box<dyn Fn(&str) + Send + Sync>>>,
    disposed: AtomicBool,
    /// The signature the owner has already reported. The watcher never
    /// re-notifies for a signature this already carries — the same
    /// de-duplication the TS `observedSignature` performs.
    observed_signature: Mutex<Option<String>>,
    watcher: Mutex<Option<Watcher>>,
}

struct Watcher {
    stop: Arc<AtomicBool>,
    wake: mpsc::Sender<()>,
    handle: std::thread::JoinHandle<()>,
}

enum ApplyResult {
    Updated,
    Unchanged,
    Stale,
}

impl FileBuiltinSource {
    pub fn new(
        bundled_file_path: PathBuf,
        active_file_path: Option<PathBuf>,
    ) -> Result<Self, String> {
        Self::with_watch(bundled_file_path, active_file_path, true)
    }

    /// `watch: false` disables the watcher entirely — the CLI entry reads the
    /// release once to materialise its cache and then drops the source.
    pub fn with_watch(
        bundled_file_path: PathBuf,
        active_file_path: Option<PathBuf>,
        watch_enabled: bool,
    ) -> Result<Self, String> {
        if bundled_file_path.as_os_str().is_empty() {
            return Err("ZCode Built-in bundledFilePath must not be empty".into());
        }
        let active_file_path = active_file_path
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| bundled_file_path.clone());
        // The old logo only has the release serial number. Different Endpoints
        // with the same serial number would make the Registry reuse the previous
        // source, so the identity is the absolute Active path, which already
        // carries the endpoint isolation scope.
        let source_key = crate::schema::source_key_for_active_path(&active_file_path);
        Ok(Self {
            shared: Arc::new(Shared {
                bundled_file_path,
                active_file_path,
                source_key,
                watch_enabled,
                listeners: Mutex::new(Vec::new()),
                disposed: AtomicBool::new(false),
                observed_signature: Mutex::new(None),
                watcher: Mutex::new(None),
            }),
        })
    }

    fn read_release_candidate(path: &Path) -> Option<Result<BuiltinRelease, String>> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                let value = match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(value) => value,
                    Err(error) => return Some(Err(format!("invalid JSON: {error}"))),
                };
                match crate::schema::decode_builtin_release(&value) {
                    Ok(release) => Some(Ok(release)),
                    Err(error) => Some(Err(error.to_string())),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => Some(Err(error.to_string())),
        }
    }

    /// Replicates `selectReleaseCandidate`.
    fn select(
        bundled: Option<Result<BuiltinRelease, String>>,
        active: Option<Result<BuiltinRelease, String>>,
    ) -> Result<BuiltinRelease, String> {
        let bundled_release = bundled.and_then(Result::ok);
        let active_release = active.and_then(Result::ok);
        if let (Some(bundled), Some(active)) = (&bundled_release, &active_release) {
            if bundled.revision == active.revision
                && serialize_release(bundled).ok() != serialize_release(active).ok()
            {
                // A same-revision conflict is an Active cache invalidation. It
                // must not be able to stop the trusted Bundled baseline from
                // starting; the caller atomically replaces Active instead.
                return Ok(bundled.clone());
            }
        }
        let valid = [bundled_release, active_release]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        valid
            .into_iter()
            .max_by_key(|release| release.revision)
            .ok_or_else(|| {
                "Both the Bundled and Active ZCode Built-in Release are unavailable".to_string()
            })
    }

    /// The body of the locked read-and-materialise. The caller holds the file
    /// lock, exactly like the TS `#readAndMaterializeLocked`, which its
    /// `#readCurrent` wrapped in `withFileLock`.
    fn read_and_materialise(&self) -> Result<BuiltinRelease, String> {
        {
            let bundled = Self::read_release_candidate(&self.shared.bundled_file_path);
            let active = if self.shared.active_file_path == self.shared.bundled_file_path {
                None
            } else {
                Self::read_release_candidate(&self.shared.active_file_path)
            };
            let selected = Self::select(bundled, active)?;
            if self.shared.active_file_path != self.shared.bundled_file_path {
                let active_signature =
                    Self::read_release_candidate(&self.shared.active_file_path)
                        .and_then(Result::ok)
                        .map(|release| signature_of(&release));
                let selected_signature = signature_of(&selected);
                if active_signature.as_deref() != Some(selected_signature.as_str()) {
                    let pretty = crate::schema::encode_builtin_release_pretty(&selected)
                        .map_err(|error| error.to_string())?;
                    zcode_private_file::atomic_write_private_text_file(
                        &self.shared.active_file_path,
                        std::str::from_utf8(&pretty).map_err(|error| error.to_string())?,
                    )?;
                }
            }
            Ok(selected)
        }
    }

    /// The TS `read()` contract: Active is only ever a cache, so any failure
    /// of the locked Active path (lock, watcher setup, materialisation) falls
    /// back to the Bundled baseline. An invalid Bundled release still throws —
    /// there is nothing left to serve from.
    pub fn read_release(&self) -> Result<BuiltinRelease, String> {
        self.ensure_watcher();
        let release = match zcode_private_file::with_file_lock(
            &self.shared.active_file_path,
            || self.read_and_materialise(),
        ) {
            Ok(release) => release,
            Err(_) => {
                Self::select(Self::read_release_candidate(&self.shared.bundled_file_path), None)?
            }
        };
        {
            let mut observed = self.shared.observed_signature.lock().unwrap();
            if observed.is_none() {
                *observed = Some(signature_of(&release));
            }
        }
        Ok(release)
    }

    pub fn apply_remote_release(
        &self,
        release: BuiltinRelease,
    ) -> Result<ApplyRemoteReleaseResult, String> {
        if self.shared.disposed.load(Ordering::SeqCst) {
            return Err("FileBuiltinSource has been disposed".into());
        }
        self.ensure_watcher();
        let new_signature = signature_of(&release);
        let result = zcode_private_file::with_file_lock(&self.shared.active_file_path, || {
            if self.shared.disposed.load(Ordering::SeqCst) {
                return Err("FileBuiltinSource has been disposed".into());
            }
            let current = self.read_and_materialise()?;
            if self.shared.disposed.load(Ordering::SeqCst) {
                return Err("FileBuiltinSource has been disposed".into());
            }
            if release.revision < current.revision {
                return Ok(ApplyResult::Stale);
            }
            if release.revision == current.revision {
                let current_signature = signature_of(&current);
                return if new_signature == current_signature {
                    Ok(ApplyResult::Unchanged)
                } else {
                    Err(format!(
                        "ZCode Built-in revision {} maps to different content",
                        release.revision
                    ))
                };
            }
            let pretty = crate::schema::encode_builtin_release_pretty(&release)
                .map_err(|error| error.to_string())?;
            zcode_private_file::atomic_write_private_text_file(
                &self.shared.active_file_path,
                std::str::from_utf8(&pretty).map_err(|error| error.to_string())?,
            )?;
            Ok(ApplyResult::Updated)
        })?;
        if matches!(result, ApplyResult::Updated) {
            *self.shared.observed_signature.lock().unwrap() = Some(new_signature);
            self.shared.emit("remote-updated");
        }
        Ok(match result {
            ApplyResult::Updated => ApplyRemoteReleaseResult::Updated,
            ApplyResult::Unchanged => ApplyRemoteReleaseResult::Unchanged,
            ApplyResult::Stale => ApplyRemoteReleaseResult::Stale,
        })
    }

    /// The watcher thread, started at most once per source.
    fn ensure_watcher(&self) {
        if !self.shared.watch_enabled || self.shared.disposed.load(Ordering::SeqCst) {
            return;
        }
        let mut slot = self.shared.watcher.lock().unwrap();
        if slot.is_some() {
            return;
        }
        if let Some(parent) = self.shared.active_file_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let (wake, wake_rx) = mpsc::channel::<()>();
        let stop = Arc::new(AtomicBool::new(false));
        let handle = {
            let shared = Arc::clone(&self.shared);
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                let mut last_seen: Option<(u64, i64)> = None;
                let mut primed = false;
                loop {
                    match wake_rx.recv_timeout(WATCH_INTERVAL) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    if stop.load(Ordering::SeqCst) || shared.disposed.load(Ordering::SeqCst) {
                        break;
                    }
                    let metadata = std::fs::metadata(&shared.active_file_path).ok();
                    let current = metadata.as_ref().map(|metadata| {
                        (
                            metadata.len(),
                            metadata
                                .modified()
                                .ok()
                                .and_then(|time| {
                                    time.duration_since(std::time::UNIX_EPOCH).ok()
                                })
                                .map(|delta| delta.as_millis() as i64)
                                .unwrap_or_default(),
                        )
                    });
                    // The first pass only primes the observation, so a source
                    // that never changes emits nothing.
                    if !primed {
                        primed = true;
                        last_seen = current;
                        continue;
                    }
                    if current == last_seen {
                        continue;
                    }
                    last_seen = current;
                    // Re-read under the same lock the owner uses; only a real
                    // content change is an event.
                    let reread =
                        zcode_private_file::with_file_lock(&shared.active_file_path, || {
                            FileBuiltinSource::select(
                                Self::read_release_candidate(&shared.bundled_file_path),
                                if shared.active_file_path == shared.bundled_file_path {
                                    None
                                } else {
                                    Self::read_release_candidate(&shared.active_file_path)
                                },
                            )
                        });
                    match reread {
                        Ok(release) => {
                            let signature = signature_of(&release);
                            let changed = {
                                let mut observed = shared.observed_signature.lock().unwrap();
                                if observed.as_deref() == Some(signature.as_str()) {
                                    false
                                } else {
                                    *observed = Some(signature);
                                    true
                                }
                            };
                            if changed && !shared.disposed.load(Ordering::SeqCst) {
                                shared.emit("file-changed");
                            }
                        }
                        Err(_) => {
                            if !shared.disposed.load(Ordering::SeqCst) {
                                shared.emit("watch-error");
                            }
                        }
                    }
                }
            })
        };
        *slot = Some(Watcher { stop, wake, handle });
    }

    pub fn active_file_path(&self) -> &PathBuf {
        &self.shared.active_file_path
    }

    pub fn dispose(&self) {
        if self.shared.disposed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(watcher) = self.shared.watcher.lock().unwrap().take() {
            watcher.stop.store(true, Ordering::SeqCst);
            let _ = watcher.wake.send(());
            let _ = watcher.handle.join();
        }
        if let Ok(mut listeners) = self.shared.listeners.lock() {
            listeners.clear();
        }
    }
}

impl Shared {
    fn emit(&self, reason: &str) {
        if self.disposed.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(listeners) = self.listeners.lock() {
            for listener in listeners.iter() {
                listener(reason);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyRemoteReleaseResult {
    Updated,
    Unchanged,
    Stale,
}

impl BuiltinSource for FileBuiltinSource {
    fn read(&self) -> Result<BuiltinSnapshot, String> {
        let release = self.read_release()?;
        Ok(BuiltinSnapshot {
            revision: format!(
                "zcode-builtin:{}:{}",
                release.revision, self.shared.source_key
            ),
            providers: release.providers,
            provider_templates: release.provider_templates,
            models: release.models,
        })
    }

    fn on_did_change(&self, listener: Box<dyn Fn(&str) + Send + Sync>) {
        if let Ok(mut listeners) = self.shared.listeners.lock() {
            listeners.push(listener);
        }
    }
}

/// `${revision}:${serialize(release)}` — the identity a change event is
/// de-duplicated on. Revision is part of it so a re-published identical body
/// at a higher revision still counts as a change.
fn signature_of(release: &BuiltinRelease) -> String {
    format!(
        "{}:{}",
        release.revision,
        serialize_release(release).unwrap_or_default()
    )
}

fn serialize_release(release: &BuiltinRelease) -> Result<String, String> {
    String::from_utf8(crate::schema::encode_builtin_release(release).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELEASE: &str = include_str!("../tests/_fixture_canonical_builtin.json");

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zcode-builtin-source-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn bundled(dir: &Path) -> PathBuf {
        let path = dir.join("bundled.json");
        std::fs::write(&path, RELEASE).unwrap();
        path
    }

    #[test]
    fn a_newer_active_release_wins_and_is_materialised() {
        let dir = temp_dir("newer");
        let bundled = bundled(&dir);
        let active = dir.join("nested/active.json");
        let source = FileBuiltinSource::with_watch(bundled, Some(active.clone()), false).unwrap();
        let release = source.read_release().unwrap();
        assert_eq!(release.revision, 32);
        // The first read materialises the active copy from the bundled baseline.
        let materialised: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&active).unwrap()).unwrap();
        assert_eq!(materialised["revision"], serde_json::json!(32));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_invalid_active_falls_back_to_bundled_and_replaces_it() {
        let dir = temp_dir("invalid-active");
        let bundled = bundled(&dir);
        let active = dir.join("active.json");
        std::fs::write(&active, "{\"schemaVersion\":1,\"revision\":1,\"config\":{}}").unwrap();
        let source = FileBuiltinSource::with_watch(bundled, Some(active.clone()), false).unwrap();
        let release = source.read_release().unwrap();
        assert_eq!(release.revision, 32, "bundled baseline serves the invalid cache");
        let repaired: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&active).unwrap()).unwrap();
        assert_eq!(repaired["revision"], serde_json::json!(32), "cache is replaced");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_invalid_bundled_still_throws() {
        let dir = temp_dir("invalid-bundled");
        let bundled = dir.join("bundled.json");
        std::fs::write(&bundled, "{\"schemaVersion\":1,\"revision\":1,\"config\":{}}").unwrap();
        let source =
            FileBuiltinSource::with_watch(bundled, Some(dir.join("active.json")), false).unwrap();
        let error = source.read_release().unwrap_err();
        assert!(!error.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_remote_release_reports_updated_unchanged_and_stale() {
        let dir = temp_dir("apply");
        let bundled = bundled(&dir);
        let source =
            FileBuiltinSource::with_watch(bundled, Some(dir.join("active.json")), false).unwrap();
        let current = source.read_release().unwrap();

        assert_eq!(
            source.apply_remote_release(current.clone()).unwrap(),
            ApplyRemoteReleaseResult::Unchanged
        );

        let mut newer = current.clone();
        newer.revision += 1;
        assert_eq!(
            source.apply_remote_release(newer.clone()).unwrap(),
            ApplyRemoteReleaseResult::Updated
        );
        assert_eq!(
            source.apply_remote_release(current.clone()).unwrap(),
            ApplyRemoteReleaseResult::Stale
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_out_of_process_write_emits_file_changed_once() {
        let dir = temp_dir("watch");
        let bundled = bundled(&dir);
        let active = dir.join("active.json");
        let source = FileBuiltinSource::with_watch(bundled.clone(), Some(active.clone()), true).unwrap();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&seen);
        source.on_did_change(Box::new(move |reason| {
            sink.lock().unwrap().push(reason.to_string());
        }));

        let current = source.read_release().unwrap();
        // An out-of-process writer publishes a newer release.
        let mut newer = current.clone();
        newer.revision += 1;
        let envelope = serde_json::from_str::<serde_json::Value>(
            std::str::from_utf8(
                &crate::schema::encode_builtin_release(&newer).unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(WATCH_INTERVAL.as_millis() as u64 * 3));
        std::fs::write(&active, serde_json::to_string(&envelope).unwrap()).unwrap();

        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline
            && !seen.lock().unwrap().iter().any(|reason| reason == "file-changed")
        {
            std::thread::sleep(WATCH_INTERVAL);
        }
        source.dispose();
        let events = seen.lock().unwrap().clone();
        assert_eq!(
            events.iter().filter(|reason| *reason == "file-changed").count(),
            1,
            "one change, one event: {events:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
