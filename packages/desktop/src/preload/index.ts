import {
  databaseStartupControlSchema,
  databaseStartupStateSchema,
  databaseStartupPortPayloadSchema,
} from "@zcode/shared";
/* eslint-disable max-lines -- preload bridge centrally exposes desktop platform IPC, and dismantling it will make contextBridge permission boundaries more difficult to audit. */
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import {
  installArmsRumBridgeIpcForward,
  scheduleArmsEventBridgePatch,
} from "../shared/armsRumBridgeForward.js";

// The send in the ARMS frame preload closure will not take effect after the subsequent ipcRenderer.send patch, and Bridge.send must be packaged synchronously.
installArmsRumBridgeIpcForward(ipcRenderer);
scheduleArmsEventBridgePatch();

/** Parsing --device-id= from command-line parameters */
function parseDeviceIdFromArgs(): string {
  for (const arg of process.argv) {
    if (arg.startsWith("--device-id=")) {
      return arg.slice("--device-id=".length);
    }
  }
  return "";
}

// Expose the synchronization value before contextBridge is established, so that the renderer can read it before React renders
contextBridge.exposeInMainWorld("__ZCODE_DEVICE_ID__", parseDeviceIdFromArgs());

import type {
  AppSettings,
  ApplicationIconRequest,
  BrowserViewOperationPayload,
  BrowserGuestAttachResult,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewViewportChangedPayload,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewportSize,
  DesktopZoomState,
  DesktopWindowChromeState,
  DesktopCommandId,
  DesktopTitleBarTheme,
  EmbeddedBrowserOpenUrlRequest,
  OAuthStateRegistration,
  OpenInEditorOptions,
  RemoteTarget,
  TaskNotificationPayload,
  TelemetryRendererContext,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererHeapSample,
  PostUpdateReleaseNotesPayload,
  RemoteSessionClosedEvent,
  BotRemoteWorkspaceReconnectedEvent,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  ZCodeStdioTapDevState,
  LoadCliMcpFromUserDirectoryRequest,
  MigrateLegacyCommonMcpRequest,
  SaveCliMcpToUserDirectoryRequest,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  SSHConfigAliasOption,
  RemoteConnectionRuntimeLog,
  WindowControlsOverlayMetrics,
  WindowControlsOverlayReadyPayload,
  CreateTempTextAttachmentRequest,
  OpenCuaPermissionOnboardingOptions,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
} from "@zcode/shared";
import {
  InternalChannels,
  PlatformChannels,
  formatZCodeRendererProcessName,
  shouldEnableE2ETestBridge,
} from "@zcode/shared";
import { createOAuthCallbackHandler } from "./oauthCallbackBridge.js";

if (shouldEnableE2ETestBridge(process.env)) {
  contextBridge.exposeInMainWorld("__zcodeFinalArmsCustomEventsE2E", {
    read: (): Promise<FinalArmsCustomEventE2EEntry[]> =>
      ipcRenderer.invoke(PlatformChannels.ReadFinalArmsCustomEventsE2E),
    clear: (): Promise<void> => ipcRenderer.invoke(PlatformChannels.ClearFinalArmsCustomEventsE2E),
    configure: (request: ConfigureFinalArmsCustomEventE2ERequest): Promise<void> =>
      ipcRenderer.invoke(PlatformChannels.ConfigureFinalArmsCustomEventsE2E, request),
  });
}

const updateReadyCallbacks = new Set<(version: string) => void>();
const updateStateCallbacks = new Set<(payload: UpdateStatePayload) => void>();
const postUpdateReleaseNotesCallbacks = new Set<(payload: PostUpdateReleaseNotesPayload) => void>();
const openWorkspacePathCallbacks = new Set<(path: string) => void>();
let latestReadyUpdateVersion: string | null = null;
let latestUpdateState: UpdateStatePayload | null = null;
let latestPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
const pendingOpenWorkspacePaths: string[] = [];
const shareImportCallbacks = new Set<(payload: { shareCode: string }) => void>();
const pendingShareImports: { shareCode: string }[] = [];
const MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX = 136;
const WINDOWS_TITLE_BAR_HEIGHT_PX = 48;
const DESKTOP_ZOOM_FACTOR_STEP = 1.1;
const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;
let latestWindowControlsOverlayMetrics: WindowControlsOverlayMetrics | null = null;
let latestDesktopZoomLevel = 0;

function clampDesktopZoomLevel(level: number) {
  return Math.min(DESKTOP_ZOOM_MAX_LEVEL, Math.max(DESKTOP_ZOOM_MIN_LEVEL, level));
}

function resolveDesktopZoomLevelFromFactor(zoomFactor: number) {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    return 0;
  }

  return clampDesktopZoomLevel(
    Math.round(Math.log(zoomFactor) / Math.log(DESKTOP_ZOOM_FACTOR_STEP)),
  );
}

