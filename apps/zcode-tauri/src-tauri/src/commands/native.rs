//! Native OS commands — dialogs, opener, shell, notifications.
//!
//! Replaces the file-picker / open / notification half of the Electron
//! `ipcMain.handle` registrations in `packages/desktop/src/main`
//! (`desktopSaveFile.ts`, `desktopMainIpcPlatform.ts`,
//! `desktopMainIpcRemote.ts`, `desktopMainIpcHelpers.ts`,
//! `desktopNotifications.ts`).
//!
//! Every function here is a `#[tauri::command]` so it is reachable from the
//! renderer. Rust-side callers reach these functions directly; the Electron
//! equivalents went through `dialog.showOpenDialog` etc. on the main side for
//! the same reason — the picker must not be spoofable by the page.
//!
//! Arg casing: `#[tauri::command]` defaults to `rename_all = "camelCase"` on the
//! wire, so a Rust `suggested_name` parameter is read from TS `suggestedName`.
//!
//! Threading: the picker commands are `async` and await the dialog plugin's
//! callback API through a oneshot channel — `blocking_pick_file` and friends
//! must never run on the main thread, and parking a runtime worker behind a
//! modal dialog would stall every other command. The opener commands offload
//! process/D-Bus work to `spawn_blocking`. `show_notification` alone stays
//! synchronous because the notification plugin already dispatches its D-Bus
//! round-trip onto the async runtime itself.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use super::{CommandError, CommandResult};

/// Result of an open/reveal request.
///
/// Mirrors Electron's `{ success, error? }` from
/// `main/desktopMainIpcHelpers.ts:46-75`: failures are values reported to the
/// renderer, never thrown, so a missing path does not become an IPC rejection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub success: bool,
    /// Omitted from the wire when `None`, matching the optional `error?` in
    /// the TypeScript `OpenResult` interface.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Dialog plumbing
// ---------------------------------------------------------------------------

/// Callback shape accepted by the dialog plugin's non-blocking pickers.
type DialogCallback = Box<dyn FnOnce(Option<FilePath>) + Send + 'static>;

/// Bridge `app.dialog().file().pick_*` (callback API) into an awaitable future.
///
/// The plugin shows the picker on the main thread via `run_on_main_thread` and
/// delivers the answer from a worker thread (tauri-plugin-dialog 2.8.0
/// `desktop.rs:142-212`), so awaiting here blocks neither the main thread nor a
/// runtime worker — unlike `blocking_pick_*`, which must not run on the main
/// thread at all.
async fn await_file_dialog<F>(start: F) -> Option<FilePath>
where
    F: FnOnce(DialogCallback),
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    start(Box::new(move |result| {
        // The receiver is only gone when the command future was dropped;
        // there is nothing left to deliver in that case.
        let _ = tx.send(result);
    }));
    // A dropped sender (dialog machinery torn down) reads as "cancelled".
    rx.await.unwrap_or(None)
}

