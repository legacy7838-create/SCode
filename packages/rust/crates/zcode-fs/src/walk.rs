//! Directory walking: the single-directory listing behind `readdir`, and the
//! full repository walk behind the workspace file index.
//!
//! Both share one rule, taken from `fileService.ts:176-195`: Node's `Dirent`
//! reports `isSymbolicLink` for a symlinked *directory* without reporting
//! `isDirectory`, so the type is resolved by `stat`-ing the target — and a
//! broken symlink resolves to `"file"`, because the selector only ever
//! distinguishes the two.
//!
//! The repository walk is what this port is really for: it evaluates the
//! gitignore matcher and the mention filter for every entry in machine code
//! instead of in JavaScript. Ordering, sorting and packing stay in TypeScript
//! (`localeCompare` is ICU collation and cannot be reproduced byte-for-byte in
//! Rust), so what crosses the boundary is an unordered entry list and what the
//! product sees is unchanged.

use std::collections::VecDeque;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::containment::{self, FsResult};
use crate::ignore_rules::{self, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME};
use crate::mention_filter;

/// One classified directory entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
  pub name: String,
  /// Built from the *requested* directory, not the canonical one, so the host
  /// sees the same path it would have composed itself.
  pub path: String,
  pub is_directory: bool,
  pub is_symlink: bool,
}

impl Entry {
  pub fn kind(&self) -> &'static str {
    if self.is_directory {
      "directory"
    } else {
      "file"
    }
  }
}

/// One workspace index entry, already filtered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEntry {
  pub name: String,
  pub path: String,
  pub relative_path: String,
  pub is_directory: bool,
}

impl WorkspaceEntry {
  pub fn kind(&self) -> &'static str {
    if self.is_directory {
      "directory"
    } else {
      "file"
    }
  }
}

/// Reads one directory and classifies every entry. `include_hidden` is the
/// caller's `includeHidden`; dotfiles are filtered here rather than on the host
/// because the host sorts and packs anyway and this is the cheaper place.
pub fn read_dir(path: &Path, include_hidden: bool) -> FsResult<Vec<Entry>> {
  let iterator = std::fs::read_dir(path).map_err(|error| {
    containment::syscall_error(&error, "scandir", &path.to_string_lossy())
  })?;
  let mut entries = Vec::new();
  for item in iterator {
    let item = item.map_err(|error| {
      containment::syscall_error(&error, "scandir", &path.to_string_lossy())
    })?;
    let name = item.file_name().to_string_lossy().into_owned();
    if !include_hidden && name.starts_with('.') {
      continue;
    }
    let file_type = item.file_type().map_err(|error| {
      containment::syscall_error(&error, "scandir", &item.path().to_string_lossy())
    })?;
    let is_symlink = file_type.is_symlink();
    let is_directory = if is_symlink {
      // A symlink to a directory must read as a directory (the remote directory
      // selector depends on it); a dangling symlink reads as a file.
      std::fs::metadata(item.path())
        .map(|meta| meta.is_dir())
        .unwrap_or(false)
    } else {
      file_type.is_dir()
    };
    entries.push(Entry {
      name,
      path: join(&path.to_string_lossy(), &item.file_name().to_string_lossy()),
      is_directory,
      is_symlink,
    });
  }
  // readdir order is filesystem order; sorting the names makes the host's
  // stable sort produce the same list on every run.
  entries.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
  Ok(entries)
}

/// `path.join`: append with exactly one separator, so a root that already ends
/// in one does not produce a double separator.
fn join(base: &str, name: &str) -> String {
  if base.ends_with('/') || base.ends_with('\\') {
    format!("{base}{name}")
  } else {
    format!("{base}/{name}")
  }
}

/// Per-directory errors the predecessor swallowed so one unreadable subtree
/// cannot fail the whole scan (`fileService.ts:118-121`). Anything else
/// propagates: a silent partial index is worse than a visible failure.
fn is_skippable(error: &std::io::Error) -> bool {
  matches!(
    error.kind(),
    ErrorKind::PermissionDenied | ErrorKind::NotFound
  ) || error.raw_os_error() == Some(1)
}

