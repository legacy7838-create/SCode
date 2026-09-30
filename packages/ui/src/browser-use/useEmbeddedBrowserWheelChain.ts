import { useEffect, type RefObject } from "react";
import {
  EmbeddedBrowserWebviewChannels,
  type EmbeddedBrowserWheelBoundaryPayload,
} from "@zcode/shared";
import { logger } from "@/logger.js";

function validatedDelta(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Continue a 2D wheel that has already reached the guest's edge onto a freely sized host canvas.
 */
export function useEmbeddedBrowserWheelChain({
  browserRegionRef,
  isResponsiveMode,
  webview,
}: {
  browserRegionRef: RefObject<HTMLDivElement | null>;
  isResponsiveMode: boolean;
  webview: ElectronWebviewTag | null;
}): void {
  useEffect(() => {
    if (!webview) return;

    const handleGuestIpcMessage = (event: ElectronWebviewIpcMessageEvent): void => {
      if (!isResponsiveMode || event.channel !== EmbeddedBrowserWebviewChannels.WheelBoundary) {
        return;
      }
      const payload = event.args[0] as Partial<EmbeddedBrowserWheelBoundaryPayload> | undefined;
      // The IPC payload may be missing fields or carry non-finite numbers, and cannot be directly passed to the host scrolling canvas.
      const deltaX = validatedDelta(payload?.deltaX);
      const deltaY = validatedDelta(payload?.deltaY);
      if (deltaX === 0 && deltaY === 0) return;

      const responsiveCanvas = browserRegionRef.current?.querySelector<HTMLElement>(
        '[data-responsive-browser-mode="active"]',
      );
      if (!responsiveCanvas) return;
      // Electron `<webview>` guest wheel does not bubble to host DOM; fixed preload
      // Only send a message when the web page cannot continue to consume the corresponding axis, and continue the scroll chain of the outer free-size canvas here.
      responsiveCanvas.scrollBy({ behavior: "auto", left: deltaX, top: deltaY });
      // The wheel is of the same order as the message flow. Only debug is used, and the production build will not be released.
      logger.debug("[browser-use] guest wheel continued free-size canvas", {
        deltaX,
        deltaY,
        scrollLeft: responsiveCanvas.scrollLeft,
        scrollTop: responsiveCanvas.scrollTop,
      });
    };

    webview.addEventListener("ipc-message", handleGuestIpcMessage);
    return () => webview.removeEventListener("ipc-message", handleGuestIpcMessage);
  }, [browserRegionRef, isResponsiveMode, webview]);
}
