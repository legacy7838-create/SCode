//! Filesystem and shell commands. Replaces `desktopSaveFile.ts`,
//! `desktopPrintToPdf.ts`, the download half of `desktopSaveFile.ts`, and the
//! file/folder half of `desktopMainIpcPlatform.ts`.
//!
//! Path handling note: Electron's `getPathForFile` handed the renderer an
//! absolute local path straight off a `File` object with no normalisation, and
//! the Electron side noted that safety depended entirely on main-side consumers
//! re-validating. The Tauri equivalent keeps the same data flow but routes every
//! filesystem read through an explicit allowlist root, so a dragged path outside
//! the permitted tree is rejected here rather than downstream.
//!
//! ## Confinement is canonical, not lexical
//!
//! `read_text_file` originally compared the *lexically* normalised path against
//! the roots. That folds `../` but not symlinks, so `<root>/link-to-etc/passwd`
//! passed. The rule implemented here is the one `zcode-fs` already enforces for
//! the Node path (`packages/rust/crates/zcode-fs/src/containment.rs:104-133`):
//! **a requested path is admitted only if its canonical form — every symlink
//! resolved — is equal to, or underneath, a canonical root.** A path that does
//! not exist yet cannot be canonicalized, so it is walked component by component
//! down to the deepest ancestor that *can* be; the remainder is kept lexically
//! and `..` cannot walk back out of what has been proven.
//!
//! `zcode-fs` cannot be linked here (it is an napi crate and `Cargo.toml` is
//! owned by the main session), and a Tauri process is not Node anyway, so the
//! same algorithm is implemented locally against `std::fs`.
//!
//! ## Why the allowlist covers the whole data base dir
//!
//! These roots are the app's own trees (`ZCODE_DATA_BASE_DIR`, else `$HOME`) —
//! the same roots `read_text_file` has always used. They are deliberately *not*
//! the whole filesystem: `reveal_in_file_manager` and `open_external_file` take
//! a renderer-supplied path, and Electron handed that path straight to the OS.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri::{AppHandle, State, WebviewWindow};

use super::{require_registered_window, CommandError, CommandResult};
use crate::app_state::AppState;
use crate::supervisor::Supervisor;

/// Roots the renderer may read from. Mirrors the Electron data base dir
/// (`getDataBaseDir()` in `main/desktopDataBaseDirBootstrap.ts`).
#[derive(Debug, Clone)]
pub struct AllowedRoots {
    roots: Vec<PathBuf>,
    /// Canonicalized once, on first use. A root that cannot be canonicalized is
    /// dropped rather than fatal — it cannot contain anything, so dropping it is
    /// fail-closed, and an allowlist that emptied out this way rejects
    /// everything rather than admitting everything.
    canonical: OnceLock<Vec<PathBuf>>,
}

