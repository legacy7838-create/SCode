// Split-screen drag-and-drop separator bar (rAF + CSS variable scheme is generalized according to split nodes, row/column bidirectional):
// Pointer capture driver, only the container CSS variables (ref + rAF frame) are used in the dragging ratio.
// Not entering React state - pane content subtree is zero-rerendered during drag;
// Pointerup is submitted to paneLayoutStore once (for persistence).
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { TID_V4_SPLIT_DIVIDER } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { clampSplitRatio, type SplitDirection } from "@/v4/paneLayoutTree.js";
import { SPLIT_VAR_PREFIX } from "@/v4/workbenchLayout.js";

interface SplitDividerDragState {
  pointerId: number;
  /** The length in pixels of the main axis of this split node region (containerRect main axis × regionFraction, constant during dragging). */
  regionPx: number;
  startClient: number;
  startRatio: number;
  latestClient: number;
  rafId: number | null;
}

interface WorkbenchSplitDividerProps {
  containerRef: RefObject<HTMLDivElement | null>;
  splitId: string;
  direction: SplitDirection;
  /** The currently submitted proportion (store value); it is only used as the starting point for dragging, and the dragging process does not rely on it for re-rendering. */
  ratio: number;
  /** The numerical proportion of the split node area to the main axis of the container (drag pixel → proportion conversion). */
  regionFraction: number;
  style: CSSProperties;
  onCommitRatio: (splitId: string, ratio: number) => void;
}

export const WorkbenchSplitDivider = memo(function WorkbenchSplitDivider({
  containerRef,
  splitId,
  direction,
  ratio,
  regionFraction,
  style,
  onCommitRatio,
}: WorkbenchSplitDividerProps) {
  const dragRef = useRef<SplitDividerDragState | null>(null);
  // Only the highlight state of the separator bar itself; the memo pane subtree is not affected when switching.
  const [dragging, setDragging] = useState(false);
  const isRow = direction === "row";

  const ratioFromDrag = useCallback((drag: SplitDividerDragState): number => {
    if (drag.regionPx <= 0) {
      return drag.startRatio;
    }
    return clampSplitRatio(
      drag.startRatio + (drag.latestClient - drag.startClient) / drag.regionPx,
    );
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") {
        return;
      }
      const container = containerRef.current;
      if (!container) {
        return;
      }
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // When e2e synthesizes PointerEvent and there is no active pointerId, capture will throw an error; the drag logic does not rely on capture to be established.
      }
      const containerRect = container.getBoundingClientRect();
      const client = isRow ? event.clientX : event.clientY;
      dragRef.current = {
        pointerId: event.pointerId,
        regionPx: (isRow ? containerRect.width : containerRect.height) * regionFraction,
        startClient: client,
        startRatio: ratio,
        latestClient: client,
        rafId: null,
      };
      setDragging(true);
    },
    [containerRef, isRow, ratio, regionFraction],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      drag.latestClient = isRow ? event.clientX : event.clientY;
      if (drag.rafId !== null) {
        return;
      }
      drag.rafId = requestAnimationFrame(() => {
        drag.rafId = null;
        containerRef.current?.style.setProperty(
          `${SPLIT_VAR_PREFIX}${splitId}`,
          String(ratioFromDrag(drag)),
        );
      });
    },
    [containerRef, isRow, ratioFromDrag, splitId],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      if (drag.rafId !== null) {
        cancelAnimationFrame(drag.rafId);
        drag.rafId = null;
      }
      drag.latestClient = isRow ? event.clientX : event.clientY;
      const finalRatio = ratioFromDrag(drag);
      containerRef.current?.style.setProperty(`${SPLIT_VAR_PREFIX}${splitId}`, String(finalRatio));
      dragRef.current = null;
      setDragging(false);
      // Submit it to the store (→ localStorage); the container style will write the same value in the next rendering, without visual jump.
      onCommitRatio(splitId, finalRatio);
    },
    [containerRef, isRow, onCommitRatio, ratioFromDrag, splitId],
  );

  // Clean up unfinished rAF when uninstalling (layout change/pane closing).
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag?.rafId != null) {
        cancelAnimationFrame(drag.rafId);
      }
      dragRef.current = null;
    },
    [],
  );

  return (
    <div
      data-testid={TID_V4_SPLIT_DIVIDER}
      data-split-id={splitId}
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      data-dragging={dragging ? "true" : "false"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={style}
      className={cn(
        "group absolute z-10 touch-none select-none",
        isRow ? "cursor-col-resize" : "cursor-row-resize",
      )}
    >
      <div
        className={cn(
          "pointer-events-none transition-colors",
          isRow ? "mx-auto h-full w-px" : "my-auto h-px w-full",
          dragging
            ? "bg-[var(--color-brand)]"
            : "bg-[var(--color-border)] group-hover:bg-[var(--color-brand)]",
        )}
      />
    </div>
  );
});
