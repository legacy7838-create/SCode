//! Window lifecycle — the Tauri replacement for `desktopWindowLifecycle.ts` +
//! `primaryWindowCoordinator.ts` + `desktopWindowChrome.ts`.
//!
//! Two invariants carried over from the Electron original:
//!   1. There is at most one *primary* workspace window. Every "show the app"
//!      trigger (app-ready, tray, dock, deep link) funnels through
//!      `ensure_primary_window`, which reveals before it creates.
//!   2. Window identity is a stable string label. The Electron version mixed
//!      `win.id` and `win.webContents.id` keys across four registries; Tauri
//!      removes that class of bug because the label is the only key.
//!
//! ## Where the portable logic lives
//!
//! Almost none of this module is reachable from a `cargo test`, because
//! `WebviewWindow` and `AppHandle` only exist once Tauri owns an event loop.
//! Everything that *is* a decision — the display clamp, the zoom level model,
//! the OS capability probes, the label grammar, the shutdown order, the
//! reveal-before-create branch — is therefore factored into a pure function
//! here, and the window code is left as a thin adapter that supplies the
//! handle. This is the same seam `commands/surface.rs` uses for
//! `clamp_zoom_factor` and `save_window_bounds`.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::app_state::AppState;
use crate::commands::surface::{
    load_window_bounds, window_bounds_file, WindowBounds, MIN_DESKTOP_WINDOW_HEIGHT,
    MIN_DESKTOP_WINDOW_WIDTH,
};

/// Options for creating the primary workspace window.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryWindowOptions {
    /// Restore the previous session on mount.
    #[serde(default)]
    pub restore_session: bool,
    /// Absolute path of the workspace to open on mount.
    #[serde(default)]
    pub initial_workspace_path: Option<String>,
    /// Why the workspace is being opened (affects the UI affordance).
    #[serde(default)]
    pub initial_workspace_purpose: Option<String>,
}

pub const PRIMARY_WINDOW_LABEL: &str = "main";
pub const UPDATE_WINDOW_LABEL: &str = "update-status";
pub const RESOURCE_WINDOW_LABEL: &str = "resource-manager";

/// Longest window label this port accepts. Tauri hands the label straight to
/// the windowing system, so an unbounded renderer-supplied string would end up
/// in a platform window-manager property list.
pub const MAX_WINDOW_LABEL_LEN: usize = 64;

// ---------------------------------------------------------------------------
// Window labels
// ---------------------------------------------------------------------------

