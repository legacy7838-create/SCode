/**
 * Lifecycle management for the CUA permission drag panel.
 *
 * This window has four non-negotiable properties, all established by measurement:
 *
 * 1. **It must not activate the app that owns it** (`type: "panel"` + `focusable: false` — neither
 *    is optional). It floats above "System Settings" and the user drags between it and the
 *    settings page. With only `focusable` set, clicking it still activates ZCode.app, focus jumps
 *    to the main window, and the onboarding flow breaks on the spot — see the comment on
 *    `createRealCuaPermissionPanelWindow`.
 * 2. **It must stay above System Settings** (`alwaysOnTop(true, "screen-saver")`). A plain
 *    `floating` level gets covered whenever the settings page is active.
 * 3. **It stops tracking its position once the drag lands** (`freezePosition()`). System Settings
 *    then raises a modal alert; continued tracking makes the panel chase that alert and get pushed
 *    underneath it.
 * 4. **Every terminal state must destroy it.** The PiP panel once lingered for no reason because
 *    it had no explicit start/stop boundary; here show/hide/destroy are three explicit states, and
 *    destroy is idempotent and stops the position data source.
 *
 * The real BrowserWindow is injected through `createWindow`, so the lifecycle and positioning
 * logic can be unit-tested without Electron.
 */

import type { CuaPermissionKind, Locale } from "@zcode/shared";
import { resolvePanelBounds, type PanelSize, type Rect } from "./cuaPermissionPanelPositioner.js";

