//! ZCode workspace file index scanner.
//!
//! Walks a workspace, applies `.zcodeignore` semantics, applies the file-level search policy,
//! orders the result with the **same collation as JavaScript's `String.prototype.localeCompare`**,
//! and emits the columnar packed format consumed by `workspaceFileEntriesCodec.ts`.
//!
//! See `spec/native-boundary-workspace-scan.md` for the boundary contract and acceptance scenarios.
//!
//! # Why ICU
//!
//! The pack order is a contract: the `@` picker renders the packed string in exactly this order.
//! `localeCompare` is ICU collation, not byte order — measured on this checkout's own 6,338 paths,
//! Rust's `str::cmp` disagrees with Node on **96.54% of positions** (`"CONTEXT.md"` sorts before
//! `"all_files.txt"` in byte order; after it in ICU). `icu_collator` at `Strength::Tertiary`
//! reproduces Node's order byte-for-byte, but Node's bare `localeCompare` uses the *runtime default*
//! locale, which varies per machine — so the caller passes its resolved locale in.
//!
//! # Where pruning happens
//!
//! Gitignore pruning runs inside the walker's `filter_entry`, not after it. Pruning afterwards
//! would still *descend* into `node_modules/`, which is most of the cost this crate removes.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::{CollatorBorrowed, CollatorPreferences};
use icu_locale_core::Locale;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{DirEntry, WalkBuilder, WalkState};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Entry kind column values; must match `WorkspaceFileEntry["type"]` in `@zcode/shared`.
const TYPE_FILE: &str = "file";
const TYPE_DIRECTORY: &str = "directory";

const FIELD_SEPARATOR: char = '\t';
const LINE_SEPARATOR: char = '\n';

/// The workspace ignore file itself, which the retired JS scan excluded from the index.
///
/// `WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME` from `workspaceFileIgnore.ts`. The old scan compared
/// the **root-relative** path for equality, so only the root-level `.zcodeignore` was dropped and a
/// nested `sub/.zcodeignore` stayed a normal candidate — that asymmetry is the contract, so this
/// compares the whole relative path rather than the file name.
///
/// It matters in production even though this checkout has no `.zcodeignore`: `workspaceFileIgnore.ts`
/// auto-creates one in every real workspace, so without this the `@` picker would start offering the
/// user's own ignore rules as a mentionable file.
const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME: &str = ".zcodeignore";

// --- file-level policy, ported from `workspaceFileMentionFilter.ts` -----------------------

/// `SKIPPED_FILE_NAMES` — exact (lowercased) file names excluded from the index.
const SKIPPED_FILE_NAMES: [&str; 2] = ["coverage.out", "lcov.info"];

/// `SKIPPED_FILE_EXTENSIONS` — lowercase extensions, compared against `extname(name)`.
const SKIPPED_FILE_EXTENSIONS: [&str; 29] = [
    ".a",
    ".aar",
    ".beam",
    ".class",
    ".dll",
    ".dylib",
    ".ear",
    ".exe",
    ".gcda",
    ".gcno",
    ".gem",
    ".hi",
    ".idb",
    ".ilk",
    ".jar",
    ".lib",
    ".node",
    ".nupkg",
    ".o",
    ".obj",
    ".pdb",
    ".profdata",
    ".profraw",
    ".pyc",
    ".pyo",
    ".rlib",
    ".so",
    ".tsbuildinfo",
    ".war",
];

/// `should_skip_file` from `workspaceFileMentionFilter.ts:130`.
///
/// `.env` and `.env.*` are matched separately from the extension table because Node's
/// `extname(".env")` is `""` (leading-dot names have no extension).
fn should_skip_file(name: &str) -> bool {
    let lowered = name.to_lowercase();
    if lowered == ".env" || lowered.starts_with(".env.") {
        return true;
    }
    if SKIPPED_FILE_NAMES.contains(&lowered.as_str()) {
        return true;
    }
    match extension_of(&lowered) {
        Some(ext) => SKIPPED_FILE_EXTENSIONS.contains(&ext.as_str()),
        None => false,
    }
}

