import { createLocalTtftExporter } from "./localTtftExporter.js";
/* eslint-disable max-lines */
import "./desktopEarlyDataBaseDirBootstrap.js";
import "./desktopEarlyChromiumHardwareAccelerationBootstrap.js";
import { powerMonitor, powerSaveBlocker } from "electron";
import { crashCapturePaths } from "./appCrashCaptureBootstrap.js";
import { armsInitPromise } from "./appARMSBootstrap.js";
import {
  onLocalDatabaseStartupReady,
  configureDatabaseStartupQuit,
} from "./databaseStartupRelay.js";
import armsRum from "@arms/rum-electron";
import { createArmsUserIdentitySync } from "./armsUserIdentity.js";
import { ensureDesktopDeviceMidSync } from "./desktopDeviceMid.js";
import {
  createDesktopContextPromptRollout,
  createElectronDesktopContextPromptConfigFetcher,
} from "./desktopContextPromptRollout.js";
import { buildBrowserViewCloseTabNotification } from "./browserView/browserCloseTabNotification.js";
import { BrowserGuestManager } from "./browserView/browserGuestManager.js";
import { createElectronBrowserWebmRecorder } from "./browserView/electronBrowserWebmRecorder.js";
import { installBrowserRestoreBootstrapProtocol } from "./browserView/browserRestoreBootstrapProtocol.js";
import {
  createLocalMediaPreviewPathRegistry,
  installLocalMediaPreviewProtocol,
  registerLocalMediaPreviewScheme,
} from "./localMediaPreviewProtocol.js";
import { createDesktopBrowserScreenshotSurfaceCoordinator } from "./browserView/browserScreenshotSurfaceCoordinatorWiring.js";
import { EMBEDDED_BROWSER_PARTITION } from "./browserDataManager.js";
import { EmbeddedBrowserJavaScriptDialogController } from "./embeddedBrowserJavaScriptDialog.js";
import {
  browserOperationResetsResizeBaseline,
  resolveBrowserOperationTabId,
} from "./browserView/browserOperationIndicator.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  net,
  protocol,
  session,
  webContents,
} from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import {
  createCredentialService,
  createSettingService,
  createTelemetryCore,
  createTelemetryMarketingParamsLoader,
  createTelemetryUserIdLoader,
  createTelemetryAuthorizationLoader,
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  getConversationWorkspaceDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  normalizeRuntimeProcessEnv,
  setDataBaseDir,
} from "@zcode/services/node";
import {
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  type Locale,
  type AppSettings,
  PlatformChannels,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  DEFAULT_LOCALE,
  ZCODE_VERSION,
  ZCODE_TELEMETRY_ENABLED,
  ZCODE_ARMS_RUM_ENDPOINT,
  buildZCodeEndpointUrls,
  resolveZCodeEndpointOrigin,
  shouldEnableE2ETestBridge,
  type UpdateStatePayload,
  type TelemetryEventPayload,
  HostMessageTypes,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { markMainLaunchAppReady } from "./desktopLaunchMarks.js";
import { createCuaPipFocusRouter, resolveCuaPipWindowKey } from "./cuaPipFocusRouter.js";
import { createDesktopTelemetryFetch } from "./desktopTelemetryFetch.js";
import {
  acknowledgePostUpdateReleaseNotes,
  getAutoUpdaterState,
  hydratePendingPostUpdateReleaseNotes,
  initAutoUpdater,
  onAutoUpdaterStateChanged,
  refreshAutoUpdaterReleaseChannel,
  resolveUpdateFeedSourceFromStartupConfig,
  syncAutoUpdaterStateToWindow,
  syncPostUpdateReleaseNotesToWindow,
  syncReadyUpdateToWindow,
} from "./autoUpdater.js";
import { BroadcastHub } from "./broadcastHub.js";
import { TaskRealtimeBus } from "./taskRealtimeBus.js";
import { createAppLaunchGate } from "./appLaunchGate.js";
import { createAppLaunchCoordinator } from "./appLaunchCoordinator.js";
import { createAppTelemetryRuntime } from "./appTelemetryRuntime.js";
import { createRendererActionTraceBroker } from "./rendererActionTraceBroker.js";
import { createRendererActionTraceExporter } from "./rendererActionTraceExporter.js";
import { registerRendererActionTraceIpc } from "./rendererActionTraceIpc.js";
import { createRendererActionTraceRollout } from "./rendererActionTraceRollout.js";
import {
  resolveAppShutdownPolicy,
  selectAppShutdownPolicy,
  type AppShutdownKind,
} from "./appShutdownPolicy.js";
import { createPrimaryWindowCoordinator } from "./primaryWindowCoordinator.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { flushMainE2ECoverage } from "./e2eCoverage.js";
import { resolveStartupWindowBootstrap, type StartupWindowBootstrap } from "./startupWorkspace.js";
import {
  createStartupDeepLinkConsumptionGate,
  type ExplicitStartupWorkspaceRequest,
  resolveExplicitStartupWorkspaceBootstrap,
} from "./startupWorkspaceDeepLinkGate.js";
import { executeDesktopCommand } from "./desktopCommandHandlers.js";
import { clampDesktopZoomLevel, resolveDesktopZoomLevelFromFactor } from "./desktopZoom.js";
import {
  rebuildApplicationMenu,
  updateZCodeStdioTapDevMenuState,
} from "./desktopApplicationMenu.js";
import { applyAppIcon } from "./desktopWindowChrome.js";
import { resolveWindowsAppUserModelIdForFlavor } from "../../scripts/desktop-product-identity.mjs";
import type { DesktopWindowSize } from "./desktopWindowSize.js";
import { maybeWarnArchitectureMismatch } from "./desktopArchitectureGuard.js";
import { maybeBlockStartupForForceUpdate } from "./forceUpdateGuard.js";
import { createWindowsDesktopTray, updateWindowsDesktopTrayMenu } from "./desktopTray.js";
import { createWindowsCuaOperationIndicator } from "./windowsCuaOperationIndicator.js";
import {
  configureDockMenu,
  createWindow,
  focusWorkspaceInExistingWindow,
  showCurrentWindowFromDock,
  syncApplicationUnreadBadge,
  handleDesktopWindowCloseRequest,
} from "./desktopWindowLifecycle.js";
import { resolveZCodeBuiltinProviderConfigFilePath } from "./desktopProviderConfig.js";
import {
  getCredentialsDir,
  listSSHConfigAliases,
  listAvailableWSLDistros,
  loadHostProcessEnvFromLocalFiles,
  resolveBundledGlmBinaryPath,
  resolveRemoteAssetDirs,
  resolveZCodeEndpointEnvBaseOrigin,
  desktopRuntimeEnv,
  runtimeApplicationName,
  runtimeHomePath,
  runtimeSessionDataPath,
  runtimeUserDataPath,
  shouldUseElectronDefaultUserDataPath,
} from "./desktopRuntimeEnv.js";
import {
  disposeHostProcess,
  disposeHostProcessAndWait,
  listDisposingHostProcesses,
  loadWindow,
  spawnHostProcess,
} from "./desktopHostProcess.js";
import { spawnCronScheduler, type CronSchedulerHandle } from "./desktopCronScheduler.js";
import {
  clearOAuthRoutesForWindow,
  handleDeepLink,
  handleOpenWorkspacePath,
  registerDeepLinkProtocol,
  externalWorkspaceOpenDialogCopy,
} from "./desktopOAuthDeepLink.js";
import { handleSecondInstanceWorkspaceRequest } from "./desktopSecondInstanceDeepLink.js";
import { installFinderOpenFolderWorkflow } from "./desktopFinderOpenFolderWorkflow.js";
import { installWindowsOpenFolderContextMenu } from "./desktopWindowsOpenFolderContextMenu.js";
import {
  createDeepLinkSingleInstanceData,
  extractWorkspaceOpenPath,
  extractDeepLinkUrlFromArgs,
  extractOpenWorkspacePathFromArgs,
  isWorkspaceOpenUrl,
} from "./desktopDeepLinkUrl.js";
import { createRemoteWorkspaceSessionManager } from "./desktopRemoteSessions.js";
import {
  reportRemoteConnectionStateChangedToArms,
  reportRemoteDisconnectToArms,
  stopRemoteUsageArmsPeriodicSampling,
} from "./desktopRemoteUsageArmsTelemetry.js";
import { resolveCanonicalWslTarget } from "./desktopWslTargetResolver.js";
import {
  listRegisteredHostAgentProcessIds,
  setBrowserUseGuestWebContentsIdsProvider,
} from "./resourceManagerWindow.js";
import { createDesktopHelpConfigReader } from "./desktopHelpConfig.js";
import { registerPlatformIpcHandlers } from "./desktopMainIpcPlatform.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "./mcpUserDirectory/index.js";
import { registerRemoteIpcHandlers } from "./desktopMainIpcRemote.js";
import {
  configureDesktopStabilityTelemetry,
  getStabilityLifecycleScene,
  notifyStabilityAppExit,
  notifyStabilityLifecycle,
  reportAgentProcessExitToArms,
  reportAgentProcessReadyToArms,
  reportAgentProcessStartToArms,
  reportAgentProcessSpawnErrorToArms,
  reportAgentProcessExceptionToArms,
  registerDesktopStabilityMonitors,
  registerStabilityMainWindow,
  scheduleReportPerfAppStartAfterMainViewReady,
} from "./desktopStabilityTelemetry.js";
import {
  configureDesktopResourceTelemetry,
  registerDesktopResourceTelemetry,
  resolveResourceUsageScene,
  stopDesktopResourceTelemetry,
} from "./desktopResourceTelemetry.js";
import { registerRendererHeapSampleIpc } from "./processResourceRendererHeapSource.js";
import {
  registerDesktopZCodeDataSizeTelemetry,
  stopDesktopZCodeDataSizeTelemetry,
} from "./desktopZCodeDataSizeTelemetry.js";
import { configureDesktopMcpTelemetry, reportMcpTelemetryToArms } from "./desktopMcpTelemetry.js";
import {
  configureDesktopNetworkTelemetry,
  registerDesktopNetworkTelemetry,
  stopDesktopNetworkTelemetry,
} from "./desktopNetworkTelemetry.js";
import { applyDesktopChromiumNetworkPolicies } from "./desktopNetworkPolicy.js";
import { mapZCodeEnvToArmsRumEnv } from "@zcode/shared";
import {
  findWindowsProcessesReferencingResourceMarkers,
  probeWindowsPackagedResourceWritable,
  resolveWindowsPackagedResourceLockMarkers,
  runWindowsUpdateProcessCleanup,
  snapshotWindowsPackagedResources,
  WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
} from "./windowsInstallResourceLocks.js";
import { mainMemoryDiagnosticsRegistry } from "./mainMemoryDiagnostics.js";

registerLocalMediaPreviewScheme(protocol);
const localMediaPreviewPathRegistry = createLocalMediaPreviewPathRegistry();

// e2e The remote debugging port is managed by Chromedriver; if this continues to be pinned to 9229,
// It will compete with the open ZCode Dev port in the development state, causing a white screen to time out before the WebDriver session is created.
// Only local development runs enable the remote debugging port by default and allow e2e to be taken over by Chromedriver through environment variables.
if (!app.isPackaged && process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT !== "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9229");
}

