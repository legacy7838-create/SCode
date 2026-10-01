//! Event names — the Tauri replacement for Electron's `PlatformChannels` strings.
//!
//! Electron used `webContents.send("zcode:SomeChannel", payload)` for main→renderer
//! push and `ipcMain.on("zcode:SomeChannel", …)` for renderer→main. Tauri splits
//! that single namespace in two:
//!   * renderer→main is `invoke("command_name", payload)` — see `commands/`
//!   * main→renderer is `app.emit("event-name", payload)` — the names below
//!
//! The `zcode:` prefix is dropped in favour of a `zc-` prefix so that event names
//! are distinguishable from command names when auditing the IPC surface.

/// Emitted once the primary window's webview has signalled it is ready.
pub const RENDERER_READY: &str = "zc-renderer-ready";
/// Window→main state sync: which workspaces this window has open.
pub const WINDOW_TABS_SYNCED: &str = "zc-window-tabs-synced";
/// Window→main state sync: unread task count.
pub const WINDOW_UNREAD_SYNCED: &str = "zc-window-unread-synced";
/// Focus routing: bring an existing window's tab to the front.
pub const FOCUS_TAB: &str = "zc-focus-tab";
/// A new tab should be opened in this window.
pub const NEW_TAB: &str = "zc-new-tab";
/// Another window (or the tray) requested the current window be shown.
pub const SHOW_CURRENT_WINDOW: &str = "zc-show-current-window";
/// Auto-update state machine transitioned.
pub const UPDATE_STATE_CHANGED: &str = "zc-update-state-changed";
/// Application settings changed at runtime.
pub const APP_SETTINGS_CHANGED: &str = "zc-app-settings-changed";
/// Host lifecycle: a host was spawned for a window.
pub const HOST_SPAWNED: &str = "zc-host-spawned";
/// Host lifecycle: a host exited or was restarted.
pub const HOST_EXITED: &str = "zc-host-exited";
/// Host→renderer task/stream realtime events (replaces TaskRealtimeBus fan-out).
pub const TASK_REALTIME: &str = "zc-task-realtime";
/// Database/index startup progressed.
pub const DATABASE_STARTUP_STATE: &str = "zc-database-startup-state";
/// An OAuth callback URL arrived via the deep-link handler.
pub const OAUTH_CALLBACK: &str = "zc-oauth-callback";
/// A payment callback URL arrived via the deep-link handler.
pub const PAYMENT_CALLBACK: &str = "zc-payment-callback";
/// CUA (computer-use) permission panel state.
pub const CUA_PERMISSION_PANEL_STATE: &str = "zc-cua-permission-panel-state";
/// Application menu should be rebuilt (locale/endpoint change).
pub const REBUILD_MENU: &str = "zc-rebuild-menu";
/// A window's renderer attached to its service session; the payload is the
/// `RendererSessionWire` from `commands/session.rs`. Distinct from
/// `zc-renderer-ready`, which is the older "the React tree mounted" signal and
/// carries no identity.
pub const RENDERER_SESSION_ATTACHED: &str = "zc-renderer-session-attached";
/// A window's renderer released its attachment on teardown (a reload). The
/// session identity in the payload is unchanged — that is the point.
pub const RENDERER_SESSION_DETACHED: &str = "zc-renderer-session-detached";
/// The user clicked a task notification; the payload is the owning `taskId`.
/// Replaces Electron's `PlatformChannels.TaskNotificationClick`.
pub const TASK_NOTIFICATION_CLICK: &str = "zc-task-notification-click";
/// The main process asked the renderer to start a new task
/// (`DesktopCommandIds.NewTask`).
pub const NEW_TASK: &str = "zc-new-task";
/// The main process asked the renderer to open the workspace picker
/// (`DesktopCommandIds.OpenWorkspace`).
pub const OPEN_WORKSPACE: &str = "zc-open-workspace";
/// The main process asked the renderer to close the active context
/// (`DesktopCommandIds.CloseActiveContext`).
pub const CLOSE_ACTIVE_CONTEXT_REQUEST: &str = "zc-close-active-context-request";
/// Remote connection lifecycle log for the calling window
/// (`RemoteConnectionRuntimeLog`). Never emitted today: the only producer,
/// `commands::session::connect_remote`, refuses — see the NO_NATIVE_EQUIV list in
/// `commands/session.rs`. The name exists so wiring a remote backend later is
/// additive rather than a wire change.
pub const REMOTE_CONNECTION_LOG: &str = "zc-remote-connection-log";
/// A remote workspace session closed (`RemoteSessionClosedEvent`). Same
/// producer caveat as `REMOTE_CONNECTION_LOG`.
pub const REMOTE_SESSION_CLOSED: &str = "zc-remote-session-closed";
/// A bot-triggered remote workspace reconnect succeeded
/// (`BotRemoteWorkspaceReconnectedEvent`). Same producer caveat.
pub const BOT_REMOTE_WORKSPACE_RECONNECTED: &str = "zc-bot-remote-workspace-reconnected";

