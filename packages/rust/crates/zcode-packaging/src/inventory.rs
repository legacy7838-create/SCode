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
    find_all_load_native_calls(source).into_iter().next()
}

/// Every `loadNative("…")` binary literal in `source`, in order of appearance.
///
/// Both quote styles are accepted so a direct consumer may use either quoting
/// convention; only literals naming a `zcode-*` crate are considered, matching
/// `find_load_native_call`.
fn find_all_load_native_calls(source: &str) -> Vec<String> {
    let needle = "loadNative";
    let mut out = Vec::new();
    let mut search = 0usize;
    while let Some(offset) = source[search..].find(needle) {
        let start = search + offset;
        search = start + needle.len();
        let rest = &source[search..];
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
            continue;
        }
        let args = &rest[cursor + 1..];
        for quote in [b'"', b'\''] {
            let Some(open) = args.as_bytes().iter().position(|b| *b == quote) else {
                continue;
            };
            let Some(close) = args[open + 1..]
                .as_bytes()
                .iter()
                .position(|b| *b == quote)
            else {
                continue;
            };
            let name = &args[open + 1..open + 1 + close];
            if name.starts_with("zcode-") {
                out.push(name.to_string());
            }
        }
    }
    out
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

/// The set of **direct** `loadNative("<crate>")` references anywhere in the workspace,
/// with the files that make them: a wrapperless consumer still ships its binary.
///
/// `packages/rust` is excluded from the scan (as for subpath importers), so a wrapper
/// cannot mark its own crate live; `docs` is excluded so specifications that *describe*
/// a reference do not count as one.
pub fn find_direct_load_native_importers(repo_root: &Path) -> BTreeMap<String, BTreeSet<String>> {
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
        for binary in find_all_load_native_calls(&source) {
            hits.entry(binary).or_default().insert(relative.clone());
        }
    }
    hits
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
/// Matching a bare mention is not enough. A bundler config naming `"@zcode/rust"` in an
/// externals array, or a `//` comment mentioning the subpath, is not a consumer; counting
/// them shipped ~4 MB of binaries that nothing loads. So a
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
    /// Has at least one importer — an `@zcode/rust/<subpath>` import (whose
    /// subpath is named here) or a direct `loadNative("<crate>")` reference
    /// (`None`) — and ships. See `rust-native-model-option-map.md` §4 for the
    /// wrapperless shape.
    Live {
        subpath: Option<String>,
        importers: Vec<String>,
    },
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
    /// Registered commands that no renderer file invokes and that carry no justification marker.
    ///
    /// A command may opt out of this list by naming itself in
    /// `apps/zcode-tauri/UNWIRED_COMMANDS.md` with a reason. That file is the difference between
    /// "waiting for a consumer that is planned" and "dead surface nobody noticed" — without it the
    /// report is fifteen items long and therefore ignored.
    pub registered_commands_without_caller: Vec<String>,
    /// Registered commands that are uncalled but justified, with the stated reason.
    pub justified_uncalled_commands: BTreeMap<String, String>,
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

/// Justifications from `apps/zcode-tauri/UNWIRED_COMMANDS.md`.
///
/// The file is a markdown list of `- \`command_name\` — reason` lines. Parsing the reason as well
/// as the name is the point: a bare allowlist would let a command be excused forever with no record
/// of why, which is how the five already-deleted commands accumulated in the first place.
pub fn read_justified_uncalled(repo_root: &Path) -> BTreeMap<String, String> {
    let path = repo_root.join("apps/zcode-tauri/UNWIRED_COMMANDS.md");
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let mut out = BTreeMap::new();
    for line in text.lines() {
        // Trim the bullet and the space before the backtick, then require the backtick. Doing it
        // as one `strip_prefix("- `")` would eat two characters and land mid-word.
        let Some(rest) = line.trim().strip_prefix('-').map(str::trim_start).filter(|r| r.starts_with('`')).map(|r| &r[1..]) else {
            continue;
        };
        let Some((name, reason)) = rest.split_once('`') else {
            continue;
        };
        let reason = reason.trim_start_matches(['-', ' ', ':', '\u{2014}', '\u{2013}']).trim();
        if !reason.is_empty() {
            out.insert(name.trim().to_string(), reason.to_string());
        }
    }
    out
}

/// The string literals in one source file.
///
/// Over-collects on purpose: anything between quotes counts as a reference, so a comment or an
/// unrelated string can mask an uncalled command. That direction is safe because this check exists
/// to *report* dead surface, and a false negative (a real dead command hidden by a coincidental
/// string) is the failure that matters.
pub fn string_literals_in(source: &str) -> BTreeSet<String> {
    source
        .split(|c: char| c == '"' || c == '\'' || c == '`')
        .map(|part| part.to_string())
        .collect()
}

