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
// mapped through `monitor_to_info`.

use tauri::{AppHandle, Manager, WebviewWindow};
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
    let fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
    window
        .set_fullscreen(!fullscreen)
        .map_err(|e| e.to_string())
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
#[tauri::command]
pub fn set_fullscreen(app: AppHandle, label: String, fullscreen: bool) -> Result<(), String> {
    require_window(&app, &label)?
        .set_fullscreen(fullscreen)
        .map_err(|e| e.to_string())
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
// 该反向映射当前仅由 `set_zoom` 设置路径的单测覆盖；读取当前等级的 getter 留待 tauriPlatform
// 适配器（见 slice 13 偏差说明），故在二进制构建中暂无运行时调用者。
#[allow(dead_code)]
pub fn zoom_factor_to_level(factor: f64) -> f64 {
    factor.ln() / 1.2_f64.ln()
}

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
/// Deviation note (documented, not stubbed): Tauri 2.12.1 provides no zoom *getter*, so
/// `getDesktopZoomLevel` cannot read the live level through this seam. Reading it back requires the
/// `tauriPlatform` adapter to track the last-set level in managed state — that getter is deliberately
/// NOT implemented or faked here; only the setter path (which zoom-in/out/reset all funnel through)
/// ships in this slice.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the window registry.
/// * `label` - Target window label (the main window is `"main"`).
/// * `level` - Desired zoom level in Electron's logarithmic unit (`0.0` == 100%).
///
/// # Returns
///
/// `Ok(())` on success; `Err(String)` when the window is missing or the OS rejects the operation.
#[tauri::command]
pub fn set_desktop_zoom_level(app: AppHandle, label: String, level: f64) -> Result<(), String> {
    let factor = zoom_level_to_factor(level);
    require_window(&app, &label)?
        .set_zoom(factor)
        .map_err(|e| e.to_string())
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

/// Spawn the trivial `zcode-echo` sidecar so the renderer can drive a loopback WebSocket round-trip.
///
/// Part of the sidecar-runtime PoC (see `../tauri-port/SIDECAR-PACKAGING.md` §4 and §7). Resolves the
/// bundled externalBin by its **stem** (`zcode-echo`; Tauri appends the current Rust target triple and
/// the OS `.exe` suffix itself), injects the loopback port via the `ZCODE_WS_PORT` environment variable
/// (so the sidecar binds a port Rust and the renderer both know — the "fixed port" handoff in
/// SIDECAR-PACKAGING.md §6), and launches it. The event `Receiver` returned by `spawn` is dropped
/// deliberately: this PoC only proves spawn + env handoff + a live pid, and does not yet route the
/// sidecar's stdout through the logger or wire lifecycle kill (both documented follow-ups).
///
/// Runtime behaviour of the sidecar (its WS echo round-trip) is UNVERIFIED here: a headless CI box has
/// no desktop window to invoke this command from. It is compile-verified and exercised manually under
/// `pnpm dev:tauri` (see SIDECAR-PACKAGING.md §7); the standalone echo binary's own WS round-trip is
/// proven out-of-band by `tauri-port/sidecar/build.sh` + a direct `node` run.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the shell extension.
/// * `port` - The loopback TCP port to hand to the sidecar via `ZCODE_WS_PORT`.
///
/// # Returns
///
/// `Ok(u32)` with the OS pid of the launched sidecar, or `Err(String)` if the sidecar could not be
/// resolved (missing/wrongly-named externalBin) or the OS refused to spawn it. Each plugin `Err` is
/// converted with `.map_err(|e| e.to_string())` (never `.unwrap()`), surfacing as a rejected `Promise`.
#[tauri::command]
pub fn spawn_sidecar_echo(app: AppHandle, port: u16) -> Result<u32, String> {
    let (_rx, child) = app
        .shell()
        .sidecar("zcode-echo")
        .map_err(|e| e.to_string())?
        .env("ZCODE_WS_PORT", port.to_string())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(child.pid())
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
}
