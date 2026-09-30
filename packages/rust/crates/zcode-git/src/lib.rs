//! zcode-git: native git REFRESH surface — repository resolution, status
//! snapshot (porcelain-v2 equivalent incl. untracked line stats, overflow
//! collapse), identity, and branch comparison.
//!
//! Spec: docs/specs/rust-native-git.md (frozen contract).
//!
//! Invariants:
//! - ZERO child-process spawns (engine rule 5): gix runs fully in-process, no
//!   `command`/`credentials`/network gix feature is enabled, `open::Options`
//!   keeps `permissions.config.git_binary = false` (the default) and always
//!   passes `system_config_path` resolved by filesystem probing so gix-path
//!   never consults `GIT_CONFIG_PATHS` through the git binary.
//! - All four exports are `AsyncTask` (engine rule 4); no sync exports, no
//!   `AbortSignal` equivalent (the legacy refresh API never accepted one).
//! - Error strings mirror legacy `ensureGitCommandSucceeded` labels exactly:
//!   `<label> timed out after 15000ms (...)`, `<label> output exceeded limit`,
//!   `<label> failed: <engine detail>` (divergences D1/D2).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::Duration;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use napi::bindgen_prelude::*;
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

use gix::bstr::{BStr, BString, ByteSlice};
use gix::dir::entry::{Kind as DirKind, Property as DirProperty};
use gix::index::entry::Flags as IndexFlags;
use gix::remote::Direction;
use gix::status::UntrackedFiles;
use gix::status::index_worktree;
use gix_config::Source as ConfigSource;
use gix_diff::Rewrites;
use gix_object::tree::EntryKind;
use gix_status::index_as_worktree::{Change as WorktreeChange, EntryStatus};

/// Legacy `DEFAULT_GIT_OUTPUT_BYTES` (config.ts) — applied to every unit.
const MAX_OUTPUT_BYTES: u64 = 512 * 1024;
/// Legacy `DEFAULT_GIT_COMMAND_TIMEOUT_MS` (config.ts) — per work unit.
const TIMEOUT_MS: u64 = 15_000;
/// Legacy `GIT_UNTRACKED_STAT_MAX_BYTES` (moved into the crate, config.ts deletion table).
const UNTRACKED_STAT_MAX_BYTES: u64 = 1024 * 1024;
/// Legacy `GIT_UNTRACKED_STAT_CHUNK_BYTES`.
const UNTRACKED_STAT_CHUNK_BYTES: usize = 64 * 1024;
/// Legacy `GIT_UNTRACKED_STAT_CONCURRENCY`.
const UNTRACKED_STAT_CONCURRENCY: usize = 4;

// ---------------------------------------------------------------------------
// Error strings (identical prefixes per the spec's failure-semantics table)
// ---------------------------------------------------------------------------

fn err_failed(label: &str, detail: impl std::fmt::Display) -> Error {
  Error::new(Status::GenericFailure, format!("{label} failed: {detail}"))
}

fn err_timeout(label: &str) -> Error {
  Error::new(
    Status::GenericFailure,
    format!("{label} timed out after {TIMEOUT_MS}ms (native deadline reached; no process to kill)"),
  )
}

fn err_limit(label: &str) -> Error {
  Error::new(Status::GenericFailure, format!("{label} output exceeded limit"))
}

/// Legacy truncation rule: `outputTruncated` ⇔ stdout byte length > cap.
fn check_limit(bytes: u64, label: &str) -> Result<()> {
  if bytes > MAX_OUTPUT_BYTES {
    Err(err_limit(label))
  } else {
    Ok(())
  }
}

// ---------------------------------------------------------------------------
// 15s per-unit deadline: a watchdog thread flips an AtomicBool which gix polls
// through `should_interrupt_owned` during walks; we check it between work
// units and every N commits while counting ahead/behind.
// ---------------------------------------------------------------------------

struct Watchdog {
  flag: Arc<AtomicBool>,
  stop: Arc<(Mutex<bool>, Condvar)>,
}

impl Watchdog {
  fn start() -> Self {
    let flag = Arc::new(AtomicBool::new(false));
    let stop = Arc::new((Mutex::new(false), Condvar::new()));
    {
      let flag = flag.clone();
      let stop = stop.clone();
      std::thread::spawn(move || {
        let (lock, cond) = &*stop;
        let stopped = lock.lock().expect("watchdog lock poisoned");
        let (guard, timeout) = cond
          .wait_timeout(stopped, Duration::from_millis(TIMEOUT_MS))
          .expect("watchdog condvar poisoned");
        if !timeout.timed_out() {
          drop(guard);
          return;
        }
        flag.store(true, Ordering::SeqCst);
      });
    }
    Self { flag, stop }
  }

  fn interrupted(&self) -> bool {
    self.flag.load(Ordering::SeqCst)
  }

  fn stop(&self) {
    let (lock, cond) = &*self.stop;
    *lock.lock().expect("watchdog lock poisoned") = true;
    cond.notify_all();
  }
}

impl Drop for Watchdog {
  fn drop(&mut self) {
    self.stop();
  }
}

/// Stop the watchdog and translate a tripped flag into the unit's timeout error.
fn finish_unit(wd: &Watchdog, label: &str) -> Result<()> {
  let interrupted = wd.interrupted();
  wd.stop();
  if interrupted {
    Err(err_timeout(label))
  } else {
    Ok(())
  }
}

// ---------------------------------------------------------------------------
// Zero-spawn git binary probe + system config path (filesystem only, cached)
// ---------------------------------------------------------------------------

fn is_executable_file(path: &Path) -> bool {
  let Ok(metadata) = std::fs::metadata(path) else {
    return false;
  };
  if !metadata.is_file() {
    return false;
  }
  #[cfg(unix)]
  {
    return metadata.permissions().mode() & 0o111 != 0;
  }
  #[cfg(not(unix))]
  {
    true
  }
}

fn git_binary_available() -> bool {
  let mut candidates: Vec<PathBuf> = Vec::new();
  if let Some(explicit) = std::env::var_os("ZCODE_GIT_BINARY") {
    let trimmed = explicit.to_string_lossy().trim().to_string();
    if !trimmed.is_empty() {
      candidates.push(PathBuf::from(trimmed));
    }
  }
  if let Some(path_var) = std::env::var_os("PATH") {
    let exe = if cfg!(windows) { "git.exe" } else { "git" };
    for dir in std::env::split_paths(&path_var) {
      candidates.push(dir.join(exe));
    }
  }
  if cfg!(windows) {
    // Mirrors WINDOWS_GIT_BINARY_CANDIDATES (config.ts:18-33, 58-66).
    let program_files = std::env::var("ProgramW6432")
      .or_else(|_| std::env::var("ProgramFiles"))
      .unwrap_or_else(|_| "C:\\Program Files".to_string());
    let program_files_x86 =
      std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
    for base in [program_files, program_files_x86] {
      candidates.push(PathBuf::from(&base).join("Git").join("cmd").join("git.exe"));
      candidates.push(PathBuf::from(&base).join("Git").join("bin").join("git.exe"));
    }
  }
  candidates.iter().any(|candidate| is_executable_file(candidate))
}

static GIT_BINARY_AVAILABLE: LazyLock<bool> = LazyLock::new(git_binary_available);

/// The system config path, always passed to gix so `gix-path` never has to
/// consult `GIT_CONFIG_PATHS` via the git binary (Windows spawn hazard, spec).
fn system_config_path() -> PathBuf {
  if cfg!(windows) {
    let program_files = std::env::var("ProgramW6432")
      .or_else(|_| std::env::var("ProgramFiles"))
      .unwrap_or_else(|_| "C:\\Program Files".to_string());
    let program_files_x86 =
      std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
    let mut candidates: Vec<PathBuf> = Vec::new();
    for base in [program_files.clone(), program_files_x86] {
      let base = PathBuf::from(base);
      candidates.push(base.join("Git").join("etc").join("gitconfig"));
      candidates.push(base.join("Git").join("mingw64").join("etc").join("gitconfig"));
    }
    candidates
      .into_iter()
      .find(|candidate| candidate.exists())
      .unwrap_or_else(|| {
        PathBuf::from(program_files)
          .join("Git")
          .join("etc")
          .join("gitconfig")
      })
  } else {
    PathBuf::from("/etc/gitconfig")
  }
}

fn open_options() -> gix::open::Options {
  gix::open::Options::default().system_config_path(system_config_path())
}

/// Strict open at a known repository root (no upward walk).
fn open_repo(root: &str, label: &str) -> Result<gix::Repository> {
  gix::open_opts(root, open_options()).map_err(|err| err_failed(label, err))
}

