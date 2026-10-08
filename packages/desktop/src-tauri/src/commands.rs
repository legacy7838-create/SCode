// Real (non-stub) Tauri v2 commands for the Phase 2 vertical slices.
//
// Contract source of truth: `../tauri-port/BRIDGE.md`. Each command resolves a value from a
// genuine source (package metadata, OS locale, process environment, compile-time OS consts, live
// webview windows); the only hardcoded values are the documented fallbacks required by the
// contract. Slices: 1) version/locale/device id, 2) platform info/app name, 3) OS directories
// (first fallible `Result` commands), 4) window management via Tauri's `WebviewWindow` API,
// 5) native file/save/message dialogs via `tauri-plugin-dialog`, 6) shell/open (URL, reveal,
// path) via `tauri-plugin-opener`, 7) native OS notifications via `tauri-plugin-notification`,
// 8) OS clipboard via `tauri-plugin-clipboard-manager`, 9) window-state queries (size, position,
// visibility, focus) via the existing `WebviewWindow` API, 10) window-mutation commands (set title,
// size, position, center, fullscreen) via the same `WebviewWindow` API; 11) app-path commands
// (home/temp/app-data/app-config dirs via the existing `app.path().resolve`, plus the current
// executable via `std::env::current_exe`); 12) window theme (get/set) via the existing
// `WebviewWindow::theme` / `set_theme` API (no new plugin); 13) desktop zoom (set) via
// `WebviewWindow::set_zoom`, with a pure Electron level↔Tauri factor mapping;
// 14) window chrome extras (scale factor, always-on-top, resizable) via the existing
// `WebviewWindow` getters/setters;
// 15) window visibility & protection (show/hide/skip-taskbar/focusable/content-protected) via the
// existing `WebviewWindow` mutators;
// 16) window state completion (unminimize, is_minimized, inner_position, is/set_enabled) via the
// existing `WebviewWindow` API;
// 17) frame geometry & global cursor (get_window_outer_size reuses WindowSize; get_cursor_position
// via new CursorPosition);
// 19) monitor information (current/primary/available monitors) via `WebviewWindow` display queries,
// mapped through `monitor_to_info`; 20) sidecar lifecycle (spawn retains a `CommandChild` in a
// managed `SidecarRegistry`, `kill_sidecar` reaps it); 21) window frame & interaction (decorations,
// click-through, min/max size set + clear) via the existing `WebviewWindow` mutators; 22) window
// background color (set RGBA + clear) via `WebviewWindow::set_background_color`; 23) window Spaces
// visibility + cursor grab/visibility (three boolean `WebviewWindow` mutators); 24) application
// lifecycle (relaunch + exit) via the core `AppHandle::restart` / `AppHandle::exit`; 25) directory
// picker (`select_directory`) via `tauri-plugin-dialog` folder pickers (selectDirectory parity);
// 26) desktop zoom GETTER via a managed `ZoomRegistry` (Tauri has no zoom getter); 31) sidecar
// dynamic-port discovery (`spawn_sidecar_echo_discover_port` reads the `ZCODE_WS_READY <port>` line
// from the sidecar stdout `Receiver` instead of dropping it); 34) window-title getter
// (`get_window_title`, the companion read for `set_window_title`) via `WebviewWindow::title`.

use tauri::{AppHandle, Manager, WebviewWindow};
// Window background color for the slice-22 `set_window_background_color` command. `Color` is the
// tuple struct `Color(r, g, b, a)` re-exported by the public `tauri::webview` module.
use tauri::webview::Color;
// Event-push API for the slice-33 zoom-changed channel: `AppHandle::emit` broadcasts a serde payload
// to every listener; the renderer subscribes via `@tauri-apps/api/event` `listen`.
use tauri::Emitter;
// Native dialog API surface for the slice-5 commands: the `DialogExt` app-extension, the file
// picker result type, and the message-dialog kinds/buttons.
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogButtons, MessageDialogKind};
// Shell/open API surface for the slice-6 commands: the `OpenerExt` app-extension exposes the real
// OS handlers (`open_url`, `open_path`, `reveal_item_in_dir`).
use tauri_plugin_opener::OpenerExt;
// Notification API surface for the slice-7 command: the `NotificationExt` app-extension returns a
// builder (`app.notification().builder()`) whose `show()` sends a real OS notification.
use tauri_plugin_notification::NotificationExt;
// Clipboard API surface for the slice-8 commands: the `ClipboardExt` app-extension (`app.clipboard()`)
// exposes the real OS clipboard (`read_text` / `write_text`).
use tauri_plugin_clipboard_manager::ClipboardExt;
// Sidecar-spawn API surface for the `spawn_sidecar_echo` command: the `ShellExt` app-extension
// (`app.shell()`) resolves a bundled externalBin by stem and launches it as a child process. The
// returned `CommandChild` reports the OS pid of the launched sidecar.
use tauri_plugin_shell::ShellExt;
// The retained child handle for the slice-20 sidecar lifecycle registry; `kill(self)` consumes it.
use tauri_plugin_shell::process::CommandChild;
// Stdout/stderr/termination events streamed from a spawned sidecar's `Receiver`, read by the
// slice-31 dynamic-port discovery command to parse the sidecar's `ZCODE_WS_READY <port>` line.
use tauri_plugin_shell::process::CommandEvent;
// Managed-state registry for live sidecars: a process-id keyed map guarded by a `Mutex` so the whole
// struct is `Send + Sync` (the Tauri managed-state bound), since `CommandChild` is `Send` but not
// `Sync` (it owns a stdin pipe handle).
use std::collections::HashMap;
use std::sync::Mutex;

/// BCP-47 fallback locale used when the host OS locale cannot be resolved.
const FALLBACK_LOCALE: &str = "en-US";

/// Environment variable carrying a stable device identifier.
///
/// Reading a full, persisted machine-id (Electron parity) is deferred to a later phase; for this
/// slice the command reflects the real environment so the invoke() seam is exercised end to end.
const DEVICE_ID_ENV: &str = "ZCODE_DEVICE_ID";

/// Resolve a locale string from the host OS, falling back to a documented default.
///
/// # Arguments
///
/// * `raw` - The value returned by the OS locale probe (`None` when unavailable).
///
/// # Returns
///
/// The raw locale when present, otherwise [`FALLBACK_LOCALE`].
pub fn locale_or_default(raw: Option<String>) -> String {
    raw.unwrap_or_else(|| FALLBACK_LOCALE.to_string())
}

/// Resolve a device identifier from the environment, falling back to an empty string.
///
/// # Arguments
///
/// * `raw` - The value read from [`DEVICE_ID_ENV`] (`None` when unset).
///
/// # Returns
///
/// The raw id when present, otherwise an empty string.
pub fn device_id_from_env(raw: Option<String>) -> String {
    raw.unwrap_or_default()
}

/// Return the application package version, e.g. `"0.0.0"`.
///
/// Sourced directly from Tauri's embedded package metadata; requires a running app handle so it is
/// not covered by the pure unit tests.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing package info.
///
/// # Returns
///
/// The semantic version of the running package as a string.
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Return the host system locale (BCP-47-ish), e.g. `"en-US"`.
///
/// Uses the `sys-locale` crate and falls back to [`FALLBACK_LOCALE`] when the OS locale is unknown.
#[tauri::command]
pub fn get_system_locale() -> String {
    locale_or_default(sys_locale::get_locale())
}

/// Return a stable device identifier, or `""` when unavailable.
///
/// Reads the `ZCODE_DEVICE_ID` environment variable. Full machine-id parity with Electron is a
/// later phase; this slice performs a real environment read rather than returning a constant.
#[tauri::command]
pub fn get_device_id() -> String {
    device_id_from_env(std::env::var(DEVICE_ID_ENV).ok())
}

/// Operating system and CPU architecture of the host running the Tauri shell.
///
/// Sourced at compile time from `std::env::consts` (`OS`/`ARCH`), so no extra crate is required.
/// Serialized to the renderer as `{ os, arch }` per the slice-2 bridge contract.
#[derive(serde::Serialize)]
pub struct PlatformInfo {
    /// Operating system identifier, e.g. `"linux"`, `"macos"`, `"windows"`.
    pub os: String,
    /// CPU architecture identifier, e.g. `"x86_64"`, `"aarch64"`.
    pub arch: String,
}

/// Build a [`PlatformInfo`] from raw OS and architecture strings.
///
/// Kept as a pure helper so the field wiring is unit-testable without a running app handle.
///
/// # Arguments
///
/// * `os` - Operating system identifier (typically `std::env::consts::OS`).
/// * `arch` - CPU architecture identifier (typically `std::env::consts::ARCH`).
///
/// # Returns
///
/// A [`PlatformInfo`] carrying the given `os` and `arch` values.
pub fn build_platform_info(os: &str, arch: &str) -> PlatformInfo {
    PlatformInfo {
        os: os.to_string(),
        arch: arch.to_string(),
    }
}

/// Return the host operating system and CPU architecture.
///
/// Values come from `std::env::consts::OS` and `std::env::consts::ARCH`, compiled into the binary.
#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    build_platform_info(std::env::consts::OS, std::env::consts::ARCH)
}

/// Return the application package name, e.g. `"ZCode"`.
///
/// Sourced from Tauri's embedded package metadata; requires a running app handle so it is not
/// covered by the pure unit tests.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing package info.
///
/// # Returns
///
/// The display name of the running package as a string.
#[tauri::command]
pub fn get_app_name(app: AppHandle) -> String {
    app.package_info().name.clone()
}

/// Relaunch the application process (terminate + start a fresh instance).
///
/// Phase 2 slice 24 (application lifecycle). Grounded in the real menu command id
/// `DesktopCommandIds.RelaunchApp` (`packages/shared/src/platform.ts`), the Tauri equivalent of
/// Electron's `app.relaunch()` + quit. Delegates to the core `AppHandle::restart()`
/// (`tauri/src/app.rs:606`), which is declared `-> !`: it tears the runtime down and re-executes the
/// binary. Because `restart` diverges, the `!` coerces to the command's `Result` return type and the
/// call never produces an `Ok`/`Err` — the renderer's `invoke` Promise simply never resolves once the
/// process is gone (the same observable behavior Electron's relaunch has). No extra plugin or
/// capability: this is a Rust-side core `AppHandle` method, not a JS-facing API. Requires a running
/// app, so it is compile-verified and exercised under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle used to restart the process.
///
/// # Returns
///
/// Never returns normally; the `Result<(), String>` signature exists only so the diverging
/// `restart()` coerces into the command contract.
#[tauri::command]
pub fn relaunch_app(app: AppHandle) -> Result<(), String> {
    app.restart()
}

/// Exit the application with the given process exit code.
///
/// Phase 2 slice 24. Maps to Electron's `app.quit()`/process exit. Delegates to the core
/// `AppHandle::exit(code)` (`tauri/src/app.rs:581`), which triggers `RunEvent::ExitRequested` and then
/// `RunEvent::Exit` before the process terminates. `exit` returns `()`, so `Ok(())` follows the call
/// in the normal (pre-teardown) control flow. No plugin/capability needed (Rust-side core method).
/// Requires a running app; compile-verified and exercised under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle used to exit the process.
/// * `code` - The process exit code to request (`0` for a clean exit).
///
/// # Returns
///
/// `Ok(())` after requesting exit; `Err` is not produced by this path (the OS teardown follows).
#[tauri::command]
pub fn exit_app(app: AppHandle, code: i32) -> Result<(), String> {
    app.exit(code);
    Ok(())
}

/// Convert a resolved directory path into an owned `String` for transport to the renderer.
///
/// Kept as a pure helper so the lossy UTF-8 coercion and trailing-separator normalization are
/// unit-testable without a running app handle. Tauri's `PathResolver::resolve` appends the
/// requested (here, empty) sub-path, so a base directory comes back with a trailing separator; we
/// strip it to yield a clean directory path. Non-UTF-8 sequences fall back to their lossy
/// representation rather than panicking, matching the "never `.unwrap()` in library paths" rule.
///
/// # Arguments
///
/// * `path` - The resolved filesystem directory path to stringify.
///
/// # Returns
///
/// The directory as an owned UTF-8 `String`, without a trailing path separator (the filesystem root
/// `"/"` is preserved).
pub fn directory_to_string(path: std::path::PathBuf) -> String {
    let raw = path.to_string_lossy();
    let trimmed = raw.trim_end_matches(std::path::is_separator).to_string();
    // Preserve the filesystem root, which would otherwise be trimmed to an empty string.
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed
    }
}

/// Return the host OS downloads directory, e.g. `"/home/user/Downloads"`.
///
/// Resolved through Tauri's built-in path API (`app.path().resolve("", BaseDirectory::Download)`),
/// so no extra crate is required. This is the first fallible command in the slice: the Rust `Err`
/// is converted to `Err(String)` via `.map_err(|e| e.to_string())` (never `.unwrap()`), which
/// surfaces on the TypeScript side as a rejected `Promise` — the error-propagation seam.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the path resolver.
///
/// # Returns
///
/// `Ok(String)` with the absolute downloads directory, or `Err(String)` describing why the OS
/// directory could not be resolved.
#[tauri::command]
pub fn get_download_directory(app: AppHandle) -> Result<String, String> {
    app.path()
        .resolve(
            std::ffi::OsStr::new(""),
            tauri::path::BaseDirectory::Download,
        )
        .map(directory_to_string)
        .map_err(|e| e.to_string())
}

/// Return the host OS documents directory, e.g. `"/home/user/Documents"`.
///
/// Resolved through Tauri's built-in path API (`app.path().resolve("", BaseDirectory::Document)`).
/// Shares the same fallible `Result<String, String>` contract as [`get_download_directory`]; the
/// Rust `Err` becomes a rejected `Promise` on the TypeScript side.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the path resolver.
///
/// # Returns
///
/// `Ok(String)` with the absolute documents directory, or `Err(String)` describing why the OS
/// directory could not be resolved.
#[tauri::command]
pub fn get_documents_directory(app: AppHandle) -> Result<String, String> {
    app.path()
        .resolve(
            std::ffi::OsStr::new(""),
            tauri::path::BaseDirectory::Document,
        )
        .map(directory_to_string)
        .map_err(|e| e.to_string())
}

/// Return the host user's home directory, e.g. `"/home/user"`.
///
/// Phase 2 slice 11 (app-path commands). Resolved through Tauri's built-in path API
/// (`app.path().resolve("", BaseDirectory::Home)`), reusing the slice-3 `resolve` + [`directory_to_string`]
/// pattern so no extra crate is required and any trailing separator is trimmed. Shares the same
/// fallible `Result<String, String>` contract as [`get_download_directory`]; the Rust `Err` becomes a
/// rejected `Promise` on the TypeScript side.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the path resolver.
///
/// # Returns
///
/// `Ok(String)` with the absolute home directory, or `Err(String)` describing why the OS directory
/// could not be resolved.
#[tauri::command]
pub fn get_home_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .resolve(std::ffi::OsStr::new(""), tauri::path::BaseDirectory::Home)
        .map(directory_to_string)
        .map_err(|e| e.to_string())
}

