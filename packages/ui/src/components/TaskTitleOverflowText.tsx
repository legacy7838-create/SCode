import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
} from "react";
import { cn } from "@/components/lib/utils.js";

const overflowFadeClassName =
  "[mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)]";
const marqueeGapPx = 24;
const marqueePixelsPerSecond = 40;
const minimumMarqueeDurationSeconds = 6;
const marqueePauseSeconds = 2;
const marqueeHoverDelayMs = 1_000;
const marqueeMaskFadeInSeconds = 0.15;
const rightFadeMask =
  "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)";
const bothEdgesFadeMask =
  "linear-gradient(to right, transparent 0, black 1.5rem, black calc(100% - 1.5rem), transparent 100%)";

function createMaskKeyframe(maskImage: string, offset: number): Keyframe {
  return { maskImage, offset, webkitMaskImage: maskImage };
}

type TaskTitleOverflowTextProps = ComponentPropsWithoutRef<"p"> & {
  as?: "p" | "span";
};

export function TaskTitleOverflowText({
  as = "p",
  children,
  className,
  // The native title prompt box will cover the scrolling task name when hovering the carousel.
  // This attribute is uniformly consumed at the component boundary to avoid reintroducing the tooltip after each task row is missed.
  title: _nativeTitle,
  ...props
}: TaskTitleOverflowTextProps) {
  const Component = as as ElementType;
  const textRef = useRef<HTMLElement | null>(null);
  const originalTextRef = useRef<HTMLSpanElement | null>(null);
  const marqueeTrackRef = useRef<HTMLSpanElement | null>(null);
  const [overflowState, setOverflowState] = useState({
    distance: 0,
    duration: minimumMarqueeDurationSeconds,
    isOverflowing: false,
  });
  const { distance, duration, isOverflowing } = overflowState;

  useEffect(() => {
    const textElement = textRef.current;
    const originalTextElement = originalTextRef.current;
    if (!textElement || !originalTextElement) return;

    const updateOverflow = () => {
      // The title used to be unconditionally attached to the mask, and the fully visible short title also had a fade-out style.
      // The actual layout width of a single title shall prevail to avoid being unable to exit the overflow state after the revolving copy expands the scrollWidth.
      const contentWidth = originalTextElement.scrollWidth;
      const nextIsOverflowing = contentWidth > textElement.clientWidth;
      const nextDistance = nextIsOverflowing ? contentWidth + marqueeGapPx : 0;
      const nextDuration = nextIsOverflowing
        ? Math.max(minimumMarqueeDurationSeconds, nextDistance / marqueePixelsPerSecond)
        : minimumMarqueeDurationSeconds;
      setOverflowState((current) =>
        current.isOverflowing === nextIsOverflowing &&
        current.distance === nextDistance &&
        current.duration === nextDuration
          ? current
          : {
              distance: nextDistance,
              duration: nextDuration,
              isOverflowing: nextIsOverflowing,
            },
      );
    };

    updateOverflow();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflow);
      return () => window.removeEventListener("resize", updateOverflow);
    }

    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(textElement);
    resizeObserver.observe(originalTextElement);
    return () => resizeObserver.disconnect();
  }, [children]);

  useEffect(() => {
    const textElement = textRef.current;
    const marqueeTrack = marqueeTrackRef.current;
    if (
      !isOverflowing ||
      !textElement ||
      !marqueeTrack ||
      typeof marqueeTrack.animate !== "function"
    ) {
      return;
    }

    const reducedMotionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    // The revolving lantern event was originally tied to the text node. When the mouse is on the task item,
    // Status or operation area will not scroll. Tie uniformly to the nearest normal or grouped task line boundary.
    const hoverTarget =
      textElement.closest<HTMLElement>("[data-task-item-key], [data-grouped-task-key]") ??
      textElement;
    let animations: Animation[] = [];
    let startTimer: number | null = null;

    const stopMarquee = () => {
      if (startTimer !== null) {
        window.clearTimeout(startTimer);
        startTimer = null;
      }
      animations.forEach((animation) => animation.cancel());
      animations = [];
    };
    const startMarquee = () => {
      if (reducedMotionQuery?.matches) return;

      stopMarquee();
      const totalDuration = duration + marqueePauseSeconds;
      // Pure CSS infinite animation can only be paused by percentage, and there is no guarantee when the title width changes.
      // Fixed wait of 2 seconds after copy head alignment. Web Animation uses dynamic offset to separate movement and dwell duration.
      const movementEndOffset = duration / totalDuration;
      const maskFadeInEndOffset = marqueeMaskFadeInSeconds / totalDuration;
      // The left mask continues to fade out within the 24px spacing, which will make the main title that has left the field
      // A contentless gradient remains. When the tail of the body reaches the left edge, it switches directly to the right-side mask only.
      const originalTailArrivalTime = duration * ((distance - marqueeGapPx) / distance);
      const originalTailArrivalOffset = originalTailArrivalTime / totalDuration;
      const animationOptions: KeyframeAnimationOptions = {
        duration: totalDuration * 1_000,
        easing: "linear",
        iterations: Infinity,
      };
      const trackAnimation = marqueeTrack.animate(
        [
          { offset: 0, transform: "translate3d(0, 0, 0)" },
          {
            offset: movementEndOffset,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
          {
            offset: 1,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
        ],
        animationOptions,
      );
      // Always use a bilateral mask during scrolling, which will cause the copy to stay on the screen for 2 seconds after it is aligned.
      // Still can't make out the beginning of the title. The mask shares the duration with the displacement animation, fading out to the left before reaching it and remaining there until the next round.
      const maskAnimation = textElement.animate(
        [
          createMaskKeyframe(rightFadeMask, 0),
          createMaskKeyframe(bothEdgesFadeMask, maskFadeInEndOffset),
          createMaskKeyframe(bothEdgesFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, 1),
        ],
        animationOptions,
      );
      animations = [trackAnimation, maskAnimation];
    };
    const scheduleMarquee = () => {
      if (reducedMotionQuery?.matches) return;
      stopMarquee();
      // Interaction rules: Briefly swiping the task row should not trigger motion immediately; stay for 1 second before starting.
      startTimer = window.setTimeout(() => {
        startTimer = null;
        startMarquee();
      }, marqueeHoverDelayMs);
    };
    const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
      if (event.matches) stopMarquee();
    };

    hoverTarget.addEventListener("mouseenter", scheduleMarquee);
    hoverTarget.addEventListener("mouseleave", stopMarquee);
    reducedMotionQuery?.addEventListener("change", handleMotionPreferenceChange);

    return () => {
      hoverTarget.removeEventListener("mouseenter", scheduleMarquee);
      hoverTarget.removeEventListener("mouseleave", stopMarquee);
      reducedMotionQuery?.removeEventListener("change", handleMotionPreferenceChange);
      stopMarquee();
    };
  }, [distance, duration, isOverflowing]);

  return (
    <Component
      ref={textRef}
      className={cn(
        "min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        isOverflowing && overflowFadeClassName,
        isOverflowing && "task-title-marquee",
        className,
      )}
      {...props}
    >
      <span
        ref={marqueeTrackRef}
        data-task-title-marquee-track="true"
        className="task-title-marquee-track inline-flex w-max min-w-max items-center gap-6"
      >
        <span ref={originalTextRef} data-task-title-copy="original" className="shrink-0">
          {children}
        </span>
        {isOverflowing ? (
          <span aria-hidden="true" data-task-title-copy="duplicate" className="shrink-0">
            {children}
          </span>
        ) : null}
      </span>
    </Component>
  );
}
