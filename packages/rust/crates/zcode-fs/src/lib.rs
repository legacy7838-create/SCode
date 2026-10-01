//! zcode-fs: the native filesystem surface of `IFileService`.
//!
//! Spec: `docs/specs/rust-native-fs.md` (written before this crate).
//!
//! Replaces, and deletes:
//! - `packages/services/src/file/fileService.ts:371-588` — `readdir`, `stat`,
//!   `checkFilesExist`, `resolvePath`, `readTextFile`, `readFileRange`,
//!   `readMediaPreview`, `readBinaryPreview`.
//! - `packages/services/src/file/fileService.ts:430-476` + `:105-114` — the three
//!   workspace-directory methods and scratch-name validation.
//! - `packages/services/src/file/fileService.ts:176-226, 290-348` — entry-type
//!   resolution, the `.zcodeignore` fingerprint, and the repository walk.
//! - `packages/services/src/file/workspaceFileIgnore.ts` (451 lines, deleted) —
//!   the `.zcodeignore` template, section transforms, atomic write, fail-open
//!   load chain, and the gitignore matcher.
//! - `packages/services/src/file/workspaceFileMentionFilter.ts` (142 lines,
//!   deleted) — the binary-extension blocklist and hidden-directory semantics.
//!
//! ## The invariant this port exists for
//!
//! `fileService.ts:425-428` was a bare `realpath` with no containment, so every
//! read entry point opened whatever absolute path the caller passed. The
//! predecessor could not fix that from TypeScript: a check added there is one
//! more thing the next call site can forget, and three different hosts
//! (`packages/desktop/src/host/index.ts`, `packages/server/src/entry-http.ts`,
//! `packages/zcode-server-cli/src/server-core/core.ts`) build these services.
//!
//! Here, **every export that touches a path takes a required `roots: string[]`.**
//! There is no optional form, no default, and no flag to skip the check, so a
//! call site that forgets to confine does not compile and a caller that bypasses
//! the wrapper still cannot omit the allowlist. The requested path is
//! canonicalized — every symlink resolved, every `..` folded — and only then
//! compared against the canonical roots. See `containment`, and the spec's
//! Failure-semantics table, which the tests here mirror row for row.
//!
//! ## Other invariants
//!
//! - **Event loop (rule 4).** All fourteen filesystem exports are `AsyncTask`.
//!   A 25 MB preview, a 370,000-entry walk and a 15-path existence batch all
//!   exceed 1 ms. The three pure exports are the only synchronous ones.
//! - **Process (rule 5).** Zero child processes: the crate links only `std`,
//!   `napi`, `base64` and the `ignore` gitignore matcher.
//! - **Byte boundary (rule 8).** `read_file_range` returns napi `Buffer`, not
//!   `Vec<u8>`, so a `Uint8Array` in yields a `Uint8Array` out. It is the only
//!   export that moves bytes; the two previews base64-encode in Rust because
//!   their wire contract is `dataBase64: string`.
//! - **No behavior fork (rule 3).** The 25 MB binary and 8 MB media preview
//!   ceilings, the 256 KB / 1 MB read clamps, the `offset >= size` early return,
//!   the `.zcodeignore` content shaping and the matcher tables are reproduced
//!   exactly, down to the `node:fs` error `code` and `message` (see
//!   [`js_error`]). The one deliberate divergence is documented in the spec:
//!   entry *sorting* stays in TypeScript because `localeCompare` is ICU
//!   collation and is not reproducible byte-for-byte in Rust.
//! - **Renderer barrier (rule 9).** `IFileService` itself
//!   (`packages/services/src/file/file.ts`) does not import `@zcode/rust`; only
//!   the Node-only implementation module does.

pub mod containment;
mod ignore_rules;
mod mention_filter;
mod reads;
mod walk;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::ptr;

use napi::bindgen_prelude::{AsyncTask, Buffer, ToNapiValue, TypeName};
use napi::{Env, Error, Result as NapiResult, Status, Task};
use napi_derive::napi;

