/* eslint-disable max-lines -- permission channel registration, the drag floating panel, and the foreground-app return wait all share the same main-process session state */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, ipcMain, nativeImage, screen } from "electron";
import { PlatformChannels, type CuaPermissionKind, type Locale } from "@zcode/shared";
import {
  cuaHelperBundleFingerprintUnchanged,
  openCuaPermissionOnboarding,
  prepareCuaHelperPermissionDrag,
} from "./cuaAccessibilitySettings.js";
import {
  createCuaPermissionDragPanel,
  createRealCuaPermissionPanelWindow,
  type CuaPermissionDragPanel,
} from "./cuaPermissionDragPanel.js";
import { createSystemSettingsWindowWatcher } from "./cuaSystemSettingsWindowWatcher.js";

const execFileAsync = promisify(execFile);
const MACOS_SYSTEM_SETTINGS_BUNDLE_ID = "com.apple.systempreferences";
// 1x1 transparent PNG. startDrag requires icon to be non-empty on macOS (electron.d.ts: "The image must be non-empty
// on macOS"), use it when you can't even read the included ZCode icon - otherwise startDrag will throw an exception and the user will be unable to drag at all.
const CUA_HELPER_DRAG_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
/** Both the drag cursor and the floating window tile use 64pt to avoid huge cursor textures. */
const CUA_DRAG_ICON_SIZE = 64;

/**
 * Drag the ZCode icon shared by the cursor and the floating window tile (module-level caching to avoid reading the disk every time you drag).
 *
 * Cannot use `nativeImage.createFromNamedImage("NSApplicationIcon")`: it takes the **current host app**
 * Icon, the host under dev is Electron.app, so the Electron default icon is displayed when dragging.
 * Change to explicitly read the ZCode icon that comes with the package (electron-builder has typed build/icon.png into resources/icon.png).
 */
let cachedZCodeIcon: Electron.NativeImage | null = null;

function resolveZCodeIcon(): Electron.NativeImage {
  if (cachedZCodeIcon && !cachedZCodeIcon.isEmpty()) return cachedZCodeIcon;
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(import.meta.dirname, "..", "..", "build", "icon.png");
  const image = nativeImage.createFromPath(iconPath);
  cachedZCodeIcon = image.isEmpty()
    ? nativeImage.createFromDataURL(CUA_HELPER_DRAG_ICON_DATA_URL)
    : image;
  return cachedZCodeIcon;
}

interface CuaApplicationReturnOptions {
  openSettings: () => Promise<void>;
  timeoutMs: number;
  signal: AbortSignal;
  resolveFrontmostBundleId?: () => Promise<string | null>;
}

async function resolveFrontmostBundleId(): Promise<string | null> {
  const { stdout: front } = await execFileAsync("/usr/bin/lsappinfo", ["front"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  const asn = front.trim();
  if (!asn) return null;
  const { stdout: info } = await execFileAsync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundleid", asn],
    { encoding: "utf8", timeout: 2_000 },
  );
  return info.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1] ?? null;
}

/**
 * Listen to the application-level window signal of Electron main instead of the DOM focus of origin renderer. Initiated by the user from window A,
 * When returning to window B, the original IPC of A must also be advanced; the listener is installed before openExternal and all race empty windows are closed.
 */