/// The full workspace walk. `root` is already canonical and admitted; the rules
/// content is the loaded `.zcodeignore` (or whatever the fail-open chain chose).
pub fn walk_workspace(root: &Path, rules_content: &str) -> FsResult<Vec<WorkspaceEntry>> {
  let matcher = ignore_rules::compile(rules_content)?;
  let root_display = root.to_string_lossy().into_owned();
  let mut entries: Vec<WorkspaceEntry> = Vec::new();
  let mut pending: VecDeque<(PathBuf, String)> = VecDeque::new();
  pending.push_back((root.to_path_buf(), String::new()));

  while let Some((directory, relative_prefix)) = pending.pop_front() {
    let children = match std::fs::read_dir(&directory) {
      Ok(children) => children,
      Err(error) if is_skippable(&error) => continue,
      Err(error) => {
        return Err(containment::syscall_error(
          &error,
          "scandir",
          &directory.to_string_lossy(),
        ))
      }
    };
    let mut batch: Vec<WorkspaceEntry> = Vec::new();
    for item in children {
      let Ok(item) = item else { continue };
      let name = item.file_name().to_string_lossy().into_owned();
      let child_path = directory.join(&name);
      let relative_path = if relative_prefix.is_empty() {
        name.clone()
      } else {
        format!("{relative_prefix}/{name}")
      };
      // The rules file itself never appears in its own index.
      if relative_path == WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME {
        continue;
      }
      let file_type = match item.file_type() {
        Ok(file_type) => file_type,
        Err(error) if is_skippable(&error) => continue,
        Err(error) => {
          return Err(containment::syscall_error(
            &error,
            "scandir",
            &child_path.to_string_lossy(),
          ))
        }
      };
      let is_symlink = file_type.is_symlink();
      let is_directory = if is_symlink {
        std::fs::metadata(&child_path)
          .map(|meta| meta.is_dir())
          .unwrap_or(false)
      } else {
        file_type.is_dir()
      };
      if ignore_rules::is_ignored(&matcher, &relative_path, is_directory) {
        continue;
      }
      let decision = mention_filter::evaluate(
        &name,
        &relative_path,
        is_directory,
        /* ignore_rules_active */ true,
      );
      if decision.include {
        batch.push(WorkspaceEntry {
          name,
          path: join(&root_display, &relative_path),
          relative_path: relative_path.clone(),
          is_directory,
        });
      }
      // A symlinked directory is listed but never descended into, so the walk
      // cannot leave the root through a link or loop on a cycle.
      if is_directory && !is_symlink && decision.traverse {
        pending.push_back((child_path, relative_path));
      }
    }
    entries.append(&mut batch);
  }
  Ok(entries)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zcode-fs-walk-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch");
    dir
  }

  #[test]
  fn readdir_classifies_symlinked_directories_and_dangling_links() {
    let root = scratch("readdir-types");
    let real = root.join("real");
    fs::create_dir_all(&real).unwrap();
    fs::write(root.join("file.txt"), b"x").unwrap();
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(&real, root.join("link-dir")).unwrap();
      std::os::unix::fs::symlink(root.join("ghost"), root.join("link-dead")).unwrap();
    }
    let entries = read_dir(&root, true).unwrap();
    let by_name: std::collections::HashMap<_, _> =
      entries.iter().map(|entry| (entry.name.as_str(), entry)).collect();
    assert_eq!(by_name["real"].kind(), "directory");
    assert_eq!(by_name["file.txt"].kind(), "file");
    #[cfg(unix)]
    {
      assert_eq!(by_name["link-dir"].kind(), "directory");
      assert!(by_name["link-dir"].is_symlink);
      assert_eq!(by_name["link-dead"].kind(), "file", "dangling symlink");
      assert!(by_name["link-dead"].is_symlink);
    }
  }

  #[test]
  fn readdir_hides_dotfiles_unless_asked() {
    let root = scratch("readdir-hidden");
    fs::write(root.join(".env"), b"x").unwrap();
    fs::write(root.join("visible"), b"x").unwrap();
    assert_eq!(read_dir(&root, false).unwrap().len(), 1);
    assert_eq!(read_dir(&root, true).unwrap().len(), 2);
  }

  #[test]
  fn readdir_builds_entry_paths_from_the_requested_directory() {
    let root = scratch("readdir-paths");
    fs::create_dir_all(root.join("sub")).unwrap();
    let entries = read_dir(&root, true).unwrap();
    assert_eq!(entries[0].path, format!("{}/sub", root.to_string_lossy()));
  }

  #[test]
  fn walk_applies_the_ignore_matcher_and_the_mention_filter() {
    let root = scratch("walk-filter");
    fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
    fs::write(root.join("node_modules").join("pkg").join("index.js"), b"x").unwrap();
    fs::write(root.join("libthing.so"), b"x").unwrap();
    fs::write(root.join("keep.txt"), b"x").unwrap();
    let rules = ignore_rules::build_template(None);
    let found = walk_workspace(&root, &rules).unwrap();
    let relatives: Vec<&str> = found.iter().map(|e| e.relative_path.as_str()).collect();
    assert!(relatives.contains(&"keep.txt"));
    assert!(!relatives.iter().any(|r| r.contains("node_modules")));
    assert!(!relatives.contains(&"libthing.so"), "binary suffix is filtered");
  }

  #[test]
  fn walk_lists_hidden_directories_but_not_their_children_as_entries() {
    let root = scratch("walk-hidden");
    fs::create_dir_all(root.join(".github").join("workflows")).unwrap();
    fs::write(root.join(".github").join("workflows").join("ci.yml"), b"x").unwrap();
    let found = walk_workspace(&root, "").unwrap();
    let relatives: Vec<&str> = found.iter().map(|e| e.relative_path.as_str()).collect();
    assert!(
      !relatives.contains(&".github"),
      "a hidden directory is traversed but not listed"
    );
    assert!(!relatives.contains(&".github/workflows"), "nor are its children");
    assert!(
      relatives.contains(&".github/workflows/ci.yml"),
      "but still traversed so its files stay searchable"
    );
  }

  #[test]
  fn walk_never_lists_the_rules_file() {
    let root = scratch("walk-rules");
    fs::write(root.join(WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME), "keep.txt\n").unwrap();
    fs::write(root.join("keep.txt"), b"x").unwrap();
    // Rules that ignore something else, so the only thing that can remove
    // `.zcodeignore` from the index is the walk's own exclusion.
    let found = walk_workspace(&root, "build/\n").unwrap();
    let relatives: Vec<&str> = found.iter().map(|e| e.relative_path.as_str()).collect();
    assert_eq!(relatives, vec!["keep.txt"], ".zcodeignore is never indexed");
  }

  #[test]
  fn walk_does_not_descend_into_symlinked_directories() {
    let root = scratch("walk-symlink");
    let inside = root.join("real");
    fs::create_dir_all(&inside).unwrap();
    fs::write(inside.join("buried.txt"), b"x").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&inside, root.join("link")).unwrap();
    let found = walk_workspace(&root, "").unwrap();
    let relatives: Vec<&str> = found.iter().map(|e| e.relative_path.as_str()).collect();
    #[cfg(unix)]
    {
      assert!(relatives.contains(&"link"), "the link itself is listed");
      assert!(!relatives.contains(&"link/buried.txt"), "but not descended");
    }
    assert!(relatives.contains(&"real/buried.txt"));
  }

  #[test]
  fn walk_entry_paths_are_rooted_at_the_workspace() {
    let root = scratch("walk-paths");
    fs::create_dir_all(root.join("a").join("b")).unwrap();
    fs::write(root.join("a").join("b").join("c.txt"), b"x").unwrap();
    let found = walk_workspace(&root, "").unwrap();
    let deep = found.iter().find(|e| e.relative_path == "a/b/c.txt").unwrap();
    assert_eq!(deep.path, format!("{}/a/b/c.txt", root.to_string_lossy()));
    assert_eq!(deep.name, "c.txt");
    assert_eq!(deep.kind(), "file");
  }
}
