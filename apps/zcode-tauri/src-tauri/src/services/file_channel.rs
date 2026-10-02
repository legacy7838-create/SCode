//! `file` channel — workspace filesystem read + workspace-creation surface.
//!
//! Replaces the `@zcode/server` `file` channel (`IFileService`). The operations
//! reuse the `zcode-fs` core (`walk::read_dir`, `reads::*`, `containment::*`)
//! linked as an rlib — the same native containment the Node path enforces, so a
//! path outside the allowlist is rejected by the identical algorithm rather than
//! a second implementation. Every path-taking call is confined to an append-only
//! roots set the handler owns.
//!
//! `readFileRange` is served over the raw top-level byte channel (the optional
//! `call_binary`), so the client gets the `Uint8Array` it expects rather than a
//! JSON+base64 object it would mis-decode.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value as JsonValue;
use zcode_fs::containment::Roots;
use zcode_fs::{ignore_rules, reads, walk};

use super::workspace_index::{self, IndexEntry};
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

use crate::services::paths;

/// Scratch workspace root name — `homedir()/ZCodeProject`.
const SCRATCH_WORKSPACE_ROOT_NAME: &str = "ZCodeProject";

/// Append-only allowlist of roots every filesystem call is confined to. Mirrors
/// `FileServiceScope`: there is no remove/clear/replace, only `allow`.
#[derive(Default)]
struct FileServiceScope {
    roots: HashSet<String>,
}

impl FileServiceScope {
    fn allow(&mut self, path: &str) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            self.roots.insert(trimmed.to_string());
        }
    }

    fn snapshot(&self) -> Vec<String> {
        self.roots.iter().cloned().collect()
    }
}

