/* eslint-disable max-lines -- Desktop platform IPC is assembled in one place; scattering it makes the permission boundary harder to audit, and the line count grows with the platform's capabilities. */
import { BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import { readZCodeStdioTapDevState } from "@zcode/services/node";
import {
  DEFAULT_LOCALE,
  DesktopCommandIds,
  appSettingsPatchSchema,
  formatZodError,
  nonEmptyStringSchema,
  PlatformChannels,
  rendererLogPayloadSchema,
  stringArraySchema,
  type DesktopCommandId,
  type ApplicationIconRequest,
  type Locale,
  type LoadCliMcpFromUserDirectoryRequest,
  type MigrateLegacyCommonMcpRequest,
  type OpenInEditorOptions,
  type SaveCliMcpToUserDirectoryRequest,
  type CreateTempTextAttachmentRequest,
  type UpdateStatePayload,
  type WindowControlsOverlayReadyPayload,
} from "@zcode/shared";
import { getInstalledEditors } from "./editors.js";
import { getApplicationIcon } from "./applicationIcons.js";
import { exportLogs } from "./exportLogs.js";
import { resolveCommunityUrl } from "./desktopCommandHandlers.js";
import { openInEditor } from "./openInEditor.js";
import {
  openResourceManager,
  getResourceUsageSnapshot,
  setResourceUsageSamplingActive,
} from "./resourceManagerWindow.js";
import { registerResourceManagerStorageIpc } from "./resourceManagerStorage.js";
import { applyWindowsTitleBarTheme, getWindowOverlayTheme } from "./desktopWindowChrome.js";
import { syncWindowControlsOverlayForZoomLevel } from "./desktopWindowButtonPosition.js";
import { resolveDesktopZoomLevelFromFactor } from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import { handleWindowUnreadCountSync } from "./desktopWindowLifecycle.js";
import { captureWindowScreenshot, openPathInFileManager } from "./desktopMainIpcHelpers.js";
import { registerCuaPermissionIpcHandlers } from "./desktopCuaPermissionIpc.js";
import {
  registerDesktopBrowserIpcHandlers,
  type AttachBrowserGuest,
  type ReportBrowserScreenshotSurfaceReady,
  type UpdateBrowserGuestViewport,
  type BrowserViewResidencyIpcHandlers,
} from "./desktopBrowserViewIpc.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "./mcpUserDirectory/index.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { registerDesktopSaveFileIpcHandler } from "./desktopSaveFile.js";
import { registerDesktopPrintToPdfIpcHandler } from "./desktopPrintToPdf.js";
import { registerCuaPipActiveSessionIpc } from "./desktopCuaPipIpc.js";

export function registerPlatformIpcHandlers(options: {
  fetchHelpConfig?: () => Promise<unknown>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  focusWorkspaceInExistingWindow: (
    path: string,
    extra?: { skipWindowId?: number },
  ) => { activated: boolean; winId?: number };
  windowWorkspaceMap: Map<number, Set<string>>;
  windowUnreadCountMap: Map<number, number>;
  currentApplicationLocale: () => Locale;
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  acknowledgePostUpdateReleaseNotes: (version: string) => Promise<void>;
  syncActiveTaskSession: (windowId: number, sessionId: string | null) => void;
  syncTaskRealtimeWorkspaceKeys: (windowId: number, workspaceKeys: Iterable<string>) => void;
  getUpdateState: () => UpdateStatePayload;
  openUpdateStatusWindow: () => void;
  getDesktopSessionActivity: () => {
    runningAgentSessionCount: number;
  };
  getAutoUpdatePreferences: () => Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;
  setAutoDownloadAndInstallUpdates: (enabled: boolean) => Promise<void>;
  syncAppSettings: (patch: unknown) => void;
  /** Shortcut settings page recording-state switch: when true, main rebuilds the menu with configurable accelerators removed */
  setShortcutRecordingActive?: (active: boolean, ownerWebContentsId?: number | null) => void;
  /** The desktop device identifier (SHA-256 over the userData path) */
  deviceMid: string;
  /** CDP-on-guest pivot: the renderer `<webview>` reports a guest webContentsId → main attaches. */
  attachBrowserGuest?: AttachBrowserGuest;
  /** Free-form renderer size change → the controlled tab that owns the current window. */
  updateBrowserGuestViewport?: UpdateBrowserGuestViewport;
  /** The trusted owner renderer reports that the offscreen screenshot surface is ready. */
  reportBrowserScreenshotSurfaceReady?: ReportBrowserScreenshotSurfaceReady;
  /** Browser tab close, suspend, resume, and cross-restart shell IPC. */
  browserViewResidencyHandlers?: BrowserViewResidencyIpcHandlers;
}) {
  ipcMain.handle(PlatformChannels.SelectDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(PlatformChannels.SelectFile, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(PlatformChannels.SelectFiles, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }
    return result.filePaths;
  });

  registerDesktopSaveFileIpcHandler(options.logger);
  registerDesktopPrintToPdfIpcHandler(options.logger);

  ipcMain.handle(
    PlatformChannels.CreateTempTextAttachment,
    async (_event, payload: CreateTempTextAttachmentRequest) => {
      return createTempTextAttachment(payload);
    },
  );

  registerDesktopBrowserIpcHandlers(
    options.attachBrowserGuest,
    options.updateBrowserGuestViewport,
    options.logger,
    options.reportBrowserScreenshotSurfaceReady,
    options.browserViewResidencyHandlers,
  );

  ipcMain.handle(PlatformChannels.ActivateOrSetWorkspace, (event, path: string) => {
    const validatedPath = nonEmptyStringSchema.parse(path);
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    const activated = options.focusWorkspaceInExistingWindow(validatedPath, {
      skipWindowId: senderWin?.id,
    });
    if (activated.activated) {
      return { activated: true };
    }

    if (senderWin) {
      let pathSet = options.windowWorkspaceMap.get(senderWin.id);
      if (!pathSet) {
        pathSet = new Set();
        options.windowWorkspaceMap.set(senderWin.id, pathSet);
        senderWin.on("closed", () => options.windowWorkspaceMap.delete(senderWin.id));
      }
      pathSet.add(validatedPath);
      options.syncTaskRealtimeWorkspaceKeys(senderWin.id, pathSet);
    }
    return { activated: false };
  });

  ipcMain.handle(PlatformChannels.GetResourceUsageSnapshot, (event) =>
    getResourceUsageSnapshot(event.sender.id),
  );
  ipcMain.on(PlatformChannels.SetResourceUsageSamplingActive, (event, active: unknown) => {
    if (typeof active === "boolean") setResourceUsageSamplingActive(event.sender.id, active);
  });
  registerResourceManagerStorageIpc();
  ipcMain.handle(PlatformChannels.GetZCodeStdioTapDevState, () => readZCodeStdioTapDevState());
  ipcMain.on(PlatformChannels.OpenResourceManager, () => {
    openResourceManager();
  });

  ipcMain.handle(
    PlatformChannels.LoadMcpFromUserDirectory,
    async (_event, payload?: LoadCliMcpFromUserDirectoryRequest) => {
      return loadCliMcpFromUserDirectory(payload);
    },
  );

  ipcMain.handle(
    PlatformChannels.SaveMcpToUserDirectory,
    async (_event, payload: SaveCliMcpToUserDirectoryRequest) => {
      try {
        await saveCliMcpToUserDirectory(payload);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn("[mcp-user-directory] save failed", message);
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PlatformChannels.MigrateLegacyCommonMcp,
    async (_event, payload?: MigrateLegacyCommonMcpRequest) => {
      return migrateLegacyCommonMcp(payload);
    },
  );

  ipcMain.handle(PlatformChannels.SetTitleBarTheme, (event, theme: string) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow) {
      return;
    }

    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      options.logger.warn("[title-bar-theme] invalid theme:", theme);
      return;
    }

    nativeTheme.themeSource = theme;
    applyWindowsTitleBarTheme(senderWindow, theme === "system" ? getWindowOverlayTheme() : theme);
  });

  ipcMain.on(PlatformChannels.SyncWindowTabs, (event, paths: string[]) => {
    const result = stringArraySchema.safeParse(paths);
    if (!result.success) {
      options.logger.warn("[sync-window-tabs] invalid payload:", formatZodError(result.error));
      return;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      options.windowWorkspaceMap.set(win.id, new Set(result.data));
      options.syncTaskRealtimeWorkspaceKeys(win.id, result.data);
    }
  });

  ipcMain.on(PlatformChannels.SyncWindowUnreadCount, (event, payload: unknown) => {
    handleWindowUnreadCountSync(
      BrowserWindow.fromWebContents(event.sender),
      payload,
      options.windowUnreadCountMap,
      options.logger,
    );
  });
  registerCuaPipActiveSessionIpc({
    syncActiveTaskSession: options.syncActiveTaskSession,
    warn: (message) => options.logger.warn(message),
  });
  ipcMain.on(
    PlatformChannels.WindowControlsOverlayReady,
    (event, payload: WindowControlsOverlayReadyPayload) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow || !Number.isFinite(payload.zoomLevel)) {
        return;
      }

      // The preload runs earlier than the React page. Use the zoom gear it synchronizes to to adjust the macOS traffic light first.
      // Avoid waiting for RootStartupLoading to switch to the App page before resetting the location.
      syncWindowControlsOverlayForZoomLevel(senderWindow, payload.zoomLevel);
    },
  );

  ipcMain.on(PlatformChannels.SyncAppSettings, (_event, payload: unknown) => {
    const result = appSettingsPatchSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[settings] invalid app settings sync payload:",
        formatZodError(result.error),
      );
      return;
    }

    options.syncAppSettings(result.data);
  });

  // Shortcut key recording state: Notify when entering/exiting recording on the renderer settings page. macOS system menu will precede renderer
  // To eat the buttons and record the menu channel command, you must first remove the configurable accelerator, otherwise the button will directly trigger the original command.
  // Comes with the initiator webContents id: when the window is destroyed during recording, the main side is reset accordingly (see index.ts).
  ipcMain.on(PlatformChannels.SetShortcutRecordingActive, (event, payload: unknown) => {
    if (typeof payload !== "boolean") {
      options.logger.warn("[shortcuts] invalid recording-active payload:", payload);
      return;
    }
    options.setShortcutRecordingActive?.(payload, event.sender.id);
  });

  ipcMain.on(PlatformChannels.Log, (_event, payload: unknown) => {
    const result = rendererLogPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn("[renderer-log] invalid payload:", formatZodError(result.error));
      return;
    }
    (
      options.logger as unknown as { fromRenderer(level: string, args: unknown[]): void }
    ).fromRenderer?.(result.data.level, result.data.args);
  });

  ipcMain.handle(PlatformChannels.OpenInFileManager, async (_event, rawPath: string) =>
    openPathInFileManager(rawPath, options.logger),
  );

  registerCuaPermissionIpcHandlers({
    logger: options.logger,
    currentApplicationLocale: options.currentApplicationLocale,
  });

  ipcMain.handle(PlatformChannels.CanOpenCommunity, async () => {
    const communityUrl = await resolveCommunityUrl({
      locale: DEFAULT_LOCALE,
      fetchRemoteConfig: options.fetchHelpConfig,
      logger: options.logger,
    });

    return typeof communityUrl === "string" && communityUrl.length > 0;
  });

  ipcMain.handle(
    PlatformChannels.AcknowledgePostUpdateReleaseNotes,
    async (_event, version: string) => {
      const validatedVersion = nonEmptyStringSchema.parse(version);
      await options.acknowledgePostUpdateReleaseNotes(validatedVersion);
    },
  );

  ipcMain.handle(PlatformChannels.GetUpdateState, () => options.getUpdateState());
  ipcMain.handle(PlatformChannels.OpenUpdateStatusWindow, () => {
    options.openUpdateStatusWindow();
  });
  ipcMain.handle(PlatformChannels.GetAutoUpdatePreferences, () =>
    options.getAutoUpdatePreferences(),
  );
  ipcMain.handle(
    PlatformChannels.SetAutoDownloadAndInstallUpdates,
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        return;
      }
      await options.setAutoDownloadAndInstallUpdates(enabled);
    },
  );
  ipcMain.handle(PlatformChannels.GetDesktopSessionActivity, () =>
    options.getDesktopSessionActivity(),
  );
  ipcMain.handle(PlatformChannels.GetDesktopZoomLevel, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) {
      return { zoomLevel: 0 };
    }

    return {
      zoomLevel: resolveDesktopZoomLevelFromFactor(senderWindow.webContents.getZoomFactor()),
    };
  });
  ipcMain.handle(PlatformChannels.GetDesktopWindowChromeState, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return resolveDesktopWindowChromeState(senderWindow?.isMaximized() ?? false);
  });
  ipcMain.handle(PlatformChannels.GetInstalledEditors, () => getInstalledEditors());
  ipcMain.handle(
    PlatformChannels.GetApplicationIcon,
    (_event, request: string | ApplicationIconRequest) => getApplicationIcon(request),
  );
  ipcMain.handle(PlatformChannels.GetDeviceId, () => options.deviceMid);
  ipcMain.handle(PlatformChannels.ExportLogs, () => exportLogs());
  ipcMain.handle(PlatformChannels.CaptureWindowScreenshot, async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return captureWindowScreenshot(senderWindow);
  });
  ipcMain.handle(
    PlatformChannels.OpenInEditor,
    (_event, payload: { editorId: string; path: string; options?: OpenInEditorOptions }) =>
      openInEditor(payload.editorId, payload.path, payload.options),
  );

  ipcMain.handle(PlatformChannels.ExecuteDesktopCommand, async (event, command: string) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const isKnownCommand = (Object.values(DesktopCommandIds) as string[]).includes(command);
    if (!isKnownCommand) {
      options.logger.warn("[desktop-command] invalid command:", command);
      return;
    }

    // The return value is passed through the renderer's executeDesktopCommand promise (GetCuaOsSupport relies on this behavior).
    return await options.executeDesktopCommand(command as DesktopCommandId, senderWindow);
  });
}
