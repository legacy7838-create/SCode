/* eslint-disable max-lines -- The cross-platform platform contract declares renderer capabilities in one place; OAuth and browser lifecycle must keep their desktop/web type contracts, so this MR does not split the platform boundary. */
import type { RemoteTarget, SSHConnectOptions, WSLConnectOptions } from "./remoteTarget.js";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./mcp.js";
import type { OAuthStateRegistration } from "./oauth.js";
import type { AppSettings } from "./protocol.js";
import type { ArmsCustomEventPayload, RendererTelemetryEventPayload } from "./telemetry.js";
import type {
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
} from "./rendererActionTrace.js";
import type { RendererHeapSample } from "./validation.js";
import type {
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";
import type { BrowserViewportSize } from "./browser-use/command-metadata.js";
import type {
  PostUpdateReleaseNotesPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
} from "./update.js";
export type {
  PostUpdateReleaseNotesPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
} from "./update.js";

export interface TaskNotificationPayload {
  taskId: string;
  status: "completed" | "failed" | "permission_request" | "elicitation_request" | "feedback_update";
  requestId?: string;
  title: string;
  body: string;
}

/** Main dispatches a browser-use operation that can locate a real tab to its origin renderer. */
export interface BrowserViewOperationPayload {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  tabId: string;
  browserId: string;
  browserGeneration: number;
  /** The current model command opens, activates, or otherwise changes the Browser layout, so the renderer should rebuild its resize observation baseline. */
  resetsResizeBaseline?: boolean;
}

export type BrowserTabResidencyState =
  | "live-visible"
  | "live-background"
  | "suspend-pending"
  | "suspended"
  | "restoring";

/** Used only to create a residency restore guest that has not yet committed its first navigation entry. */
export const BROWSER_VIEW_RESTORE_BOOTSTRAP_URL = "zcode-browser-restore://pending";

/** Renderer reports the presentation facts of a tab shell; main must bind windowId to a trusted IPC sender. */
export interface BrowserViewResidencyReportPayload {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  selected: boolean;
  visible: boolean;
  currentTask: boolean;
  loading: boolean;
  restoreUrl?: string | null;
  title?: string | null;
  faviconUrl?: string | null;
}

export interface BrowserViewResidencyTransitionPayload {
  tabId: string;
  workspaceKey: string;
  remoteSessionId: string | undefined;
  sessionId: string;
  browserId: string;
  browserGeneration: number;
  generation: number;
  residency: Extract<
    BrowserTabResidencyState,
    "live-visible" | "live-background" | "suspended" | "restoring"
  >;
}

export interface BrowserViewCloseTabRequest {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
}

export const LOCAL_MEDIA_PREVIEW_SCHEME = "zcode-media";

export function buildLocalMediaPreviewUrl(path: string): string {
  const url = new URL(`${LOCAL_MEDIA_PREVIEW_SCHEME}://local/preview`);
  url.searchParams.set("path", path);
  return url.toString();
}

/**
 * main→renderer close notification.
 *
 * The old payload carried only tabId, so the renderer could only look it up in the side pane state of the "currently active workspace";
 * once the user had switched to another workspace the notification was silently dropped, leaving a ghost tab that could never be closed in the original workspace's persisted state.
 * With the owner scope attached, the renderer can locate the owning workspace's side pane directly and remove the tab from it in memory.
 * The scope fields may be absent: internal paths such as recovery-orphan only carry tabId, and the renderer then falls back to "current workspace only" semantics.
 */
export interface BrowserViewCloseTabNotification {
  tabId: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  reason?: "recovery-orphan";
}

/** Across restarts the logical shell is restored first; the renderer must not mount every guest at once on startup. */
export interface BrowserViewRestoredTabShell {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  browserId: string;
  browserGeneration: number;
  origin: "agent" | "user";
  restoreUrl: string | null;
  title: string | null;
  faviconUrl: string | null;
  openedAt: number;
  lastSelectedAt: number | null;
}

export interface BrowserViewRestoreTabsRequest {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId?: string;
}

/** Main delivers Agent viewport changes to the origin renderer of the target tab. */
export interface BrowserViewViewportChangedPayload extends BrowserViewOperationPayload {
  viewport: BrowserViewportSize | null;
}

// The old default budget of 1500ms is not enough to wait for continuous stable frames on slow machines or background windows; main and renderer
// This default value is shared, and the actual coverage value is passed by prepare payload to prevent the deadlines at both ends from drifting again.
export const BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS = 3_000;

/** The one-shot preview-scale requirement the screenshot/recording handshake imposes on the renderer; when absent, the user's current preview scale is kept. */
export type BrowserViewSurfaceScaleMode = "current" | "unscaled";

/** Main asks the owner renderer to prepare the offscreen guest compositing surface before a screenshot. */
export interface BrowserViewScreenshotSurfacePreparePayload extends BrowserViewOperationPayload {
  requestId: string;
  webContentsId: number;
  viewport: BrowserViewportSize;
  /** A natural viewport does not use the metrics-derived guest layout compensation; when absent, the original emulation behavior (including recording) is preserved. */
  viewportMode?: "natural" | "emulated";
  /** `unscaled` forces a true 100% surface only for the lease lifetime and never writes back the user's Fit/fixed scale. */
  surfaceScaleMode?: BrowserViewSurfaceScaleMode;
  /** The prepare timeout main is actually using right now; when an old payload omits it the renderer falls back to the shared default. */
  timeoutMs?: number;
}

/** The owner renderer confirms that both the target guest's logical viewport and the native preview surface scale have settled. */
export interface BrowserViewScreenshotSurfaceReadyPayload extends BrowserViewScreenshotSurfacePreparePayload {
  surfaceScale: number;
}

/** Main tells the owner renderer to release the temporary offscreen screenshot compositing surface. */
export type BrowserViewScreenshotSurfaceReleasePayload = Omit<
  BrowserViewScreenshotSurfacePreparePayload,
  "viewport" | "viewportMode" | "surfaceScaleMode" | "timeoutMs"
>;

export type BrowserGuestAttachRejectReason =
  | "not-found"
  | "destroyed"
  | "not-webview"
  | "closed"
  | "window-mismatch"
  | "workspace-mismatch"
  | "session-mismatch"
  | "remote-session-mismatch"
  | "residency-suspended"
  | "residency-generation-mismatch";

/** The attach result main returns after the renderer reports its guest; a rejection must no longer be disguised as a ready timeout with no return value. */
export type BrowserGuestAttachResult =
  | { ok: true; guestGeneration: number }
  | { ok: false; reason: BrowserGuestAttachRejectReason; recoveryRequested: boolean };

/** Information about an installed editor/terminal */
export interface EditorInfo {
  /** Editor identifier (e.g. "vscode", "zed", "terminal") */
  id: string;
  /** Display name */
  name: string;
  /** Icon as a base64 data URL */
  iconDataUrl: string;
}

export interface ApplicationIconInfo {
  iconDataUrl: string;
}

export type ApplicationIconLocator =
  | { kind: "darwin-bundle-id"; value: string }
  | { kind: "windows-executable-path"; value: string }
  | { kind: "windows-aumid"; value: string };

export interface ApplicationIconRequest {
  locators: ApplicationIconLocator[];
}

export type OpenInEditorRemoteTarget =
  | Pick<SSHConnectOptions, "kind" | "host" | "port" | "username" | "sshConfigAlias">
  | Pick<WSLConnectOptions, "kind" | "distro" | "user">;

export interface OpenInEditorOptions {
  remoteTarget?: OpenInEditorRemoteTarget;
  workspaceIdentity?: string;
  pathKind?: "file" | "directory";
}

export interface CreateTempTextAttachmentRequest {
  text: string;
  filename?: string;
}

export interface CreateTempTextAttachmentResult {
  filename: string;
  localPath: string;
  mimeType: "text/plain";
  sizeBytes: number;
}

export type SaveFileRequest =
  | {
      data: ArrayBuffer;
      sourceUrl?: never;
      suggestedName: string;
    }
  | {
      data?: never;
      sourceUrl: string;
      suggestedName: string;
    };

export interface SaveFileResult {
  canceled?: boolean;
  error?: string;
  path?: string;
  success: boolean;
}

export interface PrintPageToPdfResult {
  success: boolean;
  /** PDF bytes; present when success */
  data?: ArrayBuffer;
  /** "print_in_progress" | "print_failed" */
  error?: string;
}

export function createOpenInEditorRemoteTarget(target: RemoteTarget): OpenInEditorRemoteTarget {
  switch (target.kind) {
    case "ssh":
      // openInEditor only needs to construct the connection identifier of VS Code Remote-SSH URI,
      // Credential fields such as password/privateKeyPassphrase should not be passed through renderer/preload/main IPC.
      return {
        kind: "ssh",
        host: target.host,
        port: target.port,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
      };
    case "wsl": {
      const user = target.user?.trim();
      return {
        kind: "wsl",
        distro: target.distro,
        ...(user ? { user } : {}),
      };
    }
  }
}

export interface WSLDistro {
  name: string;
  isDefault: boolean;
  state: string;
  version: 1 | 2 | null;
}

export interface SSHConfigAliasOption {
  alias: string;
  host?: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  source?: string;
}

export interface ZCodeStdioTapDevState {
  enabled: boolean;
  visible: boolean;
  logDir: string;
  statePath: string;
}

export type DesktopTitleBarTheme = "light" | "dark" | "system";

export interface WindowScreenshotResult {
  dataBase64: string;
  filename: string;
  contentType: string;
  size: number;
}

export type ChromeBrowserDataImportError =
  | "chrome_profile_not_found"
  | "chrome_profile_ambiguous"
  | "chrome_executable_not_found"
  | "chrome_cookie_access_denied"
  | "chrome_cookie_elevation_required"
  | "chrome_cookie_elevation_cancelled"
  | "chrome_cookie_helper_verification_failed"
  | "chrome_cookie_app_bound_decryption_failed"
  | "chrome_cookie_protection_unsupported"
  | "chrome_profile_locked"
  | "chrome_local_storage_import_failed"
  | "chrome_import_not_supported"
  | "chrome_browser_data_import_unavailable"
  | "chrome_data_import_failed"
  | "chrome_default_profile_not_found";

export interface ChromeBrowserDataImportOptions {
  /** Windows App-Bound Cookie decryption may only raise UAC after this explicit confirmation; it must never be persisted as a global grant. */
  allowElevatedChromeDecryption?: boolean;
}

/** The Chrome browser data import returns only counts and status; Cookie/LocalStorage values and decryption material must never cross a process boundary. */
export interface ChromeBrowserDataImportResult {
  success: boolean;
  cookies: {
    imported: number;
    skipped: number;
    failed: number;
  };
  localStorage: {
    originsImported: number;
    entriesImported: number;
    originsSkipped: number;
    originsFailed: number;
    error?: ChromeBrowserDataImportError;
  };
  /** Actionable issues kept on partial success; must not contain absolute Profile paths or site data. */
  issues?: ChromeBrowserDataImportError[];
  error?: ChromeBrowserDataImportError;
}

export interface EmbeddedBrowserDataClearResult {
  success: boolean;
  error?: string;
}

export interface WindowControlsOverlayMetrics {
  leftPaddingPx?: number;
  rightPaddingPx?: number;
  titleBarHeightPx?: number;
}

export interface WindowControlsOverlayReadyPayload {
  zoomLevel: number;
  metrics: WindowControlsOverlayMetrics;
}

export interface DesktopZoomState {
  zoomLevel: number;
}

export interface DesktopWindowChromeState {
  isMaximized: boolean;
  /** The local macOS major version; null on non-macOS or when it cannot be parsed. */
  macOSMajorVersion?: number | null;
  supportsNativeRoundedCorners: boolean;
}

export interface RemoteServiceSession {
  sessionId: string;
}

export interface RemoteConnectionRuntimeLog {
  label: string;
  requestId?: string;
  sessionId?: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  timestamp: string;
}

export interface RemoteSessionClosedEvent {
  sessionId: string;
  reason: "host-exit";
  exitCode: number | null;
  signal: string | null;
}

export interface EmbeddedBrowserOpenUrlRequest {
  url: string;
  disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
  /** Which browser-use tab triggered the popup; when the legacy event omits it the renderer falls back to the current scope for compatibility. */
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  browserId?: string;
  browserGeneration?: number;
  sourceTabId?: string;
}

export interface BotRemoteWorkspaceReconnectedEvent {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
  target: RemoteTarget;
}

export interface ConnectRemoteRequest {
  target: RemoteTarget;
  requestId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  connectTrigger?: import("./remoteUsageTelemetry.js").RemoteWorkspaceConnectTrigger;
}

export interface CancelPendingRemoteConnectionRequest {
  requestId?: string;
}

export interface BindRemoteWorkspaceSessionContextRequest {
  remoteSessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export const DesktopCommandIds = {
  NewTask: "newTask",
  OpenWorkspace: "openWorkspace",
  CloseActiveContext: "closeActiveContext",
  CloseWindow: "closeWindow",
  MinimizeWindow: "minimizeWindow",
  ToggleMaximizeWindow: "toggleMaximizeWindow",
  ToggleFullScreen: "toggleFullScreen",
  ResetWindowSize: "resetWindowSize",
  ResetZoom: "resetZoom",
  ZoomIn: "zoomIn",
  ZoomOut: "zoomOut",
  ShowAbout: "showAbout",
  OpenChangelog: "openChangelog",
  CheckForUpdates: "checkForUpdates",
  RelaunchApp: "relaunchApp",
  OpenFeedback: "openFeedback",
  OpenCommunity: "openCommunity",
  ExportLogs: "exportLogs",
  ToggleDevTools: "toggleDevTools",
  OpenResourceManager: "openResourceManager",
  ToggleZCodeStdioTapDevProxy: "toggleZCodeStdioTapDevProxy",
  SetZCodeEndpointProduction: "setZCodeEndpointProduction",
  SetZCodeEndpointTest: "setZCodeEndpointTest",
  SetZCodeEndpointCustom: "setZCodeEndpointCustom",
  ResetZCodeEndpoint: "resetZCodeEndpoint",
  ClearAllData: "clearAllData",
  ClearCodingPlanWebviewStorage: "clearCodingPlanWebviewStorage",
  GetCuaOsSupport: "getCuaOsSupport",
} as const;

export type DesktopCommandId = (typeof DesktopCommandIds)[keyof typeof DesktopCommandIds];

/**
 * The CUA Helper's OS support state (the macOS version-gate verdict that the main process
 * sends down to the renderer via GetCuaOsSupport).
 * - supported: the gate is met (including non-version factors, e.g. a parse failure is treated leniently).
 * - macos-below-minimum: macOS is below the promised floor (Helper LSMinimumSystemVersion 12.0);
 *   on older versions LaunchServices refuses to launch the Helper with -10825, which surfaces as authorization repeatedly hanging.
 * - not-applicable: a non-darwin platform, where the macOS version gate does not apply.
 */
export type CuaOsSupport =
  | { kind: "supported" }
  | { kind: "macos-below-minimum"; minimumMacOs: string; currentMacOs: string }
  | { kind: "not-applicable" };

/**
 * Platform operation interface — replaces direct access to window.zcode
 *
 * Defines the operations that need a host environment (Electron main / Web server) to take part.
 * Desktop and Web each provide their own implementation, and the UI layer consumes them uniformly through this interface.
 *
 * Design principle: only operations that "must cross a process boundary and are unsuitable to model as an RPC service"
 * belong here, such as native dialogs and window lifecycle control.
 * Business services (files, terminal, credentials, etc.) go through the IServiceAccessor RPC channel.
 */
export interface IPlatformService {
  /** Whether the current platform's file picker can return a local absolute path the agent can access */
  canSelectFilePath?: boolean;

  /** Opens the system directory picker and returns the selected path or null */
  selectDirectory(): Promise<string | null>;

  /** Opens the system file picker and returns the selected file path or null */
  selectFile(): Promise<string | null>;

  /** Opens the system multi-file picker and returns the selected file paths; an empty array when cancelled */
  selectFiles?(): Promise<string[]>;

  /** Writes a file through the host's native Save As dialog; not implemented on plain Web */
  saveFile?(payload: SaveFileRequest): Promise<SaveFileResult>;

  /**
   * Uses the Chromium print engine to emit the current webContents' print-media layout as a PDF (vector text).
   * The page size is decided by the @page CSS injected by the renderer (preferCSSPageSize); implemented on Desktop only.
   */
  printPageToPdf?(): Promise<PrintPageToPdfResult>;

  /**
   * Resolves a host-local path from a browser File object; only the Desktop preload can implement this safely.
   * Web/mobile return null, so the UI layer never depends on Electron's non-standard File.path.
   */
  getPathForFile?(file: unknown): string | null;

  /** Converts an Agent-authorized Desktop local video path into a host URL that media elements can read. */
  createLocalMediaPreviewUrl?(path: string): string;

  /**
   * Creates a text attachment file in the host's ~/.zcode temp directory.
   * Phone remote control must write through the shared-host/platform proxy to the desktop host, so large text never enters the prompt payload.
   */
  createTempTextAttachment?(
    payload: CreateTempTextAttachmentRequest,
  ): Promise<CreateTempTextAttachmentResult>;

  /** Subscribes to the remote connection lifecycle log of the current window; returns a disposer */
  onRemoteConnectionLog(handler: (entry: RemoteConnectionRuntimeLog) => void): () => void;

  /** Subscribes to remote workspace session close events; returns a disposer */
  onRemoteSessionClosed(handler: (event: RemoteSessionClosedEvent) => void): () => void;

  /** Subscribes to the successful Bot-triggered remote workspace reconnect event; returns a disposer */
  onBotRemoteWorkspaceReconnected(
    handler: (event: BotRemoteWorkspaceReconnectedEvent) => void,
  ): () => void;

  /** Checks whether the directory is already open in another window; if so, activates that window and switches to the matching tab */
  activateOrSetWorkspace(path: string): Promise<{ activated: boolean }>;

  /** Establishes a remote connection (Desktop: creates a remote session in the current window; Web: HTTP API) */
  connectRemote(
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath: string;
      workspaceIdentity?: string;
      connectTrigger?: import("./remoteUsageTelemetry.js").RemoteWorkspaceConnectTrigger;
    },
  ): Promise<{ success: boolean; error?: string; sessionId?: string }>;

  /** Cancels a remote connection in the current window that has not finished establishing (optional: the Web platform may ignore it) */
  cancelPendingRemoteConnection?(requestId?: string): Promise<void>;

  /** Binds the canonical workspace identity to the already-created remote logical session. */
  bindRemoteWorkspaceSessionContext?(
    context: BindRemoteWorkspaceSessionContextRequest,
  ): Promise<void>;

  /** Releases the remote session created in the current window */
  disposeRemoteSession(sessionId: string): Promise<void>;

  /** Lists the WSL distributions available on this machine */
  listWSLDistros(): Promise<WSLDistro[]>;

  /** Lists the SSH config aliases on this machine that can be used to fill the form quickly */
  listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;

  /** Reads the native MCP user directory configuration from the host environment; phone remote control forwards it through the connected desktop host. */
  loadMcpFromUserDirectory?(
    payload?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;

  /** Writes the native MCP user directory configuration into the host environment; plain Web returns unsupported when there is no host. */
  saveMcpToUserDirectory?(
    payload: SaveCliMcpToUserDirectoryRequest,
  ): Promise<{ success: boolean; error?: string }>;

  /** Migrates the legacy Common MCP configuration; only a host environment can run it, and phone remote control forwards it through the desktop attachment. */
  migrateLegacyCommonMcp?(
    payload?: MigrateLegacyCommonMcpRequest,
  ): Promise<MigrateLegacyCommonMcpResult>;

  /** Opens an external URL (used to hand OAuth off to the browser) */
  openExternal(url: string): void;

  /** Reads the real app icon for a system app identifier; non-Desktop platforms may skip implementing it. */
  getApplicationIcon?(
    request: string | ApplicationIconRequest,
  ): Promise<ApplicationIconInfo | null>;

  /** Opens the feedback entry point; the platform resolves the final address itself */
  openFeedback(): Promise<void>;

  /** Subscribes to the main process opening the built-in feedback dialog (Desktop) */
  onOpenFeedbackDialog?(handler: () => void): () => void;

  /** Subscribes to the main process opening the "My Tickets" panel (Desktop) */
  onOpenTicketsPanel?(handler: () => void): () => void;

  /** Opens the user community entry point; the platform resolves the channel for the current language itself */
  openCommunity(): Promise<void>;

  /** Queries whether a user community entry point is available for the current language */
  canOpenCommunity(): Promise<boolean>;

  /** Opens the given path in the system file manager */
  openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;

  /** Opens a local file with the system default application; the plain Web platform returns unsupported. */
  openExternalFile?(path: string): Promise<{ success: boolean; error?: string }>;

  /** Opens the full ZCode Computer Use permission onboarding flow. Desktop only. */
  openCuaPermissionOnboarding?(
    options?: OpenCuaPermissionOnboardingOptions,
  ): Promise<CuaAccessibilitySettingsResult>;
  /** Cancels the onboarding participant this renderer started under operationId. Desktop only. */
  cancelCuaPermissionOnboarding?(operationId: string): void;
  /**
   * Warms up and caches the verified Helper path + fingerprint so that the following dragstart can call startDrag synchronously.
   * Must be called when the drag overlay mounts: Electron native drag requires startDrag to be called synchronously inside the
   * dragstart event chain and cannot wait for async I/O such as install/verify (otherwise it misses the OS drag gesture window). Desktop only.
   */
  prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
  /** Drags Helper.app from the permission overlay into the macOS permission list. Desktop only. */
  startCuaHelperPermissionDrag?(): void;

  /** Reports the OAuth state to the main process for deep link routing */
  registerOAuthState(payload: OAuthStateRegistration): void;

  /**
   * Registers an OAuth deep link callback listener
   * @returns a disposer function that, when called, removes only the current callback
   */
  onOAuthCallback(callback: (url: string) => void): () => void;

  /**
   * Registers a payment deep link callback listener
   * @returns a disposer function that, when called, removes only the current callback
   */
  onPaymentCallback(callback: (url: string) => void): () => void;

  /** Registers a `zcode://share/import?code=...` import intent. */
  onShareImport?(callback: (payload: { shareCode: string }) => void): () => void;

  /** Tells the main process that the renderer is ready, triggering the replay of the cached cold-start deep link */
  notifyRendererReady(): void;

  /** Fires the system notification matching the task status; the host environment decides whether it is actually shown */
  showTaskNotification(payload: TaskNotificationPayload): void;

  /** Reports UI-side telemetry events through the host environment */
  reportTelemetryEvent(payload: RendererTelemetryEventPayload): Promise<void>;

  /** Reports ARMS custom events through the host environment; currently a no-op on Web */
  reportArmsCustomEvent(payload: ArmsCustomEventPayload): Promise<void>;

  /** Reads the current rollout configuration of the Desktop Renderer user-action trace; not implemented on Web/mobile. */
  getRendererActionTraceConfig?(): Promise<RendererActionTraceConfigV1>;
  /** Subscribes to the Renderer user-action trace configuration pushed by Main; not implemented on Web/mobile. */
  onRendererActionTraceConfigChanged?(
    callback: (config: RendererActionTraceConfigV1) => void,
  ): () => void;
  /** Renderer → Main: sends a finished ui_action batch; strictly out-of-band, fire-and-forget. */
  reportRendererActionTraceBatch?(batch: RendererActionTraceBatchV1): void;
  reportLocalTtftBatch?(batch: import("./localTtft.js").LocalTtftBatch): void;

  /**
   * Renderer → Main: the main-window renderer's heap reading taken every 60 seconds, reported as a `renderer_main` role event. One-way send, fire-and-forget;
   * the Web build and phone remote control have no bridge, so leaving it unimplemented is a no-op.
   */
  reportRendererHeapSample?(sample: RendererHeapSample): void;

  /** Syncs the workspace paths of every tab in the current window to the main process (used for cross-window dedup) */
  syncWindowTabs(paths: string[]): void;

  /** Syncs the current window's unread task count to the host environment, for Dock / taskbar badge aggregation */
  syncWindowUnreadCount(count: number): void;
  /** The active task of the current window changed; Main only publishes the global PiP focus while that window is in the foreground. */
  syncActiveTaskSession(sessionId: string | null): void;

  /** Syncs the app settings the main process must observe immediately; the Web fallback may ignore it */
  syncAppSettings?(patch: Partial<AppSettings>): void;

  /** Recording-mode switch for the shortcut settings page; desktop main temporarily removes configurable menu accelerators accordingly, Web may ignore it */
  setShortcutRecordingActive?(active: boolean): void;

  /** Registers a callback for the main process requesting focus on a workspace tab; returns a disposer */
  onFocusTab(handler: (path: string) => void): () => void;

  /** Registers a callback for the main process triggering a new tab; returns a disposer */
  onNewTab(handler: () => void): () => void;

  /** Registers a callback for the main process requesting that the current context be closed; returns a disposer */
  onCloseActiveContextRequest?(handler: () => void): () => void;

  /** Registers a callback for the built-in browser webview requesting a new page to be opened; returns a disposer */
  onOpenBrowserUrl?(handler: (request: EmbeddedBrowserOpenUrlRequest) => void): () => void;
  /** Registers a callback fired once the agent's first browser command has built the controlled view (auto-opens a browser-use tab); returns a disposer */
  onBrowserViewReady?(
    handler: (payload: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): () => void;

  /** Refreshes the tab action state when browser-use lands on a real tab; returns a disposer. */
  onBrowserViewOperation?(handler: (payload: BrowserViewOperationPayload) => void): () => void;

  /** browser visibility capability: explicitly show/hide the current IAB browser-use pane. */
  onBrowserViewVisibility?(
    handler: (payload: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): () => void;

  /** The single-tab sync event between Agent setViewportSize and the renderer's free sizing. */
  onBrowserViewViewportChanged?(
    handler: (payload: BrowserViewViewportChangedPayload) => void,
  ): () => void;

  /** Registers a callback for main preparing the offscreen guest compositing surface before a screenshot; returns a disposer. */
  onBrowserViewScreenshotSurfacePrepare?(
    handler: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
  ): () => void;

  /** Registers a callback for main releasing the offscreen guest compositing surface once the screenshot completes; returns a disposer. */
  onBrowserViewScreenshotSurfaceRelease?(
    handler: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
  ): () => void;

  /** Reports a screenshot compositing surface that has settled for the target guest across consecutive animation frames. */
  browserViewScreenshotSurfaceReady?(payload: BrowserViewScreenshotSurfaceReadyPayload): void;

  onBrowserViewCloseTab?(handler: (payload: BrowserViewCloseTabNotification) => void): () => void;

  /** main asks the renderer to unmount the guest while keeping the logical shell. */
  onBrowserViewSuspend?(
    handler: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): () => void;

  /** main asks the renderer to mount the guest for a suspended shell again. */
  onBrowserViewRestore?(
    handler: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): () => void;

  /** Registers a callback for the main process triggering a new task; returns a disposer */
  onNewTask(handler: () => void): () => void;

  /** Registers a callback for the main process triggering a workspace open; returns a disposer */
  onOpenWorkspace(handler: () => void): () => void;

  /** Registers a callback for the main process opening a local workspace directory directly through a deep link; returns a disposer */
  onOpenWorkspacePath?(handler: (path: string) => void): () => void;

  /** Registers a callback for window fullscreen state changes; returns a disposer */
  onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void;

  /** Reads the current desktop window's maximized state and the system's native rounded-corner capability */
  getDesktopWindowChromeState?(): Promise<DesktopWindowChromeState>;

  /** Registers a callback for changes to the desktop window's maximized state and the system's native rounded-corner capability */
  onDesktopWindowChromeStateChanged?(
    handler: (state: DesktopWindowChromeState) => void,
  ): () => void;

  /** Synchronously reads the current native window controls overlay safe-area insets, used to initialize the first-paint startup state */
  getWindowControlsOverlayMetrics?(): WindowControlsOverlayMetrics | null;

  /** Registers a callback for changes to the native window controls overlay safe-area insets; returns a disposer */
  onWindowControlsOverlayChanged?(
    handler: (metrics: WindowControlsOverlayMetrics) => void,
  ): () => void;

  /** Synchronously reads the current desktop window's page zoom level; the Web fallback may return the default 0 */
  getDesktopZoomLevel?(): Promise<DesktopZoomState>;

  /** Registers a callback for changes to the current desktop window's page zoom level; returns a disposer */
  onDesktopZoomLevelChanged?(handler: (state: DesktopZoomState) => void): () => void;

  /** Registers a callback that navigates to the matching task when the user clicks a system notification; returns a disposer */
  onTaskNotificationClick(handler: (taskId: string) => void): () => void;

  /** Exports logs: packages ~/.zcode/v2 and external agent logs into a zip and reveals it in the system file browser */
  exportLogs(): Promise<{ success: boolean; path?: string; error?: string }>;

  /** Captures the current window so error feedback can carry a picture of the scene; the Web fallback may return null */
  captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>;

  /** `<webview>` guest report; active=true means a tabId-less agent command should prefer reading the currently visible page. */
  browserViewAttachGuest?(payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    remoteSessionId?: string;
    /** Conversation ownership of a human browser tab; when absent main must keep it unclaimable, to avoid cross-conversation leakage. */
    sessionId?: string;
    residencyGeneration?: number;
  }): Promise<BrowserGuestAttachResult>;

  /** Before rebuilding the `<webview>`, let main detach the old guest's CDP precisely; on false the old node must not be destroyed. */
  browserViewDetachGuest?(payload: { key: string; webContentsId: number }): Promise<boolean>;

  /** The user explicitly closed a Browser tab; uses a different IPC authority than a budget suspend. */
  browserViewCloseTab?(payload: BrowserViewCloseTabRequest): Promise<void>;

  /** Reports selected/visible/loading plus recovery metadata. */
  browserViewReportResidency?(payload: BrowserViewResidencyReportPayload): Promise<void>;

  /** The renderer has unmounted the guest at the given generation. */
  browserViewSuspendReady?(payload: { tabId: string; generation: number }): Promise<void>;

  /** Requests a single-flight restore from main when the user selects a suspended tab. */
  browserViewEnsureResident?(payload: BrowserViewCloseTabRequest): Promise<void>;

  /** Reads the persisted logical shells when a workspace/task starts. */
  browserViewRestoreTabs?(
    payload: BrowserViewRestoreTabsRequest,
  ): Promise<BrowserViewRestoredTabShell[]>;

  /** The renderer writes its free sizing back to main; null restores the host's natural viewport. */
  browserViewUpdateViewport?(payload: {
    tabId: string;
    viewport: BrowserViewportSize | null;
  }): Promise<void>;

  /** One-shot import of Cookies and LocalStorage from an auto-discovered local Chrome Profile. */
  importChromeBrowserData?(
    options?: ChromeBrowserDataImportOptions,
  ): Promise<ChromeBrowserDataImportResult>;

  /** Clears the embedded browser's persisted partition; cache mode keeps authentication data, all mode clears all site data. */
  clearEmbeddedBrowserData?(mode: "cache" | "all"): Promise<EmbeddedBrowserDataClearResult>;

  /** Registers a callback fired once a new version has finished downloading, receiving the new version string; returns a disposer */
  onUpdateReady(callback: (version: string) => void): () => void;

  /** Registers a callback for the "check for updates" result (used for toast feedback); returns a disposer */
  onUpdateCheckResult(callback: (payload: UpdateCheckResultPayload) => void): () => void;

  /** Registers a callback for continuous auto-update state changes; returns a disposer */
  onUpdateStateChanged?(callback: (payload: UpdateStatePayload) => void): () => void;

  /** Proactively reads the current auto-update state, to compensate for async events lost while the menu was closed */
  getUpdateState?(): Promise<UpdateStatePayload>;

  /** The user confirmed in the update dialog that the currently discovered version should start downloading */
  downloadUpdate(): Promise<void>;

  /** The user cancelled the in-progress update download in the update dialog */
  cancelUpdateDownload(): Promise<void>;

  /** Opens the standalone desktop update window; non-desktop platforms may skip it and fall back to the embedded dialog */
  openUpdateStatusWindow?(): Promise<void>;

  /** Reads the desktop auto-update preferences; non-desktop platforms may return defaults */
  getAutoUpdatePreferences?(): Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;

  /** Writes the "download and install updates automatically from now on" preference; non-desktop platforms may no-op */
  setAutoDownloadAndInstallUpdates?(enabled: boolean): Promise<void>;

  /** The user skips the currently discovered version; the main process is responsible for persisting it per current channel */
  skipUpdateVersion(version: string): Promise<void>;

  /** Queries how many sessions the desktop is currently running; non-desktop platforms may return 0 */
  getDesktopSessionActivity?(): Promise<{
    runningAgentSessionCount: number;
  }>;

  /** Switch state of the dev-environment stdio tap proxy; non-desktop platforms may skip it */
  getZCodeStdioTapDevState?(): Promise<ZCodeStdioTapDevState>;

  /** Whether this is a local development runtime; desktop injects it via !app.isPackaged, Web may omit it. */
  isLocalDevelopmentRuntime?: boolean;

  /** Notification that the settings file was updated by a desktop menu command; the renderer uses it to refresh the settings snapshot. */
  onSettingsChanged?(callback: () => void): () => void;

  /** Registers the post-update release notes; returns a disposer */
  onPostUpdateReleaseNotes(callback: (payload: PostUpdateReleaseNotesPayload) => void): () => void;

  /** Marks the current release notes as read, allowing the main process to clear the persisted state */
  acknowledgePostUpdateReleaseNotes(version: string): Promise<void>;

  /** The user confirmed restarting to install the update */
  quitAndInstallUpdate(): Promise<void>;

  /** Gets the list of editors/terminals installed on the system (including icons) */
  getInstalledEditors(): Promise<EditorInfo[]>;

  /** Opens a path with the given editor */
  openInEditor(
    editorId: string,
    path: string,
    options?: OpenInEditorOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /** Executes a desktop window-level command (title bar menu, zoom, window controls, etc.).
   *  The return value is passed straight through from the main process handler's return (most commands return nothing;
   *  GetCuaOsSupport returns CuaOsSupport), so it is widened to unknown. */
  executeDesktopCommand(command: DesktopCommandId): Promise<unknown>;

  /** Syncs the desktop title bar light/dark theme, which drives the native window control button colors */
  setTitleBarTheme(theme: DesktopTitleBarTheme): Promise<void>;

  /** Gets a stable identifier for the current device
   *
   * - Desktop: a SHA-256 of the userData path, always stable and unique
   * - Mobile (Web remote control): a physical-attribute fingerprint (browserPlatform | screen.width | screen.height | colorDepth),
   *   resilient to browser/network/language/timezone changes; it only changes when the phone changes
   */
  getDeviceId(): string;
}
