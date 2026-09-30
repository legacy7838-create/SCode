import { nativeTheme, type BrowserWindow, type Point } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { resolveDesktopZoomFactorForLevel } from "./desktopZoom.js";

export const MACOS_TRAFFIC_LIGHT_BASE_POSITION = { x: 22, y: 23 } as const;
const MACOS_TRAFFIC_LIGHT_BASE_LEFT_PADDING_PX = 96;
const MACOS_TRAFFIC_LIGHT_POSITION_MOVEMENT_GAIN = 1.5;
export const WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX = 136;
export const WINDOWS_TITLE_BAR_HEIGHT_PX = 48;
const MACOS_TRAFFIC_LIGHT_MIN_POSITION_PX = 4;
const customWindowsControls = new WeakSet<BrowserWindow>();

export function registerCustomWindowsControls(window: BrowserWindow) {
  customWindowsControls.add(window);
}

export function hasCustomWindowsControls(window: BrowserWindow) {
  return customWindowsControls.has(window);
}

function resolveMacOSWindowButtonPositionForZoomLevel(zoomLevel: number): Point {
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const resolveVerticalPosition = (base: number) =>
    Math.max(
      MACOS_TRAFFIC_LIGHT_MIN_POSITION_PX,
      Math.round(base + (base * zoomFactor - base) * MACOS_TRAFFIC_LIGHT_POSITION_MOVEMENT_GAIN),
    );
  return {
    x: MACOS_TRAFFIC_LIGHT_BASE_POSITION.x,
    y: resolveVerticalPosition(MACOS_TRAFFIC_LIGHT_BASE_POSITION.y),
  };
}

function resolveMacOSWindowControlsOverlayMetricsForZoomLevel(zoomLevel: number) {
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const buttonPosition = resolveMacOSWindowButtonPositionForZoomLevel(zoomLevel);
  return {
    buttonPosition,
    metrics: {
      leftPaddingPx: Math.round(MACOS_TRAFFIC_LIGHT_BASE_LEFT_PADDING_PX / zoomFactor),
    },
  };
}

function resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel: number) {
  return Math.round(WINDOWS_TITLE_BAR_HEIGHT_PX * resolveDesktopZoomFactorForLevel(zoomLevel));
}

function resolveWindowsWindowControlsOverlayMetricsForZoomLevel(zoomLevel: number) {
  return {
    // The native button width does not scale with the page; fixed CSS margins only apply to the self-drawn window control branch below.
    rightPaddingPx: Math.round(
      WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX / resolveDesktopZoomFactorForLevel(zoomLevel),
    ),
    titleBarHeightPx: resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel),
  };
}

export function buildWindowsTitleBarOverlayForZoomLevel(
  zoomLevel: number,
  theme: "light" | "dark",
) {
  return {
    color: "#00000000",
    symbolColor: theme === "dark" ? "#f5f5f5" : "#1f1f1f",
    height: resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel),
  };
}

export function syncWindowControlsOverlayForZoomLevel(
  targetWindow: BrowserWindow | null | undefined,
  zoomLevel: number,
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (process.platform === "darwin") {
    const { buttonPosition, metrics } =
      resolveMacOSWindowControlsOverlayMetricsForZoomLevel(zoomLevel);
    // Page scaling changes the visual size of the renderer's top bar, but macOS native traffic lights do not scale with the page.
    // After each zoom, adjust the vertical position of the native button according to the same zoom factor; the horizontal position first maintains the system's initial value to avoid repeated compensation with the fixed-width safe area.
    // The width of the traffic light itself does not change with the zoom of the page, so the CSS padding of the renderer must be compensated inversely according to the zoom factor.
    targetWindow.setWindowButtonPosition(buttonPosition);
    targetWindow.webContents.send(PlatformChannels.WindowControlsOverlayChanged, metrics);
    return;
  }

  if (process.platform === "win32") {
    if (hasCustomWindowsControls(targetWindow)) {
      // Self-drawn buttons scale with the page, and the safe area also uses fixed CSS pixels, which can no longer compensate for the native button width in reverse.
      targetWindow.webContents.send(PlatformChannels.WindowControlsOverlayChanged, {
        rightPaddingPx: WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX,
      });
      return;
    }
    // The native window control of Windows titleBarOverlay will not automatically synchronize with the renderer page zoom.
    // Synchronizing only the height will make the vertical size of the upper right corner button and the title bar consistent, but the fixed 136px safe area will be enlarged by the page zoom.
    // As a result, the left button group and the right window control are pulled further and further apart; if the height is still clamped by the baseline when zooming out, the window control will also stop changing in advance.
    // Here, overlay.height is synchronized at the same time, and the right safety area of ​​the renderer is reversely compensated by zoomFactor, so that the layout on both sides can continue to scale at the same frequency.
    targetWindow.setTitleBarOverlay(
      buildWindowsTitleBarOverlayForZoomLevel(
        zoomLevel,
        nativeTheme.shouldUseDarkColors ? "dark" : "light",
      ),
    );
    targetWindow.webContents.send(
      PlatformChannels.WindowControlsOverlayChanged,
      resolveWindowsWindowControlsOverlayMetricsForZoomLevel(zoomLevel),
    );
  }
}
