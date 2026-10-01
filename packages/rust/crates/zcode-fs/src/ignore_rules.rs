//! `.zcodeignore` — the single source of truth for workspace file-search
//! exclusions, and the gitignore matcher that applies it.
//!
//! Port of `packages/services/src/file/workspaceFileIgnore.ts` (deleted by this
//! port). The module-level contract from the predecessor's header is kept
//! verbatim: rule parsing is delegated to the gitignore-spec 2.22 reference
//! implementation, never hand-written. The predecessor used the npm `ignore`
//! package; this crate uses its Rust counterpart (`ignore` 0.4, same spec, same
//! author), so the rules — later-declaration override, `!` negation with git's
//! parent-exclusion constraint, anchoring, `**`, the `/` directory suffix,
//! character classes, escapes — behave identically.
//!
//! Everything here is file-content shaping plus one atomic write. The matching
//! itself lives in [`crate::walk`], which applies the matcher to every entry of
//! a walk without crossing the FFI boundary once per entry.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::containment::{self, Error, FsResult, reject};

pub const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME: &str = ".zcodeignore";
const GITIGNORE_FILE_NAME: &str = ".gitignore";

/// The retired default directory blacklist, expressed in gitignore syntax so a
/// workspace created from scratch prunes what the old default pruned.
const BUILTIN_IGNORE_LINES: &[&str] = &[
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "__pycache__/",
  "site-packages/",
  "venv/",
  "coverage/",
  "htmlcov/",
  "lcov-report/",
  "cmakefiles/",
  "cmake-build-*/",
  "bazel-*/",
  "pods/",
  "deriveddata/",
  "storybook-static/",
  "playwright-report/",
  "test-results/",
  "allure-results/",
  "allure-report/",
  "cdk.out/",
  "*.egg-info/",
  "*.dist-info/",
  "eggs/",
  "pip-wheel-metadata/",
  "wheels/",
];

const TEMPLATE_HEADER: &[&str] = &[
  "# ZCode workspace file search ignore rules (.zcodeignore)",
  "# Syntax matches .gitignore; only affects ZCode's @ file candidates / Command Center / file tree search,",
  "# and does not affect file tree browsing, uploads, or Agent file access.",
  "# Editing .gitignore does not sync to this file automatically; use \"Sync from .gitignore\" in settings.",
  "",
];

const SYNC_MARKER: &str =
  "# ===== ↑ above is synced from .gitignore (\"Sync from .gitignore\" only rewrites the part above) =====";
const DEFAULTS_MARKER: &str = "# ----- ↑ above are ZCode default exclusion rules (put custom rules below this line; sync/restore never touches them) -----";
const CUSTOM_SECTION_HINT: &str = "# Custom rules go below (this hint line can be deleted)";

/// Where the effective rules came from. Mirrors the predecessor's union: the
/// first two are the settings page's `content`/`source` pair, the rest describe
/// the runtime load chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RulesSource {
  File,
  CreatedFromGitignore,
  CreatedFromTemplate,
  FallbackGitignore,
  FallbackBuiltin,
}

impl RulesSource {
  pub fn as_str(self) -> &'static str {
    match self {
      RulesSource::File => "file",
      RulesSource::CreatedFromGitignore => "created-from-gitignore",
      RulesSource::CreatedFromTemplate => "created-from-template",
      RulesSource::FallbackGitignore => "fallback-gitignore",
      RulesSource::FallbackBuiltin => "fallback-builtin",
    }
  }
}

/// The result of loading the rules, plus the two things the host cache needs:
/// whether the file was created by this load, and a one-line reason when the
/// chain degraded (the host logs it once per load, as the predecessor did).
#[derive(Debug, Clone)]
pub struct LoadedRules {
  pub content: String,
  pub source: RulesSource,
  pub created: bool,
  pub degraded_reason: Option<String>,
  /// `mtimeMs:size` of `.zcodeignore`, or `none` when it is absent. This is the
  /// host cache signature: a rules edit invalidates the index on the next use.
  pub fingerprint: String,
}