use containment::{FsResult, Roots};
use ignore_rules::Transform;
use reads::TextSlice;
use walk::{Entry, WorkspaceEntry};

// ---------------------------------------------------------------------------
// Requests. Every one of these declares `roots` as a REQUIRED field: napi
// rejects the call before `compute()` runs when it is missing, and `roots: []`
// rejects every path. There is no "unconfined" spelling anywhere in the crate.
// ---------------------------------------------------------------------------

#[derive(Debug)]
#[napi(object)]
pub struct ReaddirRequest {
  pub path: String,
  /// Allowlist of directories this call may touch. See the module docs.
  pub roots: Vec<String>,
  pub include_hidden: Option<bool>,
}

#[derive(Debug)]
#[napi(object)]
pub struct StatRequest {
  pub path: String,
  pub roots: Vec<String>,
}

#[derive(Debug)]
#[napi(object)]
pub struct CheckFilesExistRequest {
  pub paths: Vec<String>,
  pub roots: Vec<String>,
}

#[derive(Debug)]
#[napi(object)]
pub struct ResolvePathRequest {
  pub path: String,
  pub roots: Vec<String>,
}

#[derive(Debug)]
#[napi(object)]
pub struct ReadTextFileRequest {
  pub path: String,
  pub roots: Vec<String>,
  pub offset: Option<f64>,
  pub length: Option<f64>,
}

#[derive(Debug)]
#[napi(object)]
pub struct ReadFileRangeRequest {
  pub path: String,
  pub roots: Vec<String>,
  pub offset: Option<f64>,
  pub length: Option<f64>,
}

#[derive(Debug)]
#[napi(object)]
pub struct ReadPreviewRequest {
  pub path: String,
  pub roots: Vec<String>,
  pub max_bytes: Option<f64>,
}

#[derive(Debug)]
#[napi(object)]
pub struct EnsureWorkspaceDirectoryRequest {
  /// Platform-resolved parent (`os.homedir()` + the scratch root name, or the
  /// conversation workspace dir). Supplied by the host because `os.homedir()`
  /// has per-OS resolution semantics; the name rules and the `mkdir` are native.
  pub base_dir: String,
  /// Absent or empty means "use `base_dir` itself" (the default workspace).
  pub name: Option<String>,
  pub roots: Vec<String>,
}

#[derive(Debug)]
#[napi(object)]
pub struct WorkspaceRootRequest {
  pub root_path: String,
  pub roots: Vec<String>,
}

#[derive(Debug)]
#[napi(object)]
pub struct WalkWorkspaceRequest {
  pub root_path: String,
  pub roots: Vec<String>,
  /// The effective `.zcodeignore` content, from `load_workspace_ignore_rules`.
  pub ignore_rules: String,
}

#[derive(Debug)]
#[napi(object)]
pub struct TransformIgnoreRequest {
  pub root_path: String,
  pub roots: Vec<String>,
  pub transform: String,
}

#[derive(Debug)]
#[napi(object)]
pub struct WriteIgnoreRequest {
  pub root_path: String,
  pub roots: Vec<String>,
  pub content: String,
}

#[derive(Debug)]
#[napi(object)]
pub struct MatchIgnorePathRequest {
  pub rules: String,
  pub relative_path: String,
  pub is_directory: bool,
}

#[derive(Debug)]
#[napi(object)]
pub struct EvaluateFileEntryRequest {
  pub name: String,
  pub relative_path: String,
  #[napi(js_name = "type")]
  pub kind: String,
  pub ignore_rules_active: bool,
}

