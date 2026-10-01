/**
 * TypeScript mirror of `src-tauri/src/events.rs`.
 *
 * The two lists must stay identical. `main.tsx` asserts it at startup against the
 * `zc-events` command rather than trusting this file to have been updated, so a
 * rename on either side fails loudly instead of silently dropping events.
 */
export const ZC_EVENTS = {
  RENDERER_READY: "zc-renderer-ready",
  WINDOW_TABS_SYNCED: "zc-window-tabs-synced",
  WINDOW_UNREAD_SYNCED: "zc-window-unread-synced",
  FOCUS_TAB: "zc-focus-tab",
  NEW_TAB: "zc-new-tab",
  SHOW_CURRENT_WINDOW: "zc-show-current-window",
  UPDATE_STATE_CHANGED: "zc-update-state-changed",
  APP_SETTINGS_CHANGED: "zc-app-settings-changed",
  HOST_SPAWNED: "zc-host-spawned",
  HOST_EXITED: "zc-host-exited",
  TASK_REALTIME: "zc-task-realtime",
  DATABASE_STARTUP_STATE: "zc-database-startup-state",
  OAUTH_CALLBACK: "zc-oauth-callback",
  PAYMENT_CALLBACK: "zc-payment-callback",
  CUA_PERMISSION_PANEL_STATE: "zc-cua-permission-panel-state",
  RENDERER_SESSION_ATTACHED: "zc-renderer-session-attached",
  RENDERER_SESSION_DETACHED: "zc-renderer-session-detached",
  TASK_NOTIFICATION_CLICK: "zc-task-notification-click",
  NEW_TASK: "zc-new-task",
  OPEN_WORKSPACE: "zc-open-workspace",
  CLOSE_ACTIVE_CONTEXT_REQUEST: "zc-close-active-context-request",
  REMOTE_CONNECTION_LOG: "zc-remote-connection-log",
  REMOTE_SESSION_CLOSED: "zc-remote-session-closed",
  BOT_REMOTE_WORKSPACE_RECONNECTED: "zc-bot-remote-workspace-reconnected",
  REBUILD_MENU: "zc-rebuild-menu",
} as const;

export type ZcEventName = (typeof ZC_EVENTS)[keyof typeof ZC_EVENTS];