/// Upward discovery with the same open options (the system-config override
/// applies during discovery too — zero-spawn on every platform).
fn discover_repo(dir: &Path) -> std::result::Result<gix::Repository, gix::Error> {
  let trust = gix_sec::trust::Mapping {
    full: open_options(),
    reduced: open_options(),
  };
  gix::ThreadSafeRepository::discover_opts(dir, gix::discover::upwards::Options::default(), trust)
    .map(Into::into)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn lossy(bytes: impl AsRef<[u8]>) -> String {
  String::from_utf8_lossy(bytes.as_ref()).into_owned()
}

fn hex(id: &gix::ObjectId) -> String {
  format!("{id}")
}

fn mode_str(mode: u32) -> String {
  format!("{mode:06o}")
}

const SUBMODULE_BITS: u32 = 0o160000;
const FILE_TYPE_BITS: u32 = 0o170000;

fn is_submodule_mode(mode: u32) -> bool {
  mode & FILE_TYPE_BITS == SUBMODULE_BITS
}

/// `1`/`2`/`u` record sub field: always 4 characters, `N...` unless one of the
/// entry's modes is a submodule (`S...`). Byte-length parity is exact either way.
fn sub_field(mode_bits: [u32; 3]) -> &'static str {
  if mode_bits.iter().any(|mode| is_submodule_mode(*mode)) {
    "S..."
  } else {
    "N..."
  }
}

/// Worktree mode for a path git stat()s: symlink ⇒ 120000, file ⇒ 100644/100755,
/// submodule directory ⇒ 160000, anything else (missing, dir) ⇒ 000000.
fn fs_worktree_mode(abs: &Path, index_mode: u32) -> u32 {
  let Ok(metadata) = std::fs::symlink_metadata(abs) else {
    return 0;
  };
  let file_type = metadata.file_type();
  if file_type.is_symlink() {
    return 0o120000;
  }
  if file_type.is_file() {
    #[cfg(unix)]
    {
      return if metadata.permissions().mode() & 0o111 != 0 {
        0o100755
      } else {
        0o100644
      };
    }
    #[cfg(not(unix))]
    {
      return 0o100644;
    }
  }
  if file_type.is_dir() && is_submodule_mode(index_mode) {
    return SUBMODULE_BITS;
  }
  0
}

/// `mW` for `1`/`2` records: git prints 000000 whenever there is no stage-0
/// index entry (even if a file exists — `git rm --cached`), stat otherwise.
fn worktree_mode(abs: &Path, indexed: bool, index_mode: u32) -> u32 {
  if !indexed {
    0
  } else {
    fs_worktree_mode(abs, index_mode)
  }
}

/// Join a repo-relative byte path onto a root (unix keeps raw bytes).
fn worktree_path_under(root: &Path, rela_path: &(impl AsRef<[u8]> + ?Sized)) -> PathBuf {
  #[cfg(unix)]
  {
    use std::os::unix::ffi::OsStrExt;
    root.join(std::ffi::OsStr::from_bytes(rela_path.as_ref()))
  }
  #[cfg(not(unix))]
  {
    root.join(String::from_utf8_lossy(rela_path.as_ref()).as_ref())
  }
}

/// Absolute worktree path for a repo-relative byte path.
fn worktree_path(repo_root: &str, rela_path: &(impl AsRef<[u8]> + ?Sized)) -> PathBuf {
  worktree_path_under(Path::new(repo_root), rela_path)
}

/// Path resolution for the untracked line-stats scanner: legacy resolved the
/// DECODED entry path (Buffer.toString("utf-8") → resolve()), so a non-UTF-8
/// name misses exactly like the TS implementation did (parity: {0,0}).
fn lossy_worktree_path(repo_root: &str, rela_path: &BStr) -> PathBuf {
  let decoded = String::from_utf8_lossy(rela_path);
  worktree_path_under(Path::new(repo_root), decoded.as_bytes())
}

/// Lexical normalization (no filesystem access): gix hands out git-dir paths
/// like `<gitdir>/worktrees/<name>/../..` for linked worktrees while git's CLI
/// prints them fully resolved — the autoRefreshWatchPaths and `--show-origin`
/// strings must match git's resolved form exactly.
fn normalize_lexically(path: &Path) -> PathBuf {
  use std::path::Component;
  let mut out = PathBuf::new();
  for component in path.components() {
    match component {
      Component::CurDir => {}
      Component::ParentDir => match out.components().next_back() {
        Some(Component::Normal(_)) => {
          out.pop();
        }
        _ => out.push(".."),
      },
      other => out.push(other.as_os_str()),
    }
  }
  out
}

// ---------------------------------------------------------------------------
// Napi request/response objects (spec: "Crate API design")
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct NativeResolveRequest {
  pub workspace_path: String,
}

#[napi(object)]
pub struct NativeResolveResult {
  /// Legacy `isGitAvailable` — filesystem probe, no spawn (divergence D3).
  pub git_available: bool,
  /// "ok" | "not-repository" | "missing-workdir"
  pub discovery: String,
  /// Absolute; "" unless discovery == "ok".
  pub repo_root: String,
  /// `git rev-parse --show-prefix` equivalent: "" | "sub/" (trailing slash).
  pub workspace_prefix: String,
  /// Absolute (--absolute-git-dir equivalent).
  pub git_dir: String,
  /// Absolute (--git-common-dir equivalent).
  pub git_common_dir: String,
}

#[napi(object)]
pub struct NativeStatusRequest {
  pub repo_root: String,
}

#[napi(object)]
pub struct NativeStatusEntry {
  /// Repo-root-relative, "/"-normalized.
  pub path: String,
  /// Type-2 rename source path.
  pub original_path: Option<String>,
  pub x: Option<String>,
  pub y: Option<String>,
  pub is_untracked: bool,
  pub is_conflicted: bool,
}

#[napi(object)]
pub struct NativeStatRecord {
  pub path: String,
  pub added: i64,
  pub removed: i64,
}

#[napi(object)]
pub struct NativeStatusSnapshot {
  /// null ⇔ HEAD detached.
  pub branch_name: Option<String>,
  /// e.g. "origin/master".
  pub tracking_branch_name: Option<String>,
  pub head_ref_type: String,
  pub ahead: i64,
  pub behind: i64,
  /// EXACT legacy record order: headers → tracked (byte-sorted, staged and
  /// unstaged interleaved by path) → conflicted → untracked.
  pub entries: Vec<NativeStatusEntry>,
  pub staged_stats: Vec<NativeStatRecord>,
  pub unstaged_stats: Vec<NativeStatRecord>,
  pub untracked_stats: Vec<NativeStatRecord>,
  /// True only for the first overflow-collapse of this repoRoot (drives the
  /// legacy `log.warn` at gitCliRepo.ts:563-569).
  pub collapsed_now: bool,
}

#[napi(object)]
pub struct NativeIdentityRequest {
  pub repo_root: String,
}

#[napi(object)]
pub struct NativeIdentity {
  pub user_name: Option<String>,
  pub user_email: Option<String>,
  /// `--show-origin` equivalent, e.g. "file:.git/config".
  pub name_source: Option<String>,
  pub email_source: Option<String>,
  /// `--show-scope` equivalent, e.g. "local".
  pub name_scope: Option<String>,
  pub email_scope: Option<String>,
}

#[napi(object)]
pub struct NativeBranchComparisonRequest {
  pub repo_root: String,
  /// Legacy always diffs "<tracking>...HEAD".
  pub tracking_branch_name: String,
}

#[napi(object)]
pub struct NativeBranchChange {
  pub path: String,
  pub original_path: Option<String>,
  pub added: i64,
  pub removed: i64,
  /// "added" | "deleted" | "modified" | "renamed" — replicates the legacy
  /// `inferKindFromNumstat` rule (that helper dies with its last caller).
  pub kind: String,
}

// ---------------------------------------------------------------------------
// 1. resolve_repository
// ---------------------------------------------------------------------------

pub struct ResolveTask {
  workspace_path: String,
}

impl Task for ResolveTask {
  type Output = NativeResolveResult;
  type JsValue = NativeResolveResult;

