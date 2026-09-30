import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBrowserUseOperationActive } from "@/browser-use/useBrowserUseOperationActive.js";
import { logger } from "@/logger.js";

const RESIZE_WARNING_DURATION_MS = 3_000;
const AGENT_LAYOUT_SETTLE_MIN_DURATION_MS = 300;
const AGENT_LAYOUT_SETTLE_QUIET_DURATION_MS = 100;
const AGENT_LAYOUT_SETTLE_MAX_DURATION_MS = 500;

/**
 * Listens to the browser area size within the same Browser Use active period as the tab mouse icon.
 * This only produces a renderer-local weak hint: it does not cancel the tool, does not modify the
 * snapshot, and does not write state into the protocol layer.
 */
export function useBrowserResizeOperationWarning({
  browserKey,
  isVisible,
  operationUntil,
  resizeBaselineVersion,
}: {
  browserKey: string;
  isVisible: boolean;
  operationUntil?: number;
  resizeBaselineVersion?: number;
}) {
  const [showResizeWarning, setShowResizeWarning] = useState(false);
  const browserRegionRef = useRef<HTMLDivElement | null>(null);
  const lastSizeRef = useRef<{ width: number; height: number } | null>(null);
  const warnedForActiveCycleRef = useRef(false);
  const warningTimerRef = useRef<number | null>(null);
  const agentLayoutSettleUntilRef = useRef(0);
  const agentLayoutSettleMaxUntilRef = useRef(0);
  const previousResizeBaselineVersionRef = useRef(resizeBaselineVersion);
  const hasAppliedResizeBaselineVersionRef = useRef(false);
  const isVisibleRef = useRef(isVisible);
  const isAgentOperating = useBrowserUseOperationActive(operationUntil);
  const isAgentOperatingRef = useRef(isAgentOperating);
  // ResizeObserver may call back before the effect is refreshed; synchronize the ref when rendering to ensure that it is consistent with the icon's current frame state.
  isVisibleRef.current = isVisible;
  isAgentOperatingRef.current = isAgentOperating;

  const warnForBrowserResize = useCallback(() => {
    if (!isVisibleRef.current || !isAgentOperatingRef.current || warnedForActiveCycleRef.current) {
      return;
    }

    warnedForActiveCycleRef.current = true;
    setShowResizeWarning(true);
    warningTimerRef.current = window.setTimeout(() => {
      warningTimerRef.current = null;
      setShowResizeWarning(false);
    }, RESIZE_WARNING_DURATION_MS);
  }, []);

  const beginAgentLayoutSettlement = useCallback(() => {
    const now = Date.now();
    lastSizeRef.current = null;
    agentLayoutSettleUntilRef.current = now + AGENT_LAYOUT_SETTLE_MIN_DURATION_MS;
    agentLayoutSettleMaxUntilRef.current = now + AGENT_LAYOUT_SETTLE_MAX_DURATION_MS;
  }, []);

  const prepareForAgentViewportChange = useCallback(
    (willChangeResponsiveMode: boolean) => {
      if (!willChangeResponsiveMode) return;
      beginAgentLayoutSettlement();
    },
    [beginAgentLayoutSettlement],
  );

  useLayoutEffect(() => {
    const previousVersion = previousResizeBaselineVersionRef.current;
    const hasAppliedVersion = hasAppliedResizeBaselineVersionRef.current;
    const hasInitialAgentMarker = !hasAppliedVersion && (resizeBaselineVersion ?? 0) > 0;
    const agentMarkerChanged = hasAppliedVersion && previousVersion !== resizeBaselineVersion;
    previousResizeBaselineVersionRef.current = resizeBaselineVersion;
    hasAppliedResizeBaselineVersionRef.current = true;

    // The ready/visibility of model newTab mounts the view first, and the operation corresponding to the real tabId arrives later;
    // Guest mounts and side-pane animations after the marker will also generate multi-frame ResizeObserver callbacks. Clear only once
    // baseline will swallow the first frame, but falsely report the second frame as user resize. Here the model layout marker is turned on
    // Bounded stability period; normal initial mount/user tab still only rebuilds the baseline and does not expand the silent window.
    lastSizeRef.current = null;
    if (hasInitialAgentMarker || agentMarkerChanged) beginAgentLayoutSettlement();
  }, [beginAgentLayoutSettlement, isVisible, resizeBaselineVersion]);

  useEffect(() => {
    if (isAgentOperating) return;
    warnedForActiveCycleRef.current = false;
    setShowResizeWarning(false);
    if (warningTimerRef.current !== null) {
      window.clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
  }, [isAgentOperating]);

  useEffect(() => {
    const element = browserRegionRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextSize = {
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      };
      if (nextSize.width <= 0 || nextSize.height <= 0) return;

      const previousSize = lastSizeRef.current;
      lastSizeRef.current = nextSize;
      const now = Date.now();
      const isAgentLayoutSettling = now <= agentLayoutSettleUntilRef.current;
      if (isAgentLayoutSettling) {
        agentLayoutSettleUntilRef.current = Math.min(
          agentLayoutSettleMaxUntilRef.current,
          Math.max(agentLayoutSettleUntilRef.current, now + AGENT_LAYOUT_SETTLE_QUIET_DURATION_MS),
        );
      }
      const sizeChanged =
        previousSize !== null &&
        (previousSize.width !== nextSize.width || previousSize.height !== nextSize.height);
      logger.debug("[browser-use] browser region ResizeObserver", {
        browserKey,
        isAgentOperating: isAgentOperatingRef.current,
        isVisible: isVisibleRef.current,
        nextSize,
        previousSize,
        resizeBaselineVersion,
        isAgentLayoutSettling,
        sizeChanged,
        warnedForActiveCycle: warnedForActiveCycleRef.current,
      });
      if (!sizeChanged || isAgentLayoutSettling) return;

      // Coordinate actions may still be based on visual information before resize. The same active cycle will only prompt once.
      // Avoid prompt storms caused by continuous dragging, while keeping the existing execution semantics of locator/CUA unchanged.
      warnForBrowserResize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [browserKey, resizeBaselineVersion, warnForBrowserResize]);

  useEffect(
    () => () => {
      if (warningTimerRef.current !== null) window.clearTimeout(warningTimerRef.current);
    },
    [],
  );

  return {
    browserRegionRef,
    notifyBrowserViewportResize: warnForBrowserResize,
    prepareForAgentViewportChange,
    showResizeWarning,
  };
}