app.setName(runtimeApplicationName);
if (runtimeHomePath) {
  app.setPath("home", runtimeHomePath);
}
if (!shouldUseElectronDefaultUserDataPath) {
  if (!runtimeUserDataPath || !runtimeSessionDataPath) {
    throw new Error(
      "Desktop runtime data paths are required when Electron default userData is disabled",
    );
  }
  app.setPath("userData", runtimeUserDataPath);
  app.setPath("sessionData", runtimeSessionDataPath);
}
process.title = runtimeApplicationName;

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection:", reason);
});

const iconPath =
  process.platform === "win32"
    ? app.isPackaged
      ? join(process.resourcesPath, "icon_windows.png")
      : join(import.meta.dirname, "../../build/icon_windows.png")
    : app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(import.meta.dirname, "../../build/icon.png");
const linuxDesktopIntegrationIconPath =
  process.platform === "linux"
    ? app.isPackaged
      ? join(process.resourcesPath, "icon_512x512.png")
      : join(import.meta.dirname, "../../build/icons/512x512.png")
    : iconPath;
const currentApplicationLocale: Locale = DEFAULT_LOCALE;
let closeToTrayOnWindows = true;
// keep-awake: global switch keepAwakeWhileRunning. After opening, the main process holds
// powerSaveBlocker("prevent-app-suspension"), prevents the system from idle sleep (cannot prevent closing the lid/manual sleep).
// No longer bound to idle task active count - the settings page "General" has the same configuration as the Automations portal image.
let keepAwakeWhileRunning = false;
let powerSaveBlockerId: number | null = null;
function reconcileKeepAwakeBlocker(): void {
  const shouldBlock = keepAwakeWhileRunning;
  if (shouldBlock && powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    logger.info(`[keep-awake] powerSaveBlocker started id=${powerSaveBlockerId}`);
  } else if (!shouldBlock && powerSaveBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerSaveBlockerId);
    } catch {
      // Ignore: id may be invalid.
    }
    logger.info(`[keep-awake] powerSaveBlocker stopped id=${powerSaveBlockerId}`);
    powerSaveBlockerId = null;
  }
}

const embeddedBrowserDialogController = new EmbeddedBrowserJavaScriptDialogController({
  iconPath,
  logger,
});
ipcMain.on(PlatformChannels.EmbeddedBrowserJavaScriptDialog, (event, payload: unknown) => {
  event.returnValue = embeddedBrowserDialogController.handleDialogRequest(
    event.sender.id,
    event.senderFrame?.url ?? "",
    payload,
  );
});
// browser-use CDP-on-guest pivot: main process manages `<webview>` guest by key
// webContents + CDP, providing ControlledView for executors. All execute/attach exits go here.
// Although BrowserGuestManager is the main singleton, the tab owner has window/workspace/session/generation;
// create/close is only delivered to the owner window, and the old full-window broadcast is prohibited from causing cross-window attachment.
const browserScreenshotSurfaceCoordinator = createDesktopBrowserScreenshotSurfaceCoordinator({
  fromId: (windowId) => BrowserWindow.fromId(windowId),
  fromWebContentsId: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  log: (message) => logger.debug(message),
  warn: (message) => logger.warn(message),
});
const browserGuestManager = new BrowserGuestManager(
  (msg) => logger.debug(msg),
  undefined,
  (tabId, owner) => {
    const win = owner ? BrowserWindow.fromId(owner.windowId) : null;
    if (win && !win.isDestroyed()) {
      win.webContents.send(
        PlatformChannels.BrowserViewCloseTab,
        buildBrowserViewCloseTabNotification(tabId, owner),
      );
    }
  },
  (tabId, owner) => {
    const win = BrowserWindow.fromId(owner.windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send(PlatformChannels.BrowserViewReady, {
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        sessionId: owner.sessionId,
        tabId,
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
      });
    }
  },
  (visible, owner, tabId) => {
    const win = BrowserWindow.fromId(owner.windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send(PlatformChannels.BrowserViewVisibility, {
        visible,
        workspaceKey: owner.workspaceKey,
        remoteSessionId: owner.remoteSessionId,
        sessionId: owner.sessionId,
        ...(tabId ? { tabId } : {}),
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
      });
    }
  },
  (viewport, owner, tabId) => {
    const win = BrowserWindow.fromId(owner.windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send(PlatformChannels.BrowserViewViewportChanged, {
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        sessionId: owner.sessionId,
        tabId,
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
        viewport,
      });
    }
  },
  (base64Png, target) => {
    const source = nativeImage.createFromBuffer(Buffer.from(base64Png, "base64"));
    if (source.isEmpty()) return undefined;
    const resized = source.resize({
      width: target.width,
      height: target.height,
      quality: "best",
    });
    if (resized.isEmpty()) return undefined;
    return resized.toPNG().toString("base64");
  },
  browserScreenshotSurfaceCoordinator,
  {
    // Browser shell/pageState is not restored across processes to maintain the semantics of "complete exit and clear".
    // And avoid repeated attachment of the restored shell with the new webview. Therefore recoveryStore is not injected;
    // In-process residency events are still reserved for the existing IPC compatibility layer.
    onSuspendTabRequested: (payload) => {
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewSuspend, payload);
      }
    },
    onRestoreTabRequested: (payload) => {
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewRestore, payload);
      }
    },
    onResidencyChanged: (payload) => {
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewRestore, payload);
      }
    },
    onRecoveryOrphanCloseRequested: ({ tabId, reason }) => {
      const tabOwner = browserGuestManager.getTabOwner(tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewCloseTab, {
          tabId,
          reason,
        });
      }
    },
    warn: (message) => logger.warn(message),
    recording: {
      createRecorder: (input) =>
        createElectronBrowserWebmRecorder(input, (message) => logger.debug(message)),
    },
  },
  // Transparent presentation that hides window screenshots: showInactive + opacity 0 actively requests frames during capture.
  (windowId) => BrowserWindow.fromId(windowId),
);
setBrowserUseGuestWebContentsIdsProvider(() => browserGuestManager.listGuestWebContentsIds());

// browser-use: Execute browser command with diagnostic log (shared by two spawnHostProcess wiring).
// Opening the entry/exit is convenient for locating stuck points (such as navigate loadURL hang, CDP error, etc.).
// CDP-on-guest pivot: execute browserGuestManager (win is no longer passed - guest has been associated by attachGuest).
async function runBrowserCommandOnView(params: {
  win: BrowserWindow;
  requestId: string;
  browserId?: string;
  browserGeneration?: number;
  sessionId: string;
  turnId?: string;
  workspaceKey?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  sessionContext?: "live" | "cached";
  command: unknown;
}): Promise<{ ok: boolean; [k: string]: unknown }> {
  const endDialogAutomation = embeddedBrowserDialogController.beginAutomation(params.win.id);
  const command = params.command as { method?: string; tabId?: unknown } | null;
  const method = command?.method ?? "?";
  const workspaceKey =
    params.workspaceIdentity?.trim() ||
    params.workspaceKey ||
    params.workspacePath ||
    params.sessionId;
  const requestedTabId = resolveBrowserOperationTabId(command);
  const resetsResizeBaseline = browserOperationResetsResizeBaseline(command);
  const sendOperation = (tabId: string) => {
    if (params.win.isDestroyed()) return;
    params.win.webContents.send(PlatformChannels.BrowserViewOperation, {
      workspaceKey,
      ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
      sessionId: params.sessionId,
      tabId,
      browserId: params.browserId ?? "legacy-iab",
      browserGeneration: params.browserGeneration ?? 0,
      resetsResizeBaseline,
    });
  };
  // Interaction description: Most Tab APIs explicitly carry tabId, which can light up the operation icon before the command is actually executed;
  // NewTab / default-tab compatible calls must wait for the manager to return the real meta.tabId before reissuing to avoid guessing the tab identity.
  if (requestedTabId) sendOperation(requestedTabId);
  logger.debug(
    `[browser-use] execute start browserId=${params.browserId ?? "legacy-iab"} sessionId=${params.sessionId} method=${method}`,
  );
  try {
    const result = await browserGuestManager.execute(
      {
        requestId: params.requestId,
        browserId: params.browserId ?? "legacy-iab",
        browserGeneration: params.browserGeneration ?? 0,
        windowId: params.win.id,
        workspaceKey,
        sessionId: params.sessionId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
        clientMode: params.clientMode ?? "desktop-continuous",
      },
      params.command as Parameters<typeof browserGuestManager.execute>[1],
    );
    logger.debug(
      `[browser-use] execute done sessionId=${params.sessionId} method=${method} ok=${result.ok} elapsedMs=${(result as { elapsedMs?: number }).elapsedMs ?? "?"}`,
    );
    if (!requestedTabId) {
      const resolvedTabId = resolveBrowserOperationTabId(command, result);
      if (resolvedTabId) sendOperation(resolvedTabId);
    }
    return result;
  } catch (error) {
    logger.error(
      `[browser-use] execute threw sessionId=${params.sessionId} method=${method}:`,
      error,
    );
    throw error;
  } finally {
    endDialogAutomation();
  }
}
let currentDesktopZoomLevel = 0;
let currentDesktopWindowSize: DesktopWindowSize | undefined;
const preloadPath = join(import.meta.dirname, "../preload/index.cjs");
const settingsFile = join(homedir(), ".zcode", "v2", "setting.json");
let activeAppShutdownPolicy = resolveAppShutdownPolicy("normal", process.platform);
let activeAppShutdownKind: AppShutdownKind | null = null;
const WINDOWS_AGENT_FORCE_KILL_TIMEOUT_MS = 2_000;

const broadcastHub = new BroadcastHub();
const taskRealtimeBus = new TaskRealtimeBus({ logger });
// Memory diagnostic counter: desktopResourceTelemetry collect every 60s
// Write the main log once. The will-download listening number is used to observe whether defaultSession remains listening after closing the window.
mainMemoryDiagnosticsRegistry.register("taskBus", () => taskRealtimeBus.collectMemoryDiagnostics());
mainMemoryDiagnosticsRegistry.register("broadcast", () => broadcastHub.collectMemoryDiagnostics());
mainMemoryDiagnosticsRegistry.register("guest", () =>
  browserGuestManager.collectMemoryDiagnostics(),
);
mainMemoryDiagnosticsRegistry.register("app", () => ({
  windows: BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length,
  willDownloadListeners: session.defaultSession.listenerCount("will-download"),
}));
const hostProcessLocalEnv = loadHostProcessEnvFromLocalFiles();
interface RuntimeProcessEnvPreparation {
  patchPromise: Promise<Record<string, string>>;
  fallbackPatch: Record<string, string>;
}

let runtimeProcessEnvPrewarmSequence = 0;
function createRuntimeProcessEnvPreparation(): RuntimeProcessEnvPreparation {
  const prewarmId = ++runtimeProcessEnvPrewarmSequence;
  const startedAt = Date.now();
  // Windows process.env retains the original case of Path and is no longer case-insensitive after expanding to a normal object.
  // dotenv is merged first, then the real process environment is merged, and then unified into a unique PATH, maintaining the priority semantics inherited from the old Host.
  const baseEnv = normalizeRuntimeProcessEnv(
    {
      ...hostProcessLocalEnv,
      ...process.env,
    },
    process.platform,
  );
  const fallbackPatch = buildRuntimeProcessEnvPatch(baseEnv, null, {
    platform: process.platform,
  });
  const patchPromise = captureLoginShellEnvSnapshot({
    baseEnv,
    platform: process.platform,
  }).then(
    (snapshot) => {
      const patch = buildRuntimeProcessEnvPatch(baseEnv, snapshot, {
        platform: process.platform,
      });
      if (process.platform !== "win32" && !snapshot) {
        logger.warn(
          `[startup] login shell env unavailable id=${prewarmId}; using shell-free fallback after ${Date.now() - startedAt}ms`,
        );
        return patch;
      }
      logger.info(
        `[startup] runtime process env prepared asynchronously id=${prewarmId} in ${Date.now() - startedAt}ms`,
      );
      return patch;
    },
    (error) => {
      logger.warn(
        `[startup] runtime process env prewarm failed id=${prewarmId}; using shell-free fallback`,
        error,
      );
      return fallbackPatch;
    },
  );
  return { patchPromise, fallbackPatch };
}

