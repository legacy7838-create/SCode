import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IZCodeTaskService, ZCodeTaskListItem, ZCodeTaskListKind } from "@zcode/services";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { stabilizeTaskListItems } from "@/v4/taskListItemStabilization.js";
import { mergeGlobalTaskListResults } from "@/lib/globalTaskListMerge.js";
import { resolveWorkspaceServices } from "@/lib/workspaceServiceResolver.js";
import type { ZCodeWorkspaceEvent } from "@zcode/shared";

type GlobalTaskListItem = ZCodeTaskListItem;

/**
 * The Window Host Controller channel has no host implementation since the Electron cutover
 * (see docs/specs/window-controller-availability.md). This hook therefore aggregates per
 * workspace scope over each scope's own zcodeTaskService.listTaskList — the documented
 * authoritative renderer-side path. It never fabricates the controller contract.
 */
export function useGlobalTaskList(params: {
  kind: ZCodeTaskListKind;
  workspaceTabs: WorkspaceTabState[];
  sortBy: "created" | "updated";
  searchQuery: string;
  expanded: boolean;
  collapsedLimit: number;
}) {
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );

  const workspaceSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath] as const,
      )
      .sort(
        ([leftKey, leftPath], [rightKey, rightPath]) =>
          leftKey.localeCompare(rightKey) || leftPath.localeCompare(rightPath),
      ),
  );

  /**
   * One resolved query source per unique workspace scope. Remote tabs must resolve to their live
   * session before they produce a source; a disconnected placeholder is skipped instead of being
   * queried against local sqlite (which would cache a wrong empty result).
   */
  const resolvedScopes = useMemo(() => {
    const byKey = new Map<
      string,
      {
        scopeKey: string;
        workspacePath: string;
        workspaceIdentity?: string;
        remoteSessionId?: string;
        taskService: IZCodeTaskService;
      }
    >();
    for (const tab of params.workspaceTabs) {
      const scopeKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
      const resolved = resolveWorkspaceServices(
        {
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
          remoteSessionId: tab.remoteSessionId,
        },
        baseServices,
        serviceResolverState,
      );
      if (!resolved) {
        continue;
      }
      byKey.set(scopeKey, {
        scopeKey,
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(resolved.remoteSessionId ? { remoteSessionId: resolved.remoteSessionId } : {}),
        taskService: resolved.services.zcodeTaskService,
      });
    }
    return Array.from(byKey.values());
    // workspaceSignature is a normalized signature of the scope values, avoiding repeated
    // resolution when the parent rebuilds the tabs array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseServices, serviceResolverState, workspaceSignature, params.workspaceTabs]);

  const resolvedScopesSignature = JSON.stringify(
    resolvedScopes.map((scope) => [scope.scopeKey, scope.remoteSessionId ?? "local"]),
  );

  const limit = params.expanded ? undefined : params.collapsedLimit;

  const resolvedScopesRef = useRef(resolvedScopes);
  resolvedScopesRef.current = resolvedScopes;

  const [items, setItems] = useState<GlobalTaskListItem[]>([]);
  const itemsRef = useRef<GlobalTaskListItem[]>(items);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(resolvedScopes.length > 0);
  const requestSerialRef = useRef(0);

  const load = useCallback(async () => {
    const requestSerial = ++requestSerialRef.current;
    const scopes = resolvedScopesRef.current;
    if (scopes.length === 0) {
      setItems([]);
      itemsRef.current = [];
      setTotal(0);
      setHasMore(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const results = await Promise.all(
        scopes.map(async (scope) => {
          try {
            return await scope.taskService.listTaskList({
              kind: params.kind,
              workspaceScopes: [
                {
                  workspacePath: scope.workspacePath,
                  ...(scope.workspaceIdentity
                    ? { workspaceIdentity: scope.workspaceIdentity }
                    : {}),
                },
              ],
              sortBy: params.sortBy,
              search: params.searchQuery.trim() || undefined,
              limit,
            });
          } catch (error) {
            // A single scope's failure must not empty the other workspaces; keep its shard empty
            // for this round and log — the next event or refresh retries it.
            logger.error(
              `[useGlobalTaskList] failed to load ${params.kind} list for workspace ${scope.scopeKey}`,
              error,
            );
            return { items: [] as GlobalTaskListItem[], total: 0, hasMore: false };
          }
        }),
      );
      if (requestSerialRef.current !== requestSerial) {
        return;
      }
      const merged = mergeGlobalTaskListResults({
        shards: results,
        sortBy: params.sortBy,
        limit,
      });
      const nextItems = stabilizeTaskListItems(itemsRef.current, merged.items);
      itemsRef.current = nextItems;
      setItems(nextItems);
      setTotal(merged.total);
      setHasMore(merged.hasMore);
    } finally {
      if (requestSerialRef.current === requestSerial) {
        setLoading(false);
      }
    }
  }, [limit, params.kind, params.searchQuery, params.sortBy]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load, resolvedScopesSignature]);

  // Membership changes (archive/unarchive/pin, remote mutations) arrive as low-frequency
  // workspace_task_list_changed events per scope. One event triggers exactly one re-query here;
  // the consumer caches that share this event (taskQueryCacheStore) deduplicate by their own
  // membership version.
  useEffect(() => {
    if (resolvedScopes.length === 0) {
      return;
    }
    const scopes = resolvedScopes;
    const disposables = scopes.map((scope) =>
      scope.taskService.onDynamicWorkspaceEvent({
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      })((event: ZCodeWorkspaceEvent) => {
        if (event.type !== "workspace_task_list_changed") {
          return;
        }
        const eventWorkspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
        if (eventWorkspaceKey !== scope.scopeKey) {
          return;
        }
        void load();
      }),
    );
    return () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    };
  }, [load, resolvedScopes]);

  const hasRemoteScope = params.workspaceTabs.some((tab) => Boolean(tab.workspaceIdentity));
  return {
    items,
    total,
    hasMore,
    loading,
    syncingRemoteWorkspaces: loading && hasRemoteScope,
    refresh,
  };
}