#[derive(Debug)]
#[napi(object)]
pub struct BuildIgnoreTemplateRequest {
  pub gitignore: Option<String>,
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

#[derive(Debug)]
#[napi(object)]
pub struct FileEntry {
  pub name: String,
  pub path: String,
  #[napi(js_name = "type")]
  pub kind: String,
  pub is_symbolic_link: bool,
}

#[derive(Debug)]
#[napi(object)]
pub struct FileStat {
  pub path: String,
  #[napi(js_name = "type")]
  pub kind: String,
  pub size: Option<f64>,
  pub mtime_ms: Option<f64>,
}

#[derive(Debug)]
#[napi(object)]
pub struct PathExistence {
  pub path: String,
  pub exists: bool,
}

#[derive(Debug)]
#[napi(object)]
pub struct TextSliceResult {
  pub path: String,
  pub content: String,
  pub offset: f64,
  pub bytes_read: f64,
  pub total_bytes: f64,
  pub truncated: bool,
  pub is_binary: bool,
}

#[derive(Debug)]
#[napi(object)]
pub struct MediaPreview {
  pub path: String,
  pub media_type: String,
  pub data_base64: String,
  pub total_bytes: f64,
}

#[derive(Debug)]
#[napi(object)]
pub struct BinaryPreview {
  pub path: String,
  pub data_base64: String,
  pub total_bytes: f64,
}

#[derive(Debug)]
#[napi(object)]
pub struct WorkspaceDirectory {
  pub path: String,
  pub created: bool,
}

#[derive(Debug)]
#[napi(object)]
pub struct LoadedIgnoreRules {
  pub content: String,
  pub source: String,
  pub created: bool,
  /// Present when the load chain degraded; the host logs it once, exactly as
  /// the predecessor's logger did.
  pub degraded_reason: Option<String>,
  /// `mtimeMs:size` of `.zcodeignore`, or `none`. The host cache signature.
  pub fingerprint: String,
}

#[derive(Debug)]
#[napi(object)]
pub struct IgnoreContent {
  pub content: String,
  pub source: String,
}

#[derive(Debug)]
#[napi(object)]
pub struct IgnoreTransformResult {
  pub content: String,
}

#[derive(Debug)]
#[napi(object)]
pub struct WorkspaceFileEntry {
  pub name: String,
  pub path: String,
  pub relative_path: String,
  #[napi(js_name = "type")]
  pub kind: String,
}

#[derive(Debug)]
#[napi(object)]
pub struct FileDecision {
  pub include: bool,
  pub traverse: bool,
}

// ---------------------------------------------------------------------------
// The async task every filesystem export runs on
// ---------------------------------------------------------------------------

/// One generic task, so each export is a `spawn(|| { ... })` rather than a
/// duplicated `compute`/`resolve` pair. It also owns the error hand-off:
/// `compute` runs on a libuv thread where no `Env` exists, so the failure is
/// parked here and `reject` — which does have one — turns it into a JavaScript
/// `Error` carrying the original `code`.
pub struct FsTask<O: ToNapiValue + TypeName + Send + 'static> {
  body: Option<Box<dyn FnOnce() -> FsResult<O> + Send + 'static>>,
  failure: Option<Error<String>>,
}

impl<O: ToNapiValue + TypeName + Send + 'static> FsTask<O> {
  /// Runs the task body on the calling thread. The tests use this instead of
  /// going through napi, because they assert the *logic*; the JavaScript half
  /// (promise settling, `Buffer` identity, `Error.code`) is asserted by the
  /// direct-load smoke in the port report.
  #[cfg(test)]
  pub fn run(mut self) -> FsResult<O> {
    (self.body.take().expect("FsTask ran twice"))()
  }

  fn new(body: impl FnOnce() -> FsResult<O> + Send + 'static) -> Self {
    Self {
      body: Some(Box::new(body)),
      failure: None,
    }
  }
}

impl<O: ToNapiValue + TypeName + Send + 'static> Task for FsTask<O> {
  type Output = O;
  type JsValue = O;

  fn compute(&mut self) -> NapiResult<Self::Output> {
    let body = self.body.take().expect("FsTask ran twice");
    match body() {
      Ok(value) => Ok(value),
      Err(failure) => {
        self.failure = Some(failure);
        // The reason here is discarded: `reject` re-reads the parked failure
        // and throws the real object. This `Err` only says "it failed".
        Err(Error::new(Status::GenericFailure, ""))
      }
    }
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
    Ok(output)
  }

  fn reject(&mut self, env: Env, _err: Error) -> NapiResult<Self::JsValue> {
    let failure = self
      .failure
      .take()
      .expect("FsTask rejected without a recorded failure");
    Err(js_error(env, failure))
  }
}