function resolveDesktopZoomFactorForLevel(level: number) {
  return Math.pow(DESKTOP_ZOOM_FACTOR_STEP, clampDesktopZoomLevel(level));
}

function readCurrentWindowControlsOverlayReadyPayload(): WindowControlsOverlayReadyPayload {
  const zoomLevel = resolveDesktopZoomLevelFromFactor(webFrame.getZoomFactor());
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const metrics: WindowControlsOverlayMetrics =
    process.platform === "darwin"
      ? {
          leftPaddingPx: Math.round(MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX / zoomFactor),
        }
      : process.platform === "win32"
        ? {
            rightPaddingPx: Math.round(WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX / zoomFactor),
            titleBarHeightPx: Math.round(WINDOWS_TITLE_BAR_HEIGHT_PX * zoomFactor),
          }
        : {};
  return {
    zoomLevel,
    metrics,
  };
}

function readCurrentWindowControlsOverlayMetrics(): WindowControlsOverlayMetrics {
  return readCurrentWindowControlsOverlayReadyPayload().metrics;
}

const initialWindowControlsOverlayPayload = readCurrentWindowControlsOverlayReadyPayload();
latestDesktopZoomLevel = initialWindowControlsOverlayPayload.zoomLevel;
latestWindowControlsOverlayMetrics = initialWindowControlsOverlayPayload.metrics;
// RootStartupLoading Before rendering, the main process needs to get the traffic light position corresponding to the current zoom.
// The preload runs earlier than the React page. Here, main is proactively notified to avoid having to wait until the App page is entered before making adjustments.
ipcRenderer.send(PlatformChannels.WindowControlsOverlayReady, initialWindowControlsOverlayPayload);

ipcRenderer.on(
  PlatformChannels.WindowControlsOverlayChanged,
  (_event: unknown, metrics: WindowControlsOverlayMetrics) => {
    latestWindowControlsOverlayMetrics = metrics;
  },
);

