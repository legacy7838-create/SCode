import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  TID_BROWSER_RESPONSIVE_SCALED_FRAME,
  TID_BROWSER_RESPONSIVE_VIEWPORT,
  type BrowserViewportSize,
} from "@zcode/shared";
import {
  resolveBrowserViewportRendererScale,
  resolveBrowserViewportScale,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import {
  RESPONSIVE_BROWSER_VIEWPORT_LIMITS,
  ResponsiveBrowserResizeHandles,
  type ResizeDirection,
  type ResizeHandleDirections,
} from "@/browser-use/ResponsiveBrowserResizeHandles.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export const DEFAULT_RESPONSIVE_BROWSER_VIEWPORT_SIZE = {
  width: 393,
  height: 852,
} as const;

interface ResizeDragState {
  captureTarget: HTMLDivElement;
  heightDirection: ResizeDirection;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSize: BrowserViewportSize;
  widthDirection: ResizeDirection;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampViewportSize(size: BrowserViewportSize): BrowserViewportSize {
  return {
    width: clamp(
      size.width,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.minWidth,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.maxWidth,
    ),
    height: clamp(
      size.height,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.minHeight,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.maxHeight,
    ),
  };
}

/**
 * Keep the same single layer of DOM wrapper and only switch the frame's CSS size, so toggling free
 * sizing does not rebuild the Electron guest. The size belongs only to the React instance of the
 * current Browser tab, and is never written to a cross-platform store or to persisted state.
 */
export function ResponsiveBrowserViewport({
  active,
  children,
  desktopZoomFactor,
  isComposed,
  onResize,
  onViewportSizeChange,
  viewportSize,
  zoom,
}: {
  active: boolean;
  children: ReactNode;
  desktopZoomFactor: number;
  isComposed: boolean;
  onResize?: () => void;
  onViewportSizeChange: (viewportSize: BrowserViewportSize) => void;
  viewportSize: BrowserViewportSize;
  zoom: BrowserViewportZoom;
}): React.JSX.Element {
  const { intl } = useZCodeIntl();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const viewportSizeRef = useRef<BrowserViewportSize>(viewportSize);
  const rendererScaleRef = useRef(1);
  const dragRef = useRef<ResizeDragState | null>(null);
  const pendingViewportSizeRef = useRef<BrowserViewportSize | null>(null);
  const resizeAnimationFrameRef = useRef(0);
  const [canvasSize, setCanvasSize] = useState<BrowserViewportSize | null>(null);
  const visualScale = active
    ? resolveBrowserViewportScale({ canvasSize, desktopZoomFactor, viewportSize, zoom })
    : 1;
  // Electron's application global zoom will continue to be multiplied by the CSS transform of the free-size frame.
  // Causes 100%/fixed scale and drag scaling to vary with the app. frame offsets the parent zoom using the reciprocal,
  // The guest CSS viewport is still controlled by width/height alone and does not write visual compensation back to Browser Use.
  const rendererScale = active
    ? resolveBrowserViewportRendererScale({ desktopZoomFactor, visualScale })
    : 1;
  rendererScaleRef.current = rendererScale;

  const applyViewportSize = useCallback(
    (requestedSize: BrowserViewportSize) => {
      const nextSize = clampViewportSize(requestedSize);
      const previousSize = viewportSizeRef.current;
      if (previousSize.width === nextSize.width && previousSize.height === nextSize.height) {
        return;
      }
      viewportSizeRef.current = nextSize;
      onViewportSizeChange(nextSize);
      onResize?.();
    },
    [onResize, onViewportSizeChange],
  );

  useEffect(() => {
    viewportSizeRef.current = viewportSize;
  }, [viewportSize]);

  const scheduleViewportSize = useCallback(
    (requestedSize: BrowserViewportSize) => {
      pendingViewportSizeRef.current = clampViewportSize(requestedSize);
      if (resizeAnimationFrameRef.current !== 0) return;
      // The pointermove frequency may be higher than the refresh rate; only the last set of dimensions is submitted each frame to avoid invalid React renders.
      resizeAnimationFrameRef.current = window.requestAnimationFrame(() => {
        resizeAnimationFrameRef.current = 0;
        const pendingSize = pendingViewportSizeRef.current;
        pendingViewportSizeRef.current = null;
        if (pendingSize) applyViewportSize(pendingSize);
      });
    },
    [applyViewportSize],
  );

  const finishResize = useCallback(
    (reason: string, pointerId?: number, commitPendingSize = true) => {
      const drag = dragRef.current;
      if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
      dragRef.current = null;
      if (resizeAnimationFrameRef.current !== 0) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
        resizeAnimationFrameRef.current = 0;
      }
      const pendingSize = pendingViewportSizeRef.current;
      pendingViewportSizeRef.current = null;
      if (pendingSize && commitPendingSize) applyViewportSize(pendingSize);
      try {
        if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
          drag.captureTarget.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // The capture may have been revoked by the system or browser; the status has been cleared first, and lostpointercapture will not continue to be dragged after reentry.
      }
      logger.debug("[browser-use] finished free-size drag", {
        pointerId: drag.pointerId,
        reason,
      });
    },
    [applyViewportSize],
  );