/// Convert a picked path into the string the renderer expects.
fn dialog_path_to_string(path: FilePath) -> CommandResult<String> {
    let path = path
        .into_path()
        .map_err(|e| CommandError::Platform(e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Strip glob punctuation from file-filter extensions and drop empties, so
/// `["*.png", ".txt", "  ", "*"]` becomes `["png", "txt"]`. `None`, an empty
/// list, or a list that normalises to nothing all mean "no filter".
fn normalise_extensions(extensions: Option<Vec<String>>) -> Vec<String> {
    extensions
        .into_iter()
        .flatten()
        .map(|ext| {
            ext.trim()
                .trim_start_matches('*')
                .trim_start_matches('.')
                .to_owned()
        })
        .filter(|ext| !ext.is_empty())
        .collect()
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/// Open the native directory picker; `None` when the user cancels.
///
/// Electron: `main/desktopMainIpcPlatform.ts:102-110` —
/// `dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })`,
/// which returns `string | null` on the same cancel condition.
#[tauri::command]
pub async fn pick_directory(app: AppHandle) -> CommandResult<Option<String>> {
    let picked = await_file_dialog(move |done| {
        app.dialog()
            .file()
            .set_can_create_directories(true)
            .pick_folder(done)
    })
    .await;
    picked.map(dialog_path_to_string).transpose()
}

/// Open the native file picker, optionally restricted to `extensions`; `None`
/// when the user cancels.
///
/// Electron: `main/desktopMainIpcPlatform.ts:112-120` —
/// `dialog.showOpenDialog({ properties: ["openFile"] })`. Electron had no
/// extension filter; the optional list narrows the picker and is accepted in
/// `"png"` / `".png"` / `"*.png"` spelling.
#[tauri::command]
pub async fn pick_file(
    app: AppHandle,
    extensions: Option<Vec<String>>,
) -> CommandResult<Option<String>> {
    let filters = normalise_extensions(extensions);
    let picked = await_file_dialog(move |done| {
        let builder = app.dialog().file();
        let builder = if filters.is_empty() {
            builder
        } else {
            let patterns: Vec<&str> = filters.iter().map(String::as_str).collect();
            builder.add_filter("Files", &patterns)
        };
        builder.pick_file(done);
    })
    .await;
    picked.map(dialog_path_to_string).transpose()
}

// ---------------------------------------------------------------------------
// Save file
// ---------------------------------------------------------------------------

/// Reject caller-supplied names that could escape the chosen directory.
///
/// Same rule as `fs.rs::create_temp_text_attachment`: the name rides in from
/// the renderer, so `/`, `\` and `..` never reach `set_file_name` or the write.
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

/// Decode the base64 payload before any UI is shown, so a malformed request
/// fails fast instead of after the user has picked a path.
fn decode_base64_contents(contents_base64: &str) -> CommandResult<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(contents_base64)
        .map_err(|e| CommandError::InvalidPayload(format!("invalid contents_base64: {e}")))
}

/// Show the native save dialog and write `contents_base64` to the chosen path;
/// `Ok(None)` when the user cancels, otherwise the path that was written.
///
/// Electron: `main/desktopSaveFile.ts:184-224` — payload validated at :187-193,
/// `dialog.showSaveDialog` at :205-211, write at :215-220, cancel at :208-211.
/// The Electron version also accepted `sourceUrl` downloads; here the renderer
/// supplies the bytes directly (Tauri's JSON transport drops `ArrayBuffer`, so
/// file bytes ride as base64 — see the note in Cargo.toml).
#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    suggested_name: Option<String>,
    contents_base64: String,
) -> CommandResult<Option<String>> {
    // Validate before any UI: a bad payload must not cost the user a dialog.
    validate_suggested_name(suggested_name.as_deref())?;
    let bytes = decode_base64_contents(&contents_base64)?;

    let mut builder = app.dialog().file();
    if let Some(name) = suggested_name {
        builder = builder.set_file_name(name);
    }
    let Some(target) = await_file_dialog(move |done| builder.save_file(done)).await else {
        return Ok(None);
    };
    let target = target
        .into_path()
        .map_err(|e| CommandError::Platform(e.to_string()))?;
    let result_path = target.to_string_lossy().into_owned();
    // The payload can be large; keep the write off the async workers.
    let written = tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))
    })
    .await?;
    written.map_err(CommandError::Platform)?;
    Ok(Some(result_path))
}

// ---------------------------------------------------------------------------
// Open external URL
// ---------------------------------------------------------------------------

/// Schemes `open_external` will hand to the OS. This is a security boundary: a
/// page must not be able to launch an arbitrary scheme — `file:`,
/// `javascript:`, `data:` and custom protocol handlers stay out of the opener's
/// hands. Electron's gate is `isAllowedExternalOpenUrl` at
/// `main/desktopMainIpcRemote.ts:40-47`, checked for the `OpenExternal`
/// channel at `main/desktopMainIpcRemote.ts:277`. Electron additionally
/// allowed `file:`; local files go through `open_in_file_manager` here instead.
const ALLOWED_EXTERNAL_SCHEMES: [&str; 4] = ["http", "https", "mailto", "tel"];

/// Validate a URL for the opener and return it trimmed.
///
/// Rejection is `CommandError::Forbidden`, not Electron's logged no-op: the
/// renderer asked for an action and deserves to learn it was refused.
fn validate_external_url(url: &str) -> CommandResult<String> {
    let candidate = url.trim();
    // Control characters inside the URL would smuggle text past the scheme
    // check and into the opener (`java\nscript:`-style payloads).
    if candidate.is_empty() || candidate.chars().any(|c| c.is_control()) {
        return Err(CommandError::Forbidden(format!(
            "blocked external url: {candidate:?}"
        )));
    }
    let Some((scheme, remainder)) = candidate.split_once(':') else {
        return Err(CommandError::Forbidden(format!(
            "blocked external url (no scheme): {candidate:?}"
        )));
    };
    // RFC 3986 scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
    let mut chars = scheme.chars();
    let valid_scheme = matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !valid_scheme || remainder.is_empty() {
        return Err(CommandError::Forbidden(format!(
            "blocked external url (bad scheme): {candidate:?}"
        )));
    }
    let scheme = scheme.to_ascii_lowercase();
    if !ALLOWED_EXTERNAL_SCHEMES.contains(&scheme.as_str()) {
        return Err(CommandError::Forbidden(format!(
            "scheme not allowed: {scheme}"
        )));
    }
    Ok(candidate.to_string())
}