// The first window starts collecting at the time of Main import; subsequent windows are refreshed respectively to avoid permanent reuse of the shell snapshot when the process is started.
let initialRuntimeProcessEnvPreparation: RuntimeProcessEnvPreparation | null =
  createRuntimeProcessEnvPreparation();
function takeRuntimeProcessEnvPreparation(): RuntimeProcessEnvPreparation {
  const initialPreparation = initialRuntimeProcessEnvPreparation;
  if (initialPreparation) {
    initialRuntimeProcessEnvPreparation = null;
    return initialPreparation;
  }
  return createRuntimeProcessEnvPreparation();
}
const forceQuitRef = { current: false };
const explicitQuitRef = { current: false };
let appQuitPreparationInFlight: Promise<void> | null = null;
let hasPreparedAppQuit = false;
const windowWorkspaceMap = new Map<number, Set<string>>();
const windowTaskRealtimeHostIdMap = new Map<number, string>();
const windowUnreadCountMap = new Map<number, number>();
const windowHostProcessMap = new Map<number, ElectronUtilityProcess>();
const cuaPipFocusRouter = createCuaPipFocusRouter({
  send: (windowId, event) => {
    windowHostProcessMap.get(windowId)?.postMessage({
      type: HostMessageTypes.CuaPipFocusChanged,
      event,
    });
  },
});
const hostRunningTaskCountMap = new Map<ElectronUtilityProcess, number>();
const windowsCuaOperationIndicator = createWindowsCuaOperationIndicator({
  platform: process.platform,
  logger,
});

// The resident cron scheduler process handle; it is pulled up after the app is ready and destroyed before exiting.
let cronScheduler: CronSchedulerHandle | null = null;
// The scheduled task dispatch results of host → main are transferred to the scheduler for settlement. Forwarded via module variables to avoid spawn order coupling.
function forwardCronRunResult(
  result: Parameters<CronSchedulerHandle["handleCronRunResult"]>[0],
): void {
  cronScheduler?.handleCronRunResult(result);
}
function forwardOffPeakRunResult(
  result: Parameters<CronSchedulerHandle["handleOffPeakRunResult"]>[0],
): void {
  cronScheduler?.handleOffPeakRunResult(result);
}
function wakeCronScheduler(automationId: string): void {
  cronScheduler?.wake(automationId);
}
function wakeOffPeakScheduler(offPeakTaskId?: string): void {
  // Reuse the same scheduler-wake channel (tick covers both cron and off-peak branches), only log labels are distinguished.
  cronScheduler?.wake(`offpeak:${offPeakTaskId ?? "sync"}`);
}
// Select a local host to perform dispatch: the current local workspace is pulled up/reused by the createTask of any local window host according to path.
function resolveCronDispatchHost(): ElectronUtilityProcess | null {
  const first = windowHostProcessMap.values().next();
  return first.done ? null : first.value;
}
const disposingHostProcessTimers = new WeakMap<
  ElectronUtilityProcess,
  ReturnType<typeof setTimeout>
>();
let updateStatusWindow: BrowserWindow | null = null;
const UPDATE_STATUS_WINDOW_WIDTH = 512;
const UPDATE_STATUS_WINDOW_COMPACT_HEIGHT = 205;
const UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT = 224;
const UPDATE_STATUS_WINDOW_READY_HEIGHT = UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT - 54;
const UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION = { x: 10, y: 10 } as const;
const mainSettingService = createSettingService();
const appLaunchGate = createAppLaunchGate();
const appLaunchCoordinator = createAppLaunchCoordinator(appLaunchGate);
const appTelemetryCredentialService = createCredentialService();
async function resolveCurrentZCodeEndpointOrigin() {
  return resolveZCodeEndpointOrigin({
    env: ZCODE_ENV,
    envBaseOrigin: resolveZCodeEndpointEnvBaseOrigin(hostProcessLocalEnv),
    overrideOrigin: (await mainSettingService.get()).zcodeEndpointOrigin,
  });
}
let desktopContextPromptRollout: ReturnType<typeof createDesktopContextPromptRollout> | undefined;
function resolveDesktopContextPromptEnabledForHost(): boolean {
  const rollout = desktopContextPromptRollout;
  if (!rollout) {
    return false;
  }
  // Expiration refresh is triggered when the Host is created, but only the current snapshot is read; network requests cannot block the Local/Remote Host.
  void rollout.refresh();
  return rollout.getSnapshot().enabled;
}

// Bounded grayscale decision gate before the first Host is created. Host/Agent's presentation surface when the process starts
// Freeze (services/node.ts top-level const + CLI --surface), while grayscale requests are bypassed and do not block the Host. If the first
// The Host fork resolves earlier than the request, and the successful result (enabled: true) has no effective path to reach the frozen Host/Agent.
// Here is a bounded effective path for the "successful result": wait for one decision (≤2s) before the first Host fork, failure/timeout will still be based on the current
// Snapshot continues (desktopContextPrompt fail-open). first-only permanent
// latch - subsequent Host fork awaits the resolved promise (nearly 0ms), and each resolve*ForHost()
// Synchronously read live snapshots that have been refreshed.
const DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS = 2_000;
let firstHostSpawnDecisionPromise: Promise<void> | null = null;
function awaitFirstHostSpawnDecision(): Promise<void> {
  if (firstHostSpawnDecisionPromise) {
    return firstHostSpawnDecisionPromise;
  }
  firstHostSpawnDecisionPromise = (async () => {
    const rollout = desktopContextPromptRollout;
    if (!rollout) {
      return;
    }
    try {
      const decision = await rollout.awaitFirstDecision(
        DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS,
      );
      logger.info("[desktop-context-prompt] first host spawn decision resolved", {
        enabled: decision.enabled,
        configVersion: decision.configVersion,
      });
    } catch (error) {
      // awaitFirstDecision never rejects (refresh has internal catch + timeout to roll back the snapshot), this is just a brief explanation.
      logger.warn("[desktop-context-prompt] first host spawn decision failed, fail-open", {
        error,
      });
    }
  })();
  return firstHostSpawnDecisionPromise;
}
const appTelemetryCore = createTelemetryCore({
  loadUserId: createTelemetryUserIdLoader(appTelemetryCredentialService),
  loadAuthorization: createTelemetryAuthorizationLoader(appTelemetryCredentialService),
  loadMarketingParams: createTelemetryMarketingParamsLoader(appTelemetryCredentialService),
  resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  fetchImpl: createDesktopTelemetryFetch(net),
});
const appTelemetryRuntime = createAppTelemetryRuntime({
  telemetryCore: appTelemetryCore,
  appLaunchCoordinator,
});

function reportRemoteUsageEventForRenderer(rendererId: number, event: TelemetryEventPayload): void {
  const context =
    appTelemetryRuntime.getRendererContext(rendererId) ??
    appTelemetryRuntime.getLatestRendererContext();
  if (!context) {
    logger.warn("[remote-usage-telemetry] renderer context unavailable", {
      elementName: event.elementName,
      rendererId,
    });
    return;
  }
  // If the final failure occurs, TelemetryCore will uniformly record a desensitized alarm; here only the main remote connection link is isolated.
  void appTelemetryCore.reportEvent({ context, ...event }).catch(() => {});
}

function syncAppTelemetryInteractiveState(): void {
  appTelemetryRuntime.setInteractive(
    getApplicationWindowsExcludingCuaIndicator().some(
      (win) => !win.isDestroyed() && win.isVisible() && win.isFocused(),
    ),
  );
  // Logout/number switching occurs in the host sub-process, and there is no immediate signal in the main process; ARMS user.name is refreshed when the window is focused.
  void armsUserIdentitySync.refresh();
}

app.on("browser-window-focus", (_event, win) => {
  syncAppTelemetryInteractiveState();
  rebuildMenu();
  // ZCode windows without Host such as settings/updates are also considered as the front desk: the router will first clear the old workspace Host to null.
  // Then silently discard the new window without Host to prevent the old session PiP from continuing to be displayed.
  cuaPipFocusRouter.focusWindow(resolveCuaPipWindowKey(win));
});
app.on("browser-window-blur", (_event, win) => {
  syncAppTelemetryInteractiveState();
  cuaPipFocusRouter.blurWindow(resolveCuaPipWindowKey(win));
});
app.on("browser-window-created", (_event, win) => {
  const windowKey = resolveCuaPipWindowKey(win);
  win.once("closed", () => cuaPipFocusRouter.removeWindow(windowKey));
});

const remoteSessionManager = createRemoteWorkspaceSessionManager({
  logger,
  windowHostProcessMap,
  resolveRemoteAssetDirs: () =>
    resolveRemoteAssetDirs({ locale: currentApplicationLocale }, hostProcessLocalEnv),
  resolveWslTarget: resolveCanonicalWslTarget,
  reportRemoteConnectionStateChanged: reportRemoteConnectionStateChangedToArms,
  reportRemoteDisconnect: reportRemoteDisconnectToArms,
});

const deviceMid = ensureDesktopDeviceMidSync();
// The help configuration is publicly readable, and the gray response cache with account authentication below cannot be reused.
const readHelpConfig = createDesktopHelpConfigReader({
  appVersion: ZCODE_VERSION || app.getVersion(),
  deviceMid,
  resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
});
// The same /api/v1/client/configs fetcher is shared by two grayscale rollouts (the request parameters and authentication are exactly the same,
// Each caches/deduplicates independently, and the server distinguishes functions according to data.configs.<key>).
const electronClientConfigsFetcher = createElectronDesktopContextPromptConfigFetcher({
  appVersion: ZCODE_VERSION || app.getVersion(),
  deviceMid,
  resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
});
desktopContextPromptRollout = createDesktopContextPromptRollout({
  fetchConfig: electronClientConfigsFetcher,
  logger,
});
const rendererActionTraceRollout = createRendererActionTraceRollout({
  fetchConfig: electronClientConfigsFetcher,
  logger,
});
const localTtftExporter = createLocalTtftExporter({
  env: { ...hostProcessLocalEnv, ...process.env },
  version: ZCODE_VERSION || app.getVersion(),
  logger,
});
ipcMain.on(PlatformChannels.ReportLocalTtftBatch, (_event, batch: unknown) =>
  localTtftExporter.enqueue(batch),
);
const rendererActionTraceBroker = createRendererActionTraceBroker({
  exporter: createRendererActionTraceExporter({
    ...hostProcessLocalEnv,
    ...process.env,
  }),
  logger,
});
let disposeRendererActionTraceIpc: (() => void) | undefined;
const armsUserIdentitySync = createArmsUserIdentitySync({
  deviceMid,
  // When collection is disabled, the SDK is not initialized and setConfig will throw an error.
  setUser:
    ZCODE_TELEMETRY_ENABLED && ZCODE_ARMS_RUM_ENDPOINT
      ? (user) => armsRum.setConfig("user", user)
      : () => {},
});

function extractOpenWorkspacePathFromDeepLinkUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    return isWorkspaceOpenUrl(parsedUrl) ? extractWorkspaceOpenPath(parsedUrl) : null;
  } catch {
    return null;
  }
}

const startupOpenWorkspaceArgPath = extractOpenWorkspacePathFromArgs(process.argv);
const startupProtocolUrl = extractDeepLinkUrlFromArgs(process.argv);
const startupDeepLinkWorkspacePath = startupOpenWorkspaceArgPath
  ? null
  : extractOpenWorkspacePathFromDeepLinkUrl(startupProtocolUrl ?? "");
const startupDeepLinkConsumptionGate = createStartupDeepLinkConsumptionGate(startupProtocolUrl);
let startupOpenWorkspaceRequest: ExplicitStartupWorkspaceRequest | null =
  startupOpenWorkspaceArgPath
    ? { path: startupOpenWorkspaceArgPath, source: "open-workspace-arg" }
    : startupDeepLinkWorkspacePath
      ? { path: startupDeepLinkWorkspacePath, source: "deep-link" }
      : null;

let forceUpdateMainWindowCreationBlocked = false;

function focusForceUpdateGateWindow() {
  const gateWindow = getApplicationWindowsExcludingCuaIndicator()[0];
  if (!gateWindow) {
    return;
  }

  if (gateWindow.isMinimized()) {
    gateWindow.restore();
  }
  if (!gateWindow.isVisible()) {
    gateWindow.show();
  }
  gateWindow.focus();
}

const primaryWindowCoordinator = createPrimaryWindowCoordinator({
  listWindows: getApplicationWindowsExcludingCuaIndicator,
  resolveStartupWindowBootstrap: () => {
    if (startupOpenWorkspaceRequest) {
      const request = startupOpenWorkspaceRequest;
      startupOpenWorkspaceRequest = null;
      startupDeepLinkConsumptionGate.markStartupRequestConsumed(request);
      const explicitBootstrap = resolveExplicitStartupWorkspaceBootstrap(request, {
        confirmationCopy: externalWorkspaceOpenDialogCopy,
        logger,
      });
      if (explicitBootstrap) {
        return Promise.resolve(explicitBootstrap);
      }
    }

    return resolveStartupWindowBootstrap({
      settingsFile,
      // dataBaseDir may be overwritten during the bootstrap setup phase and must be retrieved when the startup workspace is actually parsed.
      conversationWorkspaceDir: getConversationWorkspaceDir(),
      logger,
    });
  },
  createWindow: (startupBootstrap) => {
    createWindowInstance(startupBootstrap);
  },
  canCreateWindow: (reason) => {
    if (!forceUpdateMainWindowCreationBlocked) {
      return true;
    }

    // After the forced upgrade is hit, Dock/tray/activate/deep link cannot bypass the app-ready gate to create the old moderator interface.
    logger.warn(`[force-update] the main window creation entry point was blocked: ${reason}`);
    focusForceUpdateGateWindow();
    return false;
  },
  logger,
});

function markForceQuit(reason: string) {
  if (forceQuitRef.current) {
    return;
  }

  forceQuitRef.current = true;
  logger.info(`[app-quit] forceQuit enabled (${reason})`);
}

function markExplicitQuit(reason: string) {
  explicitQuitRef.current = true;
  logger.info(`[app-quit] explicit quit requested (${reason})`);
}

function syncCloseToTrayOnWindows(value: unknown) {
  if (typeof value !== "boolean") {
    return;
  }

  closeToTrayOnWindows = value;
  logger.info(`[settings] closeToTrayOnWindows=${value}`);
}

function syncImmediateAppSettings(patch: Partial<AppSettings>) {
  syncCloseToTrayOnWindows(patch.closeToTrayOnWindows);

  if (typeof patch.keepAwakeWhileRunning === "boolean") {
    keepAwakeWhileRunning = patch.keepAwakeWhileRunning;
    reconcileKeepAwakeBlocker();
  }

  if (typeof patch.receivePreviewUpdates === "boolean") {
    // receivePreviewUpdates is written to setting.json by the renderer host.
    // The automatic updater of the main process will not subscribe to host setting changes and must use the syncAppSettings real-time channel to refresh the manifest channel.
    refreshAutoUpdaterReleaseChannel(
      patch.receivePreviewUpdates,
      "settings receivePreviewUpdates changed",
    );
  }

  if (patch.shortcutBindings !== undefined) {
    // Change the shortcut keys:
    // The placement has been completed (useSettings.update first awaits settingService.update and then uses this channel).
    // This rebuilds the application menu accelerator and notifies all windows to refresh the settings snapshot - other windows'
    // The useAppKeyboard validity table and settings page are updated accordingly. Precedent: full-window broadcast of setAutoDownloadAndInstallUpdates.
    rebuildMenu();
    for (const win of getApplicationWindowsExcludingCuaIndicator()) {
      if (!win.isDestroyed()) {
        win.webContents.send(PlatformChannels.SettingsChanged);
      }
    }
  }
}

async function getAutoUpdatePreferences() {
  const settings = await mainSettingService.get();
  return {
    autoDownloadAndInstallUpdates: settings.autoDownloadAndInstallUpdates ?? false,
  };
}

async function setAutoDownloadAndInstallUpdates(enabled: boolean) {
  await mainSettingService.update({
    autoDownloadAndInstallUpdates: enabled,
  });
  syncImmediateAppSettings({
    autoDownloadAndInstallUpdates: enabled,
  });
  for (const win of getApplicationWindowsExcludingCuaIndicator()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PlatformChannels.SettingsChanged);
    }
  }
}

async function prepareAppQuit(reason: string, kind: AppShutdownKind = "normal"): Promise<void> {
  const selection = selectAppShutdownPolicy(activeAppShutdownKind, kind, process.platform);
  activeAppShutdownKind = selection.kind;
  activeAppShutdownPolicy = selection.policy;
  if (selection.upgraded && (hasPreparedAppQuit || appQuitPreparationInFlight)) {
    // Update requests may occur later than normal exit barriers. The created 4s timer cannot be extended by modifying the global policy;
    // Explicitly preserve existing budgets and allow updates to proceed to the fail-open resource scan and installer.
    logger.warn(
      `[app-quit] update install joined an existing normal shutdown barrier (${reason}); existing timers keep their original budget`,
    );
  }
  if (hasPreparedAppQuit) {
    return;
  }
  if (appQuitPreparationInFlight) {
    await appQuitPreparationInFlight;
    return;
  }

  markForceQuit(reason);
  windowsCuaOperationIndicator.dispose();
  browserScreenshotSurfaceCoordinator.dispose();
  // Root cause of the bug: After the resource sample is changed to a 5-minute window, if you exit directly and still stop, the data in the unfull window will be cleared.
  // Exiting only empties the existing role/Agent memory window and does not start new sampling, directory scanning or external probes.
  stopDesktopResourceTelemetry({ flushPendingWindows: true });
  stopDesktopZCodeDataSizeTelemetry();
  stopDesktopNetworkTelemetry();
  stopRemoteUsageArmsPeriodicSampling();
  disposeRendererActionTraceIpc?.();
  disposeRendererActionTraceIpc = undefined;
  notifyStabilityAppExit(
    getStabilityLifecycleScene() === "update_install" ? "update_install" : "app_quit",
    logger,
    { exitCode: 0, exitKind: "normal" },
  );

  const cronSchedulerToDispose = cronScheduler;
  cronScheduler = null;

  const hostProcesses = [
    ...new Set([...windowHostProcessMap.values(), ...listDisposingHostProcesses()]),
  ];
  logger.info(
    `[app-quit] waiting for host process cleanup (${reason}), kind=${activeAppShutdownKind}, hosts=${hostProcesses.length}, forceKillDelayMs=${activeAppShutdownPolicy.forceKillDelayMs}, waitTimeoutMs=${activeAppShutdownPolicy.waitTimeoutMs}`,
  );

  appQuitPreparationInFlight = Promise.all([
    // After the exit barrier ends and then start writing the window size, setting.json.lock may be left before app.exit.
    // Dimensions are saved on resize debounce or maximize state changes, and exiting the barrier no longer creates new dimension writes.
    // Reason for fix: Main used to not wait for /event/report that was still being sent, and the event would be lost directly when exiting normally.
    // Enter the existing barrier in parallel with other owners and wait up to 2 seconds to avoid telemetry serial amplification and exit budget.
    appTelemetryCore.flushPendingReports({ timeoutMs: 2_000 }),
    localTtftExporter.shutdown(),
    rendererActionTraceBroker.shutdown().catch((error) => {
      logger.warn(`[app-quit] renderer action trace shutdown failed (${reason}):`, error);
    }),
    // The old process first waits for Cron's 1.5s deadline and then starts the Host timer, resulting in the declared
    // 4.5s/9s exit total budget is serially amplified. The two types of owners have no closure dependencies and enter the same barrier in parallel.
    (async () => {
      try {
        await cronSchedulerToDispose?.dispose();
      } catch (error) {
        logger.warn(`[app-quit] cron scheduler dispose failed (${reason}):`, error);
      }
    })(),
    // Remote session, attachment and transport are all held by the window Host; clean them up first
    // Main's request is associated, and then the shutdown barrier of the only Host in each window below releases the real connection and Agent.
    remoteSessionManager.disposeAllAndWaitForAppShutdown(reason),
    ...hostProcesses.map((child, index) =>
      disposeHostProcessAndWait(
        child,
        `${reason}-${index + 1}`,
        disposingHostProcessTimers,
        logger,
        {
          forceKillDelayMs: activeAppShutdownPolicy.forceKillDelayMs,
          waitTimeoutMs: activeAppShutdownPolicy.waitTimeoutMs,
        },
      ),
    ),
  ])
    .then(() => {
      logger.info(`[app-quit] host process cleanup completed (${reason})`);
    })
    .catch((error) => {
      logger.error(`[app-quit] host process cleanup failed (${reason}):`, error);
    })
    .finally(() => {
      // before-quit is a synchronous event. If you just issue Dispose and continue to exit main,
      // The host will be taken away before the SIGTERM/SIGKILL of the agent process tree is completed, and zcode-cli will be taken over by init as a residual process.
      // Here we first intercept the first exit, wait for the host cleanup to be completed, and then release the second app.quit.
      hasPreparedAppQuit = true;
      appQuitPreparationInFlight = null;
    });

  await appQuitPreparationInFlight;
}

function exitPreparedApp(reason: string): never | void {
  logger.info(`[app-quit] exiting prepared app (${reason})`);
  if (process.env.ZCODE_E2E_RUN_ID?.trim()) {
    flushMainE2ECoverage((error) => {
      logger.warn("[e2e-coverage] main coverage flush failed", error);
    });
    // When ChromeDriver is executing deleteSession, Electron app.exit(0)
    // and process.kill within the process may be swallowed by the Electron life cycle. Only here at E2E
    // After the run identity is clear and prepareAppQuit has completed host/agent recycling, start the independent system
    // The command terminates the current PID; it does not scan by name and will not affect product exit or the next session.
    const killer =
      process.platform === "win32"
        ? spawn("taskkill", ["/PID", String(process.pid), "/F"], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          })
        : spawn("kill", ["-9", String(process.pid)], {
            detached: true,
            stdio: "ignore",
          });
    killer.unref();
    return;
  }
  app.exit(0);
}