/// Validate a window label before it is used to address a window.
///
/// Electron never had to do this: the only label in the system was
/// `local-${win.webContents.id}` (`desktopWindowLifecycle.ts:89`), built once
/// in main and never parsed. Tauri replaces that integer with a string a
/// renderer can name, so the grammar has to be stated: non-empty, ASCII
/// alphanumeric with `-`/`_`, length-capped. `/` is excluded because it is
/// Tauri's own label path separator; `:` is excluded because `devtools://`-style
/// prefixed names are a Chromium internal, not ours.
pub fn validate_window_label(label: &str) -> Result<(), String> {
    if label.is_empty() {
        return Err("window label must not be empty".to_string());
    }
    if label.len() > MAX_WINDOW_LABEL_LEN {
        return Err(format!(
            "window label must be at most {MAX_WINDOW_LABEL_LEN} bytes, got {}",
            label.len()
        ));
    }
    if let Some(bad) = label
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || *c == '-' || *c == '_'))
    {
        return Err(format!(
            "window label may only contain ASCII alphanumerics, '-' and '_'; found {bad:?}"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Geometry: display work areas and the bounds clamp
// ---------------------------------------------------------------------------

/// A display work area in logical pixels: the region a window may occupy,
/// excluding the OS taskbar/dock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Clamp one dimension into `[minimum, available]`, flooring both ends.
///
/// A direct port of `clampDimension` (`desktopWindowSize.ts:12-15`). The
/// `max(minimum, …)` on the maximum is load-bearing: when the work area itself
/// is smaller than the minimum (a 1280×720 panel), the minimum wins and the
/// window overflows rather than collapsing to an unusable size.
pub fn clamp_dimension(value: i64, minimum: u32, available: u32) -> u32 {
    let maximum = minimum.max(available);
    let floored = value.max(minimum as i64) as u32;
    floored.min(maximum)
}

/// Resolve the geometry the primary window should be created with.
///
/// Port of `resolveDesktopWindowSize` (`desktopWindowSize.ts:17-29`) with one
/// addition. Electron never persisted a position, so it never needed to clamp
/// one and its window always landed centred. The Tauri port *does* persist `x`
/// and `y` (`commands/surface.rs::WindowBounds`), so a window saved on a
/// monitor that has since been unplugged would restore off-screen with no way
/// to reach it. The position is therefore clamped into the work area here.
pub fn resolve_desktop_window_size(
    persisted: Option<&WindowBounds>,
    work_area: DisplayRect,
) -> WindowBounds {
    let requested = persisted.copied().unwrap_or_default();
    let width = clamp_dimension(
        requested.width as i64,
        MIN_DESKTOP_WINDOW_WIDTH,
        work_area.width,
    );
    let height = clamp_dimension(
        requested.height as i64,
        MIN_DESKTOP_WINDOW_HEIGHT,
        work_area.height,
    );
    WindowBounds {
        x: clamp_axis(requested.x, work_area.x, work_area.width, width),
        y: clamp_axis(requested.y, work_area.y, work_area.height, height),
        width,
        height,
        // Electron passed `maximized` through unclamped and maximized
        // immediately (`desktopWindowChrome.ts:598-600`); so does this.
        maximized: requested.maximized,
    }
}

/// Pull `origin` into `[area_start, area_start + available - extent]`.
///
/// When the window is larger than the display the span goes negative; the
/// `saturating_sub` then pins the origin to the work area's top-left, which is
/// what centring a too-large window amounts to.
fn clamp_axis(origin: i32, area_start: i32, available: u32, extent: u32) -> i32 {
    let max_origin = area_start.saturating_add(available.saturating_sub(extent) as i32);
    origin.clamp(area_start, max_origin.max(area_start))
}

/// Convert a Tauri monitor into its logical-pixel work area.
pub fn work_area_of(monitor: &tauri::window::Monitor) -> DisplayRect {
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let position = area.position.to_logical::<f64>(scale);
    let size = area.size.to_logical::<f64>(scale);
    DisplayRect {
        x: position.x.round() as i32,
        y: position.y.round() as i32,
        width: size.width.max(0.0).round() as u32,
        height: size.height.max(0.0).round() as u32,
    }
}

/// The primary display's work area, falling back to the first monitor.
///
/// `primary_monitor()` returning `None` is a real case (headless CI, a
/// compositor that reports no primary), and the fallback keeps window creation
/// from becoming an error there.
pub fn primary_work_area(app: &AppHandle) -> Option<DisplayRect> {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        return Some(work_area_of(&monitor));
    }
    match app.available_monitors() {
        Ok(mut monitors) if !monitors.is_empty() => Some(work_area_of(&monitors.remove(0))),
        _ => None,
    }
}

/// Overlapping area between a work area and a requested window rect.
fn overlap_area(area: &DisplayRect, bounds: &WindowBounds) -> i64 {
    let left = i64::from(area.x).max(i64::from(bounds.x));
    let top = i64::from(area.y).max(i64::from(bounds.y));
    let right = (i64::from(area.x) + i64::from(area.width)).min(i64::from(bounds.x) + i64::from(bounds.width));
    let bottom =
        (i64::from(area.y) + i64::from(area.height)).min(i64::from(bounds.y) + i64::from(bounds.height));
    (right - left).max(0) * (bottom - top).max(0)
}

/// The work area a saved window rect actually belongs to.
///
/// Electron sidestepped this by never persisting a position. With positions
/// persisted, the saved rect has to be mapped back onto a monitor, or a window
/// saved on a since-disconnected display resolves against nothing. "Largest
/// overlap wins", falling back to the first monitor when nothing overlaps.
pub fn work_area_matching(app: &AppHandle, bounds: &WindowBounds) -> Option<DisplayRect> {
    let monitors = app.available_monitors().ok()?;
    if monitors.is_empty() {
        return None;
    }
    let areas: Vec<DisplayRect> = monitors.iter().map(work_area_of).collect();
    areas
        .iter()
        .filter(|area| overlap_area(area, bounds) > 0)
        .max_by_key(|area| overlap_area(area, bounds))
        .copied()
        .or_else(|| areas.first().copied())
}

// ---------------------------------------------------------------------------
// Reveal before create
// ---------------------------------------------------------------------------

/// Which branch of the ensure-window funnel ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnsureOutcome {
    /// An existing window was revealed; nothing was created.
    Revealed,
    /// No window existed, so one was built.
    Created,
}

/// Reveal or create — never both.
///
/// This is the whole of `primaryWindowCoordinator.ensurePrimaryWindow`
/// (`index.ts:872-911`): `revealExistingWindow()` first, and only a miss
/// creates. Electron kept a `pendingEnsurePromise` to collapse the macOS
/// cold-start `activate`-vs-`ready` race; Tauri runs `setup()` exactly once
/// before the event loop starts, so the race cannot occur and no latch is
/// needed. Making the branch a value rather than an early `return` is what makes
/// "a second workspace window cannot be spawned" assertable without an event
/// loop.
pub fn ensure_window_with<T: Clone>(
    existing: Option<T>,
    reveal: impl FnOnce(&T),
    create: impl FnOnce() -> tauri::Result<T>,
) -> tauri::Result<(T, EnsureOutcome)> {
    match existing {
        Some(window) => {
            reveal(&window);
            Ok((window, EnsureOutcome::Revealed))
        }
        None => Ok((create()?, EnsureOutcome::Created)),
    }
}

/// Un-minimize, show and focus, in that order.
///
/// Electron's `revealExistingWindow` (`index.ts:906-912`) restored only when
/// `isMinimized()`, then showed only when `!isVisible()`. The port checks
/// `is_minimized()` rather than `is_visible()` on purpose: on X11/Wayland a
/// minimized window is unmapped, so `is_visible()` is `false` there and a check
/// written against visibility would skip the restore and leave a "revealed"
/// window sitting minimized in the taskbar.
pub fn reveal_window(window: &WebviewWindow) {
    if let Ok(true) = window.is_minimized() {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Build the primary window.
///
/// Electron created a frameless window and implemented custom chrome in the
/// renderer. Tauri keeps the renderer chrome but moves the frameless decision
/// into the builder, and on Linux/Wayland `decorations(false)` yields an
/// undecorated window the renderer draws over — the same visual result without
/// the `will-attach-webview`/`setTitleBarOverlay` juggling.
///
/// Geometry comes from the persisted bounds, clamped to a display, rather than
/// a hardcoded 1280×820: `createBrowserWindow` resolved the initial size from
/// `resolveDesktopWindowSize(settings.desktopWindowSize, primaryWorkArea)`
/// (`desktopWindowChrome.ts:563-566`) and maximized immediately when the
/// setting said so (`:598-600`), so dropping the persisted value would restart
/// every user at the default size on every launch.
fn build_primary_window(
    app: &AppHandle,
    options: &PrimaryWindowOptions,
) -> tauri::Result<WebviewWindow> {
    let url = format!(
        "index.html?windowKind=main&restoreSession={}&initialWorkspacePath={}",
        options.restore_session,
        urlencoding::encode(options.initial_workspace_path.as_deref().unwrap_or(""))
    );

    let persisted = load_window_bounds(&window_bounds_file());
    // A saved rect is mapped back onto a monitor before it is used; a fresh
    // install has nothing saved and is placed against the primary display.
    let work_area = work_area_matching(app, &persisted).or_else(|| primary_work_area(app));
    let bounds = match work_area {
        Some(area) => resolve_desktop_window_size(Some(&persisted), area),
        // No display reported (headless): keep the persisted size rather than
        // clamping against a zero-sized work area.
        None => persisted,
    };

    // `mut` is only consumed inside the macOS block below; without it the
    // non-macOS build reports an unused-mut warning. Bound it to the cfg.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder =
        WebviewWindowBuilder::new(app, PRIMARY_WINDOW_LABEL, WebviewUrl::App(url.into()))
            .title("ZCode")
            .inner_size(bounds.width as f64, bounds.height as f64)
            .min_inner_size(MIN_DESKTOP_WINDOW_WIDTH as f64, MIN_DESKTOP_WINDOW_HEIGHT as f64)
            .position(bounds.x as f64, bounds.y as f64)
            .maximized(bounds.maximized)
            .resizable(true)
            // Keep the window out of the way of the OS title bar so the custom
            // renderer chrome owns the full surface.
            .decorations(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    builder.build()
}

/// Ensure a primary window exists, revealing it when one already does.
///
/// Mirrors `primaryWindowCoordinator.ensurePrimaryWindow`. The registry is only
/// written on the create branch: revealing a window that was never registered
/// would silently promote an unregistered surface to a main workspace window.
pub fn ensure_primary_window(
    app: &AppHandle,
    state: &AppState,
    options: &PrimaryWindowOptions,
) -> tauri::Result<WebviewWindow> {
    let existing = app.get_webview_window(PRIMARY_WINDOW_LABEL);
    let created = existing.is_none();

    let (window, _outcome) =
        ensure_window_with(existing, reveal_window, || build_primary_window(app, options))?;

    if created {
        state.register_window(PRIMARY_WINDOW_LABEL, true);
        state.set_primary_ready(true);
    }
    Ok(window)
}

/// Attach the lifecycle listeners for one specific window.
///
/// Tauri v2's global `app.on_window_event` receives a `&WindowEvent` that does
/// not carry the window label, so it cannot drive a label-keyed registry. The
/// per-window `WebviewWindow::on_window_event` closure *does* have the label in
/// scope, which is why the registry cleanup lives here instead. The Electron
/// original attached cleanup in two places and neither was wrapped in try/catch,
/// so one throwing listener leaked the remaining registry entries.
pub fn attach_window_events(window: &WebviewWindow, app: &AppHandle, state: Arc<AppState>) {
    let label = window.label().to_string();
    let app_for_close = app.clone();
    let state_for_events = state;

    window.clone().on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            // `quitting` is the Tauri form of Electron's
            // `forceQuitRef || explicitQuitRef` (`index.ts:609-610`). Both the
            // close-to-tray and the close-to-hide branches are gated on it, so
            // this flag is what makes a real shutdown actually close the
            // window. `run_shutdown_sequence` sets it before anything closes.
            if state_for_events.quit_requested() {
                // A confirmed quit really closes the window.
                return;
            }

            if cfg!(target_os = "windows") {
                // Close-to-tray, matching `resolveAppShutdownPolicy` in
                // `main/appShutdownPolicy.ts` and
                // `handleDesktopWindowCloseRequest` (`desktopWindowLifecycle.ts:373-381`).
                api.prevent_close();
                if let Some(w) = app_for_close.get_webview_window(&label) {
                    let _ = w.hide();
                }
            }

            #[cfg(target_os = "macos")]
            {
                // `desktopDarwinCloseBehavior.ts:6-31`: outside a confirmed
                // quit the red button never closes the window — it leaves
                // full-screen first (closing from full-screen would strand the
                // Space), otherwise it hides.
                api.prevent_close();
                if let Some(w) = app_for_close.get_webview_window(&label) {
                    if matches!(w.is_fullscreen(), Ok(true)) {
                        let _ = w.set_fullscreen(false);
                    } else {
                        let _ = w.hide();
                    }
                }
            }
        }
        WindowEvent::Destroyed => {
            state_for_events.forget_window(&label);
        }
        _ => {}
    });
}

/// Remove a window from both registries without waiting for `Destroyed`.
/// Used by the command layer when a window is closed programmatically.
pub fn forget_window(state: &AppState, label: &str) {
    state.forget_window(label);
}

// ---------------------------------------------------------------------------
// Zoom: Electron's integer level model
// ---------------------------------------------------------------------------

/// `DESKTOP_ZOOM_MIN_LEVEL` (`desktopZoom.ts:1`).
pub const ZOOM_LEVEL_MIN: i32 = -3;
/// `DESKTOP_ZOOM_MAX_LEVEL` (`desktopZoom.ts:2`).
pub const ZOOM_LEVEL_MAX: i32 = 5;
/// `DESKTOP_ZOOM_FACTOR_STEP` (`desktopZoom.ts:3`). Deliberately 1.1, not
/// Chromium/Electron's own 1.2 — `resolveDesktopZoomFactorForLevel` is
/// `Math.pow(1.1, level)` and the UI's zoom steps are calibrated to it.
pub const ZOOM_FACTOR_STEP: f64 = 1.1;

pub fn clamp_zoom_level(level: i32) -> i32 {
    level.clamp(ZOOM_LEVEL_MIN, ZOOM_LEVEL_MAX)
}

/// `resolveDesktopZoomFactorForLevel` (`desktopZoom.ts:9-11`).
pub fn zoom_factor_for_level(level: i32) -> f64 {
    ZOOM_FACTOR_STEP.powi(clamp_zoom_level(level))
}

/// `resolveDesktopZoomLevelFromFactor` (`desktopZoom.ts:13-20`).
pub fn zoom_level_from_factor(factor: f64) -> i32 {
    if !factor.is_finite() || factor <= 0.0 {
        return 0;
    }
    // `as i32` saturates, so a wild factor clamps at the range end rather than
    // wrapping the way a JavaScript `| 0` would.
    clamp_zoom_level((factor.ln() / ZOOM_FACTOR_STEP.ln()).round() as i32)
}

/// One zoom step. `delta` is `+1` for zoom-in, `-1` for zoom-out.
pub fn step_zoom_level(current: i32, delta: i32) -> i32 {
    clamp_zoom_level(current.saturating_add(delta))
}

// ---------------------------------------------------------------------------
// OS capability probes
// ---------------------------------------------------------------------------

/// First Windows 11 build (`desktopWindowChromeState.ts:4`).
pub const WINDOWS_11_FIRST_BUILD: u32 = 22000;

/// `resolveMacOSMajorVersion` (`desktopWindowChromeState.ts:6-16`).
///
/// `platform` is Tauri's `tauri_plugin_os::platform()` spelling (`"macos"`),
/// not Node's `"darwin"`. The Tahoe jump is why this arithmetic exists at all:
/// Darwin 25 *is* macOS 26, so the old `-9` would report 16.
pub fn resolve_macos_major_version(platform: &str, platform_release: &str) -> Option<i32> {
    if platform != "macos" {
        return None;
    }
    let darwin_major: i32 = platform_release.split('.').next()?.parse().ok()?;
    Some(if darwin_major >= 25 {
        darwin_major + 1
    } else {
        darwin_major - 9
    })
}

/// `supportsNativeWindowsRoundedCorners` (`desktopWindowChromeState.ts:18-25`).
/// Windows reports `major.minor.build`, so the build is the *third* field.
pub fn supports_native_rounded_corners(platform: &str, platform_release: &str) -> bool {
    if platform != "windows" {
        return false;
    }
    platform_release
        .split('.')
        .nth(2)
        .and_then(|build| build.parse::<u32>().ok())
        .is_some_and(|build| build >= WINDOWS_11_FIRST_BUILD)
}

/// The CUA Helper OS gate (`cuaOsSupport.ts`). Returned verbatim as the shared
/// `CuaOsSupport` union on the wire: `kind` is kebab-case, fields camelCase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum CuaOsSupport {
    Supported,
    MacosBelowMinimum {
        minimum_mac_os: String,
        current_mac_os: String,
    },
    NotApplicable,
}

