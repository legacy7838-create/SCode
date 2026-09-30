//! Window surface commands — zoom, title, bounds.
//!
//! Replaces the window-chrome handlers in `packages/desktop/src/main`:
//!   * zoom: the level→factor model in `desktopZoom.ts:1-11`, the main-side
//!     apply path in `desktopCommandHandlers.ts:62-70` (`updateDesktopZoomLevel`
//!     → `webContents.setZoomFactor`), and the main-side read at
//!     `desktopMainIpcPlatform.ts:348-357` (`GetDesktopZoomLevel` resolves the
//!     factor from the sender's `BrowserWindow`, never from a payload);
//!   * bounds: `desktopWindowSize.ts` (the persisted `desktopWindowSize` setting);
//!   * title: Electron's `BrowserWindow` mirrored `document.title` into the OS
//!     window title by default (the prompt windows opt out with
//!     `page-title-updated` + `preventDefault`, `desktopCommandHandlers.ts:383`),
//!     with the creation-time title at `desktopWindowChrome.ts:573`. Here the
//!     platform layer sets it explicitly instead.
//!
//! ## Zoom is main-side state, not renderer state
//!
//! The Electron original deliberately read zoom on the main side because "the
//! zoom factor can only be read from the IPC-bound BrowserWindow, and the
//! renderer payload cannot be trusted"
//! (`browserView/desktopBrowserViewIpc.ts:162`), and `GetDesktopZoomLevel`
//! resolved the factor from `senderWindow.webContents.getZoomFactor()`
//! (`desktopMainIpcPlatform.ts:348-357`). That invariant survives the port:
//! every factor is clamped and stored in [`SurfaceState`] keyed by window
//! label, and the renderer's `factor` argument is treated as a request, never
//! as truth.
//!
//! Tauri's `WebviewWindow::set_zoom` has no getter counterpart, so the stored
//! value in [`SurfaceState`] is the *only* source of truth for reads —
//! `set_desktop_zoom` writes the map and the webview in one step, so a factor
//! the map does not know about cannot exist. Zoom is session-only: Electron
//! persisted `desktopZoomLevel` into `setting.json` at startup
//! (`main/index.ts:1928`), but the settings store is not part of this module.
//!
//! ## Bounds persistence: write-through, never debounced
//!
//! `desktopWindowSize.ts:8,66-81` debounced resize writes by 250ms and, as the
//! comment at `desktopWindowSize.ts:79-80` documents, `close` deliberately
//! cancelled any pending write to avoid stranding `setting.json.lock` — so a
//! resize in the last 250ms before close was silently dropped. Both bounds
//! commands here write their JSON file immediately and atomically
//! (write-then-rename), so there is no pending window to lose. The renderer
//! drives persistence by invoking on resize/maximize/unmaximize, replacing the
//! `win.on(...)` listeners in `desktopWindowSize.ts:74-81`.
//!
//! Coordinates on the wire are logical (device-independent) pixels, matching
//! Electron's `Rectangle`/`getNormalBounds` (`desktopWindowSize.ts:48`); Tauri
//! reports physical pixels, and the conversion happens in `read_live_bounds`.
//!
//! ## NO_NATIVE_EQUIV: dock/taskbar unread badge
//!
//! Electron aggregated per-window counts and called `app.setBadgeCount`
//! (`unreadBadge.ts:25-35`, `syncAppUnreadBadge`). Tauri v2 exposes no
//! `setBadgeCount` and no cross-platform dock/taskbar badge API, and faking it
//! with a tray-title or overlay would be a different feature — so this port has
//! deliberately **no `set_badge_count` command**. What survives instead:
//! `crate::commands::window::sync_window_unread_count` (`commands/window.rs:47`)
//! still records every window's count in `AppState` via `WindowState::unread_count`
//! (`app_state.rs:22`), and the renderer reads it back through `get_window_state`
//! for in-app display. The OS-level badge itself is `NO_NATIVE_EQUIV`.
//!
//! ## Wiring
//!
//! `lib.rs` must call `.manage(SurfaceState::default())` and list the five
//! commands below in `generate_handler!`. The `State` extractors panic at
//! invoke time if the `manage` call is missing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{LogicalPosition, LogicalSize, State, WebviewWindow};

