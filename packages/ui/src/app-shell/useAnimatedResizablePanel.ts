import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

const PANEL_FLEX_GROW_TRANSITION_CLASSES = ["transition-[flex-grow]", "duration-200", "ease-out"];
const PANEL_FLEX_GROW_TRANSITION_FALLBACK_MS = 240;

function enablePanelFlexGrowTransition(panelElement: HTMLElement): () => void {
  panelElement.classList.add(...PANEL_FLEX_GROW_TRANSITION_CLASSES);

  let finished = false;
  let fallbackTimer = 0;

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    panelElement.removeEventListener("transitionend", handleTransitionEnd);
    if (fallbackTimer) {
      window.clearTimeout(fallbackTimer);
    }
    panelElement.classList.remove(...PANEL_FLEX_GROW_TRANSITION_CLASSES);
  };

  const handleTransitionEnd = (event: TransitionEvent) => {
    if (event.target === panelElement && event.propertyName === "flex-grow") {
      finish();
    }
  };

  panelElement.addEventListener("transitionend", handleTransitionEnd);
  fallbackTimer = window.setTimeout(finish, PANEL_FLEX_GROW_TRANSITION_FALLBACK_MS);

  return finish;
}

export function useAnimatedResizablePanel({
  open,
  alwaysMounted = false,
  expandedSize,
  rememberExpandedSize = false,
  resizeOnInitialVisibleMount = true,
}: {
  open: boolean;
  alwaysMounted?: boolean;
  expandedSize?: string;
  rememberExpandedSize?: boolean;
  resizeOnInitialVisibleMount?: boolean;
}) {
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);
  const expandedSizeRef = useRef(expandedSize);
  const hasHandledVisibilityRef = useRef(false);
  const [isVisible, setIsVisible] = useState(open);

  useEffect(() => {
    expandedSizeRef.current = expandedSize;
  }, [expandedSize]);

  useEffect(() => {
    if (alwaysMounted) {
      setIsVisible(open);
      return;
    }

    if (open) {
      // If the conditionally rendered Panel is in the expanded state as soon as it is mounted, the first frame will jump directly to the target size.
      // Here, let the resident Panel remain in the collapsed state, and then switch to the expanded state in the next frame. The same set of transitions can be reused when opening and closing.
      const rafId = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    setIsVisible(false);
  }, [alwaysMounted, open]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const panelElement = panelElementRef.current;

    if (!hasHandledVisibilityRef.current) {
      hasHandledVisibilityRef.current = true;
      if (isVisible && !resizeOnInitialVisibleMount) {
        // The sidebar's PanelGroup has the width persisted via layoutId.
        // If it is resized to the default value when the mount is first visible, it will overwrite the width saved by the user last drag and drop.
        return;
      }
    }

    // Previously, the flex-grow transition was resident on the data-panel, and when the window was scaled natively,
    // The ResizeObserver of react-resizable-panels will see a series of animated intermediate sizes and trigger a large number of
    // layout store updates and React commits. This only enables size transitions briefly when explicitly expanding/collapsing panels,
    // Prevent normal window resize from being enlarged by animation links.
    const cleanupTransition = panelElement
      ? enablePanelFlexGrowTransition(panelElement)
      : undefined;

    // When Panel is mounted for the first time, react-resizable-panels will register constraints in the internal effect.
    // If we call collapse/expand immediately on the same beat, occasionally the constraint registration will be completed before the trigger.
    // "Panel constraints not found" crash. This is delayed by one frame to ensure that the panel completes registration before executing the animation command.
    const rafId = window.requestAnimationFrame(() => {
      if (isVisible) {
        const nextExpandedSize = expandedSizeRef.current;
        if (nextExpandedSize) {
          panel.resize(nextExpandedSize);
          return;
        }
        panel.expand();
        return;
      }
      if (rememberExpandedSize) {
        const currentSize = panel.getSize().asPercentage;
        if (Number.isFinite(currentSize) && currentSize > 0) {
          expandedSizeRef.current = `${currentSize}%`;
        }
      }
      panel.collapse();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      cleanupTransition?.();
    };
  }, [isVisible, rememberExpandedSize, resizeOnInitialVisibleMount]);

  return {
    panelRef,
    panelElementRef,
    isVisible,
  };
}