ipcRenderer.on(
  PlatformChannels.DesktopZoomLevelChanged,
  (_event: unknown, state: DesktopZoomState) => {
    if (Number.isFinite(state.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
  },
);

ipcRenderer.on(PlatformChannels.OpenWorkspacePath, (_event: unknown, path: string) => {
  if (openWorkspacePathCallbacks.size === 0) {
    // Cold start open-workspace will be delivered from the main process immediately after the renderer is ready.
    // But React's platform effect may not have registered onOpenWorkspacePath yet. preload catch first
    // This IPC will be played back after the UI subscription is established to avoid opening the App without opening the directory.
    pendingOpenWorkspacePaths.push(path);
    return;
  }

  for (const callback of openWorkspacePathCallbacks) {
    callback(path);
  }
});

ipcRenderer.on(PlatformChannels.ShareImport, (_event: unknown, payload: { shareCode: string }) => {
  if (shareImportCallbacks.size === 0) {
    pendingShareImports.push(payload);
    return;
  }
  for (const callback of shareImportCallbacks) callback(payload);
});

function updateRendererProcessTitle(): void {
  process.title = formatZCodeRendererProcessName(document.title);
}

function notifyUpdateReadyCallbacks(version: string): void {
  latestReadyUpdateVersion = version;
  for (const callback of updateReadyCallbacks) {
    callback(version);
  }
}

function notifyPostUpdateReleaseNotesCallbacks(payload: PostUpdateReleaseNotesPayload): void {
  latestPostUpdateReleaseNotes = payload;
  for (const callback of postUpdateReleaseNotesCallbacks) {
    callback(payload);
  }
}

function notifyUpdateStateCallbacks(payload: UpdateStatePayload): void {
  latestUpdateState = payload;
  // UpdateReady is a one-time cache compatible with old interactions, but update-downloaded
  // Squirrel.Mac may report a staging error again later. At this time main will broadcast idle/error,
  // preload must clear the old ready synchronously, otherwise React will play back the expired version when resubscribing.
  latestReadyUpdateVersion = payload.kind === "update-downloaded" ? payload.version : null;
  for (const callback of updateStateCallbacks) {
    callback(payload);
  }
}

// Process retrieval experience optimization: renderer is usually only displayed as a general helper name in the system.
// Here, zcode-* title is added in the preload stage to facilitate filtering by window role.
updateRendererProcessTitle();
window.addEventListener("DOMContentLoaded", updateRendererProcessTitle, {
  once: true,
});

/**
 * Preload bridge - only exposes platform operations that require the participation of the main process
 *
 * Credential management has been moved to the host process's ICredentialService,
 * Accessed through MessagePort RPC, no longer through this bridge.
 */
contextBridge.exposeInMainWorld("zcode", {
  connectRemote: (
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath: string;
      workspaceIdentity?: string;
      connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
    },
  ) =>
    ipcRenderer.invoke(PlatformChannels.ConnectRemote, {
      target: options,
      requestId,
      ...(context ? context : {}),
    }),
  cancelPendingRemoteConnection: (requestId?: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.CancelPendingRemoteConnection, {
      requestId,
    }),
  bindRemoteWorkspaceSessionContext: (context: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BindRemoteWorkspaceSessionContext, context),
  disposeRemoteSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.DisposeRemoteSession, sessionId),
  listWSLDistros: () => ipcRenderer.invoke(PlatformChannels.ListWSLDistros),
  listSSHConfigAliases: (): Promise<SSHConfigAliasOption[]> =>
    ipcRenderer.invoke(PlatformChannels.ListSSHConfigAliases),
  loadMcpFromUserDirectory: (payload?: LoadCliMcpFromUserDirectoryRequest) =>
    ipcRenderer.invoke(PlatformChannels.LoadMcpFromUserDirectory, payload ?? {}),
  saveMcpToUserDirectory: (payload: SaveCliMcpToUserDirectoryRequest) =>
    ipcRenderer.invoke(PlatformChannels.SaveMcpToUserDirectory, payload),
  migrateLegacyCommonMcp: (payload?: MigrateLegacyCommonMcpRequest) =>
    ipcRenderer.invoke(PlatformChannels.MigrateLegacyCommonMcp, payload ?? {}),
  /** The renderer logs are transferred to the main process for unified storage through IPC. */
  log: (level: "info" | "warn" | "error", args: unknown[]) =>
    ipcRenderer.send(PlatformChannels.Log, { level, args }),
  /** Open the system directory selection box and return the selected path or null */
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(PlatformChannels.SelectDirectory),
  /** Open the system file selection box and return the selected file path or null */
  selectFile: (): Promise<string | null> => ipcRenderer.invoke(PlatformChannels.SelectFile),
  /** Open the system multi-file selection box and return the selected file path; return an empty array when canceling */
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke(PlatformChannels.SelectFiles),
  /** Explicitly place the disk through the native save as dialog box of the main process */
  saveFile: (payload: SaveFileRequest): Promise<SaveFileResult> =>
    ipcRenderer.invoke(PlatformChannels.SaveFile, payload),
  /** Export the print media layout of the current page to PDF (Chromium print engine, vector text) */
  printPageToPdf: (): Promise<PrintPageToPdfResult> =>
    ipcRenderer.invoke(PlatformChannels.PrintToPdf),
  /** Parse the real local path of the Web File obtained from the system drag/file input */
  getPathForFile: (file: File): string | null => {
    // Non-standard File.path has been removed since Electron 32, and the renderer can no longer directly take the path from the dragged File.
    // webUtils can only be used safely in preload; when the path cannot be obtained, null is returned, allowing the web/inline attachment logic to continue to take care of the problem.
    const path = webUtils.getPathForFile(file).trim();
    return path.length > 0 ? path : null;
  },
  /** Long text is pasted as a real local attachment to prevent the main text and prompt payload from being enlarged. */
  createTempTextAttachment: (payload: CreateTempTextAttachmentRequest) =>
    ipcRenderer.invoke(PlatformChannels.CreateTempTextAttachment, payload),
  /** Subscribe to the remote connection process log in the current window and return disposer */
  onRemoteConnectionLog: (callback: (entry: RemoteConnectionRuntimeLog) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteConnectionRuntimeLog);
    ipcRenderer.on(PlatformChannels.RemoteConnectionLog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteConnectionLog, handler);
  },
  /** Subscribe to the remote session close event in the current window and return disposer */
  onRemoteSessionClosed: (callback: (event: RemoteSessionClosedEvent) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteSessionClosedEvent);
    ipcRenderer.on(PlatformChannels.RemoteSessionClosed, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionClosed, handler);
  },
  /** Subscribe to the remote workspace reconnection success event triggered by Bot and return disposer */
  onBotRemoteWorkspaceReconnected: (
    callback: (event: BotRemoteWorkspaceReconnectedEvent) => void,
  ) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as BotRemoteWorkspaceReconnectedEvent);
    ipcRenderer.on(PlatformChannels.BotRemoteWorkspaceReconnected, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BotRemoteWorkspaceReconnected, handler);
  },
  /** Check if the directory is already open in another window */
  activateOrSetWorkspace: (path: string): Promise<{ activated: boolean }> =>
    ipcRenderer.invoke(PlatformChannels.ActivateOrSetWorkspace, path),
  /** Synchronize the workspace paths of all tabs in the current window to the main process */
  syncWindowTabs: (paths: string[]) => ipcRenderer.send(PlatformChannels.SyncWindowTabs, paths),
  /** Synchronize the workspace that Web remote control allows switching in the current window */
  /** Synchronize the task snapshots that can be displayed by Web remote control in the current window */
  /** Synchronize the unread task count of the current window to the main process */
  syncWindowUnreadCount: (count: number) =>
    ipcRenderer.send(PlatformChannels.SyncWindowUnreadCount, count),
  syncActiveTaskSession: (sessionId: string | null) =>
    ipcRenderer.send(PlatformChannels.SyncActiveTaskSession, sessionId),
  /** Synchronization requires application settings that the main process is immediately aware of */
  syncAppSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.send(PlatformChannels.SyncAppSettings, patch),
  /** Shortcut key settings page recording status switch: main temporarily removes the configurable menu accelerator to prevent the recording button from triggering the original command */
  setShortcutRecordingActive: (active: boolean) =>
    ipcRenderer.send(PlatformChannels.SetShortcutRecordingActive, active),
  /** Register the main process to request the callback to focus on the specified workspace tab and return the disposer */
  onFocusTab: (callback: (path: string) => void): (() => void) => {
    const handler = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on(PlatformChannels.FocusTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.FocusTab, handler);
  },
  /** Register the main process to trigger the callback of the new tab and return the disposer */
  onNewTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTab, handler);
  },
  /** Register the main process to request a callback to close the current context and return the disposer */
  onCloseActiveContextRequest: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.CloseActiveContextRequest, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.CloseActiveContextRequest, handler);
  },
  /** Register the controlled new page request of the built-in webview and return the disposer */
  onOpenBrowserUrl: (callback: (request: EmbeddedBrowserOpenUrlRequest) => void): (() => void) => {
    const handler = (_event: unknown, request: EmbeddedBrowserOpenUrlRequest) => callback(request);
    ipcRenderer.on(PlatformChannels.OpenBrowserUrl, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenBrowserUrl, handler);
  },
  /** Register the agent and use the browser command for the first time to create the callback of the controlled view (automatically open the browser-use tab) and return to the disposer */
  onBrowserViewReady: (
    callback: (payload: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        tabId: string;
        browserId: string;
        browserGeneration: number;
      },
    ) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewReady, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewReady, handler);
  },
  /** Register agent browser-use to hit the operation status callback of the real tab and return disposer. */
  onBrowserViewOperation: (
    callback: (payload: BrowserViewOperationPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewOperationPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewOperation, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewOperation, handler);
  },
  /** Register the currently controlled tab viewport change callback, which is used to synchronize the free size mode when the Agent is set. */
  onBrowserViewViewportChanged: (
    callback: (payload: BrowserViewViewportChangedPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewViewportChangedPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewViewportChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewViewportChanged, handler);
  },
  onBrowserViewScreenshotSurfacePrepare: (
    callback: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewScreenshotSurfacePreparePayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
  },
  onBrowserViewScreenshotSurfaceRelease: (
    callback: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewScreenshotSurfaceReleasePayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
  },
  browserViewScreenshotSurfaceReady: (payload: BrowserViewScreenshotSurfaceReadyPayload): void => {
    ipcRenderer.send(PlatformChannels.BrowserViewScreenshotSurfaceReady, payload);
  },
  onBrowserViewVisibility: (
    callback: (payload: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        visible: boolean;
        workspaceKey: string;
        remoteSessionId: string | undefined;
        sessionId: string;
        tabId?: string;
        browserId: string;
        browserGeneration: number;
      },
    ) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewVisibility, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewVisibility, handler);
  },
  /** Register the agent close command to request the callback to uninstall the controlled tab, and return the disposer */
  onBrowserViewCloseTab: (
    callback: (payload: BrowserViewCloseTabNotification) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewCloseTabNotification) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewCloseTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewCloseTab, handler);
  },
  onBrowserViewSuspend: (
    callback: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewResidencyTransitionPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewSuspend, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewSuspend, handler);
  },
  onBrowserViewRestore: (
    callback: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewResidencyTransitionPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewRestore, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewRestore, handler);
  },
  /** Register the main process to trigger the callback of the new task and return the disposer */
  onNewTask: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTask, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTask, handler);
  },
  /** Register the main process to trigger the callback of opening the workspace and return disposer */
  onOpenWorkspace: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenWorkspace, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenWorkspace, handler);
  },
  /** Register deep link to directly open the local workspace directory callback and return disposer */
  onOpenWorkspacePath: (callback: (path: string) => void): (() => void) => {
    openWorkspacePathCallbacks.add(callback);
    while (pendingOpenWorkspacePaths.length > 0) {
      const path = pendingOpenWorkspacePaths.shift();
      if (path) {
        callback(path);
      }
    }
    return () => openWorkspacePathCallbacks.delete(callback);
  },
  onOpenFeedbackDialog: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenFeedbackDialog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenFeedbackDialog, handler);
  },
  onOpenTicketsPanel: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenTicketsPanel, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenTicketsPanel, handler);
  },
  /** Register window full screen status change callback, return disposer */
  onWindowFullscreenChanged: (callback: (isFullscreen: boolean) => void): (() => void) => {
    const handler = (_event: unknown, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on(PlatformChannels.WindowFullscreenChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowFullscreenChanged, handler);
  },
  /** Read window maximized status and system native rounded corner capabilities */
  getDesktopWindowChromeState: (): Promise<DesktopWindowChromeState> =>
    ipcRenderer.invoke(PlatformChannels.GetDesktopWindowChromeState),
  /** Registration window maximized state and system native rounded corner capability change callback */
  onDesktopWindowChromeStateChanged: (
    callback: (state: DesktopWindowChromeState) => void,
  ): (() => void) => {
    const handler = (_event: unknown, state: DesktopWindowChromeState) => callback(state);
    ipcRenderer.on(PlatformChannels.DesktopWindowChromeStateChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.DesktopWindowChromeStateChanged, handler);
  },
  /** Synchronously read the safety margin of the current native window control area */
  getWindowControlsOverlayMetrics: (): WindowControlsOverlayMetrics =>
    latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics(),
  /** Register the native window control area safety margin change callback and return disposer */
  onWindowControlsOverlayChanged: (
    callback: (metrics: WindowControlsOverlayMetrics) => void,
  ): (() => void) => {
    const handler = (_event: unknown, metrics: WindowControlsOverlayMetrics) => callback(metrics);
    callback(latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics());
    ipcRenderer.on(PlatformChannels.WindowControlsOverlayChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowControlsOverlayChanged, handler);
  },
  /** Synchronously read the zoom level of the current desktop window page */
  getDesktopZoomLevel: async (): Promise<DesktopZoomState> => {
    const state = await ipcRenderer.invoke(PlatformChannels.GetDesktopZoomLevel);
    if (Number.isFinite(state?.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
    return { zoomLevel: latestDesktopZoomLevel };
  },
  /** Register the current desktop window page zoom gear change callback and return disposer */
  onDesktopZoomLevelChanged: (callback: (state: DesktopZoomState) => void): (() => void) => {
    const handler = (_event: unknown, state: DesktopZoomState) => {
      if (!Number.isFinite(state.zoomLevel)) {
        return;
      }
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
      callback({ zoomLevel: latestDesktopZoomLevel });
    };
    callback({ zoomLevel: latestDesktopZoomLevel });
    ipcRenderer.on(PlatformChannels.DesktopZoomLevelChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.DesktopZoomLevelChanged, handler);
  },
  /** After the registered user clicks the system notification, it jumps to the callback of the corresponding task and returns to the disposer */
  onTaskNotificationClick: (callback: (taskId: string) => void): (() => void) => {
    const handler = (_event: unknown, taskId: string) => callback(taskId);
    ipcRenderer.on(PlatformChannels.TaskNotificationClick, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.TaskNotificationClick, handler);
  },
  /** Open external URL (for OAuth redirect browser) */
  openExternal: (url: string) => ipcRenderer.send(PlatformChannels.OpenExternal, url),
  /** Query whether there is an available user community portal in the current language */
  canOpenCommunity: (): Promise<boolean> => ipcRenderer.invoke(PlatformChannels.CanOpenCommunity),
  /** Open the specified path in the system file manager */
  openInFileManager: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenInFileManager, path),
  /** Open local files using system default application */
  openExternalFile: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenExternalFile, path),
  /** Open ZCode Computer Use full permission boot */
  openCuaPermissionOnboarding: (options?: OpenCuaPermissionOnboardingOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenCuaPermissionOnboarding, options),
  /** Only cancel the onboarding participant initiated by the current renderer with operationId. */
  cancelCuaPermissionOnboarding: (operationId: string) =>
    ipcRenderer.send(PlatformChannels.CancelCuaPermissionOnboarding, {
      operationId,
    }),
  /** Warm up and cache the validated Helper path so dragstart can synchronize startDrag (avoiding asynchronous I/O missed gestures) */
  prepareCuaHelperPermissionDrag: () =>
    ipcRenderer.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag),
  /** Drag Helper.app from the permissions pop-up window to the macOS permissions list. Must be send - the round trip to invoke will miss the gesture. */
  startCuaHelperPermissionDrag: () =>
    ipcRenderer.send(PlatformChannels.StartCuaHelperPermissionDrag),
  /** Report OAuth state for deep link routing */
  registerOAuthState: (payload: OAuthStateRegistration) =>
    ipcRenderer.send(PlatformChannels.OAuthRegisterState, payload),
  /** Register OAuth deep link callback and return disposer */
  onOAuthCallback: (cb: (url: string) => void): (() => void) => {
    const handler = createOAuthCallbackHandler(cb, () => {
      ipcRenderer.send(PlatformChannels.OAuthCallbackHandled);
    });
    ipcRenderer.on(PlatformChannels.OAuthCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OAuthCallback, handler);
  },
  /** Register payment deep link callback and return disposer */
  onPaymentCallback: (callback: (url: string) => void): (() => void) => {
    const handler = (_event: unknown, url: string) => callback(url);
    ipcRenderer.on(PlatformChannels.PaymentCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.PaymentCallback, handler);
  },
  onShareImport: (callback: (payload: { shareCode: string }) => void): (() => void) => {
    shareImportCallbacks.add(callback);
    while (pendingShareImports.length > 0) {
      const payload = pendingShareImports.shift();
      if (payload) callback(payload);
    }
    return () => shareImportCallbacks.delete(callback);
  },
  /** Notify main process renderer that it is ready */
  notifyRendererReady: () => ipcRenderer.send(PlatformChannels.RendererReady),
  /** Synchronize renderer telemetry context to main process */
  syncTelemetryContext: (context: TelemetryRendererContext) =>
    ipcRenderer.send(PlatformChannels.SyncTelemetryContext, context),
  /** Unified reporting of business telemetry events through main process */
  reportTelemetryEvent: (payload: {
    context: TelemetryRendererContext;
    elementName: string;
    eventRegion: string;
    eventType: string;
    eventText?: string;
    eventExtraDetail: Record<string, string>;
    userId?: string;
    talkId?: string;
    messageId?: string;
  }) => ipcRenderer.invoke(PlatformChannels.ReportTelemetryEvent, payload),
  /** Unified reporting of ARMS custom events through the main process */
  reportArmsCustomEvent: (payload: {
    name: string;
    group: string;
    value?: number;
    properties?: Record<string, string | number | boolean | undefined>;
  }) => ipcRenderer.invoke(PlatformChannels.ReportArmsCustomEvent, payload),
  /** Read Renderer user operation Trace grayscale configuration. */
  getRendererActionTraceConfig: (): Promise<RendererActionTraceConfigV1> =>
    ipcRenderer.invoke(PlatformChannels.GetRendererActionTraceConfig),
  /** Subscribe to Renderer user operations pushed by Main to trace configuration changes. */
  onRendererActionTraceConfigChanged: (
    callback: (config: RendererActionTraceConfigV1) => void,
  ): (() => void) => {
    const handler = (_event: unknown, config: RendererActionTraceConfigV1) => callback(config);
    ipcRenderer.on(PlatformChannels.RendererActionTraceConfigChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.RendererActionTraceConfigChanged, handler);
  },
  /** Span has been sent; use send to avoid telemetry round-trips blocking the business. */
  reportLocalTtftBatch: (batch: import("@zcode/shared").LocalTtftBatch): void =>
    ipcRenderer.send(PlatformChannels.ReportLocalTtftBatch, batch),
  reportRendererActionTraceBatch: (batch: RendererActionTraceBatchV1): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererActionTraceBatch, batch),
  /**
   * 60 seconds of heap readings for the main window renderer.
   * Only one-way send is provided: main does not receive a receipt, and the renderer cannot rely on it to check the process facts of main.
   */
  reportRendererHeapSample: (sample: RendererHeapSample): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererHeapSample, sample),
  /** Trigger native task notification through main process */
  showTaskNotification: (payload: TaskNotificationPayload) =>
    ipcRenderer.send(PlatformChannels.ShowTaskNotification, payload),
  /** Export logs: package ~/.zcode/v2 and external agent logs into zip and display them in Finder */
  exportLogs: (): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> => ipcRenderer.invoke(PlatformChannels.ExportLogs),
  /** Capture the current window for error feedback and carry live images */
  captureWindowScreenshot: () => ipcRenderer.invoke(PlatformChannels.CaptureWindowScreenshot),
  // CDP-on-guest pivot: `<webview>` reports webContentsId to main attach after guest dom-ready.
  browserViewAttachGuest: (payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    residencyGeneration?: number;
  }): Promise<BrowserGuestAttachResult> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewAttachGuest, payload),
  /** React unloads old `<webview>` presync wait main disconnects native CDP session. */
  browserViewDetachGuest: (payload: { key: string; webContentsId: number }): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewDetachGuest, payload),
  browserViewCloseTab: (payload: BrowserViewCloseTabRequest): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewCloseTabFromRenderer, payload),
  browserViewReportResidency: (payload: BrowserViewResidencyReportPayload): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewReportResidency, payload),
  browserViewSuspendReady: (payload: { tabId: string; generation: number }): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewSuspendReady, payload),
  browserViewEnsureResident: (payload: BrowserViewCloseTabRequest): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewEnsureResident, payload),
  browserViewRestoreTabs: (
    payload: BrowserViewRestoreTabsRequest,
  ): Promise<BrowserViewRestoredTabShell[]> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewRestoreTabs, payload),
  /** Synchronize the UI free size to the real viewport of the currently controlled tab. */
  browserViewUpdateViewport: (payload: { tabId: string; viewport: BrowserViewportSize | null }) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewUpdateViewport, payload),
  /** One-time import of built-in browser data from auto-discovered Chrome Profiles. */
  importChromeBrowserData: (options?: import("@zcode/shared").ChromeBrowserDataImportOptions) =>
    ipcRenderer.invoke(PlatformChannels.ImportChromeBrowserData, options),
  /** Clear the built-in browser cache or all site data. */
  clearEmbeddedBrowserData: (mode: "cache" | "all") =>
    ipcRenderer.invoke(PlatformChannels.ClearEmbeddedBrowserData, mode),
  /** Read the development status stdio tap proxy switch status */
  getZCodeStdioTapDevState: (): Promise<ZCodeStdioTapDevState> =>
    ipcRenderer.invoke(PlatformChannels.GetZCodeStdioTapDevState),
  /** Register the notification after the main process modifies the settings and return the disposer */
  onSettingsChanged: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.SettingsChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.SettingsChanged, handler);
  },
  /** Register a callback for the result of "Manually Check for Updates" and return disposer */
  onUpdateCheckResult: (callback: (payload: UpdateCheckResultPayload) => void): (() => void) => {
    const handler = (_event: unknown, payload: UpdateCheckResultPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.UpdateCheckResult, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.UpdateCheckResult, handler);
  },
  getUpdateState: (): Promise<UpdateStatePayload> =>
    ipcRenderer.invoke(PlatformChannels.GetUpdateState),
  /** Start downloading currently discovered updates */
  downloadUpdate: () => ipcRenderer.invoke(PlatformChannels.DownloadUpdate),
  /** Cancel the update currently being downloaded */
  cancelUpdateDownload: () => ipcRenderer.invoke(PlatformChannels.CancelUpdateDownload),
  /** Open independent update window */
  openUpdateStatusWindow: () => ipcRenderer.invoke(PlatformChannels.OpenUpdateStatusWindow),
  /** Read auto-update preferences */
  getAutoUpdatePreferences: () => ipcRenderer.invoke(PlatformChannels.GetAutoUpdatePreferences),
  /** Set the "Automatically download and install updates" preference */
  setAutoDownloadAndInstallUpdates: (enabled: boolean) =>
    ipcRenderer.invoke(PlatformChannels.SetAutoDownloadAndInstallUpdates, enabled),
  getDesktopSessionActivity: () => ipcRenderer.invoke(PlatformChannels.GetDesktopSessionActivity),
  /** Register for automatic update of continuous status changes and return to disposer */
  onUpdateStateChanged: (callback: (payload: UpdateStatePayload) => void): (() => void) => {
    updateStateCallbacks.add(callback);
    if (latestUpdateState) {
      callback(latestUpdateState);
    }
    return () => {
      updateStateCallbacks.delete(callback);
    };
  },
  /** Register the callback when the new version has been downloaded and return to disposer */
  onUpdateReady: (callback: (version: string) => void): (() => void) => {
    // The update-ready of the main process is a one-time event, often registered earlier than the React effect.
    // Here, the latest version is cached in the preload layer and played back immediately upon subscription.
    // In this way, even if the UI is mounted late, it can still get the stable status of "update has been downloaded".
    updateReadyCallbacks.add(callback);
    if (latestReadyUpdateVersion) {
      callback(latestReadyUpdateVersion);
    }
    return () => {
      updateReadyCallbacks.delete(callback);
    };
  },
  /** Register and update the version notes after installation and return to disposer */
  onPostUpdateReleaseNotes: (
    callback: (payload: PostUpdateReleaseNotesPayload) => void,
  ): (() => void) => {
    postUpdateReleaseNotesCallbacks.add(callback);
    if (latestPostUpdateReleaseNotes) {
      callback(latestPostUpdateReleaseNotes);
    }
    return () => {
      postUpdateReleaseNotesCallbacks.delete(callback);
    };
  },
  /** Mark current release notes as read */
  acknowledgePostUpdateReleaseNotes: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.AcknowledgePostUpdateReleaseNotes, version),
  /** Skip currently discovered updated versions */
  skipUpdateVersion: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.SkipUpdateVersion, version),
  /** User confirms reboot to install updates */
  quitAndInstallUpdate: () => ipcRenderer.invoke(PlatformChannels.QuitAndInstallUpdate),
  /** Get the list of installed editors/terminals (with icons) */
  getInstalledEditors: () => ipcRenderer.invoke(PlatformChannels.GetInstalledEditors),
  getApplicationIcon: (request: string | ApplicationIconRequest) =>
    ipcRenderer.invoke(PlatformChannels.GetApplicationIcon, request),
  /** Open the path with the specified editor */
  openInEditor: (editorId: string, path: string, options?: OpenInEditorOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenInEditor, {
      editorId,
      path,
      options,
    }),
  /** Execute desktop window level commands */
  executeDesktopCommand: (command: DesktopCommandId) =>
    ipcRenderer.invoke(PlatformChannels.ExecuteDesktopCommand, command),
  /** Synchronize title bar light and dark colors */
  setTitleBarTheme: (theme: DesktopTitleBarTheme) =>
    ipcRenderer.invoke(PlatformChannels.SetTitleBarTheme, theme),
  /** Get the desktop device identifier (deviceMid) */
  getDeviceId: () => ipcRenderer.invoke(PlatformChannels.GetDeviceId),
});