use super::{require_registered_window, CommandError, CommandResult};
use crate::app_state::AppState;

/// Chromium clamps page zoom to `0.25..=5.0`; Electron's level range
/// (`-3..=5` with a 1.1 step, `desktopZoom.ts:1-3`) maps to factors
/// `≈0.75..=1.61`, comfortably inside it. Tauri passes `set_zoom` straight
/// through to the webview, so the clamp is enforced here instead.
pub const ZOOM_MIN_FACTOR: f64 = 0.25;
pub const ZOOM_MAX_FACTOR: f64 = 5.0;
/// The zoom of a window that has never been zoomed (and the fallback for a
/// non-finite request).
pub const ZOOM_DEFAULT_FACTOR: f64 = 1.0;

/// Minimum window size, mirroring `desktopWindowSize.ts:5-6`.
pub const MIN_DESKTOP_WINDOW_WIDTH: u32 = 480;
pub const MIN_DESKTOP_WINDOW_HEIGHT: u32 = 640;

/// Clamp a requested zoom factor into the range Chromium actually honours.
///
/// `NaN` has no meaningful position in the range and falls back to
/// [`ZOOM_DEFAULT_FACTOR`]; infinities saturate at the range ends.
pub fn clamp_zoom_factor(factor: f64) -> f64 {
    if factor.is_nan() {
        return ZOOM_DEFAULT_FACTOR;
    }
    // f64::clamp panics only on a bad range (constants, above) or a NaN input,
    // which is guarded; ±inf saturates to the bounds.
    factor.clamp(ZOOM_MIN_FACTOR, ZOOM_MAX_FACTOR)
}

/// Main-side zoom registry: window label → applied factor.
///
/// This is the Tauri replacement for Electron's main-side zoom reads — and the
/// only zoom source of truth, because `WebviewWindow::set_zoom` has no getter.
/// Keyed by window label like every other registry in `app_state.rs`, so the
/// Electron `win.id` vs `webContents.id` ambiguity cannot recur.
#[derive(Debug, Default)]
pub struct SurfaceState {
    zoom_by_window: Mutex<HashMap<String, f64>>,
}

impl SurfaceState {
    /// Record `factor` for `label`, clamped, and return the applied value.
    pub fn set_zoom(&self, label: &str, factor: f64) -> f64 {
        let factor = clamp_zoom_factor(factor);
        self.zoom_by_window
            .lock()
            .insert(label.to_string(), factor);
        factor
    }

    /// The last factor applied to `label`, or [`ZOOM_DEFAULT_FACTOR`] if none.
    pub fn zoom(&self, label: &str) -> f64 {
        self.zoom_by_window
            .lock()
            .get(label)
            .copied()
            .unwrap_or(ZOOM_DEFAULT_FACTOR)
    }
}

/// Persisted window geometry. Logical pixels, camelCase on the wire.
///
/// Supersedes Electron's `DesktopWindowSize` (`{width, height, maximized}`,
/// `desktopWindowSize.ts:10`) by also carrying position — Tauri has no
/// `getNormalBounds`, so the last persisted value doubles as the normal-bounds
/// cache while the window is maximized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl Default for WindowBounds {
    fn default() -> Self {
        // `desktopWindowSize.ts:4-5` — 1200×800, not maximized, position unset.
        Self { x: 0, y: 0, width: 1200, height: 800, maximized: false }
    }
}

impl WindowBounds {
    /// Enforce the persisted-size minimums, mirroring `clampDimension` in
    /// `desktopWindowSize.ts:14-20` (`resolveDesktopWindowSize` clamped the
    /// stored size before it was applied to a new window).
    fn clamp(self) -> Self {
        Self {
            width: self.width.max(MIN_DESKTOP_WINDOW_WIDTH),
            height: self.height.max(MIN_DESKTOP_WINDOW_HEIGHT),
            ..self
        }
    }
}

