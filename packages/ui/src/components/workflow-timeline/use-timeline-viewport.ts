import { useEffect, useLayoutEffect, useState } from "react";

/**
 * The three numbers of the scroll viewport (scrollLeft / clientWidth / scrollWidth) plus the "is
 * scrolling" flag. Scroll events are coalesced per frame; size changes go through a ResizeObserver
 * (watching both the container and the content layer, since the draft's pen gets wider every time
 * it reveals a station's content). jsdom cannot measure them (width 0), and consumers fold nothing
 * on that basis — so static test results stay pixel-for-pixel unchanged.
 *
 * The dependency is the **element**, not the ref object: a draft has no stations on its first frame
 * and the scroll layer is attached a frame later, so an effect that depends on the ref object hits
 * null on the first frame, returns early and never runs again — the listeners are never wired up
 * and the viewport keeps only that one stale measurement from when the width changed, leaving the
 * newest station permanently folded under the right eave. Consumers hand the element over in state
 * via a callback ref: wire it up when it appears, tear it down when it leaves.
 *
 * If the measured numbers have not changed the object is not replaced; creating a new object on
 * every ResizeObserver and scroll callback used to make the timeline render one wasted pass; while
 * an empty draft spins idle these redundant updates all get charged to React's nested update count.
 */
export interface TimelineViewport {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
  /** Scrolled within the last 800ms (the scrollbar shows itself accordingly). */
  scrolling: boolean;
}

const SCROLLING_MS = 800;
const EMPTY: TimelineViewport = { clientWidth: 0, scrollLeft: 0, scrollWidth: 0, scrolling: false };

function measure(element: HTMLElement): Omit<TimelineViewport, "scrolling"> {
  return {
    clientWidth: element.clientWidth,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
  };
}

/**
 * Folds one measurement into the previous viewport; if none of the three numbers nor scrolling
 * changed, the previous object is returned and React skips this render.
 */
function merge(
  previous: TimelineViewport,
  measured: Omit<TimelineViewport, "scrolling">,
  scrolling = previous.scrolling,
): TimelineViewport {
  return previous.clientWidth === measured.clientWidth &&
    previous.scrollLeft === measured.scrollLeft &&
    previous.scrollWidth === measured.scrollWidth &&
    previous.scrolling === scrolling
    ? previous
    : { ...measured, scrolling };
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useTimelineViewport(
  /**
   * The scroll layer element; null when it is not attached yet (first frame of a draft) or has been
   * unmounted.
   */
  element: HTMLElement | null,
  /** The handle for content changes (station count, width): when it changes, measure again. */
  contentKey: number,
): TimelineViewport {
  const [viewport, setViewport] = useState<TimelineViewport>(EMPTY);

  useIsomorphicLayoutEffect(() => {
    if (element === null) return;
    setViewport((previous) => merge(previous, measure(element)));
  }, [element, contentKey]);

  useEffect(() => {
    if (element === null) return;
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        setViewport((previous) => merge(previous, measure(element), true));
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          setViewport((previous) =>
            previous.scrolling ? { ...previous, scrolling: false } : previous,
          );
        }, SCROLLING_MS);
      });
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        setViewport((previous) => merge(previous, measure(element)));
      });
      observer.observe(element);
      const content = element.firstElementChild;
      if (content !== null) observer.observe(content);
    }
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
    };
  }, [element]);

  return viewport;
}
