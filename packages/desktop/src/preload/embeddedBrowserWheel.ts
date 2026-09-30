import {
  EmbeddedBrowserWebviewChannels,
  type EmbeddedBrowserWheelBoundaryPayload,
} from "@zcode/shared";

const DELTA_EPSILON = 0.01;
const SCROLL_BOUNDARY_EPSILON = 1;
const LINE_DELTA_PIXELS = 40;
const MAX_FORWARDED_DELTA_PIXELS = 10_000;

type SendToHost = (channel: string, payload: EmbeddedBrowserWheelBoundaryPayload) => void;

function clampForwardedDelta(delta: number): number {
  return Math.max(-MAX_FORWARDED_DELTA_PIXELS, Math.min(MAX_FORWARDED_DELTA_PIXELS, delta));
}

function normalizeAxisDelta(rawDelta: number, event: WheelEvent, pageSize: number): number {
  if (!Number.isFinite(rawDelta) || Math.abs(rawDelta) <= DELTA_EPSILON) return 0;
  const scale =
    event.deltaMode === 1 ? LINE_DELTA_PIXELS : event.deltaMode === 2 ? Math.max(1, pageSize) : 1;
  return clampForwardedDelta(rawDelta * scale);
}

/** Unify the trackpad, scroll wheel, and Shift+wheel into a CSS pixel 2D delta used by the host canvas. */
function normalizeEmbeddedBrowserWheelDelta(
  event: WheelEvent,
  targetWindow: Window,
): EmbeddedBrowserWheelBoundaryPayload {
  const rawDeltaX =
    Math.abs(event.deltaX) > DELTA_EPSILON ? event.deltaX : event.shiftKey ? event.deltaY : 0;
  const rawDeltaY = event.shiftKey ? 0 : event.deltaY;
  return {
    deltaX: normalizeAxisDelta(rawDeltaX, event, targetWindow.innerWidth),
    deltaY: normalizeAxisDelta(rawDeltaY, event, targetWindow.innerHeight),
  };
}

function isElement(value: EventTarget): value is Element {
  return "nodeType" in value && value.nodeType === 1;
}

function canElementConsumeDelta(
  element: Element,
  axis: "x" | "y",
  delta: number,
  targetWindow: Window,
): boolean {
  const isHorizontal = axis === "x";
  const scrollSize = isHorizontal ? element.scrollWidth : element.scrollHeight;
  const clientSize = isHorizontal ? element.clientWidth : element.clientHeight;
  const maxScroll = scrollSize - clientSize;
  if (maxScroll <= SCROLL_BOUNDARY_EPSILON) return false;

  const style = targetWindow.getComputedStyle(element);
  const overflow = (isHorizontal ? style.overflowX : style.overflowY) || style.overflow;
  const isDocumentScroller = element === targetWindow.document.scrollingElement;
  if (overflow === "hidden" || overflow === "clip") return false;
  if (!isDocumentScroller && !["auto", "scroll", "overlay"].includes(overflow)) return false;

  if (!isHorizontal) {
    return delta > 0
      ? element.scrollTop < maxScroll - SCROLL_BOUNDARY_EPSILON
      : element.scrollTop > SCROLL_BOUNDARY_EPSILON;
  }

  // Chromium's RTL scrollLeft is 0 at the far right and negative as you move to the left.
  if (style.direction === "rtl") {
    return delta > 0
      ? element.scrollLeft < -SCROLL_BOUNDARY_EPSILON
      : element.scrollLeft > -maxScroll + SCROLL_BOUNDARY_EPSILON;
  }
  return delta > 0
    ? element.scrollLeft < maxScroll - SCROLL_BOUNDARY_EPSILON
    : element.scrollLeft > SCROLL_BOUNDARY_EPSILON;
}

function guestCanConsumeDelta(
  event: WheelEvent,
  axis: "x" | "y",
  delta: number,
  targetWindow: Window,
): boolean {
  if (delta === 0) return false;
  const candidates = new Set<Element>();
  for (const target of event.composedPath()) {
    if (isElement(target)) candidates.add(target);
  }
  const documentScroller = targetWindow.document.scrollingElement;
  if (documentScroller) candidates.add(documentScroller);

  return [...candidates].some((element) =>
    canElementConsumeDelta(element, axis, delta, targetWindow),
  );
}

/**
 * Electron guest wheel events do not bubble into the embedder DOM. Only axes the guest cannot
 * consume further are handed over, so that forwarding unconditionally does not break the page's
 * own lists, tables, carousels and nested scroll containers.
 */
export function installEmbeddedBrowserWheelForwarding(
  targetWindow: Window,
  sendToHost: SendToHost,
): () => void {
  const handleWheel = (event: WheelEvent): void => {
    const normalized = normalizeEmbeddedBrowserWheelDelta(event, targetWindow);
    const deltaX = guestCanConsumeDelta(event, "x", normalized.deltaX, targetWindow)
      ? 0
      : normalized.deltaX;
    const deltaY = guestCanConsumeDelta(event, "y", normalized.deltaY, targetWindow)
      ? 0
      : normalized.deltaY;
    if (deltaX === 0 && deltaY === 0) return;

    // Delay until the end of this round of event dispatching and respect the preventDefault custom gesture handler registered after the web page.
    targetWindow.queueMicrotask(() => {
      if (event.defaultPrevented) return;
      sendToHost(EmbeddedBrowserWebviewChannels.WheelBoundary, { deltaX, deltaY });
    });
  };

  targetWindow.addEventListener("wheel", handleWheel, { passive: true });
  return () => targetWindow.removeEventListener("wheel", handleWheel);
}