/// Return the host temporary directory, e.g. `"/tmp"`.
///
/// Phase 2 slice 11. Resolved through `app.path().resolve("", BaseDirectory::Temp)` using the same
/// fallible contract as [`get_home_dir`].
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the path resolver.
///
/// # Returns
///
/// `Ok(String)` with the absolute temp directory, or `Err(String)` describing why it could not be
/// resolved.
#[tauri::command]
pub fn get_temp_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .resolve(std::ffi::OsStr::new(""), tauri::path::BaseDirectory::Temp)
        .map(directory_to_string)
        .map_err(|e| e.to_string())
}

/// Return the application data directory, e.g. `"/home/user/.local/share/com.zcode.app"`.
///
/// Phase 2 slice 11. Resolved through `app.path().resolve("", BaseDirectory::AppData)` using the same
/// fallible contract as [`get_home_dir`]. This is the app-scoped writable data location (Electron
/// `app.getPath("userData")` parity).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the path resolver.
///
/// # Returns
///
/// `Ok(String)` with the absolute app-data directory, or `Err(String)` describing why it could not be
/// resolved.
#[tauri::command]
pub fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .resolve(
            std::ffi::OsStr::new(""),
            tauri::path::BaseDirectory::AppData,
        )
        .map(directory_to_string)
        .map_err(|e| e.to_string())
}

/// Return the application configuration directory, e.g. `"/home/user/.config/com.zcode.app"`.
///
/// Phase 2 slice 11. Resolved through `app.path().resolve("", BaseDirectory::AppConfig)` using the
/// same fallible contract as [`get_home_dir`].
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the path resolver.
///
/// # Returns
///
/// `Ok(String)` with the absolute app-config directory, or `Err(String)` describing why it could not
/// be resolved.
#[tauri::command]
pub fn get_app_config_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .resolve(
            std::ffi::OsStr::new(""),
            tauri::path::BaseDirectory::AppConfig,
        )
        .map(directory_to_string)
        .map_err(|e| e.to_string())
}

/// Return the absolute path of the current running executable.
///
/// Phase 2 slice 11. Unlike the other slice-11 commands, the executable path is not a
/// [`tauri::path::BaseDirectory`] variant, so it is read directly from the OS through
/// `std::env::current_exe()`. The result is coerced to a lossy UTF-8 `String` via [`directory_to_string`]
/// (a file path carries no trailing separator, so the trim is a no-op there). The OS `Err` is
/// converted to `Err(String)` via `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing as a
/// rejected `Promise` on the TypeScript side.
///
/// # Arguments
///
/// * `_app` - The Tauri application handle, kept for command-signature consistency with the other
///   path commands; the executable path does not depend on it.
///
/// # Returns
///
/// `Ok(String)` with the absolute executable path, or `Err(String)` describing why the OS could not
/// report it.
#[tauri::command]
pub fn get_exe_path(_app: AppHandle) -> Result<String, String> {
    std::env::current_exe()
        .map(directory_to_string)
        .map_err(|e| e.to_string())
}

/// Resolve a live webview window by its label or produce a renderer-visible error string.
///
/// Shared by the window-management commands so the "missing window" error text stays consistent.
/// Not unit-tested: it needs a running app with real windows, which a pure test harness cannot
/// provide; faking one would violate the no-stub rule.
///
/// # Arguments
///
/// * `app` - The Tauri application handle owning the window registry.
/// * `label` - Window label as registered in `tauri.conf.json` (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(WebviewWindow)` when the label resolves, otherwise `Err` with a "window not found" message.
fn require_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    app.get_webview_window(label)
        .ok_or_else(|| format!("window not found: {label}"))
}

/// Minimize the window identified by `label`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
/// The `Err` surfaces on the TypeScript side as a rejected `Promise`.
#[tauri::command]
pub fn window_minimize(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .minimize()
        .map_err(|e| e.to_string())
}

/// Maximize the window identified by `label`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn window_maximize(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .maximize()
        .map_err(|e| e.to_string())
}

/// Restore (un-maximize) the window identified by `label`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn window_unmaximize(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .unmaximize()
        .map_err(|e| e.to_string())
}

/// Toggle fullscreen state of the window identified by `label`.
///
/// Deviation note: Tauri 2.12's `WebviewWindow` has no `toggle_fullscreen`; the toggle is
/// implemented as a real read (`is_fullscreen`) followed by the inverted `set_fullscreen`, so the
/// command enters fullscreen when windowed and leaves it when fullscreen.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn window_toggle_fullscreen(app: AppHandle, label: String) -> Result<(), String> {
    let window = require_window(&app, &label)?;
    let target = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(target).map_err(|e| e.to_string())?;
    // Best-effort push of the new state (same contract as [`set_fullscreen`]); see
    // [`WINDOW_FULLSCREEN_CHANGED_EVENT`] for why the emit lives at the command boundary.
    let _ = app.emit(
        WINDOW_FULLSCREEN_CHANGED_EVENT,
        fullscreen_changed_payload(target),
    );
    Ok(())
}

/// Close the window identified by `label`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn window_close(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .close()
        .map_err(|e| e.to_string())
}

/// Focus (bring to front and activate) the window identified by `label`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn window_set_focus(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .set_focus()
        .map_err(|e| e.to_string())
}

/// Report whether the window identified by `label` is currently maximized.
///
/// Reads the real window state through Tauri's `is_maximized`; unlike the slice-1..3 helpers it
/// cannot be unit-tested without a live window, so no fake test is written.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(bool)` with the current maximized state; `Err(String)` when the window is missing or the
/// OS cannot report the state.
#[tauri::command]
pub fn window_is_maximized(app: AppHandle, label: String) -> Result<bool, String> {
    require_window(&app, &label)?
        .is_maximized()
        .map_err(|e| e.to_string())
}

/// The inner (client-area) size of a webview window in physical pixels.
///
/// Serialized to the renderer as `{ width, height }`, matching the slice-9 bridge contract. Width
/// and height use `u32` because Tauri's `PhysicalSize` reports unsigned pixel dimensions.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct WindowSize {
    /// Inner width in physical pixels.
    pub width: u32,
    /// Inner height in physical pixels.
    pub height: u32,
}

/// The outer (window-frame) position of a webview window in physical pixels.
///
/// Serialized to the renderer as `{ x, y }`. Coordinates use `i32` because `outer_position` returns
/// a signed offset that may be negative when the window straddles a secondary monitor placed to the
/// top-left of the primary display.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct WindowPosition {
    /// Left edge X coordinate in physical pixels.
    pub x: i32,
    /// Top edge Y coordinate in physical pixels.
    pub y: i32,
}

/// The desktop-wide cursor position in physical pixels (sub-pixel floats).
///
/// Coordinates use `f64` because `WebviewWindow::cursor_position` reports a `PhysicalPosition<f64>`:
/// a global cursor has sub-pixel precision and may be negative when the desktop spans monitors placed
/// to the top-left of the primary display.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct CursorPosition {
    /// Cursor X coordinate in physical pixels (f64 for sub-pixel precision).
    pub x: f64,
    /// Cursor Y coordinate in physical pixels (f64 for sub-pixel precision).
    pub y: f64,
}

/// A serializable snapshot of one OS display (monitor), reusing the geometry structs.
///
/// `#[serde(rename_all = "camelCase")]` is REQUIRED: Tauri auto-camelCases command arguments but NOT
/// returned struct fields (serde owns those), so without it the `scale_factor` field would arrive at
/// the renderer as snake_case `scale_factor` and break the bridge's camelCase invariant.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// Human-readable monitor name when the OS provides one.
    pub name: Option<String>,
    /// Physical pixel dimensions.
    pub size: WindowSize,
    /// Physical pixel origin (top-left) on the virtual desktop.
    pub position: WindowPosition,
    /// Device-pixel-ratio of this monitor.
    pub scale_factor: f64,
}

/// Project a live `tauri::Monitor` into a transportable [`MonitorInfo`].
///
/// Kept as a single pure mapper so all three monitor commands share one field-wiring path (DRY).
/// It cannot be unit-tested without a runtime `Monitor` value (a pure harness cannot fabricate one),
/// so it is compile-verified and exercised under `pnpm dev:tauri`; no fake `Monitor` is built
/// (no-stub rule). Accessors confirmed in tauri 2.12.1: `name()->Option<&String>` (:81),
/// `size()->&PhysicalSize<u32>` (:86), `position()->&PhysicalPosition<i32>` (:91),
/// `scale_factor()->f64` (:101).
///
/// # Arguments
///
/// * `monitor` - The live `tauri::Monitor` to project.
///
/// # Returns
///
/// A [`MonitorInfo`] carrying the monitor's name, size, position and scale factor.
pub fn monitor_to_info(monitor: &tauri::Monitor) -> MonitorInfo {
    let size = monitor.size();
    let position = monitor.position();
    MonitorInfo {
        name: monitor.name().cloned(),
        size: build_window_size(size.width, size.height),
        position: WindowPosition {
            x: position.x,
            y: position.y,
        },
        scale_factor: monitor.scale_factor(),
    }
}

/// Build a [`WindowSize`] from a raw `(width, height)` pair.
///
/// Kept as a pure helper so the field wiring is unit-testable without a live window; the command
/// itself feeds it the values read from `WebviewWindow::inner_size`.
///
/// # Arguments
///
/// * `width` - Inner width in physical pixels.
/// * `height` - Inner height in physical pixels.
///
/// # Returns
///
/// A [`WindowSize`] carrying the given dimensions.
pub fn build_window_size(width: u32, height: u32) -> WindowSize {
    WindowSize { width, height }
}

/// Return the inner size of the window identified by `label`.
///
/// Phase 2 slice 9 (window-state queries). Resolves the live window through [`require_window`] and
/// reads its physical client-area dimensions via `WebviewWindow::inner_size`. Like the slice-4 state
/// query it cannot be unit-tested without a live window, so no fake test is written; the pure wiring
/// is covered through [`build_window_size`].
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(WindowSize)` with the physical dimensions; `Err(String)` when the window is missing or the
/// OS cannot report the size.
#[tauri::command]
pub fn get_window_size(app: AppHandle, label: String) -> Result<WindowSize, String> {
    let size = require_window(&app, &label)?
        .inner_size()
        .map_err(|e| e.to_string())?;
    Ok(build_window_size(size.width, size.height))
}

/// Return the outer position of the window identified by `label`.
///
/// Phase 2 slice 9. Reads the physical top-left frame coordinate via `WebviewWindow::outer_position`;
/// the signed result is exposed through [`WindowPosition`]. Requires a live window, so it is
/// compile-verified here and exercised at runtime under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(WindowPosition)` with the physical frame origin; `Err(String)` when the window is missing or
/// the OS cannot report the position.
#[tauri::command]
pub fn get_window_position(app: AppHandle, label: String) -> Result<WindowPosition, String> {
    let pos = require_window(&app, &label)?
        .outer_position()
        .map_err(|e| e.to_string())?;
    Ok(WindowPosition { x: pos.x, y: pos.y })
}

/// Report whether the window identified by `label` is currently visible.
///
/// Phase 2 slice 9. Reads the real state through `WebviewWindow::is_visible`; requires a live window,
/// so no fake test is written.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(bool)` with the current visibility; `Err(String)` when the window is missing or the OS cannot
/// report the state.
#[tauri::command]
pub fn is_window_visible(app: AppHandle, label: String) -> Result<bool, String> {
    require_window(&app, &label)?
        .is_visible()
        .map_err(|e| e.to_string())
}

/// Report whether the window identified by `label` currently has focus.
///
/// Phase 2 slice 9. Reads the real state through `WebviewWindow::is_focused`; requires a live window,
/// so no fake test is written.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(bool)` with the current focus state; `Err(String)` when the window is missing or the OS cannot
/// report the state.
#[tauri::command]
pub fn is_window_focused(app: AppHandle, label: String) -> Result<bool, String> {
    require_window(&app, &label)?
        .is_focused()
        .map_err(|e| e.to_string())
}

/// Set the title of the window identified by `label`.
///
/// Phase 2 slice 10 (window mutations). Resolves the live window through [`require_window`] and
/// applies the new title via `WebviewWindow::set_title`. Like the other window commands it needs a
/// live GUI window, so no fake test is written; it is compile-verified here and exercised at runtime
/// under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `title` - New window title.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_title(app: AppHandle, label: String, title: String) -> Result<(), String> {
    require_window(&app, &label)?
        .set_title(&title)
        .map_err(|e| e.to_string())
}

/// Return the current title of the window identified by `label`.
///
/// Phase 2 slice 34 (window-title getter). The faithful companion READ for the slice-10
/// `set_window_title` WRITE: reads the live title via `WebviewWindow::title`, the counterpart
/// Electron exposes as `win.getTitle()` that the custom titlebar reads back. Reads real OS/window
/// state — no binary, sync-IPC, or OS gate — so it is complete, not partial. `WebviewWindow::title`
/// is fallible (`Result<String, Error>`), so it uses the standard `.map_err(|e| e.to_string())`
/// seam (never `.unwrap()`). Requires a live GUI window, so it is compile-verified and exercised
/// under `pnpm dev:tauri` (no fake-window unit test — no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(String)` with the window's current title; `Err(String)` when the window is missing or the
/// OS cannot report the title.
#[tauri::command]
pub fn get_window_title(app: AppHandle, label: String) -> Result<String, String> {
    require_window(&app, &label)?
        .title()
        .map_err(|e| e.to_string())
}

/// Resize the window identified by `label` to the given physical-pixel dimensions.
///
/// Phase 2 slice 10. Applies the size via `WebviewWindow::set_size` using a `PhysicalSize` (the same
/// unsigned-pixel unit reported by the slice-9 `get_window_size`). Requires a live window, so it is
/// compile-verified here.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `width` - New inner width in physical pixels.
/// * `height` - New inner height in physical pixels.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_size(
    app: AppHandle,
    label: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    require_window(&app, &label)?
        .set_size(tauri::PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

/// Move the window identified by `label` to the given physical-pixel top-left position.
///
/// Phase 2 slice 10. Applies the origin via `WebviewWindow::set_position` using a `PhysicalPosition`
/// (the same signed-pixel unit reported by the slice-9 `get_window_position`). Requires a live
/// window, so it is compile-verified here.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `x` - New left-edge X coordinate in physical pixels.
/// * `y` - New top-edge Y coordinate in physical pixels.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_position(app: AppHandle, label: String, x: i32, y: i32) -> Result<(), String> {
    require_window(&app, &label)?
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Center the window identified by `label` on its current monitor.
///
/// Phase 2 slice 10. Delegates to `WebviewWindow::center`. Requires a live window, so it is
/// compile-verified here.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn center_window(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .center()
        .map_err(|e| e.to_string())
}

