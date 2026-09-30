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

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::app_state::AppState;

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

/// Build the primary window.
///
/// Electron created a frameless window and implemented custom chrome in the
/// renderer. Tauri keeps the renderer chrome but moves the frameless decision
/// into the builder, and on Linux/Wayland `decorations(false)` yields an
/// undecorated window the renderer draws over — the same visual result without
/// the `will-attach-webview`/`setTitleBarOverlay` juggling.
fn build_primary_window(
    app: &AppHandle,
    options: &PrimaryWindowOptions,
) -> tauri::Result<WebviewWindow> {
    let url = format!(
        "index.html?windowKind=main&restoreSession={}&initialWorkspacePath={}",
        options.restore_session,
        urlencoding::encode(options.initial_workspace_path.as_deref().unwrap_or(""))
    );

    // `mut` is only consumed inside the macOS block below; without it the
    // non-macOS build reports an unused-mut warning. Bound it to the cfg.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = WebviewWindowBuilder::new(app, PRIMARY_WINDOW_LABEL, WebviewUrl::App(url.into()))
        .title("ZCode")
        .inner_size(1280.0, 820.0)
        .min_inner_size(940.0, 600.0)
        .resizable(true)
        .center()
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
/// Mirrors `primaryWindowCoordinator.ensurePrimaryWindow`. The Electron version
/// kept a `pendingEnsurePromise` to collapse the macOS cold-start `activate` vs
/// `ready` race; Tauri exposes `setup()` which runs exactly once before the
/// event loop starts, so that race cannot occur and no latch is needed.
pub fn ensure_primary_window(
    app: &AppHandle,
    state: &AppState,
    options: &PrimaryWindowOptions,
) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(PRIMARY_WINDOW_LABEL) {
        // Reveal before creating — never spawn a second workspace window.
        if let Ok(true) = existing.is_visible() {
            let _ = existing.unminimize();
        }
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(existing);
    }

    let window = build_primary_window(app, options)?;
    state.register_window(PRIMARY_WINDOW_LABEL, true);
    state.set_primary_ready(true);
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
            // Close-to-tray on Windows, matching `resolveAppShutdownPolicy`
            // in `main/appShutdownPolicy.ts`. An explicit quit sets the flag, so
            // the tray path never swallows a real shutdown.
            let quitting = state_for_events.quit_requested();
            if cfg!(target_os = "windows") && !quitting {
                api.prevent_close();
                if let Some(w) = app_for_close.get_webview_window(&label) {
                    let _ = w.hide();
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
