/* eslint-disable max-lines -- Communication channels and request/response mappings must be defined centrally so channel strings don't scatter across processes. */
import type {
  ResourceUsageSnapshot,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./index.js";
import type { OAuthStateRegistration } from "./oauth.js";
import type { AppSettings } from "./protocol.js";
import type { StorageCleanRequest, StorageCleanResult, StorageUsageSnapshot } from "./storage.js";
import type {
  ArmsCustomEventPayload,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
  RendererTelemetryEventPayload,
  TelemetryRendererContext,
} from "./telemetry.js";
import type {
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
} from "./rendererActionTrace.js";
import type { RendererHeapSample } from "./validation.js";
import type {
  CancelPendingRemoteConnectionRequest,
  BindRemoteWorkspaceSessionContextRequest,
  BotRemoteWorkspaceReconnectedEvent,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewViewportChangedPayload,
  ConnectRemoteRequest,
  DesktopCommandId,
  DesktopTitleBarTheme,
  EmbeddedBrowserOpenUrlRequest,
  EditorInfo,
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  OpenInEditorOptions,
  PostUpdateReleaseNotesPayload,
  RemoteSessionClosedEvent,
  SSHConfigAliasOption,
  TaskNotificationPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  DesktopZoomState,
  DesktopWindowChromeState,
  WindowControlsOverlayMetrics,
  WindowControlsOverlayReadyPayload,
} from "./platform.js";
import type { BrowserViewportSize } from "./browser-use/command-metadata.js";
import type {
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";

// ============================================================================
// RPC service channel - transmitted through ChannelServer/ChannelClient
// ============================================================================

/** RPC service channel names. Correspond to `ServiceDescriptor.channelName`. */
export const ServiceChannels = {
  File: "file",
  MediaPreview: "media-preview",
  System: "system",
  Terminal: "terminal",
  /** Git service */
  Git: "git",
  /** Git checkpoint service */
  GitCheckpoint: "git-checkpoint",
  Setting: "setting",
  /** Credential management (migrated from main IPC to host RPC) */
  Credential: "credential",
  /** Computer Use Helper macOS permission service */
  CuaPermission: "cua-permission",
  /** producer-owned PiP session presentation client */
  CuaPipSession: "cua-pip-session",
  /** Cross-window broadcast */
  Broadcast: "broadcast",
  /** ZCode task wrapper service */
  ZCodeTask: "zcode-task",
  /** Window Host: aggregates workspace/task projections and routes list writes */
  WindowController: "window-controller",
  /** ZCode Protocol agent service */
  ZCodeAgent: "zcode-agent",
  /** ZCode session application service */
  ZCodeSession: "zcode-session",
  /** Orchestrates session share publishing, preview, and the continuation API */
  ConversationShare: "conversation-share",
  /** File system watcher service */
  FileWatcher: "file-watcher",
  /** OAuth authentication service */
  OAuth: "oauth",
  /** Settings read/write facade for the new Provider Config */
  ProviderSettings: "provider-settings",
  /** Model selection facade for the new Provider Registry */
  ModelSelection: "model-selection",
  /** Provider Provisioning target inside a remote Environment */
  ProviderProvisioningTarget: "provider-provisioning-target",
  /** Local usage stats service */
  UsageStats: "usage-stats",
  /** Coding Plan subscription purchase service */
  CodingPlanSubscription: "coding-plan-subscription",
  ClientConfig: "client-config",
  /** ZCode client scene configuration service */
  ClientScenes: "client-scenes",
  /** Skills management service */
  Skills: "skills",
  /** SSH remote skills sync service */
  SkillSync: "skill-sync",
  /** SSH remote MCP sync service */
  McpSync: "mcp-sync",
  /** SSH remote plugin sync service */
  PluginSync: "plugin-sync",
  /** Plugin management service */
  Plugins: "plugins",
  /** Settings-page plugin management service (UI platform capability surface consolidated; no longer talks to zcodeAgentService directly) */
  PluginManagement: "plugin-management",
  /** Subagents management service */
  Subagents: "subagents",
  /** Commands management service */
  Commands: "commands",
  /** Hooks management service */
  Hooks: "hooks",
  /** First-launch settings sync service */
  SettingsSync: "settings-sync",
  /** Bots remote chat control service */
  Bots: "bots",
  /** User feedback ticket service */
  Feedback: "feedback",
  /** Pre-transfer service for Composer attachments between host-local and remote runtime */
  PromptAttachmentTransfer: "prompt-attachment-transfer",
  /** Off-peak task management service (a service surface separate from automation) */
  OffPeakTask: "off-peak-task",
  /** Onboarding completion record service (persisted locally, uploaded to the server later) */
  OnboardingRecord: "onboarding-record",
} as const;

export type ServiceChannelName = (typeof ServiceChannels)[keyof typeof ServiceChannels];

// ============================================================================
// Platform Channel - Operations that only the Desktop main process can handle (Electron IPC)
// ============================================================================

/** Electron IPC channel names. Used only between preload ↔ main. */
export const PlatformChannels = {
  /** Open the system directory picker */
  SelectDirectory: "zcode:select-directory",
  /** Open the system file picker */
  SelectFile: "zcode:select-file",
  /** Open the system multi-file picker */
  SelectFiles: "zcode:select-files",
  /** Renderer → Main: write a temporary text attachment into the host's `~/.zcode` */
  CreateTempTextAttachment: "zcode:create-temp-text-attachment",
  /** Renderer → Main: save a file through the native save-as dialog */
  SaveFile: "zcode:save-file",
  /** Renderer → Main: export the current page's print-media layout to PDF with the Chromium print engine */
  PrintToPdf: "zcode:print-to-pdf",
  /** Main → Renderer: forward remote connection progress logs */
  RemoteConnectionLog: "zcode:remote-connection-log",
  /** Main → Renderer: the remote workspace session has closed */
  RemoteSessionClosed: "zcode:remote-session-closed",
  /** Main → Renderer: the Bot-triggered remote workspace reconnect succeeded */
  BotRemoteWorkspaceReconnected: "zcode:bot-remote-workspace-reconnected",
  /** Check whether the directory is already open in another window; if so, activate that window */
  ActivateOrSetWorkspace: "zcode:activate-or-set-workspace",
  /** Establish an SSH remote connection */
  ConnectRemote: "zcode:connect-remote",
  /** Cancel the remote connection currently in progress for this window */
  CancelPendingRemoteConnection: "zcode:cancel-pending-remote-connection",
  /** Renderer → Main: bind the canonical workspace context of a remote logical session */
  BindRemoteWorkspaceSessionContext: "zcode:bind-remote-workspace-session-context",
  /** Release the remote session held by the current window */
  DisposeRemoteSession: "zcode:dispose-remote-session",
  /** Renderer → Main: list the SSH config aliases that can be used to fill the form quickly */
  ListSSHConfigAliases: "zcode:list-ssh-config-aliases",
  /** Renderer → Main: load the CLI MCP config from the user directory */
  LoadMcpFromUserDirectory: "zcode:load-mcp-from-user-directory",
  /** Renderer → Main: save the CLI MCP config to the user directory */
  SaveMcpToUserDirectory: "zcode:save-mcp-to-user-directory",
  /** Forward renderer logs to the main process for centralized storage */
  Log: "zcode:log",
  /** Renderer → Main: sync the workspace paths of every tab in the current window */
  SyncWindowTabs: "zcode:sync-window-tabs",
  /** Renderer → Main: sync the unread task count for the current window */
  SyncWindowUnreadCount: "zcode:sync-window-unread-count",
  /** Renderer → Main: the active task of the current window; only updates Main's temporary focus mapping. */
  SyncActiveTaskSession: "zcode:sync-active-task-session",
  /** Renderer → Main: sync the app settings Main must observe immediately */
  SyncAppSettings: "zcode:sync-app-settings",
  /** Renderer → Main: recording-mode toggle for the shortcut settings page; true = main temporarily removes the configurable menu accelerator */
  SetShortcutRecordingActive: "zcode:set-shortcut-recording-active",
  /** Main → Renderer: focus the tab for the given workspace path */
  FocusTab: "zcode:focus-tab",
  /** Main → Renderer: the menu asked to create a new tab */
  NewTab: "zcode:new-tab",
  /** Main → Renderer: a menu or shortcut asked to close the current context */
  CloseActiveContextRequest: "zcode:close-active-context-request",
  /** Main → Renderer: the embedded webview asked to open a new browser tab */
  OpenBrowserUrl: "zcode:open-browser-url",
  /** Main → Renderer: the agent's first browser command built the controlled view, so tell the renderer to auto-open a browser-use tab */
  BrowserViewReady: "zcode:browser-view-ready",
  /** Main → Renderer: the agent is driving a browser-use tab; the renderer shows a temporary status icon */
  BrowserViewOperation: "zcode:browser-view-operation",
  /** Main → Renderer: the browser visibility capability shows/hides the right-hand IAB panel */
  BrowserViewVisibility: "zcode:browser-view-visibility",
  /** Main → Renderer: the Agent sets/resets the target tab's viewport */
  BrowserViewViewportChanged: "zcode:browser-view-viewport-changed",
  /** Main → Renderer: before a screenshot, ask the owner renderer to prepare an off-screen guest compositing surface. */
  BrowserViewScreenshotSurfacePrepare: "zcode:browser-view-screenshot-surface-prepare",
  /** Renderer → Main: the target guest's viewport has been stable across two consecutive animation frames. */
  BrowserViewScreenshotSurfaceReady: "zcode:browser-view-screenshot-surface-ready",
  /** Main → Renderer: the screenshot finished or preparation failed; release the temporary off-screen compositing layer. */
  BrowserViewScreenshotSurfaceRelease: "zcode:browser-view-screenshot-surface-release",
  /** Main → Renderer: after the agent close command detached the controlled guest, tell the renderer to unload the matching tab */
  BrowserViewCloseTab: "zcode:browser-view-close-tab",
  /** Main → Renderer: unload the guest on budget eviction, but keep the logical tab shell. */
  BrowserViewSuspend: "zcode:browser-view-suspend",
  /** Main → Renderer: re-mount a guest for a suspended shell. */
  BrowserViewRestore: "zcode:browser-view-restore",
  /** Main → Renderer: the menu asked to create a new task */
  NewTask: "zcode:new-task",
  /** Main → Renderer: the menu asked to open a workspace */
  OpenWorkspace: "zcode:open-workspace",
  /** Main → Renderer: a deep link opens the given local workspace directory directly */
  OpenWorkspacePath: "zcode:open-workspace-path",
  /** Main → Renderer: open the built-in feedback dialog */
  OpenFeedbackDialog: "zcode:open-feedback-dialog",
  /** Main → Renderer: open the "My Tickets" panel */
  OpenTicketsPanel: "zcode:open-tickets-panel",
  /** Main → Renderer: the window fullscreen state changed */
  WindowFullscreenChanged: "zcode:window-fullscreen-changed",
  /** Renderer → Main: read the window maximized state and the system's native rounded-corner capability */
  GetDesktopWindowChromeState: "zcode:get-desktop-window-chrome-state",
  /** Main → Renderer: the window maximized state or the system's native rounded-corner capability changed */
  DesktopWindowChromeStateChanged: "zcode:desktop-window-chrome-state-changed",
  /** Main → Renderer: the native window controls overlay safe-area insets changed */
  WindowControlsOverlayChanged: "zcode:window-controls-overlay-changed",
  /** Preload → Main: preload has synchronously read the current window controls overlay safe-area insets */
  WindowControlsOverlayReady: "zcode:window-controls-overlay-ready",
  /** Get a resource manager snapshot (CPU / memory, grouped by base services, built-in plugins, community plugins) */
  GetResourceUsageSnapshot: "zcode:get-resource-usage-snapshot",
  SetResourceUsageSamplingActive: "zcode:set-resource-usage-sampling-active",
  /** Open the resource manager window (triggered by another window) */
  OpenResourceManager: "zcode:open-resource-manager",
  /** Resource manager "Storage" tab: start scanning local `.zcode` usage (main holds StorageService, a Worker thread walks the tree) */
  StorageStartScan: "zcode:storage-start-scan",
  /** Resource manager "Storage" tab: cancel the scan */
  StorageCancelScan: "zcode:storage-cancel-scan",
  /** Resource manager "Storage" tab: read the most recent snapshot */
  StorageGetSnapshot: "zcode:storage-get-snapshot",
  /** Resource manager "Storage" tab: clean up by category */
  StorageClean: "zcode:storage-clean",
  /** Resource manager "Storage" tab: reveal a path under the data root in the system file manager */
  StorageRevealPath: "zcode:storage-reveal-path",
  /** Main → resource manager renderer: push a scan progress snapshot */
  StorageScanProgress: "zcode:storage-scan-progress",
  /** Renderer → Main: open an external URL (used to hand off to the browser for OAuth) */
  OpenExternal: "zcode:open-external",
  /** Renderer → Main: query whether a user community entry point is available in the current language */
  CanOpenCommunity: "zcode:can-open-community",
  /** Renderer → Main: open a path in the system file manager */
  OpenInFileManager: "zcode:open-in-file-manager",
  /** Renderer → Main: open a local file with the system default app */
  OpenExternalFile: "zcode:open-external-file",
  /** Renderer → Main: open the ZCode Computer Use permission onboarding */
  OpenCuaPermissionOnboarding: "zcode:open-cua-permission-onboarding",
  /** Renderer → Main: cancel one permission onboarding participant started by the current renderer */
  CancelCuaPermissionOnboarding: "zcode:cancel-cua-permission-onboarding",
  /**
   * Renderer → Main: warm up and cache the verified Helper path + bundle fingerprint.
   * Must be called when the drag floating window mounts — the dragstart path must not
   * contain any async I/O at all.
   */
  PrepareCuaHelperPermissionDrag: "zcode:prepare-cua-helper-permission-drag",
  /** Renderer → Main: drag the verified Helper.app out to the macOS permission list synchronously */
  StartCuaHelperPermissionDrag: "zcode:start-cua-helper-permission-drag",
  /**
   * Renderer → Main: the drag gesture has ended.
   * Once the drop completes the grant is done and the floating window must step aside
   * (the user now needs to see the settings page and the system restart prompt). Wait for
   * dragend instead of closing the window inside dragstart: startDrag only hands the drag
   * session to the OS and does not block, so the drag source vanishing immediately could
   * interrupt the drag that is still in progress.
   */
  NotifyCuaHelperPermissionDragEnded: "zcode:notify-cua-helper-permission-drag-ended",
  /** Renderer → Main: report the OAuth state for deep link routing */
  OAuthRegisterState: "zcode:oauth-register-state",
  /** Main → Renderer: forward the deep link URL */
  OAuthCallback: "zcode:oauth-callback",
  /** Main → Renderer: forward the payment deep link URL */
  PaymentCallback: "zcode:payment-callback",
  /** Main → Renderer: an external share page asked to import a share code. */
  ShareImport: "zcode:share-import",
  /** Renderer → Main: the OAuth callback has been handled, so the deferred startup flow may continue */
  OAuthCallbackHandled: "zcode:oauth-callback-handled",
  /** Renderer → Main: the renderer is ready and can take a cached deep link */
  RendererReady: "zcode:renderer-ready",
  /** Renderer → Main: sync the telemetry context of the current renderer */
  SyncTelemetryContext: "zcode:sync-telemetry-context",
  /** Renderer → Main: report product events through the unified telemetry layer */
  ReportTelemetryEvent: "zcode:report-telemetry-event",
  /** Renderer → Main: report an ARMS custom event */
  ReportArmsCustomEvent: "zcode:report-arms-custom-event",
  /** Renderer → Main: read the canary configuration for Renderer user-action traces. */
  GetRendererActionTraceConfig: "zcode:get-renderer-action-trace-config",
  /** Main → Renderer: the Renderer user-action trace canary configuration changed. */
  RendererActionTraceConfigChanged: "zcode:renderer-action-trace-config-changed",
  /** Renderer → Main: send a finished ui_action batch. */
  ReportRendererActionTraceBatch: "zcode:report-renderer-action-trace-batch",
  /** Renderer → Main: the main window renderer's heap reading every 60 seconds; a one-way send that needs no acknowledgement. */
  ReportRendererHeapSample: "zcode:report-renderer-heap-sample",
  ReportLocalTtftBatch: "zcode:report-local-ttft-batch",
  /** E2E preload → Main: read the in-memory ring of final `sendCustom` parameters. */
  ReadFinalArmsCustomEventsE2E: "zcode:e2e:read-final-arms-custom-events",
  /** E2E preload → Main: clear the in-memory ring of final `sendCustom` parameters. */
  ClearFinalArmsCustomEventsE2E: "zcode:e2e:clear-final-arms-custom-events",
  /** E2E preload → Main: configure real network suppression scoped to the target event name only. */
  ConfigureFinalArmsCustomEventsE2E: "zcode:e2e:configure-final-arms-custom-events",
  /** Renderer → Main: fire the system notification for task completion/failure */
  ShowTaskNotification: "zcode:show-task-notification",
  /** Main → Preload: tell the renderer to play the task notification sound */
  TaskNotificationSound: "zcode:task-notification-sound",
  /** Main → Preload: the user clicked the system notification; carries taskId so the renderer can jump to the matching task */
  TaskNotificationClick: "zcode:task-notification-click",
  /** Renderer → Main: export logs (zip up `~/.zcode/v2` plus external agent logs and reveal them in Finder) */
  ExportLogs: "zcode:export-logs",
  /** Renderer → Main: capture the current window as a feedback attachment */
  CaptureWindowScreenshot: "zcode:capture-window-screenshot",
  /**
   * Renderer → Main: report the webContentsId once the `<webview>` guest is dom-ready;
   * main attaches that guest with BrowserGuestManager (fire-and-forget). CDP-on-guest pivot.
   */
  BrowserViewAttachGuest: "zcode:browser-view-attach-guest",
  /** Renderer → Main: proactively drop the old guest's CDP before rebuilding the `<webview>`. */
  BrowserViewDetachGuest: "zcode:browser-view-detach-guest",
  /** Renderer → Main: the user explicitly closed a Browser tab. */
  BrowserViewCloseTabFromRenderer: "zcode:browser-view-close-tab-from-renderer",
  /** Renderer → Main: report Browser tab residency/display facts. */
  BrowserViewReportResidency: "zcode:browser-view-report-residency",
  /** Renderer → Main: the guest for the given generation has been unloaded. */
  BrowserViewSuspendReady: "zcode:browser-view-suspend-ready",
  /** Renderer → Main: the user visited a suspended tab and asks for a restore. */
  BrowserViewEnsureResident: "zcode:browser-view-ensure-resident",
  /** Renderer → Main: read the persisted logical shells of workspaces/tasks. */
  BrowserViewRestoreTabs: "zcode:browser-view-restore-tabs",
  /** Renderer → Main: write back the target guest viewport on free-size drag/toggle */
  BrowserViewUpdateViewport: "zcode:browser-view-update-viewport",
  /** Embedded Browser preload → Main: synchronously request a trusted system frame before the page's native dialog is created. */
  EmbeddedBrowserJavaScriptDialog: "zcode:embedded-browser-javascript-dialog",
  /** Renderer → Main: import the auto-discovered local Chrome profile data into the embedded browser partition in one shot. */
  ImportChromeBrowserData: "zcode:import-chrome-browser-data",
  /** Renderer → Main: clear the embedded browser cache or all site data. */
  ClearEmbeddedBrowserData: "zcode:clear-embedded-browser-data",
  /** Main → Renderer: notify that a new version has finished downloading and can be installed on restart */
  UpdateReady: "zcode:update-ready",
  /** Main → Renderer: the result of the user's manual "Check for Updates" (used for a toast) */
  UpdateCheckResult: "zcode:update-check-result",
  /** Main → Renderer: the ongoing auto-update state changed (used by the menu UI) */
  UpdateStateChanged: "zcode:update-state-changed",
  /** Renderer → Main: fetch the current auto-update state on demand (compensates for lost events when the menu opens) */
  GetUpdateState: "zcode:get-update-state",
  /** Renderer → Main: start downloading the currently discovered auto-update */
  DownloadUpdate: "zcode:download-update",
  /** Renderer → Main: cancel the auto-update that is currently downloading */
  CancelUpdateDownload: "zcode:cancel-update-download",
  /** Renderer → Main: open the standalone auto-update window */
  OpenUpdateStatusWindow: "zcode:open-update-status-window",
  /** Renderer → Main: read the auto-update preferences */
  GetAutoUpdatePreferences: "zcode:get-auto-update-preferences",
  /** Renderer → Main: write the "download and install updates automatically" preference */
  SetAutoDownloadAndInstallUpdates: "zcode:set-auto-download-and-install-updates",
  /** Renderer → Main: query how many sessions the desktop app is currently running */
  GetDesktopSessionActivity: "zcode:get-desktop-session-activity",
  /** Renderer → Main: read the page zoom level of the current window */
  GetDesktopZoomLevel: "zcode:get-desktop-zoom-level",
  /** Main → Renderer: the page zoom level of the current window changed */
  DesktopZoomLevelChanged: "zcode:desktop-zoom-level-changed",
  /** Renderer → Main: read the dev-mode stdio tap proxy toggle state */
  GetZCodeStdioTapDevState: "zcode:get-zcode-stdio-tap-dev-state",
  /** Main → Renderer: the local setting.json has been updated by the main process */
  SettingsChanged: "zcode:settings-changed",
  /** Main → Renderer: the release notes shown after the update has been installed */
  PostUpdateReleaseNotes: "zcode:post-update-release-notes",
  /** Renderer → Main: acknowledge that the release notes have been read */
  AcknowledgePostUpdateReleaseNotes: "zcode:ack-post-update-release-notes",
  /** Renderer → Main: skip the currently discovered auto-update version */
  SkipUpdateVersion: "zcode:skip-update-version",
  /** Renderer → Main: the user confirmed restarting to install the update */
  QuitAndInstallUpdate: "zcode:quit-and-install-update",
  /** Renderer → Main: get the list of editors/terminals installed on the system (with icons) */
  GetInstalledEditors: "zcode:get-installed-editors",
  /** Renderer → Main: get a system application icon by bundle id */
  GetApplicationIcon: "zcode:get-application-icon",
  /** Renderer → Main: open a path with the given editor */
  OpenInEditor: "zcode:open-in-editor",
  /** Renderer → Main: execute a desktop window-level command */
  ExecuteDesktopCommand: "zcode:execute-desktop-command",
  /** Renderer → Main: sync the title bar light/dark theme, used to tint the native window control buttons */
  SetTitleBarTheme: "zcode:set-title-bar-theme",
  /** Renderer → Main: migrate the legacy Common MCP config */
  MigrateLegacyCommonMcp: "zcode:migrate-legacy-common-mcp",
  /** Renderer → Main: get the stable identifier of the current device (deviceMid) */
  GetDeviceId: "zcode:get-device-id",
} as const;

export type PlatformChannelName = (typeof PlatformChannels)[keyof typeof PlatformChannels];

// ============================================================================
// Built-in WebView channel - fixed guest preload ↔ embedder renderer
// ============================================================================

/** `sendToHost` / `ipc-message` channels of the Electron `<webview>`; these bypass the main process. */
export const EmbeddedBrowserWebviewChannels = {
  /** When the guest can no longer consume scrolling in one direction, hand the 2D delta to the free-size canvas. */
  WheelBoundary: "zcode:embedded-browser-wheel-boundary",
} as const;

export interface EmbeddedBrowserWheelBoundaryPayload {
  deltaX: number;
  deltaY: number;
}

// ============================================================================
// Coding Plan WebView channel ——Official website preload ↔ App renderer
// ============================================================================

/**
 * `sendToHost` / `ipc-message` channels of the Electron `<webview>` (partition=persist:zcode-coding-plan).
 * The website calls them through the preload-injected window.zcodeBridge, without the main process.
 */
export const CodingPlanWebviewChannels = {
  /** The website tells the App to refresh entitlements and close the webview after a successful purchase. */
  PurchaseComplete: "zcode:coding-plan-purchase-complete",
} as const;

/** Payload returned once a purchase completes. `provider` is structurally identical to the website's CodingPlanProvider / auth-ready event `detail.provider`. */
export interface CodingPlanPurchaseCompletePayload {
  provider: "zai" | "bigmodel";
  /** Client-side timestamp, used for App-side dedup/logging; it does not take part in the equality check. */
  timestamp: number;
}

/**
 * Values of the website's window.__zcodeLang__, matching the Locale of the App's IntlProvider.
 * When the App locale changes it rewrites this variable via executeJavaScript and dispatches a lang-change event.
 */
export type CodingPlanWebviewLocale = "en-US";

/**
 * detail of the website's lang-change event. The App uses executeJavaScript to dispatch a
 * `zcode-coding-plan-lang-change` CustomEvent in the main world; the website side
 * (zcodeBridge.onLangChange or a plain window.addEventListener) switches copy once it subscribes.
 */
export interface CodingPlanWebviewLangChangeDetail {
  locale: CodingPlanWebviewLocale;
}

// ============================================================================
// Internal transport channel - frame level communication
// ============================================================================
/** Internal transport channels. Used for framework-level communication such as MessagePort forwarding. */
export const InternalChannels = {
  DatabaseStartupState: "zcode:database-startup-state",
  DatabaseStartupControl: "zcode:database-startup-control",
  /** main → renderer: forwards a MessagePort (via webContents.postMessage) */
  ServicePort: "zcode:service-port",
  /** main → renderer: forwards a window Host's scoped MessagePort */
  ScopedServicePort: "zcode:scoped-service-port",
  /** renderer → main: the scoped MessagePort is registered, so the attachment can be switched safely */
  ScopedServicePortReady: "zcode:scoped-service-port-ready",
  /** preload → renderer: the main process has confirmed the system notification was shown, so the renderer may play the sound */
  TaskNotificationSound: "zcode:task-notification-sound",
} as const;

/** @deprecated `/ws` ignores this header; the constant is kept only for compatibility with older clients. */
export const ZCODE_RPC_CLIENT_MODE_HEADER = "x-zcode-rpc-client-mode";
/** desktop obtains it first from a protected HTTP endpoint, then consumes it once during the `/ws/host` handshake. */
export const ZCODE_RPC_HOST_CAPABILITY_HEADER = "x-zcode-rpc-host-capability";

// ============================================================================
// Inter-process message type - postMessage between main ↔ host process
// ============================================================================

/** Initialization message types sent from main → host process */
export const HostMessageTypes = {
  DatabaseStartupControl: "database-startup-control",
  /** Initialize local services */
  InitLocal: "init-local",
  /** main → window Host: establish a remote logical session in the current window */
  ConnectRemoteWorkspace: "connect-remote-workspace",
  /** main → window Host: cancel a remote connection that has not completed yet */
  CancelRemoteWorkspaceConnect: "cancel-remote-workspace-connect",
  /** main → window Host: bind a canonical workspace identity to the logical session */
  BindRemoteWorkspaceContext: "bind-remote-workspace-context",
  /** main → window Host: release a remote logical session */
  DisposeRemoteWorkspaceSession: "dispose-remote-workspace-session",
  /** main → host: expose existing services over a new RPC MessagePort */
  AttachServicePort: "attach-service-port",
  /** main → host: release exactly one RPC MessagePort attachment */
  DetachServicePort: "detach-service-port",
  /** The window closed; clean up resources */
  Dispose: "dispose",
  /** Broadcast message relay */
  Broadcast: "broadcast",
  /** main → host: cross-window atomic claim result */
  BroadcastClaimResult: "broadcast-claim-result",
  /** main → host: task realtime invalidation delivery */
  TaskRealtimeDeliver: "task-realtime-deliver",
  /** main → host: task run lease acquire result */
  TaskRunLeaseResult: "task-run-lease-result",
  /** main → host: deliver owner-only task command */
  TaskOwnerCommandDeliver: "task-owner-command-deliver",
  /** main → host: deliver owner command result to requester */
  TaskOwnerCommandResult: "task-owner-command-result",
  /** main → host: Bot remote workspace reconnect result */
  BotRemoteWorkspaceReconnectResult: "bot-remote-workspace-reconnect-result",
  /** main → host: Bot remote workspace connection status query result */
  BotRemoteWorkspaceConnectionStatusResult: "bot-remote-workspace-connection-status-result",
  /** main → host: Bot remote workspace runtime RPC port */
  BotRemoteWorkspaceRuntimePort: "bot-remote-workspace-runtime-port",
  /** main → host: deliver a session message to the target session managed by that host */
  SessionMessageDeliver: "session-message-deliver",
  /** main → host: write the session message delivery result back to the source session */
  SessionMessageDeliveryResult: "session-message-delivery-result",
  /** main → host: feedback log archive creation result */
  FeedbackLogArchiveResult: "feedback-log-archive-result",
  /** main → host: a scheduled (cron) task is due for dispatch; a cron inside a session reuses targetTaskId, and only unbound legacy tasks get a new session */
  CronRun: "cron-run",
  /** main → host: off-peak task dispatch; the first run creates a session via createTask, later runs resume with conversationId/sessionId */
  OffPeakRun: "off-peak-run",
  /** main → host: browser-use command result (returned once CDP finishes, correlated by requestId) */
  BrowserExecuteResult: "browser-execute-result",
  /** main → host: authorization result for a local video canonical path */
  LocalMediaPreviewPathAuthorizeResult: "local-media-preview-path-authorize-result",
  /** Main → Host: producer focus fact derived from the globally focused foreground ZCode window. */
  CuaPipFocusChanged: "cua-pip-focus-changed",
  /** main → host: ask the Host to read the local Source now and sync the given Remote Environment. */
  ProviderProvisioningExecute: "provider-provisioning-execute",
  /** main → host: the resource manager asks the Host to sample the CPU and memory of its child processes (Agent / MCP / terminal) */
  ResourceUsageSnapshotRequest: "resource-usage-snapshot-request",
  ResourceUsageSnapshotCancel: "resource-usage-snapshot-cancel",
} as const;

/** Response message types sent from host process → main process */
export const HostResponseTypes = {
  DatabaseStartupState: "database-startup-state",
  /** window Host → main: report remote connection progress logs keyed by requestId */
  RemoteWorkspaceConnectionLog: "remote-workspace-connection-log",
  /** window Host → main: the remote logical session is established */
  RemoteWorkspaceConnected: "remote-workspace-connected",
  /** window Host → main: establishing the remote logical session failed */
  RemoteWorkspaceConnectFailed: "remote-workspace-connect-failed",
  /** window Host → main: a connected remote logical session closed */
  RemoteWorkspaceClosed: "remote-workspace-closed",
  /** Log report from a host process */
  Log: "log",
  /** A new agent child process was spawned inside the host */
  AgentProcessSpawned: "agent-process-spawned",
  /** The agent runtime inside the host passed the model execution gate for the first time */
  AgentProcessReady: "agent-process-ready",
  /** An agent child process inside the host exited */
  AgentProcessExited: "agent-process-exited",
  /** An agent child process inside the host failed to start */
  AgentProcessError: "agent-process-error",
  AgentProcessException: "agent-process-exception",
  /** host → main: CPU / RSS self-sampled inside the CLI process */
  AgentResourceSample: "agent-resource-sample",
  /** host → main: CPU / RSS / heap self-sampled by the Host process itself every 60 seconds (the heap source for the host role in resource telemetry) */
  HostResourceSample: "host-resource-sample",
  /** host → main: lifecycle and memory telemetry of MCP processes inside the CLI */
  McpTelemetry: "mcp-telemetry",
  McpResourceSamples: "mcp-resource-samples",
  ToolExecResource: "tool-exec-resource",
  /** An automation Host reports a newly created Session once its first input is accepted. */
  SessionCreateTelemetry: "session-create-telemetry",
  /** host → main: resource manager sampling result (correlated by requestId) */
  ResourceUsageSnapshotResult: "resource-usage-snapshot-result",
  /** The number of agent sessions inside the host that are currently executing a prompt changed */
  AgentRunningTaskCountChanged: "agent-running-task-count-changed",
  /** The number of tasks in the given workspace inside the host that have not yet reached a terminal state changed */
  WorkspaceRunningTaskCountChanged: "workspace-running-task-count-changed",
  /** host → main: the operation-hint state of a Windows desktop-local CUA turn */
  CuaOperationState: "cua-operation-state",
  /** host → main: the workspace generation is now safe to attach */
  RemoteWorkspaceAcquired: "remote-workspace-acquired",
  /** Broadcast message */
  Broadcast: "broadcast",
  /** host → main: request a cross-window atomic claim */
  BroadcastClaimRequest: "broadcast-claim-request",
  /** host → main: commit a temporary claim reservation into a permanent claim */
  BroadcastClaimCommit: "broadcast-claim-commit",
  /** host → main: release an uncommitted claim reservation by token */
  BroadcastClaimRelease: "broadcast-claim-release",
  /** host → main: publish a task realtime invalidation */
  TaskRealtimePublish: "task-realtime-publish",
  /** host → main: publish a task stream mirror op */
  TaskStreamOpPublish: "task-stream-op-publish",
  /** host → main: request a task run lease */
  TaskRunLeaseAcquire: "task-run-lease-acquire",
  /** host → main: release a task run lease */
  TaskRunLeaseRelease: "task-run-lease-release",
  /** host → main: an observer asks the owner to execute a task command */
  TaskOwnerCommandRequest: "task-owner-command-request",
  /** host → main: the owner returns a task command result */
  TaskOwnerCommandResult: "task-owner-command-result",
  /** host → main: the Bot asks to create a remote workspace session */
  BotRemoteWorkspaceReconnectRequest: "bot-remote-workspace-reconnect-request",
  /** host → main: the Bot asks whether the current window already has a remote workspace session */
  BotRemoteWorkspaceConnectionStatusRequest: "bot-remote-workspace-connection-status-request",
  /** host → main: the Bot asks for the remote workspace runtime RPC port */
  BotRemoteWorkspaceRuntimePortRequest: "bot-remote-workspace-runtime-port-request",
  /** host → main: the Agent asks to send a message to another session */
  SessionMessageSendRequested: "session-message-send-requested",
  /** host → main: declare that a ZCode Agent session currently belongs to this host */
  SessionRouteAnnounce: "session-route-announce",
  /** host → main: the target host finished delivering a local session message */
  SessionMessageDeliverResult: "session-message-deliver-result",
  /** host → main: ask main to reuse its log-export logic to create a feedback log archive */
  FeedbackLogArchiveRequest: "feedback-log-archive-request",
  /** host → main: scheduled (cron) task dispatch result (success fills in taskId/sessionId, failure carries transient/permanent) */
  CronRunResult: "cron-run-result",
  /** host → main: off-peak task dispatch result (success fills in conversationId/sessionId, failure carries transient/permanent) */
  OffPeakRunResult: "off-peak-run-result",
  /** host → main: the manual run is persisted; wake the scheduler immediately so it can claim the dispatch */
  CronSchedulerWakeRequest: "cron-scheduler-wake-request",
  /** host → main: an off-peak task just became schedulable; wake the scheduler immediately so it can claim the dispatch (independent of the cron message) */
  OffPeakSchedulerWakeRequest: "off-peak-scheduler-wake-request",
  /** host → main: execute one browser-use command (main runs it via WebContentsView+CDP, correlated by requestId) */
  BrowserExecuteRequest: "browser-execute-request",
  /** host → main: request authorization for a local video path the Agent has already precisely validated */
  LocalMediaPreviewPathAuthorizeRequest: "local-media-preview-path-authorize-request",
  /** host → main: RPC network telemetry batch (channel.command success rate / latency) */
  NetworkTelemetryBatch: "network-telemetry-batch",
  /** host → main: the local Provisioning Source was persisted successfully. */
  ProviderProvisioningSourceChanged: "provider-provisioning-source-changed",
  /** host → main: one Remote Environment sync has finished executing. */
  ProviderProvisioningExecutionResult: "provider-provisioning-execution-result",
} as const;

// ============================================================================
// Platform channel type mapping - request/response type safety
// ============================================================================

/** Request/response type mappings for the platform channels */
export interface PlatformChannelMap {
  [PlatformChannels.SelectDirectory]: {
    request: void;
    response: string | null;
  };
  [PlatformChannels.SelectFile]: {
    request: void;
    response: string | null;
  };
  [PlatformChannels.SelectFiles]: {
    request: void;
    response: string[];
  };
  [PlatformChannels.CreateTempTextAttachment]: {
    request: CreateTempTextAttachmentRequest;
    response: CreateTempTextAttachmentResult;
  };
  [PlatformChannels.SaveFile]: {
    request: SaveFileRequest;
    response: SaveFileResult;
  };
  [PlatformChannels.PrintToPdf]: {
    request: void;
    response: PrintPageToPdfResult;
  };
  [PlatformChannels.RemoteConnectionLog]: {
    request: {
      label: string;
      requestId?: string;
      sessionId?: string;
      level: "info" | "warn" | "error";
      source: string;
      message: string;
      timestamp: string;
    };
    response: void;
  };
  [PlatformChannels.RemoteSessionClosed]: {
    request: RemoteSessionClosedEvent;
    response: void;
  };
  [PlatformChannels.BotRemoteWorkspaceReconnected]: {
    request: BotRemoteWorkspaceReconnectedEvent;
    response: void;
  };
  [PlatformChannels.ActivateOrSetWorkspace]: {
    request: string;
    response: { activated: boolean };
  };
  [PlatformChannels.OpenWorkspacePath]: {
    request: string;
    response: void;
  };
  [PlatformChannels.ConnectRemote]: {
    request: ConnectRemoteRequest;
    response: { success: boolean; error?: string; sessionId?: string };
  };
  [PlatformChannels.CancelPendingRemoteConnection]: {
    request: CancelPendingRemoteConnectionRequest;
    response: void;
  };
  [PlatformChannels.BindRemoteWorkspaceSessionContext]: {
    request: BindRemoteWorkspaceSessionContextRequest;
    response: void;
  };
  [PlatformChannels.DisposeRemoteSession]: {
    request: string;
    response: void;
  };
  [PlatformChannels.ListSSHConfigAliases]: {
    request: void;
    response: SSHConfigAliasOption[];
  };
  [PlatformChannels.LoadMcpFromUserDirectory]: {
    request: LoadCliMcpFromUserDirectoryRequest;
    response: LoadCliMcpFromUserDirectoryResult;
  };
  [PlatformChannels.SaveMcpToUserDirectory]: {
    request: SaveCliMcpToUserDirectoryRequest;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.MigrateLegacyCommonMcp]: {
    request: MigrateLegacyCommonMcpRequest;
    response: MigrateLegacyCommonMcpResult;
  };
  [PlatformChannels.Log]: {
    request: { level: "info" | "warn" | "error"; args: unknown[] };
    response: void;
  };
  [PlatformChannels.SyncWindowUnreadCount]: {
    request: number;
    response: void;
  };
  [PlatformChannels.SyncAppSettings]: {
    request: Partial<AppSettings>;
    response: void;
  };
  [PlatformChannels.GetResourceUsageSnapshot]: {
    request: void;
    response: ResourceUsageSnapshot;
  };
  [PlatformChannels.SetResourceUsageSamplingActive]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.StorageStartScan]: {
    request: void;
    response: { jobId: string };
  };
  [PlatformChannels.StorageCancelScan]: {
    request: string;
    response: void;
  };
  [PlatformChannels.StorageGetSnapshot]: {
    request: void;
    response: StorageUsageSnapshot | null;
  };
  [PlatformChannels.StorageClean]: {
    request: StorageCleanRequest;
    response: StorageCleanResult;
  };
  [PlatformChannels.StorageRevealPath]: {
    request: string;
    response: void;
  };
  [PlatformChannels.OpenExternal]: {
    request: string;
    response: void;
  };
  [PlatformChannels.OpenBrowserUrl]: {
    request: EmbeddedBrowserOpenUrlRequest;
    response: void;
  };
  [PlatformChannels.BrowserViewReady]: {
    request: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewVisibility]: {
    request: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewViewportChanged]: {
    request: BrowserViewViewportChangedPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfacePrepare]: {
    request: BrowserViewScreenshotSurfacePreparePayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfaceReady]: {
    request: BrowserViewScreenshotSurfaceReadyPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfaceRelease]: {
    request: BrowserViewScreenshotSurfaceReleasePayload;
    response: void;
  };
  [PlatformChannels.BrowserViewCloseTab]: {
    request: BrowserViewCloseTabNotification;
    response: void;
  };
  [PlatformChannels.BrowserViewSuspend]: {
    request: BrowserViewResidencyTransitionPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewRestore]: {
    request: BrowserViewResidencyTransitionPayload;
    response: void;
  };
  [PlatformChannels.CanOpenCommunity]: {
    request: "en-US";
    response: boolean;
  };
  [PlatformChannels.OpenInFileManager]: {
    request: string;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.OpenExternalFile]: {
    request: string;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.OpenCuaPermissionOnboarding]: {
    request: OpenCuaPermissionOnboardingOptions | undefined;
    response: CuaAccessibilitySettingsResult;
  };
  [PlatformChannels.PrepareCuaHelperPermissionDrag]: {
    request: undefined;
    response: PrepareCuaHelperPermissionDragResult;
  };
  // One-way send (not invoke): dragstart must be initiated synchronously and cannot wait for the round trip of invoke.
  [PlatformChannels.StartCuaHelperPermissionDrag]: {
    request: undefined;
    response: void;
  };
  [PlatformChannels.NotifyCuaHelperPermissionDragEnded]: {
    request: undefined;
    response: void;
  };
  [PlatformChannels.CancelCuaPermissionOnboarding]: {
    request: { operationId: string };
    response: void;
  };
  [PlatformChannels.OAuthRegisterState]: {
    request: OAuthStateRegistration;
    response: void;
  };
  [PlatformChannels.OAuthCallback]: {
    request: string;
    response: void;
  };
  [PlatformChannels.PaymentCallback]: {
    request: string;
    response: void;
  };
  [PlatformChannels.ShareImport]: {
    request: { shareCode: string };
    response: void;
  };
  [PlatformChannels.OAuthCallbackHandled]: {
    request: void;
    response: void;
  };
  [PlatformChannels.RendererReady]: {
    request: void;
    response: void;
  };
  [PlatformChannels.SyncTelemetryContext]: {
    request: TelemetryRendererContext;
    response: void;
  };
  [PlatformChannels.ReportTelemetryEvent]: {
    request: RendererTelemetryEventPayload;
    response: void;
  };
  [PlatformChannels.ReportArmsCustomEvent]: {
    request: ArmsCustomEventPayload;
    response: void;
  };
  [PlatformChannels.GetRendererActionTraceConfig]: {
    request: void;
    response: RendererActionTraceConfigV1;
  };
  [PlatformChannels.RendererActionTraceConfigChanged]: {
    request: RendererActionTraceConfigV1;
    response: void;
  };
  [PlatformChannels.ReportRendererActionTraceBatch]: {
    request: RendererActionTraceBatchV1;
    response: void;
  };
  // One-way send (not invoke): 60 seconds of bypass telemetry samples, renderer does not wait for main receipt.
  [PlatformChannels.ReportRendererHeapSample]: {
    request: RendererHeapSample;
    response: void;
  };
  [PlatformChannels.ReadFinalArmsCustomEventsE2E]: {
    request: void;
    response: FinalArmsCustomEventE2EEntry[];
  };
  [PlatformChannels.ClearFinalArmsCustomEventsE2E]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ConfigureFinalArmsCustomEventsE2E]: {
    request: ConfigureFinalArmsCustomEventE2ERequest;
    response: void;
  };
  [PlatformChannels.ShowTaskNotification]: {
    request: TaskNotificationPayload;
    response: void;
  };
  [PlatformChannels.TaskNotificationSound]: {
    request: void;
    response: void;
  };
  [PlatformChannels.TaskNotificationClick]: {
    request: string;
    response: void;
  };
  [PlatformChannels.WindowFullscreenChanged]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.GetDesktopWindowChromeState]: {
    request: void;
    response: DesktopWindowChromeState;
  };
  [PlatformChannels.DesktopWindowChromeStateChanged]: {
    request: DesktopWindowChromeState;
    response: void;
  };
  [PlatformChannels.WindowControlsOverlayChanged]: {
    request: WindowControlsOverlayMetrics;
    response: void;
  };
  [PlatformChannels.WindowControlsOverlayReady]: {
    request: WindowControlsOverlayReadyPayload;
    response: void;
  };
  [PlatformChannels.ExportLogs]: {
    request: void;
    response: { success: boolean; path?: string; error?: string };
  };
  [PlatformChannels.CaptureWindowScreenshot]: {
    request: void;
    response: {
      dataBase64: string;
      filename: string;
      contentType: string;
      size: number;
    } | null;
  };
  // CDP-on-guest pivot: renderer `<webview>` reports guest webContentsId → main attach.
  [PlatformChannels.BrowserViewAttachGuest]: {
    request: {
      key: string;
      webContentsId: number;
      active?: boolean;
      workspaceKey?: string;
      remoteSessionId?: string;
      sessionId?: string;
      residencyGeneration?: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewDetachGuest]: {
    request: { key: string; webContentsId: number };
    response: boolean;
  };
  [PlatformChannels.BrowserViewCloseTabFromRenderer]: {
    request: BrowserViewCloseTabRequest;
    response: void;
  };
  [PlatformChannels.BrowserViewReportResidency]: {
    request: BrowserViewResidencyReportPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewSuspendReady]: {
    request: { tabId: string; generation: number };
    response: void;
  };
  [PlatformChannels.BrowserViewEnsureResident]: {
    request: BrowserViewCloseTabRequest;
    response: void;
  };
  [PlatformChannels.BrowserViewRestoreTabs]: {
    request: BrowserViewRestoreTabsRequest;
    response: BrowserViewRestoredTabShell[];
  };
  [PlatformChannels.BrowserViewUpdateViewport]: {
    request: { tabId: string; viewport: BrowserViewportSize | null };
    response: void;
  };
  [PlatformChannels.EmbeddedBrowserJavaScriptDialog]: {
    request: {
      type: "alert" | "confirm";
      message: string;
    };
    response: {
      handled: boolean;
      value?: boolean;
    };
  };
  [PlatformChannels.UpdateReady]: {
    request: string;
    response: void;
  };
  [PlatformChannels.UpdateCheckResult]: {
    request: UpdateCheckResultPayload;
    response: void;
  };
  [PlatformChannels.UpdateStateChanged]: {
    request: UpdateStatePayload;
    response: void;
  };
  [PlatformChannels.GetUpdateState]: {
    request: void;
    response: UpdateStatePayload;
  };
  [PlatformChannels.DownloadUpdate]: {
    request: void;
    response: void;
  };
  [PlatformChannels.CancelUpdateDownload]: {
    request: void;
    response: void;
  };
  [PlatformChannels.OpenUpdateStatusWindow]: {
    request: void;
    response: void;
  };
  [PlatformChannels.GetAutoUpdatePreferences]: {
    request: void;
    response: {
      autoDownloadAndInstallUpdates: boolean;
    };
  };
  [PlatformChannels.SetAutoDownloadAndInstallUpdates]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.SettingsChanged]: {
    request: void;
    response: void;
  };
  [PlatformChannels.GetDesktopSessionActivity]: {
    request: void;
    response: {
      runningAgentSessionCount: number;
    };
  };
  [PlatformChannels.GetDesktopZoomLevel]: {
    request: void;
    response: DesktopZoomState;
  };
  [PlatformChannels.DesktopZoomLevelChanged]: {
    request: DesktopZoomState;
    response: void;
  };
  [PlatformChannels.PostUpdateReleaseNotes]: {
    request: PostUpdateReleaseNotesPayload;
    response: void;
  };
  [PlatformChannels.AcknowledgePostUpdateReleaseNotes]: {
    request: string;
    response: void;
  };
  [PlatformChannels.SkipUpdateVersion]: {
    request: string;
    response: void;
  };
  [PlatformChannels.QuitAndInstallUpdate]: {
    request: void;
    response: void;
  };
  [PlatformChannels.GetInstalledEditors]: {
    request: void;
    response: EditorInfo[];
  };
  [PlatformChannels.GetApplicationIcon]: {
    request: string | import("./platform.js").ApplicationIconRequest;
    response: import("./platform.js").ApplicationIconInfo | null;
  };
  [PlatformChannels.OpenInEditor]: {
    request: { editorId: string; path: string; options?: OpenInEditorOptions };
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.CloseActiveContextRequest]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ExecuteDesktopCommand]: {
    request: DesktopCommandId;
    // The return value goes directly to the return of the main process handler (GetCuaOsSupport returns CuaOsSupport),
    // Aligned with the Promise<unknown> of IPlatformService.executeDesktopCommand on the renderer side.
    response: unknown;
  };
  [PlatformChannels.SetTitleBarTheme]: {
    request: DesktopTitleBarTheme;
    response: void;
  };
}