/// `String.prototype.split(/\r?\n/)`: split on `\n`, drop one trailing `\r`.
/// The npm `ignore` package splits rules the same way, so both sides agree on
/// what a "line" is even for a CRLF rules file.
fn split_lines(content: &str) -> Vec<&str> {
  content
    .split('\n')
    .map(|line| line.strip_suffix('\r').unwrap_or(line))
    .collect()
}

/// The default exclusion section, with rules the gitignore copy already declares
/// removed so the file never carries two copies of the same rule. The judgment
/// is conservative: trimmed equality, or a single trailing `/` difference.
fn builtin_defaults_section(gitignore: Option<&str>) -> String {
  let Some(gitignore) = gitignore else {
    return BUILTIN_IGNORE_LINES.join("\n");
  };
  let mut declared: Vec<String> = Vec::new();
  for raw in split_lines(gitignore) {
    let line = raw.trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
      continue;
    }
    declared.push(line.to_string());
    declared.push(line.strip_suffix('/').unwrap_or(line).to_string());
  }
  BUILTIN_IGNORE_LINES
    .iter()
    .copied()
    .filter(|line| {
      let bare = line.strip_suffix('/').unwrap_or(line);
      !declared.iter().any(|d| d == line || d == bare)
    })
    .collect::<Vec<_>>()
    .join("\n")
}

/// Builds the initial `.zcodeignore` content: a copy of `.gitignore` plus the
/// two-marker split. Appending the default section is a behavioral compatibility
/// requirement — for a repo whose `.gitignore` does not declare `node_modules`, a
/// strict copy alone would leave dependency directories fully open to scanning.
pub fn build_template(gitignore: Option<&str>) -> String {
  let gitignore_section = match gitignore {
    Some(content) if !content.trim().is_empty() => {
      if content.ends_with('\n') {
        content.to_string()
      } else {
        format!("{content}\n")
      }
    }
    _ => format!("{}\n", TEMPLATE_HEADER.join("\n")),
  };
  [
    gitignore_section.as_str(),
    SYNC_MARKER,
    builtin_defaults_section(gitignore).as_str(),
    DEFAULTS_MARKER,
    CUSTOM_SECTION_HINT,
    "",
  ]
  .join("\n")
}

struct Sections {
  gitignore: String,
  defaults: String,
  custom: String,
}

/// Splits the file by the two markers. `None` when either marker is missing
/// (legacy format or user deletion) — the caller then degrades into a full
/// rebuild, exactly as the predecessor did.
fn split_sections(content: &str) -> Option<Sections> {
  let lines = split_lines(content);
  let sync_at = lines.iter().position(|line| line.trim() == SYNC_MARKER);
  let defaults_at = lines.iter().position(|line| line.trim() == DEFAULTS_MARKER);
  let (sync_at, defaults_at) = (sync_at?, defaults_at?);
  if defaults_at <= sync_at {
    return None;
  }
  Some(Sections {
    gitignore: lines[..sync_at].join("\n"),
    defaults: lines[sync_at + 1..defaults_at].join("\n").trim().to_string(),
    custom: lines[defaults_at + 1..].join("\n").trim_start_matches('\n').to_string(),
  })
}

/// `String.prototype.replace(/\n+$/, "\n")` — collapse trailing newlines to one.
fn collapse_trailing_newlines(value: String) -> String {
  let trimmed = value.trim_end_matches('\n');
  format!("{trimmed}\n")
}

