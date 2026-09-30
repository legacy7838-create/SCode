import { BrowserWindow, screen } from "electron";
import type { BrowserWindowConstructorOptions, Display, Point, Rectangle } from "electron";
import type { HostCuaOperationStateResponse } from "@zcode/shared";
import {
  INDICATOR_CARD_TOP_OFFSET,
  INDICATOR_SHADOW_INSET,
  indicatorDataUrl,
  indicatorWindowSize,
} from "./windowsCuaOperationIndicatorContent.js";

const HIDE_ANIMATION_MS = 120;
/**
 * Hidden time limit. The main hidden ones are turn final state/session closed/runtime unavailable/workspace destroyed
 * For these explicit clearing paths, this timer will only end when they all fail to ensure that the floating layer will not stay indefinitely.
 *
 * Take 30s instead of shorter: CUA facts are now reported per cell (once per node_repl cell), within the same turn
 * Subsequent cells will refresh the timer, but a single cell itself can run for a long time, and 10s will cause the floating layer to go out in the middle of the operation.
 */
const AUTO_HIDE_MS = 30_000;
const CREATE_RETRY_MS = 250;

interface WindowsCuaOperationIndicatorWindow {
  readonly webContents: Pick<BrowserWindow["webContents"], "executeJavaScript">;
  destroy(): void;
  hide(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  moveTop(): void;
  on(event: "closed", listener: () => void): this;
  setAlwaysOnTop(flag: boolean, level?: Parameters<BrowserWindow["setAlwaysOnTop"]>[1]): void;
  setBounds(bounds: Rectangle): void;
  setContentProtection(enable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  showInactive(): void;
}

interface WindowsCuaOperationIndicator {
  handleState(source: object, event: HostCuaOperationStateResponse): void;
  clearSource(source: object): void;
  ownsWindow(candidate: object): boolean;
  dispose(): void;
}

interface IndicatorLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

interface WindowsCuaOperationIndicatorOptions {
  platform?: NodeJS.Platform;
  logger: IndicatorLogger;
  createWindow?: (options: BrowserWindowConstructorOptions) => WindowsCuaOperationIndicatorWindow;
  getCursorScreenPoint?: () => Point;
  getDisplayNearestPoint?: (point: Point) => Pick<Display, "workArea">;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createWindowsCuaOperationIndicator(
  options: WindowsCuaOperationIndicatorOptions,
): WindowsCuaOperationIndicator {
  const platform = options.platform ?? process.platform;
  const createWindow =
    options.createWindow ??
    ((windowOptions: BrowserWindowConstructorOptions) =>
      new BrowserWindow(windowOptions) as WindowsCuaOperationIndicatorWindow);
  const getCursorScreenPoint =
    options.getCursorScreenPoint ?? (() => screen.getCursorScreenPoint());
  const getDisplayNearestPoint =
    options.getDisplayNearestPoint ?? ((point: Point) => screen.getDisplayNearestPoint(point));
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer));

  const activeTurnKeysBySource = new Map<object, Set<string>>();
  const ownedWindows = new WeakSet<object>();
  const failedWindows = new WeakSet<object>();
  let window: WindowsCuaOperationIndicatorWindow | null = null;
  let windowReady = false;
  let windowShown = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const autoHideTimersBySource = new Map<object, Map<string, ReturnType<typeof setTimeout>>>();
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let setupRetryAvailable = false;
  let disposed = false;

  function hasActiveTurns(): boolean {
    for (const keys of activeTurnKeysBySource.values()) {
      if (keys.size > 0) return true;
    }
    return false;
  }

  function keyFor(event: HostCuaOperationStateResponse): string {
    const workspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
    return `${workspaceKey}\0${event.sessionId}\0${event.turnId}`;
  }

  function setDocumentState(nextState: "active" | "leaving"): void {
    if (!window || window.isDestroyed()) return;
    void window.webContents
      .executeJavaScript(`document.documentElement.dataset.state=${JSON.stringify(nextState)}`)
      .catch((error) =>
        options.logger.debug("[cua-operation-indicator] state update failed", error),
      );
  }

  function cancelPendingHide(): void {
    if (!hideTimer) return;
    cancelSchedule(hideTimer);
    hideTimer = null;
  }

  function cancelAutoHide(source: object, key: string): void {
    const timers = autoHideTimersBySource.get(source);
    const timer = timers?.get(key);
    if (!timer) return;
    cancelSchedule(timer);
    timers?.delete(key);
    if (timers?.size === 0) autoHideTimersBySource.delete(source);
  }

  function scheduleAutoHide(source: object, key: string): void {
    cancelAutoHide(source, key);
    const timers = autoHideTimersBySource.get(source) ?? new Map();
    autoHideTimersBySource.set(source, timers);
    let timer: ReturnType<typeof setTimeout>;
    timer = schedule(() => {
      const currentTimers = autoHideTimersBySource.get(source);
      if (currentTimers?.get(key) !== timer) return;
      currentTimers.delete(key);
      if (currentTimers.size === 0) autoHideTimersBySource.delete(source);

      const sourceKeys = activeTurnKeysBySource.get(source);
      if (!sourceKeys?.delete(key)) return;
      if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
      // Safety timers are fail-hidden bounds: even if the runtime does not reissue inactive, it cannot
      // The native floating layer is visible indefinitely; subsequent CUA tool-started will re-establish the key and re-time.
      if (!hasActiveTurns()) beginHide();
    }, AUTO_HIDE_MS);
    timers.set(key, timer);
  }

  function scheduleSetupRetry(): void {
    if (!setupRetryAvailable || !hasActiveTurns() || reconcileTimer) return;
    setupRetryAvailable = false;
    reconcileTimer = schedule(() => {
      reconcileTimer = null;
      ensureWindow();
    }, CREATE_RETRY_MS);
  }

  function discardFailedWindow(target: WindowsCuaOperationIndicatorWindow): void {
    failedWindows.add(target);
    if (window === target) {
      window = null;
      windowReady = false;
      windowShown = false;
    }
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (destroyError) {
      options.logger.debug(
        "[cua-operation-indicator] failed to discard partial window",
        destroyError,
      );
    }
  }

  function positionWindow(target: WindowsCuaOperationIndicatorWindow): void {
    const { width, height } = indicatorWindowSize();
    const point = getCursorScreenPoint();
    const { workArea } = getDisplayNearestPoint(point);
    target.setBounds({
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + INDICATOR_CARD_TOP_OFFSET - INDICATOR_SHADOW_INSET.top),
    });
  }

