import { useEffect, useState } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";

const DESKTOP_ZOOM_FACTOR_STEP = 1.1;
const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;

function resolveDesktopZoomFactor(zoomLevel: number): number {
  if (!Number.isFinite(zoomLevel)) return 1;
  const clampedLevel = Math.min(
    DESKTOP_ZOOM_MAX_LEVEL,
    Math.max(DESKTOP_ZOOM_MIN_LEVEL, Math.round(zoomLevel)),
  );
  return Math.pow(DESKTOP_ZOOM_FACTOR_STEP, clampedLevel);
}

/**
 * Reads the Electron page zoom of the current window; the web wiring returns level 0, so it falls
 * back to factor 1 naturally. This reuses IPlatformService to keep the shared UI from reaching into
 * window.zcode directly.
 */
export function useDesktopZoomFactor(): number {
  const platform = usePlatform();
  const [zoomLevel, setZoomLevel] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const applyZoomLevel = (nextZoomLevel: number) => {
      if (!cancelled && Number.isFinite(nextZoomLevel)) {
        setZoomLevel(nextZoomLevel);
      }
    };

    void platform.getDesktopZoomLevel?.().then((state) => applyZoomLevel(state.zoomLevel));
    const dispose = platform.onDesktopZoomLevelChanged?.((state) => {
      applyZoomLevel(state.zoomLevel);
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [platform]);

  return resolveDesktopZoomFactor(zoomLevel);
}