/// "Sync from .gitignore": rewrites only the section above the SYNC marker.
pub fn sync_from_gitignore(current: &str, gitignore: Option<&str>) -> String {
  let Some(sections) = split_sections(current) else {
    return build_template(gitignore);
  };
  let gitignore_section = match gitignore {
    Some(content) if !content.trim().is_empty() => {
      if content.ends_with('\n') {
        content.to_string()
      } else {
        format!("{content}\n")
      }
    }
    _ => format!("{}\n", TEMPLATE_HEADER.join("\n")),
  };
  collapse_trailing_newlines(
    [
      gitignore_section.as_str(),
      SYNC_MARKER,
      sections.defaults.as_str(),
      DEFAULTS_MARKER,
      sections.custom.as_str(),
    ]
    .join("\n"),
  )
}

/// "Restore default rules": rewrites only the default exclusion section, and
/// de-duplicates it against the current gitignore section.
pub fn reset_defaults(current: &str, gitignore: Option<&str>) -> String {
  let Some(sections) = split_sections(current) else {
    return build_template(gitignore);
  };
  collapse_trailing_newlines(
    [
      sections.gitignore.as_str(),
      SYNC_MARKER,
      builtin_defaults_section(Some(&sections.gitignore)).as_str(),
      DEFAULTS_MARKER,
      sections.custom.as_str(),
    ]
    .join("\n"),
  )
}

/// The transform the settings page drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transform {
  SyncGitignore,
  ResetDefaults,
}

impl Transform {
  pub fn parse(value: &str) -> FsResult<Self> {
    match value {
      "sync-gitignore" => Ok(Transform::SyncGitignore),
      "reset-defaults" => Ok(Transform::ResetDefaults),
      other => Err(reject(format!("Unknown workspace ignore transform: {other}"))),
    }
  }
}

fn ignore_path(root: &Path) -> PathBuf {
  root.join(WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME)
}

fn gitignore_path(root: &Path) -> PathBuf {
  root.join(GITIGNORE_FILE_NAME)
}

/// Reads an optional text file. `Ok(None)` for "absent"; a real error for
/// anything else, which the caller turns into the fail-open chain.
fn read_optional(path: &Path) -> FsResult<Option<String>> {
  match std::fs::read(path) {
    Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(containment::syscall_error(
      &error,
      "open",
      &path.to_string_lossy(),
    )),
  }
}

/// Read-for-settings: never writes. A missing file yields the initial content
/// preview, tagged `template`.
pub fn read_for_settings(root: &Path) -> (String, &'static str) {
  match read_optional(&ignore_path(root)) {
    Ok(Some(content)) => (content, "file"),
    _ => {
      let gitignore = read_optional(&gitignore_path(root)).ok().flatten();
      (build_template(gitignore.as_deref()), "template")
    }
  }
}

/// Compute-only transform: returns the new content for the editor. Only a save
/// writes, so this touches no state.
pub fn transform_for_settings(root: &Path, transform: Transform) -> String {
  let existing = read_optional(&ignore_path(root)).ok().flatten();
  let gitignore = read_optional(&gitignore_path(root)).ok().flatten();
  let current = existing.unwrap_or_else(|| build_template(gitignore.as_deref()));
  match transform {
    Transform::SyncGitignore => sync_from_gitignore(&current, gitignore.as_deref()),
    Transform::ResetDefaults => reset_defaults(&current, gitignore.as_deref()),
  }
}

fn fingerprint(root: &Path) -> String {
  match std::fs::metadata(ignore_path(root)) {
    Ok(meta) => format!("{}:{}", mtime_ms(&meta), meta.len()),
    Err(_) => "none".to_string(),
  }
}

/// `fs.stat().mtimeMs`: milliseconds since the epoch as a float. The value only
/// has to be stable within a process and change when the file changes, which is
/// the host cache's whole contract.
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
  meta
    .modified()
    .ok()
    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
    .map(|delta| delta.as_secs_f64() * 1000.0)
    .unwrap_or(0.0)
}