/** The minimum window capability required for a floating window makes it easy to implement test stand-ins. */
interface CuaPermissionPanelWindow {
  onceReadyToShow(callback: () => void): void;
  setBounds(bounds: Rect): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

interface CreateCuaPermissionDragPanelOptions {
  createWindow: (initialBounds: Rect) => CuaPermissionPanelWindow;
  getDisplayWorkArea: () => Rect;
  /** The system sets the window bounds data source; fail-open to the bottom of the screen when missing or throwing an error. */
  getSettingsBounds?: () => Rect | null;
  /** Release the above data source (usually kill the resident child process). */
  stopSettingsBounds?: () => void;
  /** The application icon (data URL) displayed by the floating window tile. By default, the page falls back to the built-in placeholder graphics. */
  getIconDataUrl?: () => string | null;
  /** ZCode current interface language. Each show is re-read, preventing the floating window from guessing the system language by itself. */
  getLocale: () => Locale;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  panelSize?: PanelSize;
  repositionIntervalMs?: number;
}

export interface CuaPermissionDragPanel {
  show(permission: CuaPermissionKind): void;
  /**
   * Stops position tracking while keeping the window visible and draggable.
   *
   * After the drag lands, System Settings raises a modal alert ("…may not be able to record…").
   * Continuing to track makes the panel chase that alert and wedge itself underneath it. Once the
   * user has dragged, the position should stay put — their attention is on System Settings now, so
   * any further panel movement is just interference. Tracking resumes automatically on the next
   * permission stage's `show()`.
   */
  freezePosition(): void;
  hide(): void;
  destroy(): void;
}

export const CUA_PERMISSION_PANEL_STATE_CHANNEL = "zcode:cua-permission-panel-state";

const DEFAULT_PANEL_SIZE: PanelSize = { width: 560, height: 124 };
// Use a 0.15 second tracking interval to balance position synchronization overhead with panel responsiveness when setting page drags.
const DEFAULT_REPOSITION_INTERVAL_MS = 150;

export function createCuaPermissionDragPanel(
  options: CreateCuaPermissionDragPanelOptions,
): CuaPermissionDragPanel {
  const panelSize = options.panelSize ?? DEFAULT_PANEL_SIZE;
  const intervalMs = options.repositionIntervalMs ?? DEFAULT_REPOSITION_INTERVAL_MS;

  let window: CuaPermissionPanelWindow | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastBounds: Rect | null = null;
  let destroyed = false;

  function readSettingsBounds(): Rect | null {
    if (!options.getSettingsBounds) return null;
    try {
      return options.getSettingsBounds();
    } catch (error) {
      // fail-open: Adsorption only enhances the look and feel. Problems with the data source must not cause the authorization guide to fail.
      options.logger.warn(
        "[cua-permission-panel] settings bounds source failed; falling back to screen bottom",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  function sameRect(a: Rect | null, b: Rect): boolean {
    return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  function reposition(): void {
    if (!window || window.isDestroyed()) return;
    const bounds = resolvePanelBounds({
      settings: readSettingsBounds(),
      display: options.getDisplayWorkArea(),
      panel: panelSize,
    });
    // SetBounds every tick will cause visible jitter, moving only when the target rectangle actually changes.
    if (sameRect(lastBounds, bounds)) return;
    lastBounds = bounds;
    window.setBounds(bounds);
  }

  function startTracking(): void {
    if (timer) return;
    timer = setInterval(reposition, intervalMs);
    // Location tracking should never prevent a process from exiting.
    timer.unref?.();
  }

  function stopTracking(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    show(permission: CuaPermissionKind): void {
      if (destroyed) destroyed = false;
      const initialBounds = resolvePanelBounds({
        settings: readSettingsBounds(),
        display: options.getDisplayWorkArea(),
        panel: panelSize,
      });
      lastBounds = initialBounds;

      if (!window || window.isDestroyed()) {
        window = options.createWindow(initialBounds);
        window.onceReadyToShow(() => {
          if (!window || window.isDestroyed()) return;
          window.setBounds(lastBounds ?? initialBounds);
          // The floating window is an independent static renderer, not in the main React Intl tree; if the locale is not passed
          // The English ZCode will also display hardcoded Chinese. Send the current locale first and then display it to avoid Chinese fallback splash screen.
          window.send(CUA_PERMISSION_PANEL_STATE_CHANNEL, {
            permission,
            locale: options.getLocale(),
            iconDataUrl: options.getIconDataUrl?.() ?? null,
          });
          window.showInactive();
          startTracking();
        });
        return;
      }

      window.setBounds(initialBounds);
      window.send(CUA_PERMISSION_PANEL_STATE_CHANNEL, {
        permission,
        locale: options.getLocale(),
        iconDataUrl: options.getIconDataUrl?.() ?? null,
      });
      window.showInactive();
      startTracking();
    },

    hide(): void {
      stopTracking();
      if (window && !window.isDestroyed()) window.hide();
    },

    freezePosition(): void {
      stopTracking();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopTracking();
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
      lastBounds = null;
      options.stopSettingsBounds?.();
    },
  };
}

/**
 * The real window factory used in production. The combination of properties is the smallest set
 * that works, established by measurement, with a reason for each:
 *   frame:false + transparent  —— the rounded floating-panel look
 *   type:"panel"               —— NSPanel + NSWindowStyleMaskNonactivatingPanel:
 *                                 clicking this window **does not activate the owning app**
 *   focusable:false            —— the window itself does not take focus
 *   skipTaskbar:true           —— stays out of the Dock / app switcher
 *   show:false + showInactive  —— shown without activating
 *   alwaysOnTop("screen-saver")—— stays above the System Settings window; the floating level
 *                                 gets covered
 *
 * `type` and `focusable` must be present **together** — that was the trap: the first version only
 * set focusable:false, and clicking the panel sent focus to the ZCode main window. Measured
 * results of a three-way comparison ——
 *   focusable:false alone          → the app is still activated, focus lands on the next
 *                                     focusable window of the same app (the main window)
 *   type:panel alone (focusable defaults to true) → the panel takes focus itself and activates
 *                                     the app, and System Settings is pushed back anyway
 *   both together                   → zero focus events after the click, System Settings stays
 *                                     frontmost ✓
 * In other words `focusable` governs "the window does not take focus" and `type:panel` governs
 * "the app is not activated"; missing either half breaks it.
 */
export function createRealCuaPermissionPanelWindow(deps: {
  BrowserWindow: typeof import("electron").BrowserWindow;
  app: Pick<typeof import("electron").app, "isPackaged">;
  preloadPath: string;
  rendererDir: string;
  rendererDevUrl?: string | undefined;
}): (initialBounds: Rect) => CuaPermissionPanelWindow {
  return (initialBounds: Rect) => {
    const win = new deps.BrowserWindow({
      ...initialBounds,
      // macOS: NSPanel with NSWindowStyleMaskNonactivatingPanel - see comments above,
      // This is a necessary condition for "clicking the floating window will not kick the system settings to the background".
      type: "panel",
      frame: false,
      transparent: true,
      hasShadow: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Consistent with the main window: Production packages always load rendering resources from signed packages.
    if (!deps.app.isPackaged && deps.rendererDevUrl) {
      void win.loadURL(`${deps.rendererDevUrl}/cua-permission-panel.html`);
    } else {
      void win.loadFile(`${deps.rendererDir}/cua-permission-panel.html`);
    }

    return {
      onceReadyToShow(callback: () => void) {
        win.once("ready-to-show", callback);
      },
      setBounds(bounds: Rect) {
        win.setBounds(bounds);
      },
      showInactive() {
        win.showInactive();
        win.setAlwaysOnTop(true, "screen-saver");
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      },
      hide() {
        win.hide();
      },
      destroy() {
        win.destroy();
      },
      isDestroyed: () => win.isDestroyed(),
      send(channel: string, payload: unknown) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      },
    };
  };
}
