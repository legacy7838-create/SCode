//! The workspace file-mention filter — a direct port of
//! `packages/services/src/file/workspaceFileMentionFilter.ts:1-142`
//! (deleted by this port; the tables below are its only remaining copy).
//!
//! Two layers stack here, and which one applies depends on the caller:
//! - the **directory blacklist**, retired whenever `.zcodeignore` rules are
//!   active, because the rule file is then the single source of directory
//!   exclusions. It only survives as the fail-open fallback.
//! - the **file-level rules** (`.env*`, binary build artifacts) and the
//!   hidden-directory semantics, which always apply.
//!
//! Pure string logic, no I/O: this is the hot per-entry predicate of the
//! workspace walk and it moved to machine code unchanged.

const SKIPPED_DIRECTORY_NAMES: &[&str] = &[
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "__pycache__",
  "site-packages",
  "venv",
  "coverage",
  "htmlcov",
  "lcov-report",
  "cmakefiles",
  "pods",
  "deriveddata",
  "storybook-static",
  "playwright-report",
  "test-results",
  "allure-results",
  "allure-report",
  "cdk.out",
  "eggs",
  "pip-wheel-metadata",
  "wheels",
];
const SKIPPED_DIRECTORY_PREFIXES: &[&str] = &["cmake-build-", "bazel-"];
const SKIPPED_DIRECTORY_SUFFIXES: &[&str] = &[".egg-info", ".dist-info"];
const SKIPPED_FILE_NAMES: &[&str] = &["coverage.out", "lcov.info"];
const SKIPPED_FILE_EXTENSIONS: &[&str] = &[
  ".a", ".aar", ".beam", ".class", ".dll", ".dylib", ".ear", ".exe", ".gcda", ".gcno", ".gem",
  ".hi", ".idb", ".ilk", ".jar", ".lib", ".node", ".nupkg", ".o", ".obj", ".pdb", ".profdata",
  ".profraw", ".pyc", ".pyo", ".rlib", ".so", ".tsbuildinfo", ".war",
];

/// `path.extname` for a file name. The two rules that matter: a leading dot
/// makes it a dotfile, not an extension (`.env` → `""`), and a trailing dot is
/// not one either (`a.` → `""`).
pub fn extname(name: &str) -> &str {
  let base = name.rsplit('/').next().unwrap_or(name);
  match base.rfind('.') {
    None | Some(0) => "",
    Some(at) if at == base.len() - 1 => "",
    Some(at) => &base[at..],
  }
}

fn should_skip_directory(name: &str) -> bool {
  let normalized = name.to_lowercase();
  SKIPPED_DIRECTORY_NAMES.contains(&normalized.as_str())
    || SKIPPED_DIRECTORY_PREFIXES.iter().any(|p| normalized.starts_with(p))
    || SKIPPED_DIRECTORY_SUFFIXES.iter().any(|s| normalized.ends_with(s))
}

fn should_skip_file(name: &str) -> bool {
  let normalized = name.to_lowercase();
  normalized == ".env"
    || normalized.starts_with(".env.")
    || SKIPPED_FILE_NAMES.contains(&normalized.as_str())
    || SKIPPED_FILE_EXTENSIONS.contains(&extname(&normalized))
}

fn is_inside_hidden_directory(relative_path: &str) -> bool {
  match relative_path.rfind('/') {
    // Everything before the last separator: a path with no separator is itself
    // the name, so it has no parent to be hidden inside.
    None => false,
    Some(at) => relative_path[..at].split('/').any(|s| s.starts_with('.')),
  }
}

/// The decision for one workspace entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
  pub include: bool,
  pub traverse: bool,
}

