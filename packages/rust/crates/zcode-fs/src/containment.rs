//! Filesystem confinement: the root allowlist every path-taking export carries.
//!
//! Spec: docs/specs/rust-native-fs.md §3.1-§3.2. The rule is one sentence:
//! **a requested path is accepted only if its canonical form (every symlink
//! resolved) is equal to, or underneath, a canonical root.** Because
//! [`std::fs::canonicalize`] resolves every component first, a symlink inside a
//! root that points outside it, and a `..` segment that walks out of it, both
//! fail the comparison. Nothing here is optional: the request types in `lib.rs`
//! declare `roots` as a required field, so an unchecked call site cannot be
//! written.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub use napi::Error;

/// Every filesystem error this crate raises is an `Error<String>` so the string
/// becomes the JavaScript `Error.code`. `ENOENT`/`EACCES`/… then read exactly
/// like the `node:fs` codes the TypeScript predecessor threw, instead of the
/// generic `GenericFailure` a `Status` variant would produce.
pub type FsResult<T> = std::result::Result<T, Error<String>>;

/// A rejection, a policy error, or a contract violation: no errno involved, so
/// the predecessor threw a plain `Error` (whose `.code` is `undefined`). napi
/// always attaches a `code`, so these carry `GenericFailure`; the *message* is
/// byte-identical to the predecessor's, which is what every caller renders.
pub fn reject(reason: impl Into<String>) -> Error<String> {
  Error::new(STATUS_GENERIC.to_string(), reason.into())
}

const STATUS_GENERIC: &str = "GenericFailure";

/// libuv's errno → `code` table (the strings Node puts in `Error.code`).
/// `ErrorKind` covers the portable cases and raw OS codes fill in the
/// Unix-specific ones; Windows raises its own code numbers, which fall through
/// to `EIO` rather than being mislabelled.
fn errno_code(error: &std::io::Error) -> &'static str {
  match error.raw_os_error() {
    Some(1) => "EPERM",
    Some(13) => "EACCES",
    Some(17) => "EEXIST",
    Some(18) => "EXDEV",
    Some(20) => "ENOTDIR",
    Some(21) => "EISDIR",
    Some(22) => "EINVAL",
    Some(28) => "ENOSPC",
    Some(30) => "EROFS",
    Some(31) => "EMLINK",
    Some(36) => "ENAMETOOLONG",
    Some(39) => "ENOTEMPTY",
    Some(40) => "ELOOP",
    _ => match error.kind() {
      ErrorKind::NotFound => "ENOENT",
      ErrorKind::PermissionDenied => "EACCES",
      ErrorKind::AlreadyExists => "EEXIST",
      ErrorKind::InvalidInput => "EINVAL",
      _ => "EIO",
    },
  }
}
/// libuv's errno → message table, so the message reads like `node:fs`:
/// `ENOENT: no such file or directory, stat '/x'`. Rust's `io::Error` `Display`
/// is `No such file or directory (os error 2)`, which is neither the same
/// casing nor the same shape, so it is not usable here.
fn errno_message(code: &str) -> &'static str {
  match code {
    "ENOENT" => "no such file or directory",
    "EACCES" => "permission denied",
    "EPERM" => "operation not permitted",
    "EEXIST" => "file already exists",
    "EINVAL" => "invalid argument",
    "ENOTDIR" => "not a directory",
    "EISDIR" => "illegal operation on a directory",
    "ENOSPC" => "no space left on device",
    "EROFS" => "read-only file system",
    "EMLINK" => "too many links",
    "ENAMETOOLONG" => "name too long",
    "ENOTEMPTY" => "directory not empty",
    "ELOOP" => "too many symbolic links encountered",
    "EXDEV" => "cross-device link not permitted",
    _ => "i/o error",
  }
}

/// Reproduces `node:fs`'s error message for a failed syscall, and carries the
/// matching `code`. `syscall` must be the name the predecessor would have used
/// (`realpath`, `stat`, `scandir`, `open`, `mkdir`, `access`) so renderer error
/// text is unchanged.
pub fn syscall_error(error: &std::io::Error, syscall: &str, path: &str) -> Error<String> {
  let code = errno_code(error);
  Error::new(
    code.to_string(),
    format!("{code}: {}, {syscall} '{path}'", errno_message(code)),
  )
}

/// The canonicalized allowlist a single call is confined to.
#[derive(Debug, Default)]
pub struct Roots {
  canonical: Vec<PathBuf>,
}