impl AllowedRoots {
    /// Build from the configured data base dir, falling back to `$HOME`.
    pub fn from_env() -> Self {
        let configured = std::env::var("ZCODE_DATA_BASE_DIR")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var("HOME").ok().map(PathBuf::from));
        let roots = configured.into_iter().collect();
        Self::from_paths(roots)
    }

    /// Build from an explicit root list. Public because the command tests build
    /// fixtures with it.
    pub fn from_paths(roots: Vec<PathBuf>) -> Self {
        Self {
            roots,
            canonical: OnceLock::new(),
        }
    }

    /// The configured roots, as supplied.
    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// True when `candidate` resolves inside an allowed root, **lexically**.
    ///
    /// Kept for the cases where the target legitimately does not exist on this
    /// machine (a remote-workspace path the renderer is echoing back); it is
    /// not sufficient on its own and is never the last word on a path that will
    /// be handed to the OS — see [`AllowedRoots::admit`].
    pub fn contains(&self, candidate: &Path) -> bool {
        let normalised = normalise(candidate);
        self.roots
            .iter()
            .any(|root| normalised.starts_with(normalise(root)))
    }

    /// Admit a path for a host operation, returning its canonical form.
    ///
    /// Fails with [`CommandError::Forbidden`] for every escape class — `..`,
    /// a symlink pointing out of the tree, a sibling that merely shares the
    /// root's prefix, or an allowlist that canonicalized to nothing.
    pub fn admit(&self, requested: &Path) -> CommandResult<PathBuf> {
        match std::fs::canonicalize(requested) {
            Ok(canonical) if self.contains_canonical(&canonical) => Ok(canonical),
            Ok(_) => Err(out_of_root(requested)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.admit_absent(requested)?;
                Ok(normalise(requested))
            }
            Err(error) => Err(CommandError::Platform(format!(
                "{}: {error}",
                requested.display()
            ))),
        }
    }

    /// `Path::starts_with` compares whole components, so `/ws-evil/x` does **not**
    /// start with `/ws`. That is the sibling-prefix guard; no separator is
    /// appended and none is needed.
    fn contains_canonical(&self, canonical: &Path) -> bool {
        self.canonical_roots()
            .iter()
            .any(|root| canonical == root.as_path() || canonical.starts_with(root))
    }

    fn canonical_roots(&self) -> &[PathBuf] {
        self.canonical.get_or_init(|| {
            self.roots
                .iter()
                .filter_map(|root| std::fs::canonicalize(root).ok())
                .collect()
        })
    }

    /// Admit a path that is *allowed not to exist*.
    ///
    /// A missing path cannot be canonicalized, so containment is decided on the
    /// deepest ancestor that can be: each existing prefix is replaced by its
    /// canonical form — which is what folds every symlink and every resolvable
    /// `..` — and the remainder is kept lexically. Popping `base` with `..` can
    /// therefore never lead outside what has already been proven.
    fn admit_absent(&self, requested: &Path) -> CommandResult<()> {
        let mut base = PathBuf::new();
        let mut missing = 0usize;
        for component in requested.components() {
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
        if missing == 0 || self.contains_canonical(&base) {
            Ok(())
        } else {
            Err(out_of_root(requested))
        }
    }
}

/// One rejection message for every escape class, naming the **requested** path
/// because that is what the caller sent and what an operator needs in a log.
fn out_of_root(requested: &Path) -> CommandError {
    CommandError::Forbidden(format!(
        "path outside allowed roots: {}",
        requested.display()
    ))
}

/// Lexically resolve `.`/`..` without touching the filesystem.
fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextFileResult {
    pub contents: String,
}

// ---------------------------------------------------------------------------
// Path resolution / normalisation
// ---------------------------------------------------------------------------

/// What a host path turned out to be once the filesystem had been asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostPathKind {
    File,
    Directory,
    /// Not present on this machine, or not a regular file/directory. Matches
    /// `detectPathKind`'s `"unknown"` in `main/openInEditor.ts:32-45`.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedHostPath {
    /// Canonical form: every symlink resolved, every `..` folded.
    pub path: String,
    pub kind: HostPathKind,
    pub exists: bool,
}

// ---------------------------------------------------------------------------
// Temporary attachments
// ---------------------------------------------------------------------------