/// Enter or leave fullscreen for the window identified by `label`.
///
/// Phase 2 slice 10. Unlike the slice-4 `window_toggle_fullscreen` (which reads then inverts), this
/// sets an explicit state via `WebviewWindow::set_fullscreen`. Requires a live window, so it is
/// compile-verified here.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `fullscreen` - `true` to enter fullscreen, `false` to leave it.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
/// Event name broadcast whenever [`set_fullscreen`] or [`window_toggle_fullscreen`] changes a window's
/// fullscreen state. The renderer's `tauriBridge.listenTauriWindowFullscreenChanged` subscribes to this
/// exact string (a5 guards the literal against drift). Payload is a bare JSON boolean, matching
/// `IPlatformService.onWindowFullscreenChanged`'s `(isFullscreen: boolean)` argument.
///
/// Parity residual (documented honestly, like slice 26's out-of-shell zoom): Tauri 2.12.1's
/// `WindowEvent` enum (`tauri-2.12.1/src/app.rs:111`) has NO fullscreen variant, so the transition
/// cannot be observed from a native window event — this emits at the COMMAND boundary instead. Every
/// app-driven transition (via these two commands) is reported faithfully, but a transition triggered
/// OUTSIDE the shell (an OS window-manager fullscreen shortcut) is invisible: there is no Tauri event
/// to hook. That external-transition gap is a de-scope residual for the GO-NO-GO decision, NOT a
/// silent stub; the authoritative synchronous value remains readable via [`is_fullscreen`].
pub const WINDOW_FULLSCREEN_CHANGED_EVENT: &str = "zcode:window-fullscreen-changed";

/// Build the [`WINDOW_FULLSCREEN_CHANGED_EVENT`] payload: a bare `serde_json::Value` boolean equal to
/// the new fullscreen state (mirrors the interface's `(isFullscreen: boolean)`, NOT an object). Pure and
/// unit-tested because a5 pins the event NAME but not the payload BODY.
///
/// # Arguments
///
/// * `is_fullscreen` - The fullscreen state just applied.
///
/// # Returns
///
/// A `serde_json::Value` boolean equal to `is_fullscreen`.
pub fn fullscreen_changed_payload(is_fullscreen: bool) -> serde_json::Value {
    serde_json::json!(is_fullscreen)
}

#[tauri::command]
pub fn set_fullscreen(app: AppHandle, label: String, fullscreen: bool) -> Result<(), String> {
    require_window(&app, &label)?
        .set_fullscreen(fullscreen)
        .map_err(|e| e.to_string())?;
    // Best-effort push (same contract as the zoom event in `set_desktop_zoom_level`): a dropped emit
    // must not fail a transition that already applied, and `is_fullscreen` stays the authoritative
    // synchronous read — hence `let _ =`, never `.unwrap()`.
    let _ = app.emit(
        WINDOW_FULLSCREEN_CHANGED_EVENT,
        fullscreen_changed_payload(fullscreen),
    );
    Ok(())
}

/// Report whether the window identified by `label` is currently fullscreen.
///
/// Phase 2 slice 10. Reads the real state through `WebviewWindow::is_fullscreen`; requires a live
/// window, so no fake test is written.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(bool)` with the current fullscreen state; `Err(String)` when the window is missing or the OS
/// cannot report the state.
#[tauri::command]
pub fn is_fullscreen(app: AppHandle, label: String) -> Result<bool, String> {
    require_window(&app, &label)?
        .is_fullscreen()
        .map_err(|e| e.to_string())
}

/// Map a renderer-supplied theme string onto Tauri's [`tauri::Theme`].
///
/// Phase 2 slice 12 (window theme). Pure helper so the case-insensitive parsing is unit-testable
/// without a live window. Returns `Some(Theme)` only for the recognized `"light"` / `"dark"`
/// discriminators; anything else yields `None`, which the calling command turns into an explicit
/// `Err("invalid theme")` rather than silently clearing the theme (the `None` variant there comes
/// from an absent argument, not an unrecognized string).
///
/// # Arguments
///
/// * `s` - Theme discriminator: `"light"` or `"dark"` (case-insensitive).
///
/// # Returns
///
/// The matching [`tauri::Theme`] wrapped in `Some`, or `None` when unrecognized.
pub fn parse_theme(s: &str) -> Option<tauri::Theme> {
    match s.to_ascii_lowercase().as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    }
}

/// Return the current theme of the window identified by `label`.
///
/// Phase 2 slice 12 (window theme). Resolves the live window through [`require_window`] and reads
/// its theme via `WebviewWindow::theme`, mapping the resulting [`tauri::Theme`] to the contract's
/// `"light"` / `"dark"` string. Tauri's `theme()` is fallible (it reports a per-window `Err` when the
/// OS cannot be queried), so it uses the same `.map_err(|e| e.to_string())` seam as the slice-9/10
/// queries — never `.unwrap()` — surfacing the `Err` on the TypeScript side as a rejected `Promise`.
/// Requires a live GUI window, so it is compile-verified here and exercised under `pnpm dev:tauri`;
/// the pure string mapping is covered by [`parse_theme`]'s unit test.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(String)` with `"light"` or `"dark"`; `Err(String)` when the window is missing or the OS
/// cannot report the theme.
#[tauri::command]
pub fn get_window_theme(app: AppHandle, label: String) -> Result<String, String> {
    let theme = require_window(&app, &label)?
        .theme()
        .map_err(|e| e.to_string())?;
    Ok(match theme {
        tauri::Theme::Light => "light".to_string(),
        tauri::Theme::Dark => "dark".to_string(),
        // `tauri::Theme` 是 #[non_exhaustive]，未来可能新增变体；未知主题回退 "unknown" 而非 panic。
        _ => "unknown".to_string(),
    })
}

/// Set (or clear) the theme of the window identified by `label`.
///
/// Phase 2 slice 12. Converts the renderer's `Option<String>` into `Option<tauri::Theme>`: `None`
/// clears the explicit override (letting the window follow the system), `Some("light")` / `Some("dark")`
/// selects the matching theme, and an unrecognized string yields `Err("invalid theme")` rather than
/// silently clearing. The chosen value is applied via `WebviewWindow::set_theme`, whose `Err` is
/// converted with `.map_err(|e| e.to_string())` (never `.unwrap()`). Requires a live window, so it is
/// compile-verified here.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `theme` - Desired theme: `"light"`, `"dark"`, or `None` to clear the override.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the theme string is invalid, the window is missing, or
/// the OS rejects the operation.
#[tauri::command]
pub fn set_window_theme(
    app: AppHandle,
    label: String,
    theme: Option<String>,
) -> Result<(), String> {
    // An absent argument clears the override; a present one must parse to a known theme or error.
    let parsed = match theme.as_deref() {
        None => None,
        Some(s) => Some(parse_theme(s).ok_or_else(|| "invalid theme".to_string())?),
    };
    require_window(&app, &label)?
        .set_theme(parsed)
        .map_err(|e| e.to_string())
}

/// Convert an Electron/Chromium zoom *level* into a Tauri zoom *factor* (scale factor).
///
/// Phase 2 slice 13 (desktop zoom). Chromium exposes zoom as a logarithmic "level" where each step
/// multiplies the scale by `1.2` (`level 0 == factor 1.0 == 100%`), while Tauri's
/// `WebviewWindow::set_zoom` takes a linear scale factor. The documented Electron relation
/// `zoomFactor = 1.2^zoomLevel` is inverted by [`zoom_factor_to_level`]. Kept pure so the
/// float/unit conversion (a PORTING.md Phase-6 trap) is unit-testable without a live window.
///
/// # Arguments
///
/// * `level` - Zoom level, e.g. `0.0` for 100%, `1.0` for 120%.
///
/// # Returns
///
/// The multiplicative scale factor `1.2^level` understood by `set_zoom`.
pub fn zoom_level_to_factor(level: f64) -> f64 {
    1.2_f64.powf(level)
}

/// Convert a Tauri zoom *factor* (scale factor) back into an Electron/Chromium zoom *level*.
///
/// Phase 2 slice 13. The exact inverse of [`zoom_level_to_factor`]: `ln(factor) / ln(1.2)`. Tauri
/// 2.12.1 has no zoom getter, so reading the live level is deferred; this helper exists so the
/// eventual getter (adapter-managed state) can round-trip through the same mapping.
///
/// # Arguments
///
/// * `factor` - Multiplicative scale factor, e.g. `1.0` for level `0`, `1.2` for level `1`.
///
/// # Returns
///
/// The logarithmic zoom level `ln(factor) / ln(1.2)` used by the Electron platform contract.
// 第二十六切片起，本反向映射由 `get_desktop_zoom_level` 运行时调用（把受管状态里记录的因子换算回等级）。
pub fn zoom_factor_to_level(factor: f64) -> f64 {
    factor.ln() / 1.2_f64.ln()
}

/// Last-set desktop zoom factor per window label, for the slice-26 getter.
///
/// Phase 2 slice 26. Tauri 2.12.1 exposes `WebviewWindow::set_zoom` but **no zoom getter**, so
/// Electron's live `getDesktopZoomLevel` is ported by remembering the factor applied by
/// [`set_desktop_zoom_level`] in this managed registry and converting it back on read. `Mutex<HashMap>`
/// keeps the struct `Send + Sync` (the managed-state bound) even though the value is a plain `f64`.
#[derive(Default)]
pub struct ZoomRegistry(Mutex<HashMap<String, f64>>);

/// Set the zoom level of the window identified by `label`.
///
/// Phase 2 slice 13 (desktop zoom). The Electron platform contract and the `ZoomIn`/`ZoomOut`/
/// `ResetZoom` menu commands (`platform.ts` `DesktopCommandIds`) speak in logarithmic zoom *levels*,
/// while Tauri's `WebviewWindow::set_zoom` takes a linear scale factor, so the level is converted
/// through [`zoom_level_to_factor`] (`factor = 1.2^level`) before being applied. The `set_zoom`
/// `Err` is converted with `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the
/// TypeScript side as a rejected `Promise`. Requires a live GUI window, so it is compile-verified
/// here and exercised under `pnpm dev:tauri`; the pure conversion is covered by unit tests.
///
/// On success the applied `factor` is also recorded in the [`ZoomRegistry`] under `label`, so
/// [`get_desktop_zoom_level`] can report the current level back (slice 26 closes the slice-13
/// deferral). A poisoned registry lock is surfaced as `Err` via `.map_err`, not `.unwrap()` — the zoom
/// is applied first, so a registry failure still reports the operation's own outcome ordering below.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry and [`ZoomRegistry`].
/// * `label` - Target window label (the main window is `"main"`).
/// * `level` - Desired zoom level in Electron's logarithmic unit (`0.0` == 100%).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing, the OS rejects the operation, or the
/// registry lock is poisoned.
/// Event name broadcast whenever [`set_desktop_zoom_level`] changes a window's zoom. The renderer's
/// `tauriBridge.listenTauriDesktopZoomChanged` subscribes to this exact string (a5-contract guards the
/// literal against drift). Payload shape is `DesktopZoomState` = `{ zoomLevel: number }`.
pub const ZOOM_CHANGED_EVENT: &str = "zcode:desktop-zoom-changed";

/// Build the `ZOOM_CHANGED_EVENT` payload: an object matching the `DesktopZoomState` contract
/// (`packages/shared`), i.e. `{ "zoomLevel": <level> }` in camelCase. Extracted as a pure fn so the
/// payload SHAPE is unit-tested — the a5 guards pin the event NAME and arg camelCase, but a drift in
/// this key would silently hand the renderer a wrong-shaped `DesktopZoomState` with no failing check.
///
/// # Arguments
///
/// * `level` - The Electron zoom level just applied.
///
/// # Returns
///
/// A `serde_json::Value` object `{ "zoomLevel": level }`.
pub fn zoom_changed_payload(level: f64) -> serde_json::Value {
    serde_json::json!({ "zoomLevel": level })
}

#[tauri::command]
pub fn set_desktop_zoom_level(app: AppHandle, label: String, level: f64) -> Result<(), String> {
    let factor = zoom_level_to_factor(level);
    require_window(&app, &label)?
        .set_zoom(factor)
        .map_err(|e| e.to_string())?;
    let registry = app.state::<ZoomRegistry>();
    registry
        .0
        .lock()
        .map_err(|e| format!("zoom registry lock poisoned: {e}"))?
        .insert(label, factor);
    // Push the change so subscribers of `onDesktopZoomLevelChanged` update. Best-effort by design:
    // the authoritative value lives in `ZoomRegistry` (readable via `get_desktop_zoom_level`), so a
    // dropped emit is recoverable and must NOT fail a zoom that already applied — hence `let _ =`,
    // not `?` and never `.unwrap()`.
    let _ = app.emit(ZOOM_CHANGED_EVENT, zoom_changed_payload(level));
    Ok(())
}

/// Return the current desktop zoom level of the window identified by `label`.
///
/// Phase 2 slice 26 (desktop zoom getter; closes the slice-13 deferral of `getDesktopZoomLevel`).
/// Tauri 2.12.1 has no zoom getter, so the level is recovered by reading the factor that
/// [`set_desktop_zoom_level`] recorded in the [`ZoomRegistry`] and converting it through
/// [`zoom_factor_to_level`] (`level = ln(factor)/ln(1.2)`). The live window is resolved through
/// [`require_window`] first so an unknown label errors exactly like the sibling getters. A window that
/// has never been zoomed returns `0.0` (== 100%), the documented initial default. This is the
/// platform's best-effort port of Electron's live read — a real implementation, not a stub; the only
/// residual (a zoom set outside this shell is invisible to the registry) is inherent to Tauri's missing
/// getter and is documented rather than hidden. Lock poisoning is mapped to `Err` (never `.unwrap()`).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry and [`ZoomRegistry`].
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(f64)` with the current Electron zoom level (`0.0` if never set); `Err(String)` when the window is
/// missing or the registry lock is poisoned.
#[tauri::command]
pub fn get_desktop_zoom_level(app: AppHandle, label: String) -> Result<f64, String> {
    // Validate the label resolves to a live window (parity with the other getters), then read the
    // tracked factor; `0.0` is the initial default when this window has never been zoomed.
    require_window(&app, &label)?;
    let registry = app.state::<ZoomRegistry>();
    let guard = registry
        .0
        .lock()
        .map_err(|e| format!("zoom registry lock poisoned: {e}"))?;
    Ok(guard
        .get(&label)
        .map_or(0.0, |factor| zoom_factor_to_level(*factor)))
}

/// Return the device-pixel-ratio (HiDPI scale factor) of the window identified by `label`.
///
/// Phase 2 slice 14 (window chrome extras). Resolves the live window through [`require_window`] and
/// reads its real scale factor via `WebviewWindow::scale_factor`, the value the frameless custom
/// titlebar uses to lay out HiDPI geometry. `scale_factor` is fallible (it reports a per-window
/// `Err` when the OS cannot be queried), so it uses the same `.map_err(|e| e.to_string())` seam as
/// the slice-9/10/12 queries — never `.unwrap()` — surfacing the `Err` on the TypeScript side as a
/// rejected `Promise`. Requires a live GUI window, so it is compile-verified here and exercised at
/// runtime under `pnpm dev:tauri`; faking a window in a unit test would violate the no-stub rule.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(f64)` with the device-pixel-ratio (`1.0` on a standard display); `Err(String)` when the
/// window is missing or the OS cannot report the scale factor.
#[tauri::command]
pub fn get_window_scale_factor(app: AppHandle, label: String) -> Result<f64, String> {
    require_window(&app, &label)?
        .scale_factor()
        .map_err(|e| e.to_string())
}

