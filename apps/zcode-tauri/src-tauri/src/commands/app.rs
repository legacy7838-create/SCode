//! Application-level commands. Replaces the handlers in
//! `main/desktopMainIpcPlatform.ts` that are not window-scoped or filesystem.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::{require_registered_window, CommandResult};
use crate::app_state::{AppState, QuitKind};

/// Identity and build information for the running app.
///
/// Electron answered this from a preload constant bundle; Tauri has a real
/// `PackageInfo`, so the values are authoritative rather than injected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub tauri_version: String,
    pub os: String,
    pub arch: String,
}

/// Show the primary window (tray click, dock click, deep link).
#[tauri::command]
pub fn show_current_window(app: AppHandle) -> CommandResult<bool> {
    match app.get_webview_window(crate::window::PRIMARY_WINDOW_LABEL) {
        Some(window) => {
            let _ = window.show();
            let _ = window.set_focus();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Begin an orderly shutdown.
///
/// The Electron original had a two-phase barrier with a deadline and a
/// `hasPreparedAppQuit` latch whose interaction with update-initiated quits was
/// the source of a documented inconsistency. Here the quit kind is recorded
/// explicitly *before* the drain begins, so the confirm dialog and the shutdown
/// budget can both branch on it without racing.
#[tauri::command]
pub fn request_quit(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<AppState>>,
    kind: Option<String>,
) -> CommandResult<bool> {
    require_registered_window(&state, window.label())?;
    let kind = match kind.as_deref() {
        Some("updateInstall") | Some("update-install") => QuitKind::UpdateInstall,
        _ => QuitKind::Normal,
    };
    state.request_quit(kind);
    Ok(true)
}