function getRunningAgentSessionCount() {
  return [...hostRunningTaskCountMap.values()].reduce((total, count) => total + count, 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(ms, 0));
    timer.unref?.();
  });
}

async function execWithTimeout(
  file: string,
  args: string[],
  timeoutMs: number,
  spawnOptions: { windowsHide?: boolean; encoding?: BufferEncoding } = {},
): Promise<{
  timedOut: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = execFile(file, args, {
      windowsHide: spawnOptions.windowsHide,
      encoding: spawnOptions.encoding,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        // The process may have exited on its own, ignore
      }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, code, signal });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, error: error.message });
    });
  });
}

async function forceTerminateWindowsAgentProcesses(pids: number[]): Promise<
  Array<{
    pid: number;
    timedOut: boolean;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: string;
  }>
> {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  return Promise.all(
    uniquePids.map((pid) =>
      execWithTimeout(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        WINDOWS_AGENT_FORCE_KILL_TIMEOUT_MS,
        {
          windowsHide: true,
        },
      ).then((result) => ({ pid, ...result })),
    ),
  );
}

function logWindowsPackagedResourceSnapshot(stage: string) {
  logger.info(
    `[auto-update] Windows packaged resources snapshot (${stage}): ${JSON.stringify(
      snapshotWindowsPackagedResources(process.resourcesPath),
    )}`,
  );
}

function logWindowsPackagedResourceWritableProbe(stage: string) {
  const probes = probeWindowsPackagedResourceWritable(process.resourcesPath);
  const failed = probes.filter((probe) => probe.exists && !probe.writable);
  logger.info(
    `[auto-update] Windows packaged resources writable probe (${stage}): ${JSON.stringify(probes)}`,
  );
  if (failed.length > 0) {
    logger.warn(
      `[auto-update] Windows packaged resource dirs are not writable (${stage}): ${JSON.stringify(
        failed,
      )}`,
    );
  }
}

function logWindowsBundledRuntimeIntegrityDiagnostic() {
  if (process.platform !== "win32" || !app.isPackaged) {
    return;
  }

  const binaryPaths = {
    glm: resolveBundledGlmBinaryPath(),
  };
  const missingProviders = Object.entries(binaryPaths)
    .filter(([, binaryPath]) => !binaryPath)
    .map(([provider]) => provider);
  if (missingProviders.length === 0) {
    return;
  }

  // The absence of bundled runtime does not necessarily affect the user's current provider, and only logs are logged silently during the startup phase.
  // In this way, you can confirm whether the installation resources are damaged in the next user log, and the startup will not be interrupted due to the lack of unused providers.
  logger.warn(
    `[startup] Windows bundled runtime missing providers: ${missingProviders.join(", ")} resources=${JSON.stringify(
      snapshotWindowsPackagedResources(process.resourcesPath),
    )}`,
  );
}

async function prepareWindowsProcessesForUpdateInstall() {
  const trackedAgentCount = listRegisteredHostAgentProcessIds().length;

  logger.info(`[auto-update] preparing Windows update install: trackedAgent=${trackedAgentCount}`);
  logWindowsPackagedResourceSnapshot("before-dispose");

  const resourceLockMarkers = resolveWindowsPackagedResourceLockMarkers(process.resourcesPath);
  // prepareAppQuit has used the same barrier to recycle the only Host per window and killed it in 7.5 seconds.
  // 9 seconds to close; the Windows special phase cannot add another round of waiting, nor can the Host/Agent PID recorded before exiting be used
  // Kill by force because the PID may have been reused. Here we only clean up the runtime processes that still reference package resources during real-time scanning.
  // The final exit of the current main/renderer is handed over to the updater and NSIS.
  const cleanup = await runWindowsUpdateProcessCleanup({
    resourceLockMarkers,
    lockReleaseGraceMs: WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
    scan: findWindowsProcessesReferencingResourceMarkers,
    terminate: forceTerminateWindowsAgentProcesses,
    delay,
  });

  logger.info(
    `[auto-update] Windows resource lock scan: matches=${cleanup.initialLockProcesses.length} trackedAgent=${trackedAgentCount} details=${JSON.stringify(
      cleanup.initialLockProcesses,
    )}`,
  );
  for (const error of cleanup.errors) {
    logger.warn(`[auto-update] Windows process cleanup degraded: ${error}`);
  }

  if (cleanup.terminationPids.length === 0) {
    logWindowsPackagedResourceWritableProbe("no-lock-processes");
    return;
  }

  // After a small number of Windows users update, the bundled agent file in the installation directory will be missing.
  // The root cause is usually that when NSIS overwrites directories such as resources/glm, the old agent/helper process or the residual process triggered by the anti-virus software still holds the handle;
  // Killing only the agent pid reported by the host will miss unregistered or unregistered descendants. Here, press the command line to scan the installation resource path again before updating.
  // Forcefully clean up process trees that still reference packaged resources to reduce the probability of environmental damage caused by half-updates.
  logger.info(
    `[auto-update] Windows taskkill results: ${JSON.stringify(cleanup.terminationResults)}`,
  );
  logger.info(
    `[auto-update] Windows resource lock release grace elapsed: ${WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS}ms`,
  );

  if (cleanup.remainingLockProcesses.length > 0) {
    logger.warn(
      `[auto-update] Windows resource lock processes still alive after taskkill: ${JSON.stringify(
        cleanup.remainingLockProcesses,
      )}`,
    );
  }
  logWindowsPackagedResourceWritableProbe("after-taskkill");
}

function shouldConfirmAppQuit() {
  // Ordinary sessions in the development environment often require restarting Electron and only intercept them in production to avoid interrupting debugging.
  return ZCODE_ENV === "production" && getRunningAgentSessionCount() > 0;
}

function confirmAppQuit(originWindow?: BrowserWindow | null) {
  if (!shouldConfirmAppQuit()) {
    logger.info(`[app-quit] quit confirmation skipped in ${ZCODE_ENV}`);
    return true;
  }

  const runningAgentSessionCount = getRunningAgentSessionCount();
  const detailLines = [
    runningAgentSessionCount > 0
      ? `In-progress sessions: ${runningAgentSessionCount}. They will be interrupted after quitting.`
      : null,
  ].filter((line): line is string => line !== null);
  const targetWindow =
    originWindow && !originWindow.isDestroyed()
      ? originWindow
      : (BrowserWindow.getFocusedWindow() ??
        getApplicationWindowsExcludingCuaIndicator()[0] ??
        null);
  const dialogOptions = {
    type: "question" as const,
    buttons: ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Confirm Quit",
    message: "Quit Z Code?",
    detail: detailLines.join("\n"),
    icon: nativeImage.createFromPath(iconPath),
  };

  const result = targetWindow
    ? dialog.showMessageBoxSync(targetWindow, dialogOptions)
    : dialog.showMessageBoxSync(dialogOptions);
  return result === 0;
}

async function executeDesktopCommandForApp(
  command: Parameters<typeof executeDesktopCommand>[0]["command"],
  senderWindow?: BrowserWindow | null,
) {
  return executeDesktopCommand({
    fetchHelpConfig: readHelpConfig,
    command,
    senderWindow,
    logger,
    updateZCodeStdioTapDevMenuState,
    onDesktopZoomChanged: (zoomLevel) => {
      currentDesktopZoomLevel = clampDesktopZoomLevel(zoomLevel);
      rebuildMenu();
    },
    settingService: mainSettingService,
    onZCodeEndpointChanged: handleZCodeEndpointChanged,
    zcodeEndpointEnvBaseOrigin: resolveZCodeEndpointEnvBaseOrigin(hostProcessLocalEnv),
    onRelaunchApp: async () => {
      await prepareAppQuit("desktop-command-relaunch");
      app.relaunch();
      app.quit();
    },
    credentialsDir: getCredentialsDir(),
    currentApplicationLocale,
  });
}

async function resolveZCodeEndpointSelection(): Promise<"production" | "test" | "custom"> {
  if (ZCODE_ENV === "production") {
    return "production";
  }
  const origin = await resolveCurrentZCodeEndpointOrigin();
  if (origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
    return "production";
  }
  return "custom";
}

async function handleZCodeEndpointChanged() {
  rebuildMenu();
}

/** The shortcut key sets the page recording state (renderer is synchronized by SetShortcutRecordingActive); when true, the accelerator can be configured when the menu is removed. */
let shortcutRecordingActive = false;
/** The webContents id that initiates recording; when the window is closed/crash, the renderer will not send a reset IPC, and the main side will close accordingly. */
let shortcutRecordingOwnerWebContentsId: number | null = null;

function setShortcutRecordingActive(active: boolean, ownerWebContentsId: number | null = null) {
  if (active) {
    shortcutRecordingOwnerWebContentsId = ownerWebContentsId;
  }
  if (shortcutRecordingActive === active) {
    return;
  }
  shortcutRecordingActive = active;
  if (!active) {
    shortcutRecordingOwnerWebContentsId = null;
  }
  rebuildMenu();
}

/**
 * The recording state is a temporary global state across processes, and the closing cannot rely on renderer cooperation - close the window during recording
 * Or when the rendering process crashes, React cleanup and reset IPC will not be executed, and the flag will be permanently true, and all subsequent
 * rebuildMenu (all languages/zoom/settings synchronization) creates menus without accelerator and affects all windows.
 * Click to initiate webContents reset in the existing window destruction cleanup.
 */
function resetShortcutRecordingForWebContents(webContentsId: number) {
  if (!shortcutRecordingActive || shortcutRecordingOwnerWebContentsId !== webContentsId) {
    return;
  }
  shortcutRecordingOwnerWebContentsId = null;
  shortcutRecordingActive = false;
  rebuildMenu();
}

function rebuildMenu() {
  void Promise.all([resolveZCodeEndpointSelection(), mainSettingService.get()]).then(
    ([zcodeEndpointSelection, settings]) => {
      rebuildApplicationMenu({
        zcodeEndpointSelection,
        executeDesktopCommand: executeDesktopCommandForApp,
        currentZoomLevel: resolveFocusedDesktopZoomLevel(),
        // Menu accelerator follows user shortcut key settings (shortcutBindings user override)
        shortcutBindings: settings.shortcutBindings,
        // Shortcut key recording state: remove the configurable accelerator to prevent the key from directly triggering the original command when recording menu channel commands.
        // (The macOS system menu eats the keys before the renderer, and the renderer side preventDefault cannot stop it).
        disableShortcutAccelerators: shortcutRecordingActive,
      });
    },
  );
  updateWindowsDesktopTrayMenu();
}

function resolveFocusedDesktopZoomLevel(): number {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow || focusedWindow.isDestroyed()) {
    return 0;
  }
  return resolveDesktopZoomLevelFromFactor(focusedWindow.webContents.getZoomFactor());
}

function getApplicationWindowsExcludingCuaIndicator(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && !windowsCuaOperationIndicator.ownsWindow(win),
  );
}

function getMainApplicationWindows(): BrowserWindow[] {
  return getApplicationWindowsExcludingCuaIndicator().filter((win) => win !== updateStatusWindow);
}

function isUpdateStatusWindowCloseLocked(state: UpdateStatePayload) {
  return state.kind === "download-progress" || state.kind === "update-downloaded";
}