/// Report whether the window identified by `label` is currently kept above all others.
///
/// Phase 2 slice 14. Reads the real state through `WebviewWindow::is_always_on_top`; like the
/// slice-9/10 queries it needs a live GUI window, so it is compile-verified here and exercised under
/// `pnpm dev:tauri` (no fake window test is written — faking one violates the no-stub rule). The
/// fallible `Result` is converted with `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing
/// on the TypeScript side as a rejected `Promise`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(bool)` with the current always-on-top state; `Err(String)` when the window is missing or the
/// OS cannot report the state.
#[tauri::command]
pub fn is_window_always_on_top(app: AppHandle, label: String) -> Result<bool, String> {
    require_window(&app, &label)?
        .is_always_on_top()
        .map_err(|e| e.to_string())
}

/// Set whether the window identified by `label` stays above all others.
///
/// Phase 2 slice 14. Applies the flag via `WebviewWindow::set_always_on_top`, the behavior the
/// frameless shell needs for "pin on top". Requires a live GUI window, so it is compile-verified
/// here and exercised under `pnpm dev:tauri`. The `Err` is converted with
/// `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript side as a
/// rejected `Promise`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `always_on_top` - `true` to pin the window above others, `false` to unpin.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_always_on_top(
    app: AppHandle,
    label: String,
    always_on_top: bool,
) -> Result<(), String> {
    require_window(&app, &label)?
        .set_always_on_top(always_on_top)
        .map_err(|e| e.to_string())
}

/// Report whether the window identified by `label` is currently user-resizable.
///
/// Phase 2 slice 14. Reads the real state through `WebviewWindow::is_resizable`; needs a live GUI
/// window, so it is compile-verified here and exercised under `pnpm dev:tauri` (no fake window test
/// is written). The fallible `Result` is converted with `.map_err(|e| e.to_string())` (never
/// `.unwrap()`), surfacing on the TypeScript side as a rejected `Promise`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(bool)` with the current resizable state; `Err(String)` when the window is missing or the OS
/// cannot report the state.
#[tauri::command]
pub fn is_window_resizable(app: AppHandle, label: String) -> Result<bool, String> {
    require_window(&app, &label)?
        .is_resizable()
        .map_err(|e| e.to_string())
}

/// Set whether the window identified by `label` may be resized by the user.
///
/// Phase 2 slice 14. Applies the flag via `WebviewWindow::set_resizable`, letting the frameless
/// shell lock or unlock window geometry (e.g. while a fixed-size panel is shown). Requires a live
/// GUI window, so it is compile-verified here and exercised under `pnpm dev:tauri`. The `Err` is
/// converted with `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript
/// side as a rejected `Promise`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `resizable` - `true` to allow user resizing, `false` to lock the current size.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_resizable(app: AppHandle, label: String, resizable: bool) -> Result<(), String> {
    require_window(&app, &label)?
        .set_resizable(resizable)
        .map_err(|e| e.to_string())
}

/// Show the window identified by `label`.
///
/// Phase 2 slice 15 (window visibility & protection). Resolves the live window through
/// [`require_window`] and calls the real `WebviewWindow::show`, the mirror of Electron's
/// `win.show()`. The fallible `Result<()>` is converted with `.map_err(|e| e.to_string())` (never
/// `.unwrap()`), surfacing on the TypeScript side as a rejected `Promise`. Requires a live GUI
/// window, so it is compile-verified here and exercised under `pnpm dev:tauri` (no fake-window unit
/// test — faking one violates the no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn show_window(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .show()
        .map_err(|e| e.to_string())
}

/// Hide the window identified by `label`.
///
/// Phase 2 slice 15 (window visibility & protection). Resolves the live window through
/// [`require_window`] and calls the real `WebviewWindow::hide`, the mirror of Electron's
/// `win.hide()`. The fallible `Result<()>` is converted with `.map_err(|e| e.to_string())` (never
/// `.unwrap()`), surfacing on the TypeScript side as a rejected `Promise`. Requires a live GUI
/// window, so it is compile-verified here and exercised under `pnpm dev:tauri` (no fake-window unit
/// test — faking one violates the no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn hide_window(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .hide()
        .map_err(|e| e.to_string())
}

/// Set whether the window identified by `label` is hidden from the OS taskbar/dock.
///
/// Phase 2 slice 15 (window visibility & protection). Resolves the live window through
/// [`require_window`] and applies the flag via the real `WebviewWindow::set_skip_taskbar`, the
/// mirror of Electron's `setSkipTaskbar`. The fallible `Result<()>` is converted with
/// `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript side as a rejected
/// `Promise`. Requires a live GUI window, so it is compile-verified here and exercised under
/// `pnpm dev:tauri` (no fake-window unit test — faking one violates the no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `skip` - `true` to hide the window from the taskbar/dock, `false` to show it.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_skip_taskbar(app: AppHandle, label: String, skip: bool) -> Result<(), String> {
    require_window(&app, &label)?
        .set_skip_taskbar(skip)
        .map_err(|e| e.to_string())
}

/// Set whether the window identified by `label` may take keyboard focus.
///
/// Phase 2 slice 15 (window visibility & protection). Resolves the live window through
/// [`require_window`] and applies the flag via the real `WebviewWindow::set_focusable`, the mirror
/// of Electron's `setFocusable`. The fallible `Result<()>` is converted with
/// `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript side as a rejected
/// `Promise`. Requires a live GUI window, so it is compile-verified here and exercised under
/// `pnpm dev:tauri` (no fake-window unit test — faking one violates the no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `focusable` - `true` to allow the window to take focus, `false` to prevent it.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_focusable(app: AppHandle, label: String, focusable: bool) -> Result<(), String> {
    require_window(&app, &label)?
        .set_focusable(focusable)
        .map_err(|e| e.to_string())
}

/// Enable or disable content protection for the window identified by `label`.
///
/// Phase 2 slice 15 (window visibility & protection). Resolves the live window through
/// [`require_window`] and applies the flag via the real `WebviewWindow::set_content_protected`, the
/// anti-screen-capture mirror of the platform contract's `captureWindowScreenshot`
/// (`packages/shared/src/platform.ts`) — when protected, the window is excluded from screenshots and
/// screen recording, as Electron's `setContentProtection` does. The fallible `Result<()>` is
/// converted with `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript
/// side as a rejected `Promise`. Requires a live GUI window, so it is compile-verified here and
/// exercised under `pnpm dev:tauri` (no fake-window unit test — faking one violates the no-stub rule).
///
/// The Rust parameter is named `is_protected` rather than `protected` because `protected` is a
/// reserved keyword in the Rust 2024 edition; naming it `is_protected` keeps the command valid across
/// all editions. Tauri maps the snake_case Rust parameter to a camelCase JS key, so the JS-facing
/// argument is `isProtected` (see the `tauriBridge.ts` wrapper).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `is_protected` - `true` to exclude the window from capture/recording, `false` to allow it.
///   Exposed to the renderer as the JS key `isProtected`.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_content_protected(
    app: AppHandle,
    label: String,
    is_protected: bool,
) -> Result<(), String> {
    require_window(&app, &label)?
        .set_content_protected(is_protected)
        .map_err(|e| e.to_string())
}

/// Restore (un-minimize) the window identified by `label`.
///
/// Phase 2 slice 16 (window state completion). Resolves the live window through [`require_window`]
/// and calls the real `WebviewWindow::unminimize`, the mirror of Electron's restore-from-minimized.
/// The fallible `Result<()>` is converted with `.map_err(|e| e.to_string())` (never `.unwrap()`),
/// surfacing on the TypeScript side as a rejected `Promise`. Requires a live GUI window, so it is
/// compile-verified here and exercised under `pnpm dev:tauri` (no fake-window unit test — faking one
/// violates the no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn window_unminimize(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .unminimize()
        .map_err(|e| e.to_string())
}

/// Report whether the window identified by `label` is currently minimized.
///
/// Phase 2 slice 16 (window state completion). Reads the real state through
/// `WebviewWindow::is_minimized`; like the slice-9/10/14 queries it needs a live GUI window, so it is
/// compile-verified here and exercised under `pnpm dev:tauri` (no fake-window unit test). The
/// fallible `Result` is converted with `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing
/// on the TypeScript side as a rejected `Promise`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(bool)` with the current minimized state; `Err(String)` when the window is missing or the OS
/// cannot report the state.
#[tauri::command]
pub fn is_window_minimized(app: AppHandle, label: String) -> Result<bool, String> {
    require_window(&app, &label)?
        .is_minimized()
        .map_err(|e| e.to_string())
}

/// Return the inner (client-area) position of the window identified by `label`.
///
/// Phase 2 slice 16 (window state completion). Reads the physical top-left of the window's client
/// area via `WebviewWindow::inner_position`, which reports a signed `PhysicalPosition<i32>` mapped
/// onto the SAME [`WindowPosition`] struct the slice-9 [`get_window_position`] uses for
/// `outer_position`. The two differ only in origin: this is the inner client-area origin, the slice-9
/// command is the outer frame origin. Requires a live GUI window, so it is compile-verified here and
/// exercised under `pnpm dev:tauri` (no fake-window unit test). The fallible `Result` is converted
/// with `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript side as a
/// rejected `Promise`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(WindowPosition)` with the physical client-area origin; `Err(String)` when the window is
/// missing or the OS cannot report the position.
#[tauri::command]
pub fn get_window_inner_position(app: AppHandle, label: String) -> Result<WindowPosition, String> {
    let pos = require_window(&app, &label)?
        .inner_position()
        .map_err(|e| e.to_string())?;
    Ok(WindowPosition { x: pos.x, y: pos.y })
}

/// Report whether user interaction with the window identified by `label` is enabled.
///
/// Phase 2 slice 16 (window state completion). Reads the real state through
/// `WebviewWindow::is_enabled`, the flag toggled by [`set_window_enabled`]; needs a live GUI window,
/// so it is compile-verified here and exercised under `pnpm dev:tauri` (no fake-window unit test).
/// The fallible `Result` is converted with `.map_err(|e| e.to_string())` (never `.unwrap()`),
/// surfacing on the TypeScript side as a rejected `Promise`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(bool)` with the current enabled state; `Err(String)` when the window is missing or the OS
/// cannot report the state.
#[tauri::command]
pub fn is_window_enabled(app: AppHandle, label: String) -> Result<bool, String> {
    require_window(&app, &label)?
        .is_enabled()
        .map_err(|e| e.to_string())
}

/// Enable or disable user interaction with the window identified by `label`.
///
/// Phase 2 slice 16 (window state completion). Applies the flag via `WebviewWindow::set_enabled`,
/// letting the shell block or unblock user input on the window (e.g. while a modal is shown). Requires
/// a live GUI window, so it is compile-verified here and exercised under `pnpm dev:tauri` (no
/// fake-window unit test). The fallible `Result<()>` is converted with `.map_err(|e| e.to_string())`
/// (never `.unwrap()`), surfacing on the TypeScript side as a rejected `Promise`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `enabled` - `true` to allow user interaction, `false` to block it.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_enabled(app: AppHandle, label: String, enabled: bool) -> Result<(), String> {
    require_window(&app, &label)?
        .set_enabled(enabled)
        .map_err(|e| e.to_string())
}

/// Return the outer (frame-inclusive) size of the window identified by `label`.
///
/// Phase 2 slice 17 (frame geometry). Resolves the live window through [`require_window`] and reads
/// its physical dimensions via `WebviewWindow::outer_size`, reusing the SAME [`WindowSize`] struct
/// and [`build_window_size`] helper the slice-9 [`get_window_size`] uses. The distinction: slice-9
/// reports the inner client area (`inner_size`), while this command includes the window frame/decorations
/// (matching Electron `win.getBounds()`). The fallible `Result` is converted with
/// `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript side as a rejected
/// `Promise`. Requires a live GUI window, so it is compile-verified here and exercised under
/// `pnpm dev:tauri` (no fake-window unit test — faking one violates the no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(WindowSize)` with the physical frame-inclusive dimensions; `Err(String)` when the window is
/// missing or the OS cannot report the size.
#[tauri::command]
pub fn get_window_outer_size(app: AppHandle, label: String) -> Result<WindowSize, String> {
    let size = require_window(&app, &label)?
        .outer_size()
        .map_err(|e| e.to_string())?;
    Ok(build_window_size(size.width, size.height))
}

/// Return the OS-wide cursor position in physical pixels.
///
/// Phase 2 slice 17 (global cursor). Resolves the live window through [`require_window`] and reads
/// the desktop-wide mouse location via `WebviewWindow::cursor_position`, which reports a
/// `PhysicalPosition<f64>` mapped onto the new [`CursorPosition`]. Unlike the slice-9/16 window
/// positions (`i32`, frame-relative), this is the global cursor and uses `f64` for sub-pixel precision;
/// it may be negative off the top-left of the primary monitor. The fallible `Result` is converted with
/// `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript side as a rejected
/// `Promise`. Requires a live GUI window, so it is compile-verified here and exercised under
/// `pnpm dev:tauri` (no fake-window unit test — faking one violates the no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`), used to reach the cursor API on the
///   window (the value returned is the desktop-wide cursor, not window-relative).
///
/// # Returns
///
/// `Ok(CursorPosition)` with the sub-pixel global cursor coordinates; `Err(String)` when the window
/// is missing or the OS cannot report the cursor position.
#[tauri::command]
pub fn get_cursor_position(app: AppHandle, label: String) -> Result<CursorPosition, String> {
    let pos = require_window(&app, &label)?
        .cursor_position()
        .map_err(|e| e.to_string())?;
    Ok(CursorPosition { x: pos.x, y: pos.y })
}