/// Promise floor = max(Helper `Info.plist` `LSMinimumSystemVersion` 12.0, SEA
/// Binary `minos` 11.0). Missing this check is a documented 2026-08 incident:
/// users below the floor saw authorization repeat forever with no response,
/// because LaunchServices refuses to launch the Helper at all.
pub const CUA_MINIMUM_MACOS_VERSION: &str = "12.0";
/// Darwin major - 9 = macOS major (21↔12, 22↔13).
pub const CUA_MINIMUM_DARWIN_MAJOR: i32 = 21;

/// `resolveCuaOsSupport` (`cuaOsSupport.ts:16-31`).
pub fn resolve_cua_os_support(platform: &str, platform_release: &str) -> CuaOsSupport {
    if platform != "macos" {
        return CuaOsSupport::NotApplicable;
    }
    // An unparseable release is treated leniently, exactly as upstream's
    // `Number.isNaN(major) → supported` does: an unknown macOS is not evidence
    // of an unsupported one.
    let major: Option<i32> = platform_release.split('.').next().unwrap_or("").parse().ok();
    match major {
        None => CuaOsSupport::Supported,
        Some(major) if major < CUA_MINIMUM_DARWIN_MAJOR => CuaOsSupport::MacosBelowMinimum {
            minimum_mac_os: CUA_MINIMUM_MACOS_VERSION.to_string(),
            current_mac_os: (major - 9).to_string(),
        },
        Some(_) => CuaOsSupport::Supported,
    }
}