/// The load chain: file → create-from-gitignore-or-template → fail open to
/// `.gitignore` in memory → fail open to the built-in template. The @ panel must
/// never fail to scan because the rules file is unavailable, so every read and
/// create error degrades instead of propagating; the reason rides back to the
/// host, which logs it exactly as `workspaceFileIgnore.ts:307-384` did.
pub fn load(root: &Path) -> LoadedRules {
  match read_optional(&ignore_path(root)) {
    Ok(Some(content)) => {
      return LoadedRules {
        content,
        source: RulesSource::File,
        created: false,
        degraded_reason: None,
        fingerprint: fingerprint(root),
      };
    }
    Ok(None) => {}
    Err(error) => {
      return degrade(
        root,
        format!("failed to read {WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}"),
        &error.reason,
      );
    }
  }

  let gitignore = read_optional(&gitignore_path(root)).ok().flatten();
  let initial = build_template(gitignore.as_deref());
  match atomic_write(&ignore_path(root), &initial) {
    Ok(()) => LoadedRules {
      content: initial,
      source: match gitignore {
        Some(_) => RulesSource::CreatedFromGitignore,
        None => RulesSource::CreatedFromTemplate,
      },
      created: true,
      degraded_reason: None,
      fingerprint: fingerprint(root),
    },
    Err(error) => {
      // The initial content is deterministically known, so a failed create only
      // costs persistence, not correctness: run it from memory and say so.
      let reason = format!("failed to auto-create {WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}");
      let source = if gitignore.is_some() {
        RulesSource::FallbackGitignore
      } else {
        RulesSource::FallbackBuiltin
      };
      LoadedRules {
        content: initial,
        source,
        created: false,
        degraded_reason: Some(reason),
        fingerprint: fingerprint(root),
      }
      .with_error(&error)
    }
  }
}

impl LoadedRules {
  /// Attaches the write error to the degradation reason, matching the
  /// predecessor's warn line, which interpolated the underlying error.
  fn with_error(mut self, error: &Error<String>) -> Self {
    if let Some(reason) = self.degraded_reason.take() {
      self.degraded_reason = Some(format!("{reason}: {}", error.reason));
    }
    self
  }
}

fn degrade(root: &Path, reason: String, error: &str) -> LoadedRules {
  let gitignore = read_optional(&gitignore_path(root)).ok().flatten();
  let (content, source) = match gitignore {
    Some(content) => (content, RulesSource::FallbackGitignore),
    None => (build_template(None), RulesSource::FallbackBuiltin),
  };
  LoadedRules {
    content,
    source,
    created: false,
    degraded_reason: Some(format!("{reason}: {error}")),
    fingerprint: fingerprint(root),
  }
}

/// Atomic write: a temp file in the target directory (write + `fsync` + close),
/// then `rename` over the target, so a settings save is never observed
/// half-written. Temp names carry pid, nanoseconds and a counter because the
/// file is created with `O_EXCL`; a collision retries.
pub fn atomic_write(path: &Path, content: &str) -> FsResult<()> {
  static COUNTER: AtomicU64 = AtomicU64::new(0);
  let directory = path.parent().unwrap_or_else(|| Path::new("."));
  let display = path.to_string_lossy().into_owned();
  let base = path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| display.clone());

  let mut last: Option<std::io::Error> = None;
  for _ in 0..8 {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|delta| delta.as_nanos() as u64)
      .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = directory.join(format!(".{base}.{}.{nanos}.{seq}.tmp", std::process::id()));
    match write_temp(&temp, content) {
      Ok(()) => {
        return std::fs::rename(&temp, path).map_err(|error| {
          let _ = std::fs::remove_file(&temp);
          containment::syscall_error(&error, "rename", &display)
        });
      }
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
        last = Some(error);
        continue;
      }
      Err(error) => {
        let _ = std::fs::remove_file(&temp);
        return Err(containment::syscall_error(
          &error,
          "open",
          &temp.to_string_lossy(),
        ));
      }
    }
  }
  Err(containment::syscall_error(
    &last.unwrap_or_else(|| std::io::Error::from(std::io::ErrorKind::AlreadyExists)),
    "open",
    &display,
  ))
}