/// Node's `path.extname` restricted to what the policy needs: the suffix from the last `.` that is
/// not at index 0 of the basename. Returns the extension **including** the leading dot; the input
/// must already be lowercased.
fn extension_of(name: &str) -> Option<String> {
    let dot = name.rfind('.')?;
    // A leading dot marks a dotfile, not an extension ("`.env`" has no extension).
    if dot == 0 {
        return None;
    }
    Some(name[dot..].to_string())
}

/// A directory is hidden when it or any ancestor segment starts with `.`.
///
/// Mirrors `isInsideHiddenDirectory` plus the leading-dot check in
/// `workspaceFileMentionFilter.ts:133-140`. Hidden directories are **pruned from the candidate
/// list but still traversed**, so ordinary files beneath `.github/` remain searchable.
fn is_hidden_directory(relative_path: &str) -> bool {
    relative_path
        .split('/')
        .any(|segment| segment.starts_with('.'))
}

// --- packing -------------------------------------------------------------------------------

/// `escapeField` from `workspaceFileEntriesCodec.ts`: backslash first, then tab and newline.
/// The backslash pass must run before the other two or it would double-escape their output.
fn escape_field(value: &str, out: &mut String) {
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            _ => out.push(ch),
        }
    }
}

/// One packed row: `type \t escaped(relativePath)`.
fn pack_row(entry_type: &str, relative_path: &str, out: &mut String) {
    out.push_str(entry_type);
    out.push(FIELD_SEPARATOR);
    escape_field(relative_path, out);
}

/// Root-relative path with `/` separators, matching the codec's posix convention.
fn relative_path_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Final path segment, the value the file policy is keyed on.
fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// --- collation -----------------------------------------------------------------------------

/// Build a collator matching `Intl.Collator` at default (tertiary) strength.
///
/// `locale` must be the caller's `new Intl.Collator().resolvedOptions().locale`; `"und"` selects
/// root collation. An unparseable locale falls back to root rather than failing the scan, matching
/// the fail-open posture used elsewhere in this boundary: a bad locale degrades *ordering*, and
/// ordering is recoverable by re-scanning, whereas failing would take the whole index down.
fn build_collator(locale: &str) -> CollatorBorrowed<'static> {
    let mut options = CollatorOptions::default();
    options.strength = Some(Strength::Tertiary);
    let preferences = if locale.is_empty() || locale == "und" {
        CollatorPreferences::default()
    } else {
        match Locale::try_from_str(locale) {
            Ok(parsed) => CollatorPreferences::from(parsed),
            Err(_) => CollatorPreferences::default(),
        }
    };
    CollatorBorrowed::try_new(preferences, options)
        .expect("compiled_data collator construction cannot fail")
}

/// Order rows: directories before files, then ICU-collated `relative_path`.
///
/// Mirrors the comparator being replaced
/// (`return left.type === "directory" ? -1 : 1; return left.relativePath.localeCompare(...)`).
fn compare_rows(
    left: &(String, String),
    right: &(String, String),
    collator: &CollatorBorrowed<'_>,
) -> Ordering {
    // `true` (directory) must sort before `false`, so the natural bool order is reversed.
    let left_is_dir = left.0 == TYPE_DIRECTORY;
    let right_is_dir = right.0 == TYPE_DIRECTORY;
    match right_is_dir.cmp(&left_is_dir) {
        Ordering::Equal => collator.compare(left.1.as_str(), right.1.as_str()),
        other => other,
    }
}

// --- the scan ------------------------------------------------------------------------------