/// Builds a JavaScript `Error` whose `code` is this crate's own errno-style
/// string and whose `message` is the `node:fs`-shaped text, then hands it back
/// as an `Error` that retains a reference to that exact object.
///
/// napi's own path (`Error::into_value`) would synthesize the object from
/// `status`/`reason`, and `Status` has no per-errno variant, so every failure
/// would surface as `code: "GenericFailure"`. `PreviewPane.tsx:127-128` reads
/// `error.code === "ENOENT"` on exactly these reads, so the code has to survive
/// the boundary; retaining the object is what makes that happen.
fn js_error(env: Env, failure: Error<String>) -> Error {
  // SAFETY (both calls): `env.raw()` is a live env and the arguments are
  // borrowed Rust values, so napi only reads them for the duration of the call.
  let Ok(code) = (unsafe { ToNapiValue::to_napi_value(env.raw(), &failure.status) }) else {
    return Error::new(Status::GenericFailure, failure.reason);
  };
  let Ok(reason) = (unsafe { ToNapiValue::to_napi_value(env.raw(), &failure.reason) }) else {
    return Error::new(Status::GenericFailure, failure.reason);
  };
  let mut raw = ptr::null_mut();
  // SAFETY: `raw` is a fresh out-pointer; `code` and `reason` are napi values
  // created on this same env a line above.
  let status = unsafe { napi::sys::napi_create_error(env.raw(), code, reason, &mut raw) };
  if status != napi::sys::Status::napi_ok || raw.is_null() {
    return Error::new(Status::GenericFailure, failure.reason);
  }
  // SAFETY: `raw` is a JS Error freshly created on this env and owned by it.
  let unknown = unsafe { napi::bindgen_prelude::Unknown::from_raw_unchecked(env.raw(), raw) };
  Error::from(unknown)
}

pub fn spawn<O: ToNapiValue + TypeName + Send + 'static>(
  body: impl FnOnce() -> FsResult<O> + Send + 'static,
) -> FsTask<O> {
  FsTask::new(body)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// `mtimeMs` as the wire contract carries it.
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
  meta
    .modified()
    .ok()
    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|delta| delta.as_secs_f64() * 1000.0)
    .unwrap_or(0.0)
}

/// The three guard steps every read shares, in the predecessor's order:
/// confine → stat → assert the target is a file. The file check runs *after*
/// confinement so an out-of-root probe reports the escape, not "not a file".
fn confined_file(
  roots: &Roots,
  requested: &str,
) -> FsResult<(PathBuf, u64)> {
  let canonical = roots.resolve(requested, "stat")?;
  let meta = std::fs::metadata(&canonical)
    .map_err(|error| containment::syscall_error(&error, "stat", requested))?;
  if !meta.is_file() {
    return Err(containment::not_a_file(requested));
  }
  Ok((canonical, meta.len()))
}

fn to_file_entry(entry: &Entry) -> FileEntry {
  FileEntry {
    name: entry.name.clone(),
    path: entry.path.clone(),
    kind: entry.kind().to_string(),
    is_symbolic_link: entry.is_symlink,
  }
}

fn to_workspace_entry(entry: &WorkspaceEntry) -> WorkspaceFileEntry {
  WorkspaceFileEntry {
    name: entry.name.clone(),
    path: entry.path.clone(),
    relative_path: entry.relative_path.clone(),
    kind: entry.kind().to_string(),
  }
}

// ---------------------------------------------------------------------------
// 1. readdir
// ---------------------------------------------------------------------------

