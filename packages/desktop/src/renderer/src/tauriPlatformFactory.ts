import type { IPlatformService } from "@zcode/shared";

import { bootstrapTauriPlatform, createTauriPlatformSubset } from "./tauriPlatform.js";

/**
 * Tauri runtime platform factory — Phase 3, the renderer seam (`main.tsx` selects this when
 * `isTauriRuntime()`). This is a DEGRADED BOOT PLATFORM, not parity: methods backed by a real, verified
 * Tauri command delegate to `createTauriPlatformSubset()`; the rest return safe inert values so the
 * renderer can MOUNT and render instead of crashing on the absent Electron `window.zcode`.
 *
 * Honest scope note: the inert fallbacks below are explicitly "not yet ported to the Tauri shell" — they
 * no-op (void methods), return empty/false/null (getters), or return a never-firing disposer (`on*`).
 * They are NOT stubs pretending to work; calling an inert feature does nothing until it is ported. The
 * real, backed methods are the source of truth. Electron has been removed from this project — Tauri is
 * the sole desktop runtime; these inert methods are Phase-3 surfaces awaiting a Tauri command.
 *
 * The `as unknown as IPlatformService` cast is deliberate: only the boot-path methods need concrete
 * shapes now; unported methods are filled with best-effort defaults and will be replaced by real
 * command-backed implementations slice-by-slice (see `tauri-port/GO-NO-GO.md` core-path plan).
 */

/** A `() => void` disposer that does nothing — for `on*` subscriptions whose emit source isn't wired. */
const inertDisposer = (): (() => void) => () => {};

/**
 * Build the degraded Tauri platform. Callers MUST `await bootstrapTauriPlatform()` first (or use
 * {@link createTauriPlatformAsync}) so the synchronous getters (e.g. `getDeviceId`) are populated.
 */
export function createTauriPlatform(): IPlatformService {
  // Kick the synchronous-getter prefetch (blocker #7). Fire-and-forget: the async MessagePort wait in
  // main.tsx gives it time to resolve before the first synchronous getter read (getDeviceId).
  void bootstrapTauriPlatform();
  const subset = createTauriPlatformSubset();

  const degraded = {
    // --- eager / boot-path reads that crashed the renderer under Tauri (window.zcode.* in Electron) ---
    // printToPDF is not available on the Tauri webview yet (PRINT-PDF-SPIKE); report an error result.
    printPageToPdf: async () => ({
      success: false,
      error: "not-supported-in-tauri-shell",
    }),
    getDesktopWindowChromeState: async () => ({
      isMaximized: false,
      supportsNativeRoundedCorners: false,
    }),
    onDesktopWindowChromeStateChanged: inertDisposer,
    getWindowControlsOverlayMetrics: () => null,

    // --- fire-and-forget main-process bookkeeping: inert until the shell registry is ported ---
    notifyRendererReady: () => {},
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    syncAppSettings: () => {},
    setShortcutRecordingActive: () => {},
    registerOAuthState: () => {},

    // --- `on*` subscriptions whose emit sources (deep links / menu / updater) aren't wired yet ---
    onOAuthCallback: inertDisposer,
    onPaymentCallback: inertDisposer,
    onShareImport: inertDisposer,
    onOpenFeedbackDialog: inertDisposer,
    onOpenTicketsPanel: inertDisposer,
    onFocusTab: inertDisposer,
    onNewTab: inertDisposer,
    onNewTask: inertDisposer,
    onOpenWorkspace: inertDisposer,
    onOpenWorkspacePath: inertDisposer,
    onCloseActiveContextRequest: inertDisposer,
    onSettingsChanged: inertDisposer,
    onApplicationLocaleChanged: inertDisposer,
    onTaskNotificationClick: inertDisposer,
    onRemoteConnectionLog: inertDisposer,
    onRemoteSessionClosed: inertDisposer,
    onBotRemoteWorkspaceReconnected: inertDisposer,

    // --- config / remote / browser / updater families: inert safe defaults until ported ---
    openFeedback: async () => {},
    openCommunity: async () => {},
    canOpenCommunity: async () => false,
    saveFile: async () => ({
      success: false,
      error: "not-supported-in-tauri-shell",
    }),
    getPathForFile: () => null,
    createLocalMediaPreviewUrl: () => "",
    isDockerAvailable: async () => false,
    listWSLDistros: async () => [],
    listDockerContainers: async () => [],
    listSSHConfigAliases: async () => [],
    disposeRemoteSession: async () => {},
    cancelPendingRemoteConnection: async () => {},
    connectRemote: async () => ({
      success: false,
      error: "not-supported-in-tauri-shell",
    }),
    getInstalledEditors: async () => [],
    executeDesktopCommand: async () => undefined,
    setApplicationLocale: async () => {},
    exportLogs: async () => ({
      success: false,
      error: "not-supported-in-tauri-shell",
    }),
    captureWindowScreenshot: async () => null,

    // --- updater (D2, tauri-plugin-updater not installed): inert ---
    getUpdateState: async () => ({ status: "idle" }),
    onUpdateReady: inertDisposer,
    onUpdateCheckResult: inertDisposer,
    onUpdateStateChanged: inertDisposer,
    downloadUpdate: async () => {},
    cancelUpdateDownload: async () => {},
    quitAndInstallUpdate: async () => {},
    openUpdateStatusWindow: async () => {},
    getAutoUpdatePreferences: async () => ({
      autoDownload: false,
      autoInstall: false,
    }),
    setAutoDownloadAndInstallUpdates: async () => {},
    skipUpdateVersion: async () => {},
    onPostUpdateReleaseNotes: inertDisposer,
    acknowledgePostUpdateReleaseNotes: async () => {},
    getDesktopSessionActivity: async () => ({}),
    getZCodeStdioTapDevState: async () => ({
      enabled: false,
      logDir: "",
      statePath: "",
    }),
  };

  // Real command-backed methods (subset) win over the degraded defaults on key collision.
  return { ...degraded, ...subset } as unknown as IPlatformService;
}

/**
 * Await-init-before-expose: populates the synchronous-getter cache (blocker #7), then returns the
 * platform. This is what `main.tsx` should call under `isTauriRuntime()`.
 */
export async function createTauriPlatformAsync(): Promise<IPlatformService> {
  await bootstrapTauriPlatform();
  return createTauriPlatform();
}