/// Create a temporary text attachment, mirroring `createTempTextAttachment`
/// in `main/tempTextAttachment.ts`. Writes under the data base dir and returns
/// the path so the renderer can reference it in a prompt.
#[tauri::command]
pub fn create_temp_text_attachment(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    supervisor: State<'_, Supervisor>,
    contents: String,
    suggested_name: Option<String>,
) -> CommandResult<String> {
    require_registered_window(&app_state, window.label())?;
    let name = suggested_name.unwrap_or_else(|| "attachment.txt".to_string());
    // Reject traversal in the caller-supplied name; the temp dir is trusted but
    // the name is not.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(CommandError::InvalidPayload(format!(
            "illegal attachment name: {name}"
        )));
    }
    let dir = supervisor
        .temp_attachment_dir()
        .map_err(|e| CommandError::Platform(e.to_string()))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::Platform(e.to_string()))?;
    let target = dir.join(name);
    std::fs::write(&target, contents)
        .map_err(|e| CommandError::Platform(format!("{}: {e}", target.display())))?;
    Ok(target.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Download / save-location completion
// ---------------------------------------------------------------------------

/// Schemes `save_download_file` will fetch from.
///
/// A download URL arrives from the renderer, so this is the same boundary
/// `open_external` applies to the opener: only the two schemes a download can
/// legitimately be. `file:`, `ftp:` and custom protocol handlers would let a
/// page turn the host into a file reader or a request forwarder.
const ALLOWED_DOWNLOAD_SCHEMES: [&str; 2] = ["http", "https"];

/// Validate a download URL and return it trimmed.
fn validate_download_url(url: &str) -> CommandResult<String> {
    let candidate = url.trim();
    if candidate.is_empty() || candidate.chars().any(|c| c.is_control()) {
        return Err(CommandError::Forbidden(format!(
            "blocked download url: {candidate:?}"
        )));
    }
    let Some((scheme, remainder)) = candidate.split_once(':') else {
        return Err(CommandError::Forbidden(format!(
            "blocked download url (no scheme): {candidate:?}"
        )));
    };
    // RFC 3986 scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
    let mut chars = scheme.chars();
    let valid_scheme = matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !valid_scheme || remainder.is_empty() {
        return Err(CommandError::Forbidden(format!(
            "blocked download url (bad scheme): {candidate:?}"
        )));
    }
    let scheme = scheme.to_ascii_lowercase();
    if !ALLOWED_DOWNLOAD_SCHEMES.contains(&scheme.as_str()) {
        return Err(CommandError::Forbidden(format!(
            "scheme not allowed for download: {scheme}"
        )));
    }
    Ok(candidate.to_string())
}

/// Reject a caller-supplied file name that could escape the chosen directory.
///
/// Same rule as `commands::native::validate_suggested_name`: the name rides in
/// from the renderer, so `/`, `\` and `..` never reach `set_file_name`.
fn validate_suggested_name(name: Option<&str>) -> CommandResult<()> {
    let Some(name) = name else {
        return Ok(());
    };
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(CommandError::InvalidPayload(format!(
            "illegal file name: {name}"
        )));
    }
    Ok(())
}

/// Callback shape accepted by the dialog plugin's non-blocking save picker.
///
/// The plugin shows the picker on the main thread and delivers the answer from a
/// worker thread, so awaiting a oneshot blocks neither the main thread nor a
/// runtime worker.
type SaveDialogCallback = Box<dyn FnOnce(Option<FilePath>) + Send + 'static>;

/// Bridge `app.dialog().file().save_file` into an awaitable future.
///
/// Duplicated from `commands::native::await_file_dialog` because `native.rs` is
/// owned by another slice; the main session should extract it when it next edits
/// that file rather than leaving two copies.
async fn await_save_dialog<F>(start: F) -> CommandResult<Option<PathBuf>>
where
    F: FnOnce(SaveDialogCallback),
{
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    start(Box::new(move |result| {
        let _ = tx.send(result);
    }));
    // A dropped sender (dialog machinery torn down) reads as "cancelled",
    // exactly as Electron's `showSaveDialog` resolving `undefined` did.
    Ok(rx
        .await
        .unwrap_or(None)
        .map(|picked| {
            picked
                .into_path()
                .map_err(|error| CommandError::Platform(error.to_string()))
        })
        .transpose()?)
}