/// Hand a validated URL to the system default handler (browser, mail client,
/// dialer). Mirrors the `OpenExternal` channel dispatch at
/// `main/desktopMainIpcRemote.ts:269-305`.
#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> CommandResult<()> {
    let url = validate_external_url(&url)?;
    // The opener still forks helper processes (`open::that_detached`); keep
    // that off the main thread and off the async workers.
    let opened =
        tauri::async_runtime::spawn_blocking(move || app.opener().open_url(url, None::<&str>))
            .await?;
    opened.map_err(|e| CommandError::Platform(e.to_string()))
}

// ---------------------------------------------------------------------------
// Open in file manager
// ---------------------------------------------------------------------------

/// Decided result for an empty/whitespace path, without touching the opener.
/// Electron refuses it up front too: `main/desktopMainIpcHelpers.ts:51-53`.
fn empty_open_path_result(path: &str) -> Option<OpenResult> {
    path.trim().is_empty().then(|| OpenResult {
        success: false,
        error: Some("empty path".to_string()),
    })
}

/// Reveal the target first (select-the-file semantics). When that fails — path
/// gone, or no `FileManager1` service on this desktop — fall back to opening
/// it with the default application, mirroring Electron's `shell.openPath`
/// (`main/desktopMainIpcHelpers.ts:66-75`). Both outcomes are values; the
/// caller never sees a thrown error.
fn reveal_or_open(app: &AppHandle, target: &str) -> OpenResult {
    let opener = app.opener();
    let reveal_error = match opener.reveal_item_in_dir(target) {
        Ok(()) => {
            return OpenResult {
                success: true,
                error: None,
            };
        }
        Err(error) => error,
    };
    // The free `open_path` checks `metadata()` first, so a missing path is
    // reported here instead of being handed to `xdg-open`, which fails only
    // asynchronously and would read as success.
    match tauri_plugin_opener::open_path(target, None::<&str>) {
        Ok(()) => OpenResult {
            success: true,
            error: None,
        },
        Err(open_error) => OpenResult {
            success: false,
            error: Some(format!("reveal failed: {reveal_error}; open failed: {open_error}")),
        },
    }
}