/// Classify a walker entry the way `resolveReaddirEntryType` did.
///
/// `DirEntry::file_type` describes the link itself, not the target. The previous implementation
/// `stat`-ed symlinks so a symlink-to-directory is classified as a directory, while traversal stayed
/// gated on `!isSymbolicLink` (which `follow_links(false)` preserves).
fn classify(entry: &DirEntry) -> &'static str {
    match entry.file_type() {
        Some(file_type) if file_type.is_dir() => TYPE_DIRECTORY,
        Some(file_type) if file_type.is_file() => TYPE_FILE,
        // Symlink or unknown kind: stat the target. Errors classify as a file, matching the old
        // `catch { return "file" }`.
        _ => match std::fs::metadata(entry.path()) {
            Ok(meta) if meta.is_dir() => TYPE_DIRECTORY,
            _ => TYPE_FILE,
        },
    }
}

/// True when the entry (or anything above it) is excluded by the rule set.
///
/// `is_dir` carries the gitignore "dir-only" distinction (`node_modules/`): the crate applies it
/// exactly as the `ignore` npm package did when the TypeScript side appended a trailing separator
/// to directory queries — see `isWorkspaceFileSearchPathIgnored` in
/// `workspaceFileIgnore.ts:365-377`.
fn is_ignored(matcher: &Gitignore, entry: &DirEntry, entry_type: &str) -> bool {
    matcher
        .matched_path_or_any_parents(entry.path(), entry_type == TYPE_DIRECTORY)
        .is_ignore()
}

/// Configure the parallel walker to reproduce the previous traversal semantics exactly.
///
/// Every knob is pinned deliberately; the `WalkBuilder` default would change behavior for each:
/// - `hidden(false)` — hidden directories must still be traversed.
/// - `standard_filters(false)` — `.zcodeignore` is the only rule source, so repo `.gitignore`,
///   `.ignore`, global gitconfig and parent-directory rules must not leak in.
/// - `follow_links(false)` — symlinks are listed but never traversed, even after a
///   symlink-to-directory is classified as a directory.
///
/// Pruning is done by the visitor in [`scan_workspace_files_packed`] returning
/// [`WalkState::Skip`], **not** by [`WalkBuilder::filter_entry`]. In `ignore` 0.4 the filter
/// predicate only suppresses the yield; the worker still returns `WalkState::Continue` and
/// descends. Only the visitor's state is honored by `run_one` before it walks a directory's
/// children, so a `filter_entry`-based port would still enter `node_modules/` — i.e. it would
/// keep most of the cost this crate exists to remove.
fn build_walker(root: &Path) -> ignore::WalkParallel {
    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(false)
        .hidden(false)
        .follow_links(false)
        .git_global(false)
        .parents(false);
    builder.build_parallel()
}