/// The configured data base dir: `ZCODE_DATA_BASE_DIR`, else `$HOME`, else `.`
/// — the same precedence as `Supervisor::new` (`supervisor/mod.rs:113-121`).
fn data_base_dir() -> PathBuf {
    std::env::var("ZCODE_DATA_BASE_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `<data base dir>/.zcode/v2/desktop-window-size.json`.
///
/// Electron funneled this through `settingService.update({desktopWindowSize})`
/// into `setting.json` (`main/index.ts:528`); the port writes a dedicated file
/// so the bounds path does not depend on the settings store's lock/queue — and
/// the 250ms-debounce/dropped-close-write bug documented in
/// `desktopWindowSize.ts:79-80` cannot recur. The `.zcode/v2` layout matches
/// the CLI (`credentials.json`, `telemetry-state.json`) and the README's
/// "`ZCODE_DATA_BASE_DIR` … data written under `.zcode/` within it".
pub fn window_bounds_file() -> PathBuf {
    data_base_dir().join(".zcode").join("v2").join("desktop-window-size.json")
}

/// Persist bounds immediately: `create_dir_all` + write to a sibling `.tmp` +
/// atomic rename. A crash mid-write leaves either the old file or the new one,
/// never torn JSON (Electron's `settingService` serialised atomic writes for
/// the same reason — see the note at `desktopWindowSize.ts:71`).
pub fn save_window_bounds(path: &Path, bounds: &WindowBounds) -> CommandResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| CommandError::Platform(format!("{}: {e}", dir.display())))?;
    }
    let json = serde_json::to_string_pretty(bounds)
        .map_err(|e| CommandError::Platform(format!("serialise window bounds: {e}")))?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, json.as_bytes())
        .map_err(|e| CommandError::Platform(format!("{}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| CommandError::Platform(format!("{}: {e}", path.display())))?;
    Ok(())
}

/// Read persisted bounds. Missing file or malformed JSON falls back to
/// [`WindowBounds::default`] — never a panic — and a successful read is clamped
/// to the minimum size so a hand-edited or pre-clamp file cannot restore an
/// unusable window (the `resolveDesktopWindowSize` clamp, `desktopWindowSize.ts:14-30`).
pub fn load_window_bounds(path: &Path) -> WindowBounds {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        // Missing or unreadable on the first run is the normal case.
        Err(_) => return WindowBounds::default(),
    };
    match serde_json::from_str::<WindowBounds>(&contents) {
        Ok(bounds) => bounds.clamp(),
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "malformed desktop window bounds; falling back to defaults"
            );
            WindowBounds::default()
        }
    }
}

/// Live geometry of `window` in logical pixels.
///
/// Uses `outer_position` + `inner_size` — exactly what `set_window_bounds`
/// applies (`set_position` takes the outer position, `set_size` the inner
/// size), so get→set round-trips precisely on the frameless window
/// (`window.rs` builds it with `decorations(false)`).
fn read_live_bounds(window: &WebviewWindow, maximized: bool) -> CommandResult<WindowBounds> {
    let scale = window.scale_factor().map_err(CommandError::from)?;
    let position = window.outer_position().map_err(CommandError::from)?.to_logical::<f64>(scale);
    let size = window.inner_size().map_err(CommandError::from)?.to_logical::<f64>(scale);
    Ok(WindowBounds {
        // Positions round (nearest DIP under fractional scale factors);
        // width/height floor, matching `Math.floor` in `persistCurrentState`
        // (`desktopWindowSize.ts:50-51`).
        x: position.x.round() as i32,
        y: position.y.round() as i32,
        width: size.width.floor() as u32,
        height: size.height.floor() as u32,
        maximized,
    })
}

