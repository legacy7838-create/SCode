import { useEffect, useRef, useState } from "react";
import type { V4ConversationWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * The discovery query for dwf runs.
 *
 * It no longer backs the card join — after a restart the projection is refilled by the CLI's cold
 * materialization replaying the journal. The remaining consumers are the run catalog page and the
 * "Ended workflows · N" count in the task list: the catalog lists the latest 64 entries while the
 * projection keeps only 8. The first query on a cold open can still land before the subscription
 * and fail, so the retry semantics below are kept exactly as they are.
 *
 * This logic used to be inlined in `SessionPane`: one shot, and a silent `null` on failure. Since
 * the discovery query's effect is declared before the lease/subscription effect and the CLI
 * dispatches requests strictly serially, opening a historical session after a restart always landed
 * it before the subscription, while the host record was not yet registered → `sessionNotFound` →
 * the whole fallback disappeared, and the card spent the rest of its life stuck in the "compiled
 * but no run" compile state (opening it shows only the script and the static diagram, with no entry
 * to a detail page). The CLI side has added the cold-session precondition; this side adds the other
 * half: the retryable hop actually retries.
 */

/**
 * A missing capability (an old CLI has no such query / the dwf journal is unavailable, so the run
 * service was never constructed) and an ordinary failure must be told apart: the former is a stable
 * fact, and retrying only fires one more doomed RPC for every new pane, while the latter (cold
 * session, connection jitter) succeeds when asked once more.
 *
 * Read the same way as `isWorkflowRunEventsCapabilityMissing`: after an error crosses JSON-RPC,
 * only the message stays reliable, so both patterns are accepted — if the reasonCode is passed
 * through it matches that, otherwise it matches the capability name hardcoded by the constructor.
 * Deliberately **not** counting `sessionNotFound` as a missing capability: that is exactly the case
 * worth retrying.
 */
function isWorkflowRunsCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("listDynamicWorkflowRuns");
}

/**
 * The journal run summaries under a given session name; `null` when nothing is found (or nothing
 * has been found yet) — the whole fallback is absent, the card keeps its "compiled but no run"
 * shape, and it never pretends there is an entry point.
 *
 * `live` is the ready-made signal that "the host record is definitely registered" (the subscription
 * ACK has come back). On a cold open, the false→true transition is the only moment worth retrying,
 * so there is no polling and no backoff here: a failure after `live` is a real failure.
 *
 * `refreshKey` is the only seam for **active** re-fetching after the collapse (the freshness source
 * for the run catalog page and the task list count): the caller supplies a "monotonic count of
 * settled runs", so a run finishing mid-session costs exactly one more paged read. Deliberately not
 * wired to the projection's `revision` — that key bumps on every node event, which would turn one
 * read into a stream.
 */
export function useWorkflowRunJournalSummaries(options: {
  sessionId: string | null;
  live: boolean;
  /**
   * The gate through which the caller declares "this query is meaningful for this pane"; it
   * defaults to true.
   *
   * The journal is keyed by the **parent session**, yet the SessionPane of a nested read-only
   * transcript (dwf actor / subagent) used to fire this query with the child session id without
   * discrimination. Coming back empty-handed is the small part; the big part is that the CLI's
   * cold-session precondition materializes a second (ghost) runtime for a **running** detached
   * session — double-writing the same event log, with the live view frozen at "Worked for xx
   * seconds". The CLI side has collapsed this behind hasLiveConversation; this is the UI-side half
   * of it: a pane that should not ask simply does not ask.
   */
  enabled?: boolean;
  /** This key is absent by default; the count is decided on the CLI side (default 16 / cap 64). */
  limit?: number;
  refreshKey?: number | string;
}): readonly V4ConversationWorkflowRunSummary[] | null {
  const { workflowRuns } = useV4Conversation();
  const { enabled = true, limit, live, refreshKey, sessionId } = options;
  const [summaries, setSummaries] = useState<readonly V4ConversationWorkflowRunSummary[] | null>(
    null,
  );
  /**
   * The **most recently** collapsed session and its answer (a successful summary, or `null` when
   * the capability is missing).
   *
   * What is recorded is the "session + answer" pair, not merely an "already asked" boolean: the
   * pane's `effectiveSessionId` changes (a draft is promoted, forked, or the task is switched), and
   * recording only the session id makes switching back to an already-asked session fail on both
   * counts — it neither early-returns nor re-queries, and it stays empty forever because switching
   * sessions cleared the state. Switching to another session and back re-queries one page of the
   * journal, which is cheap; an entry point that is forever empty is not.
   *
   * `refreshKey` is recorded alongside it: a bump is treated as "this answer went stale" and
   * triggers a re-fetch. **But a missing capability is not affected by it** (see below), which is
   * why that tier keeps a flag of its own instead of being folded into this comparison.
   */
  const settledRef = useRef<{
    sessionId: string;
    refreshKey: number | string | undefined;
    summaries: readonly V4ConversationWorkflowRunSummary[] | null;
  } | null>(null);
  /**
   * A missing capability is a terminal fact **per session**: an old CLI or an unavailable journal
   * does not change just because a run finished. It is recorded apart from the collapse above
   * precisely so that a `refreshKey` bump cannot get through this tier — otherwise every finished
   * run would fire another doomed RPC, which is exactly the churn this classification was written
   * to avoid.
   */
  const capabilityMissingSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setSummaries(null);
      return;
    }
    if (capabilityMissingSessionRef.current === sessionId) {
      setSummaries(null);
      return;
    }
    const settled = settledRef.current;
    if (settled?.sessionId === sessionId && settled.refreshKey === refreshKey) {
      // Answer already available: a `live` rise no longer costs one more RPC (live runs belong to the projection, the journal only backfills history).
      setSummaries(settled.summaries);
      return;
    }
    // Session switch: joining the previous session's runs onto this session's cards would be a wrong join.
    // (A `refreshKey` rise takes the same path: clear → refetch, nothing old is shown before the new answer lands.)
    setSummaries(null);
    let alive = true;
    workflowRuns({ sessionId, ...(limit === undefined ? {} : { limit }) }).then(
      (result) => {
        if (!alive) return;
        settledRef.current = { sessionId, refreshKey, summaries: result.runs };
        setSummaries(result.runs);
      },
      (error: unknown) => {
        if (!alive) return;
        if (isWorkflowRunsCapabilityMissing(error)) {
          capabilityMissingSessionRef.current = sessionId;
        } else {
          // A cold session is the most common case here; a `live` rise will come back automatically; leaving a log trace makes the rest easier to debug.
          logger.warn("[workflow-run] failed to read run summaries (no journal fallback yet)", {
            error: error instanceof Error ? error.message : String(error),
            live,
            sessionId,
          });
        }
        setSummaries(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [enabled, limit, live, refreshKey, sessionId, workflowRuns]);

  return summaries;
}