fn readdir_task(request: ReaddirRequest) -> FsTask<Vec<FileEntry>> {

  let roots = Roots::from_raw(&request.roots);
  let path = request.path.clone();
  let include_hidden = request.include_hidden.unwrap_or(false);
  spawn(move || {
    let canonical = roots.resolve(&path, "scandir")?;
    Ok(
      walk::read_dir(&canonical, include_hidden)?
        .iter()
        .map(to_file_entry)
        .collect(),
    )
  })
}

#[napi]
pub fn readdir(request: ReaddirRequest) -> AsyncTask<FsTask<Vec<FileEntry>>> {
  AsyncTask::new(readdir_task(request))
}


// ---------------------------------------------------------------------------
// 2. stat
// ---------------------------------------------------------------------------

fn stat_task(request: StatRequest) -> FsTask<FileStat> {
  let roots = Roots::from_raw(&request.roots);
  let path = request.path;
  spawn(move || {
    let canonical = roots.resolve(&path, "stat")?;
    let meta = std::fs::metadata(&canonical)
      .map_err(|error| containment::syscall_error(&error, "stat", &path))?;
    let is_directory = meta.is_dir();
    Ok(FileStat {
      path,
      kind: if is_directory { "directory" } else { "file" }.to_string(),
      // The predecessor reported size/mtime for files only: a directory's
      // "size" is meaningless and the preview layer branches on it.
      size: (!is_directory).then_some(meta.len() as f64),
      mtime_ms: (!is_directory).then(|| mtime_ms(&meta)),
    })
  })
}

#[napi]
pub fn stat(request: StatRequest) -> AsyncTask<FsTask<FileStat>> {
  AsyncTask::new(stat_task(request))
}


// ---------------------------------------------------------------------------
// 3. check_files_exist
// ---------------------------------------------------------------------------

fn check_files_exist_task(request: CheckFilesExistRequest) -> FsTask<Vec<PathExistence>> {

  let roots = Roots::from_raw(&request.roots);
  let paths = request.paths;
  spawn(move || {
    // The cap lives here, not on the host, so a caller that batches differently
    // cannot turn a 15-path check into an unbounded stat storm.
    if paths.len() > reads::FILE_EXISTENCE_BATCH_LIMIT {
      return Err(containment::reject(format!(
        "File existence check supports at most {} paths.",
        reads::FILE_EXISTENCE_BATCH_LIMIT
      )));
    }
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
      // A path that is inside the allowlist but absent is a legitimate "no" —
      // that is the whole point of the call. A path *outside* the allowlist is
      // not: "you may not look there" is not the same answer as "it is not
      // there", and collapsing them would hide the attempt, so the batch fails.
      let exists = match roots.admit(&path, "stat")? {
        Some(canonical) => std::fs::metadata(&canonical)
          .map(|meta| meta.is_file())
          .unwrap_or(false),
        None => false,
      };
      out.push(PathExistence { path, exists });
    }
    Ok(out)
  })
}

#[napi]
pub fn check_files_exist(request: CheckFilesExistRequest) -> AsyncTask<FsTask<Vec<PathExistence>>> {
  AsyncTask::new(check_files_exist_task(request))
}


// ---------------------------------------------------------------------------
// 4. resolve_path
// ---------------------------------------------------------------------------

fn resolve_path_task(request: ResolvePathRequest) -> FsTask<String> {
  let roots = Roots::from_raw(&request.roots);
  let path = request.path;
  spawn(move || {
    let canonical = roots.resolve(&path, "realpath")?;
    Ok(canonical.to_string_lossy().into_owned())
  })
}

#[napi]
pub fn resolve_path(request: ResolvePathRequest) -> AsyncTask<FsTask<String>> {
  AsyncTask::new(resolve_path_task(request))
}


// ---------------------------------------------------------------------------
// 5. read_text_file
// ---------------------------------------------------------------------------