impl Roots {
  /// Canonicalizes each root once. A root that cannot be canonicalized (it was
  /// deleted, or a parent is unreadable) is **skipped**, not an error: it cannot
  /// contain anything, so dropping it is fail-closed. If every root is dropped
  /// the result contains nothing and every path is rejected.
  pub fn from_raw(raw: &[String]) -> Self {
    let mut canonical = Vec::with_capacity(raw.len());
    for root in raw {
      if let Ok(resolved) = std::fs::canonicalize(root) {
        canonical.push(resolved);
      }
    }
    Self { canonical }
  }

  pub fn is_empty(&self) -> bool {
    self.canonical.is_empty()
  }

  /// Canonicalizes `requested` and asserts containment. `syscall` labels the
  /// error when the path does not exist, so the message matches whichever
  /// predecessor call site reached this (see [`syscall_error`]).
  pub fn resolve(&self, requested: &str, syscall: &str) -> FsResult<PathBuf> {
    let canonical = std::fs::canonicalize(requested)
      .map_err(|error| syscall_error(&error, syscall, requested))?;
    if self.contains(&canonical) {
      Ok(canonical)
    } else {
      Err(out_of_root(requested))
    }
  }

  /// Same as [`Roots::resolve`], but for a path that is *allowed not to exist*:
  /// an existence check has to answer "no" rather than fail. Returns the
  /// canonical path when it exists, and `None` when it does not — and in both
  /// cases only after the path has been proved to be inside the allowlist.
  ///
  /// A missing path cannot be canonicalized, so containment is decided on the
  /// deepest ancestor that *can* be: the path is walked component by
  /// component, each existing prefix replaced by its canonical form (which is
  /// what folds every symlink and every resolvable `..`), and the remainder
  /// kept lexically. `base` therefore only ever holds a proven path, and
  /// popping it with `..` cannot lead outside what has been proven so far.
  pub fn admit(&self, requested: &str, syscall: &str) -> FsResult<Option<PathBuf>> {
    match std::fs::canonicalize(requested) {
      Ok(canonical) if self.contains(&canonical) => Ok(Some(canonical)),
      Ok(_) => Err(out_of_root(requested)),
      Err(error) if error.kind() == ErrorKind::NotFound => {
        self.admit_absent(requested)?;
        Ok(None)
      }
      Err(error) => Err(syscall_error(&error, syscall, requested)),
    }
  }

  fn admit_absent(&self, requested: &str) -> FsResult<()> {
    use std::path::Component;
    let mut base = PathBuf::new();
    let mut missing = 0usize;
    for component in Path::new(requested).components() {
      match component {
        Component::Prefix(prefix) => base = PathBuf::from(prefix.as_os_str()),
        Component::RootDir => base = PathBuf::from(std::path::MAIN_SEPARATOR_STR),
        Component::CurDir => {}
        Component::ParentDir => {
          base.pop();
          missing += 1;
        }
        Component::Normal(name) => {
          if missing > 0 {
            missing += 1;
            continue;
          }
          match std::fs::canonicalize(base.join(name)) {
            Ok(canonical) => base = canonical,
            Err(_) => missing += 1,
          }
        }
      }
    }
    if missing == 0 || self.contains(&base) {
      Ok(())
    } else {
      Err(out_of_root(requested))
    }
  }

  /// `Path::starts_with` compares whole components, so `/ws-evil/x` does **not**
  /// start with `/ws`. That is the sibling-prefix guard; no manual separator is
  /// appended and none is needed.
  fn contains(&self, canonical: &Path) -> bool {
    self
      .canonical
      .iter()
      .any(|root| canonical == root.as_path() || canonical.starts_with(root))
  }
}

/// The single rejection message for every escape class (symlink, `..`, sibling
/// prefix, empty allowlist). It names the **requested** path, because that is
/// what the caller sent and what an operator needs to see in a log.
pub fn out_of_root(requested: &str) -> Error<String> {
  reject(format!("Path is not inside an allowed root: {requested}"))
}