/// Reveal `path` in the OS file manager, falling back to opening it with the
/// default application.
///
/// Electron: `main/desktopMainIpcHelpers.ts:46-75` (`openPathInFileManager`);
/// the Tauri side uses `reveal_item_in_dir` for reveal-in-folder semantics and
/// returns `{ success, error }` — a missing path is reported to the renderer,
/// never thrown across the IPC boundary.
#[tauri::command]
pub async fn open_in_file_manager(app: AppHandle, path: String) -> CommandResult<OpenResult> {
    if let Some(result) = empty_open_path_result(&path) {
        return Ok(result);
    }
    // On Linux `reveal_item_in_dir` talks to FileManager1 over a blocking zbus
    // connection; keep the D-Bus round-trip off every shared thread.
    let result =
        tauri::async_runtime::spawn_blocking(move || reveal_or_open(&app, path.trim())).await?;
    Ok(result)
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

/// Trim both strings and refuse an empty result — Electron does the same at
/// `main/desktopNotifications.ts:104-116` so a notification never fires with
/// missing (unlocalized) copy.
fn trimmed_notification_text(title: &str, body: &str) -> CommandResult<(String, String)> {
    let title = title.trim().to_owned();
    let body = body.trim().to_owned();
    if title.is_empty() || body.is_empty() {
        return Err(CommandError::InvalidPayload(
            "notification title and body must not be empty".to_string(),
        ));
    }
    Ok((title, body))
}

/// Fire a desktop notification.
///
/// Electron: `main/desktopNotifications.ts:104-116` (trimmed copy, empty copy
/// refused) and `:123-127` (`new Notification({ title, body })`).
#[tauri::command]
pub fn show_notification(
    app: AppHandle,
    title: String,
    body: String,
    tag: Option<String>,
) -> CommandResult<()> {
    let (title, body) = trimmed_notification_text(&title, &body)?;
    // Electron's `tag` replaces an earlier same-tag notification. The Tauri
    // notification plugin has no desktop backend support for tags — its
    // desktop.rs forwards only title/body/icon/sound — and `show()` hands back
    // no handle to close the previous notification, so the tag cannot be
    // honoured (NO_NATIVE_EQUIV); the parameter stays for wire compatibility.
    let _ = tag;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| CommandError::Platform(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_documented_external_schemes() {
        for url in [
            "https://example.com/a?b=c",
            "http://example.com",
            "mailto:someone@example.com?subject=hello world",
            "tel:+15551234567",
            "HTTPS://EXAMPLE.COM",
            "  https://example.com  ",
        ] {
            assert!(validate_external_url(url).is_ok(), "should allow {url:?}");
        }
        assert_eq!(validate_external_url("  https://a  ").unwrap(), "https://a");
    }

    #[test]
    fn rejects_disallowed_external_schemes() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "ftp://example.com",
            "data:text/html;base64,PGI+",
            "vbscript:msgbox(1)",
            "zcode-internal://payload",
        ] {
            let error = validate_external_url(url).unwrap_err();
            assert!(
                matches!(error, CommandError::Forbidden(_)),
                "{url:?} should be Forbidden, got {error:?}"
            );
        }
    }

    #[test]
    fn rejects_malformed_external_urls() {
        for url in [
            "",
            "   ",
            "not a url",
            "//example.com",
            ":evil",
            "1https://example.com",
            "ht tp://example.com",
            "https://a\nb",
            "https:",
        ] {
            let error = validate_external_url(url).unwrap_err();
            assert!(
                matches!(error, CommandError::Forbidden(_)),
                "{url:?} should be Forbidden, got {error:?}"
            );
        }
    }

    #[test]
    fn suggested_name_traversal_rejected() {
        for name in ["../evil.txt", "a/b.txt", "a\\b.txt", "..", "dir/.."] {
            let error = validate_suggested_name(Some(name)).unwrap_err();
            assert!(
                matches!(error, CommandError::InvalidPayload(_)),
                "{name:?} should be InvalidPayload, got {error:?}"
            );
        }
        assert!(validate_suggested_name(None).is_ok());
        assert!(validate_suggested_name(Some("report.pdf")).is_ok());
    }

    #[test]
    fn base64_payload_decodes_or_rejects() {
        assert_eq!(decode_base64_contents("aGVsbG8=").unwrap(), b"hello");
        assert!(decode_base64_contents("").unwrap().is_empty());
        let error = decode_base64_contents("not base64!!").unwrap_err();
        assert!(matches!(error, CommandError::InvalidPayload(_)));
    }

    #[test]
    fn extension_filters_normalise() {
        assert!(normalise_extensions(None).is_empty());
        assert!(normalise_extensions(Some(vec![])).is_empty());
        assert_eq!(
            normalise_extensions(Some(vec![
                "*.png".to_string(),
                ".txt".to_string(),
                "  ".to_string(),
                "*".to_string(),
            ])),
            vec!["png".to_string(), "txt".to_string()]
        );
    }

    #[test]
    fn empty_path_is_reported_not_thrown() {
        let result = empty_open_path_result("").unwrap();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("empty path"));
        assert!(empty_open_path_result("   \t").is_some());
        assert!(empty_open_path_result("/tmp/zcode").is_none());
    }

    #[test]
    fn open_result_wire_shape() {
        // The TS adapter reads `{ success, error? }`; `error` must be omitted
        // when absent rather than serialised as null.
        let ok = serde_json::to_value(OpenResult {
            success: true,
            error: None,
        })
        .unwrap();
        assert_eq!(ok, serde_json::json!({ "success": true }));
        let failed = serde_json::to_value(OpenResult {
            success: false,
            error: Some("empty path".to_string()),
        })
        .unwrap();
        assert_eq!(
            failed,
            serde_json::json!({ "success": false, "error": "empty path" })
        );
    }

    #[test]
    fn notification_copy_must_be_present() {
        let (title, body) = trimmed_notification_text("  Hello  ", "\n world \n").unwrap();
        assert_eq!(title, "Hello");
        assert_eq!(body, "world");
        for (title, body) in [("   ", "body"), ("title", "\n\t"), ("", "")] {
            let error = trimmed_notification_text(title, body).unwrap_err();
            assert!(
                matches!(error, CommandError::InvalidPayload(_)),
                "({title:?}, {body:?}) should be InvalidPayload, got {error:?}"
            );
        }
    }
}
