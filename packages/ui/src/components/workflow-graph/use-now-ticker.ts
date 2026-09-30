import { useEffect, useState } from "react";

/**
 * The natural granularity of the countdown: at second-level wording, ticking one notch faster would
 * not change the text.
 */
export const NOW_TICKER_INTERVAL_MS = 1_000;

/**
 * A "now" that only ticks while `active`.
 *
 * Why it does not piggyback on projection updates to recompute: an ask that is backing off waiting
 * for a provider **precisely does not emit events**, so an event-driven reading would stay frozen
 * at the seconds it had on arrival. The timer exists only while there is a countdown to show; the
 * moment `active` turns true it first re-reads "now", so it does not start from the previous
 * segment's drift. Same approach as the wait duration in WorkflowRunPendingQuestionsSection, only
 * with the granularity tightened from 30 seconds to 1 second — what is shown here is seconds.
 */
export function useNowTicker(active: boolean, intervalMs: number = NOW_TICKER_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