// ---------------------------------------------------------------------------
// Workspace activation
// ---------------------------------------------------------------------------

/// Choose which window a workspace path should be activated in.
///
/// Electron's `focusWorkspaceInExistingWindow` (`desktopWindowLifecycle.ts:288-315`)
/// scanned `windowWorkspaceMap` — a `Map`, so *insertion* order — skipped the
/// sender, and took the first window whose set contained the path. This port's
/// registry is a `HashMap`, whose iteration order is not stable between runs,
/// so "first match wins" is not reproducible from `AppState` alone. The
/// ordering is therefore made explicit and deterministic here:
///
///   1. the primary window when it is among the matches — there is at most one,
///      and it is where the user expects to land;
///   2. otherwise the lexicographically smallest match, as a deterministic
///      stand-in for insertion order.
///
/// The caller is skipped by the caller of this function: activating a path in
/// the window already showing it is a no-op the user would read as "nothing
/// happened".
pub fn pick_activation_target(
    primary: Option<&str>,
    candidates: &[(String, bool)],
) -> Option<String> {
    if let Some(primary) = primary.filter(|p| candidates.iter().any(|(l, has)| l == *p && *has)) {
        return Some(primary.to_string());
    }
    candidates
        .iter()
        .filter(|(_, has)| *has)
        .map(|(label, _)| label.clone())
        .min()
}