/**
 * MessagePort cannot be passed through contextBridge (contextBridge will wrap it into Proxy,
 * Lost native methods such as addEventListener). Use transfer of window.postMessage instead
 * The mechanism passes the MessagePort unchanged into the renderer's window context.
 */
ipcRenderer.on(InternalChannels.ServicePort, (event, payload: unknown) => {
  const [port] = event.ports;
  const parsed = databaseStartupPortPayloadSchema.safeParse(payload);
  if (port && parsed.success)
    window.postMessage({ type: InternalChannels.ServicePort, ...parsed.data }, "*", [port]);
  else port?.close();
});

ipcRenderer.on(
  InternalChannels.ScopedServicePort,
  (
    event,
    payload: {
      attachmentId?: string;
      sessionId?: string;
      target?: RemoteTarget;
    },
  ) => {
    const [port] = event.ports;
    if (port) {
      window.postMessage(
        {
          type: InternalChannels.ScopedServicePort,
          attachmentId: payload.attachmentId,
          sessionId: payload.sessionId,
          target: payload.target,
        },
        "*",
        [port],
      );
    }
  },
);

window.addEventListener("message", (event) => {
  if (event.source !== window || typeof event.data !== "object" || event.data === null) {
    return;
  }
  const payload = event.data as {
    type?: unknown;
    attachmentId?: unknown;
    sessionId?: unknown;
  };
  if (
    payload.type !== InternalChannels.ScopedServicePortReady ||
    typeof payload.attachmentId !== "string" ||
    !payload.attachmentId ||
    typeof payload.sessionId !== "string" ||
    !payload.sessionId
  ) {
    return;
  }
  // MessagePort registration occurs in an isolated renderer world, and Main cannot mistake "delivered" for "available".
  // Preload only forwards the renderer's ready ACK to Main, and the business attachment status is still managed by the window session manager.
  ipcRenderer.send(InternalChannels.ScopedServicePortReady, {
    attachmentId: payload.attachmentId,
    sessionId: payload.sessionId,
  });
});