/// Writes the temp file, flushes it to disk, and closes it. 0o644 is the mode
/// the predecessor's `open(tempPath, "wx", 0o644)` used; `OpenOptions::mode` is
/// Unix-only, so the Windows build takes the inherited default instead.
#[cfg(unix)]
fn write_temp(temp: &Path, content: &str) -> std::io::Result<()> {
  use std::os::unix::fs::OpenOptionsExt;
  let mut file = std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .mode(0o644)
    .open(temp)?;
  file.write_all(content.as_bytes())?;
  file.sync_all()?;
  drop(file);
  Ok(())
}

#[cfg(not(unix))]
fn write_temp(temp: &Path, content: &str) -> std::io::Result<()> {
  let mut file = std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(temp)?;
  file.write_all(content.as_bytes())?;
  file.sync_all()?;
  drop(file);
  Ok(())
}

/// Compiles rules content into a matcher. The npm `ignore` package defaults to
/// case-insensitive matching, so the builder must too or `NODE_MODULES/` would
/// stop being pruned.
pub fn compile(content: &str) -> FsResult<Gitignore> {
  let mut builder = GitignoreBuilder::new("");
  // Only fails on a closed-bracket pattern, which `add_line` already rejected.
  let _ = builder.case_insensitive(true);
  for line in split_lines(content) {
    // A malformed line must not take the whole index down: the predecessor's
    // `ignore.add()` skipped what it could not parse, and gitignore's rule is
    // that the index is best-effort.
    let _ = builder.add_line(None, line);
  }
  builder
    .build()
    .map_err(|error| reject(format!("Invalid ignore rules: {error}")))
}