  function handleLoadFailure(target: WindowsCuaOperationIndicatorWindow, error: unknown): void {
    options.logger.warn("[cua-operation-indicator] failed to load window content", error);
    if (disposed || target !== window) return;
    discardFailedWindow(target);
    scheduleSetupRetry();
  }

  function showWindowOnTop(target: WindowsCuaOperationIndicatorWindow): void {
    target.showInactive();
    // Windows may clear WS_EX_TOPMOST after hiding a transparent window; showInactive only restores visibility,
    // The native Z-order is not restored, so the hierarchy must be re-declared and moved to the front after each display.
    target.setAlwaysOnTop(true, "screen-saver");
    target.moveTop();
  }

  function loadContent(target: WindowsCuaOperationIndicatorWindow): void {
    try {
      positionWindow(target);
      void target
        .loadURL(indicatorDataUrl())
        .then(() => {
          if (disposed || target !== window || target.isDestroyed()) return;
          windowReady = true;
          setupRetryAvailable = false;
          if (!hasActiveTurns()) {
            // There may be no active turns when content loading is complete (all between window creation and loadURL completion),
            // The exit state must be restored explicitly to avoid false prompts exposed by subsequent erroneous show().
            setDocumentState("leaving");
            return;
          }
          positionWindow(target);
          showWindowOnTop(target);
          windowShown = true;
          setDocumentState("active");
        })
        .catch((error) => handleLoadFailure(target, error));
    } catch (error) {
      handleLoadFailure(target, error);
    }
  }