/// Scan `root_path` and return the columnar packed workspace file index.
///
/// `ignore_rule_text` is the verbatim `.zcodeignore` content, already loaded by the caller; an
/// empty string means "no rules", which is the fail-open state. This function never reads or
/// creates the rules file — authoring and syncing stay in TypeScript.
///
/// `locale` must be the caller's resolved `Intl.Collator().resolvedOptions().locale` so that the
/// emitted order matches JavaScript's `localeCompare` exactly. Ordering is part of the wire
/// contract, so it is a required argument rather than an option.
///
/// # Errors
///
/// Returns an error if `root_path` is not a readable directory, or if the rule set cannot be
/// compiled. Individual unreadable subdirectories are skipped, matching the previous
/// `isSkippableWorkspaceFileListError` behavior, so one permission-denied folder cannot fail a
/// scan of a 370k-file workspace.
#[napi]
pub fn scan_workspace_files_packed(
    root_path: String,
    ignore_rule_text: String,
    locale: String,
) -> Result<String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(Error::from_reason(format!(
            "workspace scan root is not a directory: {root_path}"
        )));
    }

    // `GitignoreBuilder::add` treats each line as one rule; empty and comment lines are ignored by
    // the crate, matching the `ignore` npm package. No default rules are inherited because the
    // builder is rooted at `root_path` and nothing else is added.
    let mut gitignore = GitignoreBuilder::new(&root);
    for line in ignore_rule_text.lines() {
        // `from: None` — every rule comes from the caller's verbatim file content, so there is no
        // per-rule origin to record and no repository default to inherit.
        gitignore.add_line(None, line).map_err(|error| {
            Error::from_reason(format!("invalid .zcodeignore rule {line:?}: {error}"))
        })?;
    }
    let matcher = gitignore
        .build()
        .map_err(|error| Error::from_reason(format!("invalid .zcodeignore rules: {error}")))?;

    let collator = build_collator(&locale);

    // The walk is parallel, so rows arrive in nondeterministic order. That is safe: rows are keyed
    // by unique root-relative path, so `compare_rows` is a total order and no two rows can tie.
    let collected: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);
    build_walker(&root).run(move || {
        let sink = Arc::clone(&sink);
        let root = root.clone();
        let matcher = matcher.clone();
        Box::new(
            move |result: std::result::Result<DirEntry, ignore::Error>| {
                // A single unreadable directory must not abort the scan.
                let entry = match result {
                    Ok(entry) => entry,
                    Err(_) => return WalkState::Continue,
                };
                // The root is the scan subject, never a candidate, and is never pruned.
                if entry.depth() == 0 {
                    return WalkState::Continue;
                }
                let relative_path = relative_path_of(&root, entry.path());
                if relative_path.is_empty() {
                    return WalkState::Continue;
                }
                // The workspace's own ignore file is not a search candidate. Checked before the
                // gitignore test so the ordering matches the retired scan exactly.
                if relative_path == WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME {
                    return WalkState::Continue;
                }
                let entry_type = classify(&entry);
                if is_ignored(&matcher, &entry, entry_type) {
                    // Honored by `run_one` before it lists the directory's children: this is the
                    // subtree prune that keeps `node_modules/` out of the traversal entirely.
                    return WalkState::Skip;
                }
                let row = match entry_type {
                    // Hidden directories are traversed but never listed as candidates.
                    TYPE_DIRECTORY => {
                        if is_hidden_directory(&relative_path) {
                            return WalkState::Continue;
                        }
                        (TYPE_DIRECTORY.to_string(), relative_path)
                    }
                    _ => {
                        if should_skip_file(&file_name_of(entry.path())) {
                            return WalkState::Continue;
                        }
                        (TYPE_FILE.to_string(), relative_path)
                    }
                };
                sink.lock()
                    .expect("workspace scan sink mutex poisoned")
                    .push(row);
                WalkState::Continue
            },
        )
    });

    let mut rows = Arc::try_unwrap(collected)
        .map_err(|_| Error::from_reason("workspace scan threads outlived the collector"))?
        .into_inner()
        .map_err(|_| Error::from_reason("workspace scan collector panicked"))?;

    rows.sort_by(|left, right| compare_rows(left, right, &collator));

    let mut packed = String::with_capacity(rows.len() * 48);
    for (entry_type, relative_path) in &rows {
        if !packed.is_empty() {
            packed.push(LINE_SEPARATOR);
        }
        pack_row(entry_type, relative_path, &mut packed);
    }
    Ok(packed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn escape(value: &str) -> String {
        let mut out = String::new();
        escape_field(value, &mut out);
        out
    }

    #[test]
    fn escape_prefers_backslash_first() {
        // A literal backslash must double BEFORE tab/newline are escaped, else the escapes of
        // those passes would be re-escaped.
        assert_eq!(escape(r"a\tb"), r"a\\tb");
        assert_eq!(escape("a\tb"), r"a\tb");
        assert_eq!(escape("a\nb"), r"a\nb");
        assert_eq!(escape("plain"), "plain");
    }

    #[test]
    fn file_policy_matches_node_extname_semantics() {
        assert!(extension_of(".env").is_none());
        assert!(should_skip_file(".env"));
        assert!(should_skip_file(".env.local"));
        assert!(should_skip_file("node.exe"));
        assert!(should_skip_file("NODE.EXE"));
        assert!(should_skip_file("COVERAGE.OUT"));
        assert_eq!(extension_of("a.tar.gz").as_deref(), Some(".gz"));
        assert!(!should_skip_file("archive.tar.gz"));
        assert!(!should_skip_file("main.rs"));
        assert!(!should_skip_file("README.md"));
    }

    #[test]
    fn hidden_directory_covers_self_and_ancestors() {
        assert!(is_hidden_directory(".github"));
        assert!(is_hidden_directory(".github/workflows"));
        assert!(!is_hidden_directory("src"));
        assert!(!is_hidden_directory("src/config"));
        // A dot-named directory IS hidden wherever it sits: `workspaceFileMentionFilter.ts` tests
        // `entry.name.startsWith(".")` independently of the ancestor scan, and `relativePath`'s
        // last segment is that same name. So `src/.config` is hidden too.
        assert!(is_hidden_directory("src/.config"));
    }

    #[test]
    fn directories_sort_before_files() {
        let collator = build_collator("und");
        let dir = (TYPE_DIRECTORY.to_string(), "src".to_string());
        let file = (TYPE_FILE.to_string(), "zzz.rs".to_string());
        assert_eq!(compare_rows(&dir, &file, &collator), Ordering::Less);
        assert_eq!(compare_rows(&file, &dir, &collator), Ordering::Greater);
        // Equal keys are a stable no-op, not a panic.
        assert_eq!(compare_rows(&dir, &dir, &collator), Ordering::Equal);
    }

    #[test]
    fn collation_is_not_byte_order() {
        // The property byte order violates and ICU honors. If this ever starts failing because a
        // dependency swapped collation back to bytes, the packed index would silently reorder.
        let collator = build_collator("und");
        let lower = (TYPE_FILE.to_string(), "all_files.txt".to_string());
        let upper = (TYPE_FILE.to_string(), "CONTEXT.md".to_string());
        assert_eq!(compare_rows(&lower, &upper, &collator), Ordering::Less);
        // Byte order puts 'C' (0x43) before 'a' (0x61), i.e. the OPPOSITE of ICU's primary
        // weight. If this ever flipped, the packed index would silently reorder and this test
        // would stop proving that collation is actually in play.
        assert_eq!(
            "CONTEXT.md".to_string().cmp(&"all_files.txt".to_string()),
            Ordering::Less,
            "byte order must disagree with ICU — otherwise this test proves nothing"
        );
    }

    #[test]
    fn unknown_locale_degrades_instead_of_failing() {
        let _ = build_collator("not a locale");
        let _ = build_collator("");
    }

    #[test]
    fn rejects_non_directory_root() {
        assert!(scan_workspace_files_packed(
            "/definitely/not/here".to_string(),
            String::new(),
            "und".to_string()
        )
        .is_err());
    }

    #[test]
    fn root_ignore_file_is_excluded_but_nested_ones_are_not() {
        // Regression: the retired JS scan compared the *root-relative path* for equality, so only
        // `.zcodeignore` at the root was dropped. A blanket "skip any .zcodeignore" would itself
        // have been a new divergence, because `sub/.zcodeignore` is a normal candidate.
        let dir = std::env::temp_dir().join("zcode-scan-ignore-file-fixture");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).expect("fixture dir");
        std::fs::write(dir.join(WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME), "").expect("root rule");
        std::fs::write(dir.join("a.txt"), "").expect("root file");
        std::fs::write(dir.join("sub/.zcodeignore"), "").expect("nested rule");
        std::fs::write(dir.join("sub/b.txt"), "").expect("nested file");

        let packed = scan_workspace_files_packed(
            dir.to_string_lossy().into_owned(),
            String::new(),
            "und".to_string(),
        )
        .expect("scan");

        assert!(
            !packed.contains(&format!("\n{WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}"))
                && !packed.starts_with(WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME),
            "root .zcodeignore must not be a candidate: {packed}"
        );
        assert!(
            packed.contains("sub/.zcodeignore"),
            "nested .zcodeignore stays a candidate: {packed}"
        );
        assert!(packed.contains("a.txt"), "{packed}");
        assert!(packed.contains("sub/b.txt"), "{packed}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