ipcRenderer.on(PlatformChannels.TaskNotificationSound, () => {
  window.postMessage(InternalChannels.TaskNotificationSound, "*");
});

ipcRenderer.on(PlatformChannels.UpdateReady, (_event, version: string) => {
  notifyUpdateReadyCallbacks(version);
});

ipcRenderer.on(PlatformChannels.UpdateStateChanged, (_event, payload: UpdateStatePayload) => {
  notifyUpdateStateCallbacks(payload);
});

ipcRenderer.on(
  PlatformChannels.PostUpdateReleaseNotes,
  (_event, payload: PostUpdateReleaseNotesPayload) => {
    notifyPostUpdateReleaseNotesCallbacks(payload);
  },
);

// If Bridge is reset after dom-ready autoInject, try packaging again
scheduleArmsEventBridgePatch();

// Start the control plane before ordinary RPC; reload is completed from Main's notification mirror and does not trigger new migration.
ipcRenderer.on(InternalChannels.DatabaseStartupState, (_event, raw: unknown) => {
  const parsed = databaseStartupStateSchema.safeParse(raw);
  if (parsed.success)
    window.postMessage({ type: InternalChannels.DatabaseStartupState, state: parsed.data }, "*");
});
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== InternalChannels.DatabaseStartupControl)
    return;
  const parsed = databaseStartupControlSchema.safeParse(event.data.control);
  if (parsed.success) ipcRenderer.send(InternalChannels.DatabaseStartupControl, parsed.data);
});