/// `Path is not a file: <path>` — the predecessor's guard on every read entry
/// point, checked after containment so an out-of-root probe never reports itself
/// as "not a file".
pub fn not_a_file(requested: &str) -> Error<String> {
  reject(format!("Path is not a file: {requested}"))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zcode-fs-containment-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch");
    dir
  }

  #[test]
  fn accepts_the_root_itself_and_its_descendants() {
    let root = scratch("accept");
    let file = root.join("inside.txt");
    fs::write(&file, b"ok").unwrap();
    let roots = Roots::from_raw(&[root.to_string_lossy().into_owned()]);
    assert!(roots.contains(&fs::canonicalize(&root).unwrap()));
    assert!(roots.contains(&fs::canonicalize(&file).unwrap()));
    assert!(roots.resolve(&file.to_string_lossy(), "stat").is_ok());
  }

  #[test]
  fn empty_allowlist_rejects_everything() {
    let root = scratch("empty");
    let file = root.join("inside.txt");
    fs::write(&file, b"ok").unwrap();
    let roots = Roots::from_raw(&[]);
    let error = roots.resolve(&file.to_string_lossy(), "stat").unwrap_err();
    assert_eq!(error.status, STATUS_GENERIC);
    assert_eq!(
      error.reason,
      format!("Path is not inside an allowed root: {}", file.to_string_lossy())
    );
  }

  #[test]
  fn rejects_escape_through_a_symlink() {
    let base = scratch("symlink");
    let root = base.join("ws");
    let outside = base.join("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let secret = outside.join("secret.txt");
    fs::write(&secret, b"top secret").unwrap();
    let link = root.join("link-out");
    let _ = fs::remove_file(&link);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&outside, &link).unwrap();

    let roots = Roots::from_raw(&[root.to_string_lossy().into_owned()]);
    let error = roots
      .resolve(&link.join("secret.txt").to_string_lossy(), "realpath")
      .unwrap_err();
    assert!(error.reason.starts_with("Path is not inside an allowed root:"));
  }

  #[test]
  fn rejects_escape_through_dotdot() {
    let base = scratch("dotdot");
    let root = base.join("ws");
    let outside = base.join("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), b"top secret").unwrap();
    let roots = Roots::from_raw(&[root.to_string_lossy().into_owned()]);
    let escapee = root.join("..").join("outside").join("secret.txt");
    let error = roots.resolve(&escapee.to_string_lossy(), "realpath").unwrap_err();
    assert!(error.reason.starts_with("Path is not inside an allowed root:"));
  }

  #[test]
  fn rejects_sibling_prefix_confusion() {
    let base = scratch("sibling");
    let root = base.join("ws");
    let sibling = base.join("ws-evil");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    fs::write(sibling.join("secret.txt"), b"nope").unwrap();
    let roots = Roots::from_raw(&[root.to_string_lossy().into_owned()]);
    let error = roots
      .resolve(&sibling.join("secret.txt").to_string_lossy(), "realpath")
      .unwrap_err();
    assert!(error.reason.starts_with("Path is not inside an allowed root:"));
  }

  #[test]
  fn missing_path_reports_the_callers_syscall() {
    let root = scratch("missing");
    let roots = Roots::from_raw(&[root.to_string_lossy().into_owned()]);
    let missing = root.join("nope.txt");
    for syscall in ["stat", "scandir", "realpath"] {
      let error = roots.resolve(&missing.to_string_lossy(), syscall).unwrap_err();
      assert_eq!(error.status, "ENOENT");
      assert_eq!(
        error.reason,
        format!("ENOENT: no such file or directory, {syscall} '{}'", missing.to_string_lossy())
      );
    }
  }

  #[test]
  fn unresolvable_roots_are_skipped_not_fatal() {
    let base = scratch("badroot");
    let root = base.join("ws");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("a.txt"), b"a").unwrap();
    let roots = Roots::from_raw(&[
      base.join("does-not-exist").to_string_lossy().into_owned(),
      root.to_string_lossy().into_owned(),
    ]);
    assert!(!roots.is_empty());
    assert!(roots.resolve(&root.join("a.txt").to_string_lossy(), "stat").is_ok());
  }

  #[test]
  fn errno_messages_match_node() {
    let error = std::io::Error::from_raw_os_error(2);
    let wrapped = syscall_error(&error, "stat", "/x");
    assert_eq!(wrapped.status, "ENOENT");
    assert_eq!(wrapped.reason, "ENOENT: no such file or directory, stat '/x'");
    let denied = syscall_error(&std::io::Error::from_raw_os_error(13), "open", "/x");
    assert_eq!(denied.status, "EACCES");
    assert_eq!(denied.reason, "EACCES: permission denied, open '/x'");
  }
}