// ---------------------------------------------------------------------------
// Shutdown ordering
// ---------------------------------------------------------------------------

/// The steps an explicit quit or relaunch takes, in order.
///
/// The order is the contract. `MarkExplicitQuit` must land before anything that
/// can close a window: `attach_window_events` treats a close as close-to-tray
/// (Windows) or close-to-hide (macOS) unless `AppState::quit_requested()` is
/// already true. The earlier port regressed exactly here — gating the drain on
/// `quit_flag` while setting that flag *after* the close meant every explicit
/// quit was swallowed as close-to-tray and the supervised children never
/// drained. Keeping the sequence as an enum is what makes that assertable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShutdownStep {
    MarkExplicitQuit,
    TakeDrainLatch,
    StopSupervisor,
    Finish,
}

/// What a shutdown actually did, for the caller and for tests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownReport {
    /// `true` when this call is the one that owned the drain latch. A second
    /// quit racing the first gets `false` and must not stop the supervisor
    /// twice.
    pub drained: bool,
    pub steps: Vec<ShutdownStep>,
}

/// The four side effects a shutdown performs, behind a trait so the *order*
/// can be asserted without an event loop, a window, or a `Supervisor`.
pub trait ShutdownSink {
    fn mark_explicit_quit(&mut self);
    fn take_drain_latch(&mut self) -> bool;
    fn stop_supervisor(&mut self);
    /// Quit or relaunch — the only step that differs between the two.
    fn finish(&mut self);
}

/// Run the shutdown steps in their one correct order.
pub fn run_shutdown_sequence(sink: &mut impl ShutdownSink) -> ShutdownReport {
    sink.mark_explicit_quit();
    let drained = sink.take_drain_latch();

    let mut steps = vec![ShutdownStep::MarkExplicitQuit, ShutdownStep::TakeDrainLatch];
    if drained {
        sink.stop_supervisor();
        steps.push(ShutdownStep::StopSupervisor);
    }
    sink.finish();
    steps.push(ShutdownStep::Finish);

    ShutdownReport { drained, steps }
}

#[cfg(test)]
mod tests {
    use crate::app_state::QuitKind;
    use super::*;

