//! Crate discovery and the live-set derivation (spec §4.2, P5).
//!
//! The live set is *computed*, never declared: a crate ships only when at least one
//! file in the workspace imports the `@zcode/rust/<subpath>` that wraps it. That is
//! what keeps the ten zero-consumer v4-wire crates out of every installer instead of
//! letting them ride along because someone globbed `crates/*`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// A crate as declared by the workspace.
#[derive(Debug, Clone)]
pub struct CrateInfo {
    /// Cargo package name, e.g. `zcode-git`.
    pub name: String,
    /// Path to its `Cargo.toml`, relative to the workspace root.
    pub manifest: String,
    /// `true` when the manifest declares a `cdylib` lib target.
    pub is_cdylib: bool,
}

/// One `@zcode/rust/*` subpath export and the crate it loads.
#[derive(Debug, Clone)]
pub struct SubpathExport {
    /// The subpath key without the leading dot, e.g. `events`.
    pub subpath: String,
    /// The wrapper module path relative to the workspace root.
    pub wrapper: String,
    /// The binary name passed to `loadNative<…>()`, parsed out of the wrapper.
    pub binary_name: String,
}

/// Directory names never scanned for importers.
///
/// `docs` is excluded because the specs quote these paths while describing them as
/// *not* wired. `packages/rust` is excluded by path in `collect_source_files` rather
/// than by name, because each wrapper mentions its own binary via `loadNative()` and
/// would otherwise mark every crate live.
const SCAN_EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "target",
    ".git",
    "docs",
    "out",
    "coverage",
    "bundled-agents",
];

/// Path fragments that mark a file as belonging to the rust package itself.
const SCAN_EXCLUDED_PATH_FRAGMENTS: &[&str] = &["/packages/rust/"];

/// Source extensions worth scanning for an import.
const SCAN_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
];

#[derive(Debug)]
pub enum InventoryError {
    Io { path: PathBuf, source: std::io::Error },
    Json { path: PathBuf, source: serde_json::Error },
    NoPackageJson(PathBuf),
    SubpathWithoutWrapper { subpath: String, target: String },
    WrapperWithoutLoadNative { wrapper: PathBuf },
}

impl std::fmt::Display for InventoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InventoryError::Io { path, source } => {
                write!(f, "cannot read {}: {source}", path.display())
            }
            InventoryError::Json { path, source } => {
                write!(f, "cannot parse {}: {source}", path.display())
            }
            InventoryError::NoPackageJson(root) => write!(
                f,
                "no packages/rust/package.json under {}; run from the repository root",
                root.display()
            ),
            InventoryError::SubpathWithoutWrapper { subpath, target } => write!(
                f,
                "subpath {subpath:?} resolves to {target:?}, which is not a file under packages/rust/src"
            ),
            InventoryError::WrapperWithoutLoadNative { wrapper } => write!(
                f,
                "{} declares a @zcode/rust subpath but contains no loadNative(\"...\") call; \
                 the live-set derivation cannot classify it",
                wrapper.display()
            ),
        }
    }
}

impl std::error::Error for InventoryError {}

