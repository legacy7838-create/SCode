//! Application-level commands. Replaces the handlers in
//! `main/desktopMainIpcPlatform.ts` that are not window-scoped or filesystem.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::{require_registered_window, CommandError, CommandResult};
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

#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    let package = app.package_info();
    let os = tauri_plugin_os::platform();
    let arch = tauri_plugin_os::arch();
    AppInfo {
        version: package.version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        os: os.to_string(),
        arch: arch.to_string(),
    }
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

/// Read the recorded quit kind; used by the renderer to decide whether to warn
/// about in-flight sessions.
#[tauri::command]
pub fn get_quit_kind(state: State<'_, Arc<AppState>>) -> Option<String> {
    state.quit_kind().map(|k| match k {
        QuitKind::Normal => "normal".to_string(),
        QuitKind::UpdateInstall => "updateInstall".to_string(),
    })
}

/// Diagnostics: the whole window registry, for the resource-manager surface and
/// for e2e assertions.
#[tauri::command]
pub fn describe_runtime(state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, CommandError> {
    Ok(serde_json::json!({
        "windows": state.snapshot(),
        "mainWindows": state.main_window_labels(),
        "primaryReady": state.is_primary_ready(),
        "quitRequested": state.quit_requested(),
    }))
}