/// Fetch `url` and write it through the native Save As dialog.
///
/// Electron did this in the renderer: `packages/desktop/src/preload/index.ts`
/// forwarded `SaveFileRequest.sourceUrl` and `desktopSaveFile.ts` re-downloaded
/// it, and the Tauri adapter kept that split
/// (`src/platform/tauriPlatform.ts:151-159` fetches in the webview). That put a
/// network fetch and an unbounded `arrayBuffer()` in the page, where a
/// compromised renderer decides what the host retrieves. Here the host fetches,
/// the scheme is constrained, and the bytes never enter the renderer's heap.
///
/// Returns `Ok(None)` when the user cancels, otherwise the path written.
///
/// **Not exercised end to end** (CUTOVER_SPEC §2.6 / PORT_STATUS.md:103-107):
/// the picker is modal, so only the URL validation and the wire shape are
/// covered by tests.
#[tauri::command]
pub async fn save_download_file(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    app: AppHandle,
    url: String,
    suggested_name: Option<String>,
) -> CommandResult<Option<String>> {
    require_registered_window(&app_state, window.label())?;
    // Validate before any UI: a bad payload must not cost the user a dialog.
    let url = validate_download_url(&url)?;
    validate_suggested_name(suggested_name.as_deref())?;

    let downloaded = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let response = reqwest::blocking::get(&url).map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("download failed: HTTP {status}"));
        }
        response
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|error| error.to_string())
    })
    .await?;
    let bytes = downloaded.map_err(CommandError::Platform)?;

    let mut builder = app.dialog().file();
    if let Some(name) = suggested_name {
        builder = builder.set_file_name(name);
    }
    let Some(target) = await_save_dialog(move |done| builder.save_file(done)).await? else {
        return Ok(None);
    };
    let result_path = target.to_string_lossy().into_owned();
    let written = tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))
    })
    .await?;
    written.map_err(CommandError::Platform)?;
    Ok(Some(result_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch tree under the OS temp dir, removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let mut base = std::env::temp_dir();
            base.push(format!(
                "zcode-fs-{}-{}-{:?}",
                tag,
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).expect("scratch");
            Self(base)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn normalises_lexically() {
        assert_eq!(
            normalise(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
    }

    #[test]
    fn rejects_traversal_outside_root() {
        let roots = AllowedRoots::from_paths(vec![PathBuf::from("/home/u/.zcode")]);
        assert!(roots.contains(Path::new("/home/u/.zcode/a.txt")));
        assert!(!roots.contains(Path::new("/home/u/.zcode/../../etc/passwd")));
        assert!(!roots.contains(Path::new("/etc/passwd")));
    }

    #[test]
    fn admits_a_path_inside_the_root_and_canonicalises_it() {
        let scratch = Scratch::new("admit-inside");
        let file = scratch.path().join("a.txt");
        std::fs::write(&file, "ok").unwrap();
        let roots = AllowedRoots::from_paths(vec![scratch.path().to_path_buf()]);
        assert_eq!(roots.admit(&file).unwrap(), file);
    }

    /// The escape class the lexical check alone misses: a symlink *inside* the
    /// root that points at a file outside it.
    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_escapes_the_root() {
        let scratch = Scratch::new("symlink-escape");
        let root = scratch.path().join("root");
        let outside = scratch.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "top secret").unwrap();
        let link = root.join("innocent.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        let roots = AllowedRoots::from_paths(vec![root]);
        // Lexically this looks perfectly contained — which is exactly why the
        // canonical form is what gets compared.
        assert!(roots.contains(&link));
        let error = roots.admit(&link).unwrap_err();
        assert!(matches!(error, CommandError::Forbidden(_)), "{error:?}");
    }

    #[test]
    fn refuses_a_traversal_that_leaves_the_root() {
        let scratch = Scratch::new("traversal-escape");
        let root = scratch.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        let outside = scratch.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let escapee = root.join("..").join("outside").join("secret.txt");
        std::fs::write(&escapee, "top secret").unwrap();

        let roots = AllowedRoots::from_paths(vec![root]);
        let error = roots.admit(&escapee).unwrap_err();
        assert!(matches!(error, CommandError::Forbidden(_)), "{error:?}");
    }

    /// `/ws-evil` shares the `/ws` prefix as a string but not as a path.
    #[test]
    fn refuses_a_sibling_that_shares_the_root_prefix() {
        let scratch = Scratch::new("sibling-prefix");
        let root = scratch.path().join("ws");
        let sibling = scratch.path().join("ws-evil");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let target = sibling.join("secret.txt");
        std::fs::write(&target, "nope").unwrap();

        let roots = AllowedRoots::from_paths(vec![root]);
        assert!(roots.admit(&target).is_err());
    }

    /// The renderer-supplied-absolute-path case: nothing about `/etc/passwd`
    /// makes it special, so it is refused like any other out-of-root path.
    #[test]
    fn refuses_an_absolute_path_outside_the_allowed_root() {
        let scratch = Scratch::new("absolute-outside");
        let root = scratch.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        let roots = AllowedRoots::from_paths(vec![root]);

        for outside in ["/etc/passwd", "/", "/root/.ssh/id_rsa"] {
            let error = roots.admit(Path::new(outside)).unwrap_err();
            assert!(
                matches!(error, CommandError::Forbidden(_)),
                "{outside} must be refused, got {error:?}"
            );
        }
    }

    /// A path that does not exist yet is allowed, but only when its deepest
    /// existing ancestor is proven inside the root.
    #[test]
    fn admits_a_missing_path_under_the_root_but_not_above_it() {
        let scratch = Scratch::new("absent");
        let root = scratch.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        let roots = AllowedRoots::from_paths(vec![root.clone()]);

        let future = root.join("not-created-yet.txt");
        assert_eq!(roots.admit(&future).unwrap(), normalise(&future));

        let above = scratch.path().join("elsewhere").join("nope.txt");
        assert!(matches!(
            roots.admit(&above).unwrap_err(),
            CommandError::Forbidden(_)
        ));
    }

    /// Fail-closed: an allowlist whose roots cannot be canonicalized admits
    /// nothing, rather than degenerating into "allow everything".
    #[test]
    fn an_unresolvable_allowlist_admits_nothing() {
        let scratch = Scratch::new("bad-roots");
        let roots = AllowedRoots::from_paths(vec![scratch.path().join("does-not-exist")]);
        let error = roots.admit(Path::new("/etc/hosts")).unwrap_err();
        assert!(matches!(error, CommandError::Forbidden(_)), "{error:?}");
    }

    #[test]
    fn allows_only_http_and_https_for_downloads() {
        assert_eq!(
            validate_download_url("  https://example.com/a.bin ").unwrap(),
            "https://example.com/a.bin"
        );
        assert_eq!(
            validate_download_url("http://example.com/a.bin").unwrap(),
            "http://example.com/a.bin"
        );
        for blocked in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>",
            "ftp://example.com/a.bin",
            "example.com/a.bin",
            "",
            "   ",
            "https://exa\nmple.com",
        ] {
            let error = validate_download_url(blocked).unwrap_err();
            assert!(
                matches!(error, CommandError::Forbidden(_)),
                "{blocked:?} must be refused, got {error:?}"
            );
        }
    }

    /// A name that walks out of the directory the user picked is refused
    /// before the dialog is ever shown.
    #[test]
    fn refuses_a_suggested_name_that_escapes_the_chosen_directory() {
        assert!(validate_suggested_name(None).is_ok());
        assert!(validate_suggested_name(Some("report.pdf")).is_ok());
        for bad in ["../escape.pdf", "sub/dir.pdf", "sub\\dir.pdf", "..\\escape.pdf"] {
            assert!(
                matches!(
                    validate_suggested_name(Some(bad)).unwrap_err(),
                    CommandError::InvalidPayload(_)
                ),
                "{bad:?} must be refused"
            );
        }
    }
}