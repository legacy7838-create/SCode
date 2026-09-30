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
];
