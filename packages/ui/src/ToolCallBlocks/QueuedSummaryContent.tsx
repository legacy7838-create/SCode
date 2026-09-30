import { type ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

const SUMMARY_ROLL_TRANSITION_MS = 300;
const SUMMARY_ROLL_HOLD_MS = 500;
const SUMMARY_ROLL_TOTAL_MS = SUMMARY_ROLL_TRANSITION_MS + SUMMARY_ROLL_HOLD_MS;
const SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS = 250;
const SUMMARY_ROLL_MAX_PENDING = 2;
const SUMMARY_ROLL_TRANSITION = {
  duration: SUMMARY_ROLL_TRANSITION_MS / 1000,
  ease: [0.4, 0, 0.2, 1],
} as const;

function getCurrentTimestamp() {
  if (typeof performance !== "undefined") {
    return performance.now();
  }
  return Date.now();
}

function resolveQueuedSummaryPlaybackQueue<T>(
  queuedContent: readonly T[],
  timerDriftMs: number,
): T[] {
  if (timerDriftMs > SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS && queuedContent.length > 1) {
    return queuedContent.slice(-1);
  }
  return [...queuedContent];
}

function shouldAnimateQueuedSummaryContent({
  enabled,
  disableAnimation,
  reducedMotion,
}: {
  enabled: boolean;
  disableAnimation?: boolean;
  reducedMotion: boolean;
}) {
  return enabled && disableAnimation !== true && !reducedMotion;
}

interface SummaryContentSnapshot {
  key: string;
  refreshVersion?: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  trailingText?: ReactNode;
}

function shouldRefreshQueuedSummaryContent(
  current: Pick<SummaryContentSnapshot, "key" | "refreshVersion" | "trailingText">,
  next: Pick<SummaryContentSnapshot, "key" | "refreshVersion" | "trailingText">,
) {
  return (
    current.key === next.key &&
    (current.trailingText !== next.trailingText || current.refreshVersion !== next.refreshVersion)
  );
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

export function QueuedSummaryContent({
  contentKey,
  contentRefreshVersion,
  primaryText,
  secondaryText,
  trailingText,
  enabled,
  disableAnimation = false,
}: {
  contentKey: string;
  contentRefreshVersion?: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  trailingText?: ReactNode;
  enabled: boolean;
  disableAnimation?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const shouldAnimate = shouldAnimateQueuedSummaryContent({
    enabled,
    disableAnimation,
    reducedMotion,
  });
  const createSnapshot = (): SummaryContentSnapshot => ({
    key: contentKey,
    refreshVersion: contentRefreshVersion,
    primaryText,
    secondaryText,
    trailingText,
  });
  const [displayedContent, setDisplayedContent] = useState(createSnapshot);
  const displayedContentRef = useRef(displayedContent);
  const queuedContentRef = useRef<SummaryContentSnapshot[]>([]);
  const animationTimerRef = useRef<number | null>(null);
  const isAnimatingRef = useRef(false);

  useEffect(() => {
    displayedContentRef.current = displayedContent;
  }, [displayedContent]);

  useEffect(() => {
    const clearAnimationTimer = () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    };
    const enqueue = (snapshot: SummaryContentSnapshot) => {
      const queue = queuedContentRef.current;
      const existingIndex = queue.findIndex((item) => item.key === snapshot.key);
      if (existingIndex >= 0) {
        // While the file summary is waiting to be played, continuously arriving diffs only update the same snapshot and cannot be deduplicated due to key
        // Leaving the earliest +N/-N behind, you cannot add an entire scroll item for each value change.
        const nextQueue = [...queue];
        nextQueue[existingIndex] = snapshot;
        queuedContentRef.current = nextQueue;
        return;
      }

      if (queue.length === 0) {
        queuedContentRef.current = [snapshot];
        return;
      }

      // Summary scrolling can only have three spaces in total: the current display, the next one, and the queue-breaking bar.
      // queuedContentRef only saves the last two fields; the second field cannot be overwritten, and the new summary can only replace the third field.
      queuedContentRef.current = [queue[0]!, snapshot].slice(0, SUMMARY_ROLL_MAX_PENDING);
    };
    const promote = (snapshot: SummaryContentSnapshot) => {
      displayedContentRef.current = snapshot;
      setDisplayedContent(snapshot);
      isAnimatingRef.current = true;
      clearAnimationTimer();
      const expectedTimerAt = getCurrentTimestamp() + SUMMARY_ROLL_TOTAL_MS;
      animationTimerRef.current = window.setTimeout(() => {
        isAnimatingRef.current = false;
        animationTimerRef.current = null;
        const queuedContent = queuedContentRef.current;
        const timerDrift = getCurrentTimestamp() - expectedTimerAt;
        // When the main thread is busy, timeout will arrive late; if the old summary continues to be replayed one by one,
        // After the lag is restored, the user will see the expired status queued for playback, and the experience will become more laggy.
        const nextQueue = resolveQueuedSummaryPlaybackQueue(queuedContent, timerDrift);
        const [nextQueued, ...restQueued] = nextQueue;
        if (!nextQueued) {
          queuedContentRef.current = [];
          return;
        }
        queuedContentRef.current = restQueued;
        promote(nextQueued);
      }, SUMMARY_ROLL_TOTAL_MS);
    };
    const nextContent = createSnapshot();

    if (!shouldAnimate) {
      clearAnimationTimer();
      isAnimatingRef.current = false;
      queuedContentRef.current = [];
      displayedContentRef.current = nextContent;
      setDisplayedContent(nextContent);
      return;
    }

    if (displayedContentRef.current.key === nextContent.key) {
      // Neither the diff of the same Changes child nor the same streaming Assistant message can replay the entire summary;
      // The former updates the tail count, and the latter refreshes the body in place with an explicit version.
      if (shouldRefreshQueuedSummaryContent(displayedContentRef.current, nextContent)) {
        displayedContentRef.current = nextContent;
        setDisplayedContent(nextContent);
      }
      return;
    }

    if (isAnimatingRef.current) {
      enqueue(nextContent);
      return;
    }

    if (queuedContentRef.current.length > 0) {
      enqueue(nextContent);
      return;
    }

    promote(nextContent);
  }, [contentKey, contentRefreshVersion, shouldAnimate, trailingText]);

  useEffect(() => {
    return () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  if (!shouldAnimate) {
    return (
      <>
        {primaryText}
        {secondaryText}
        {trailingText}
      </>
    );
  }

  return (
    <span className="relative inline-flex min-w-0 items-center gap-2 overflow-hidden align-middle">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={displayedContent.key}
          className="inline-flex min-w-0 items-center gap-2"
          initial={{ y: "0.8em", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-0.8em", opacity: 0 }}
          transition={SUMMARY_ROLL_TRANSITION}
        >
          {displayedContent.primaryText}
          {displayedContent.secondaryText}
        </motion.span>
      </AnimatePresence>
      {/* The diff count of Changes must belong to the same queued snapshot as the file digest,
          However, the numbers themselves continue to be flipped independently using FlipMetricValue and cannot scroll vertically together with the entire summary. */}
      {displayedContent.trailingText}
    </span>
  );
}