/// Return the monitor currently hosting the window identified by `label`, if any.
///
/// Phase 2 slice 19 (monitor information). Resolves the live window through [`require_window`] and
/// reads its display via `WebviewWindow::current_monitor`, projecting the resulting
/// `tauri::Monitor` through the shared [`monitor_to_info`] mapper. The fallible `Result` is converted
/// with `.map_err(|e| e.to_string())` FIRST (never `.unwrap()`), then the `Ok` value's `Option` is
/// mapped — surfacing the `Err` on the TypeScript side as a rejected `Promise`. Requires a live GUI
/// window and a real OS display, so it is compile-verified here and exercised under `pnpm dev:tauri`;
/// a pure test cannot fabricate a `Monitor`, so no fake unit test is written (no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(Some(MonitorInfo))` for the hosting monitor, `Ok(None)` when the OS reports none, or
/// `Err(String)` when the window is missing or the OS cannot enumerate displays.
#[tauri::command]
pub fn get_window_current_monitor(
    app: AppHandle,
    label: String,
) -> Result<Option<MonitorInfo>, String> {
    require_window(&app, &label)?
        .current_monitor()
        .map_err(|e| e.to_string())
        .map(|m| m.as_ref().map(monitor_to_info))
}

/// Return the primary monitor of the display identified through the window `label`.
///
/// Phase 2 slice 19 (monitor information). Resolves the live window through [`require_window`] and
/// reads the primary display via `WebviewWindow::primary_monitor`, projected through [`monitor_to_info`].
/// Shares the same slice-19 contract as [`get_window_current_monitor`]: the `.map_err` seam FIRST,
/// never `.unwrap()`, with the `Err` surfacing as a rejected `Promise`. Requires a live GUI window and
/// OS display, so it is compile-verified here and exercised under `pnpm dev:tauri` (no fake `Monitor`
/// unit test — no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(Some(MonitorInfo))` for the primary monitor, `Ok(None)` when the OS reports none, or
/// `Err(String)` when the window is missing or the OS cannot enumerate displays.
#[tauri::command]
pub fn get_primary_monitor(app: AppHandle, label: String) -> Result<Option<MonitorInfo>, String> {
    require_window(&app, &label)?
        .primary_monitor()
        .map_err(|e| e.to_string())
        .map(|m| m.as_ref().map(monitor_to_info))
}

/// Return every monitor available to the window identified by `label`.
///
/// Phase 2 slice 19 (monitor information). Resolves the live window through [`require_window`] and
/// enumerates all displays via `WebviewWindow::available_monitors`, mapping each `tauri::Monitor`
/// through [`monitor_to_info`] (`iter()` yields `&Monitor`, matching the mapper's borrow). The
/// fallible `Result` uses the `.map_err(|e| e.to_string())` seam FIRST (never `.unwrap()`), then the
/// `Ok` `Vec` is projected — the `Err` surfacing as a rejected `Promise`. Requires a live GUI window
/// and OS display, so it is compile-verified here and exercised under `pnpm dev:tauri` (no fake
/// `Monitor` unit test — no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(Vec<MonitorInfo>)` with one entry per display; `Err(String)` when the window is missing or
/// the OS cannot enumerate displays.
#[tauri::command]
pub fn get_available_monitors(app: AppHandle, label: String) -> Result<Vec<MonitorInfo>, String> {
    require_window(&app, &label)?
        .available_monitors()
        .map_err(|e| e.to_string())
        .map(|monitors| {
            monitors
                .iter()
                .map(monitor_to_info)
                .collect::<Vec<MonitorInfo>>()
        })
}

/// Toggle the native title bar / window frame of the window identified by `label`.
///
/// Phase 2 slice 21 (window frame & interaction). Resolves the live window through [`require_window`]
/// and applies the flag via `WebviewWindow::set_decorations`, the mirror of Electron's `setFrame` —
/// the frameless custom-titlebar shell toggles this to swap between native chrome and a drawn one.
/// The `Err` is converted with `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the
/// TypeScript side as a rejected `Promise`. Requires a live GUI window, so it is compile-verified here
/// and exercised under `pnpm dev:tauri` (no fake-window unit test — no-stub rule).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `decorations` - `true` to show the native frame, `false` for a frameless window.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_decorations(
    app: AppHandle,
    label: String,
    decorations: bool,
) -> Result<(), String> {
    require_window(&app, &label)?
        .set_decorations(decorations)
        .map_err(|e| e.to_string())
}

/// Make the window identified by `label` pass mouse events through to what is behind it.
///
/// Phase 2 slice 21. Applies `WebviewWindow::set_ignore_cursor_events`, the capability the overlay /
/// tooltip surfaces need for a click-through window (the pointer lands on the window beneath instead
/// of being consumed). The `Err` uses the standard `.map_err(|e| e.to_string())` seam (never
/// `.unwrap()`). Requires a live GUI window, so it is compile-verified and exercised under
/// `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `ignore` - `true` to ignore (pass through) cursor events, `false` to capture them.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_ignore_cursor_events(
    app: AppHandle,
    label: String,
    ignore: bool,
) -> Result<(), String> {
    require_window(&app, &label)?
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

/// Set the minimum size of the window identified by `label` in physical pixels.
///
/// Phase 2 slice 21. Builds a `PhysicalSize<u32>` (the same unsigned-pixel unit as the slice-9/10
/// size commands) and passes it as `Some(..)` to `WebviewWindow::set_min_size`, which takes an
/// `Option<S: Into<Size>>`. To lift a previously-set minimum use [`clear_window_min_size`]. The `Err`
/// uses `.map_err(|e| e.to_string())` (never `.unwrap()`). Requires a live GUI window, so it is
/// compile-verified and exercised under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `width` - Minimum inner width in physical pixels.
/// * `height` - Minimum inner height in physical pixels.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_min_size(
    app: AppHandle,
    label: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    require_window(&app, &label)?
        .set_min_size(Some(tauri::PhysicalSize::new(width, height)))
        .map_err(|e| e.to_string())
}

/// Set the maximum size of the window identified by `label` in physical pixels.
///
/// Phase 2 slice 21. Mirrors [`set_window_min_size`] via `WebviewWindow::set_max_size`. To lift the
/// cap use [`clear_window_max_size`]. Requires a live GUI window, so it is compile-verified and
/// exercised under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `width` - Maximum inner width in physical pixels.
/// * `height` - Maximum inner height in physical pixels.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_max_size(
    app: AppHandle,
    label: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    require_window(&app, &label)?
        .set_max_size(Some(tauri::PhysicalSize::new(width, height)))
        .map_err(|e| e.to_string())
}

/// Clear the minimum-size constraint on the window identified by `label`.
///
/// Phase 2 slice 21. Passes `None::<PhysicalSize<u32>>` to `WebviewWindow::set_min_size`, which the
/// Option-carrying signature interprets as "no minimum" (the turbofish fixes the `Into<Size>` type so
/// the `None` is unambiguous). Requires a live GUI window; compile-verified and exercised under
/// `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn clear_window_min_size(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .set_min_size(None::<tauri::PhysicalSize<u32>>)
        .map_err(|e| e.to_string())
}

/// Clear the maximum-size constraint on the window identified by `label`.
///
/// Phase 2 slice 21. Passes `None::<PhysicalSize<u32>>` to `WebviewWindow::set_max_size` to lift the
/// cap (the counterpart of [`set_window_max_size`]). Requires a live GUI window; compile-verified and
/// exercised under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn clear_window_max_size(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .set_max_size(None::<tauri::PhysicalSize<u32>>)
        .map_err(|e| e.to_string())
}

/// Set the background (backdrop) color of the window identified by `label`.
///
/// Phase 2 slice 22 (window background color). Builds an RGBA `tauri::webview::Color` from four
/// separate `u8` channel arguments and applies it via `WebviewWindow::set_background_color(Some(..))`,
/// mirroring Electron's `win.setBackgroundColor`. The backdrop shows during load and behind any
/// transparent region. The four channels are distinct single-word args (not a nested object) so the A5
/// camelCase guard is satisfied. The `Err` uses `.map_err(|e| e.to_string())` (never `.unwrap()`).
/// Requires a live GUI window, so it is compile-verified and exercised under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `red` - Red channel, 0..=255.
/// * `green` - Green channel, 0..=255.
/// * `blue` - Blue channel, 0..=255.
/// * `alpha` - Alpha channel, 0..=255 (255 = opaque).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_background_color(
    app: AppHandle,
    label: String,
    red: u8,
    green: u8,
    blue: u8,
    alpha: u8,
) -> Result<(), String> {
    require_window(&app, &label)?
        .set_background_color(Some(Color(red, green, blue, alpha)))
        .map_err(|e| e.to_string())
}

/// Clear the background color override of the window identified by `label`.
///
/// Phase 2 slice 22. Passes `None` to `WebviewWindow::set_background_color`, restoring the OS/webview
/// default backdrop (the counterpart of [`set_window_background_color`]). The `None` needs no
/// turbofish because the parameter type `Option<Color>` is already fixed by the method signature.
/// Requires a live GUI window, so it is compile-verified and exercised under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn clear_window_background_color(app: AppHandle, label: String) -> Result<(), String> {
    require_window(&app, &label)?
        .set_background_color(None)
        .map_err(|e| e.to_string())
}

/// Show or hide the window identified by `label` across all macOS Spaces.
///
/// Phase 2 slice 23. Applies `WebviewWindow::set_visible_on_all_workspaces`, the mirror of Electron's
/// `setVisibleOnAllWorkspaces` — pinning the window so it follows the active Space. Platform-specific
/// (meaningful on macOS; a no-op elsewhere), but the `Result<()>` seam is uniform: the `Err` uses
/// `.map_err(|e| e.to_string())` (never `.unwrap()`). Requires a live GUI window, so it is
/// compile-verified and exercised under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `visible_on_all_workspaces` - `true` to show on every Space, `false` for the current one.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_visible_on_all_workspaces(
    app: AppHandle,
    label: String,
    visible_on_all_workspaces: bool,
) -> Result<(), String> {
    require_window(&app, &label)?
        .set_visible_on_all_workspaces(visible_on_all_workspaces)
        .map_err(|e| e.to_string())
}

/// Confine or release the system cursor to the window identified by `label`.
///
/// Phase 2 slice 23. Applies `WebviewWindow::set_cursor_grab`, the pointer-lock equivalent the
/// renderer needs for capture-style interactions (the cursor cannot leave the window while grabbed).
/// The `Err` uses `.map_err(|e| e.to_string())` (never `.unwrap()`). Requires a live GUI window, so it
/// is compile-verified and exercised under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `grab` - `true` to lock the cursor inside the window, `false` to release it.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_cursor_grab(app: AppHandle, label: String, grab: bool) -> Result<(), String> {
    require_window(&app, &label)?
        .set_cursor_grab(grab)
        .map_err(|e| e.to_string())
}

/// Show or hide the system cursor over the window identified by `label`.
///
/// Phase 2 slice 23. Applies `WebviewWindow::set_cursor_visible`, used to hide the pointer during
/// idle/fullscreen media and restore it on interaction. The `Err` uses `.map_err(|e| e.to_string())`
/// (never `.unwrap()`). Requires a live GUI window, so it is compile-verified and exercised under
/// `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `visible` - `true` to show the cursor, `false` to hide it over this window.
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_window_cursor_visible(
    app: AppHandle,
    label: String,
    visible: bool,
) -> Result<(), String> {
    require_window(&app, &label)?
        .set_cursor_visible(visible)
        .map_err(|e| e.to_string())
}

/// A file-type filter for the open dialog, mirroring the plugin's `{ name, extensions }` shape.
///
/// Deserialized from the renderer's camelCase `DialogFilter` object; Tauri maps the JS fields onto
/// these snake_case Rust fields automatically.
#[derive(serde::Deserialize)]
pub struct DialogFilter {
    /// File-name extensions without a leading dot, e.g. `["rs", "toml"]`.
    extensions: Vec<String>,
    /// Human-readable filter name shown in the native dialog, e.g. `"Source"`.
    name: String,
}

/// Render a plugin [`FilePath`] into an owned UTF-8 string for transport to the renderer.
///
/// Kept pure so the path/URL coercion is unit-testable without a live dialog. The `Path` variant is
/// stringified with a lossy UTF-8 conversion (never `.unwrap()`), while the `Url` variant (e.g. a
/// `file://` or Android `content://` picker result) falls back to its `Display` form rather than
/// panicking on a failed filesystem conversion.
///
/// # Arguments
///
/// * `path` - The picker result path to stringify.
///
/// # Returns
///
/// The filesystem path (lossy) or URL string of the given file path.
fn file_path_to_string(path: &FilePath) -> String {
    match path.as_path() {
        Some(p) => p.to_string_lossy().into_owned(),
        None => path.to_string(),
    }
}

/// Map a renderer-supplied dialog kind string onto the plugin's [`MessageDialogKind`].
///
/// Pure helper so the case-insensitive parsing is unit-testable. Unknown or empty inputs fall back
/// to [`MessageDialogKind::Info`] (the plugin default) rather than erroring, since the kind only
/// affects the icon shown and never the user's yes/no decision.
///
/// # Arguments
///
/// * `kind` - Kind discriminator: `"info"`, `"warning"` or `"error"` (case-insensitive).
///
/// # Returns
///
/// The matching [`MessageDialogKind`], or `Info` when unrecognized.
fn parse_message_kind(kind: &str) -> MessageDialogKind {
    match kind.to_ascii_lowercase().as_str() {
        "warning" => MessageDialogKind::Warning,
        "error" => MessageDialogKind::Error,
        _ => MessageDialogKind::Info,
    }
}

/// Split a save-dialog `default_path` into its parent directory and file name components.
///
/// Pure helper backing the save dialog's default suggestion; mirrors the plugin's own default-path
/// handling (a path that is not an existing directory is treated as a suggested file name). Returns
/// the parent directory when it has at least one component, plus the file name, so the caller can
/// feed them to `FileDialogBuilder::set_directory` / `set_file_name`.
///
/// # Arguments
///
/// * `default_path` - The absolute or relative path suggested as the save target.
///
/// # Returns
///
/// `(directory, file_name)` where either element may be `None` when the path has no such component.
fn split_default_path(default_path: &std::path::Path) -> (Option<String>, Option<String>) {
    let directory = default_path
        .parent()
        .filter(|p| p.components().count() > 0)
        .map(|p| p.to_string_lossy().into_owned());
    let file_name = default_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned());
    (directory, file_name)
}