function waitForCuaApplicationReturn({
  openSettings,
  timeoutMs,
  signal,
  resolveFrontmostBundleId: readFrontmostBundleId = resolveFrontmostBundleId,
}: CuaApplicationReturnOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let settingsOpened = false;
    // The LaunchServices query is two sub-process round trips. The ASN of Settings may have been read, but in
    // The bundle id is returned only after the ZCode focus edge. Pair "probe start/during blur" with monotonic sequence numbers
    // Subsequent focus neither loses the true return nor resurrects the old snapshot of BrowserWindow.isFocused().
    let applicationEventSequence = 0;
    let latestBlurSequence = 0;
    let latestZCodeReturnSequence = 0;
    let observedSystemSettingsAfterSequence: number | null = null;
    let activeInspections = 0;
    let inspectionTimer: ReturnType<typeof setTimeout> | undefined;
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (observationTimer) clearTimeout(observationTimer);
      if (inspectionTimer) clearTimeout(inspectionTimer);
      app.removeListener("browser-window-blur", onBlur);
      app.removeListener("browser-window-focus", onFocus);
      app.removeListener("activate", onFocus);
      app.removeListener("before-quit", onQuit);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const maybeFinishReturn = () => {
      if (
        settingsOpened &&
        observedSystemSettingsAfterSequence !== null &&
        latestZCodeReturnSequence > observedSystemSettingsAfterSequence
      )
        finish();
    };
    const scheduleInspection = () => {
      if (settled || activeInspections > 0 || observedSystemSettingsAfterSequence !== null) return;
      if (inspectionTimer) clearTimeout(inspectionTimer);
      inspectionTimer = setTimeout(inspectFrontmost, 150);
    };
    const inspectFrontmost = (forceAtEventBoundary = false) => {
      if (
        settled ||
        observedSystemSettingsAfterSequence !== null ||
        (!forceAtEventBoundary && activeInspections > 0)
      )
        return;
      if (inspectionTimer) {
        clearTimeout(inspectionTimer);
        inspectionTimer = undefined;
      }
      const inspectionStartedAtSequence = applicationEventSequence;
      // Only sampling started in the leaving interval of "the last application event is blur and return focus has not been seen yet",
      // Only then can evidence be established for this System Settings round-trip. Query triggered by return focus itself even later
      // Reading the hysteresis Settings value of LaunchServices also cannot pair with the same focus or clear the timeout.
      const inspectionStartedWhileAway = latestBlurSequence > latestZCodeReturnSequence;
      activeInspections += 1;
      void readFrontmostBundleId().then(
        (bundleId) => {
          activeInspections -= 1;
          if (settled) return;
          if (
            bundleId === MACOS_SYSTEM_SETTINGS_BUNDLE_ID &&
            inspectionStartedWhileAway &&
            inspectionStartedAtSequence >= latestBlurSequence
          ) {
            // If another blur is received during this query, the blur must also be earlier than the acceptable ZCode
            // return edge. This will eliminate the old focus of "first cut the window inside ZCode, then open Settings".
            // Results from LaunchServices can be delivered earlier than Electron blur. If the pre-open probe reads first
            // Settings, and there was exactly one ZCode focus/activate before the detection was started. Immediately treating the old focus as "return" would be a misjudgment.
            // The probe must be started after the latest blur and before return focus: only checking "once blur" will still borrow once
            // Earlier internal window cuts are blurred; probes started after focus may read the lagging value of LaunchServices and permanently
            // Clear the timeout. Both types of results are ignored and left to the blur-bound/away-interval probe for confirmation.
            observedSystemSettingsAfterSequence = Math.max(
              inspectionStartedAtSequence,
              latestBlurSequence,
            );
            // The old timer mistook the machine SLA of "whether system settings are turned on" as the user operation time limit. Confirm settings page
            // It is cleared immediately after being in the foreground; return/restart is not lost as long as the user stays, and is only ended by an explicit life cycle signal.
            if (observationTimer) {
              clearTimeout(observationTimer);
              observationTimer = undefined;
            }
            maybeFinishReturn();
            return;
          }
          scheduleInspection();
        },
        () => {
          activeInspections -= 1;
          scheduleInspection();
        },
      );
    };
    const onBlur = () => {
      latestBlurSequence = ++applicationEventSequence;
      // The pre-open lsappinfo query may have picked up ZCode, but got stuck in the second info sub-process.
      // If the global single-flight is reused, the complete round-trip opened by Settings and quickly returned will fall into the blind window. blur edge
      // A time-bound parallel sampling must be forced to be started; ordinary 150ms polling remains single-flight to avoid unbounded concurrency.
      inspectFrontmost(true);
    };
    const onFocus = () => {
      // System Settings BrowserWindow.isFocused() may still briefly hold the old true after becoming foreground.
      // Directly reading this stale snapshot when the front-end probe is completed will misjudge "the settings page just opened" as "the user has returned".
      // focus/activate always records the serial number first; if the corresponding Settings probe is still flying, it will return after a delay
      // You can still use inspection-start snapshot to prove that this is a subsequent edge. Edges can also resolve earlier than openExternal.
      latestZCodeReturnSequence = ++applicationEventSequence;
      inspectFrontmost();
      maybeFinishReturn();
    };
    const onQuit = () => finish(new Error("ZCode quit during CUA permission onboarding"));
    const onAbort = () =>
      finish(signal.reason ?? new Error("CUA permission onboarding origin window closed"));
    observationTimer = setTimeout(
      () =>
        finish(
          new Error(`System Settings did not return to ZCode within ${Math.max(1, timeoutMs)}ms`),
        ),
      Math.max(1, timeoutMs),
    );

    app.on("browser-window-blur", onBlur);
    app.on("browser-window-focus", onFocus);
    app.on("activate", onFocus);
    app.on("before-quit", onQuit);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    // All listeners are installed before calling openExternal; from this moment on the real foreground app starts polling LaunchServices.
    // Only when System Settings is indeed observed can subsequent ZCode focus be advanced, and internal window switching will not be misjudged.
    inspectFrontmost();
    void openSettings().then(
      () => {
        settingsOpened = true;
        maybeFinishReturn();
      },
      (error) => finish(error),
    );
  });
}