  function ensureWindow(repositionExisting = false): void {
    if (disposed || platform !== "win32" || !hasActiveTurns()) return;
    cancelPendingHide();
    if (window && !window.isDestroyed()) {
      if (repositionExisting) positionWindow(window);
      setDocumentState("active");
      // Root cause: Exiting only hides but does not destroy the window; the loaded window must be redisplayed during subsequent turn reuse.
      if (windowReady && !windowShown) {
        showWindowOnTop(window);
        windowShown = true;
      }
      if (windowReady) setupRetryAvailable = false;
      return;
    }

    let created: WindowsCuaOperationIndicatorWindow | null = null;
    try {
      const { width, height } = indicatorWindowSize();
      created = createWindow({
        width,
        height,
        alwaysOnTop: true,
        focusable: false,
        frame: false,
        // The old window only leaves a 1px transparent edge for CSS shadow, and overlays the default DWM rectangular shadow.
        // Causes the rounded shadow to be clipped to hard edges and gray bands; the shadow is exclusive to CSS after expanding the transparent canvas.
        hasShadow: false,
        resizable: false,
        show: false,
        skipTaskbar: true,
        transparent: true,
        backgroundColor: "#00000000",
        autoHideMenuBar: true,
        fullscreenable: false,
        maximizable: false,
        minimizable: false,
        movable: false,
        webPreferences: {
          contextIsolation: true,
          devTools: false,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window = created;
      windowReady = false;
      windowShown = false;
      ownedWindows.add(created);
      created.setIgnoreMouseEvents(true);
      created.setContentProtection(true);
      created.on("closed", () => {
        const failedDuringSetup = failedWindows.delete(created as object);
        if (window === created) {
          window = null;
          windowReady = false;
          windowShown = false;
        }
        if (failedDuringSetup || disposed || !hasActiveTurns() || reconcileTimer) return;
        // Reason: When the system unexpectedly closes the window, the Host's turn is still active and must be actively rebuilt without waiting for the next status.
        setupRetryAvailable = true;
        reconcileTimer = schedule(() => {
          reconcileTimer = null;
          ensureWindow();
        }, 0);
      });
      loadContent(created);
    } catch (error) {
      options.logger.warn("[cua-operation-indicator] failed to create secure window", error);
      if (created) discardFailedWindow(created);
      scheduleSetupRetry();
    }
  }

  function hideOrDestroy(target: WindowsCuaOperationIndicatorWindow): void {
    try {
      target.hide();
      windowShown = false;
      return;
    } catch (error) {
      // Closing is the bottom line of safety for this floating layer: it is claiming that "ZCode is operating the computer", and hiding failure is tantamount to exposing the user to
      // Lie. When hide() throws an error, it downgrades to destroying the window - the next CUA cell will be rebuilt by ensureWindow.
      options.logger.warn("[cua-operation-indicator] hide failed, destroying window", error);
    }
    if (window === target) {
      window = null;
      windowReady = false;
    }
    windowShown = false;
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (destroyError) {
      options.logger.warn(
        "[cua-operation-indicator] destroy after failed hide failed",
        destroyError,
      );
    }
  }

  function beginHide(): void {
    setupRetryAvailable = false;
    if (!window || window.isDestroyed() || hideTimer) return;
    setDocumentState("leaving");
    const target = window;
    hideTimer = schedule(() => {
      hideTimer = null;
      if (!disposed && !hasActiveTurns() && target === window && !target.isDestroyed()) {
        hideOrDestroy(target);
      }
    }, HIDE_ANIMATION_MS);
  }

  function handleState(source: object, event: HostCuaOperationStateResponse): void {
    if (disposed || platform !== "win32") return;
    const key = keyFor(event);
    const sourceKeys = activeTurnKeysBySource.get(source);
    if (event.active) {
      if (sourceKeys?.has(key)) {
        cancelPendingHide();
        scheduleAutoHide(source, key);
        ensureWindow();
        return;
      }
      const wasActive = hasActiveTurns();
      if (!wasActive) setupRetryAvailable = true;
      const nextKeys = sourceKeys ?? new Set<string>();
      nextKeys.add(key);
      activeTurnKeysBySource.set(source, nextKeys);
      scheduleAutoHide(source, key);
      // Only when the aggregate changes from empty to non-empty is it relocated according to the current mouse monitor to avoid parallel sources making the window jump.
      ensureWindow(!wasActive);
      return;
    }
    if (!sourceKeys?.delete(key)) return;
    cancelAutoHide(source, key);
    if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
    if (!hasActiveTurns()) beginHide();
  }

  function clearSource(source: object): void {
    if (disposed || platform !== "win32" || !activeTurnKeysBySource.delete(source)) return;
    const timers = autoHideTimersBySource.get(source);
    for (const key of timers ? [...timers.keys()] : []) {
      cancelAutoHide(source, key);
    }
    if (!hasActiveTurns()) beginHide();
  }

  function ownsWindow(candidate: object): boolean {
    return ownedWindows.has(candidate);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    setupRetryAvailable = false;
    activeTurnKeysBySource.clear();
    for (const [source, timers] of autoHideTimersBySource) {
      for (const timer of timers.values()) cancelSchedule(timer);
      autoHideTimersBySource.delete(source);
    }
    cancelPendingHide();
    if (reconcileTimer) {
      cancelSchedule(reconcileTimer);
      reconcileTimer = null;
    }
    const target = window;
    window = null;
    windowReady = false;
    windowShown = false;
    if (target && !target.isDestroyed()) target.destroy();
  }

  return { handleState, clearSource, ownsWindow, dispose };
}