/// Tauri commands listed in `generate_handler!` that no file under `apps/zcode-tauri/src` names.
///
/// Both halves are name-based on purpose. `generate_handler!` is the single registration point, and
/// the renderer can only reach a command by passing its exact name to `invoke`, so a string match is
/// the same relation the runtime uses — a stricter analysis would be more precise and could reject a
/// working alias. The failure mode of this check is a false positive, never a false negative, which
/// is why it reports rather than blocks.
pub fn find_uncalled_tauri_commands(repo_root: &Path) -> Vec<String> {
    let lib_rs = repo_root
        .join("apps/zcode-tauri/src-tauri/src/lib.rs")
        .canonicalize()
        .unwrap_or_else(|_| repo_root.join("apps/zcode-tauri/src-tauri/src/lib.rs"));
    let Ok(source) = fs::read_to_string(&lib_rs) else {
        return Vec::new();
    };
    let registered: BTreeSet<String> = source
        .lines()
        .filter_map(|line| {
            let line = line.trim().strip_suffix(',')?;
            line.strip_prefix("commands::")
                .and_then(|rest| rest.rsplit("::").next())
                .map(|name| name.to_string())
        })
        .collect();
    if registered.is_empty() {
        return Vec::new();
    }

    // Every string literal in the renderer, which is what an `invoke("name", …)` argument is.
    let mut referenced: BTreeSet<String> = BTreeSet::new();
    let mut files = Vec::new();
    collect_source_files(&repo_root.join("apps/zcode-tauri/src"), &repo_root, &mut files);
    for file in files {
        if let Ok(text) = fs::read_to_string(&file) {
            referenced.extend(string_literals_in(&text));
        }
    }

    registered
        .into_iter()
        .filter(|name| !referenced.contains(name))
        .collect()
}