/// One directory entry, matching the shared `FileEntry` wire shape.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntryView {
    name: String,
    path: String,
    r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_symbolic_link: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileStatView {
    path: String,
    r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime_ms: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTextView {
    path: String,
    content: String,
    offset: u64,
    bytes_read: u64,
    total_bytes: u64,
    truncated: bool,
    is_binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMediaPreviewView {
    path: String,
    media_type: String,
    data_base64: String,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileBinaryPreviewView {
    path: String,
    data_base64: String,
    total_bytes: u64,
}

pub struct FileService {
    scope: Mutex<FileServiceScope>,
    /// Packed workspace indexes, keyed by root. The TS side caches with a
    /// 60 s TTL + rules fingerprint; here the fingerprint gates the rebuild so
    /// an edited `.zcodeignore` invalidates the index.
    workspace_indexes: Mutex<std::collections::HashMap<String, (String, String)>>,
}

impl FileService {
    pub fn new() -> Self {
        let mut scope = FileServiceScope::default();
        // The product's workspace roots: home, the data base dir, and the app
        // config dir — the same roots `@zcode/server` seeded. A scratch or
        // conversation workspace adds itself when created.
        scope.allow(&paths::homedir());
        scope.allow(&paths::data_base_dir().to_string_lossy());
        scope.allow(&paths::app_config_dir().to_string_lossy());
        Self {
            scope: Mutex::new(scope),
            workspace_indexes: Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn roots(&self) -> Vec<String> {
        self.scope.lock().unwrap().snapshot()
    }

    fn allow_root(&self, path: &str) {
        self.scope.lock().unwrap().allow(path);
    }

    fn resolve(&self, path: &str, syscall: &str) -> Result<PathBuf, HandlerError> {
        Roots::from_raw(&self.roots())
            .resolve(path, syscall)
            .map_err(|error| HandlerError::message(error.reason))
    }

    fn canonical_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn stat_view(&self, path: &str) -> Result<FileStatView, HandlerError> {
        let canonical = self.resolve(path, "stat")?;
        let meta = std::fs::metadata(&canonical)
            .map_err(|error| HandlerError::message(format!("{error}")))?;
        let is_directory = meta.is_dir();
        Ok(FileStatView {
            path: path.to_string(),
            r#type: if is_directory { "directory" } else { "file" }.to_string(),
            size: (!is_directory).then_some(meta.len() as f64),
            mtime_ms: (!is_directory).then(|| {
                meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as f64)
                    .unwrap_or_default()
            }),
        })
    }

    /// `ensureWorkspaceDirectory`: mkdir -p and return the created path.
    fn ensure_workspace_directory(&self, base_dir: &Path, name: Option<&str>) -> Result<(String, bool), HandlerError> {
        let created = match name {
            Some(name) if !name.is_empty() => {
                if name.contains('/') || name.contains('\\') {
                    return Err(HandlerError::message("workspace name must not contain path separators"));
                }
                base_dir.join(name)
            }
            _ => base_dir.to_path_buf(),
        };
        let existed = created.exists();
        std::fs::create_dir_all(&created)
            .map_err(|error| HandlerError::message(format!("cannot create workspace {}: {error}", created.display())))?;
        self.allow_root(&created.to_string_lossy());
        Ok((created.to_string_lossy().into_owned(), !existed))
    }

    fn scratch_base_dir(&self) -> PathBuf {
        Path::new(&paths::homedir()).join(SCRATCH_WORKSPACE_ROOT_NAME)
    }
}

impl Default for FileService {
    fn default() -> Self {
        Self::new()
    }
}

impl FileService {
    /// Build (or reuse) the packed workspace index for a root: load ignore
    /// rules, walk (gitignore matching + mention filter in Rust), sort
    /// (directories first, then relative path), pack. Mirrors
    /// `fileService.ensureWorkspaceFileIndex`.
    fn workspace_index(&self, root_path: &str) -> Result<String, HandlerError> {
        self.scope.lock().unwrap().allow(root_path);
        let rules = ignore_rules::load(Path::new(root_path));
        let fingerprint = rules.fingerprint.clone();
        if let Some((_cached_fingerprint, packed)) = self
            .workspace_indexes
            .lock()
            .unwrap()
            .get(root_path)
            .filter(|(cached, _)| *cached == fingerprint)
        {
            return Ok(packed.clone());
        }
        let found = walk::walk_workspace(Path::new(root_path), &rules.content)
            .map_err(|error| HandlerError::message(error.reason))?;
        let mut entries: Vec<IndexEntry> = found
            .into_iter()
            .map(|entry| {
                let r#type = entry.kind().to_string();
                IndexEntry {
                    name: entry.name,
                    path: entry.path,
                    relative_path: entry.relative_path,
                    r#type,
                }
            })
            .collect();
        workspace_index::sort_entries(&mut entries);
        let packed = workspace_index::pack_entries(&entries);
        self.workspace_indexes
            .lock()
            .unwrap()
            .insert(root_path.to_string(), (fingerprint, packed.clone()));
        Ok(packed)
    }
}

impl ChannelHandler for FileService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        let params = args.first().cloned().unwrap_or(JsonValue::Null);
        let get_str = |field: &str| -> Result<&str, HandlerError> {
            params
                .get(field)
                .and_then(JsonValue::as_str)
                .ok_or_else(|| HandlerError::message(format!("file.{method} requires a `{field}` string")))
        };
        match method {
            "readdir" => {
                let path = get_str("path")?;
                let include_hidden = params.get("includeHidden").and_then(JsonValue::as_bool).unwrap_or(false);
                let canonical = self.resolve(path, "scandir")?;
                let entries = walk::read_dir(&canonical, include_hidden).map_err(|e| HandlerError::message(e.reason))?;
                let views: Vec<FileEntryView> = entries
                    .into_iter()
                    .map(|entry| {
                        let r#type = entry.kind().to_string();
                        FileEntryView {
                            name: entry.name,
                            path: entry.path,
                            r#type,
                            is_symbolic_link: Some(entry.is_symlink),
                        }
                    })
                    .collect();
                serde_json::to_value(&views).map_err(handler_error)
            }
            "stat" => serde_json::to_value(self.stat_view(get_str("path")?)?).map_err(handler_error),
            "resolvePath" => {
                let path = get_str("path")?;
                let canonical = self.resolve(path, "resolve")?;
                Ok(JsonValue::String(Self::canonical_string(&canonical)))
            }
            "checkFilesExist" => {
                let paths = params
                    .get("paths")
                    .and_then(JsonValue::as_array)
                    .cloned()
                    .ok_or_else(|| HandlerError::message("file.checkFilesExist requires a `paths` array"))?;
                let roots = Roots::from_raw(&self.roots());
                let mut out = Vec::with_capacity(paths.len());
                for item in paths {
                    let Some(candidate) = item.as_str() else { continue };
                    let exists = match roots.admit(candidate, "stat") {
                        Ok(Some(canonical)) => std::fs::metadata(&canonical)
                            .map(|meta| meta.is_file())
                            .unwrap_or(false),
                        Ok(None) => false,
                        Err(error) => return Err(HandlerError::message(error.reason)),
                    };
                    out.push(serde_json::json!({ "path": candidate, "exists": exists }));
                }
                serde_json::to_value(&out).map_err(handler_error)
            }
            "readTextFile" => {
                let path = get_str("path")?;
                let offset = params.get("offset").and_then(JsonValue::as_f64);
                let length = params.get("length").and_then(JsonValue::as_f64);
                let canonical = self.resolve(path, "read")?;
                let size = std::fs::metadata(&canonical)
                    .map_err(|error| HandlerError::message(format!("{error}")))?
                    .len();
                let slice = reads::read_text_slice(&canonical, path, size, offset, length)
                    .map_err(|e| HandlerError::message(e.reason))?;
                let view = FileTextView {
                    path: path.to_string(),
                    content: slice.content,
                    offset: slice.offset,
                    bytes_read: slice.bytes_read,
                    total_bytes: slice.total_bytes,
                    truncated: slice.truncated,
                    is_binary: slice.is_binary,
                };
                serde_json::to_value(&view).map_err(handler_error)
            }
            "readMediaPreview" => {
                let path = get_str("path")?;
                let max_bytes = params.get("maxBytes").and_then(JsonValue::as_f64).unwrap_or(2_000_000.0) as u64;
                let canonical = self.resolve(path, "read")?;
                let size = std::fs::metadata(&canonical)
                    .map_err(|error| HandlerError::message(format!("{error}")))?
                    .len();
                let bytes = reads::read_whole_for_preview(&canonical, path, size, max_bytes)
                    .map_err(|e| HandlerError::message(e.reason))?;
                let view = FileMediaPreviewView {
                    path: path.to_string(),
                    media_type: reads::infer_media_type(path),
                    data_base64: reads::encode_base64(&bytes),
                    total_bytes: size,
                };
                serde_json::to_value(&view).map_err(handler_error)
            }
            "readBinaryPreview" => {
                let path = get_str("path")?;
                let max_bytes = params.get("maxBytes").and_then(JsonValue::as_f64).unwrap_or(2_000_000.0) as u64;
                let canonical = self.resolve(path, "read")?;
                let size = std::fs::metadata(&canonical)
                    .map_err(|error| HandlerError::message(format!("{error}")))?
                    .len();
                let bytes = reads::read_whole_for_preview(&canonical, path, size, max_bytes)
                    .map_err(|e| HandlerError::message(e.reason))?;
                let view = FileBinaryPreviewView {
                    path: path.to_string(),
                    data_base64: reads::encode_base64(&bytes),
                    total_bytes: size,
                };
                serde_json::to_value(&view).map_err(handler_error)
            }
            "createDefaultWorkspace" => {
                let base_dir = self.scratch_base_dir();
                let (path, _created) = self.ensure_workspace_directory(&base_dir, None)?;
                Ok(serde_json::json!({ "path": path }))
            }
            "ensureConversationWorkspace" => {
                // The conversation workspace lives under the data base dir.
                let base_dir = paths::app_config_dir().join("conversation-workspace");
                let (path, created) = self.ensure_workspace_directory(&base_dir, None)?;
                Ok(serde_json::json!({ "path": path, "created": created, "workspacePurpose": "conversation" }))
            }
            "createScratchWorkspace" => {
                let name = get_str("name")?;
                let base_dir = self.scratch_base_dir();
                let (path, _created) = self.ensure_workspace_directory(&base_dir, Some(name))?;
                Ok(serde_json::json!({ "path": path }))
            }

            "searchWorkspaceFiles" => {
                let root_path = get_str("rootPath")?;
                let query = params
                    .get("query")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("searchWorkspaceFiles requires a `query`"))?;
                let limit = params
                    .get("limit")
                    .and_then(JsonValue::as_u64)
                    .map(|value| value as usize)
                    .unwrap_or(workspace_index::SEARCH_DISPLAY_CAP);
                let entries = workspace_index::unpack_entries(&self.workspace_index(root_path)?, root_path);
                let results = workspace_index::search(&entries, query, limit);
                serde_json::to_value(&results).map_err(handler_error)
            }
            "listWorkspaceFilesLength" => {
                let root_path = get_str("rootPath")?;
                Ok(JsonValue::from(self.workspace_index(root_path)?.len() as u64))
            }
            "listWorkspaceFilesRange" => {
                let root_path = get_str("rootPath")?;
                let packed = self.workspace_index(root_path)?;
                let offset = params.get("offset").and_then(JsonValue::as_u64).unwrap_or(0) as usize;
                let length = params.get("length").and_then(JsonValue::as_u64).unwrap_or(0) as usize;
                let start = offset.min(packed.len());
                let end = (offset + length).min(packed.len());
                Ok(JsonValue::String(packed[start..end].to_string()))
            }
            "readWorkspaceFileSearchIgnore" => {
                let root_path = get_str("rootPath")?;
                self.scope.lock().unwrap().allow(root_path);
                let (content, source) = ignore_rules::read_for_settings(Path::new(root_path));
                Ok(serde_json::json!({ "content": content, "source": source }))
            }
            "applyWorkspaceFileSearchIgnoreTransform" => {
                let root_path = get_str("rootPath")?;
                self.scope.lock().unwrap().allow(root_path);
                let transform = params
                    .get("transform")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("applyTransform requires a `transform`"))?;
                let mode = match transform {
                    "sync-gitignore" => ignore_rules::Transform::SyncGitignore,
                    "reset-defaults" => ignore_rules::Transform::ResetDefaults,
                    other => {
                        return Err(HandlerError::message(format!(
                            "unknown ignore transform: {other}"
                        )))
                    }
                };
                let content = ignore_rules::transform_for_settings(Path::new(root_path), mode);
                Ok(serde_json::json!({ "content": content }))
            }
            "writeWorkspaceFileSearchIgnore" => {
                let root_path = get_str("rootPath")?;
                let content = params
                    .get("content")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| HandlerError::message("writeIgnore requires a `content`"))?;
                self.scope.lock().unwrap().allow(root_path);
                ignore_rules::atomic_write(&Path::new(root_path).join(".zcodeignore"), content)
                    .map_err(|error| HandlerError::message(error.reason))?;
                Ok(JsonValue::Null)
            }
            other => Err(HandlerError::message(format!(
                "file.{other} is not implemented by the Rust host"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        _event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        None
    }

    /// `readFileRange` answers with a top-level byte range (the raw byte
    /// channel); every other method returns `None` and goes through `call`.
    fn call_binary(
        &self,
        _ctx: &str,
        method: &str,
        args: &[JsonValue],
    ) -> Option<Result<Vec<u8>, HandlerError>> {
        if method != "readFileRange" {
            return None;
        }
        let params = args.first().cloned().unwrap_or(JsonValue::Null);
        Some(self.read_file_range(&params))
    }
}

impl FileService {
    /// `readFileRange`: resolve through the allowlist, then read a byte range.
    fn read_file_range(&self, params: &JsonValue) -> Result<Vec<u8>, HandlerError> {
        let path = params
            .get("path")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("readFileRange requires a `path`"))?;
        let offset = params.get("offset").and_then(JsonValue::as_f64);
        let length = params.get("length").and_then(JsonValue::as_f64);
        let canonical = self.resolve(path, "read")?;
        let size = std::fs::metadata(&canonical)
            .map_err(|error| HandlerError::message(format!("{error}")))?
            .len();
        reads::read_range(&canonical, path, size, offset, length)
            .map_err(|error| HandlerError::message(error.reason))
    }
}

fn handler_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::message(error.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn home_dir(name: &str) -> PathBuf {
        let dir = std::path::Path::new(&paths::homedir()).join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_workspace_index_lists_and_fuzzy_searches_files() {
        let dir = home_dir("wsindex");
        std::fs::write(dir.join("alpha.txt"), b"a").unwrap();
        std::fs::write(dir.join("beta.md"), b"b").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("gamma.ts"), b"c").unwrap();
        // An ignored path must not appear in the index.
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules").join("dep.js"), b"x").unwrap();
        std::fs::write(dir.join(".zcodeignore"), b"node_modules/\n").unwrap();

        let service = FileService::new();
        let root = dir.to_string_lossy().into_owned();

        let length = service
            .call("", "listWorkspaceFilesLength", &[serde_json::json!({ "rootPath": root })])
            .expect("length");
        // `listWorkspaceFilesLength` is the packed string length (TS
        // `packed.length`), not an entry count. Verify the index is non-empty
        // and the search below proves the entry set (node_modules excluded).
        assert!(length.as_u64().unwrap_or(0) > 0, "packed index is non-empty: {length}");

        // Fuzzy search finds "alpha".
        let search = service
            .call("", "searchWorkspaceFiles", &[serde_json::json!({ "rootPath": root, "query": "alp" })])
            .expect("search");
        let names: Vec<_> = search
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry["name"].as_str())
            .collect();
        assert!(names.contains(&"alpha.txt"), "search should find alpha: {search}");
        assert!(!names.contains(&"dep.js"), "node_modules must be excluded: {search}");

        // Range fetch returns a slice of the packed index.
        let range = service
            .call("", "listWorkspaceFilesRange", &[serde_json::json!({ "rootPath": root, "offset": 0, "length": 8 })])
            .expect("range");
        assert!(!range.as_str().unwrap().is_empty(), "range is a non-empty packed slice: {range}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod binary_tests {
    use super::*;

    #[test]
    fn read_file_range_returns_top_level_bytes() {
        let dir = std::path::Path::new(&paths::homedir())
            .join(format!("zcode-range-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("data.bin");
        std::fs::write(&file, b"0123456789").unwrap();

        let service = FileService::new();
        let params = serde_json::json!({
            "path": file.to_string_lossy(),
            "offset": 2,
            "length": 4
        });
        let bytes = service.read_file_range(&params).expect("read range");
        assert_eq!(bytes, b"2345", "bytes 2..6: {bytes:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn call_binary_answers_only_read_file_range() {
        let service = FileService::new();
        assert!(service.call_binary("", "readFileRange", &[serde_json::json!({"path":"/x","offset":0,"length":1})]).is_some());
        assert!(service.call_binary("", "readdir", &[serde_json::json!({"path":"/x"})]).is_none());
    }
}