  const beginResize = useCallback(
    (directions: ResizeHandleDirections, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      finishResize("pointer-replaced");
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Automated composition events may not have an active pointer; a move on the same node can still verify the size logic.
      }
      dragRef.current = {
        ...directions,
        captureTarget: event.currentTarget,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startSize: viewportSizeRef.current,
      };
    },
    [finishResize],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      // The buttons of mousemove are the browser’s source of fact for the current physical buttons; even if the window blur is swallowed by the system screenshot layer,
      // The old gesture must also be terminated on the first frame after releasing the main key, and the dragRef left during pointerdown cannot be trusted anymore.
      if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
        finishResize("mouse-button-released", event.pointerId);
        return;
      }
      event.preventDefault();
      // After the frame is scaled using CSS transform, pointer delta is the visual pixel; if added directly,
      // The same drag distance at 50%/200% will incorrectly produce the same CSS viewport change.
      const scale = rendererScaleRef.current > 0 ? rendererScaleRef.current : 1;
      const widthDelta = (event.clientX - drag.startClientX) / scale;
      const heightDelta = (event.clientY - drag.startClientY) / scale;
      scheduleViewportSize({
        width: drag.startSize.width + widthDelta * drag.widthDirection,
        height: drag.startSize.height + heightDelta * drag.heightDirection,
      });
    },
    [finishResize, scheduleViewportSize],
  );

  const endResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      finishResize(event.type, event.pointerId);
    },
    [finishResize],
  );

  const handleResizeKeyDown = useCallback(
    (directions: ResizeHandleDirections, event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 1;
      const currentSize = viewportSizeRef.current;
      if (
        directions.widthDirection !== 0 &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        applyViewportSize({
          ...currentSize,
          width:
            currentSize.width +
            (event.key === "ArrowRight" ? step : -step) * directions.widthDirection,
        });
      }
      if (
        directions.heightDirection !== 0 &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        applyViewportSize({
          ...currentSize,
          height:
            currentSize.height +
            (event.key === "ArrowDown" ? step : -step) * directions.heightDirection,
        });
      }
    },
    [applyViewportSize],
  );

  useLayoutEffect(() => {
    if (!active || !isComposed || zoom !== "fit") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateCanvasSize = (size: BrowserViewportSize) => {
      // The display:none of inactive tab will cause ResizeObserver to return 0×0; if the last valid canvas is cleared,
      // When switching back to the first frame, Fit will first go back to 1 and then shrink in the next frame.
      // Non-positive sizes do not have layout authority; when recomposed, the layout effect retests before first drawing.
      if (size.width <= 0 || size.height <= 0) return;
      setCanvasSize((previous) =>
        previous?.width === size.width && previous.height === size.height ? previous : size,
      );
    };
    const rect = canvas.getBoundingClientRect();
    updateCanvasSize({ width: rect.width, height: rect.height });
    logger.debug("[browser-use] remeasured free-size Fit canvas", {
      desktopZoomFactor,
      height: rect.height,
      width: rect.width,
    });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateCanvasSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [active, desktopZoomFactor, isComposed, zoom]);

  useEffect(() => {
    if (!active) {
      finishResize("mode-inactive", undefined, false);
      return;
    }
    // System screenshots, application switching, etc. will cause the window to be out of focus in front of pointerup. The original handle
    // The end event is not received, so pointer capture and dragRef remain; normal movement after refocusing will continue to resize.
    const handleWindowBlur = () => finishResize("window-blur");
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      finishResize("mode-exit", undefined, false);
    };
  }, [active, finishResize]);

  return (
    <div
      ref={canvasRef}
      className={cn(
        "h-full min-h-0 w-full min-w-0",
        active ? "overflow-auto bg-background-alt" : "overflow-hidden bg-background",
      )}
      data-responsive-browser-mode={active ? "active" : "inactive"}
    >
      <div
        className={cn(
          active
            ? "flex min-h-full w-max min-w-full items-center justify-center p-4"
            : "h-full w-full",
        )}
      >
        <div
          className={cn(
            "relative shrink-0",
            active ? "bg-card shadow-sm ring-1 ring-border" : "h-full w-full",
          )}
          data-testid={TID_BROWSER_RESPONSIVE_SCALED_FRAME}
          style={
            active
              ? {
                  height: `${viewportSize.height * rendererScale}px`,
                  width: `${viewportSize.width * rendererScale}px`,
                }
              : undefined
          }
        >
          <div
            aria-label={intl.formatMessage({ id: "browser.responsive.viewport" })}
            className={cn("relative", active ? "shrink-0" : "h-full w-full")}
            data-responsive-height={active ? viewportSize.height : undefined}
            data-responsive-scale={active ? visualScale : undefined}
            data-responsive-width={active ? viewportSize.width : undefined}
            data-testid={TID_BROWSER_RESPONSIVE_VIEWPORT}
            style={
              active
                ? {
                    height: `${viewportSize.height}px`,
                    transform: `scale(${rendererScale})`,
                    transformOrigin: "top left",
                    width: `${viewportSize.width}px`,
                  }
                : undefined
            }
          >
            {children}
            {active ? (
              <ResponsiveBrowserResizeHandles
                height={viewportSize.height}
                heightLabel={intl.formatMessage({
                  id: "browser.responsive.resizeHeight",
                })}
                onBeginResize={beginResize}
                onEndResize={endResize}
                onPointerMove={handlePointerMove}
                onResizeKeyDown={handleResizeKeyDown}
                width={viewportSize.width}
                widthLabel={intl.formatMessage({
                  id: "browser.responsive.resizeWidth",
                })}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