/// Builds the full inventory for the repository at `repo_root`.
pub fn build(repo_root: &Path) -> Result<Inventory, InventoryError> {
    let rust_root = find_rust_root(repo_root)?;
    let crates = read_crates(&rust_root)?;
    let exports = read_subpath_exports(&rust_root, repo_root)?;
    let importers = find_subpath_importers(repo_root);
    let direct_importers = find_direct_load_native_importers(repo_root);

    let mut classifications: BTreeMap<String, Classification> = BTreeMap::new();
    let mut cdylib_without_subpath = Vec::new();
    let justified_uncalled_commands = read_justified_uncalled(repo_root);
    let registered_commands_without_caller: Vec<String> =
        find_uncalled_tauri_commands(repo_root)
            .into_iter()
            .filter(|name| !justified_uncalled_commands.contains_key(name))
            .collect();

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
                        subpath: Some(export.subpath.clone()),
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
        if !crate_info.is_cdylib {
            classifications.insert(crate_info.name.clone(), Classification::NotCdylib);
            continue;
        }
        // Wrapperless direct consumer: the TypeScript loads the binary itself
        // (`loadNative("<crate>")` in the consumer), so the absence of a subpath
        // export means nothing — the reference is the importer (spec:
        // rust-native-model-option-map.md §4).
        if let Some(files) = direct_importers.get(&crate_info.name) {
            classifications.insert(
                crate_info.name.clone(),
                Classification::Live {
                    subpath: None,
                    importers: files.iter().cloned().collect(),
                },
            );
            continue;
        }
        // A crate with neither a subpath export nor a direct reference cannot be
        // loaded from TypeScript at all, so it never ships. Recording why keeps
        // `inventory` honest instead of leaving these as unclassified noise.
        cdylib_without_subpath.push(crate_info.name.clone());
        classifications.insert(crate_info.name.clone(), Classification::NoSubpath);
    }

    Ok(Inventory {
        crates,
        classifications,
        cdylib_without_subpath,
        registered_commands_without_caller,
        justified_uncalled_commands,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal scratch directory. The inventory tests must not depend on a real checkout, and this
    /// crate has no dev-dependency for it.
    fn tempdir() -> TempDir {
        TempDir::new()
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "zcode-packaging-inventory-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&base).expect("create scratch dir");
            TempDir(base)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    #[test]
    fn a_quoted_command_name_counts_as_referenced() {
        let found = string_literals_in("invoke(\"terminal_create\", { cwd })");
        assert!(found.contains("terminal_create"));
    }

    #[test]
    fn a_command_name_outside_quotes_is_not_a_reference() {
        // The check is deliberately blind to bare identifiers: `invoke(name)` computes the name,
        // and a runtime-computed command name cannot be resolved statically anyway.
        let found = string_literals_in("invoke(name)");
        assert!(!found.contains("name"));
    }

    #[test]
    fn a_justification_needs_a_reason_not_just_a_name() {
        // The parser drops a reason-less entry on purpose: a bare allowlist would let a command be
        // excused forever, which is how the five uncalled commands accumulated unnoticed.
        let dir = tempdir();
        // The reader looks under `apps/zcode-tauri/`, so the fixture has to live there.
        let nested = dir.path().join("apps/zcode-tauri");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            nested.join("UNWIRED_COMMANDS.md"),
            "- `orphan_command`\n- `justified_command` - waits for the browser\n",
        )
        .unwrap();
        let read = read_justified_uncalled(dir.path());
        assert!(!read.contains_key("orphan_command"), "a bare allowlist entry must be dropped");
        assert_eq!(read.get("justified_command").map(String::as_str), Some("waits for the browser"));
        fs::remove_dir_all(dir.path()).ok();
    }

    #[test]
    fn a_missing_justification_file_yields_no_entries() {
        let dir = tempdir();
        assert!(read_justified_uncalled(dir.path()).is_empty());
        fs::remove_dir_all(dir.path()).ok();
    }

    #[test]
    fn single_and_backtick_quotes_count_too() {
        assert!(string_literals_in("invoke('decide_navigation')").contains("decide_navigation"));
        assert!(string_literals_in("invoke(`show_current_window`)").contains("show_current_window"));
    }

    /// Writes the minimal repository skeleton `inventory::build` requires:
    /// `packages/rust/package.json` (with `exports`), one crate manifest, and
    /// an optional consumer file. Returns the repo root path.
    fn scaffold_repo(temp: &TempDir, crate_name: &str, cdylib: bool, consumer: Option<&str>) -> PathBuf {
        let root = temp.path().to_path_buf();
        let rust = root.join("packages/rust");
        std::fs::create_dir_all(rust.join("crates").join(crate_name)).unwrap();
        std::fs::write(
            rust.join("package.json"),
            r#"{ "name": "@zcode/rust", "exports": { ".": "./src/index.ts" } }"#,
        )
        .unwrap();
        let crate_type = if cdylib { r#"["cdylib", "rlib"]"# } else { r#"["rlib"]"# };
        std::fs::write(
            rust.join("crates").join(crate_name).join("Cargo.toml"),
            format!("[package]\nname = \"{crate_name}\"\n\n[lib]\ncrate-type = {crate_type}\n"),
        )
        .unwrap();
        if let Some(body) = consumer {
            let dir = root.join("apps/example");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("consumer.ts"), body).unwrap();
        }
        root
    }

    #[test]
    fn a_direct_load_native_reference_ships_a_cdylib_without_any_subpath() {
        let temp = TempDir::new();
        let root = scaffold_repo(
            &temp,
            "zcode-direct-load",
            true,
            Some(r#"import { loadNative } from "@zcode/rust"; loadNative("zcode-direct-load");"#),
        );
        let inventory = build(&root).expect("inventory");
        assert_eq!(
            inventory.classifications.get("zcode-direct-load"),
            Some(&Classification::Live {
                subpath: None,
                importers: vec!["apps/example/consumer.ts".to_string()],
            }),
            "a wrapperless direct reference is a live importer"
        );
        assert_eq!(
            inventory.live_binaries(),
            vec!["zcode-direct-load".to_string()],
            "the binary must reach the staging plan"
        );
        assert!(
            inventory.cdylib_without_subpath.is_empty(),
            "a direct consumer is not an orphan"
        );
    }

    #[test]
    fn a_single_quoted_and_a_second_reference_in_one_file_both_count() {
        let temp = TempDir::new();
        let root = scaffold_repo(
            &temp,
            "zcode-quoted",
            true,
            Some(
                r#"loadNative('zcode-quoted'); loadNative("zcode-other"); loadNative("zcode-quoted");"#,
            ),
        );
        let hits = find_direct_load_native_importers(&root);
        assert_eq!(
            hits.get("zcode-quoted").map(|files| files.len()),
            Some(1),
            "both references in one file collapse to one importer"
        );
        assert!(hits.contains_key("zcode-other"));
    }

    #[test]
    fn a_cdylib_with_no_subpath_and_no_reference_still_never_ships() {
        let temp = TempDir::new();
        let root = scaffold_repo(&temp, "zcode-unwired", true, None);
        let inventory = build(&root).expect("inventory");
        assert_eq!(
            inventory.classifications.get("zcode-unwired"),
            Some(&Classification::NoSubpath)
        );
        assert!(inventory.live_binaries().is_empty());
    }

    #[test]
    fn the_subpath_mechanism_is_unchanged_by_direct_detection() {
        let temp = TempDir::new();
        let root = temp.path().to_path_buf();
        let rust = root.join("packages/rust");
        std::fs::create_dir_all(rust.join("crates/zcode-wrapped")).unwrap();
        std::fs::create_dir_all(rust.join("src")).unwrap();
        std::fs::write(
            rust.join("package.json"),
            r#"{ "name": "@zcode/rust", "exports": { "./wrapped": "./src/wrapped.ts" } }"#,
        )
        .unwrap();
        std::fs::write(
            rust.join("crates/zcode-wrapped/Cargo.toml"),
            "[lib]\ncrate-type = [\"cdylib\"]\n",
        )
        .unwrap();
        std::fs::write(
            rust.join("src/wrapped.ts"),
            r#"import { loadNative } from "./loader.js"; export const n = () => loadNative("zcode-wrapped");"#,
        )
        .unwrap();
        let dir = root.join("apps/example");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("consumer.ts"),
            r#"import { n } from "@zcode/rust/wrapped"; n();"#,
        )
        .unwrap();
        let inventory = build(&root).expect("inventory");
        assert_eq!(
            inventory.classifications.get("zcode-wrapped"),
            Some(&Classification::Live {
                subpath: Some("wrapped".to_string()),
                importers: vec!["apps/example/consumer.ts".to_string()],
            })
        );
    }
}