fn read_text_file_task(request: ReadTextFileRequest) -> FsTask<TextSliceResult> {
  let roots = Roots::from_raw(&request.roots);
  let path = request.path;
  let offset = request.offset;
  let length = request.length;
  spawn(move || {
    let (canonical, size) = confined_file(&roots, &path)?;
    let slice = reads::read_text_slice(&canonical, &path, size, offset, length)?;
    Ok(text_slice_result(&path, slice))
  })
}

#[napi]
pub fn read_text_file(request: ReadTextFileRequest) -> AsyncTask<FsTask<TextSliceResult>> {
  AsyncTask::new(read_text_file_task(request))
}


fn text_slice_result(path: &str, slice: TextSlice) -> TextSliceResult {
  TextSliceResult {
    path: path.to_string(),
    content: slice.content,
    offset: slice.offset as f64,
    bytes_read: slice.bytes_read as f64,
    total_bytes: slice.total_bytes as f64,
    truncated: slice.truncated,
    is_binary: slice.is_binary,
  }
}

// ---------------------------------------------------------------------------
// 6. read_file_range — the only export that moves raw bytes (rule 8)
// ---------------------------------------------------------------------------

fn read_file_range_task(request: ReadFileRangeRequest) -> FsTask<Buffer> {
  let roots = Roots::from_raw(&request.roots);
  let path = request.path;
  let offset = request.offset;
  let length = request.length;
  spawn(move || {
    let (canonical, size) = confined_file(&roots, &path)?;
    let bytes = reads::read_range(&canonical, &path, size, offset, length)?;
    Ok(Buffer::from(bytes))
  })
}

#[napi]
pub fn read_file_range(request: ReadFileRangeRequest) -> AsyncTask<FsTask<Buffer>> {
  AsyncTask::new(read_file_range_task(request))
}


// ---------------------------------------------------------------------------
// 7-8. the two preview reads
// ---------------------------------------------------------------------------

fn read_media_preview_task(request: ReadPreviewRequest) -> FsTask<MediaPreview> {
  let roots = Roots::from_raw(&request.roots);
  let path = request.path;
  let max_bytes = request.max_bytes;
  spawn(move || {
    let (canonical, size) = confined_file(&roots, &path)?;
    let ceiling = reads::clamp_bytes(
      max_bytes,
      reads::DEFAULT_MEDIA_PREVIEW_BYTES,
      reads::MAX_MEDIA_PREVIEW_BYTES,
    );
    let bytes = reads::read_whole_for_preview(&canonical, &path, size, ceiling)?;
    Ok(MediaPreview {
      media_type: reads::infer_media_type(&path),
      path,
      data_base64: reads::encode_base64(&bytes),
      total_bytes: size as f64,
    })
  })
}

#[napi]
pub fn read_media_preview(request: ReadPreviewRequest) -> AsyncTask<FsTask<MediaPreview>> {
  AsyncTask::new(read_media_preview_task(request))
}


fn read_binary_preview_task(request: ReadPreviewRequest) -> FsTask<BinaryPreview> {
  let roots = Roots::from_raw(&request.roots);
  let path = request.path;
  let max_bytes = request.max_bytes;
  spawn(move || {
    let (canonical, size) = confined_file(&roots, &path)?;
    let ceiling = reads::clamp_bytes(
      max_bytes,
      reads::DEFAULT_BINARY_PREVIEW_BYTES,
      reads::MAX_BINARY_PREVIEW_BYTES,
    );
    let bytes = reads::read_whole_for_preview(&canonical, &path, size, ceiling)?;
    Ok(BinaryPreview {
      path,
      data_base64: reads::encode_base64(&bytes),
      total_bytes: size as f64,
    })
  })
}

#[napi]
pub fn read_binary_preview(request: ReadPreviewRequest) -> AsyncTask<FsTask<BinaryPreview>> {
  AsyncTask::new(read_binary_preview_task(request))
}


// ---------------------------------------------------------------------------
// 9. ensure_workspace_directory
// ---------------------------------------------------------------------------

