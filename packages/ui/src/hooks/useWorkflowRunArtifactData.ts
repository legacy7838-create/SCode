import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORKFLOW_ARTIFACT_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/index.js";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Data fetching for preset dashboards.
 *
 * Invariant: **the dashboard is a projection of the journal**. What is read here are journal rows with `kind = "report"` and a
 * matching `artifact_id`, which the pure function `applyArtifactItems` then folds into charts / tables / tiles / dashboards — any
 * surface (side-panel cards, full-size tabs, cold recovery) gets the same picture from the same batch of rows.
 *
 * ```
 * projected artifacts[id].itemCount rises
 *        │  (refresh signal, may overcount by one — see the note in 3a)
 *        ▼
 *  workflowRunArtifactData({ afterSequence: sequence of the last one received })
 *        │
 *        ▼  keep paging while hasMore is true, until drained
 *   items[] appended  ──▶  applyArtifactItems  ──▶  one more point on the line
 * ```
 */

/**
 * How many pages a single "page until drained" pass may fetch at most. `REPORT_CAPS` is 256 entries / run
 * and the page size is 200, so normally at most two pages; this bound only guards against an implementation that refuses to return `hasMore: false` locking up the render thread.
 */
const MAX_PAGES_PER_DRAIN = 16;

/**
 * When `itemCount` rises again during a fetch, how many follow-up rounds may run before wrapping up (see `pendingRef`).
 * Each round is an incremental read "resuming from the local end"; normally one round drains it.
 */
const MAX_FOLLOW_UP_ROUNDS = 8;

interface WorkflowRunArtifactDataState {
  items: readonly ArtifactItem[];
  loading: boolean;
  /** The session does not support artifact fetching (old CLI): the dashboard cannot be drawn; distinct from "no data yet". */
  unavailable: boolean;
  error: string | null;
}

/** The capability-absence test matches `useWorkflowRunArtifacts`: after crossing JSON-RPC only the message is reliable. */
function isWorkflowRunArtifactDataCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("ArtifactItems");
}

function emptyState(): WorkflowRunArtifactDataState {
  return { items: [], loading: false, unavailable: false, error: null };
}