  fn compute(&mut self) -> Result<Self::Output> {
    let wd = Watchdog::start();

    let blank = |git_available: bool, discovery: &str| NativeResolveResult {
      git_available,
      discovery: discovery.to_string(),
      repo_root: String::new(),
      workspace_prefix: String::new(),
      git_dir: String::new(),
      git_common_dir: String::new(),
    };

    if !*GIT_BINARY_AVAILABLE {
      // Legacy: no candidate passes the probe → isGitAvailable:false fallback.
      return Ok(blank(false, "not-repository"));
    }

    let Ok(canonical) = std::fs::canonicalize(&self.workspace_path) else {
      // Legacy: spawn fails with ENOENT / "unable to read current working
      // directory" → isMissingWorkingDirectoryResult → isRepository:false.
      return Ok(blank(true, "missing-workdir"));
    };
    if !canonical.is_dir() {
      return Ok(blank(true, "missing-workdir"));
    }

    let repo = match discover_repo(&canonical) {
      Ok(repo) => repo,
      Err(_) => return Ok(blank(true, "not-repository")),
    };

    let Some(workdir) = repo.workdir() else {
      // Legacy: `git rev-parse` in a bare repo exits non-zero, matches neither
      // downgrade helper → ensureGitCommandSucceeded throws (D2 detail).
      return Err(err_failed(
        "git rev-parse",
        "this operation must be run in a work tree",
      ));
    };

    let repo_root = normalize_lexically(workdir)
      .to_string_lossy()
      .replace('\\', "/");
    let workspace_prefix = match canonical.strip_prefix(workdir) {
      Ok(rel) if rel.as_os_str().is_empty() => String::new(),
      Ok(rel) => format!("{}/", rel.to_string_lossy().replace('\\', "/")),
      Err(_) => String::new(),
    };
    let git_dir = normalize_lexically(repo.git_dir())
      .to_string_lossy()
      .replace('\\', "/");
    let git_common_dir = normalize_lexically(repo.common_dir())
      .to_string_lossy()
      .replace('\\', "/");

    // Byte-gate on the legacy stdout of the four-argument `git rev-parse`.
    let stdout_bytes = repo_root.len() as u64
      + workspace_prefix.len() as u64
      + git_dir.len() as u64
      + git_common_dir.len() as u64
      + 4;
    check_limit(stdout_bytes, "git rev-parse")?;
    finish_unit(&wd, "git rev-parse")?;

    Ok(NativeResolveResult {
      git_available: true,
      discovery: "ok".to_string(),
      repo_root,
      workspace_prefix,
      git_dir,
      git_common_dir,
    })
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

#[napi]
pub fn resolve_repository(request: NativeResolveRequest) -> Result<AsyncTask<ResolveTask>> {
  Ok(AsyncTask::new(ResolveTask {
    workspace_path: request.workspace_path,
  }))
}

// ---------------------------------------------------------------------------
// 2. status_snapshot
// ---------------------------------------------------------------------------

/// Process-lifetime collapse state — mirrors `collapsedUntrackedRepoRoots`
/// (gitCliRepo.ts:544): set on first overflow, never cleared by `invalidate()`.
static COLLAPSED_ROOTS: LazyLock<Mutex<HashSet<String>>> =
  LazyLock::new(|| Mutex::new(HashSet::new()));

/// Head/upstream header facts (legacy `# branch.*` records).
struct HeadInfo {
  branch_name: Option<String>,
  tracking_branch_name: Option<String>,
  head_ref_type: String,
  head_oid: Option<gix::ObjectId>,
  tracking_resolves: bool,
  ahead: i64,
  behind: i64,
}

fn commit_parents(
  repo: &gix::Repository,
  id: &gix::ObjectId,
  label: &str,
) -> std::result::Result<Vec<gix::ObjectId>, Error> {
  let object = repo.find_object(*id).map_err(|e| err_failed(label, e))?;
  Ok(object
    .into_commit()
    .parent_ids()
    .map(|parent| parent.detach())
    .collect())
}

/// Custom paint-down-to-common ahead/behind counting (validated against
/// `git rev-list --left-right --count` in the parity harness): ahead =
/// reachable(head) \ reachable(upstream), behind = the inverse difference.
fn ahead_behind(
  repo: &gix::Repository,
  head: &gix::ObjectId,
  upstream: &gix::ObjectId,
  wd: &Watchdog,
  label: &str,
) -> Result<(i64, i64)> {
  let mut reach_up: HashSet<gix::ObjectId> = HashSet::new();
  reach_up.insert(*upstream);
  let mut stack = vec![*upstream];
  let mut processed: usize = 0;
  while let Some(id) = stack.pop() {
    processed += 1;
    if processed % 512 == 0 && wd.interrupted() {
      return Err(err_timeout(label));
    }
    for parent in commit_parents(repo, &id, label)? {
      if reach_up.insert(parent) {
        stack.push(parent);
      }
    }
  }

  let mut reach_head: HashSet<gix::ObjectId> = HashSet::new();
  reach_head.insert(*head);
  stack.push(*head);
  let mut processed: usize = 0;
  while let Some(id) = stack.pop() {
    processed += 1;
    if processed % 512 == 0 && wd.interrupted() {
      return Err(err_timeout(label));
    }
    for parent in commit_parents(repo, &id, label)? {
      if reach_head.insert(parent) {
        stack.push(parent);
      }
    }
  }

  let ahead = reach_head.difference(&reach_up).count() as i64;
  let behind = reach_up.difference(&reach_head).count() as i64;
  Ok((ahead, behind))
}

fn read_head_info(repo: &gix::Repository, wd: &Watchdog) -> Result<HeadInfo> {
  const LABEL: &str = "git status";
  let mut head = repo.head().map_err(|e| err_failed(LABEL, e))?;
  let detached = head.is_detached();

  let mut info = HeadInfo {
    branch_name: None,
    tracking_branch_name: None,
    head_ref_type: if detached { "detached" } else { "branch" }.to_string(),
    head_oid: None,
    tracking_resolves: false,
    ahead: 0,
    behind: 0,
  };

  if detached {
    if let Ok(Some(id)) = head.try_peel_to_id() {
      info.head_oid = Some(id.detach());
    }
    return Ok(info);
  }

  let Some(referent) = head.referent_name() else {
    return Ok(info);
  };
  info.branch_name = Some(format!("{}", referent.shorten()));

  if let Ok(mut head_ref) = repo.find_reference(referent) {
    if let Ok(id) = head_ref.peel_to_id() {
      info.head_oid = Some(id.detach());
    }
  }

  if let Some(Ok(tracking)) = repo.branch_remote_tracking_ref_name(referent, Direction::Fetch) {
    info.tracking_branch_name = Some(format!("{}", tracking.shorten()));
    // `# branch.ab` only appears once the tracking ref resolves — and the
    // upstream header itself only appears when the config chain resolves
    // (verified against `git status` with a vanished/misnamed upstream).
    if let Ok(mut tracking_ref) = repo.find_reference(tracking.as_bstr()) {
      if let (Some(head_oid), Ok(tracking_id)) = (info.head_oid.as_ref(), tracking_ref.peel_to_id()) {
        info.tracking_resolves = true;
        let (ahead, behind) = ahead_behind(repo, head_oid, &tracking_id.detach(), wd, LABEL)?;
        info.ahead = ahead;
        info.behind = behind;
      }
    }
  }

  Ok(info)
}

fn decimal_len(value: i64) -> u64 {
  value.unsigned_abs().to_string().len() as u64
}

/// Byte length of the `# branch.*` headers (ordering rule 1).
fn header_bytes(info: &HeadInfo) -> u64 {
  let mut bytes = 0u64;
  // Unborn HEAD ⇒ "(initial)"; every resolvable HEAD prints its full oid.
  let oid_line = match &info.head_oid {
    Some(oid) => hex(oid),
    None => "(initial)".to_string(),
  };
  bytes += b"# branch.oid ".len() as u64 + oid_line.len() as u64 + 1;

  let head_line = match &info.branch_name {
    Some(name) => name.clone(),
    None => "(detached)".to_string(),
  };
  bytes += b"# branch.head ".len() as u64 + head_line.len() as u64 + 1;

  if let Some(tracking) = &info.tracking_branch_name {
    bytes += b"# branch.upstream ".len() as u64 + tracking.len() as u64 + 1;
    if info.tracking_resolves {
      // `# branch.ab +<ahead> -<behind>`
      bytes += b"# branch.ab ".len() as u64 + 1 + 1 + decimal_len(info.ahead) + 1 + 1
        + decimal_len(info.behind)
        + 1;
    }
  }
  bytes
}

struct TreeEvent {
  path: BString,
  x: char,
  head_mode: u32,
  head_id: gix::ObjectId,
  original: Option<BString>,
}

struct Stage0Entry {
  mode: u32,
  id: gix::ObjectId,
}

/// Index facts needed for porcelain rendering: stage-0 entries (with
/// intent-to-add zeroed exactly like git prints them) and conflict stages.
struct IndexMaps {
  stage0: HashMap<BString, Stage0Entry>,
  stage0_present: HashSet<BString>,
  conflicts: Vec<(BString, [Option<Stage0Entry>; 3])>,
  conflict_paths: HashSet<BString>,
}

fn build_index_maps(repo: &gix::Repository) -> Result<IndexMaps> {
  const LABEL: &str = "git status";
  let index = repo.index_or_empty().map_err(|e| err_failed(LABEL, e))?;
  let null_id = gix::ObjectId::null(repo.object_hash());
  let mut maps = IndexMaps {
    stage0: HashMap::new(),
    stage0_present: HashSet::new(),
    conflicts: Vec::new(),
    conflict_paths: HashSet::new(),
  };
  let mut conflict_slots: HashMap<BString, [Option<Stage0Entry>; 3]> = HashMap::new();
  for entry in index.entries() {
    let path = entry.path(&index).to_owned();
    let stage = entry.stage_raw();
    if stage == 0 {
      maps.stage0_present.insert(path.clone());
      let value = if entry.flags.contains(IndexFlags::INTENT_TO_ADD) {
        // git renders intent-to-add index sides as 000000/all-zero regardless
        // of the stored (empty-blob) entry.
        Stage0Entry {
          mode: 0,
          id: null_id,
        }
      } else {
        Stage0Entry {
          mode: entry.mode.bits(),
          id: entry.id,
        }
      };
      maps.stage0.insert(path, value);
    } else {
      maps.conflict_paths.insert(path.clone());
      let slot = conflict_slots.entry(path).or_insert_with(|| [None, None, None]);
      slot[(stage - 1) as usize] = Some(Stage0Entry {
        mode: entry.mode.bits(),
        id: entry.id,
      });
    }
  }
  maps.conflicts = conflict_slots.into_iter().collect();
  Ok(maps)
}

/// Legacy XY for an unmerged record, derived from stage presence exactly as
/// git does (all seven combinations pinned by the spec's ground truth).
fn conflict_xy(stages: &[Option<Stage0Entry>; 3]) -> (char, char) {
  let s1 = stages[0].is_some();
  let s2 = stages[1].is_some();
  let s3 = stages[2].is_some();
  let x = if s2 {
    if s1 {
      'U'
    } else {
      'A'
    }
  } else if s1 {
    'D'
  } else if s3 {
    'U'
  } else {
    'D'
  };
  let y = if s3 {
    if s1 {
      'U'
    } else {
      'A'
    }
  } else if s1 {
    'D'
  } else if s2 {
    'U'
  } else {
    'D'
  };
  (x, y)
}

/// Emit one untracked record per the mode's rules: git never prints bare
/// directories in `-uall` (files are emitted individually) and never prints
/// empty directories at all; `-unormal` prints wholly-untracked dirs as `dir/`.
fn emit_untracked(out: &mut Vec<(BString, bool)>, entry: &gix::dir::Entry, mode: UntrackedFiles) {
  if !matches!(entry.status, gix::dir::entry::Status::Untracked) {
    return;
  }
  if matches!(
    entry.property,
    Some(DirProperty::EmptyDirectory) | Some(DirProperty::EmptyDirectoryAndCWD)
  ) {
    return;
  }
  let is_dir_entry = matches!(
    entry.disk_kind,
    Some(DirKind::Directory) | Some(DirKind::Repository)
  );
  match mode {
    UntrackedFiles::Files => {
      if is_dir_entry {
        // Individual files inside are emitted on their own; an embedded
        // repository is a single `dir/` entry even under `-uall`.
        if matches!(entry.disk_kind, Some(DirKind::Repository)) {
          out.push((entry.rela_path.clone(), true));
        }
      } else {
        out.push((entry.rela_path.clone(), false));
      }
    }
    _ => {
      if is_dir_entry {
        out.push((entry.rela_path.clone(), true));
      } else {
        out.push((entry.rela_path.clone(), false));
      }
    }
  }
}

struct TrackedRecord {
  path: BString,
  x: char,
  y: char,
  original: Option<BString>,
  head_mode: u32,
  head_id: gix::ObjectId,
}

struct CollectedStatus {
  entries: Vec<NativeStatusEntry>,
  untracked_paths: Vec<BString>,
  bytes: u64,
}

fn collect_status(
  repo: &gix::Repository,
  repo_root: &str,
  info: &HeadInfo,
  index: &IndexMaps,
  untracked_mode: UntrackedFiles,
  wd: &Watchdog,
) -> Result<CollectedStatus> {
  const LABEL: &str = "git status";
  let null_id = gix::ObjectId::null(repo.object_hash());

  let platform = repo
    .status(gix::progress::Discard)
    .map_err(|e| err_failed(LABEL, e))?
    .untracked_files(untracked_mode)
    .should_interrupt_owned(wd.flag.clone());
  let iter = platform
    .into_iter(Vec::<BString>::new())
    .map_err(|e| err_failed(LABEL, e))?;

  let mut tree_events: HashMap<BString, TreeEvent> = HashMap::new();
  let mut worktree_events: HashMap<BString, char> = HashMap::new();
  let mut untracked: Vec<(BString, bool)> = Vec::new();

  for item in iter {
    let item = item.map_err(|e| err_failed(LABEL, e))?;
    match item {
      gix::status::Item::TreeIndex(change) => {
        use gix_diff::index::Change as IndexChange;
        let event: TreeEvent = match change {
          IndexChange::Addition { location, .. } => TreeEvent {
            path: location.into_owned(),
            x: 'A',
            head_mode: 0,
            head_id: null_id,
            original: None,
          },
          IndexChange::Deletion {
            location,
            entry_mode,
            id,
            ..
          } => TreeEvent {
            path: location.into_owned(),
            x: 'D',
            head_mode: entry_mode.bits(),
            head_id: id.into_owned(),
            original: None,
          },
          IndexChange::Modification {
            location,
            previous_entry_mode,
            previous_id,
            ..
          } => TreeEvent {
            path: location.into_owned(),
            x: 'M',
            head_mode: previous_entry_mode.bits(),
            head_id: previous_id.into_owned(),
            original: None,
          },
          IndexChange::Rewrite {
            source_location,
            source_entry_mode,
            source_id,
            location,
            ..
          } => TreeEvent {
            path: location.into_owned(),
            x: 'R',
            head_mode: source_entry_mode.bits(),
            head_id: source_id.into_owned(),
            original: Some(source_location.into_owned()),
          },
        };
        tree_events.insert(event.path.clone(), event);
      }
      gix::status::Item::IndexWorktree(item) => match item {
        index_worktree::Item::Modification {
          rela_path,
          status,
          ..
        } => match status {
          EntryStatus::Change(change) => {
            let y = match change {
              WorktreeChange::Removed => 'D',
              WorktreeChange::Type { .. } => 'T',
              WorktreeChange::Modification { .. } => 'M',
              WorktreeChange::SubmoduleModification(_) => 'M',
            };
            worktree_events.insert(rela_path, y);
          }
          EntryStatus::IntentToAdd => {
            worktree_events.insert(rela_path, 'A');
          }
          EntryStatus::Conflict { .. } | EntryStatus::NeedsUpdate(_) => {}
        },
        index_worktree::Item::DirectoryContents { entry, .. } => {
          emit_untracked(&mut untracked, &entry, untracked_mode);
        }
        index_worktree::Item::Rewrite { dirwalk_entry, .. } => {
          // index→worktree rewrites are disabled by default; defensively treat
          // the destination as untracked if they ever appear.
          emit_untracked(&mut untracked, &dirwalk_entry, untracked_mode);
        }
      },
    }
  }
  finish_unit(wd, LABEL)?;

  // ---- merge TreeIndex (X) + IndexWorktree (Y) by path, byte-sorted ----
  let mut paths: Vec<&BString> = tree_events.keys().chain(worktree_events.keys()).collect();
  paths.sort();
  paths.dedup();

  let mut tracked: Vec<TrackedRecord> = Vec::new();
  for path in paths {
    if index.conflict_paths.contains(path) {
      continue;
    }
    let tree = tree_events.get(path);
    let x = tree.map(|event| event.x).unwrap_or('.');
    let y = worktree_events.get(path).copied().unwrap_or('.');
    let (head_mode, head_id) = match tree {
      Some(event) => (event.head_mode, event.head_id),
      None => match index.stage0.get(path) {
        // X='.' ⇒ index and HEAD agree for this path.
        Some(entry) => (entry.mode, entry.id),
        None => (0, null_id),
      },
    };
    tracked.push(TrackedRecord {
      path: path.clone(),
      x,
      y,
      original: tree.and_then(|event| event.original.clone()),
      head_mode,
      head_id,
    });
  }

  let mut entries: Vec<NativeStatusEntry> = Vec::new();
  let mut bytes = header_bytes(info);

  // ---- group 2: tracked `1`/`2` records (byte-sorted by path) ----
  for record in &tracked {
    let indexed = index.stage0_present.contains(&record.path);
    let idx = index.stage0.get(&record.path);
    let idx_mode = idx.map(|entry| entry.mode).unwrap_or(0);
    let idx_id = idx.map(|entry| entry.id).unwrap_or(null_id);
    let abs = worktree_path(repo_root, &record.path);
    let m_w = worktree_mode(&abs, indexed, idx_mode);
    let sub = sub_field([record.head_mode, idx_mode, m_w]);

    let mut raw: Vec<u8> = Vec::new();
    if record.x == 'R' {
      raw.extend_from_slice(b"2 ");
      raw.extend_from_slice(record.x.to_string().as_bytes());
      raw.push(record.y as u8);
      raw.extend_from_slice(
        format!(
          " {sub} {} {} {} {} {} R100 ",
          mode_str(record.head_mode),
          mode_str(idx_mode),
          mode_str(m_w),
          hex(&record.head_id),
          hex(&idx_id)
        )
        .as_bytes(),
      );
      raw.extend_from_slice(&record.path);
      raw.push(0);
      if let Some(original) = &record.original {
        raw.extend_from_slice(original);
        raw.push(0);
      }
    } else {
      raw.extend_from_slice(b"1 ");
      raw.push(record.x as u8);
      raw.push(record.y as u8);
      raw.extend_from_slice(
        format!(
          " {sub} {} {} {} {} {} ",
          mode_str(record.head_mode),
          mode_str(idx_mode),
          mode_str(m_w),
          hex(&record.head_id),
          hex(&idx_id)
        )
        .as_bytes(),
      );
      raw.extend_from_slice(&record.path);
      raw.push(0);
    }
    bytes += raw.len() as u64;

    entries.push(NativeStatusEntry {
      path: lossy(&record.path),
      original_path: record.original.as_deref().map(lossy),
      x: Some(record.x.to_string()),
      y: Some(record.y.to_string()),
      is_untracked: false,
      is_conflicted: false,
    });
  }

  // ---- group 3: conflicted `u` records (path-sorted, after all tracked) ----
  let mut conflicts: Vec<&(BString, [Option<Stage0Entry>; 3])> = index.conflicts.iter().collect();
  conflicts.sort_by(|left, right| left.0.cmp(&right.0));
  for (path, stages) in &conflicts {
    let (x, y) = conflict_xy(stages);
    let abs = worktree_path(repo_root, path);
    // `u` records always stat the worktree (merge conflicts materialize files).
    let m_w = fs_worktree_mode(&abs, 0);
    let m1 = stages[0].as_ref().map(|entry| entry.mode).unwrap_or(0);
    let m2 = stages[1].as_ref().map(|entry| entry.mode).unwrap_or(0);
    let m3 = stages[2].as_ref().map(|entry| entry.mode).unwrap_or(0);
    let h1 = stages[0].as_ref().map(|entry| entry.id).unwrap_or(null_id);
    let h2 = stages[1].as_ref().map(|entry| entry.id).unwrap_or(null_id);
    let h3 = stages[2].as_ref().map(|entry| entry.id).unwrap_or(null_id);
    let sub = sub_field([m1, m2, m3]);

    let mut raw: Vec<u8> = Vec::new();
    raw.extend_from_slice(b"u ");
    raw.push(x as u8);
    raw.push(y as u8);
    raw.extend_from_slice(
      format!(
        " {sub} {} {} {} {} {} {} {} ",
        mode_str(m1),
        mode_str(m2),
        mode_str(m3),
        mode_str(m_w),
        hex(&h1),
        hex(&h2),
        hex(&h3)
      )
      .as_bytes(),
    );
    raw.extend_from_slice(path);
    raw.push(0);
    bytes += raw.len() as u64;

    entries.push(NativeStatusEntry {
      path: lossy(path),
      original_path: None,
      x: Some(x.to_string()),
      y: Some(y.to_string()),
      is_untracked: false,
      is_conflicted: true,
    });
  }

  // ---- group 4: untracked `?` records (path-sorted, last) ----
  untracked.sort_by(|left, right| left.0.cmp(&right.0));
  let mut untracked_paths: Vec<BString> = Vec::with_capacity(untracked.len());
  for (path, is_dir) in &untracked {
    let mut raw: Vec<u8> = Vec::new();
    raw.extend_from_slice(b"? ");
    raw.extend_from_slice(path);
    if *is_dir {
      raw.push(b'/');
    }
    raw.push(0);
    bytes += raw.len() as u64;

    let mut display = lossy(path);
    if *is_dir {
      display.push('/');
    }
    entries.push(NativeStatusEntry {
      path: display,
      original_path: None,
      x: None,
      y: Some("?".to_string()),
      is_untracked: true,
      is_conflicted: false,
    });
    untracked_paths.push(path.clone());
  }

  Ok(CollectedStatus {
    entries,
    untracked_paths,
    bytes,
  })
}

/// Legacy `countUntrackedFileLines` ported 1:1 (≤1 MiB/file, 64 KiB chunks,
/// NUL ⇒ 0, EOF ⇒ newlines + final-non-newline, any error ⇒ 0). One buffer per
/// worker thread, fixed chunk size for bounded memory (config.ts:16).
fn count_untracked_file_lines(abs: &Path) -> i64 {
  let Ok(metadata) = std::fs::symlink_metadata(abs) else {
    return 0;
  };
  if !metadata.is_file() || metadata.len() > UNTRACKED_STAT_MAX_BYTES {
    return 0;
  }
  let Ok(mut file) = std::fs::File::open(abs) else {
    return 0;
  };
  use std::io::Read;
  let mut buffer = vec![0u8; UNTRACKED_STAT_CHUNK_BYTES];
  let mut total_bytes: u64 = 0;
  let mut newlines: u64 = 0;
  let mut last_byte: u8 = b'\n';
  loop {
    if total_bytes > UNTRACKED_STAT_MAX_BYTES {
      return 0;
    }
    let remaining = UNTRACKED_STAT_MAX_BYTES + 1 - total_bytes;
    let length = std::cmp::min(buffer.len() as u64, remaining) as usize;
    let bytes_read = match file.read(&mut buffer[..length]) {
      Ok(0) => {
        return (newlines + u64::from(last_byte != b'\n')) as i64;
      }
      Ok(bytes_read) => bytes_read,
      Err(_) => return 0,
    };
    total_bytes += bytes_read as u64;
    if total_bytes > UNTRACKED_STAT_MAX_BYTES {
      return 0;
    }
    for byte in &buffer[..bytes_read] {
      if *byte == 0 {
        return 0;
      }
      if *byte == b'\n' {
        newlines += 1;
      }
    }
    last_byte = buffer[bytes_read - 1];
  }
}

/// Untracked line stats over 4 fixed worker threads (thread scheduling cannot
/// change the result — per-key independent).
fn untracked_stats(repo_root: &str, paths: &[BString]) -> Vec<NativeStatRecord> {
  if paths.is_empty() {
    return Vec::new();
  }
  let workers = std::cmp::min(UNTRACKED_STAT_CONCURRENCY, paths.len());
  let mut chunks: Vec<&[BString]> = Vec::with_capacity(workers);
  let chunk_size = paths.len().div_ceil(workers);
  for chunk in paths.chunks(chunk_size) {
    chunks.push(chunk);
    if chunks.len() == workers {
      break;
    }
  }
  let mut results: Vec<Vec<NativeStatRecord>> = Vec::with_capacity(workers);
  std::thread::scope(|scope| {
    let mut handles = Vec::with_capacity(workers);
    for chunk in chunks {
      handles.push(scope.spawn(move || {
        let mut out = Vec::with_capacity(chunk.len());
        for path in chunk {
          let display = if path.last_byte() == Some(b'/') {
            format!("{}/", lossy(path))
          } else {
            lossy(path)
          };
          let stat_path = strip_trailing_slash(path.as_bstr());
          let abs = lossy_worktree_path(repo_root, stat_path);
          out.push(NativeStatRecord {
            path: display,
            added: count_untracked_file_lines(&abs),
            removed: 0,
          });
        }
        out
      }));
    }
    for handle in handles {
      results.push(handle.join().unwrap_or_default());
    }
  });
  results.into_iter().flatten().collect()
}

fn strip_trailing_slash(path: &BStr) -> &BStr {
  if path.last_byte() == Some(b'/') {
    &path[..path.len() - 1]
  } else {
    path
  }
}

pub struct StatusTask {
  repo_root: String,
}

impl Task for StatusTask {
  type Output = NativeStatusSnapshot;
  type JsValue = NativeStatusSnapshot;

  fn compute(&mut self) -> Result<Self::Output> {
    const STATUS_LABEL: &str = "git status";
    const STAGED_LABEL: &str = "git diff --cached --numstat";
    const UNSTAGED_LABEL: &str = "git diff --numstat";

    let repo = open_repo(&self.repo_root, STATUS_LABEL)?;

    // -- unit 1: `git status` (headers + records + untracked walk + collapse) --
    let status_watchdog = Watchdog::start();
    let info = read_head_info(&repo, &status_watchdog)?;
    let index = build_index_maps(&repo)?;

    let pre_collapsed = COLLAPSED_ROOTS
      .lock()
      .expect("collapse lock poisoned")
      .contains(&self.repo_root);
    let mut collapsed_now = false;
    let mut collected = collect_status(
      &repo,
      &self.repo_root,
      &info,
      &index,
      if pre_collapsed {
        UntrackedFiles::Collapsed
      } else {
        UntrackedFiles::Files
      },
      &status_watchdog,
    )?;
    if collected.bytes > MAX_OUTPUT_BYTES {
      if pre_collapsed {
        return Err(err_limit(STATUS_LABEL));
      }
      // First overflow for this repoRoot: remember the root, collapse
      // untracked directories, re-derive the exact byte length (spec overflow rule).
      COLLAPSED_ROOTS
        .lock()
        .expect("collapse lock poisoned")
        .insert(self.repo_root.clone());
      collapsed_now = true;
      collected = collect_status(
        &repo,
        &self.repo_root,
        &info,
        &index,
        UntrackedFiles::Collapsed,
        &status_watchdog,
      )?;
      if collected.bytes > MAX_OUTPUT_BYTES {
        return Err(err_limit(STATUS_LABEL));
      }
    }
    finish_unit(&status_watchdog, STATUS_LABEL)?;
    let untracked_paths = collected.untracked_paths;

    // -- unit 2: `git diff --cached --numstat` (HEAD → index) --
    let staged_watchdog = Watchdog::start();
    let staged_stats = staged_numstat(&repo, &index, &staged_watchdog)?;
    finish_unit(&staged_watchdog, STAGED_LABEL)?;

    // -- unit 3: `git diff --numstat` (index → worktree) --
    let unstaged_watchdog = Watchdog::start();
    let unstaged_stats = unstaged_numstat(&repo, &index, &unstaged_watchdog)?;
    finish_unit(&unstaged_watchdog, UNSTAGED_LABEL)?;

    // -- untracked line stats (legacy had no timeout on file scans) --
    let untracked_stats = untracked_stats(&self.repo_root, &untracked_paths);

    Ok(NativeStatusSnapshot {
      branch_name: info.branch_name,
      tracking_branch_name: info.tracking_branch_name,
      head_ref_type: info.head_ref_type,
      ahead: info.ahead,
      behind: info.behind,
      entries: collected.entries,
      staged_stats,
      unstaged_stats,
      untracked_stats,
      collapsed_now,
    })
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

// ---------------------------------------------------------------------------
// Numstat primitives (staged / unstaged / branch comparison)
// ---------------------------------------------------------------------------

struct NumstatRecord {
  path: BString,
  original: Option<BString>,
  added: i64,
  removed: i64,
  binary: bool,
}

fn record_kind(record: &NumstatRecord) -> &'static str {
  if record.original.is_some() {
    return "renamed";
  }
  // Legacy `inferKindFromNumstat` over the parsed (- ⇒ 0) numbers.
  if record.added > 0 && record.removed == 0 {
    "added"
  } else if record.removed > 0 && record.added == 0 {
    "deleted"
  } else {
    "modified"
  }
}

/// Exact legacy `--numstat -z` stdout bytes for one record:
/// `a\tt\tpath\0`, or `a\tt\t\0src\0dst\0` for renames (`-` for binary).
fn numstat_raw(record: &NumstatRecord) -> Vec<u8> {
  let added = if record.binary { "-" } else { &record.added.to_string() };
  let removed = if record.binary {
    "-"
  } else {
    &record.removed.to_string()
  };
  let mut raw: Vec<u8> = Vec::new();
  raw.extend_from_slice(added.as_bytes());
  raw.push(b'\t');
  raw.extend_from_slice(removed.as_bytes());
  raw.push(b'\t');
  if let Some(original) = &record.original {
    raw.push(0);
    raw.extend_from_slice(original);
    raw.push(0);
    raw.extend_from_slice(&record.path);
    raw.push(0);
  } else {
    raw.extend_from_slice(&record.path);
    raw.push(0);
  }
  raw
}

fn sort_numstat(records: &mut [NumstatRecord]) {
  records.sort_by(|left, right| left.path.cmp(&right.path));
}

fn to_stat_records(records: Vec<NumstatRecord>) -> Vec<NativeStatRecord> {
  records
    .into_iter()
    .map(|record| NativeStatRecord {
      path: lossy(&record.path),
      added: record.added,
      removed: record.removed,
    })
    .collect()
}

fn gate_numstat(records: &[NumstatRecord], label: &str) -> Result<()> {
  let mut bytes: u64 = 0;
  for record in records {
    bytes += numstat_raw(record).len() as u64;
  }
  check_limit(bytes, label)
}

/// One line-count diff between two ODB/worktree resources; the resource cache
/// is cleared after every path so memory stays bounded (one file at a time).
///
/// NOTE: gix's own `Platform::line_counts()` interns lines with
/// `ByteLinesWithoutTerminator`, which strips `\r` alongside `\n` — an
/// EOL-only change (CRLF index vs LF worktree) would then diff to ~zero while
/// git counts every converted line (verified against `git diff --numstat` on a
/// real generated file). We keep git's model: a line is everything up to and
/// including `\n`, so `\r` stays part of the token (imara's `ByteLines`).
fn line_counts(
  cache: &mut gix_diff::blob::Platform,
  old: (&gix::ObjectId, EntryKind, &BString),
  new: (&gix::ObjectId, EntryKind, &BString),
  repo: &gix::Repository,
) -> std::result::Result<(i64, i64, bool), String> {
  use gix_diff::blob::platform::prepare_diff::Operation;
  use gix_diff::blob::{InternedInput, ResourceKind};
  cache
    .set_resource(
      *old.0,
      old.1,
      old.2.as_bstr(),
      ResourceKind::OldOrSource,
      &repo.objects,
    )
    .map_err(|err| err.to_string())?;
  cache
    .set_resource(
      *new.0,
      new.1,
      new.2.as_bstr(),
      ResourceKind::NewOrDestination,
      &repo.objects,
    )
    .map_err(|err| err.to_string())?;
  // Force the internal diff even when an external driver is configured — same
  // as gix's `line_counts()`.
  cache.options.skip_internal_diff_if_external_is_configured = false;
  let counts = {
    let prep = cache.prepare_diff().map_err(|err| err.to_string())?;
    match prep.operation {
      Operation::InternalDiff { algorithm } => {
        let input = InternedInput::new(prep.old.intern_source(), prep.new.intern_source());
        // Slider heuristics = git's xdiff default behaviour; plain
        // `Diff::compute` (what gix's own `line_counts()` uses) diverges from
        // `git diff --numstat` on ambiguous hunks (verified against git).
        let diff = gix_diff::blob::diff_with_slider_heuristics(algorithm, &input);
        Some((diff.count_additions() as i64, diff.count_removals() as i64))
      }
      Operation::SourceOrDestinationIsBinary => None,
      Operation::ExternalCommand { .. } => {
        return Err("external diff command unexpectedly configured".to_string());
      }
    }
  };
  cache.clear_resource_cache();
  match counts {
    Some((added, removed)) => Ok((added, removed, false)),
    None => Ok((0, 0, true)),
  }
}

fn entry_kind(mode: u32) -> EntryKind {
  if is_submodule_mode(mode) {
    EntryKind::Commit
  } else if mode & 0o111 != 0 && mode & FILE_TYPE_BITS == 0o100000 {
    EntryKind::BlobExecutable
  } else if mode & FILE_TYPE_BITS == 0o120000 {
    EntryKind::Link
  } else {
    EntryKind::Blob
  }
}

/// `git diff --cached --numstat -z --find-renames --` (HEAD → index).
fn staged_numstat(repo: &gix::Repository, index: &IndexMaps, wd: &Watchdog) -> Result<Vec<NativeStatRecord>> {
  const LABEL: &str = "git diff --cached --numstat";
  let head_tree = repo
    .head_tree_id_or_empty()
    .map_err(|e| err_failed(LABEL, e))?;
  let index_state = repo.index_or_empty().map_err(|e| err_failed(LABEL, e))?;

  let mut pending: Vec<(BString, Option<BString>, gix::ObjectId, u32, gix::ObjectId, u32)> =
    Vec::new();
  // `--find-renames` is passed explicitly by legacy ⇒ rename tracking forced at
  // the default 50% threshold regardless of `diff.renames` config.
  let outcome = repo
    .tree_index_status(
      &head_tree,
      &index_state,
      None,
      gix::status::tree_index::TrackRenames::Given(Rewrites::default()),
      |change, _lhs, _rhs| {
        use gix_diff::index::ChangeRef as Change;
        match change {
          Change::Addition {
            location,
            entry_mode,
            id,
            ..
          } => pending.push((
            location.into_owned(),
            None,
            gix::ObjectId::null(repo.object_hash()),
            0,
            id.into_owned(),
            entry_mode.bits(),
          )),
          Change::Deletion {
            location,
            entry_mode,
            id,
            ..
          } => pending.push((
            location.into_owned(),
            None,
            id.into_owned(),
            entry_mode.bits(),
            gix::ObjectId::null(repo.object_hash()),
            0,
          )),
          Change::Modification {
            location,
            previous_entry_mode,
            previous_id,
            entry_mode,
            id,
            ..
          } => pending.push((
            location.into_owned(),
            None,
            previous_id.into_owned(),
            previous_entry_mode.bits(),
            id.into_owned(),
            entry_mode.bits(),
          )),
          Change::Rewrite {
            source_location,
            source_entry_mode,
            source_id,
            location,
            entry_mode,
            id,
            ..
          } => pending.push((
            location.into_owned(),
            Some(source_location.into_owned()),
            source_id.into_owned(),
            source_entry_mode.bits(),
            id.into_owned(),
            entry_mode.bits(),
          )),
        }
        if wd.interrupted() {
          Ok(std::ops::ControlFlow::Break(()))
        } else {
          Ok(std::ops::ControlFlow::Continue(()))
        }
      },
    )
    .map_err(|e| err_failed(LABEL, e))?;
  let _ = outcome;
  finish_unit(wd, LABEL)?;

  let mut cache = repo
    .diff_resource_cache_for_tree_diff()
    .map_err(|e| err_failed(LABEL, e))?;
  let mut records: Vec<NumstatRecord> = Vec::with_capacity(pending.len());
  for (path, original, old_id, old_mode, new_id, new_mode) in pending {
    if wd.interrupted() {
      return Err(err_timeout(LABEL));
    }
    let (added, removed, binary) = if is_submodule_mode(old_mode) || is_submodule_mode(new_mode) {
      (0, 0, false)
    } else {
      line_counts(
        &mut cache,
        (&old_id, entry_kind(old_mode), &path),
        (&new_id, entry_kind(new_mode), &path),
        repo,
      )
      .map_err(|err| err_failed(LABEL, err))?
    };
    records.push(NumstatRecord {
      path,
      original,
      added,
      removed,
      binary,
    });
  }

  // Legacy `git diff --cached` prints `0 0 <path>` for unmerged paths; gix's
  // index diff skips them entirely, so re-add them for byte/key parity.
  let mut conflict_paths: Vec<&BString> = index.conflict_paths.iter().collect();
  conflict_paths.sort();
  for path in conflict_paths {
    records.push(NumstatRecord {
      path: path.clone(),
      original: None,
      added: 0,
      removed: 0,
      binary: false,
    });
  }

  sort_numstat(&mut records);
  gate_numstat(&records, LABEL)?;
  Ok(to_stat_records(records))
}

/// `git diff --numstat -z --find-renames --` (index → worktree).
fn unstaged_numstat(
  repo: &gix::Repository,
  index: &IndexMaps,
  wd: &Watchdog,
) -> Result<Vec<NativeStatRecord>> {
  const LABEL: &str = "git diff --numstat";
  let null_id = gix::ObjectId::null(repo.object_hash());
  let workdir = repo
    .workdir()
    .ok_or_else(|| err_failed(LABEL, "not a worktree"))?
    .to_owned();

  let platform = repo
    .status(gix::progress::Discard)
    .map_err(|e| err_failed(LABEL, e))?
    .untracked_files(UntrackedFiles::None)
    .should_interrupt_owned(wd.flag.clone());
  let iter = platform
    .into_index_worktree_iter(Vec::<BString>::new())
    .map_err(|e| err_failed(LABEL, e))?;

  // Two caches: one reads present files from the worktree (New side has a
  // worktree root), one treats the New side as absent (deleted entries).
  let mut wt_cache = repo
    .diff_resource_cache(
      gix_diff::blob::pipeline::Mode::ToGit,
      gix_diff::blob::pipeline::WorktreeRoots {
        old_root: None,
        new_root: Some(workdir.clone()),
      },
    )
    .map_err(|e| err_failed(LABEL, e))?;
  let mut odb_cache = repo
    .diff_resource_cache_for_tree_diff()
    .map_err(|e| err_failed(LABEL, e))?;

  let mut pending: Vec<(BString, gix::ObjectId, u32)> = Vec::new();
  let mut submodule_paths: Vec<BString> = Vec::new();
  for item in iter {
    let item = item.map_err(|e| err_failed(LABEL, e))?;
    match item {
      index_worktree::Item::Modification {
        entry,
        rela_path,
        status,
        ..
      } => match status {
        EntryStatus::Change(change) => match change {
          WorktreeChange::Removed
          | WorktreeChange::Type { .. }
          | WorktreeChange::Modification { .. } => {
            pending.push((rela_path, entry.id, entry.mode.bits()));
          }
          WorktreeChange::SubmoduleModification(_) => submodule_paths.push(rela_path),
        },
        EntryStatus::IntentToAdd => {
          // Intent-to-add: index side is the empty blob ⇒ whole file counts
          // as added (`1 0 path` in legacy output).
          pending.push((rela_path, entry.id, entry.mode.bits()));
        }
        EntryStatus::Conflict { .. } | EntryStatus::NeedsUpdate(_) => {}
      },
      _ => {}
    }
  }
  finish_unit(wd, LABEL)?;

  let mut records: Vec<NumstatRecord> = Vec::with_capacity(pending.len());
  for (path, old_id, old_mode) in pending {
    if wd.interrupted() {
      return Err(err_timeout(LABEL));
    }
    let abs = worktree_path_under(&workdir, &path);
    // Presence decides which cache handles the New side: a missing file (or a
    // path replaced by a directory) diffs against an absent resource.
    let present = std::fs::symlink_metadata(&abs)
      .map(|metadata| {
        let file_type = metadata.file_type();
        file_type.is_file() || file_type.is_symlink()
      })
      .unwrap_or(false);
    let (added, removed, binary) = if present {
      let mode = fs_worktree_mode(&abs, old_mode);
      line_counts(
        &mut wt_cache,
        (&old_id, entry_kind(old_mode), &path),
        (&null_id, entry_kind(mode), &path),
        repo,
      )
      .map_err(|err| err_failed(LABEL, err))?
    } else {
      line_counts(
        &mut odb_cache,
        (&old_id, entry_kind(old_mode), &path),
        (&null_id, entry_kind(old_mode), &path),
        repo,
      )
      .map_err(|err| err_failed(LABEL, err))?
    };
    records.push(NumstatRecord {
      path,
      original: None,
      added,
      removed,
      binary,
    });
  }

  // Unmerged paths: legacy emits duplicate records whose last value wins
  // (divergence D7 — payload-irrelevant); emit a single `0 0` key.
  let mut conflict_paths: Vec<&BString> = index.conflict_paths.iter().collect();
  conflict_paths.sort();
  for path in conflict_paths {
    records.push(NumstatRecord {
      path: path.clone(),
      original: None,
      added: 0,
      removed: 0,
      binary: false,
    });
  }
  for path in submodule_paths {
    records.push(NumstatRecord {
      path,
      original: None,
      added: 0,
      removed: 0,
      binary: false,
    });
  }

  sort_numstat(&mut records);
  gate_numstat(&records, LABEL)?;
  Ok(to_stat_records(records))
}

#[napi]
pub fn status_snapshot(request: NativeStatusRequest) -> Result<AsyncTask<StatusTask>> {
  Ok(AsyncTask::new(StatusTask {
    repo_root: request.repo_root,
  }))
}

// ---------------------------------------------------------------------------
// 3. identity
// ---------------------------------------------------------------------------

fn config_scope(source: ConfigSource) -> &'static str {
  match source {
    ConfigSource::System => "system",
    ConfigSource::Git | ConfigSource::User => "global",
    ConfigSource::Local => "local",
    ConfigSource::Worktree => "worktree",
    ConfigSource::GitInstallation => "unknown",
    ConfigSource::Env | ConfigSource::Cli | ConfigSource::Api | ConfigSource::EnvOverride => {
      "command"
    }
  }
}

/// `--show-origin` string. Git prints the local config relative to the
/// worktree root (`file:.git/config` from the main tree — verified from any
/// cwd) and absolute paths everywhere else (linked worktrees, global/system,
/// includes).
fn config_origin(path: &Path, source: ConfigSource, workdir: Option<&Path>) -> String {
  let path = normalize_lexically(path);
  let path = path.as_path();
  let mapped = match source {
    ConfigSource::Local | ConfigSource::Worktree => match workdir {
      Some(workdir) if matches!(source, ConfigSource::Local) && path.starts_with(workdir) => {
        path.strip_prefix(workdir).ok().map(|rel| rel.to_path_buf())
      }
      _ => None,
    },
    _ => None,
  };
  let shown = mapped.as_deref().unwrap_or(path);
  format!("file:{}", shown.to_string_lossy().replace('\\', "/"))
}

struct IdentityValue {
  value: Option<String>,
  source: Option<String>,
  scope: Option<String>,
}

fn read_identity_value(
  plumbing: &gix_config::File,
  key: &str,
  workdir: Option<&Path>,
  wd: &Watchdog,
) -> Result<IdentityValue> {
  const LABEL: &str = "git config";
  if wd.interrupted() {
    return Err(err_timeout(LABEL));
  }
  match plumbing.value_with_section::<BString>(key) {
    Err(_) => Ok(IdentityValue {
      value: None,
      source: None,
      scope: None,
    }),
    Ok((value, section)) => {
      let meta = section.meta();
      let scope = config_scope(meta.source).to_string();
      let origin = match &meta.path {
        Some(path) => config_origin(path, meta.source, workdir),
        None => match meta.source {
          ConfigSource::Env => "env:?".to_string(),
          _ => "command line:?".to_string(),
        },
      };
      let value = String::from_utf8_lossy(&value).into_owned();
      // Byte-gate on the legacy stdout line `<scope>\t<origin>\t<value>\n`.
      let stdout_bytes = scope.len() + origin.len() + value.len() + 3;
      check_limit(stdout_bytes as u64, LABEL)?;
      Ok(IdentityValue {
        value: Some(value),
        source: Some(origin),
        scope: Some(scope),
      })
    }
  }
}

pub struct IdentityTask {
  repo_root: String,
}

impl Task for IdentityTask {
  type Output = NativeIdentity;
  type JsValue = NativeIdentity;

  fn compute(&mut self) -> Result<Self::Output> {
    const LABEL: &str = "git config";
    let repo = open_repo(&self.repo_root, LABEL)?;
    let wd = Watchdog::start();

    let snapshot = repo.config_snapshot();
    let plumbing = snapshot.plumbing();
    let workdir = repo.workdir().map(|path| path.to_owned());

    let name = read_identity_value(plumbing, "user.name", workdir.as_deref(), &wd)?;
    let email = read_identity_value(plumbing, "user.email", workdir.as_deref(), &wd)?;
    finish_unit(&wd, LABEL)?;

    Ok(NativeIdentity {
      user_name: name.value,
      user_email: email.value,
      name_source: name.source,
      email_source: email.source,
      name_scope: name.scope,
      email_scope: email.scope,
    })
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

#[napi]
pub fn identity(request: NativeIdentityRequest) -> Result<AsyncTask<IdentityTask>> {
  Ok(AsyncTask::new(IdentityTask {
    repo_root: request.repo_root,
  }))
}

// ---------------------------------------------------------------------------
// 4. branch_comparison (`git diff --numstat -z --find-renames <tracking>...HEAD`)
// ---------------------------------------------------------------------------

fn resolve_revision(repo: &gix::Repository, revision: &str) -> Option<gix::ObjectId> {
  let candidates: Vec<String> = if revision.starts_with("refs/") {
    vec![revision.to_string()]
  } else {
    vec![
      format!("refs/remotes/{revision}"),
      format!("refs/heads/{revision}"),
      format!("refs/tags/{revision}"),
      revision.to_string(),
    ]
  };
  for candidate in candidates {
    if let Ok(mut reference) = repo.find_reference(candidate.as_str()) {
      if let Ok(id) = reference.peel_to_id() {
        return Some(id.detach());
      }
    }
  }
  None
}

pub struct BranchComparisonTask {
  repo_root: String,
  tracking_branch_name: String,
}

impl Task for BranchComparisonTask {
  type Output = Vec<NativeBranchChange>;
  type JsValue = Vec<NativeBranchChange>;

  fn compute(&mut self) -> Result<Self::Output> {
    const LABEL: &str = "git diff --numstat upstream...HEAD";
    let repo = open_repo(&self.repo_root, LABEL)?;
    let wd = Watchdog::start();

    let mut head = repo.head().map_err(|e| err_failed(LABEL, e))?;
    let head_id = head
      .try_peel_to_id()
      .map_err(|e| err_failed(LABEL, e))?
      .ok_or_else(|| err_failed(LABEL, "ambiguous argument 'HEAD'"))?
      .detach();
    let tracking_id = resolve_revision(&repo, &self.tracking_branch_name)
      .ok_or_else(|| err_failed(LABEL, format!("unknown revision '{}'", self.tracking_branch_name)))?;
    let merge_base = repo
      .merge_base(head_id, tracking_id)
      .map_err(|_e| err_failed(LABEL, "no merge base"))?;

    let base_commit = repo
      .find_object(merge_base)
      .map_err(|e| err_failed(LABEL, e))?
      .into_commit();
    let head_commit = repo
      .find_object(head_id)
      .map_err(|e| err_failed(LABEL, e))?
      .into_commit();
    let base_tree = base_commit.tree().map_err(|e| err_failed(LABEL, e))?;
    let head_tree = head_commit.tree().map_err(|e| err_failed(LABEL, e))?;

    let mut options = gix::diff::Options::default();
    options.track_path();
    // Legacy passes `--find-renames` explicitly ⇒ forced at the 50% default.
    options.track_rewrites(Some(Rewrites::default()));
    let changes = repo
      .diff_tree_to_tree(Some(&base_tree), Some(&head_tree), options)
      .map_err(|e| err_failed(LABEL, e))?;
    finish_unit(&wd, LABEL)?;

    let null_id = gix::ObjectId::null(repo.object_hash());
    let mut cache = repo
      .diff_resource_cache_for_tree_diff()
      .map_err(|e| err_failed(LABEL, e))?;

    let mut records: Vec<NumstatRecord> = Vec::with_capacity(changes.len());
    for change in changes {
      if wd.interrupted() {
        return Err(err_timeout(LABEL));
      }
      use gix::object::tree::diff::ChangeDetached;
      let record = match change {
        ChangeDetached::Addition {
          location,
          entry_mode,
          id,
          ..
        } => {
          let path = location;
          let (added, removed, binary) = if entry_mode.kind() == EntryKind::Commit {
            (0, 0, false)
          } else {
            line_counts(
              &mut cache,
              (&null_id, entry_mode.kind(), &path),
              (&id, entry_mode.kind(), &path),
              &repo,
            )
            .map_err(|err| err_failed(LABEL, err))?
          };
          NumstatRecord { path, original: None, added, removed, binary }
        }
        ChangeDetached::Deletion {
          location,
          entry_mode,
          id,
          ..
        } => {
          let path = location;
          let (added, removed, binary) = if entry_mode.kind() == EntryKind::Commit {
            (0, 0, false)
          } else {
            line_counts(
              &mut cache,
              (&id, entry_mode.kind(), &path),
              (&null_id, entry_mode.kind(), &path),
              &repo,
            )
            .map_err(|err| err_failed(LABEL, err))?
          };
          NumstatRecord { path, original: None, added, removed, binary }
        }
        ChangeDetached::Modification {
          location,
          previous_entry_mode,
          previous_id,
          entry_mode,
          id,
          ..
        } => {
          let path = location;
          let (added, removed, binary) = if entry_mode.kind() == EntryKind::Commit
            || previous_entry_mode.kind() == EntryKind::Commit
          {
            (0, 0, false)
          } else {
            line_counts(
              &mut cache,
              (&previous_id, previous_entry_mode.kind(), &path),
              (&id, entry_mode.kind(), &path),
              &repo,
            )
            .map_err(|err| err_failed(LABEL, err))?
          };
          NumstatRecord { path, original: None, added, removed, binary }
        }
        ChangeDetached::Rewrite {
          source_location,
          source_entry_mode,
          source_id,
          location,
          entry_mode,
          id,
          ..
        } => {
          let path = location;
          let original = source_location;
          let (added, removed, binary) = if entry_mode.kind() == EntryKind::Commit
            || source_entry_mode.kind() == EntryKind::Commit
          {
            (0, 0, false)
          } else {
            line_counts(
              &mut cache,
              (&source_id, source_entry_mode.kind(), &original),
              (&id, entry_mode.kind(), &path),
              &repo,
            )
            .map_err(|err| err_failed(LABEL, err))?
          };
          NumstatRecord {
            path,
            original: Some(original),
            added,
            removed,
            binary,
          }
        }
      };
      records.push(record);
    }

    sort_numstat(&mut records);
    gate_numstat(&records, LABEL)?;

    Ok(records
      .into_iter()
      .map(|record| NativeBranchChange {
        path: lossy(&record.path),
        original_path: record.original.as_deref().map(lossy),
        added: record.added,
        removed: record.removed,
        kind: record_kind(&record).to_string(),
      })
      .collect())
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

#[napi]
pub fn branch_comparison(
  request: NativeBranchComparisonRequest,
) -> Result<AsyncTask<BranchComparisonTask>> {
  Ok(AsyncTask::new(BranchComparisonTask {
    repo_root: request.repo_root,
    tracking_branch_name: request.tracking_branch_name,
  }))
}
