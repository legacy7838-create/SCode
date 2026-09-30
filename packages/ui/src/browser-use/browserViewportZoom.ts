import {
  BROWSER_VIEWPORT_ZOOM_OPTIONS,
  DEFAULT_BROWSER_VIEWPORT_ZOOM,
  type BrowserViewportSize,
  type BrowserViewportZoom,
} from "@zcode/shared";

export { BROWSER_VIEWPORT_ZOOM_OPTIONS, DEFAULT_BROWSER_VIEWPORT_ZOOM };
export type { BrowserViewportZoom };

/** Fit's canvas padding is consistent with ResponsiveBrowserViewport's `p-4`. */
const RESPONSIVE_BROWSER_CANVAS_PADDING_PX = 16;

export function resolveBrowserViewportScale({
  canvasSize,
  desktopZoomFactor = 1,
  viewportSize,
  zoom,
}: {
  canvasSize: BrowserViewportSize | null;
  desktopZoomFactor?: number;
  viewportSize: BrowserViewportSize;
  zoom: BrowserViewportZoom;
}): number {
  if (zoom !== "fit") {
    return Number(zoom) / 100;
  }
  if (!canvasSize || canvasSize.width <= 0 || canvasSize.height <= 0) {
    return 1;
  }

  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;
  // ResizeObserver returns the scaled CSS size of the parent renderer page; convert it to the screen visual size and then parse Fit.
  // This will prevent application global zoom from being mistaken for browser preview zoom.
  const availableWidth =
    Math.max(0, canvasSize.width - RESPONSIVE_BROWSER_CANVAS_PADDING_PX * 2) *
    safeDesktopZoomFactor;
  const availableHeight =
    Math.max(0, canvasSize.height - RESPONSIVE_BROWSER_CANVAS_PADDING_PX * 2) *
    safeDesktopZoomFactor;
  if (availableWidth === 0 || availableHeight === 0) {
    return 1;
  }

  return Math.min(1, availableWidth / viewportSize.width, availableHeight / viewportSize.height);
}

export function resolveBrowserViewportRendererScale({
  desktopZoomFactor,
  visualScale,
}: {
  desktopZoomFactor: number;
  visualScale: number;
}): number {
  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;
  return visualScale / safeDesktopZoomFactor;
}

export function resolveResponsiveBrowserGuestLayout(desktopZoomFactor: number): {
  layoutScale: number;
  transformScale: number;
} {
  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;

  if (safeDesktopZoomFactor > 1) {
    // When Desktop page zoom is enlarged, the outer transform will only expand the webview DOM.
    // The guest native raster still only has 1/zoom of the frame, thus producing right/bottom white space.
    // Amplification compensation has been scaled down to main's CDP metrics scale, and the renderer must maintain true 100% bounds.
    return { layoutScale: 1, transformScale: 1 };
  }

  if (safeDesktopZoomFactor < 1) {
    // If only the surface is zoomed out, the surface will be left blank; first expand the layout in reverse, and then retract the frame.
    // While preserving full page content and correct guest coordinate mapping.
    return {
      layoutScale: 1 / safeDesktopZoomFactor,
      transformScale: safeDesktopZoomFactor,
    };
  }

  return { layoutScale: 1, transformScale: 1 };
}