/// Full event name list, asserted against the TypeScript mirror in
/// `src/platform/events.ts` by `tests::event_names_match_typescript_mirror`.
pub const ALL: &[&str] = &[
    RENDERER_READY,
    WINDOW_TABS_SYNCED,
    WINDOW_UNREAD_SYNCED,
    FOCUS_TAB,
    NEW_TAB,
    SHOW_CURRENT_WINDOW,
    UPDATE_STATE_CHANGED,
    APP_SETTINGS_CHANGED,
    HOST_SPAWNED,
    HOST_EXITED,
    TASK_REALTIME,
    DATABASE_STARTUP_STATE,
    OAUTH_CALLBACK,
    PAYMENT_CALLBACK,
    CUA_PERMISSION_PANEL_STATE,
    REBUILD_MENU,
    RENDERER_SESSION_ATTACHED,
    RENDERER_SESSION_DETACHED,
    TASK_NOTIFICATION_CLICK,
    NEW_TASK,
    OPEN_WORKSPACE,
    CLOSE_ACTIVE_CONTEXT_REQUEST,
    REMOTE_CONNECTION_LOG,
    REMOTE_SESSION_CLOSED,
    BOT_REMOTE_WORKSPACE_RECONNECTED,
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// The header comment above `ALL` claimed this assertion existed. It did
    /// not — nothing compared the two lists, so a rename on one side silently
    /// dropped every subscription on the other. It is real now.
    #[test]
    fn event_names_match_typescript_mirror() {
        let mirror = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/platform/events.ts");
        let source = std::fs::read_to_string(&mirror).unwrap_or_else(|e| {
            panic!("cannot read {}: {e}", mirror.display());
        });
        let mut mirrored: Vec<&str> = Vec::new();
        for line in source.lines() {
            let Some((_, value)) = line.split_once(':') else { continue };
            // `ZC_EVENTS` entries are written `KEY: "value",` — with a trailing comma,
            // because it is an object literal. The comma has to come off before the
            // closing quote or `strip_suffix('"')` never matches, which silently left
            // `mirrored` empty and made this comparison vacuously true against an
            // empty right-hand side.
            let value = value.trim().trim_end_matches(',').trim();
            let Some(quoted) = value.strip_prefix('"') else { continue };
            let Some(name) = quoted.strip_suffix('"') else { continue };
            // `ZC_EVENTS` entries are `"name": "value",`; the type alias line and
            // the object key are not both quoted values, so this only collects
            // the event strings.
            if name.starts_with("zc-") {
                mirrored.push(name);
            }
        }
        let mut expected: Vec<&str> = ALL.to_vec();
        let mut mirrored_sorted = mirrored.clone();
        mirrored_sorted.sort_unstable();
        expected.sort_unstable();
        assert_eq!(
            expected, mirrored_sorted,
            "src/platform/events.ts and src-tauri/src/events.rs must list the same event names"
        );
    }

    #[test]
    fn every_event_name_is_listed_exactly_once() {
        let mut seen = HashSet::new();
        for name in ALL {
            assert!(seen.insert(*name), "{name} is listed twice in ALL");
            assert!(name.starts_with("zc-"), "{name} must keep the zc- prefix");
        }
    }
}
