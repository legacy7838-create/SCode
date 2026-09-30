import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeSessionEndedSubagent, ZCodeSessionSubagentsResult } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

interface SessionSubagentsViewState {
  revision: number;
  ended: ZCodeSessionSubagentsResult["ended"];
  error: string | null;
  loading: boolean;
}

function emptyState(): SessionSubagentsViewState {
  return {
    revision: 0,
    ended: { total: 0, items: [] },
    error: null,
    loading: false,
  };
}

function mergeEndedSubagentPages(
  current: readonly ZCodeSessionEndedSubagent[],
  incoming: readonly ZCodeSessionEndedSubagent[],
): ZCodeSessionEndedSubagent[] {
  const currentIds = new Set(current.map((item) => item.childSessionId));
  return [...current, ...incoming.filter((item) => !currentIds.has(item.childSessionId))];
}

function resolveEndedSubagentRefreshTargetCount(options: {
  loadedItemCount: number;
  nextTotal: number;
  previousTotal: number;
  requestedCount: number;
}): number {
  if (options.loadedItemCount === 0) return options.requestedCount;
  return options.requestedCount + Math.max(0, options.nextTotal - options.previousTotal);
}

export function useSessionSubagents(options: {
  enabled?: boolean;
  refreshKey?: string | number | null;
  remoteSessionId?: string;
  sessionId?: string | null;
  workspaceIdentity?: string;
  workspacePath: string;
}) {
  const services = useServices();
  const zcodeAgentService = services.zcodeAgentService;
  const [state, setState] = useState<SessionSubagentsViewState>(emptyState);
  const requestVersionRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const loadedEndedCountRef = useRef(PAGE_SIZE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const enabled = options.enabled !== false && Boolean(options.sessionId);

  const requestPage = useCallback(
    (endedLimit: number, endedCursor?: string): Promise<ZCodeSessionSubagentsResult> => {
      if (!options.sessionId) return Promise.reject(new Error("session_id_missing"));
      if (typeof zcodeAgentService?.listSessionSubagents !== "function") {
        return Promise.resolve({
          revision: 0,
          childSessionIds: [],
          running: [],
          ended: { total: 0, items: [] },
        });
      }
      return zcodeAgentService.listSessionSubagents({
        workspacePath: options.workspacePath,
        ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
        ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
        sessionId: options.sessionId,
        endedLimit,
        ...(endedCursor ? { endedCursor } : {}),
      });
    },
    [
      options.remoteSessionId,
      options.sessionId,
      options.workspaceIdentity,
      options.workspacePath,
      zcodeAgentService,
    ],
  );

  const refresh = useCallback(async () => {
    if (!enabled) {
      setState(emptyState());
      return;
    }
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    const requestVersion = ++requestVersionRef.current;
    setState((current) => ({ ...current, loading: current.revision === 0, error: null }));
    try {
      const requestedCount = Math.max(PAGE_SIZE, loadedEndedCountRef.current);
      let response = await requestPage(Math.min(requestedCount, MAX_PAGE_SIZE));
      const previous = stateRef.current;
      // Newly finished items are inserted at the top of ended. Fetch the same number of older items so a refresh
      // does not push items the user already loaded at the catalog bottom out of the current in-memory page; the browser scroll anchor can keep visible rows in place.
      const targetCount = resolveEndedSubagentRefreshTargetCount({
        loadedItemCount: previous.ended.items.length,
        nextTotal: response.ended.total,
        previousTotal: previous.ended.total,
        requestedCount,
      });
      let items = response.ended.items;
      let cursor = response.ended.nextCursor;
      while (items.length < targetCount && cursor) {
        const page = await requestPage(Math.min(PAGE_SIZE, targetCount - items.length), cursor);
        items = mergeEndedSubagentPages(items, page.ended.items);
        cursor = page.ended.nextCursor;
        response = page;
      }
      if (requestVersion !== requestVersionRef.current) return;
      loadedEndedCountRef.current = Math.max(PAGE_SIZE, items.length);
      setState({
        revision: response.revision,
        ended: {
          total: response.ended.total,
          items,
          ...(cursor ? { nextCursor: cursor } : {}),
        },
        error: null,
        loading: false,
      });
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[subagent-directory] failed to read the subagent directory", {
        error: message,
        sessionId: options.sessionId,
        workspaceKey: options.workspaceIdentity?.trim() || options.workspacePath,
      });
      setState((current) => ({ ...current, error: message, loading: false }));
    } finally {
      requestInFlightRef.current = false;
    }
  }, [
    enabled,
    options.remoteSessionId,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
    requestPage,
  ]);

  const loadMore = useCallback(async () => {
    const current = stateRef.current;
    if (!enabled || current.loading || requestInFlightRef.current || !current.ended.nextCursor) {
      return;
    }
    requestInFlightRef.current = true;
    const requestVersion = ++requestVersionRef.current;
    setState((value) => ({ ...value, loading: true, error: null }));
    try {
      const response = await requestPage(PAGE_SIZE, current.ended.nextCursor);
      if (requestVersion !== requestVersionRef.current) return;
      const items = mergeEndedSubagentPages(current.ended.items, response.ended.items);
      loadedEndedCountRef.current = Math.max(PAGE_SIZE, items.length);
      setState({
        revision: response.revision,
        ended: {
          total: response.ended.total,
          items,
          ...(response.ended.nextCursor ? { nextCursor: response.ended.nextCursor } : {}),
        },
        error: null,
        loading: false,
      });
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return;
      setState((value) => ({
        ...value,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      }));
    } finally {
      requestInFlightRef.current = false;
    }
  }, [enabled, requestPage]);

  useEffect(() => {
    loadedEndedCountRef.current = PAGE_SIZE;
    setState(emptyState());
    return () => {
      requestVersionRef.current += 1;
    };
  }, [
    options.remoteSessionId,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
  ]);

  useEffect(() => {
    void refresh();
  }, [options.refreshKey, refresh]);

  return { ...state, loadMore, refresh };
}