function syncUpdateStatusWindowClosePolicy(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }
  const closeLocked = isUpdateStatusWindowCloseLocked(getAutoUpdaterState());
  win.setClosable(!closeLocked || forceQuitRef.current);
  win.setMinimizable(true);
}

function syncUpdateStatusWindowChrome(win: BrowserWindow) {
  if (win.isDestroyed() || process.platform !== "darwin") {
    return;
  }
  // Independently updating the traffic light position of a window cannot rely solely on the BrowserWindow construction parameters.
  // macOS may continue to use the default coordinates of the hidden titlebar after window show / resize,
  // Therefore, the higher button position is explicitly written every time the layout is synchronized.
  win.setWindowButtonPosition(UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION);
}

function resolveUpdateStatusWindowHeight(state: UpdateStatePayload) {
  if (state.kind === "download-progress") {
    return UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT;
  }
  if (state.kind === "update-downloaded") {
    return UPDATE_STATUS_WINDOW_READY_HEIGHT;
  }
  return UPDATE_STATUS_WINDOW_COMPACT_HEIGHT;
}

function shouldUseUpdateStatusWindowContentSize(): boolean {
  return process.platform === "linux";
}

function syncUpdateStatusWindowLayout(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }
  const state = getAutoUpdaterState();
  const height = resolveUpdateStatusWindowHeight(state);
  const bounds = shouldUseUpdateStatusWindowContentSize()
    ? win.getContentBounds()
    : win.getBounds();
  if (!shouldUseUpdateStatusWindowContentSize()) {
    win.setMinimumSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    win.setMaximumSize(UPDATE_STATUS_WINDOW_WIDTH, height);
  }
  if (bounds.width !== UPDATE_STATUS_WINDOW_WIDTH || bounds.height !== height) {
    // After independently updating the 240px height of the Dialog in the reused page, the normal state only has two lines of content.
    // The footer will eat up the remaining grid rows to form a large blank space; tighten the window height according to the state to make the content fit the actual density.
    // Canceling the download will return to update-available from download-progress; synchronize min/max here and then setSize.
    // Prevent macOS from inheriting the download state height on non-resizable BrowserWindow, causing the pop-up window to not be recovered.
    if (shouldUseUpdateStatusWindowContentSize()) {
      // The Linux system title bar will occupy the height of the BrowserWindow frame.
      // If you continue to use setSize to lock the outer frame, the actual height of WebContents will be reduced and the bottom button will be cut off.
      win.setContentSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    } else {
      win.setSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    }
  }
  syncUpdateStatusWindowChrome(win);
}

function openUpdateStatusWindow() {
  if (updateStatusWindow && !updateStatusWindow.isDestroyed()) {
    if (updateStatusWindow.isMinimized()) {
      updateStatusWindow.restore();
    }
    updateStatusWindow.show();
    updateStatusWindow.focus();
    syncAutoUpdaterStateToWindow(updateStatusWindow);
    syncReadyUpdateToWindow(updateStatusWindow);
    syncPostUpdateReleaseNotesToWindow(updateStatusWindow);
    syncUpdateStatusWindowClosePolicy(updateStatusWindow);
    syncUpdateStatusWindowLayout(updateStatusWindow);
    return;
  }

  const parentWindow =
    getMainApplicationWindows().find((candidate) => candidate.isFocused()) ??
    getMainApplicationWindows()[0] ??
    undefined;
  const win = new BrowserWindow({
    width: UPDATE_STATUS_WINDOW_WIDTH,
    height: resolveUpdateStatusWindowHeight(getAutoUpdaterState()),
    useContentSize: shouldUseUpdateStatusWindowContentSize(),
    ...(shouldUseUpdateStatusWindowContentSize()
      ? {}
      : {
          minWidth: UPDATE_STATUS_WINDOW_WIDTH,
          minHeight: UPDATE_STATUS_WINDOW_READY_HEIGHT,
          maxWidth: UPDATE_STATUS_WINDOW_WIDTH,
          maxHeight: UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT,
        }),
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    // The update status has been changed from in-page Dialog to independent BrowserWindow.
    // Independent windows should retain system window controls and cannot continue to use the borderless transparent window configuration of the in-page pop-up window era.
    frame: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION,
        }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: true,
          }
        : {}),
    transparent: false,
    backgroundColor: "#ffffff",
    title: "",
    icon: iconPath,
    parent: parentWindow,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      additionalArguments: [`--device-id=${deviceMid}`],
    },
  });
  // Update windows to retain system window controls but not allow scaling or full screen.
  // Explicitly lock it again in addition to the construction parameters to avoid inconsistencies in the default processing of title bar control capabilities on different platforms.
  win.setResizable(false);
  win.setMinimizable(true);
  win.setMaximizable(false);
  win.setFullScreenable(false);
  if (process.platform === "darwin") {
    syncUpdateStatusWindowChrome(win);
  }
  syncUpdateStatusWindowClosePolicy(win);
  syncUpdateStatusWindowLayout(win);

  updateStatusWindow = win;
  const disposeAutoUpdaterStateListener = onAutoUpdaterStateChanged(() => {
    syncUpdateStatusWindowClosePolicy(win);
    syncUpdateStatusWindowLayout(win);
  });
  const showUpdateStatusWindow = () => {
    if (win.isDestroyed()) {
      return;
    }
    if (!win.isVisible()) {
      win.center();
      syncUpdateStatusWindowChrome(win);
      win.show();
      syncUpdateStatusWindowChrome(win);
    }
    win.moveTop();
    win.focus();
    win.setAlwaysOnTop(true, "floating");
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.setAlwaysOnTop(false);
      }
    }, 250);
    logger.info(
      `[auto-update] update status window shown visible=${win.isVisible()} focused=${win.isFocused()} bounds=${JSON.stringify(win.getBounds())}`,
    );
  };
  win.webContents.on("dom-ready", () => {
    logger.info("[auto-update] update status window dom-ready");
    syncAutoUpdaterStateToWindow(win);
    syncReadyUpdateToWindow(win);
    syncPostUpdateReleaseNotesToWindow(win);
    // The update window may not trigger ready-to-show stably in development mode or in some macOS rendering paths.
    // Also try to display it after loading is completed to prevent the window from being loaded but remaining hidden, making the update portal look unresponsive.
    setTimeout(showUpdateStatusWindow, 0);
  });
  win.once("ready-to-show", () => {
    showUpdateStatusWindow();
  });
  win.on("close", (event) => {
    if (forceQuitRef.current || !isUpdateStatusWindowCloseLocked(getAutoUpdaterState())) {
      return;
    }
    // After the download starts, the update window provides feedback on the installation status. The user can still minimize it, but cannot close the window by mistake.
    // The close event completely intercepts the native close / shortcut key path, and setClosable(false) is only responsible for the system control status.
    event.preventDefault();
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    disposeAutoUpdaterStateListener();
    if (updateStatusWindow === win) {
      updateStatusWindow = null;
    }
  });

  loadWindow(win, "index", {
    restoreSession: false,
    supportsSettings: false,
    windowKind: "update-status",
    locale: currentApplicationLocale,
  });
}