function normalizePermissionList(value: unknown): CuaPermissionKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const set = new Set<CuaPermissionKind>();
  for (const permission of value) {
    if (permission === "accessibility" || permission === "screen_recording") {
      set.add(permission);
    }
  }
  return [...set];
}

function normalizeOnboardingOperationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : null;
}

/**
 * Create a floating window (including adsorption data source) for an onboarding session.
 *
 * When the watcher cannot get bounds (the binary is not packaged, there is no swiftc build, the settings page is not open, the process crashes)
 * `getSettingsBounds` returns null → positioner takes the fail-open branch to center the panel at the bottom of the screen.
 * Adsorption is a visual enhancement and must not be a prerequisite for the usability of authorized guidance.
 */
function createDragPanelForSession(
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  getLocale: () => Locale,
): CuaPermissionDragPanel {
  const watcher = createSystemSettingsWindowWatcher({
    binaryPath: resolveWindowBoundsBinaryPath(),
    logger,
  });
  watcher.start();

  return createCuaPermissionDragPanel({
    createWindow: createRealCuaPermissionPanelWindow({
      BrowserWindow,
      app,
      preloadPath: join(import.meta.dirname, "../preload/cuaPermissionPanel.cjs"),
      rendererDir: join(import.meta.dirname, "../renderer"),
      rendererDevUrl: process.env["ELECTRON_RENDERER_URL"],
    }),
    getDisplayWorkArea: () => screen.getPrimaryDisplay().workArea,
    getSettingsBounds: () => watcher.latest(),
    stopSettingsBounds: () => watcher.stop(),
    getLocale,
    // The tile uses a real ZCode icon that matches the icon in the row in the system settings permission list, so that the user can
    // "Things to be dragged" correspond to "items to appear in the list".
    getIconDataUrl: () =>
      resolveZCodeIcon()
        .resize({ width: CUA_DRAG_ICON_SIZE, height: CUA_DRAG_ICON_SIZE })
        .toDataURL(),
    logger,
  });
}

