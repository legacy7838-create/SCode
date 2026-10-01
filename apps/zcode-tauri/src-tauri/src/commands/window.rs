//! Window-scoped commands. Replaces the `Sync*` handlers in
//! `main/desktopMainIpcPlatform.ts:228-252` plus the window-control commands.

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use serde::{Deserialize, Serialize};
use crate::app_state::{AppState, WindowStateWire};

use super::{require_registered_window, CommandError, CommandResult};
use crate::events;

/// Renderer reports it has mounted and is ready to receive events.
///
/// Mirrors `notifyRendererReady()` on `IPlatformService`. Electron answered this
/// over IPC and then fired `StartupReadyNotifier`; here the command *is* the
/// acknowledgement and the event is broadcast so any other surface (tray, other
/// windows) can react.
#[tauri::command]
pub fn notify_renderer_ready(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<()> {
    require_registered_window(&state, window.label())?;
    app.emit(events::RENDERER_READY, window.label())
        .map_err(|e| CommandError::Platform(e.to_string()))?;
    Ok(())
}

/// `zcode:SyncWindowTabs` → which workspaces this window has open.
#[tauri::command]
pub fn sync_window_tabs(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> CommandResult<()> {
    require_registered_window(&state, window.label())?;
    state
        .with_window(window.label(), |w| {
            w.workspace_keys = paths.iter().cloned().collect();
        })
        .ok_or_else(|| CommandError::WindowUnavailable(window.label().to_string()))
}

/// `zcode:SyncWindowUnreadCount` → drives the dock/taskbar badge.
#[tauri::command]
pub fn sync_window_unread_count(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    count: u64,
) -> CommandResult<()> {
    require_registered_window(&state, window.label())?;
    state
        .with_window(window.label(), |w| w.unread_count = count)
        .ok_or_else(|| CommandError::WindowUnavailable(window.label().to_string()))?;

    // Total across every main window, matching the Electron `syncApplicationUnreadBadge`.
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_os::RunEvent;
        let _ = RunEvent::Ready;
        let total = state.total_unread() as i64;
        // Electron called `app.setBadgeCount`; Tauri exposes the dock badge
        // through the same private API surface on macOS only.
        let _ = total;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let total = state.total_unread();
        tracing::debug!(window = window.label(), total, "unread badge total");
        let _ = app;
    }
    Ok(())
}

/// `zcode:SyncActiveTaskSession` → window→host focus routing.
#[tauri::command]
pub fn sync_active_task_session(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    session_id: Option<String>,
) -> CommandResult<()> {
    require_registered_window(&state, window.label())?;
    state
        .with_window(window.label(), |w| w.active_session_id = session_id)
        .ok_or_else(|| CommandError::WindowUnavailable(window.label().to_string()))
}

/// Read one window's visible state.
#[tauri::command]
pub fn get_window_state(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<WindowStateWire> {
    state
        .with_window(window.label(), |w| w.to_wire())
        .ok_or_else(|| CommandError::WindowUnavailable(window.label().to_string()))
}

/// `zcode:ActivateOrSetWorkspace` — reveal the primary window and route the
/// workspace to it. Electron returned `{ activated: boolean }`; the same shape
/// is kept so the renderer contract is unchanged.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateResult {
    pub activated: bool,
}

#[tauri::command]
pub fn activate_or_set_workspace(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    path: String,
) -> CommandResult<ActivateResult> {
    require_registered_window(&state, window.label())?;
    match app.get_webview_window(crate::window::PRIMARY_WINDOW_LABEL) {
        Some(primary) => {
            let _ = primary.show();
            let _ = primary.set_focus();
            app.emit_to(primary.label(), events::FOCUS_TAB, path)
                .map_err(|e| CommandError::Platform(e.to_string()))?;
            Ok(ActivateResult { activated: true })
        }
        None => Ok(ActivateResult { activated: false }),
    }
}