/// Show a native open-file dialog and return the selected path(s), or `None` on cancel.
///
/// Uses the `tauri-plugin-dialog` blocking API (`app.dialog().file().blocking_pick_files()`), which
/// internally schedules the native picker on the main thread and blocks the calling thread on a
/// sync channel. The command is therefore `async`: Tauri runs `async fn` commands on a worker
/// thread, so the blocking call never freezes the event loop (calling it on the main thread would
/// deadlock). A single selection is requested when `multiple` is false, and the result is normalized
/// to a `Vec<String>`; `serde_json` transports it to the renderer as an array or `null`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the dialog extension.
/// * `multiple` - Whether the user may select more than one file.
/// * `filters` - File-type filters shown by the native dialog.
///
/// # Returns
///
/// `Ok(Some(paths))` for the chosen files, `Ok(None)` when the user cancels, or `Err(String)` if the
/// native dialog cannot be shown. The dialog itself surfaces user cancellation as `None`, not an
/// error; the `Err` arm covers a runtime that refuses to present a native dialog at all.
#[tauri::command]
pub async fn show_open_dialog(
    app: AppHandle,
    multiple: bool,
    filters: Vec<DialogFilter>,
) -> Result<Option<Vec<String>>, String> {
    let mut builder = app.dialog().file();
    for filter in &filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(|s| &**s).collect();
        builder = builder.add_filter(filter.name.clone(), &extensions);
    }

    let picked = if multiple {
        builder.blocking_pick_files()
    } else {
        builder.blocking_pick_file().map(|p| vec![p])
    };

    Ok(picked.map(|paths| {
        paths
            .iter()
            .map(file_path_to_string)
            .collect::<Vec<String>>()
    }))
}

/// Show a native directory (folder) picker and return the selected path(s), or `None` on cancel.
///
/// Phase 2 slice 25 (directory picker). Grounded in the `IPlatformService.selectDirectory` method
/// (the workspace-open flow): slice 5 added the file picker but not a folder picker. Uses the same
/// already-installed `tauri-plugin-dialog` (no new dependency) via `blocking_pick_folders()` (multi)
/// or `blocking_pick_folder()` (single), reusing the slice-5 `file_path_to_string` helper. Like the
/// file dialogs the command is `async`: Tauri runs it on a worker thread so the blocking native
/// picker never freezes the event loop. A single selection is normalized to a `Vec<String>` so the
/// result shape is uniform for `multiple` true/false; directory selection has no file-type filters.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the dialog extension.
/// * `multiple` - Whether the user may select more than one folder.
///
/// # Returns
///
/// `Ok(Some(paths))` for the chosen directories, `Ok(None)` when the user cancels, or `Err(String)`
/// if the native dialog cannot be shown. Cancellation is `None`, not an error.
#[tauri::command]
pub async fn select_directory(
    app: AppHandle,
    multiple: bool,
) -> Result<Option<Vec<String>>, String> {
    let builder = app.dialog().file();
    let picked = if multiple {
        builder.blocking_pick_folders()
    } else {
        builder.blocking_pick_folder().map(|p| vec![p])
    };
    Ok(picked.map(|paths| {
        paths
            .iter()
            .map(file_path_to_string)
            .collect::<Vec<String>>()
    }))
}

/// Show a native save-file dialog and return the chosen path, or `None` on cancel.
///
/// Uses `app.dialog().file().blocking_save_file()`, bridged the same way as [`show_open_dialog`]
/// (worker-thread blocking, native picker on the main thread). When `default_path` is provided it is
/// split into a suggested directory and file name via [`split_default_path`].
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the dialog extension.
/// * `default_path` - Optional path suggested as the initial save target.
///
/// # Returns
///
/// `Ok(Some(path))` for the chosen save target, `Ok(None)` on cancel, or `Err(String)` if the native
/// dialog cannot be shown.
#[tauri::command]
pub async fn show_save_dialog(
    app: AppHandle,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file();
    if let Some(path) = default_path.as_deref() {
        let (directory, file_name) = split_default_path(std::path::Path::new(path));
        if let Some(dir) = directory {
            builder = builder.set_directory(std::path::PathBuf::from(dir));
        }
        if let Some(name) = file_name {
            builder = builder.set_file_name(name);
        }
    }

    Ok(builder
        .blocking_save_file()
        .as_ref()
        .map(file_path_to_string))
}

/// Show a native modal message dialog and return whether the user confirmed.
///
/// Uses `app.dialog().message(..).blocking_show()`, bridged the same way as the file dialogs. The
/// dialog is presented with `YesNo` buttons so the boolean result is meaningful: the plugin's
/// `blocking_show` returns `true` for the affirmative (Yes/Ok) button and `false` otherwise. The
/// `kind` string selects the icon via [`parse_message_kind`] (unknown kinds default to info).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the dialog extension.
/// * `kind` - Dialog severity: `"info"`, `"warning"` or `"error"`.
/// * `title` - Window/dialog title.
/// * `message` - Primary message text.
///
/// # Returns
///
/// `Ok(true)` when the user confirms (Yes), `Ok(false)` when they decline (No), or `Err(String)` if
/// the native dialog cannot be shown.
#[tauri::command]
pub async fn show_message_dialog(
    app: AppHandle,
    kind: String,
    title: String,
    message: String,
) -> Result<bool, String> {
    let confirmed = app
        .dialog()
        .message(message)
        .title(title)
        .kind(parse_message_kind(&kind))
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show();
    Ok(confirmed)
}

/// Open a URL in the system's default browser via `tauri-plugin-opener`.
///
/// Phase 2 slice 6 (shell/open). Delegates to the plugin's real OS handler
/// (`app.opener().open_url(..)`); the `with` argument selects a specific application and is left
/// unset (`None`) so the platform default browser is used. The plugin's `Err` is converted to
/// `Err(String)` via `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript
/// side as a rejected `Promise`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the opener extension.
/// * `url` - The URL to open (scheme allow-listing is a documented P2 hardening item, not here).
///
/// # Returns
///
/// `Ok(())` when the OS launched a handler, or `Err(String)` describing why it could not.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Reveal a filesystem path in the OS file manager via `tauri-plugin-opener`.
///
/// Phase 2 slice 6. Maps to Electron's `shell.showItemInFolder`. Delegates to the plugin's real
/// handler `app.opener().reveal_item_in_dir(&path)`, which canonicalizes the path and opens the
/// enclosing directory with the item selected. The `Err` becomes a rejected `Promise` on the
/// TypeScript side.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the opener extension.
/// * `path` - The file or directory path to reveal.
///
/// # Returns
///
/// `Ok(())` when the file manager opened, or `Err(String)` describing why it could not.
#[tauri::command]
pub fn reveal_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

/// Open a file or directory with its default application via `tauri-plugin-opener`.
///
/// Phase 2 slice 6. Maps to Electron's `shell.openPath`. Delegates to the plugin's real handler
/// `app.opener().open_path(&path, None)`; the `with` argument (a specific opener app) is left unset
/// so the OS default is used. The `Err` becomes a rejected `Promise` on the TypeScript side.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the opener extension.
/// * `path` - The filesystem path to open.
///
/// # Returns
///
/// `Ok(())` when the default app launched, or `Err(String)` describing why it could not.
#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Show a native OS notification with the given `title` and `body` via `tauri-plugin-notification`.
///
/// Phase 2 slice 7 (native notifications). Delegates to the plugin's real builder API
/// `app.notification().builder().title(..).body(..).show()`, which dispatches an OS notification
/// (Linux/libnotify, macOS User Notifications, Windows toast). The plugin's `show()` returns
/// `Result<(), tauri_plugin_notification::Error>`; the `Err` is converted to `Err(String)` via
/// `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript side as a
/// rejected `Promise`. Not unit-tested: delivering a notification requires a live desktop session
/// and OS notification daemon, which a pure test harness cannot provide; faking one would violate
/// the no-stub rule. The command is compile-verified here and exercised at runtime under
/// `pnpm dev:tauri` (a real window and granted OS permission are required).
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the notification extension.
/// * `title` - Notification title shown by the OS.
/// * `body` - Notification body text shown by the OS.
///
/// # Returns
///
/// `Ok(())` when the notification was dispatched, or `Err(String)` describing why it could not.
#[tauri::command]
pub fn show_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}

/// Task-notification dedupe window (ms). Identical to `desktopNotifications.ts:6`
/// `TASK_NOTIFICATION_DEDUPE_WINDOW_MS`; two identical notifications inside this span collapse to one.
const TASK_NOTIFICATION_DEDUPE_WINDOW_MS: u64 = 3000;

/// Choose the dedupe TARGET for a task notification. `permission_request` and `elicitation_request`
/// each represent a distinct human-in-the-loop prompt, so consecutive prompts for the SAME task must
/// NOT collapse — they dedupe by `requestId` (trimmed, falling back to `taskId` when absent/blank);
/// every other status dedupes by `taskId`. Mirrors `desktopNotifications.ts:32-35`.
///
/// # Arguments
///
/// * `status` - The notification status tag.
/// * `task_id` - The owning task id.
/// * `request_id` - Optional request id (only meaningful for the two blocking-request statuses).
///
/// # Returns
///
/// The string used to build the dedupe key.
pub fn notification_dedupe_target<'a>(
    status: &str,
    task_id: &'a str,
    request_id: Option<&'a str>,
) -> &'a str {
    if status == "permission_request" || status == "elicitation_request" {
        request_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(task_id)
    } else {
        task_id
    }
}

/// Build the dedupe map key `{status}:{target}`, mirroring `desktopNotifications.ts:36`.
pub fn notification_dedupe_key(status: &str, target: &str) -> String {
    format!("{status}:{target}")
}

/// Decide whether a notification is a duplicate within the dedupe window, mutating the recent-seen map.
/// Prunes entries older than the window, suppresses (`true`) when the same key was seen < window ago,
/// otherwise records `now_ms` for `key` and allows (`false`). Pure (the clock is passed in) so the
/// 3-second boundary is unit-tested. Mirrors `desktopNotifications.ts:17-44`.
///
/// # Arguments
///
/// * `recent` - The mutable dedupe map (key -> last-seen epoch millis).
/// * `key` - The dedupe key for this notification.
/// * `now_ms` - Current wall-clock milliseconds since the UNIX epoch.
///
/// # Returns
///
/// `true` if the notification should be suppressed as a duplicate, else `false`.
pub fn should_suppress_task_notification(
    recent: &mut HashMap<String, u64>,
    key: &str,
    now_ms: u64,
) -> bool {
    recent.retain(|_, ts| now_ms.saturating_sub(*ts) <= TASK_NOTIFICATION_DEDUPE_WINDOW_MS);
    if let Some(last) = recent.get(key) {
        if now_ms.saturating_sub(*last) < TASK_NOTIFICATION_DEDUPE_WINDOW_MS {
            return true;
        }
    }
    recent.insert(key.to_string(), now_ms);
    false
}

/// Wall-clock milliseconds since the UNIX epoch, saturating to `0` if the system clock predates it
/// (never panics). Used by [`show_task_notification`]'s dedupe.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Per-notification dedupe state (key -> last-shown epoch millis), mirroring the module-level
/// `recentTaskNotificationTimestamps` in `desktopNotifications.ts:8`. Stored in Tauri managed state;
/// `Mutex<HashMap<String,u64>>` is `Send + Sync` (the managed-state bound), same pattern as
/// [`SidecarRegistry`] and [`ZoomRegistry`].
#[derive(Default)]
pub struct NotificationDedupeRegistry(Mutex<HashMap<String, u64>>);

/// Show a task notification through Electron's dispatch POLICY, via `tauri-plugin-notification`.
///
/// Phase 3 slice 38. The existing [`show_notification`] dispatches unconditionally; Electron's
/// `dispatchTaskNotification` first runs three suppressions that the naive command lacks, so the
/// Tauri shell would over-notify: (1) an empty title/body means the renderer failed to supply
/// localized copy — main has no i18n context so it must REFUSE, not hard-code fallback text
/// (`desktopNotifications.ts:106-116`); (2) suppress while ANY app window is focused — the user is
/// already looking at the app (`desktopNotifications.ts:99-101`); (3) a 3-second dedupe window
/// (`desktopNotifications.ts:118`, pure logic unit-tested here). Suppressed cases return `Ok(())` with
/// no notification, matching the interface's `showTaskNotification(): void` (the caller never awaits a
/// result; suppression is not an error).
///
/// Documented residuals (evidence-based, not silent stubs): (a) Electron's `.silent(true)` + the
/// `TaskNotificationSound` send to the originating window are omitted — `tauri-plugin-notification`
/// 2.5.1's desktop builder has no per-notification silent control and the sound is an internal channel
/// with no ported renderer consumer yet; (b) the click-to-jump routing (`onTaskNotificationClick`) is
/// NOT portable on Tauri desktop — `desktop.rs:31` states action options are ignored on desktop and
/// the Linux `notify-rust` backend delivers no click callback. Both are recorded for the GO-NO-GO
/// decision. Requires a live desktop session + granted OS notification permission, so the command is
/// compile-verified here and exercised under `pnpm dev:tauri`; only the pure policy is unit-tested.
///
/// # Arguments
///
/// * `app` - The Tauri application handle (window registry, notification extension, dedupe state).
/// * `task_id` - The owning task id (dedupe fallback key and would-be click target).
/// * `status` - Notification status tag.
/// * `title` - Localized notification title; blank suppresses.
/// * `body` - Localized notification body; blank suppresses.
/// * `request_id` - Optional request id, used instead of `task_id` for the blocking-request statuses.
///
/// # Returns
///
/// `Ok(())` when shown OR deliberately suppressed; `Err(String)` only when the OS rejected the
/// notification dispatch.
#[tauri::command]
pub fn show_task_notification(
    app: AppHandle,
    task_id: String,
    status: String,
    title: String,
    body: String,
    request_id: Option<String>,
) -> Result<(), String> {
    if title.trim().is_empty() || body.trim().is_empty() {
        return Ok(());
    }
    if app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false))
    {
        return Ok(());
    }
    let key = notification_dedupe_key(
        &status,
        notification_dedupe_target(&status, &task_id, request_id.as_deref()),
    );
    let registry = app.state::<NotificationDedupeRegistry>();
    let mut recent = registry
        .0
        .lock()
        .map_err(|e| format!("notification dedupe lock poisoned: {e}"))?;
    if should_suppress_task_notification(&mut recent, &key, now_millis()) {
        return Ok(());
    }
    drop(recent);
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}

/// Registry of live sidecar child processes, keyed by their OS pid.
///
/// Phase 2 slice 20 (sidecar lifecycle). Electron's `utilityProcess` is auto-killed when the main
/// process exits; a Tauri sidecar is NOT, so a spawned `CommandChild` must be retained and explicitly
/// terminated or it orphans (PORTING.md Phase-6 process-lifecycle trap). Stored in Tauri managed
/// state. `CommandChild` is `Send` but not `Sync` (it owns a stdin pipe handle), so wrapping it in a
/// `Mutex<HashMap<..>>` makes the whole struct `Send + Sync` — the managed-state bound. Keyed by pid
/// because [`kill_sidecar`] must take ownership back out of the map to call the consuming
/// `CommandChild::kill(self)`.
#[derive(Default)]
pub struct SidecarRegistry(Mutex<HashMap<u32, CommandChild>>);

