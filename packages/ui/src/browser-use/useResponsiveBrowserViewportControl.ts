import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserViewportSize,
  BrowserViewportZoom,
  EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { DEFAULT_BROWSER_VIEWPORT_ZOOM } from "@/browser-use/browserViewportZoom.js";
import { DEFAULT_RESPONSIVE_BROWSER_VIEWPORT_SIZE } from "@/browser-use/ResponsiveBrowserViewport.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

export type HumanBrowserViewportPreferenceChangeSource = "mode" | "viewport" | "zoom";

export function useResponsiveBrowserViewportControl({
  browserKey,
  desktopZoomFactor,
  onAgentViewportChange,
  onViewportSynchronized,
  onViewportResize,
  initialHumanViewportPreference,
  onHumanViewportPreferenceChange,
  sessionId,
}: {
  browserKey: string;
  desktopZoomFactor: number;
  onAgentViewportChange: (willChangeResponsiveMode: boolean) => void;
  onViewportSynchronized: () => void;
  onViewportResize: () => void;
  initialHumanViewportPreference?: EmbeddedBrowserViewportPreference;
  onHumanViewportPreferenceChange?: (
    preference: EmbeddedBrowserViewportPreference,
    source: HumanBrowserViewportPreferenceChangeSource,
  ) => void;
  sessionId?: string;
}) {
  const platform = usePlatform();
  const initialResponsiveMode = initialHumanViewportPreference?.mode === "responsive";
  const initialResponsiveViewportSize =
    initialHumanViewportPreference?.viewport ?? DEFAULT_RESPONSIVE_BROWSER_VIEWPORT_SIZE;
  const initialResponsiveViewportZoom =
    initialHumanViewportPreference?.zoom ?? DEFAULT_BROWSER_VIEWPORT_ZOOM;
  const [isResponsiveMode, setIsResponsiveMode] = useState(initialResponsiveMode);
  const [responsiveViewportSize, setResponsiveViewportSize] = useState<BrowserViewportSize>({
    ...initialResponsiveViewportSize,
  });
  const [responsiveViewportZoom, setResponsiveViewportZoom] = useState<BrowserViewportZoom>(
    initialResponsiveViewportZoom,
  );
  const isResponsiveModeRef = useRef(initialResponsiveMode);
  const responsiveViewportSizeRef = useRef<BrowserViewportSize>({
    ...initialResponsiveViewportSize,
  });
  const responsiveViewportZoomRef = useRef<BrowserViewportZoom>(initialResponsiveViewportZoom);
  const didSynchronizeInitialHumanViewportRef = useRef(false);
  const lastDesktopZoomFactorRef = useRef(desktopZoomFactor);
  const wasResponsiveModeForZoomRef = useRef(initialResponsiveMode);

  const reportHumanViewportPreference = useCallback(
    (source: HumanBrowserViewportPreferenceChangeSource) => {
      if (!initialHumanViewportPreference || !onHumanViewportPreferenceChange) return;
      onHumanViewportPreferenceChange(
        {
          mode: isResponsiveModeRef.current ? "responsive" : "normal",
          viewport: { ...responsiveViewportSizeRef.current },
          zoom: responsiveViewportZoomRef.current,
        },
        source,
      );
    },
    [initialHumanViewportPreference, onHumanViewportPreferenceChange],
  );

  const applyResponsiveMode = useCallback((nextMode: boolean) => {
    // The viewport event is also used for in-modal size synchronization; it is only reset when false → true to avoid overwriting the fixed zoom the user just selected.
    if (nextMode && !isResponsiveModeRef.current) {
      responsiveViewportZoomRef.current = DEFAULT_BROWSER_VIEWPORT_ZOOM;
      setResponsiveViewportZoom(DEFAULT_BROWSER_VIEWPORT_ZOOM);
    }
    isResponsiveModeRef.current = nextMode;
    setIsResponsiveMode(nextMode);
  }, []);

  const updateControlledViewport = useCallback(
    (viewport: BrowserViewportSize | null) => {
      const request = platform.browserViewUpdateViewport?.({ tabId: browserKey, viewport });
      if (!request) return;
      void request
        .then(() => {
          // After the metrics serialization in main is completed, guest zoom is fixed back to 1. If in advance
          // Set in React effect, the asynchronous propagation of Desktop page zoom will change the guest back to global zoom.
          if (viewport) onViewportSynchronized();
        })
        .catch((error) => {
          logger.debug("[browser-use] failed to sync tab viewport", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [browserKey, onViewportSynchronized, platform],
  );

  useEffect(() => {
    const wasResponsiveMode = wasResponsiveModeForZoomRef.current;
    const zoomChanged = lastDesktopZoomFactorRef.current !== desktopZoomFactor;
    wasResponsiveModeForZoomRef.current = isResponsiveMode;
    lastDesktopZoomFactorRef.current = desktopZoomFactor;
    if (!isResponsiveMode || !wasResponsiveMode || !zoomChanged) return;
    // After Electron enlarges the Desktop page, the guest native raster still presses the original value before zooming.
    // backing size output. Zoom resends the same viewport every time it changes, allowing main to be trusted from
    // BrowserWindow reads the current zoom factor and replays metrics; does not write zoom to the Agent viewport state.
    updateControlledViewport(responsiveViewportSize);
  }, [desktopZoomFactor, isResponsiveMode, responsiveViewportSize, updateControlledViewport]);

  useEffect(() => {
    return platform.onBrowserViewViewportChanged?.((payload) => {
      if (payload.tabId !== browserKey) return;
      if (sessionId && payload.sessionId !== sessionId) return;
      const willChangeResponsiveMode = (payload.viewport !== null) !== isResponsiveModeRef.current;
      onAgentViewportChange(willChangeResponsiveMode);
      logger.debug("[browser-use] model viewport change does not trigger resize nudge", {
        modeChanged: willChangeResponsiveMode,
        tabId: browserKey,
        viewport: payload.viewport,
      });
      if (payload.viewport) {
        responsiveViewportSizeRef.current = { ...payload.viewport };
        setResponsiveViewportSize({ ...payload.viewport });
        applyResponsiveMode(true);
        // Agent creates/sets the main path of viewport without going through renderer IPC; only in the current window
        // When it is in the zoom position, it is sent back once to let main fill in the trusted zoom factor. Default/minify does not require echo.
        if (desktopZoomFactor > 1) updateControlledViewport(payload.viewport);
        return;
      }
      applyResponsiveMode(false);
    });
  }, [
    applyResponsiveMode,
    browserKey,
    desktopZoomFactor,
    onAgentViewportChange,
    platform,
    sessionId,
    updateControlledViewport,
  ]);

  const toggleResponsiveMode = useCallback(() => {
    onViewportResize();
    const nextMode = !isResponsiveModeRef.current;
    applyResponsiveMode(nextMode);
    updateControlledViewport(nextMode ? responsiveViewportSize : null);
    reportHumanViewportPreference("mode");
  }, [
    applyResponsiveMode,
    onViewportResize,
    reportHumanViewportPreference,
    responsiveViewportSize,
    updateControlledViewport,
  ]);

  const updateResponsiveViewportSize = useCallback(
    (viewportSize: BrowserViewportSize) => {
      responsiveViewportSizeRef.current = { ...viewportSize };
      setResponsiveViewportSize(viewportSize);
      updateControlledViewport(viewportSize);
      reportHumanViewportPreference("viewport");
    },
    [reportHumanViewportPreference, updateControlledViewport],
  );

  const updateResponsiveViewportZoom = useCallback(
    (zoom: BrowserViewportZoom) => {
      responsiveViewportZoomRef.current = zoom;
      setResponsiveViewportZoom(zoom);
      reportHumanViewportPreference("zoom");
    },
    [reportHumanViewportPreference],
  );

  const synchronizeInitialHumanViewport = useCallback(() => {
    if (
      !initialHumanViewportPreference ||
      initialHumanViewportPreference.mode !== "responsive" ||
      didSynchronizeInitialHumanViewportRef.current
    ) {
      return;
    }
    didSynchronizeInitialHumanViewportRef.current = true;
    updateControlledViewport(responsiveViewportSizeRef.current);
  }, [initialHumanViewportPreference, updateControlledViewport]);

  return {
    isResponsiveMode,
    responsiveViewportSize,
    responsiveViewportZoom,
    setResponsiveViewportZoom: updateResponsiveViewportZoom,
    synchronizeInitialHumanViewport,
    toggleResponsiveMode,
    updateResponsiveViewportSize,
  };
}