    /// A sink that records the order it was driven in, over a real `AppState`
    /// so the latch semantics under test are the production ones.
    #[derive(Debug)]
    struct RecordingSink<'a> {
        steps: Vec<ShutdownStep>,
        state: &'a AppState,
        /// `quit_requested()` sampled immediately after `mark_explicit_quit`,
        /// i.e. before any step that could close a window.
        quit_flag_after_mark: bool,
    }

    impl<'a> RecordingSink<'a> {
        fn new(state: &'a AppState) -> Self {
            Self { steps: Vec::new(), state, quit_flag_after_mark: false }
        }
    }

    impl ShutdownSink for RecordingSink<'_> {
        fn mark_explicit_quit(&mut self) {
            self.state.request_quit(QuitKind::Normal);
            self.quit_flag_after_mark = self.state.quit_requested();
            self.steps.push(ShutdownStep::MarkExplicitQuit);
        }
        fn take_drain_latch(&mut self) -> bool {
            self.steps.push(ShutdownStep::TakeDrainLatch);
            self.state.take_shutdown_drain()
        }
        fn stop_supervisor(&mut self) {
            self.steps.push(ShutdownStep::StopSupervisor);
        }
        fn finish(&mut self) {
            self.steps.push(ShutdownStep::Finish);
        }
    }

    // --- reveal before create ------------------------------------------------

    #[test]
    fn ensure_reveals_an_existing_window_and_never_creates_a_second() {
        let mut revealed = 0;
        let mut created = 0;
        let (window, outcome) = ensure_window_with(
            Some("primary".to_string()),
            |_| revealed += 1,
            || {
                created += 1;
                Ok("second".to_string())
            },
        )
        .expect("reveal must not fail");

        assert_eq!(window, "primary");
        assert_eq!(outcome, EnsureOutcome::Revealed);
        assert_eq!(revealed, 1, "an existing window must be revealed");
        assert_eq!(created, 0, "a second workspace window must be impossible");
    }

    #[test]
    fn ensure_creates_exactly_once_when_no_window_exists() {
        let mut revealed = 0;
        let mut created = 0;
        let (window, outcome) = ensure_window_with(
            None::<String>,
            |_| revealed += 1,
            || {
                created += 1;
                Ok("primary".to_string())
            },
        )
        .expect("create must succeed");

        assert_eq!(window, "primary");
        assert_eq!(outcome, EnsureOutcome::Created);
        assert_eq!(created, 1);
        assert_eq!(revealed, 0);
    }

    #[test]
    fn ensure_propagates_a_creation_failure_rather_than_silently_revealing_nothing() {
        // Any `tauri::Error` variant will do: the assertion is that the failure
        // propagates instead of being swallowed, not which failure it was.
        // `WindowLabel` was removed in Tauri 2.12, so this uses a plain String
        // variant that is stable across versions.
        let result: tauri::Result<(String, EnsureOutcome)> = ensure_window_with(
            None::<String>,
            |_| unreachable!("there is nothing to reveal"),
            || Err(tauri::Error::AssetNotFound(String::from("no display"))),
        );
        assert!(result.is_err());
    }

    // --- quit drain ordering -------------------------------------------------

    #[test]
    fn the_quit_latch_is_set_before_anything_can_close_a_window() {
        let state = AppState::new();
        let mut sink = RecordingSink::new(&state);
        let report = run_shutdown_sequence(&mut sink);

        assert_eq!(
            report.steps,
            vec![
                ShutdownStep::MarkExplicitQuit,
                ShutdownStep::TakeDrainLatch,
                ShutdownStep::StopSupervisor,
                ShutdownStep::Finish,
            ],
            "the shutdown order is the contract that previously regressed"
        );
        assert!(
            sink.quit_flag_after_mark,
            "attach_window_events reads quit_requested() to decide whether a \
             close is close-to-tray; if it is still false when the close \
             arrives, the quit is swallowed"
        );
        assert!(report.drained);
    }

    #[test]
    fn a_second_quit_racing_the_first_does_not_drain_twice() {
        let state = AppState::new();
        let mut first = RecordingSink::new(&state);
        let mut second = RecordingSink::new(&state);

        assert!(run_shutdown_sequence(&mut first).drained);
        let second_report = run_shutdown_sequence(&mut second);

        assert!(
            !second_report.drained,
            "the drain latch is one-shot: a tray quit racing a window quit \
             must not stop the supervisor a second time"
        );
        assert_eq!(
            second_report.steps,
            vec![
                ShutdownStep::MarkExplicitQuit,
                ShutdownStep::TakeDrainLatch,
                ShutdownStep::Finish,
            ]
        );
        // The second caller still marks the quit, so its own close is not
        // swallowed as close-to-tray.
        assert!(second.quit_flag_after_mark);
    }

    #[test]
    fn quit_kind_is_recorded_for_the_renderer() {
        let state = AppState::new();
        assert_eq!(state.quit_kind(), None);
        state.request_quit(QuitKind::UpdateInstall);
        assert_eq!(state.quit_kind(), Some(QuitKind::UpdateInstall));
        assert!(state.quit_requested());
    }

    // --- window labels -------------------------------------------------------

    #[test]
    fn window_labels_accept_the_real_registry_keys() {
        for label in [
            PRIMARY_WINDOW_LABEL,
            UPDATE_WINDOW_LABEL,
            RESOURCE_WINDOW_LABEL,
            "main-2",
            "a",
        ] {
            assert!(validate_window_label(label).is_ok(), "{label} must be addressable");
        }
    }

    #[test]
    fn window_labels_reject_empty_overlong_and_pathed_input() {
        assert!(validate_window_label("").is_err(), "empty label");
        assert!(
            validate_window_label(&"a".repeat(MAX_WINDOW_LABEL_LEN + 1)).is_err(),
            "an unbounded renderer string would reach the windowing system"
        );
        assert!(validate_window_label("main/../../etc").is_err(), "path separator");
        assert!(validate_window_label("devtools://x").is_err(), "chromium-internal prefix");
        assert!(validate_window_label("main window").is_err(), "whitespace");
        assert!(validate_window_label("café").is_err(), "non-ascii");
        assert!(
            validate_window_label(&"a".repeat(MAX_WINDOW_LABEL_LEN)).is_ok(),
            "the cap itself is inclusive"
        );
    }

    // --- bounds clamping to a display ---------------------------------------

    const DISPLAY: DisplayRect = DisplayRect { x: 0, y: 0, width: 1920, height: 1040 };

    #[test]
    fn clamp_dimension_floors_and_respects_a_work_area_smaller_than_the_minimum() {
        assert_eq!(clamp_dimension(1440, 480, 1920), 1440);
        assert_eq!(clamp_dimension(4000, 480, 1920), 1920, "clamped to the work area");
        assert_eq!(clamp_dimension(100, 480, 1920), 480, "clamped up to the minimum");
        assert_eq!(clamp_dimension(1200, 480, 1920), 1200, "floor then clamp");
        assert_eq!(clamp_dimension(1201, 480, 1920), 1201);
        // A 1280×720 panel: the work area is smaller than the 480×640 minimum,
        // and the minimum wins so the window stays usable.
        assert_eq!(clamp_dimension(900, 640, 720), 640, "minimum beats a tiny work area");
        assert_eq!(clamp_dimension(600, 640, 720), 640);
    }

    #[test]
    fn window_size_defaults_to_the_electron_default_when_nothing_is_persisted() {
        // `resolveDesktopWindowSize(undefined, workArea)` —
        // DEFAULT_DESKTOP_WINDOW_WIDTH/HEIGHT (`desktopWindowSize.ts:4-5`).
        assert_eq!(
            resolve_desktop_window_size(None, DISPLAY),
            WindowBounds { x: 0, y: 0, width: 1200, height: 800, maximized: false }
        );
    }

    #[test]
    fn window_size_is_clamped_into_the_display_it_restores_onto() {
        let persisted = WindowBounds { x: 4000, y: -300, width: 1440, height: 900, maximized: false };
        let bounds = resolve_desktop_window_size(Some(&persisted), DISPLAY);
        // 1920 - 1440 = 480, so the right edge lands on the work-area edge.
        assert_eq!(bounds.x, 480);
        assert_eq!(bounds.y, 0, "a negative y clamps to the work-area origin");
        assert_eq!(bounds.width, 1440);
        assert_eq!(bounds.height, 900);

        // A negative display origin is respected rather than clamped to 0.
        let left_monitor = DisplayRect { x: -1920, y: 25, width: 1920, height: 1055 };
        let offscreen = WindowBounds { x: 10, y: 10, width: 800, height: 600, maximized: false };
        let bounds = resolve_desktop_window_size(Some(&offscreen), left_monitor);
        assert_eq!(bounds.x, -1920, "clamped up to the left monitor's origin");
        assert_eq!(bounds.y, 25);
    }

    #[test]
    fn a_window_larger_than_the_display_anchors_to_the_work_area_origin() {
        let tiny = DisplayRect { x: 100, y: 200, width: 640, height: 480 };
        let oversized = WindowBounds { x: 0, y: 0, width: 2000, height: 1500, maximized: false };
        let bounds = resolve_desktop_window_size(Some(&oversized), tiny);
        assert_eq!(bounds.width, 640, "clamped down to the work area");
        assert_eq!(bounds.height, 480);
        assert_eq!(bounds.x, 100);
        assert_eq!(bounds.y, 200);
    }

    #[test]
    fn persisted_maximized_survives_the_clamp() {
        let persisted = WindowBounds { x: 0, y: 0, width: 100, height: 100, maximized: true };
        assert!(resolve_desktop_window_size(Some(&persisted), DISPLAY).maximized);
    }

    #[test]
    fn overlap_prefers_the_monitor_that_actually_contains_the_window() {
        let left = DisplayRect { x: -1920, y: 0, width: 1920, height: 1080 };
        let right = DISPLAY;
        let on_right = WindowBounds { x: 10, y: 10, width: 800, height: 600, maximized: false };
        assert!(overlap_area(&right, &on_right) > overlap_area(&left, &on_right));
        let on_left = WindowBounds { x: -1800, y: 10, width: 800, height: 600, maximized: false };
        assert!(overlap_area(&left, &on_left) > overlap_area(&right, &on_left));
        let nowhere = WindowBounds { x: 9000, y: 9000, width: 100, height: 100, maximized: false };
        assert_eq!(overlap_area(&right, &nowhere), 0, "no overlap falls back to the first monitor");
    }

    // --- zoom ----------------------------------------------------------------

    #[test]
    fn zoom_levels_clamp_to_the_electron_range() {
        assert_eq!(clamp_zoom_level(0), 0);
        assert_eq!(clamp_zoom_level(-3), ZOOM_LEVEL_MIN);
        assert_eq!(clamp_zoom_level(5), ZOOM_LEVEL_MAX);
        assert_eq!(clamp_zoom_level(99), ZOOM_LEVEL_MAX);
        assert_eq!(clamp_zoom_level(i32::MIN), ZOOM_LEVEL_MIN);
        assert_eq!(
            step_zoom_level(ZOOM_LEVEL_MIN, -1),
            ZOOM_LEVEL_MIN,
            "cannot zoom out past the floor"
        );
        assert_eq!(step_zoom_level(ZOOM_LEVEL_MAX, 1), ZOOM_LEVEL_MAX);
        assert_eq!(step_zoom_level(0, 1), 1);
        assert_eq!(step_zoom_level(0, -1), -1);
        assert_eq!(step_zoom_level(i32::MAX, 1), ZOOM_LEVEL_MAX, "saturating, not wrapping");
    }

    #[test]
    fn zoom_factor_is_the_1_1_power_of_the_level_and_round_trips() {
        assert!((zoom_factor_for_level(0) - 1.0).abs() < 1e-12);
        assert!((zoom_factor_for_level(2) - 1.21).abs() < 1e-9, "1.1^2, not Chromium's 1.2^2");
        assert!((zoom_factor_for_level(-1) - 1.0 / 1.1).abs() < 1e-9);
        // An out-of-range level clamps before the power is taken.
        assert_eq!(zoom_factor_for_level(99), zoom_factor_for_level(ZOOM_LEVEL_MAX));

        for level in ZOOM_LEVEL_MIN..=ZOOM_LEVEL_MAX {
            assert_eq!(zoom_level_from_factor(zoom_factor_for_level(level)), level);
        }
    }

    #[test]
    fn a_non_finite_or_non_positive_zoom_factor_reads_as_level_zero() {
        assert_eq!(zoom_level_from_factor(f64::NAN), 0);
        assert_eq!(zoom_level_from_factor(f64::INFINITY), 0);
        assert_eq!(zoom_level_from_factor(0.0), 0);
        assert_eq!(zoom_level_from_factor(-2.0), 0);
        // A factor between two levels rounds to the nearer one.
        assert_eq!(zoom_level_from_factor(1.15), 1);
    }

    // --- OS capability probes -------------------------------------------------

    #[test]
    fn macos_major_version_follows_the_darwin_to_macos_mapping() {
        // `desktopWindowChromeState.ts:6-16`: >=25 is +1 (Tahoe), else -9.
        assert_eq!(resolve_macos_major_version("macos", "15.3.0"), Some(6));
        assert_eq!(resolve_macos_major_version("macos", "21.0.0"), Some(12));
        assert_eq!(resolve_macos_major_version("macos", "25.0.0"), Some(26));
        assert_eq!(resolve_macos_major_version("macos", "26.1.2"), Some(27));
        assert_eq!(resolve_macos_major_version("macos", "not-a-version"), None);
        assert_eq!(resolve_macos_major_version("windows", "10.0.26100"), None);
        assert_eq!(resolve_macos_major_version("linux", "6.8.0"), None);
    }

    #[test]
    fn rounded_corners_are_windows_11_or_newer_only() {
        assert!(supports_native_rounded_corners("windows", "10.0.26100"));
        assert!(!supports_native_rounded_corners("windows", "10.0.21999"));
        assert!(!supports_native_rounded_corners("windows", "10.0"), "no build field");
        assert!(!supports_native_rounded_corners("linux", "6.8.0"));
        assert!(!supports_native_rounded_corners("macos", "15.3.0"));
    }

    #[test]
    fn cua_os_support_gates_on_the_helper_floor() {
        assert_eq!(resolve_cua_os_support("linux", "6.8.0"), CuaOsSupport::NotApplicable);
        assert_eq!(
            resolve_cua_os_support("windows", "10.0.26100"),
            CuaOsSupport::NotApplicable
        );
        assert_eq!(resolve_cua_os_support("macos", "25.0.0"), CuaOsSupport::Supported);
        assert_eq!(
            resolve_cua_os_support("macos", "20.6.0"),
            CuaOsSupport::MacosBelowMinimum {
                minimum_mac_os: "12.0".to_string(),
                current_mac_os: "11".to_string(),
            }
        );
        assert_eq!(resolve_cua_os_support("macos", "?"), CuaOsSupport::Supported);
    }

    // --- workspace activation -------------------------------------------------

    fn candidates(entries: &[(&str, bool)]) -> Vec<(String, bool)> {
        entries.iter().map(|(l, has)| ((*l).to_string(), *has)).collect()
    }

    #[test]
    fn activation_prefers_the_primary_window() {
        let windows = candidates(&[("main-2", true), ("main", true)]);
        assert_eq!(pick_activation_target(Some("main"), &windows), Some("main".to_string()));
    }

    #[test]
    fn activation_falls_back_to_a_deterministic_match_when_the_primary_lacks_the_path() {
        let windows = candidates(&[("main", false), ("zeta", true), ("alpha", true)]);
        // Lexicographic, standing in for the `Map` insertion order Electron had.
        assert_eq!(pick_activation_target(Some("main"), &windows), Some("alpha".to_string()));
    }

    #[test]
    fn activation_reports_nothing_when_no_window_holds_the_path() {
        let windows = candidates(&[("main", false), ("main-2", false)]);
        assert_eq!(pick_activation_target(Some("main"), &windows), None);
        assert_eq!(pick_activation_target(None, &[]), None);
    }
}