fn read_json(path: &Path) -> Result<serde_json::Value, InventoryError> {
    let text = fs::read_to_string(path).map_err(|source| InventoryError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_str(&text).map_err(|source| InventoryError::Json {
        path: path.to_path_buf(),
        source,
    })
}

/// Locates `packages/rust` by walking up from `start`.
pub fn find_rust_root(start: &Path) -> Result<PathBuf, InventoryError> {
    let mut dir = start;
    loop {
        let candidate = dir.join("packages/rust");
        if candidate.join("package.json").is_file() {
            return Ok(candidate);
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => return Err(InventoryError::NoPackageJson(start.to_path_buf())),
        }
    }
}

/// Reads every `crates/*/Cargo.toml` and classifies cdylib vs rlib.
pub fn read_crates(rust_root: &Path) -> Result<Vec<CrateInfo>, InventoryError> {
    let crates_dir = rust_root.join("crates");
    let mut out = Vec::new();
    let entries = fs::read_dir(&crates_dir).map_err(|source| InventoryError::Io {
        path: crates_dir.clone(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| InventoryError::Io {
            path: crates_dir.clone(),
            source,
        })?;
        if !entry.path().is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("Cargo.toml");
        if !manifest_path.is_file() {
            continue;
        }
        let manifest = fs::read_to_string(&manifest_path).map_err(|source| InventoryError::Io {
            path: manifest_path.clone(),
            source,
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        // `build-native.sh:30` used `grep -qE 'crate-type[[:space:]]*=[[:space:]]*\[[^]]*"cdylib"'`.
        // Cargo metadata is the same information without the regex, and it keeps working
        // when the manifest is reformatted.
        let is_cdylib = manifest_has_cdylib(&manifest);
        out.push(CrateInfo {
            name,
            manifest: format!(
                "packages/rust/crates/{}/Cargo.toml",
                entry.file_name().to_string_lossy()
            ),
            is_cdylib,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// True when any `[lib]` section (or a bare `crate-type`) declares `cdylib`.
///
/// Deliberately conservative: a crate we cannot classify is treated as *not* a cdylib
/// so it is never staged, and `inventory` reports it for review. Shipping an unknown
/// artifact is the failure P2 exists to prevent.
fn manifest_has_cdylib(manifest: &str) -> bool {
    let mut in_lib_section = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_lib_section = line == "[lib]";
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if in_lib_section && key == "crate-type" {
            return value.contains("cdylib");
        }
        // A top-level `crate-type` outside `[lib]` is not valid Cargo, so ignore it.
    }
    // Fall back to a whole-file check for manifests that put crate-type in [lib] with
    // the key on a continuation line, which the loop above handles, or omit [lib] and
    // rely on Cargo's default (rlib) — in which case there is nothing to stage.
    false
}

/// Reads the `exports` map of `packages/rust/package.json` and pairs each subpath with
/// the binary name its wrapper loads.
///
/// `package_root` is `packages/rust` (not the repository root): the `exports` values
/// are relative to the package's own directory, so `./src/image.ts` resolves to
/// `packages/rust/src/image.ts`.
pub fn read_subpath_exports(
    package_root: &Path,
    repo_root: &Path,
) -> Result<Vec<SubpathExport>, InventoryError> {
    let package_json = package_root.join("package.json");
    let value = read_json(&package_json)?;
    let exports = value
        .get("exports")
        .and_then(|e| e.as_object())
        .ok_or_else(|| InventoryError::NoPackageJson(package_root.to_path_buf()))?;

    let mut out = Vec::new();
    for (key, target) in exports {
        // Skip the bare "." entry and the "./package.json" escape hatch.
        if key == "." || key == "./package.json" {
            continue;
        }
        let Some(subpath) = key.strip_prefix("./") else {
            continue;
        };
        let Some(target) = target.as_str() else {
            continue;
        };
        // `exports` values are package-relative, so `./src/image.ts` is
        // `packages/rust/src/image.ts`.
        let wrapper = package_root.join(target);
        if !wrapper.is_file() {
            return Err(InventoryError::SubpathWithoutWrapper {
                subpath: subpath.to_string(),
                target: target.to_string(),
            });
        }
        let source = fs::read_to_string(&wrapper).map_err(|source| InventoryError::Io {
            path: wrapper.clone(),
            source,
        })?;
        let binary_name = find_load_native_call(&source)
            .or_else(|| find_delegated_load_native(&wrapper, 4))
            .ok_or_else(|| InventoryError::WrapperWithoutLoadNative {
                wrapper: wrapper.clone(),
            })?;
        // Store the repo-relative form so plans and errors name a path a reader can open.
        let wrapper_display = wrapper
            .strip_prefix(repo_root)
            .unwrap_or(&wrapper)
            .to_string_lossy()
            .replace('\\', "/");
        out.push(SubpathExport {
            subpath: subpath.to_string(),
            wrapper: wrapper_display,
            binary_name,
        });
    }
    out.sort_by(|a, b| a.subpath.cmp(&b.subpath));
    Ok(out)
}

/// Follows a companion wrapper's relative imports to the module that owns the `loadNative`
/// call.
///
/// `offPeakRepository.ts`, `taskReadRepository.ts`, `taskWriteRepository.ts` and
/// `taskGroupRepository.ts` do not call `loadNative` themselves: they share the one native
/// object `taskIndex.ts` opens, through the `NATIVE_STORE` symbol. That is the single
/// connection / one migration ledger arrangement spec §4.4 chose, so those subpaths still
/// belong to the `zcode-task-index` crate — and the inventory has to say so rather than
/// failing the build.
fn find_delegated_load_native(wrapper: &Path, depth: usize) -> Option<String> {
    if depth == 0 {
        return None;
    }
    let source = fs::read_to_string(wrapper).ok()?;
    if let Some(binary) = find_load_native_call(&source) {
        return Some(binary);
    }
    let directory = wrapper.parent()?;
    for import in relative_imports(&source) {
        // Source imports are written with the emitted `.js` extension; the file on disk is
        // `.ts`. Try the literal target first, then the source forms.
        let base = directory.join(&import);
        let mut candidates = vec![base.clone()];
        if base.extension().and_then(|ext| ext.to_str()) == Some("js") {
            if let Some(stem) = base.file_stem().and_then(|stem| stem.to_str()) {
                candidates.push(directory.join(format!("{stem}.ts")));
                candidates.push(directory.join(format!("{stem}.tsx")));
            }
        }
        for candidate in candidates {
            if candidate.is_file() {
                if let Some(binary) = find_delegated_load_native(&candidate, depth - 1) {
                    return Some(binary);
                }
            }
        }
    }
    None
}

/// The `./x.js`-style module specifiers a TypeScript file imports.
fn relative_imports(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (index, _) in source.match_indices("from \"") {
        let rest = &source[index + "from \"".len()..];
        if let Some(end) = rest.find('"') {
            let specifier = &rest[..end];
            if specifier.starts_with("./") || specifier.starts_with("../") {
                out.push(specifier.to_string());
            }
        }
    }
    out
}

/// Extracts the first `loadNative<…>("name")` / `loadNative("name")` literal.
fn find_load_native_call(source: &str) -> Option<String> {
    let needle = "loadNative";
    let mut search = 0usize;
    while let Some(offset) = source[search..].find(needle) {
        let start = search + offset;
        let rest = &source[start + needle.len()..];
        // Skip the generic parameter list, then the call's argument list.
        let mut cursor = 0usize;
        let bytes = rest.as_bytes();
        let mut angle_depth = 0i32;
        while cursor < bytes.len() {
            match bytes[cursor] {
                b'<' => angle_depth += 1,
                b'>' => angle_depth -= 1,
                b'(' if angle_depth <= 0 => break,
                _ => {}
            }
            cursor += 1;
        }
        if cursor >= bytes.len() {
            return None;
        }
        let args = &rest[cursor + 1..];
        if let Some(open) = args.find('"') {
            if let Some(close) = args[open + 1..].find('"') {
                let name = &args[open + 1..open + 1 + close];
                if name.starts_with("zcode-") {
                    return Some(name.to_string());
                }
            }
        }
        search = start + needle.len();
    }
    None
}

/// Recursively collects scannable source files under `dir`.
fn collect_source_files(dir: &Path, repo_root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if SCAN_EXCLUDED_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            collect_source_files(&path, repo_root, out);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if !SCAN_EXTENSIONS.contains(&ext) {
                continue;
            }
            let relative = path
                .strip_prefix(repo_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if SCAN_EXCLUDED_PATH_FRAGMENTS
                .iter()
                .any(|fragment| relative.contains(fragment))
            {
                continue;
            }
            out.push(path);
        }
    }
}

/// The set of `@zcode/rust/<subpath>` specifiers imported anywhere in the workspace,
/// with the files that import them.
pub fn find_subpath_importers(repo_root: &Path) -> BTreeMap<String, BTreeSet<String>> {
    let mut files = Vec::new();
    collect_source_files(repo_root, repo_root, &mut files);
    files.sort();

    let mut hits: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for file in files {
        let Ok(source) = fs::read_to_string(&file) else {
            continue;
        };
        let Ok(relative) = file.strip_prefix(repo_root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        for subpath in subpaths_referenced_in(&source) {
            hits.entry(subpath).or_default().insert(relative.clone());
        }
    }
    hits
}

/// Every `@zcode/rust/<subpath>` **module specifier** appearing in `source`.
///
/// Matching a bare mention is not enough. `packages/desktop/tsup.config.ts` names
/// `"@zcode/rust"` in a bundler externals array and in a `//` comment, and neither is
/// a consumer; counting them shipped ~4 MB of binaries that nothing loads. So a
/// reference only counts when it sits in an import/export/require position inside a
/// quoted string, with comments stripped first.
fn subpaths_referenced_in(source: &str) -> BTreeSet<String> {
    const PREFIX: &str = "@zcode/rust/";
    let code = strip_comments(source);
    let mut out = BTreeSet::new();
    let mut search = 0usize;
    while let Some(relative) = code[search..].find(PREFIX) {
        // `relative` is relative to `search`; the absolute start of the prefix is the
        // sum. Keeping the two apart matters — mixing them slices past the end.
        let prefix_start = search + relative;
        let tail = &code[prefix_start + PREFIX.len()..];
        let end = tail
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
            .unwrap_or(tail.len());
        if end > 0 && is_module_specifier_position(&code[..prefix_start]) {
            out.insert(tail[..end].to_string());
        }
        // Resume just past the prefix so overlapping matches cannot loop forever.
        search = prefix_start + PREFIX.len();
    }
    out
}

/// Replaces comment bodies with spaces, leaving every other character untouched.
///
/// Length is not preserved (one space per comment *character*), and that is fine: the
/// result is only used for substring search plus a prefix test, and every index the
/// caller computes comes from `find` on this same string, so all slices land on
/// character boundaries. String literals are copied verbatim, so a `//` inside a URL
/// or a regex-like value never opens a comment.
fn strip_comments(source: &str) -> String {
    #[derive(PartialEq)]
    enum State {
        Normal,
        LineComment,
        BlockComment,
        SingleQuote,
        DoubleQuote,
        Backtick,
    }

    let mut out = String::with_capacity(source.len());
    let mut state = State::Normal;
    let mut chars = source.chars().peekable();

    while let Some(ch) = chars.next() {
        let next = chars.peek().copied();
        match state {
            State::Normal => match ch {
                '/' if next == Some('/') => {
                    chars.next();
                    state = State::LineComment;
                    out.push(' ');
                }
                '/' if next == Some('*') => {
                    chars.next();
                    state = State::BlockComment;
                    out.push(' ');
                }
                '"' => {
                    state = State::DoubleQuote;
                    out.push(ch);
                }
                '\'' => {
                    state = State::SingleQuote;
                    out.push(ch);
                }
                '`' => {
                    state = State::Backtick;
                    out.push(ch);
                }
                _ => out.push(ch),
            },
            State::LineComment => {
                if ch == '\n' {
                    state = State::Normal;
                    out.push('\n');
                } else {
                    out.push(' ');
                }
            }
            State::BlockComment => {
                if ch == '*' && next == Some('/') {
                    chars.next();
                    state = State::Normal;
                    out.push(' ');
                } else if ch == '\n' {
                    out.push('\n');
                } else {
                    out.push(' ');
                }
            }
            State::DoubleQuote | State::SingleQuote | State::Backtick => {
                let quote = match state {
                    State::DoubleQuote => '"',
                    State::SingleQuote => '\'',
                    _ => '`',
                };
                if ch == '\\' {
                    // Copy the escape and whatever it escapes, so `\"` does not end
                    // the literal.
                    out.push(ch);
                    if let Some(escaped) = chars.next() {
                        out.push(escaped);
                    }
                } else {
                    out.push(ch);
                    if ch == quote {
                        state = State::Normal;
                    }
                }
            }
        }
    }
    out
}

/// True when the text immediately before a specifier puts it in a module position.
///
/// Accepts `… from "…"`, `import "…"`, `import("…")` and `require("…")`. The opening
/// quote is trimmed along with trailing whitespace, because it always sits between the
/// keyword and the specifier.
///
/// No statement-boundary check is applied to `from`: `import a from "x"` puts a binding
/// name between the keyword and `from`, and `export { y } from "x"` puts a clause. A
/// false positive would need a binding literally named `from`/`import`/`require`
/// immediately before a `@zcode/rust/…` string literal, and the only consequence would
/// be that a crate ships — which is the safe direction for a payload decision.
fn is_module_specifier_position(before: &str) -> bool {
    let trimmed = before
        .trim_end()
        .trim_end_matches(['"', '\'', '`'])
        .trim_end();
    trimmed.ends_with("from")
        || trimmed.ends_with("import")
        || trimmed.ends_with("import(")
        || trimmed.ends_with("require(")
        || trimmed.ends_with("require")
}

/// How a crate ended up in (or out of) the payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classification {
    /// Has at least one importer; ships.
    Live { subpath: String, importers: Vec<String> },
    /// Declared a subpath but nothing imports it; does not ship.
    NoConsumer { subpath: String },
    /// Not a `cdylib` crate, so cargo emits no shared object; does not ship.
    NotCdylib,
    /// Emits a shared object but exposes no `@zcode/rust` subpath, so nothing can
    /// reach it from TypeScript; does not ship. This is the build tool's own case.
    NoSubpath,
}

/// The resolved inventory: one classification per crate, plus the orphans that have
/// no subpath export at all.
#[derive(Debug)]
pub struct Inventory {
    pub crates: Vec<CrateInfo>,
    pub classifications: BTreeMap<String, Classification>,
    /// cdylib crates with no `@zcode/rust` subpath export — surfaced so they cannot
    /// silently exist outside the payload decision.
    pub cdylib_without_subpath: Vec<String>,
}

impl Inventory {
    /// Crates that must be present in a packaged artifact, in stable order.
    pub fn live_binaries(&self) -> Vec<String> {
        self.classifications
            .iter()
            .filter_map(|(name, class)| match class {
                Classification::Live { .. } => Some(name.clone()),
                _ => None,
            })
            .collect()
    }

    /// Human-readable reason a crate is not shipped.
    pub fn skip_reason(&self, name: &str) -> String {
        match self.classifications.get(name) {
            Some(Classification::NotCdylib) => {
                "not a cdylib crate; cargo emits no shared object (an rlib is linked into its host, a bin is a build tool)".to_string()
            }
            Some(Classification::NoConsumer { subpath }) => format!(
                "@zcode/rust/{subpath} has no importer; built but unwired (renderer-safe TS twin)"
            ),
            Some(Classification::NoSubpath) => {
                "emits a shared object but exposes no @zcode/rust subpath, so TypeScript cannot load it".to_string()
            }
            Some(Classification::Live { .. }) => "live".to_string(),
            None => "not a workspace crate".to_string(),
        }
    }
}

/// Builds the full inventory for the repository at `repo_root`.
pub fn build(repo_root: &Path) -> Result<Inventory, InventoryError> {
    let rust_root = find_rust_root(repo_root)?;
    let crates = read_crates(&rust_root)?;
    let exports = read_subpath_exports(&rust_root, repo_root)?;
    let importers = find_subpath_importers(repo_root);

    let mut classifications: BTreeMap<String, Classification> = BTreeMap::new();
    let mut cdylib_without_subpath = Vec::new();

    for export in &exports {
        let crate_info = match crates.iter().find(|c| c.name == export.binary_name) {
            Some(info) => info,
            None => {
                // A subpath whose wrapper loads a binary with no matching crate is a
                // packaging contract violation; refuse to guess.
                return Err(InventoryError::WrapperWithoutLoadNative {
                    wrapper: repo_root.join(&export.wrapper),
                });
            }
        };        if !crate_info.is_cdylib {
            classifications.insert(
                export.binary_name.clone(),
                Classification::NotCdylib,
            );
            continue;
        }
        match importers.get(&export.subpath) {
            Some(files) if !files.is_empty() => {
                classifications.insert(
                    export.binary_name.clone(),
                    Classification::Live {
                        subpath: export.subpath.clone(),
                        importers: files.iter().cloned().collect(),
                    },
                );
            }
            _ => {
                classifications.insert(
                    export.binary_name.clone(),
                    Classification::NoConsumer {
                        subpath: export.subpath.clone(),
                    },
                );
            }
        }
    }

    for crate_info in &crates {
        if classifications.contains_key(&crate_info.name) {
            continue;
        }
        // A crate with no subpath export cannot be loaded from TypeScript at all, so it
        // never ships. Recording why keeps `inventory` honest instead of leaving these
        // as unclassified noise.
        if crate_info.is_cdylib {
            cdylib_without_subpath.push(crate_info.name.clone());
            classifications.insert(crate_info.name.clone(), Classification::NoSubpath);
        } else {
            classifications.insert(crate_info.name.clone(), Classification::NotCdylib);
        }
    }

    Ok(Inventory {
        crates,
        classifications,
        cdylib_without_subpath,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cdylib_is_detected_from_the_lib_section() {
        assert!(manifest_has_cdylib(
            "[lib]\ncrate-type = [\"cdylib\"]\n"
        ));
        assert!(manifest_has_cdylib(
            "[package]\nname = \"x\"\n\n[lib]\ncrate-type = [\"cdylib\", \"rlib\"]\n"
        ));
    }

    #[test]
    fn rlib_is_not_mistaken_for_cdylib() {
        // zcode-rpc-server is the real case: rlib only, linked into the Tauri host.
        assert!(!manifest_has_cdylib("[lib]\ncrate-type = [\"rlib\"]\n"));
        // No [lib] at all means cargo's default (rlib) — nothing to stage.
        assert!(!manifest_has_cdylib("[package]\nname = \"x\"\nversion = \"0\"\n"));
    }

    #[test]
    fn a_non_lib_crate_type_does_not_leak_into_the_decision() {
        // `[[bin]]` sections are not `[lib]`, so a cdylib-looking value there must not
        // make the crate shippable.
        assert!(!manifest_has_cdylib(
            "[[bin]]\nname = \"x\"\ncrate-type = [\"cdylib\"]\n"
        ));
    }

    #[test]
    fn load_native_call_is_extracted_through_the_generic_parameter() {
        let source = r#"
            export function loadDiff() {
              let m;
              if (!m) m = loadNative<NativeDiffModule>("zcode-diff");
              return m;
            }
        "#;
        assert_eq!(
            find_load_native_call(source).as_deref(),
            Some("zcode-diff")
        );
    }

    #[test]
    fn load_native_call_is_extracted_without_generics() {
        let source = r#"const m = loadNative("zcode-rpc-utils");"#;
        assert_eq!(
            find_load_native_call(source).as_deref(),
            Some("zcode-rpc-utils")
        );
    }

    #[test]
    fn a_non_zcode_argument_is_not_accepted() {
        // Guards against silently classifying a wrapper by an unrelated string.
        assert_eq!(find_load_native_call(r#"loadNative("some-lib")"#), None);
    }

    #[test]
    fn relative_imports_are_extracted() {
        let imports = relative_imports(
            r#"import { a } from "./taskIndex.js";
import type { B } from "../shared/x.js";
import { c } from "@zcode/shared";"#,
        );
        assert_eq!(
            imports,
            vec!["./taskIndex.js".to_string(), "../shared/x.js".to_string()]
        );
    }

    /// The shared-store facades do not call `loadNative` themselves; the inventory has to follow
    /// their relative import to the module that owns the call, or `build:native` fails on a
    /// repository whose only "error" is the one-connection design.
    #[test]
    fn a_companion_wrapper_inherits_the_binary_from_its_relative_import() {
        let dir = std::env::temp_dir().join(format!(
            "zcode-inventory-delegation-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let owner = dir.join("taskIndex.ts");
        fs::write(
            &owner,
            r#"const m = loadNative<NativeTaskIndexModule>("zcode-task-index");"#,
        )
        .expect("owner wrapper");
        let companion = dir.join("offPeakRepository.ts");
        fs::write(&companion, r#"import { NATIVE_STORE } from "./taskIndex.js";"#)
            .expect("companion wrapper");

        assert_eq!(
            find_delegated_load_native(&companion, 4).as_deref(),
            Some("zcode-task-index")
        );
        // A cycle must terminate rather than recurse forever.
        fs::write(&companion, r#"import { NATIVE_STORE } from "./offPeakRepository.js";"#)
            .expect("self import");
        assert_eq!(find_delegated_load_native(&companion, 4), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn subpath_specifiers_are_extracted_with_a_word_boundary() {
        let found = subpaths_referenced_in(
            r#"import a from "@zcode/rust/events";
               import b from "@zcode/rust/git";
               const c = "@zcode/rust/image";"#,
        );
        assert!(found.contains("events"));
        assert!(found.contains("git"));
        // A bare string constant is not a module reference.
        assert!(!found.contains("image"), "{found:?}");
    }

    /// Regression: `tsup.config.ts` lists `"@zcode/rust"` in a bundler externals array
    /// and in a `//` comment. Counting those shipped four binaries that nothing loads.
    #[test]
    fn a_bundler_externals_entry_is_not_an_importer() {
        let source = r#"
            // `@zcode/rust` must NOT stay external: its exports point at TypeScript sources.
            const noExternal = [
              "@zcode/rust",
              "playwright-core",
            ];
        "#;
        assert!(subpaths_referenced_in(source).is_empty(), "{:?}", subpaths_referenced_in(source));
    }

    #[test]
    fn all_module_specifier_forms_are_accepted() {
        for source in [
            r#"import x from "@zcode/rust/git";"#,
            r#"import "@zcode/rust/git";"#,
            r#"const x = require("@zcode/rust/git");"#,
            r#"import x = require("@zcode/rust/git");"#,
            r#"export { y } from "@zcode/rust/git";"#,
            r#"import(
              "@zcode/rust/git"
            );"#,
        ] {
            assert!(
                subpaths_referenced_in(source).contains("git"),
                "not detected in: {source}"
            );
        }
    }

    #[test]
    fn a_commented_out_import_does_not_count() {
        let source = r#"
            // import x from "@zcode/rust/reassembly";
            /* import y from "@zcode/rust/projection"; */
        "#;
        assert!(subpaths_referenced_in(source).is_empty());
    }

    #[test]
    fn a_slash_inside_a_string_literal_is_not_a_comment() {
        // Stripping comments must not eat the rest of a line that contains a URL, which
        // would otherwise hide a real import on the same line.
        let source = r#"import x from "@zcode/rust/git"; // see https://example.com/a"#;
        assert!(subpaths_referenced_in(source).contains("git"));
    }

    #[test]
    fn non_ascii_text_does_not_corrupt_byte_offsets() {
        // 中文注释 + a real import: strip_comments copies multi-byte chars verbatim.
        let source = "// 中文注释：这是一个测试\nimport x from \"@zcode/rust/git\";\nconst s = \"值\";";
        assert_eq!(subpaths_referenced_in(source).into_iter().collect::<Vec<_>>(), vec!["git"]);
    }

    #[test]
    fn the_dot_subpath_is_not_treated_as_a_crate() {
        // Guards the `strip_prefix("./")` branch against a bare "." export.
        assert!(subpaths_referenced_in(r#"from "@zcode/rust/""#).is_empty());
    }
}