fn ensure_workspace_directory_task(
  request: EnsureWorkspaceDirectoryRequest,
) -> FsTask<WorkspaceDirectory> {
  let roots = Roots::from_raw(&request.roots);
  let base_dir = request.base_dir;
  let name = request.name;
  spawn(move || {
    // `validateScratchWorkspaceName`: a present-but-blank name is an error, not
    // a request for the base directory. Only an absent name means "the default
    // workspace".
    let target = match name {
      None => base_dir.clone(),
      Some(name) => {
        let trimmed = name.trim();
        if trimmed.is_empty() {
          return Err(containment::reject("Workspace name is required."));
        }
        if trimmed.contains('/') || trimmed.contains('\\') {
          return Err(containment::reject(
            "Workspace name cannot contain path separators.",
          ));
        }
        // Joined here rather than in the host, and only after the name is known
        // to be a single segment, so nothing can smuggle a separator through.
        Path::new(&base_dir)
          .join(trimmed)
          .to_string_lossy()
          .into_owned()
      }
    };
    // `created` is `true` only when this call is the one that made the
    // directory: libuv's recursive mkdir resolves to the first path it created
    // and to `undefined` when there was nothing to create, which is exactly the
    // distinction the predecessor's `(await mkdir(...)) !== undefined` made.
    let already_there = roots.admit(&target, "realpath")?.is_some();
    let created = match std::fs::create_dir_all(&target) {
      Ok(()) => !already_there,
      Err(error) => {
        // Losing a create race — or a read-only parent that already holds the
        // directory — is not a failure as long as the target is a directory.
        let canonical = roots.resolve(&target, "realpath")?;
        let meta = std::fs::metadata(&canonical)
          .map_err(|_| containment::syscall_error(&error, "mkdir", &target))?;
        if meta.is_dir() {
          false
        } else {
          return Err(not_a_directory(&target));
        }
      }
    };
    let canonical = roots.resolve(&target, "realpath")?;
    let meta = std::fs::metadata(&canonical)
      .map_err(|error| containment::syscall_error(&error, "stat", &target))?;
    if !meta.is_dir() {
      return Err(not_a_directory(&target));
    }
    Ok(WorkspaceDirectory {
      path: canonical.to_string_lossy().into_owned(),
      created,
    })
  })
}

#[napi]
pub fn ensure_workspace_directory(
  request: EnsureWorkspaceDirectoryRequest,
) -> AsyncTask<FsTask<WorkspaceDirectory>> {
  AsyncTask::new(ensure_workspace_directory_task(request))
}


/// The predecessor named the *requested* path here, not the canonical one, so
/// the message is unchanged for a caller that passed a symlinked root.
fn not_a_directory(requested: &str) -> Error<String> {
  containment::reject(format!("Workspace path is not a directory: {requested}"))
}

// ---------------------------------------------------------------------------
// 10-11. the ignore rules and the workspace walk
// ---------------------------------------------------------------------------

fn load_workspace_ignore_rules_task(
  request: WorkspaceRootRequest,
) -> FsTask<LoadedIgnoreRules> {
  let roots = Roots::from_raw(&request.roots);
  let root_path = request.root_path;
  spawn(move || {
    let canonical = roots.resolve(&root_path, "realpath")?;
    let loaded = ignore_rules::load(&canonical);
    Ok(LoadedIgnoreRules {
      content: loaded.content,
      source: loaded.source.as_str().to_string(),
      created: loaded.created,
      degraded_reason: loaded.degraded_reason,
      fingerprint: loaded.fingerprint,
    })
  })
}

#[napi]
pub fn load_workspace_ignore_rules(
  request: WorkspaceRootRequest,
) -> AsyncTask<FsTask<LoadedIgnoreRules>> {
  AsyncTask::new(load_workspace_ignore_rules_task(request))
}


fn walk_workspace_task(request: WalkWorkspaceRequest) -> FsTask<Vec<WorkspaceFileEntry>> {

  let roots = Roots::from_raw(&request.roots);
  let root_path = request.root_path;
  let rules = request.ignore_rules;
  spawn(move || {
    let canonical = roots.resolve(&root_path, "realpath")?;
    Ok(
      walk::walk_workspace(&canonical, &rules)?
        .iter()
        .map(to_workspace_entry)
        .collect(),
    )
  })
}