/// Spawn the trivial `zcode-echo` sidecar so the renderer can drive a loopback WebSocket round-trip.
///
/// Part of the sidecar-runtime PoC (see `../tauri-port/SIDECAR-PACKAGING.md` §4 and §7). Resolves the
/// bundled externalBin by its **stem** (`zcode-echo`; Tauri appends the current Rust target triple and
/// the OS `.exe` suffix itself), injects the loopback port via the `ZCODE_WS_PORT` environment variable
/// (so the sidecar binds a port Rust and the renderer both know — the "fixed port" handoff in
/// SIDECAR-PACKAGING.md §6), launches it, and **retains** the resulting `CommandChild` in the
/// [`SidecarRegistry`] managed state so it can later be terminated by [`kill_sidecar`]. The event
/// `Receiver` returned by `spawn` is still dropped deliberately: this PoC does not route the sidecar's
/// stdout through the logger (documented follow-up), but lifecycle kill is now wired.
///
/// Runtime behaviour of the sidecar (its WS echo round-trip) is UNVERIFIED here: a headless CI box has
/// no desktop window to invoke this command from. It is compile-verified and exercised manually under
/// `pnpm dev:tauri` (see SIDECAR-PACKAGING.md §7); the standalone echo binary's own WS round-trip is
/// proven out-of-band by `tauri-port/sidecar/build.sh` + a direct `node` run.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the shell extension and managed state.
/// * `port` - The loopback TCP port to hand to the sidecar via `ZCODE_WS_PORT`.
///
/// # Returns
///
/// `Ok(u32)` with the OS pid of the launched (and now-registered) sidecar, or `Err(String)` if the
/// sidecar could not be resolved (missing/wrongly-named externalBin), the OS refused to spawn it, or
/// the registry lock was poisoned. Each error is converted with `.map_err` (never `.unwrap()`),
/// surfacing as a rejected `Promise`.
#[tauri::command]
pub fn spawn_sidecar_echo(app: AppHandle, port: u16) -> Result<u32, String> {
    let (_rx, child) = app
        .shell()
        .sidecar("zcode-echo")
        .map_err(|e| e.to_string())?
        .env("ZCODE_WS_PORT", port.to_string())
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.pid();
    let registry = app.state::<SidecarRegistry>();
    registry
        .0
        .lock()
        .map_err(|e| format!("sidecar registry lock poisoned: {e}"))?
        .insert(pid, child);
    Ok(pid)
}

/// Parse the sidecar's stdout ready-handshake line for the TCP port it actually bound.
///
/// Phase 2 slice 31 (dynamic-port discovery). The `zcode-echo` sidecar binds an OS-ephemeral port when
/// given `ZCODE_WS_PORT=0` and prints `ZCODE_WS_READY <port> has_secret=<bool>` on stdout (see
/// `SIDECAR-PACKAGING.md` §6 "print ready port"). Because the port is chosen by the OS, the renderer
/// cannot learn it from the spawn-time env — it MUST read the emitted line. This is the pure,
/// unit-testable parse: split on whitespace, require the `ZCODE_WS_READY` tag, then parse the next
/// token as the bound port, ignoring the trailing fields. Returns `None` for any non-ready line
/// (e.g. incidental stdout) so the reader can keep looping until the handshake arrives.
///
/// # Arguments
///
/// * `line` - One stdout line from the sidecar.
///
/// # Returns
///
/// `Some(port)` when `line` is a valid ready handshake, otherwise `None`.
pub fn parse_ready_port(line: &str) -> Option<u32> {
    let mut tokens = line.split_whitespace();
    if tokens.next()? == "ZCODE_WS_READY" {
        tokens.next()?.parse::<u32>().ok()
    } else {
        None
    }
}

/// Launch the `zcode-echo` sidecar on an OS-chosen ephemeral port and return that port.
///
/// Phase 2 slice 31 (dynamic-port discovery) — the transport building block the fixed-port
/// [`spawn_sidecar_echo`] cannot provide for concurrent agent instances. Injects `ZCODE_WS_PORT=0` so
/// the sidecar binds a free port, retains the `CommandChild` in the [`SidecarRegistry`] (slice-20
/// lifecycle), then consumes the previously-dropped `Receiver`: it awaits stdout events until a line
/// yields `Some(port)` via [`parse_ready_port`], and returns that port to the renderer. On a plugin
/// `Error` event or process `Terminated` before the handshake it returns `Err` (never hangs on a crash
/// or stdout close). The echo prints the ready line immediately on listening, so in the happy path the
/// await resolves promptly; a bounded readiness timeout is a documented production hardening (not added
/// here to avoid masking a genuine handshake failure — PORTING.md). Errors use `.map_err`/explicit
/// `Err` (never `.unwrap()`). Requires a live app + built externalBin, so it is compile-verified and
/// exercised under `pnpm dev:tauri`; the parse logic is unit-tested via [`parse_ready_port`].
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the shell extension and [`SidecarRegistry`].
///
/// # Returns
///
/// `Ok(u32)` with the ephemeral port the sidecar bound, or `Err(String)` if spawn failed, the child
/// errored/terminated before reporting ready, stdout closed, or the registry lock poisoned.
#[tauri::command]
pub async fn spawn_sidecar_echo_discover_port(app: AppHandle) -> Result<u32, String> {
    let (mut rx, child) = app
        .shell()
        .sidecar("zcode-echo")
        .map_err(|e| e.to_string())?
        .env("ZCODE_WS_PORT", "0")
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.pid();
    app.state::<SidecarRegistry>()
        .0
        .lock()
        .map_err(|e| format!("sidecar registry lock poisoned: {e}"))?
        .insert(pid, child);
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                if let Ok(line) = String::from_utf8(bytes) {
                    if let Some(port) = parse_ready_port(&line) {
                        return Ok(port);
                    }
                }
            }
            CommandEvent::Error(e) => return Err(format!("sidecar error before ready: {e}")),
            CommandEvent::Terminated(_) => {
                return Err("sidecar terminated before reporting ready".to_string());
            }
            // `CommandEvent` is #[non_exhaustive]: ignore Stderr and any future variant while we
            // wait for the ready line.
            _ => {}
        }
    }
    Err("sidecar stdout closed before reporting ready".to_string())
}

/// Terminate a previously-spawned sidecar by its OS pid.
///
/// Phase 2 slice 20 (sidecar lifecycle). Removes the `CommandChild` from the [`SidecarRegistry`]
/// managed state and calls its consuming `kill(self)`, so the externalBin process is explicitly
/// reaped. sidecar 不会随主进程自动回收(不同于 Electron 的 utilityProcess)，必须显式终止，否则残留孤儿进程——
/// 这正是 PORTING.md Phase-6 记录的进程生命周期陷阱。
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the managed [`SidecarRegistry`].
/// * `pid` - The OS pid returned by [`spawn_sidecar_echo`].
///
/// # Returns
///
/// `Ok(())` when the child was found and killed, or `Err(String)` when the pid is not registered
/// (already killed or never spawned), the registry lock was poisoned, or the OS refused to kill it.
/// Never `.unwrap()`s; each error surfaces as a rejected `Promise`.
#[tauri::command]
pub fn kill_sidecar(app: AppHandle, pid: u32) -> Result<(), String> {
    let registry = app.state::<SidecarRegistry>();
    let mut map = registry
        .0
        .lock()
        .map_err(|e| format!("sidecar registry lock poisoned: {e}"))?;
    let child = map
        .remove(&pid)
        .ok_or_else(|| format!("no such sidecar: {pid}"))?;
    child.kill().map_err(|e| e.to_string())
}

/// Read the current text content of the OS clipboard via `tauri-plugin-clipboard-manager`.
///
/// Phase 2 slice 8 (clipboard). Delegates to the plugin's real OS handler
/// `app.clipboard().read_text()`, which returns the clipboard's plain-text content (or an empty
/// string when the clipboard holds no text). The plugin's `Err` is converted to `Err(String)` via
/// `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing on the TypeScript side as a rejected
/// `Promise`. Not unit-tested: reading the clipboard requires a live desktop session and OS clipboard,
/// which a pure test harness cannot provide; faking one would violate the no-stub rule. The command
/// is compile-verified here and exercised at runtime under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the clipboard extension.
///
/// # Returns
///
/// `Ok(String)` with the clipboard's text content, or `Err(String)` describing why the OS clipboard
/// could not be read.
#[tauri::command]
pub fn read_clipboard_text(app: AppHandle) -> Result<String, String> {
    app.clipboard().read_text().map_err(|e| e.to_string())
}

/// Write text content to the OS clipboard via `tauri-plugin-clipboard-manager`.
///
/// Phase 2 slice 8. Delegates to the plugin's real handler `app.clipboard().write_text(text)`, which
/// replaces the clipboard's plain-text content. `write_text` accepts anything implementing
/// `Into<Cow<str>>`, so the owned `String` from the renderer is moved in without an extra clone. The
/// plugin's `Err` is converted to `Err(String)` via `.map_err(|e| e.to_string())` (never
/// `.unwrap()`), surfacing on the TypeScript side as a rejected `Promise`. Not unit-tested for the
/// same live-session reason as [`read_clipboard_text`].
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the clipboard extension.
/// * `text` - The text to place on the clipboard.
///
/// # Returns
///
/// `Ok(())` when the clipboard was updated, or `Err(String)` describing why the OS clipboard could
/// not be written.
#[tauri::command]
pub fn write_clipboard_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// The `{dataBaseDir}/.zcode/tmp/paste-attachments/{YYYY-MM-DD}` subtree the temp-text attachment
/// writer creates under, mirroring `tempTextAttachment.ts:10` `TEMP_TEXT_ATTACHMENT_DIR` and the
/// `join(getZCodeDataRootDir(), "tmp", ...)` structure (`paths.ts:22,44`).
const TEMP_TEXT_ATTACHMENT_SUBDIR: &str = ".zcode/tmp/paste-attachments";

/// Convert days-since-UNIX-epoch to a proleptic-Gregorian `(year, month, day)`.
///
/// Implements Howard Hinnant's integer `civil_from_days` (no date crate). `epoch == 0` at `1970-01-01`;
/// months Jan/Feb belong to the previous year in the era decomposition, hence the `+1` year fix.
/// Pure and unit-tested (`days=0 -> (1970,1,1)`, `days=59 -> (1970,3,1)`).
///
/// # Arguments
///
/// * `days` - Whole days since 1970-01-01 (may be negative for pre-epoch dates).
///
/// # Returns
///
/// The `(year, month, day)` triple in proleptic-Gregorian form.
fn ymd_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // day-of-era [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // year-of-era [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day-of-year [0, 365]
    let mp = (5 * doy + 2) / 153; // month-position [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // day [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // month [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Build the `YYYY-MM-DD` date subdirectory for a temp attachment from an epoch-millisecond stamp
/// (mirrors `tempTextAttachment.ts:20-21`). Uses UTC; Electron uses the host-local date — a documented
/// platform adaptation, since the bucket only tidies files and the returned `localPath` is absolute.
fn temp_attachment_date_dir(epoch_ms: u64) -> String {
    let days = (epoch_ms / 1_000).div_euclid(86_400) as i64;
    let (y, m, d) = ymd_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Generate an 8-hex-char collision-avoidance suffix, the dependency-free analog of
/// `randomUUID().slice(0, 8)` (`tempTextAttachment.ts:42`). Mixes sub-second nanos with a process
/// counter and pid so successive same-instant calls differ; the `create_new` write flag still rejects
/// the astronomically rare true collision.
fn temp_attachment_suffix() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos() as u64);
    let pid = std::process::id() as u64;
    let mixed = (nanos ^ count.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (pid << 16)) as u32;
    format!("{mixed:08x}")
}

/// Turn a caller-supplied (or absent) filename into the on-disk name, mirroring
/// `buildTempTextAttachmentFilename` (`tempTextAttachment.ts:38-48`): default `pasted-text.txt`; strip
/// NUL and path separators `\\ / :` (the path-traversal guard, replaced with `-`); force a `.txt`
/// extension; insert the unique suffix before the extension (or append `-suffix.txt` when there is no
/// usable dot, e.g. a leading-dot name).
///
/// # Arguments
///
/// * `raw` - Optional caller filename; trimmed, treated as absent when empty.
/// * `suffix` - The 8-hex collision suffix to embed.
///
/// # Returns
///
/// The sanitized `name-suffix.txt` string.
fn build_temp_text_attachment_filename(raw: Option<&str>, suffix: &str) -> String {
    let raw_base = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("pasted-text.txt");
    let normalized = raw_base.replace('\0', "-").replace(['\\', '/', ':'], "-");
    let safe_name = if normalized.ends_with(".txt") {
        normalized
    } else {
        format!("{normalized}.txt")
    };
    match safe_name.rfind('.') {
        Some(0) | None => format!("{safe_name}-{suffix}.txt"),
        Some(dot) => format!("{}-{}{}", &safe_name[..dot], suffix, &safe_name[dot..]),
    }
}

/// Serializable result for [`create_temp_text_attachment`]. `#[serde(rename_all = "camelCase")]` is
/// REQUIRED so the keys match `CreateTempTextAttachmentResult` (`localPath`, `mimeType`, `sizeBytes`) —
/// Tauri camelCases command ARGS automatically but NOT return-struct fields (see the PlatformInfo note
/// at the slice-3 serde doc).
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TempTextAttachmentResult {
    filename: String,
    local_path: String,
    mime_type: &'static str,
    size_bytes: u64,
}

/// Write `text` as a temp attachment under `base_dir/.zcode/tmp/paste-attachments/{date_dir}`,
/// returning the absolute path + metadata. Faithful to `createTempTextAttachment`
/// (`tempTextAttachment.ts:22-35`): recursive-mkdir, then a `create_new` (Electron `wx`) write so an
/// existing path errors rather than clobbers. Split from [`create_temp_text_attachment`] (which only
/// resolves the base dir + clock) so this fs logic is unit-testable against a temp dir without env
/// or global-state races — `base_dir`/`date_dir`/`suffix` are injected.
///
/// # Arguments
///
/// * `base_dir` - The data-root base directory (`home` or `ZCODE_DATA_BASE_DIR`).
/// * `date_dir` - The `YYYY-MM-DD` bucket.
/// * `text` - Non-empty UTF-8 content.
/// * `raw_filename` - Optional caller filename.
/// * `suffix` - Collision-avoidance suffix.
///
/// # Returns
///
/// `Ok(TempTextAttachmentResult)` or `Err(String)` describing the fs failure.
fn write_temp_text_attachment(
    base_dir: &std::path::Path,
    date_dir: &str,
    text: &str,
    raw_filename: Option<&str>,
    suffix: &str,
) -> Result<TempTextAttachmentResult, String> {
    let dir = base_dir.join(TEMP_TEXT_ATTACHMENT_SUBDIR).join(date_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let filename = build_temp_text_attachment_filename(raw_filename, suffix);
    let path = dir.join(&filename);
    let bytes = text.as_bytes();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut file, bytes).map_err(|e| e.to_string())?;
    Ok(TempTextAttachmentResult {
        local_path: path.to_string_lossy().into_owned(),
        size_bytes: bytes.len() as u64,
        mime_type: "text/plain",
        filename,
    })
}