export function useWorkflowRunArtifactData(options: {
  sessionId: string;
  runId: string;
  artifactId: string;
  /**
   * Refresh signal = the `itemCount` for this id in the projection. A rise triggers an incremental fetch; it may **overcount by one**
   * (a deliberate trade-off recorded in 3a), so treat it only as "maybe there is more", never as the entry count — the real count is
   * `items.length`.
   */
  itemCount?: number;
  enabled?: boolean;
}): WorkflowRunArtifactDataState {
  const { workflowRunArtifactData } = useV4Conversation();
  const [state, setState] = useState<WorkflowRunArtifactDataState>(emptyState);
  const requestVersionRef = useRef(0);
  const inFlightRef = useRef(false);
  /** A new refresh signal arrived mid-fetch: must follow up before wrapping up, or the last point never appears. */
  const pendingRef = useRef(false);
  /**
   * The `sequence` of the last entry received — the cursor for incremental reads.
   *
   * Deliberately a ref rather than reading off the end of `state.items`: after `setState`, `state` only updates on the next render,
   * and the follow-up fetch happens **inside the same async function**, so reading state would get the previous round's end and append the same
   * sequence segment twice.
   */
  const cursorRef = useRef<number | undefined>(undefined);
  /**
   * The `itemCount` last used to resume fetching. `undefined` = no baseline set for this round yet (mount / just switched artifact);
   * that frame's fetching belongs to the full refetch and the incremental effect only records the baseline and exits — otherwise every
   * dashboard mount would fire an incremental query guaranteed to come back empty.
   */
  const lastDrainedCountRef = useRef<number | undefined>(undefined);

  const { artifactId, runId, sessionId } = options;
  const enabled =
    options.enabled !== false && sessionId.length > 0 && runId.length > 0 && artifactId.length > 0;

  /**
   * Page from the cursor all the way to drained. `replace` is a full refetch (switch artifact / switch run), `append` is an incremental append.
   *
   * Single-flight gate (`inFlightRef`): `itemCount` rising again mid-fetch is routine (the script reports once per round), and re-entry
   * would append the same sequence segment twice. The blocked call is **not dropped**; it is recorded on `pendingRef` and followed up by the
   * running one before it wraps up — otherwise a run's **last** report could never be drawn (no further `itemCount` change will come to
   * trigger the next fetch).
   */
  const drain = useCallback(
    async (mode: "replace" | "append") => {
      if (!enabled) return;
      if (inFlightRef.current) {
        pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      const requestVersion = ++requestVersionRef.current;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        let round = 0;
        let currentMode = mode;
        for (;;) {
          pendingRef.current = false;
          const collected: ArtifactItem[] = [];
          let cursor = currentMode === "append" ? cursorRef.current : undefined;
          for (let page = 0; page < MAX_PAGES_PER_DRAIN; page += 1) {
            const result = await workflowRunArtifactData({
              sessionId,
              runId,
              artifactId,
              ...(cursor === undefined ? {} : { afterSequence: cursor }),
              limit: WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
            });
            if (requestVersion !== requestVersionRef.current) return;
            collected.push(...result.items);
            const lastSequence = result.items.at(-1)?.sequence;
            if (lastSequence !== undefined) cursor = lastSequence;
            if (!result.hasMore || result.items.length === 0) break;
          }
          if (requestVersion !== requestVersionRef.current) return;
          cursorRef.current = cursor;
          const settledMode = currentMode;
          setState((current) => ({
            items: settledMode === "replace" ? collected : [...current.items, ...collected],
            loading: false,
            unavailable: false,
            error: null,
          }));
          round += 1;
          if (!pendingRef.current || round >= MAX_FOLLOW_UP_ROUNDS) break;
          currentMode = "append";
        }
      } catch (caught) {
        if (requestVersion !== requestVersionRef.current) return;
        if (isWorkflowRunArtifactDataCapabilityMissing(caught)) {
          setState((current) => ({
            items: mode === "replace" ? [] : current.items,
            loading: false,
            unavailable: true,
            error: null,
          }));
          return;
        }
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.warn("[workflow-artifacts] failed to read board entries", {
          artifactId,
          error: message,
          runId,
          sessionId,
        });
        setState((current) => ({ ...current, loading: false, error: message }));
      } finally {
        inFlightRef.current = false;
        pendingRef.current = false;
      }
    },
    [artifactId, enabled, runId, sessionId, workflowRunArtifactData],
  );

  // Switch artifact / switch run / off to on: clear first, then full refetch. Another dashboard's points must never linger on this canvas.
  useEffect(() => {
    requestVersionRef.current += 1;
    cursorRef.current = undefined;
    lastDrainedCountRef.current = undefined;
    setState(emptyState());
    if (!enabled) return;
    void drain("replace");
  }, [drain, enabled]);

  // Incremental: resume fetching as soon as `itemCount` rises.
  //
  // The gate has **no** "skip if the local side has not a single entry" rule: a dashboard declared at the top of the script and only fed
  // data by reports each round is empty locally the moment it mounts, and blocking on emptiness would mean it could never draw its first point.
  // The duplicate trigger at mount is swallowed by the single-flight gate (the refetch effect runs first and already holds the gate).
  const itemCount = options.itemCount ?? 0;
  useEffect(() => {
    if (!enabled) return;
    // First frame of this round: the full refetch is running, so only record the baseline here. Effect declaration order guarantees the refetch one runs first.
    if (lastDrainedCountRef.current === undefined) {
      lastDrainedCountRef.current = itemCount;
      return;
    }
    if (itemCount === lastDrainedCountRef.current) return;
    lastDrainedCountRef.current = itemCount;
    void drain("append");
  }, [drain, enabled, itemCount]);

  return useMemo(() => state, [state]);
}