#[napi]
pub fn walk_workspace(request: WalkWorkspaceRequest) -> AsyncTask<FsTask<Vec<WorkspaceFileEntry>>> {
  AsyncTask::new(walk_workspace_task(request))
}


// ---------------------------------------------------------------------------
// 12-14. the settings-page read / transform / save
// ---------------------------------------------------------------------------

fn read_workspace_ignore_task(
  request: WorkspaceRootRequest,
) -> FsTask<IgnoreContent> {
  let roots = Roots::from_raw(&request.roots);
  let root_path = request.root_path;
  spawn(move || {
    let canonical = roots.resolve(&root_path, "realpath")?;
    let (content, source) = ignore_rules::read_for_settings(&canonical);
    Ok(IgnoreContent {
      content,
      source: source.to_string(),
    })
  })
}

#[napi]
pub fn read_workspace_ignore(
  request: WorkspaceRootRequest,
) -> AsyncTask<FsTask<IgnoreContent>> {
  AsyncTask::new(read_workspace_ignore_task(request))
}


fn transform_workspace_ignore_task(
  request: TransformIgnoreRequest,
) -> FsTask<IgnoreTransformResult> {
  let roots = Roots::from_raw(&request.roots);
  let root_path = request.root_path;
  spawn(move || {
    let transform = Transform::parse(&request.transform)?;
    let canonical = roots.resolve(&root_path, "realpath")?;
    Ok(IgnoreTransformResult {
      content: ignore_rules::transform_for_settings(&canonical, transform),
    })
  })
}

#[napi]
pub fn transform_workspace_ignore(
  request: TransformIgnoreRequest,
) -> AsyncTask<FsTask<IgnoreTransformResult>> {
  AsyncTask::new(transform_workspace_ignore_task(request))
}


fn write_workspace_ignore_task(request: WriteIgnoreRequest) -> FsTask<bool> {
  let roots = Roots::from_raw(&request.roots);
  let root_path = request.root_path;
  let content = request.content;
  spawn(move || {
    let canonical = roots.resolve(&root_path, "realpath")?;
    ignore_rules::atomic_write(
      &canonical.join(ignore_rules::WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME),
      &content,
    )?;
    Ok(true)
  })
}

#[napi]
pub fn write_workspace_ignore(request: WriteIgnoreRequest) -> AsyncTask<FsTask<bool>> {
  AsyncTask::new(write_workspace_ignore_task(request))
}


// ---------------------------------------------------------------------------
// 15-17. the pure exports: below 1 ms, so synchronous (rule 4 allows short
// primitives). They exist so the matcher and the filter can be exercised
// directly — by the tests and by the port's differential — without a walk.
// ---------------------------------------------------------------------------

#[napi]
pub fn match_workspace_ignore_path(request: MatchIgnorePathRequest) -> bool {
  match ignore_rules::compile(&request.rules) {
    Ok(matcher) => {
      ignore_rules::is_ignored(&matcher, &request.relative_path, request.is_directory)
    }
    // Rules the matcher cannot compile must not take the index down; treating
    // them as "ignores nothing" is the fail-open posture the load chain has
    // already established.
    Err(_) => false,
  }
}

#[napi]
pub fn evaluate_workspace_file_entry(request: EvaluateFileEntryRequest) -> FileDecision {
  let decision = mention_filter::evaluate(
    &request.name,
    &request.relative_path,
    request.kind == "directory",
    request.ignore_rules_active,
  );
  FileDecision {
    include: decision.include,
    traverse: decision.traverse,
  }
}

#[napi]
pub fn build_workspace_ignore_template(request: BuildIgnoreTemplateRequest) -> String {
  ignore_rules::build_template(request.gitignore.as_deref())
}