/// Create a temp text attachment from renderer-pasted content, mirroring Electron's
/// `createTempTextAttachment` (host-side write so large pasted text never rides the prompt payload).
///
/// Phase 3 slice 40. Resolves the data base dir exactly like `paths.ts:getDataBaseDir`
/// (env `ZCODE_DATA_BASE_DIR` else the home dir), then delegates to [`write_temp_text_attachment`].
/// The empty-text guard rejects like Electron's thrown error (`tempTextAttachment.ts:16-18`). Residual:
/// the services in-process `setDataBaseDir()` override is a singleton absent from this shell, so only
/// the env + home fallbacks are honored (matches Electron's default-at-startup path); and the date
/// bucket is UTC vs Electron's local date — both documented, non-behavioral for the returned absolute
/// `localPath`. Requires a writable data dir (present at runtime); the pure helpers + the injected
/// writer are unit-tested here, and delivery is exercised under `pnpm dev:tauri`.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the home-path resolver.
/// * `text` - The attachment content; must be non-empty.
/// * `filename` - Optional base filename (sanitized server-side).
///
/// # Returns
///
/// `Ok(TempTextAttachmentResult)` with `{ filename, localPath, mimeType, sizeBytes }`, or `Err(String)`.
#[tauri::command]
pub fn create_temp_text_attachment(
    app: AppHandle,
    text: String,
    filename: Option<String>,
) -> Result<TempTextAttachmentResult, String> {
    if text.is_empty() {
        return Err("Temporary text attachment content is empty".to_string());
    }
    let base_dir = match std::env::var("ZCODE_DATA_BASE_DIR") {
        Ok(v) if !v.trim().is_empty() => std::path::PathBuf::from(v.trim()),
        _ => app
            .path()
            .resolve(std::ffi::OsStr::new(""), tauri::path::BaseDirectory::Home)
            .map_err(|e| e.to_string())?,
    };
    write_temp_text_attachment(
        &base_dir,
        &temp_attachment_date_dir(now_millis()),
        &text,
        filename.as_deref(),
        &temp_attachment_suffix(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_falls_back_when_unavailable() {
        // Arrange
        let raw = None;

        // Act
        let result = locale_or_default(raw);

        // Assert
        assert_eq!(result, FALLBACK_LOCALE);
    }

    #[test]
    fn locale_passes_through_when_available() {
        // Arrange
        let raw = Some("de-DE".to_string());

        // Act
        let result = locale_or_default(raw);

        // Assert
        assert_eq!(result, "de-DE");
    }

    #[test]
    fn device_id_returns_env_value_when_present() {
        // Arrange
        let raw = Some("device-abc-123".to_string());

        // Act
        let result = device_id_from_env(raw);

        // Assert
        assert_eq!(result, "device-abc-123");
    }

    #[test]
    fn device_id_is_empty_when_env_absent() {
        // Arrange
        let raw = None;

        // Act
        let result = device_id_from_env(raw);

        // Assert
        assert_eq!(result, "");
    }

    #[test]
    fn platform_info_carries_os_and_arch() {
        // Arrange
        let os = "linux";
        let arch = "x86_64";

        // Act
        let info = build_platform_info(os, arch);

        // Assert
        assert_eq!(info.os, "linux");
        assert_eq!(info.arch, "x86_64");
    }

    #[test]
    fn platform_info_matches_compile_time_consts() {
        // Act: the command wires `std::env::consts` through the pure helper.
        let info = get_platform_info();

        // Assert
        assert_eq!(info.os, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
    }

    #[test]
    fn directory_to_string_trims_trailing_separator() {
        // Arrange: Tauri's resolve appends an empty sub-path, yielding a trailing separator.
        let path = std::path::PathBuf::from("/home/user/Downloads/");

        // Act
        let result = directory_to_string(path);

        // Assert
        assert_eq!(result, "/home/user/Downloads");
    }

    #[test]
    fn directory_to_string_preserves_filesystem_root() {
        // Arrange
        let path = std::path::PathBuf::from("/");

        // Act
        let result = directory_to_string(path);

        // Assert
        assert_eq!(result, "/");
    }

    #[test]
    fn file_path_to_string_renders_path_variant() {
        // Arrange: a plain filesystem path picker result.
        let path = FilePath::Path(std::path::PathBuf::from("/home/user/report.pdf"));

        // Act
        let result = file_path_to_string(&path);

        // Assert
        assert_eq!(result, "/home/user/report.pdf");
    }

    #[test]
    fn parse_message_kind_maps_known_and_unknown_values() {
        // Act / Assert: recognized kinds map case-insensitively, everything else falls back to Info.
        assert!(matches!(
            parse_message_kind("warning"),
            MessageDialogKind::Warning
        ));
        assert!(matches!(
            parse_message_kind("ERROR"),
            MessageDialogKind::Error
        ));
        assert!(matches!(parse_message_kind(""), MessageDialogKind::Info));
        assert!(matches!(
            parse_message_kind("nonsense"),
            MessageDialogKind::Info
        ));
    }

    #[test]
    fn split_default_path_yields_directory_and_file_name() {
        // Arrange
        let path = std::path::Path::new("/home/user/output/report.txt");

        // Act
        let (dir, name) = split_default_path(path);

        // Assert
        assert_eq!(dir.as_deref(), Some("/home/user/output"));
        assert_eq!(name.as_deref(), Some("report.txt"));
    }

    #[test]
    fn window_size_carries_width_and_height() {
        // Arrange
        let (width, height) = (1280, 720);

        // Act
        let size = build_window_size(width, height);

        // Assert
        assert_eq!(size, WindowSize { width, height });
    }

    #[test]
    fn parse_theme_maps_known_and_unknown_values() {
        // Act / Assert: recognized themes map case-insensitively, everything else yields `None`
        // (which the command turns into an explicit `Err`, not a silent clear).
        assert!(matches!(parse_theme("light"), Some(tauri::Theme::Light)));
        assert!(matches!(parse_theme("DARK"), Some(tauri::Theme::Dark)));
        assert!(parse_theme("").is_none());
        assert!(parse_theme("nonsense").is_none());
    }

    #[test]
    fn split_default_path_handles_bare_file_name() {
        // Arrange: a path with only a file name has no parent directory to suggest.
        let path = std::path::Path::new("report.txt");

        // Act
        let (dir, name) = split_default_path(path);

        // Assert
        assert_eq!(dir, None);
        assert_eq!(name.as_deref(), Some("report.txt"));
    }

    #[test]
    fn zoom_level_to_factor_maps_known_levels() {
        // Act: level 0 is 100% (factor 1.0); level 1 is one Chromium step (factor 1.2).
        let zero = zoom_level_to_factor(0.0);
        let one = zoom_level_to_factor(1.0);

        // Assert: compare within a tight float epsilon for the powf conversion.
        assert!((zero - 1.0).abs() < 1e-12);
        assert!((one - 1.2).abs() < 1e-12);
    }

    #[test]
    fn zoom_factor_to_level_round_trips_and_matches_known_value() {
        // Act: an inverse composition recovers the original level despite float drift.
        let round_trip = zoom_factor_to_level(zoom_level_to_factor(3.0));
        // A known Chromium data point: factor 1.5 corresponds to ln(1.5)/ln(1.2).
        let known_level = zoom_factor_to_level(1.5);

        // Assert
        assert!((round_trip - 3.0).abs() < 1e-9);
        assert!((known_level - (1.5_f64.ln() / 1.2_f64.ln())).abs() < 1e-12);
    }

    #[test]
    fn parse_ready_port_extracts_port_from_ready_line() {
        // Arrange / Act / Assert: the real handshake format (with the trailing has_secret field).
        assert_eq!(
            parse_ready_port("ZCODE_WS_READY 41234 has_secret=false"),
            Some(41234)
        );
        assert_eq!(
            parse_ready_port("ZCODE_WS_READY 0 has_secret=true"),
            Some(0)
        );
    }

    #[test]
    fn parse_ready_port_is_none_for_non_ready_or_malformed_lines() {
        // The reader loops until a real handshake, so any other line must yield None (not panic).
        assert_eq!(parse_ready_port("some incidental stdout"), None);
        assert_eq!(parse_ready_port(""), None);
        assert_eq!(parse_ready_port("ZCODE_WS_READY"), None);
        assert_eq!(parse_ready_port("ZCODE_WS_READY notanumber"), None);
    }

    #[test]
    fn zoom_changed_payload_has_camelcase_zoomlevel_key() {
        // The renderer reads the payload as `DesktopZoomState` (`{ zoomLevel: number }`); a key
        // drift here would silently hand it a wrong-shaped object, so pin the exact shape.
        let payload = zoom_changed_payload(3.0);
        let obj = payload
            .as_object()
            .expect("zoom-changed payload must be a JSON object");
        // Exactly one field, named in camelCase (not snake_case).
        assert_eq!(obj.len(), 1);
        assert_eq!(obj.get("zoomLevel"), Some(&serde_json::json!(3.0)));
        assert!(obj.get("zoom_level").is_none());
    }

    #[test]
    fn fullscreen_changed_payload_is_a_bare_boolean() {
        // The interface arg is `(isFullscreen: boolean)`, NOT an object; a5 pins the event name but not
        // this body, so assert the payload is a bare JSON bool equal to the input on both transitions.
        assert_eq!(fullscreen_changed_payload(true), serde_json::json!(true));
        assert_eq!(fullscreen_changed_payload(false), serde_json::json!(false));
        assert!(fullscreen_changed_payload(true).is_boolean());
    }

    #[test]
    fn notification_dedupe_target_uses_request_id_only_for_blocking_requests() {
        // Blocking-request statuses must dedupe by requestId so consecutive prompts for the SAME
        // task are not collapsed; every other status dedupes by taskId. (desktopNotifications.ts:32)
        assert_eq!(
            notification_dedupe_target("permission_request", "task-1", Some("req-9")),
            "req-9"
        );
        assert_eq!(
            notification_dedupe_target("elicitation_request", "task-1", Some("  ")),
            "task-1",
            "a blank requestId must fall back to taskId"
        );
        assert_eq!(
            notification_dedupe_target("completed", "task-1", Some("req-9")),
            "task-1",
            "non-blocking statuses ignore requestId"
        );
    }

    #[test]
    fn notification_dedupe_key_formats_status_and_target() {
        assert_eq!(notification_dedupe_key("failed", "task-1"), "failed:task-1");
    }

    #[test]
    fn should_suppress_task_notification_collapses_within_window_only() {
        let mut recent: HashMap<String, u64> = HashMap::new();
        let key = "completed:task-1";
        // First occurrence is allowed and recorded.
        assert!(!should_suppress_task_notification(&mut recent, key, 1_000));
        // A second within 3000ms is suppressed.
        assert!(should_suppress_task_notification(&mut recent, key, 2_500));
        // Past the window it is allowed again (and the stale entry refreshed to the new timestamp).
        assert!(!should_suppress_task_notification(&mut recent, key, 4_001));
        // A different key seen later than the window also prunes the now-stale first entry, so the
        // map stays bounded (7500 - 4001 > 3000).
        assert!(!should_suppress_task_notification(
            &mut recent,
            "failed:task-2",
            7_500
        ));
        assert!(!recent.contains_key("completed:task-1"));
        assert!(recent.contains_key("failed:task-2"));
    }

    #[test]
    fn ymd_from_days_maps_known_epoch_days() {
        // epoch day 0 == 1970-01-01; day 59 == 1970-03-01 (crosses the non-leap Feb boundary, where
        // the era Jan/Feb year-fix must NOT apply).
        assert_eq!(ymd_from_days(0), (1970, 1, 1));
        assert_eq!(ymd_from_days(59), (1970, 3, 1));
        assert_eq!(ymd_from_days(60), (1970, 3, 2));
    }

    #[test]
    fn temp_attachment_date_dir_formats_utc_date() {
        // 1_704_067_200_000 ms == 2024-01-01T00:00:00Z -> "2024-01-01" (zero-padded).
        assert_eq!(temp_attachment_date_dir(1_704_067_200_000), "2024-01-01");
        assert_eq!(temp_attachment_date_dir(0), "1970-01-01");
    }

    #[test]
    fn build_temp_text_attachment_filename_sanitizes_and_inserts_suffix() {
        // Default name when absent: "pasted-text.txt" -> suffix inserted before the final dot.
        assert_eq!(
            build_temp_text_attachment_filename(None, "abcd1234"),
            "pasted-text-abcd1234.txt"
        );
        // Extension inserted before the final dot.
        assert_eq!(
            build_temp_text_attachment_filename(Some("report"), "abcd1234"),
            "report-abcd1234.txt"
        );
        assert_eq!(
            build_temp_text_attachment_filename(Some("a.txt"), "abcd1234"),
            "a-abcd1234.txt"
        );
        // Path separators + NUL are neutralized (the traversal guard), never appear in the output.
        let evil = build_temp_text_attachment_filename(Some("../../etc/passwd"), "abcd1234");
        assert!(!evil.contains('/') && !evil.contains('\\') && !evil.contains('\0'));
        assert!(evil.ends_with("-abcd1234.txt"));
        // A leading-dot name: "..txt" -> suffix inserted after the first dot (matches the JS slice math).
        assert_eq!(
            build_temp_text_attachment_filename(Some("."), "abcd1234"),
            ".-abcd1234.txt"
        );
    }

    #[test]
    fn write_temp_text_attachment_writes_bytes_under_the_date_dir() {
        // Real fs, but in a unique temp base with injected date+suffix -> deterministic, race-free.
        let base = std::env::temp_dir().join(format!("zcode-tta-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let result =
            write_temp_text_attachment(&base, "2024-01-01", "hello 世界", Some("note"), "cafe0000")
                .expect("write must succeed");
        assert_eq!(result.filename, "note-cafe0000.txt");
        assert_eq!(result.mime_type, "text/plain");
        // UTF-8 byte length: "hello " =6 + "世界" =6 bytes.
        assert_eq!(result.size_bytes, 12);
        let on_disk = std::fs::read_to_string(&result.local_path).expect("file exists");
        assert_eq!(on_disk, "hello 世界");
        assert!(result
            .local_path
            .ends_with(".zcode/tmp/paste-attachments/2024-01-01/note-cafe0000.txt"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
