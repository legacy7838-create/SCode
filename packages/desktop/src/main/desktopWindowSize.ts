import type { BrowserWindow, Rectangle } from "electron";
import type { AppSettings } from "@zcode/shared";

export const DEFAULT_DESKTOP_WINDOW_WIDTH = 1200;
export const DEFAULT_DESKTOP_WINDOW_HEIGHT = 800;
export const MIN_DESKTOP_WINDOW_WIDTH = 480;
export const MIN_DESKTOP_WINDOW_HEIGHT = 640;
const WINDOW_SIZE_PERSIST_DEBOUNCE_MS = 250;

export type DesktopWindowSize = NonNullable<AppSettings["desktopWindowSize"]>;

function clampDimension(value: number, minimum: number, available: number): number {
  const maximum = Math.max(minimum, Math.floor(available));
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

export function resolveDesktopWindowSize(
  persisted: DesktopWindowSize | undefined,
  workAreaSize: Pick<Rectangle, "width" | "height">,
): DesktopWindowSize {
  const width = persisted?.width ?? DEFAULT_DESKTOP_WINDOW_WIDTH;
  const height = persisted?.height ?? DEFAULT_DESKTOP_WINDOW_HEIGHT;

  return {
    width: clampDimension(width, MIN_DESKTOP_WINDOW_WIDTH, workAreaSize.width),
    height: clampDimension(height, MIN_DESKTOP_WINDOW_HEIGHT, workAreaSize.height),
    maximized: persisted?.maximized ?? false,
  };
}

type WindowSizePersistenceTarget = Pick<
  BrowserWindow,
  "getNormalBounds" | "isDestroyed" | "isMaximized" | "on"
>;

export function attachDesktopWindowSizePersistence(
  win: WindowSizePersistenceTarget,
  save: (state: DesktopWindowSize) => Promise<void>,
  onSaveError: (error: unknown) => void = () => undefined,
): void {
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  const persistCurrentState = (): void => {
    if (win.isDestroyed()) return;

    // The current bounds of the maximized window are equal to the monitor workspace, and direct persistence will overwrite the user's last
    // Manually adjusted normal window size. Always read normal bounds and save maximized as a separate state.
    const bounds = win.getNormalBounds();
    const state: DesktopWindowSize = {
      width: Math.max(MIN_DESKTOP_WINDOW_WIDTH, Math.floor(bounds.width)),
      height: Math.max(MIN_DESKTOP_WINDOW_HEIGHT, Math.floor(bounds.height)),
      maximized: win.isMaximized(),
    };
    void save(state).catch(onSaveError);
  };

  const clearResizeTimer = () => {
    if (resizeTimer === null) return;
    clearTimeout(resizeTimer);
    resizeTimer = null;
  };
  const persistImmediately = (): void => {
    clearResizeTimer();
    persistCurrentState();
  };

  win.on("resize", () => {
    // resize will be triggered frequently with dragging in Linux and some Windows window managers; only the stable size will be saved.
    // Avoid piling writes of the same magnitude as rendered frames into the setting.json atomic write queue.
    clearResizeTimer();
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      void persistCurrentState();
    }, WINDOW_SIZE_PERSIST_DEBOUNCE_MS);
  });
  win.on("maximize", () => void persistImmediately());
  win.on("unmaximize", () => void persistImmediately());
  // After the exit barrier ends, Electron will trigger close again; if asynchronous setting writing is started here,
  // A subsequent app.exit may terminate Main before releaseLock completes, leaving setting.json.lock behind.
  // close only cancels the resize anti-shake that has not yet been triggered, and does not start new setting writing.
  win.on("close", clearResizeTimer);
}