/// Apply a zoom factor to the calling window.
///
/// The main-side replacement for `updateDesktopZoomLevel`
/// (`desktopCommandHandlers.ts:62-70`): the factor is clamped here, pushed to
/// the webview with `WebviewWindow::set_zoom`, and recorded in [`SurfaceState`]
/// — the map being the only zoom getter this port has.
#[tauri::command]
pub fn set_desktop_zoom(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    surface: State<'_, SurfaceState>,
    factor: f64,
) -> CommandResult<()> {
    require_registered_window(&app_state, window.label())?;
    let applied = clamp_zoom_factor(factor);
    window.set_zoom(applied).map_err(CommandError::from)?;
    surface.set_zoom(window.label(), applied);
    Ok(())
}

/// Read the calling window's current zoom factor.
///
/// The main-side replacement for `GetDesktopZoomLevel`
/// (`desktopMainIpcPlatform.ts:348-357`), which likewise derived the value
/// from the sender's window instead of trusting a renderer payload.
#[tauri::command]
pub fn get_desktop_zoom(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    surface: State<'_, SurfaceState>,
) -> CommandResult<f64> {
    require_registered_window(&app_state, window.label())?;
    Ok(surface.zoom(window.label()))
}

/// Set the OS window title for the calling window.
///
/// The target is derived from the injected `WebviewWindow`, never from a
/// payload field, so a caller cannot retitle a window it does not own.
#[tauri::command]
pub fn set_window_title(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    title: String,
) -> CommandResult<()> {
    require_registered_window(&app_state, window.label())?;
    window.set_title(&title).map_err(CommandError::from)?;
    Ok(())
}

/// Read the calling window's geometry, persisting it write-through.
///
/// While maximized, Tauri has no `getNormalBounds` equivalent: the live
/// geometry *is* the monitor workspace, and overwriting the persisted normal
/// bounds with it is precisely the corruption the Electron original guarded
/// against (`desktopWindowSize.ts:46-48`: "Always read normal bounds and save
/// maximized as a separate state"). So a maximized read serves the last
/// persisted normal geometry with `maximized: true` (flipping and persisting
/// the flag, as the `maximize` hook did at `desktopWindowSize.ts:79`);
/// with nothing persisted yet it reports the live work area but does not
/// write it.
#[tauri::command]
pub fn get_window_bounds(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
) -> CommandResult<WindowBounds> {
    require_registered_window(&app_state, window.label())?;
    let path = window_bounds_file();

    if window.is_maximized().map_err(CommandError::from)? {
        if path.exists() {
            let mut stored = load_window_bounds(&path);
            if !stored.maximized {
                // Flip and persist the flag (idempotent: only writes on the
                // transition), keeping the stored normal geometry untouched.
                stored.maximized = true;
                save_window_bounds(&path, &stored)?;
            }
            return Ok(stored);
        }
        return read_live_bounds(&window, true);
    }

    let live = read_live_bounds(&window, false)?;
    save_window_bounds(&path, &live)?;
    Ok(live)
}

