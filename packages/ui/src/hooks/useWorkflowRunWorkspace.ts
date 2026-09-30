import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowRunWorkspaceNode } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * The script transcript list of a workflow run.
 *
 * ```
 * live projection run.lastEventSequence rises ──┐(refresh signal: every node event raises it)
 *                                              ├─▶ workflowRunWorkspace({sessionId, runId}) ─▶ nodes[]
 * tab opens / run switch ──────────────────────┘
 * ```
 *
 * The list carries **no bodies**, so refetching is cheap; bodies are fetched on demand in `useWorkflowRunNodeResult`. After the signal
 * rises, debounce 250 ms more before querying: around one `world.run` settlement there are queued / dispatched / settled events, and
 * refetching per event would just read the same list three times.
 */

const REFRESH_DEBOUNCE_MS = 250;

interface WorkflowRunWorkspaceState {
  nodes: readonly WorkflowRunWorkspaceNode[];
  /** Successfully read at least once (both the placeholder and the landing point wait on it). */
  loaded: boolean;
  loading: boolean;
  /** The list was truncated by the gateway (over maxNodes). */
  truncated: boolean;
  /** The session does not support workspace queries (old CLI). */
  unavailable: boolean;
  error: string | null;
}

/** The capability-absence test matches the artifact hook: after crossing JSON-RPC only the message is reliable. */
function isWorkflowRunWorkspaceCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("WorkspaceNodes");
}

export function useWorkflowRunWorkspace(options: {
  sessionId: string;
  runId: string;
  /** Refresh signal: the run's `lastEventSequence` in the live projection; absent when the run is not in the projection (queried once). */
  refreshSignal?: number;
  enabled?: boolean;
}): WorkflowRunWorkspaceState {
  const { workflowRunWorkspace } = useV4Conversation();
  const [nodes, setNodes] = useState<readonly WorkflowRunWorkspaceNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Request version: late responses after a run switch / session switch must be discarded.
  const requestVersionRef = useRef(0);

  const { runId, sessionId } = options;
  const enabled = options.enabled !== false && sessionId.length > 0 && runId.length > 0;

  const fetchNodes = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    try {
      const result = await workflowRunWorkspace({ sessionId, runId });
      if (requestVersion !== requestVersionRef.current) return;
      setNodes(result.nodes);
      setTruncated(result.truncated === true);
      setUnavailable(false);
      setError(null);
      setLoaded(true);
      setLoading(false);
    } catch (caught) {
      if (requestVersion !== requestVersionRef.current) return;
      setLoading(false);
      if (isWorkflowRunWorkspaceCapabilityMissing(caught)) {
        setUnavailable(true);
        setLoaded(true);
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.warn("[workflow-workspace] failed to read the workspace list", {
        error: message,
        runId,
        sessionId,
      });
      setError(message);
    }
  }, [runId, sessionId, workflowRunWorkspace]);

  // Switch run / switch session: drop the old list first, then refetch.
  useEffect(() => {
    requestVersionRef.current += 1;
    setNodes([]);
    setLoaded(false);
    setTruncated(false);
    setUnavailable(false);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    void fetchNodes();
  }, [enabled, fetchNodes]);

  // Signal rise: refetch after the debounce. The first-mount beat is handled by the effect above; skip undefined here.
  const signal = options.refreshSignal;
  const lastSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled || signal === undefined) return;
    if (lastSignalRef.current === undefined) {
      lastSignalRef.current = signal;
      return;
    }
    if (signal <= lastSignalRef.current) return;
    lastSignalRef.current = signal;
    const timer = window.setTimeout(() => {
      void fetchNodes();
    }, REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, fetchNodes, signal]);

  return useMemo(
    () => ({ nodes, loaded, loading, truncated, unavailable, error }),
    [error, loaded, loading, nodes, truncated, unavailable],
  );
}