/// `isWorkspaceFileSearchPathIgnored`. `parent` is `matched_path_or_any_parents`,
/// not `matched`, because the npm `ignores()` walks the parent chain: a file
/// under an ignored directory is ignored even when no rule names the file.
pub fn is_ignored(matcher: &Gitignore, relative_path: &str, is_directory: bool) -> bool {
  matcher
    .matched_path_or_any_parents(relative_path, is_directory)
    .is_ignore()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zcode-fs-ignore-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch");
    dir
  }

  #[test]
  fn template_without_gitignore_is_the_header_plus_defaults() {
    let content = build_template(None);
    assert!(content.starts_with("# ZCode workspace file search ignore rules (.zcodeignore)"));
    assert!(content.contains(SYNC_MARKER));
    assert!(content.contains(DEFAULTS_MARKER));
    assert!(content.ends_with("# Custom rules go below (this hint line can be deleted)\n"));
    assert!(content.contains("\nnode_modules/\n"));
  }

  #[test]
  fn defaults_deduplicate_against_the_gitignore_copy() {
    let content = build_template(Some("node_modules/\ndist/\n"));
    let sections = split_sections(&content).expect("markers present");
    assert!(!sections.defaults.contains("\nnode_modules/\n"));
    assert!(sections.defaults.contains("\ndist/\n") == false, "dist is not builtin");
    assert!(sections.defaults.contains("cmake-build-*/"), "unrelated rules stay");
  }

  #[test]
  fn defaults_dedup_ignores_a_single_trailing_slash() {
    let content = build_template(Some("node_modules\n"));
    let sections = split_sections(&content).expect("markers present");
    assert!(!sections.defaults.contains("node_modules"));
  }

  #[test]
  fn sync_rewrites_only_the_gitignore_section() {
    let original = build_template(Some("dist/\n"));
    let sections = split_sections(&original).unwrap();
    let synced = sync_from_gitignore(&original, Some("target/\n"));
    let after = split_sections(&synced).unwrap();
    assert!(after.gitignore.starts_with("target/\n"));
    assert_eq!(after.defaults, sections.defaults, "defaults section untouched");
    assert_eq!(after.custom, sections.custom, "custom section untouched");
  }

  #[test]
  fn reset_rewrites_only_the_defaults_section() {
    let original = build_template(Some("dist/\n"));
    let sections = split_sections(&original).unwrap();
    let reset = reset_defaults(&original, Some("dist/\n"));
    let after = split_sections(&reset).unwrap();
    assert_eq!(after.gitignore, sections.gitignore);
    assert_eq!(after.defaults, builtin_defaults_section(Some("dist/\n")));
    assert_eq!(after.custom, sections.custom);
  }

  #[test]
  fn a_missing_marker_degrades_to_a_full_rebuild() {
    let legacy = "dist/\nnode_modules/\n";
    assert_eq!(sync_from_gitignore(legacy, Some("x/\n")), build_template(Some("x/\n")));
    assert_eq!(reset_defaults(legacy, Some("x/\n")), build_template(Some("x/\n")));
  }

  #[test]
  fn crlf_rules_survive_the_split() {
    let crlf = build_template(Some("dist/\r\n")).replace('\n', "\r\n");
    let sections = split_sections(&crlf).expect("markers present despite CRLF");
    assert!(sections.defaults.contains("node_modules/"));
  }

  #[test]
  fn matcher_follows_parents_like_the_npm_package() {
    let matcher = compile("build/\n*.log\n!keep.log\n").unwrap();
    assert!(is_ignored(&matcher, "build", true));
    assert!(is_ignored(&matcher, "build/out.txt", false), "parent wins");
    assert!(is_ignored(&matcher, "deep/nested/app.log", false));
    assert!(!is_ignored(&matcher, "keep.log", false), "negation re-includes");
    assert!(!is_ignored(&matcher, "src/index.ts", false));
  }

  #[test]
  fn matcher_is_case_insensitive_like_the_npm_default() {
    let matcher = compile("node_modules/\n").unwrap();
    assert!(is_ignored(&matcher, "NODE_MODULES", true));
  }

  #[test]
  fn load_creates_the_file_from_gitignore_then_reports_file() {
    let root = scratch("load-create");
    fs::write(root.join(GITIGNORE_FILE_NAME), "dist/\n").unwrap();
    let first = load(&root);
    assert!(first.created);
    assert_eq!(first.source, RulesSource::CreatedFromGitignore);
    assert!(first.content.starts_with("dist/\n"));
    assert!(!first.fingerprint.eq_ignore_ascii_case("none"));
    let second = load(&root);
    assert!(!second.created);
    assert_eq!(second.source, RulesSource::File);
    assert_eq!(second.content, first.content);
  }

  #[test]
  fn load_uses_the_builtin_template_when_there_is_no_gitignore() {
    let root = scratch("load-template");
    let loaded = load(&root);
    assert_eq!(loaded.source, RulesSource::CreatedFromTemplate);
    assert!(loaded.content.starts_with("# ZCode workspace file search ignore rules"));
  }

  #[test]
  fn settings_read_never_writes() {
    let root = scratch("settings-read");
    fs::write(root.join(GITIGNORE_FILE_NAME), "dist/\n").unwrap();
    let (content, source) = read_for_settings(&root);
    assert_eq!(source, "template");
    assert!(content.starts_with("dist/\n"));
    assert!(!ignore_path(&root).exists(), "a preview must not create the file");
  }

  #[test]
  fn atomic_write_replaces_in_place_and_leaves_no_temp_files() {
    let root = scratch("atomic");
    let target = root.join("rules.txt");
    atomic_write(&target, "first\n").unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "first\n");
    atomic_write(&target, "second\n").unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "second\n");
    let leftovers: Vec<_> = fs::read_dir(&root)
      .unwrap()
      .filter_map(|entry| entry.ok())
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .filter(|name| name.ends_with(".tmp"))
      .collect();
    assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
  }

  #[test]
  fn unknown_transform_is_rejected() {
    let error = Transform::parse("nope").unwrap_err();
    assert_eq!(error.reason, "Unknown workspace ignore transform: nope");
  }
}