/// Apply geometry to the calling window and persist it immediately.
///
/// Bounds are applied to the *normal* geometry: a maximized window is
/// unmaximized first (window managers ignore or corrupt `set_position`/
/// `set_size` on a maximized window — the Tauri counterpart of reading
/// `getNormalBounds` rather than maximized bounds in
/// `desktopWindowSize.ts:48`), then `bounds.maximized` is re-applied last.
/// The write is synchronous — there is no 250ms debounce whose pending entry
/// `close` could drop (`desktopWindowSize.ts:79-81`).
#[tauri::command]
pub fn set_window_bounds(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    bounds: WindowBounds,
) -> CommandResult<()> {
    require_registered_window(&app_state, window.label())?;
    let bounds = bounds.clamp();

    if window.is_maximized().map_err(CommandError::from)? {
        window.unmaximize().map_err(CommandError::from)?;
    }
    window
        .set_position(LogicalPosition::new(bounds.x as f64, bounds.y as f64))
        .map_err(CommandError::from)?;
    window
        .set_size(LogicalSize::new(bounds.width as f64, bounds.height as f64))
        .map_err(CommandError::from)?;
    if bounds.maximized {
        window.maximize().map_err(CommandError::from)?;
    }

    save_window_bounds(&window_bounds_file(), &bounds)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique per test (name + pid): the suite runs in one process, and env
    /// vars are off-limits here because they would race other tests.
    fn temp_bounds_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zcode-surface-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("nested").join("desktop-window-size.json")
    }

    fn cleanup(path: &Path) {
        if let Some(dir) = path.parent().and_then(|p| p.parent()) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn zoom_factor_clamped_to_electron_range() {
        // Below the range, at the edges, inside.
        assert_eq!(clamp_zoom_factor(0.01), ZOOM_MIN_FACTOR);
        assert_eq!(clamp_zoom_factor(-3.0), ZOOM_MIN_FACTOR);
        assert_eq!(clamp_zoom_factor(0.25), 0.25);
        assert_eq!(clamp_zoom_factor(1.5), 1.5);
        assert_eq!(clamp_zoom_factor(5.0), 5.0);
        // Above the range, and non-finite input.
        assert_eq!(clamp_zoom_factor(9.0), ZOOM_MAX_FACTOR);
        assert_eq!(clamp_zoom_factor(f64::INFINITY), ZOOM_MAX_FACTOR);
        assert_eq!(clamp_zoom_factor(f64::NEG_INFINITY), ZOOM_MIN_FACTOR);
        assert_eq!(clamp_zoom_factor(f64::NAN), ZOOM_DEFAULT_FACTOR);
    }

    #[test]
    fn zoom_state_is_per_window_and_clamped() {
        let state = SurfaceState::default();
        // A window never zoomed reports the default, not an error.
        assert_eq!(state.zoom("main"), ZOOM_DEFAULT_FACTOR);

        assert_eq!(state.set_zoom("main", 1.5), 1.5);
        state.set_zoom("other", 0.5);
        assert_eq!(state.zoom("main"), 1.5);
        assert_eq!(state.zoom("other"), 0.5);

        // Out-of-range requests store the clamped value, so reads stay truthful.
        assert_eq!(state.set_zoom("main", 99.0), ZOOM_MAX_FACTOR);
        assert_eq!(state.zoom("main"), ZOOM_MAX_FACTOR);
        assert_eq!(state.zoom("other"), 0.5);
    }

    #[test]
    fn bounds_round_trip_through_disk() {
        let path = temp_bounds_path("round-trip");
        let bounds = WindowBounds { x: -40, y: 12, width: 1440, height: 900, maximized: true };

        // save creates the missing parent directories.
        save_window_bounds(&path, &bounds).expect("save should succeed");
        assert!(path.exists());
        assert_eq!(load_window_bounds(&path), bounds);

        // Overwriting with different bounds replaces the previous file.
        // (Values must sit at or above the minimums: `load` clamps — see
        // `load_clamps_persisted_size_to_minimums` below — so a sub-minimum
        // value would not round-trip verbatim by design.)
        let second = WindowBounds { x: 0, y: 0, width: 640, height: 720, maximized: false };
        save_window_bounds(&path, &second).expect("second save");
        assert_eq!(load_window_bounds(&path), second);

        cleanup(&path);
    }

    #[test]
    fn malformed_bounds_fall_back_to_defaults() {
        let path = temp_bounds_path("malformed");
        std::fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        std::fs::write(&path, b"{ not valid json").expect("write garbage");

        // Falls back to defaults instead of panicking or erroring.
        assert_eq!(load_window_bounds(&path), WindowBounds::default());

        // A missing file behaves the same way (first run).
        let missing = path.with_extension("missing.json");
        assert_eq!(load_window_bounds(&missing), WindowBounds::default());

        cleanup(&path);
    }

    #[test]
    fn load_clamps_persisted_size_to_minimums() {
        let path = temp_bounds_path("load-clamp");
        let too_small = WindowBounds { x: 10, y: 10, width: 100, height: 50, maximized: false };
        save_window_bounds(&path, &too_small).expect("save");

        assert_eq!(
            load_window_bounds(&path),
            WindowBounds {
                width: MIN_DESKTOP_WINDOW_WIDTH,
                height: MIN_DESKTOP_WINDOW_HEIGHT,
                ..too_small
            }
        );

        cleanup(&path);
    }
}
