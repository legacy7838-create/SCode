//! Bundled + Active builtin release source for the in-process host.
//!
//! Rust port of `NodeZCodeBuiltinProviderConfigSource`
//! (`packages/provider-node/src/zcode-builtin-provider-config-source.ts`):
//! the bundled release embedded in the host is the fallback, and a cached,
//! monotonically-upgraded "active" copy wins when it is newer and valid.
//! Remote sync writes the active copy through `apply_remote_release`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::config_service::{BuiltinSnapshot, BuiltinSource};
use crate::schema::{decode_builtin_release, BuiltinRelease};

pub struct FileBuiltinSource {
    bundled_file_path: PathBuf,
    active_file_path: PathBuf,
    source_key: String,
    listeners: Mutex<Vec<Box<dyn Fn(&str) + Send>>>,
    disposed: AtomicBool,
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
        if bundled_file_path.as_os_str().is_empty() {
            return Err("ZCode Built-in bundledFilePath must not be empty".into());
        }
        let active = active_file_path
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| bundled_file_path.clone());
        let source_key = crate::schema::source_key_for_active_path(&active);
        Ok(Self {
            bundled_file_path,
            active_file_path: active,
            source_key,
            listeners: Mutex::new(Vec::new()),
            disposed: AtomicBool::new(false),
        })
    }

    fn read_release_candidate(path: &PathBuf) -> Option<Result<BuiltinRelease, String>> {
        match std::fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(value) => match decode_builtin_release(&value) {
                    Ok(release) => Some(Ok(release)),
                    Err(error) => Some(Err(error.to_string())),
                },
                Err(error) => Some(Err(error.to_string())),
            },
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
            if bundled.revision == active.revision {
                let same = serialize_release(bundled).ok() == serialize_release(active).ok();
                if !same {
                    // Conflict at the same revision: trusted bundled wins and
                    // atomically replaces the active copy.
                    return Ok(bundled.clone());
                }
            }
        }
        let valid_candidates = [bundled_release, active_release]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        match valid_candidates
            .into_iter()
            .max_by_key(|release| release.revision)
        {
            Some(release) => Ok(release),
            None => {
                Err("Both the Bundled and Active ZCode Built-in Release are unavailable".into())
            }
        }
    }

    fn read_and_materialise(&self) -> Result<BuiltinRelease, String> {
        zcode_private_file::with_file_lock(&self.active_file_path, || {
            let bundled = Self::read_release_candidate(&self.bundled_file_path);
            let active = if self.active_file_path == self.bundled_file_path {
                None
            } else {
                Self::read_release_candidate(&self.active_file_path)
            };
            let selected = Self::select(bundled, active)?;
            if self.active_file_path != self.bundled_file_path {
                let active_signature = Self::read_release_candidate(&self.active_file_path)
                    .and_then(Result::ok)
                    .and_then(|release| serialize_release(&release).ok());
                let target_signature = serialize_release(&selected).ok();
                if active_signature != target_signature {
                    let pretty = crate::schema::encode_builtin_release_pretty(&selected)
                        .map_err(|error| error.to_string())?;
                    zcode_private_file::atomic_write_private_text_file(
                        &self.active_file_path,
                        std::str::from_utf8(&pretty).map_err(|e| e.to_string())?,
                    )?;
                }
            }
            Ok(selected)
        })
    }

    pub fn apply_remote_release(
        &self,
        release: BuiltinRelease,
    ) -> Result<ApplyRemoteReleaseResult, String> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err("FileBuiltinSource has been disposed".into());
        }
        let result = zcode_private_file::with_file_lock(&self.active_file_path, || {
            let current = self.read_and_materialise()?;
            if release.revision < current.revision {
                return Ok(ApplyResult::Stale);
            }
            if release.revision == current.revision {
                let same_signature =
                    serialize_release(&release).ok() == serialize_release(&current).ok();
                return if same_signature {
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
                &self.active_file_path,
                std::str::from_utf8(&pretty).map_err(|e| e.to_string())?,
            )?;
            Ok(ApplyResult::Updated)
        })?;
        if matches!(result, ApplyResult::Updated) {
            self.emit("remote-updated");
        }
        Ok(match result {
            ApplyResult::Updated => ApplyRemoteReleaseResult::Updated,
            ApplyResult::Unchanged => ApplyRemoteReleaseResult::Unchanged,
            ApplyResult::Stale => ApplyRemoteReleaseResult::Stale,
        })
    }

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

    pub fn active_file_path(&self) -> &PathBuf {
        &self.active_file_path
    }

    pub fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        if let Ok(mut listeners) = self.listeners.lock() {
            listeners.clear();
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
        let release = self
            .read_and_materialise()
            .map_err(|error| error.to_string())?;
        Ok(BuiltinSnapshot {
            revision: format!("zcode-builtin:{}:{}", release.revision, self.source_key),
            providers: release.providers,
            provider_templates: release.provider_templates,
            models: release.models,
        })
    }

    fn on_did_change(&self, listener: Box<dyn Fn(&str) + Send>) {
        if let Ok(mut listeners) = self.listeners.lock() {
            listeners.push(listener);
        }
    }
}

fn serialize_release(release: &BuiltinRelease) -> Result<String, String> {
    String::from_utf8(crate::schema::encode_builtin_release(release).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