/// `WorkspaceFileSearchFilter.evaluate` from
/// `workspaceFileMentionFilter.ts:126-142`, with the default filter's two
/// branches. `ignore_rules_active` is the caller's `context.ignoreRulesActive`.
pub fn evaluate(
  name: &str,
  relative_path: &str,
  is_directory: bool,
  ignore_rules_active: bool,
) -> Decision {
  if is_directory {
    if !ignore_rules_active && should_skip_directory(name) {
      return Decision {
        include: false,
        traverse: false,
      };
    }
    // A hidden directory is pruned from the candidate list but still traversed,
    // so ordinary files inside `.github` remain searchable by name.
    let hidden = name.starts_with('.') || is_inside_hidden_directory(relative_path);
    return Decision {
      include: !hidden,
      traverse: true,
    };
  }
  Decision {
    include: !should_skip_file(name),
    traverse: false,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const ACTIVE: bool = true;

  #[test]
  fn extname_matches_node_semantics() {
    assert_eq!(extname("a.txt"), ".txt");
    assert_eq!(extname(".env"), "");
    assert_eq!(extname(".env.local"), ".local");
    assert_eq!(extname("a."), "");
    assert_eq!(extname("a..b"), ".b");
    assert_eq!(extname("noext"), "");
    assert_eq!(extname("archive.war"), ".war");
    assert_eq!(extname(".."), "");
  }

  #[test]
  fn binary_build_artifacts_are_excluded() {
    for name in [
      "libthing.so",
      "app.tsbuildinfo",
      "archive.war",
      "x.class",
      "y.dll",
      "z.node",
      "out.o",
      "out.obj",
      "prof.pdb",
      "x.pyo",
    ] {
      assert!(!evaluate(name, name, false, ACTIVE).include, "{name}");
    }
    assert!(evaluate("keep.txt", "keep.txt", false, ACTIVE).include);
    // `.bin` is deliberately *not* on the list: the blocklist is a fixed table,
    // not a suffix heuristic.
    assert!(evaluate("gc.gcov.bin", "gc.gcov.bin", false, ACTIVE).include);
  }

  #[test]
  fn env_files_are_excluded() {
    assert!(!evaluate(".env", ".env", false, ACTIVE).include);
    assert!(!evaluate(".env.local", ".env.local", false, ACTIVE).include);
    assert!(evaluate("environment.ts", "environment.ts", false, ACTIVE).include);
  }

  #[test]
  fn named_coverage_artifacts_are_excluded() {
    assert!(!evaluate("coverage.out", "coverage.out", false, ACTIVE).include);
    assert!(!evaluate("lcov.info", "lcov.info", false, ACTIVE).include);
  }

  #[test]
  fn directory_blacklist_only_applies_when_rules_are_inactive() {
    assert!(!evaluate("node_modules", "node_modules", true, false).include);
    assert!(!evaluate("node_modules", "node_modules", true, false).traverse);
    // With .zcodeignore active the rule file is the only source of directory
    // exclusions, so the retired blacklist must not prune anything.
    let active = evaluate("node_modules", "node_modules", true, ACTIVE);
    assert!(active.include);
    assert!(active.traverse);
  }

  #[test]
  fn directory_prefix_and_suffix_rules() {
    assert!(!evaluate("cmake-build-release", "cmake-build-release", true, false).include);
    assert!(!evaluate("bazel-out", "bazel-out", true, false).include);
    assert!(!evaluate("thing.egg-info", "thing.egg-info", true, false).include);
    assert!(!evaluate("thing.dist-info", "thing.dist-info", true, false).include);
    assert!(!evaluate("PODS", "PODS", true, false).include, "lowercased match");
  }

  #[test]
  fn hidden_directories_are_pruned_but_still_traversed() {
    let dot = evaluate(".git", ".git", true, ACTIVE);
    assert!(!dot.include);
    assert!(dot.traverse, "must stay traversable");
    let nested = evaluate("workflows", ".github/workflows", true, ACTIVE);
    assert!(!nested.include, "inside a hidden directory");
    assert!(nested.traverse);
    let inside = evaluate("ci.yml", ".github/workflows/ci.yml", false, ACTIVE);
    assert!(inside.include, "files under a hidden directory stay searchable");
  }

  #[test]
  fn files_are_never_traversed() {
    assert!(!evaluate("a.txt", "a.txt", false, ACTIVE).traverse);
  }
}