function createWindowInstance(startupBootstrap: StartupWindowBootstrap = {}) {
  const runtimeProcessEnvPreparation = takeRuntimeProcessEnvPreparation();
  const win = createWindow({
    iconPath,
    preloadPath,
    logger,
    forceQuitRef,
    handleBeforeClose: (win, label) =>
      handleDesktopWindowCloseRequest({
        platform: process.platform,
        forceQuit: forceQuitRef.current,
        explicitQuitRequested: explicitQuitRef.current,
        closeToTrayOnWindows,
        isLastWindow: getMainApplicationWindows().length === 1,
        label,
        logger,
        shouldConfirmQuit: shouldConfirmAppQuit(),
        confirmQuit: () => confirmAppQuit(win),
        requestQuit: () => {
          markForceQuit(`last-window-close:${label}`);
          app.quit();
        },
        hideWindow: () => win.hide(),
      }),
    windowHostProcessMap,
    onHostProcessReady: (windowKey) => cuaPipFocusRouter.refreshWindow(windowKey),
    awaitFirstHostSpawnDecision,
    spawnHostProcess: (win, label, initMessage) =>
      spawnHostProcess(
        win,
        label,
        {
          ...initMessage,
          zcodeBuiltinProviderConfigFilePath: resolveZCodeBuiltinProviderConfigFilePath({
            env: { ...hostProcessLocalEnv, ...process.env },
          }),
        },
        {
          hostProcessLocalEnv,
          desktopContextPromptEnabled: resolveDesktopContextPromptEnabledForHost,
          logger,
          broadcastHub,
          taskRealtimeBus,
          windowHostProcessMap,
          hostRunningTaskCountMap,
          onCuaOperationStateChanged: (source, event) =>
            windowsCuaOperationIndicator.handleState(source, event),
          onCuaOperationStateSourceExited: (source) =>
            windowsCuaOperationIndicator.clearSource(source),
          onAgentProcessExited: (event) => reportAgentProcessExitToArms(event, logger),
          onAgentProcessError: (event) => reportAgentProcessSpawnErrorToArms(event, logger),
          onAgentProcessException: (event) => reportAgentProcessExceptionToArms(event, logger),
          onAgentProcessReady: (event) => reportAgentProcessReadyToArms(event, logger),
          onAgentProcessSpawned: (event) => reportAgentProcessStartToArms(event, logger),
          onMcpTelemetry: (message) =>
            reportMcpTelemetryToArms(message.event, message.runtimeSurface),
          onSessionCreateTelemetry: (message) => {
            void appTelemetryCore.reportEvent(message.event).catch(() => {});
          },
          onCronRunResult: forwardCronRunResult,
          onOffPeakRunResult: forwardOffPeakRunResult,
          onCronSchedulerWakeRequested: wakeCronScheduler,
          onOffPeakSchedulerWakeRequested: wakeOffPeakScheduler,
          authorizeLocalMediaPreviewPath: localMediaPreviewPathRegistry.authorize,
          // Bugfix: The bot service runs in the local window host. /reconnect must be able to request main from the local host to create a remote session.
          handleBotRemoteWorkspaceReconnectRequest: async ({
            win,
            requestId,
            workspacePath,
            workspaceIdentity,
            target,
          }) => {
            try {
              const sessionId = await remoteSessionManager.reconnectBotRemoteWorkspaceSession(win, {
                target,
                workspacePath,
                workspaceIdentity,
                requestId,
              });
              if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
                win.webContents.send(PlatformChannels.BotRemoteWorkspaceReconnected, {
                  sessionId,
                  workspacePath,
                  workspaceIdentity,
                  target,
                });
              }
              return { ok: true, sessionId };
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
          handleBotRemoteWorkspaceConnectionStatusRequest: async ({
            win,
            target,
            workspacePath,
            workspaceIdentity,
          }) => ({
            ok: true,
            // Bugfix: Bot remote connection status must be accurately isolated by workspaceIdentity/workspacePath.
            // Only judging by SSH target will misjudge other directories on the same machine as being connected to the current workspace.
            connected: remoteSessionManager.hasRemoteWorkspaceSessionForTarget(win, target, {
              workspacePath,
              workspaceIdentity,
            }),
          }),
          handleBotRemoteWorkspaceRuntimePortRequest: async ({
            win,
            requestId,
            workspacePath,
            workspaceIdentity,
            target,
          }) => {
            try {
              const port = await remoteSessionManager.createBotRemoteWorkspaceRuntimePort(
                win,
                {
                  target,
                  workspacePath,
                  workspaceIdentity,
                },
                requestId,
              );
              return { ok: true, port };
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
          // browser-use: main executes commands with WebContentsView+CDP.
          handleBrowserExecuteRequest: ({ win: browserWin, ...request }) =>
            runBrowserCommandOnView({ win: browserWin, ...request }),
        },
        {
          taskRealtime: {
            workspaceKeys: windowWorkspaceMap.get(win.id) ?? [],
            onHostId: (hostId) => {
              windowTaskRealtimeHostIdMap.set(win.id, hostId);
            },
          },
        },
      ),
    disposeHostProcess: (child, label, forceKillDelayMs) =>
      disposeHostProcess(
        child,
        label,
        disposingHostProcessTimers,
        logger,
        label.includes("window-closed")
          ? activeAppShutdownPolicy.forceKillDelayMs
          : forceKillDelayMs,
      ),
    syncAutoUpdaterStateToWindow,
    syncReadyUpdateToWindow,
    syncPostUpdateReleaseNotesToWindow,
    disposeRemoteWorkspaceSessionsForWindow:
      remoteSessionManager.disposeRemoteWorkspaceSessionsForWindow,
    reattachRemoteWorkspaceSessionsForWindow:
      remoteSessionManager.reattachRemoteWorkspaceSessionsForWindow,
    bootstrap: {
      restoreSession: startupBootstrap.restoreSession,
      initialWorkspacePath: startupBootstrap.initialWorkspacePath,
      initialWorkspacePurpose: startupBootstrap.initialWorkspacePurpose,
      unavailableWorkspacePath: startupBootstrap.unavailableWorkspacePath,
    },
    agentWarmupTargets: startupBootstrap.agentWarmupTargets,
    // startupBootstrap only marks whether the active workspace is unavailable, but local Host will
    // The workspace has been restored to create background indexes. Always inject a canonical fallback to override the deletion of non-active history directories.
    agentSpawnFallbackCwd: getConversationWorkspaceDir(),
    deviceMid,
    runtimeProcessEnvPatchPromise: runtimeProcessEnvPreparation.patchPromise,
    runtimeProcessEnvFallbackPatch: runtimeProcessEnvPreparation.fallbackPatch,
    initialDesktopZoomLevel: currentDesktopZoomLevel,
    initialWindowSize: currentDesktopWindowSize,
    currentApplicationLocale: () => currentApplicationLocale,
    resolveBrowserViewOwner: (webContentsId) =>
      browserGuestManager.getTabOwnerByWebContentsId(webContentsId),
    persistWindowSize: async (state) => {
      currentDesktopWindowSize = state;
      await mainSettingService.update({ desktopWindowSize: state });
    },
  });
  registerStabilityMainWindow(win);
  return win;
}

registerDeepLinkProtocol(logger, { iconPath: linuxDesktopIntegrationIconPath });
app.on("open-url", (event, url) => {
  event.preventDefault();
  const workspacePath = extractOpenWorkspacePathFromDeepLinkUrl(url);
  if (workspacePath && forceUpdateMainWindowCreationBlocked) {
    logger.warn("[force-update] ignored an open-url workspace request during the force update");
    focusForceUpdateGateWindow();
    return;
  }
  if (workspacePath && getApplicationWindowsExcludingCuaIndicator().length === 0) {
    // When macOS cold starts Finder Service, open-url will be triggered first and then the first window will be created.
    // Record the target directory as a deep link source, and you still need to go through the confirmation gate before bootstrap in the first window.
    startupOpenWorkspaceRequest = { path: workspacePath, source: "deep-link" };
    if (app.isReady()) {
      void primaryWindowCoordinator.ensurePrimaryWindow("open-url-workspace");
    }
    return;
  }
  handleDeepLink(url, logger, {
    confirmationCopy: externalWorkspaceOpenDialogCopy,
    resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
  });
});
const gotTheLock = app.requestSingleInstanceLock(createDeepLinkSingleInstanceData(process.argv));
if (!gotTheLock) {
  app.quit();
}
app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
  if (
    handleSecondInstanceWorkspaceRequest({
      additionalData,
      argv,
      focusForceUpdateGateWindow,
      forceUpdateBlocked: forceUpdateMainWindowCreationBlocked,
      handleDeepLink: (url, options) => handleDeepLink(url, logger, options),
      handleOpenWorkspacePath: (path, options) =>
        handleOpenWorkspacePath(path, logger, {
          allowWithoutReadyWindow: true,
          ...options,
          resolveApplicationWindow:
            options?.resolveApplicationWindow ??
            (() => getApplicationWindowsExcludingCuaIndicator()[0] ?? null),
        }),
      resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
      logger,
      workspaceConfirmationCopy: externalWorkspaceOpenDialogCopy,
    })
  ) {
    return;
  }

  const win = getApplicationWindowsExcludingCuaIndicator()[0];
  if (win) {
    if (win.isMinimized()) {
      win.restore();
    }
    if (!win.isVisible()) {
      win.show();
    }
    win.focus();
  }
});

app.whenReady().then(async () => {
  markMainLaunchAppReady();
  installLocalMediaPreviewProtocol(session.defaultSession.protocol, {
    isPathAuthorized: localMediaPreviewPathRegistry.isAuthorized,
  });
  // Electron's net.request can only be used after the app is ready; grayscale requests are still bypass preheating and do not block the first Host.
  void desktopContextPromptRollout?.refresh();
  installBrowserRestoreBootstrapProtocol(
    session.fromPartition(EMBEDDED_BROWSER_PARTITION).protocol,
  );
  // Bootstrap: Read the custom data directory from the settings file and take effect before all host processes are started.
  let bootstrapSettings: AppSettings | undefined;
  try {
    bootstrapSettings = await mainSettingService.get();
    if (bootstrapSettings.dataBaseDir) {
      setDataBaseDir(bootstrapSettings.dataBaseDir);
    }
    closeToTrayOnWindows = bootstrapSettings.closeToTrayOnWindows ?? true;
    keepAwakeWhileRunning = bootstrapSettings.keepAwakeWhileRunning ?? false;
    currentDesktopZoomLevel = clampDesktopZoomLevel(bootstrapSettings.desktopZoomLevel ?? 0);
    currentDesktopWindowSize = bootstrapSettings.desktopWindowSize;
    // Global keep-awake: If the setting is turned on at startup, the powerSaveBlocker will be held immediately without waiting for the setting change event.
    reconcileKeepAwakeBlocker();
  } catch {
    // Reading failure does not affect startup, use the default homedir
  }

  // The scheduler will also open tasks-index; wait for the Host to complete the unified preparation to avoid migrating before the startup page appears.
  configureDatabaseStartupQuit(() => {
    markExplicitQuit("database-startup-exit");
    app.quit();
  });
  onLocalDatabaseStartupReady(() => {
    try {
      cronScheduler = spawnCronScheduler({
        hostProcessLocalEnv,
        logger,
        resolveDispatchHost: resolveCronDispatchHost,
        // keep-awake has been changed to a pure setting driver; count reporting is reserved for subsequent diagnosis/quota purposes and is no longer linked to the blocker.
        onOffPeakActiveCountChanged: () => {},
      });
    } catch (error) {
      logger.error("[cron-scheduler] failed to spawn scheduler process:", error);
    }
  });

  if (process.platform === "win32") {
    // The packaged state must use the same AUMID as the NSIS shortcut, otherwise the shell will treat them as different applications.
    // Use the product identity during the build phase and do not rely on the user's machine environment; the development phase continues to maintain an independent identity.
    app.setAppUserModelId(
      resolveWindowsAppUserModelIdForFlavor(ZCODE_PRODUCT_FLAVOR, { isPackaged: app.isPackaged }),
    );
  }

  applyAppIcon(iconPath);
  installFinderOpenFolderWorkflow({
    platform: process.platform,
    homeDir: app.getPath("home"),
    logger,
  });
  await installWindowsOpenFolderContextMenu({
    platform: process.platform,
    executablePath: process.execPath,
    argv: process.argv,
    isDefaultApp: Boolean(process.defaultApp),
    logger,
  });
  try {
    await applyDesktopChromiumNetworkPolicies(session, bootstrapSettings ?? {}, logger);
  } catch (error) {
    logger.warn("[desktop-network] Chromium network policy bootstrap failed:", error);
  }

  await hydratePendingPostUpdateReleaseNotes(mainSettingService);
  logWindowsBundledRuntimeIntegrityDiagnostic();

  // Start automatic update check (executed in the background, without blocking the main interface)
  // The Preview identity will not be automatically updated no matter which backend it is connected to: only the official ZCode installation package is distributed on the stable feed.
  // Updates are not provided to the Preview channel.
  void initAutoUpdater({
    enabled: ZCODE_PRODUCT_FLAVOR === "production",
    onBeforeQuitAndInstall: async () => {
      notifyStabilityLifecycle("update_install");
      await prepareAppQuit("auto-update quitAndInstall", "update-install");
      if (process.platform === "win32") {
        await prepareWindowsProcessesForUpdateInstall();
      }
    },
    settingService: mainSettingService,
    deviceMid,
    resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
    updateFeedSource: resolveUpdateFeedSourceFromStartupConfig({
      argv: process.argv,
      env: process.env,
    }),
  });

  if (process.platform === "darwin" || process.platform === "win32") {
    app.clearRecentDocuments();
  }

  rebuildMenu();
  configureDockMenu(
    () => getDesktopMenuMessage(desktopMenuMessageIds.dockShowCurrentWindow),
    () => showCurrentWindowFromDock(primaryWindowCoordinator),
  );
  createWindowsDesktopTray({
    getLocale: () => currentApplicationLocale,
    showCurrentWindow: () =>
      primaryWindowCoordinator.ensurePrimaryWindow("tray-show-current-window"),
    executeDesktopCommand: executeDesktopCommandForApp,
    quitApp: () => {
      markExplicitQuit("tray-quit");
      app.quit();
    },
    logger,
  });

  registerPlatformIpcHandlers({
    fetchHelpConfig: readHelpConfig,
    logger,
    // CDP-on-guest pivot: renderer `<webview>` dom-ready reports guest webContentsId → attach.
    attachBrowserGuest: (key, webContentsId, options) => {
      const result = browserGuestManager.attachGuest(key, webContentsId, options);
      if (result.ok && options?.windowId !== undefined) {
        embeddedBrowserDialogController.bindGuest(key, webContentsId, options.windowId);
      }
      return result;
    },
    updateBrowserGuestViewport: (tabId, viewport, windowId, desktopZoomFactor) =>
      browserGuestManager.updateViewportFromRenderer(tabId, viewport, windowId, desktopZoomFactor),
    reportBrowserScreenshotSurfaceReady: (windowId, senderWebContentsId, payload) => {
      logger.debug("[browser-screenshot-surface] renderer ready", {
        windowId,
        senderWebContentsId,
        requestId: payload.requestId,
        tabId: payload.tabId,
        webContentsId: payload.webContentsId,
        viewport: payload.viewport,
        surfaceScale: payload.surfaceScale,
      });
      browserScreenshotSurfaceCoordinator.handleReady({
        windowId,
        senderWebContentsId,
        payload,
      });
    },
    browserViewResidencyHandlers: {
      detachBrowserGuest: (key, webContentsId, windowId) =>
        browserGuestManager.detachGuestBeforeReplacement(key, webContentsId, windowId),
      closeBrowserTab: (payload) => browserGuestManager.closeTabFromRenderer(payload),
      reportBrowserTabResidency: (payload) => browserGuestManager.reportResidency(payload),
      acknowledgeBrowserTabSuspend: (payload) => browserGuestManager.acknowledgeSuspend(payload),
      ensureBrowserTabResident: (payload) =>
        browserGuestManager.ensureResidentFromRenderer(payload),
      restoreBrowserTabs: (payload) => browserGuestManager.restoreTabs(payload),
    },
    focusWorkspaceInExistingWindow: (path, extra) =>
      focusWorkspaceInExistingWindow(path, windowWorkspaceMap, extra),
    windowWorkspaceMap,
    windowUnreadCountMap,
    currentApplicationLocale: () => currentApplicationLocale,
    executeDesktopCommand: executeDesktopCommandForApp,
    acknowledgePostUpdateReleaseNotes: (version) =>
      acknowledgePostUpdateReleaseNotes(version, mainSettingService),
    syncActiveTaskSession: (windowId, sessionId) =>
      cuaPipFocusRouter.updateActiveSession(windowId, sessionId),
    syncTaskRealtimeWorkspaceKeys: (windowId, workspaceKeys) => {
      const hostId = windowTaskRealtimeHostIdMap.get(windowId);
      if (hostId) {
        taskRealtimeBus.updateHostWorkspaceKeys(hostId, workspaceKeys);
      }
    },
    getUpdateState: getAutoUpdaterState,
    openUpdateStatusWindow,
    getAutoUpdatePreferences,
    setAutoDownloadAndInstallUpdates,
    getDesktopSessionActivity: () => ({
      runningAgentSessionCount: getRunningAgentSessionCount(),
    }),
    syncAppSettings: syncImmediateAppSettings,
    setShortcutRecordingActive,
    deviceMid,
  });

  disposeRendererActionTraceIpc = registerRendererActionTraceIpc({
    rollout: rendererActionTraceRollout,
    broker: rendererActionTraceBroker,
    env: process.env,
    logger,
  });

  registerRemoteIpcHandlers({
    logger,
    appTelemetryRuntime,
    onOAuthCallbackHandledSideEffect: () => {
      void armsUserIdentitySync.refresh();
    },
    appTelemetryCore,
    reportRemoteUsageEvent: reportRemoteUsageEventForRenderer,
    armsCustomContext: {
      deviceMid,
      platform: process.platform,
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
    },
    finalArmsCustomEventE2EEnabled: shouldEnableE2ETestBridge(process.env),
    createRemoteWorkspaceSession: remoteSessionManager.createRemoteWorkspaceSession,
    getRemoteConnectionStats: remoteSessionManager.getRemoteConnectionStats,
    disposeRemoteWorkspaceSession: remoteSessionManager.disposeRemoteWorkspaceSession,
    cancelPendingRemoteWorkspaceSessionsForWindow:
      remoteSessionManager.cancelPendingRemoteWorkspaceSessionsForWindow,
    bindRemoteWorkspaceSessionContext: remoteSessionManager.bindRemoteWorkspaceSessionContext,
    confirmRendererAttachmentReady: remoteSessionManager.confirmRendererAttachmentReady,
    listAvailableWSLDistros,
    listSSHConfigAliases,
  });

  // Wait for ARMS to complete init (including rendering process injection monitoring) to avoid no reporting due to the first window dom-ready being registered earlier than the SDK
  await armsInitPromise;

  // After ARMS init is completed, user.name is written for the first time (drop device_mid)
  void armsUserIdentitySync.refresh();

  // When the ARMS endpoint is not configured, the reporting context is not initialized to avoid mistaking idling for being enabled.
  if (ZCODE_TELEMETRY_ENABLED && ZCODE_ARMS_RUM_ENDPOINT) {
    configureDesktopStabilityTelemetry({
      deviceMid,
      platform: process.platform,
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
    });
    configureDesktopResourceTelemetry({
      deviceMid,
      platform: process.platform,
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
    });
    configureDesktopNetworkTelemetry({
      deviceMid,
      platform: process.platform,
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
    });
  }
  configureDesktopMcpTelemetry({
    deviceMid,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  registerDesktopStabilityMonitors(logger, crashCapturePaths);
  registerDesktopResourceTelemetry(logger);
  // The 60-second heap sample entry of the main window renderer; it is resident with the App life cycle and is only registered once.
  registerRendererHeapSampleIpc();
  const defaultDataBaseDir = process.env.HOME?.trim() || homedir();
  registerDesktopZCodeDataSizeTelemetry({
    context: {
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
      dataRootKind:
        resolve(getDataBaseDir()) === resolve(defaultDataBaseDir) ? "default" : "custom",
      deviceMid,
      platform: process.platform,
    },
    getSystemIdleTimeSeconds: () => powerMonitor.getSystemIdleTime(),
    isAppBackground: () => resolveResourceUsageScene() === "background",
    isZCodeBusy: () => getRunningAgentSessionCount() > 0,
    logger,
    rootPath: getZCodeDataRootDir(),
    stateFile: join(app.getPath("userData"), "zcode-data-size-telemetry.json"),
  });
  registerDesktopNetworkTelemetry(logger);

  // Local unpackaged dev builds (app.isPackaged === false) must bypass the remote forced upgrade gate.
  // Reason: force-update gate only looks at ZCODE_ENV === "production", but dev builds (such as dev:desktop:cua
  // Even though the real backend test (computer use) points to the production backend, the version number lags behind the online release (feature
  // If the branch does not bump the version), it will be misjudged by release minimalVersion as "requiring forced upgrade" and the instant rollback will be initiated. force-update
  // It is a security gate for packaged and released clients, and is meaningless for unpackaged dev runtimes. Packaged version app.isPackaged === true,
  // The gate takes effect as usual and has zero impact on real users.
  const skipForceUpdateForLocalDevRuntime = !app.isPackaged;
  const forceUpdateGuardResult =
    ZCODE_PRODUCT_FLAVOR === "production" && !skipForceUpdateForLocalDevRuntime
      ? await maybeBlockStartupForForceUpdate({
          logger,
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          onBlocked: () => {
            forceUpdateMainWindowCreationBlocked = true;
          },
        })
      : { blocked: false };
  if (ZCODE_PRODUCT_FLAVOR !== "production") {
    logger.info("[force-update] Preview skipped the remote force update check");
  } else if (skipForceUpdateForLocalDevRuntime) {
    logger.info(
      "[force-update] local dev build (not packaged) skipped the remote force update check",
    );
  }
  if (forceUpdateGuardResult.blocked) {
    return;
  }

  logger.info("[startup] creating the main window");
  await primaryWindowCoordinator.ensurePrimaryWindow("app-ready");

  const primaryWindow = getApplicationWindowsExcludingCuaIndicator()[0];
  if (primaryWindow) {
    scheduleReportPerfAppStartAfterMainViewReady(primaryWindow.webContents, logger);
  }

  // After startup, check whether the CPU architecture matches (for example, if the Apple chip mistakenly installs the x64 version and is translated and run by Rosetta),
  // After hitting the target, an asynchronous pop-up box prompts you to install the native architecture version without blocking the main interface.
  void maybeWarnArchitectureMismatch({
    logger,
    parentWindow: getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
    icon: nativeImage.createFromPath(iconPath),
  }).catch((error) => {
    logger.warn("[architecture] the architecture mismatch dialog failed:", error);
  });

  const protocolUrl = extractDeepLinkUrlFromArgs(process.argv);
  if (startupDeepLinkConsumptionGate.shouldHandleReadyProtocolUrl(protocolUrl)) {
    handleDeepLink(protocolUrl, logger, {
      confirmationCopy: externalWorkspaceOpenDialogCopy,
      resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
    });
  }
});

app.on("browser-window-created", (_, win) => {
  const windowWebContentsId = win.webContents.id;
  win.on("closed", () => {
    browserScreenshotSurfaceCoordinator.handleWindowDestroyed(win.id);
    browserGuestManager.closeWindow(win.id);
    windowWorkspaceMap.delete(win.id);
    windowTaskRealtimeHostIdMap.delete(win.id);
    if (windowUnreadCountMap.delete(win.id)) {
      syncApplicationUnreadBadge(windowUnreadCountMap);
    }
    // When Electron enters the closed callback, win.webContents may have been destroyed.
    // Previously, win.webContents.id was retrieved here, and "Object has been destroyed" would be thrown at the end of closing the window.
    // Instead cache the webContents id on window creation, ensuring that destroyed objects are no longer accessed when cleaning up OAuth routes.
    clearOAuthRoutesForWindow(windowWebContentsId);
    // When the window is closed or crashes during recording, the renderer will not send a reset IPC. Click here to initiate webContents to reset the recording state.
    // Prevents the menu accelerator from being permanently removed.
    resetShortcutRecordingForWebContents(windowWebContentsId);
  });
  // closed will not be triggered when the rendering process crashes but the window is alive, and the crash path is also reset by owner
  // (Naturally idempotent when owner does not match).
  win.webContents.on("render-process-gone", () => {
    resetShortcutRecordingForWebContents(windowWebContentsId);
  });
});
app.on("window-all-closed", () => {
  if (process.platform === "darwin") {
    // macOS: keep app running when all windows are closed
    return;
  }

  app.quit();
});
app.on("before-quit", (event) => {
  // The final window closing in Windows will be confirmed in advance and marked with forceQuit in the close phase;
  // macOS's Cmd+Q/menu exit will not prompt the window to close the confirmation, and the application-level confirmation must be retained in before-quit.
  if (!forceQuitRef.current && shouldConfirmAppQuit() && !confirmAppQuit()) {
    event.preventDefault();
    // If explicit exit such as tray exit is canceled by the confirmation box, explicitQuit cannot be retained.
    // Otherwise, the next time the user clicks the Windows Close button, the "Hide to Tray" setting will be bypassed and the full exit path will be triggered by mistake.
    explicitQuitRef.current = false;
    return;
  }

  if (!hasPreparedAppQuit) {
    localMediaPreviewPathRegistry.clear();
    event.preventDefault();
    void prepareAppQuit("app-before-quit").finally(() => {
      const remainingWindows = getApplicationWindowsExcludingCuaIndicator();
      logger.info(
        `[app-quit] preparation finished, resuming quit with windows=${remainingWindows.length}`,
      );
      // When ChromeDriver triggers app.quit after closing the last renderer,
      // The first before-quit will be intercepted by asynchronous host cleaning; the window may still be in the
      // closing state, re-entering app.quit at this time will be ignored by Electron, and ChromeDriver will wait
      // About 70 seconds. Here, the last exit is bound to the real closed event, without relying on timeout guessing.
      if (remainingWindows.length === 0) {
        exitPreparedApp("no-windows-after-preparation");
        return;
      }

      let exitRequested = false;
      const exitAfterLastWindowClosed = () => {
        if (exitRequested || getApplicationWindowsExcludingCuaIndicator().length > 0) {
          return;
        }
        exitRequested = true;
        logger.info("[app-quit] all windows closed after preparation, exiting app");
        exitPreparedApp("all-windows-closed-after-preparation");
      };
      for (const win of remainingWindows) {
        win.once("closed", exitAfterLastWindowClosed);
      }
      app.quit();
    });
  }
});
app.on("activate", () => {
  void primaryWindowCoordinator.ensurePrimaryWindow("app-activate");
});