/** For production, use the extraResources in the signed package; for dev, use the build products in checkout. */
function resolveWindowBoundsBinaryPath(): string {
  const relative = join("macos-window-bounds", "zcode-window-bounds");
  return app.isPackaged
    ? join(process.resourcesPath, relative)
    : join(import.meta.dirname, "..", "..", "resources", relative);
}

export function registerCuaPermissionIpcHandlers(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  currentApplicationLocale: () => Locale;
}) {
  // operationId is only valid within the same webContents id namespace to prevent another renderer from canceling after guessing the id.
  // A participant that does not belong to you. The final state of invoke must be deleted; destroyed is still covered by the original signal path.
  const onboardingControllers = new Map<string, AbortController>();
  const operationKey = (senderId: number, operationId: string) => `${senderId}\0${operationId}`;

  // Verified Helper.app path + byte fingerprint cache. Native file drag and drop must be called *synchronously* in the dragstart event link
  // event.sender.startDrag(), cannot wait for asynchronous I/O such as install/verify (otherwise the OS drag gesture window will be missed and the user
  // No files can be dragged out). Therefore, when mounting the floating window, first prepare to warm up, dragstart read-only cache + microsecond-level synchronous fingerprint comparison.
  let verifiedHelperAppPath: string | null = null;
  let verifiedHelperFingerprint: string | null = null;
  // Helper's bundle display name. Floating tile displays it instead of hardcoded string - macOS permission list
  // The name of that row is this value (with the Dev suffix under dev). Only when both sides are consistent can the user confirm that "the one dragged in is it."
  let verifiedHelperDisplayName: string | null = null;
  // The floating window for the current session. After dragging and landing, you need to notify it of the frozen position, and StartDrag and onboarding are two independent
  // handler, so this layer of sharing is mentioned; the session end state is returned to null.
  let activeDragPanel: CuaPermissionDragPanel | null = null;

  function cacheVerifiedHelper(
    helperAppPath: string,
    verifiedFingerprint: string,
    displayName: string | null,
  ): void {
    verifiedHelperAppPath = helperAppPath;
    verifiedHelperFingerprint = verifiedFingerprint;
    verifiedHelperDisplayName = displayName;
  }

  function clearVerifiedHelper(): void {
    verifiedHelperAppPath = null;
    verifiedHelperFingerprint = null;
    verifiedHelperDisplayName = null;
  }

  async function refreshVerifiedHelperAppPath(): Promise<void> {
    const result = await prepareCuaHelperPermissionDrag({ logger: options.logger });
    if (result.success && result.helperAppPath && result.helperBundleFingerprint) {
      cacheVerifiedHelper(
        result.helperAppPath,
        result.helperBundleFingerprint,
        result.helperDisplayName ?? null,
      );
    } else {
      clearVerifiedHelper();
      options.logger.warn("[cua-permission-onboarding] prepare helper drag failed", result.error);
    }
  }

  // Called when the floating window is mounted: asynchronous install+verify and caches the verified path + fingerprint to prepare for subsequent synchronous drag and drop.
  ipcMain.handle(PlatformChannels.PrepareCuaHelperPermissionDrag, async () => {
    await refreshVerifiedHelperAppPath();
    // The fingerprint is synchronized TOCTOU evidence on the main side and is never returned across IPC to the renderer.
    return {
      success: verifiedHelperAppPath !== null,
      ...(verifiedHelperAppPath !== null ? { helperAppPath: verifiedHelperAppPath } : {}),
      ...(verifiedHelperDisplayName !== null
        ? { helperDisplayName: verifiedHelperDisplayName }
        : {}),
      ...(verifiedHelperAppPath === null ? { error: "helper drag preparation failed" } : {}),
    };
  });

  ipcMain.on(PlatformChannels.StartCuaHelperPermissionDrag, (event) => {
    const helperAppPath = verifiedHelperAppPath;
    const fingerprint = verifiedHelperFingerprint;
    if (!helperAppPath || !fingerprint) {
      // Not yet warmed up: asynchronous install/verify must not be done here (drag gestures will be missed). Make it up in the background so that it can be used next time you drag and drop.
      // Skip this time (prepare has been triggered when the floating window is mounted, and it will not go here normally).
      options.logger.warn(
        "[cua-permission-onboarding] helper drag not prepared yet; verifying in background for next drag",
      );
      void refreshVerifiedHelperAppPath();
      return;
    }
    // TOCTOU gate: prepare (signature verification) From now on, an attacker with the same UID may overwrite Helper.app, and the TCC authorization is bound to
    // The identity of the bundle being dragged into. Synchronously compare byte fingerprints (ino/ctime/size, ctime user mode cannot be dialed back); if it does not match, it means
    // Refuse to drag + clear cache and prepare again. Never drag bundles that may be replaced into Accessibility/Screen Recording.
    // The comparison is synchronized (microsecond level) and drag gestures are not missed.
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, fingerprint)) {
      options.logger.warn(
        "[cua-permission-onboarding] cached helper changed since verification; refusing to drag a possibly-tampered bundle",
      );
      clearVerifiedHelper();
      void refreshVerifiedHelperAppPath();
      return;
    }
    const icon = resolveZCodeIcon().resize({
      width: CUA_DRAG_ICON_SIZE,
      height: CUA_DRAG_ICON_SIZE,
    });
    try {
      // Start native file drag and drop synchronously - only then will the OS actually drag Helper.app out to the system settings.
      event.sender.startDrag({ file: helperAppPath, icon });
    } catch (error) {
      options.logger.warn(
        "[cua-permission-onboarding] helper drag failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    // Drag has been implemented: the system setting will then pop up a modal prompt, and continuing to track the window will cause the floating window to chase the prompt box and be pressed under it.
    activeDragPanel?.freezePosition();
    // If dragend/mouseup is received later, the floating window will be taken away directly (see handler below); freeze is the signal
    // Don’t let the pop-up window chase the system prompt box.
    // Refresh the cache in the background (Helper may be reinstalled/upgraded in the background) to ensure that the next drag and drop will still have the latest verified path + fingerprint.
    void refreshVerifiedHelperAppPath();
  });

  // The drag gesture ends - the authorization has been implemented, and the floating window gives way to the settings page and system restart prompt. Use hide instead of destroy:
  // The same window will be reused in the next permissions phase. hide is idempotent, dragend and mouseup repeat notifications harmlessly.
  ipcMain.on(PlatformChannels.NotifyCuaHelperPermissionDragEnded, () => {
    activeDragPanel?.hide();
  });

  ipcMain.on(PlatformChannels.CancelCuaPermissionOnboarding, (event, payload) => {
    const senderId = event.sender?.id;
    const operationId = normalizeOnboardingOperationId(
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).operationId
        : undefined,
    );
    if (!Number.isInteger(senderId) || !operationId) return;
    onboardingControllers
      .get(operationKey(senderId, operationId))
      ?.abort(new Error("CUA permission onboarding surface closed"));
  });

  ipcMain.handle(PlatformChannels.OpenCuaPermissionOnboarding, async (event, payload) => {
    // Directly open the corresponding panel of the system settings (no more confirmation dialog boxes + no more exposure of Helper tiles/animations in Finder).
    const payloadRecord =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
    const operationId = normalizeOnboardingOperationId(payloadRecord?.operationId);
    const requiredPermissions = normalizePermissionList(payloadRecord?.requiredPermissions);
    const originController = new AbortController();
    const sender = event.sender as {
      id?: number;
      isDestroyed?: () => boolean;
      once?: (event: "destroyed", listener: () => void) => void;
      removeListener?: (event: "destroyed", listener: () => void) => void;
    };
    const senderId =
      typeof sender.id === "number" && Number.isInteger(sender.id) ? sender.id : null;
    const participantOperationKey =
      senderId !== null && operationId ? operationKey(senderId, operationId) : null;
    if (participantOperationKey && onboardingControllers.has(participantOperationKey)) {
      return {
        success: false,
        canceled: true,
        error: "duplicate CUA permission onboarding operation id",
      };
    }
    if (participantOperationKey) {
      onboardingControllers.set(participantOperationKey, originController);
    }
    const abortForDestroyedOrigin = () =>
      originController.abort(new Error("CUA permission onboarding origin window closed"));
    if (sender.isDestroyed?.()) abortForDestroyedOrigin();
    else sender.once?.("destroyed", abortForDestroyedOrigin);

    // Lazy creation: Floating windows are only meaningful in the actual boot process of macOS, and must be created/destroyed session by session (no singleton,
    // Prevent the remaining windows from the previous session from being reused by the next session). Non-darwin values ​​remain null, and all call points are short-circuited with ?..
    //
    // Must include try/catch: To create a floating window, you need to parse the binary path, start the watcher subprocess, and build the BrowserWindow.
    // Any exception thrown at any step should not break down the entire authorization boot - then the user cannot even open the settings page, and there is no floating window.
    // The settings page is still available (users can drag .app from Finder into the list themselves). Downgrade > Total failure.
    let dragPanel: CuaPermissionDragPanel | null = null;
    if (process.platform === "darwin") {
      try {
        dragPanel = createDragPanelForSession(options.logger, options.currentApplicationLocale);
      } catch (error) {
        options.logger.warn(
          "[cua-permission-onboarding] drag panel unavailable; continuing with settings pane only",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    activeDragPanel = dragPanel;

    let result: Awaited<ReturnType<typeof openCuaPermissionOnboarding>>;
    try {
      result = await openCuaPermissionOnboarding({
        initialPermission:
          payloadRecord?.initialPermission === "screen_recording"
            ? "screen_recording"
            : "accessibility",
        ...(requiredPermissions !== undefined ? { requiredPermissions } : {}),
        ...(typeof sender.id === "number" && Number.isInteger(sender.id)
          ? { participantKey: `webContents:${sender.id}` }
          : {}),
        signal: originController.signal,
        // Each stage: When opening the settings page, a drag-and-drop window pops up (the only way for the Helper to enter the TCC list),
        // The stage will be collected after waiting for it to end. The final cleanup of the entire session is in finally below.
        openSettingsAndWaitForReturn: async (stage) => {
          try {
            await waitForCuaApplicationReturn({
              ...stage,
              openSettings: async () => {
                await stage.openSettings();
                dragPanel?.show(stage.permission);
              },
            });
          } finally {
            dragPanel?.hide();
          }
        },
        logger: options.logger,
      });
    } finally {
      // The floating window will be destroyed in all session end states (success/cancellation/timeout/origin destroyed). The PiP panel was missing this
      // It is cleaned up unconditionally and persists out of thin air. It is placed in finally and does not depend on any success path.
      dragPanel?.destroy();
      if (activeDragPanel === dragPanel) activeDragPanel = null;
      sender.removeListener?.("destroyed", abortForDestroyedOrigin);
      if (
        participantOperationKey &&
        onboardingControllers.get(participantOperationKey) === originController
      ) {
        onboardingControllers.delete(participantOperationKey);
      }
    }
    // During onboarding, the user may stay in the system settings for a long time, and the old verification evidence when the stage is started cannot be used after returning.
    // Continue as "verified fingerprint". After success, another prepare with verify+fingerprint is started for next drag and drop.
    if (result.success) void refreshVerifiedHelperAppPath();
    return result;
  });

  // 2026-08 Audit once deleted Prepare/StartCuaHelperPermissionDrag as a dead link (there was no caller in the rendering layer at that time,
  // Permission guidance relies on native pop-up windows to allow Helper to automatically enter the TCC list). After the pop-up window is removed, drag it to become
  // Helper's only way into the permissions list, both channels have been restored above.
}
