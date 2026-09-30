/* eslint-disable max-lines -- the workspace row task list needs to keep sharded querying, cached
 * display, and cross-device membership subscription inside one hook; splitting it up would add
 * cache-consistency risk.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeSessionStore, selectWorkspaceZCodeState } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  buildTaskListCacheKeyFromDescriptor,
  buildTaskWorkspaceKey,
} from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  isRemoteWorkspaceTarget,
  resolveWorkspaceRemoteSessionId,
  resolveWorkspaceServices,
} from "@/lib/workspaceServiceResolver.js";
import { useWorkspaceTaskOptimisticOverlayByWorkspaceKey } from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import {
  buildWorkspaceTaskListDisplayGroups,
  type WorkspaceTaskListGroup,
} from "@/hooks/workspaceTaskListDisplayGroups.js";
import {
  buildWorkspaceRemoteSessionSignature,
  buildWorkspaceTaskListVersionSignature,
} from "@/hooks/workspaceTaskListRefreshSignatures.js";
import { shouldRefetchTaskListMembershipForWorkspaceEvent } from "@/lib/taskListRefreshPolicy.js";
import { syncTaskUnreadFromStatusWorkspaceEvent } from "@/lib/taskStatusUnreadSync.js";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { fetchTaskListMembershipSetsForEndpointsCached } from "@/lib/taskListMembershipSets.js";
import { buildTaskListResult } from "@/v4/buildTaskListResultFromSessions.js";
import {
  bumpTaskListMembershipVersionForWorkspaceEvent,
  useTaskListMembershipVersion,
} from "@/v4/taskListMembershipVersion.js";
import {
  buildWorkspaceSessionsIndexSourceKey,
  useWorkspaceSessionsIndexItems,
} from "@/v4/useWorkspaceSessionsIndexItems.js";
import { resolveWorkspaceTaskVisibleLimit } from "@/lib/workspaceTaskPagination.js";

interface WorkspaceTaskListQueryConfig {
  scope: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  workspaceKey: string;
  remoteSessionId?: string;
  isRemoteWorkspace: boolean;
  visibleLimit: number;
  descriptor: ReturnType<typeof buildTaskListCacheDescriptor>;
  queryKey: string;
}

interface WorkspaceTaskListEndpointShard {
  shardKey: string;
  services: IServiceAccessor;
  configs: WorkspaceTaskListQueryConfig[];
}

interface WorkspaceTaskListGroupResult {
  workspacePath: string;
  workspaceIdentity?: string;
  items: ZCodeTaskMeta[];
  total: number;
  hasMore: boolean;
  unreadTaskKeys: string[];
}

interface WorkspaceTaskListRefreshFlight {
  requestId: number;
  signature: string;
  activityRevision: string;
  membershipVersion: number;
}

function updateBlockingLoadingState(
  current: Record<string, boolean>,
  blockingWorkspaceKeys: string[],
): Record<string, boolean> {
  const uniqueKeys = [...new Set(blockingWorkspaceKeys)];
  const currentKeys = Object.keys(current);
  if (
    currentKeys.length === uniqueKeys.length &&
    uniqueKeys.every((workspaceKey) => current[workspaceKey] === true)
  ) {
    return current;
  }
  return Object.fromEntries(uniqueKeys.map((workspaceKey) => [workspaceKey, true]));
}

// Workspace grouping treats tasks-index task rows as the persistent rows; sessions-index only backfills activity/detail.
// A remote shard uses its own endpoint task service and returns a group map shaped like the old protocol.
async function buildWorkspaceGroupsFromSessions(params: {
  service: IServiceAccessor["zcodeTaskService"];
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  sessions: ZCodeTaskMeta[];
  sortBy: "created" | "updated";
  /**
   * Incremental update: membership only changes with membershipVersion, so caching per version
   * avoids refetching on every content frame.
   */
  membershipCacheKey: string;
}): Promise<Map<string, WorkspaceTaskListGroupResult>> {
  const {
    taskIndexItems,
    pinnedIds,
    archivedIds,
    deletedIds,
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  } = await fetchTaskListMembershipSetsForEndpointsCached({
    cacheKey: params.membershipCacheKey,
    endpoints: [{ service: params.service, scopes: params.scopes }],
  });
  const map = new Map<string, WorkspaceTaskListGroupResult>();
  for (const scope of params.scopes) {
    const scopeKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
    const scopeSessions = params.sessions.filter(
      (task) => buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === scopeKey,
    );
    const scopeTaskIndexItems = taskIndexItems.filter(
      (task) => buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === scopeKey,
    );
    // The "workspace" view rule = !pinned && !archived, same as "timeline" (matchesTaskMembership).
    const result = buildTaskListResult({
      taskIndexItems: scopeTaskIndexItems,
      sessions: scopeSessions,
      kind: "timeline",
      pinnedIds,
      archivedIds,
      deletedIds,
      unreadAtByTaskId,
      terminalStatusByTaskId,
      titleOverrideByTaskId,
      cronAutomationIdByTaskId,
      sortBy: params.sortBy,
    });
    map.set(scopeKey, {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      items: result.items,
      total: result.total,
      hasMore: false,
      // Workspace tasks are paginated before entering the query cache; checking only the visible items
      // would make collapsed rows miss unread beyond the pagination window. Solidify the membership keys over the complete regular-task result first.
      unreadTaskKeys: result.items
        .filter((task) => typeof task.unreadAt === "number")
        .map((task) => buildTaskEntityKey(task)),
    });
  }
  return map;
}

/**
 * Reference stabilization for the sessions-index aggregation layer it depends on: an unchanged
 * entry reference means equivalent content. Only the workspaces owning entries whose references
 * differ between the previous and the current `items` count as "changed".
 */
function diffChangedWorkspaceKeys(previous: ZCodeTaskMeta[], next: ZCodeTaskMeta[]): Set<string> {
  const changed = new Set<string>();
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  for (const item of next) {
    if (!previousSet.has(item)) {
      changed.add(buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity));
    }
  }
  for (const item of previous) {
    if (!nextSet.has(item)) {
      changed.add(buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity));
    }
  }
  return changed;
}

function buildWorkspaceEventSubscriptionSignature(
  shards: WorkspaceTaskListEndpointShard[],
): string {
  return shards
    .map((shard) => {
      const workspaceKeys = [...new Set(shard.configs.map((config) => config.workspaceKey))].sort(
        (left, right) => left.localeCompare(right),
      );
      return `${shard.shardKey}:${workspaceKeys.join("|")}`;
    })
    .join("||");
}

export function useWorkspaceTaskLists(params: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  sortBy: "created" | "updated";
  visibleLimitByWorkspaceKey: Readonly<Record<string, number>>;
  defaultVisibleLimit: number;
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
  const setQueryResults = useTaskQueryCacheStore((state) => state.setQueryResults);
  const resultsByQueryKey = useTaskQueryCacheStore((state) => state.resultsByQueryKey);
  const taskMetaByEntityKey = useTaskQueryCacheStore((state) => state.taskMetaByEntityKey);
  const taskUnreadOverlayByEntityKey = useTaskQueryCacheStore(
    (state) => state.taskUnreadOverlayByEntityKey,
  );
  const inFlightRequestRef = useRef<WorkspaceTaskListRefreshFlight | null>(null);
  const nextRequestIdRef = useRef(0);
  const rerunRequestedRef = useRef(false);
  const groupCacheRef = useRef<Map<string, WorkspaceTaskListGroup>>(new Map());
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    buildWorkspaceTaskListVersionSignature(
      params.workspaceTabs.map((tab) => {
        const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
        const workspaceState = selectWorkspaceZCodeState(
          state,
          tab.workspacePath,
          tab.workspaceIdentity,
        );
        return [workspaceKey, workspaceState.taskListVersion] as const;
      }),
    ),
  );
  const optimisticTaskOverlayByWorkspaceKey = useWorkspaceTaskOptimisticOverlayByWorkspaceKey(
    params.workspaceTabs,
  );
  const taskListVersionByWorkspaceKey = useMemo(
    () => new Map<string, number>(JSON.parse(taskListVersionSignature) as Array<[string, number]>),
    [taskListVersionSignature],
  );
  const remoteSessionSignature = useMemo(
    () =>
      buildWorkspaceRemoteSessionSignature(
        params.workspaceTabs.map((tab) => {
          const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
          const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(
            tab,
            serviceResolverState,
          );
          return {
            workspaceKey,
            remoteSessionId: resolvedRemoteSessionId,
            ready: resolvedRemoteSessionId ? Boolean(sessionsById[resolvedRemoteSessionId]) : true,
          };
        }),
      ),
    [params.workspaceTabs, serviceResolverState, sessionsById],
  );
  const activeWorkspaceKey = useMemo(
    () => buildTaskWorkspaceKey(params.activeWorkspacePath, params.activeWorkspaceIdentity),
    [params.activeWorkspaceIdentity, params.activeWorkspacePath],
  );
  const activeWorkspaceRef = useRef({
    workspacePath: params.activeWorkspacePath,
    ...(params.activeWorkspaceIdentity
      ? { workspaceIdentity: params.activeWorkspaceIdentity }
      : {}),
  });
  // When switching workspaces the old workspace keeps its own activeTaskId; the terminal-state subscription is also
  // reused long-term per endpoint/workspace set. A callback that only looks at the old workspace's activeTaskId, or captures the global
  // focus from the first render, would misjudge a task that has moved to the background as "still being read" and miss the unread badge.
  activeWorkspaceRef.current = {
    workspacePath: params.activeWorkspacePath,
    ...(params.activeWorkspaceIdentity
      ? { workspaceIdentity: params.activeWorkspaceIdentity }
      : {}),
  };
  const queryConfigs = useMemo(
    () =>
      params.workspaceTabs.map((tab) => {
        const scope = {
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
        };
        const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(tab, serviceResolverState);
        const isRemoteWorkspace = isRemoteWorkspaceTarget(tab, resolvedRemoteSessionId);
        const workspaceKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
        const visibleLimit = resolveWorkspaceTaskVisibleLimit(
          params.visibleLimitByWorkspaceKey,
          workspaceKey,
          params.defaultVisibleLimit,
        );
        const descriptor = buildTaskListCacheDescriptor({
          kind: "workspace",
          workspaceScopes: [scope],
          sortBy: params.sortBy,
          search: "",
          expanded: false,
          visibleLimit,
        });
        return {
          scope,
          workspaceKey,
          remoteSessionId: resolvedRemoteSessionId,
          isRemoteWorkspace,
          visibleLimit,
          descriptor,
          // Previously every workspace group's queryKey spliced in a "version signature of all tabs".
          // After archiving a local task, other workspaces' queryKeys changed at the same time and the old cache
          // was invalidated instantly; with a remote connection the refresh was even slower, and every local workspace showed No tasks yet.
          // Now only the current workspace's own version is used, so unrelated workspaces are not cleared along with it.
          queryKey:
            buildTaskListCacheKeyFromDescriptor(descriptor) +
            `::version=${taskListVersionByWorkspaceKey.get(workspaceKey) ?? 0}`,
        };
      }),
    [
      params.defaultVisibleLimit,
      params.sortBy,
      params.visibleLimitByWorkspaceKey,
      params.workspaceTabs,
      serviceResolverState,
      taskListVersionByWorkspaceKey,
    ],
  );
  const endpointShards = useMemo(() => {
    const shardMap = new Map<
      string,
      {
        services: IServiceAccessor;
        configs: WorkspaceTaskListQueryConfig[];
      }
    >();

    for (const config of queryConfigs) {
      const resolvedServices = resolveWorkspaceServices(
        {
          ...config.scope,
          remoteSessionId: config.remoteSessionId,
        },
        baseServices,
        serviceResolverState,
      );
      if (!resolvedServices) {
        continue;
      }

      const shardKey = resolvedServices.remoteSessionId ?? "__base__";

      const shard = shardMap.get(shardKey) ?? {
        services: resolvedServices.services,
        configs: [],
      };
      shard.configs.push(config);
      shardMap.set(shardKey, shard);
    }

    return [...shardMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map<WorkspaceTaskListEndpointShard>(([shardKey, shard]) => ({
        shardKey,
        services: shard.services,
        configs: shard.configs,
      }));
  }, [baseServices, queryConfigs, serviceResolverState]);
  const endpointShardsRef = useRef(endpointShards);
  endpointShardsRef.current = endpointShards;
  const workspaceEventSubscriptionSignature = useMemo(
    () => buildWorkspaceEventSubscriptionSignature(endpointShards),
    [endpointShards],
  );
  // List data source = sessions-index. Remote shards (web/mobile remote control/SSH workspaces)
  // also go through sessions-index — the scope carries the endpoint dimension and that endpoint's agentService proxy;
  // tabs whose remote session is not yet resolved (disconnected placeholders) are not in endpointShards and get subscribed automatically after reconnect.
  const sessionsIndexScopes = useMemo(
    () =>
      endpointShards.flatMap((shard) =>
        shard.configs.map((config) => ({
          workspacePath: config.scope.workspacePath,
          ...(config.scope.workspaceIdentity
            ? { workspaceIdentity: config.scope.workspaceIdentity }
            : {}),
          ...(shard.shardKey === "__base__" ? {} : { endpointKey: shard.shardKey }),
          agentService: shard.services.zcodeAgentService,
        })),
      ),
    [endpointShards],
  );
  const { items: sessionsIndexItems, sourceRevisionByScopeKey } =
    useWorkspaceSessionsIndexItems(sessionsIndexScopes);
  // pin/archive membership version: bumped after a mutation (local optimistic or remote event), driving the authoritative re-filter.
  const membershipVersion = useTaskListMembershipVersion();
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const pendingConfigs = useMemo(() => {
    const pending = queryConfigs.filter((config) => {
      const cachedResult = resultsByQueryKey[config.queryKey];
      return cachedResult == null || cachedResult.stale;
    });
    const activePending = pending.filter((config) => config.workspaceKey === activeWorkspaceKey);
    if (activePending.length > 0) {
      // On cold start, querying every historical workspace at once competes with the current workspace's model readState for resources,
      // leaving "Managing model/Loading" stuck at the bottom of the input box. Ensure the current workspace's task list and model state finish first here,
      // and backfill other workspaces in the background once the current cache lands.
      return activePending;
    }
    return pending;
  }, [activeWorkspaceKey, queryConfigs, resultsByQueryKey]);
  const sessionsIndexRevision = useMemo(
    () =>
      pendingConfigs
        .map((config) => {
          const sourceKey = buildWorkspaceSessionsIndexSourceKey({
            workspacePath: config.scope.workspacePath,
            ...(config.scope.workspaceIdentity
              ? { workspaceIdentity: config.scope.workspaceIdentity }
              : {}),
            ...(config.remoteSessionId ? { endpointKey: config.remoteSessionId } : {}),
          });
          return `${sourceKey}=${sourceRevisionByScopeKey[sourceKey] ?? "missing"}`;
        })
        .sort()
        .join("|"),
    [pendingConfigs, sourceRevisionByScopeKey],
  );
  const requestSignature = useMemo(
    () =>
      [
        params.sortBy,
        taskListVersionSignature,
        remoteSessionSignature,
        `activity=${sessionsIndexRevision}`,
        `membership=${membershipVersion}`,
        ...pendingConfigs.map(
          (config) =>
            `${config.workspaceKey}:${config.remoteSessionId ?? "base"}:limit=${config.visibleLimit}:${config.queryKey}:invalidation=${resultsByQueryKey[config.queryKey]?.invalidationVersion ?? 0}`,
        ),
      ].join("||"),
    [
      membershipVersion,
      pendingConfigs,
      params.sortBy,
      remoteSessionSignature,
      resultsByQueryKey,
      sessionsIndexRevision,
      taskListVersionSignature,
    ],
  );
  const latestRefreshInputRef = useRef({
    requestSignature,
    sessionsIndexRevision,
    membershipVersion,
  });
  latestRefreshInputRef.current = {
    requestSignature,
    sessionsIndexRevision,
    membershipVersion,
  };

  const refresh = useCallback(async () => {
    if (pendingConfigs.length === 0) {
      if (inFlightRequestRef.current === null) {
        setLoading((current) => updateBlockingLoadingState(current, []));
      }
      return;
    }

    const currentFlight = inFlightRequestRef.current;
    if (currentFlight) {
      if (currentFlight.signature !== requestSignature) {
        // While a membership RPC for the same list query is in flight, sessions-index can still converge from
        // running to completed/error. With single-flight keyed only on the query signature, the second invalidation
        // would be swallowed; record here that the latest input arrived, and after the current flight closes another round must run.
        rerunRequestedRef.current = true;
      }
      return;
    }

    const requestId = ++nextRequestIdRef.current;
    const flight: WorkspaceTaskListRefreshFlight = {
      requestId,
      signature: requestSignature,
      activityRevision: sessionsIndexRevision,
      membershipVersion,
    };
    inFlightRequestRef.current = flight;
    const sessionsForRequest = sessionsIndexItems;
    const expectedInvalidationVersionByQueryKey = new Map(
      pendingConfigs.map((config) => [
        config.queryKey,
        resultsByQueryKey[config.queryKey]?.invalidationVersion ?? 0,
      ]),
    );
    // A status/title change in sessions-index marks existing queries stale and recomputes them in the background.
    // Stale results are still safe to display; setting loading here too would make clicking/restoring a historical task switch the whole
    // workspace row's loading prop, and combined with a hard invalidation it would flash straight to "Fetching tasks". Only the very first
    // hydration with no cache at all is a blocking loading; existing caches uniformly use stale-while-revalidate.
    const blockingWorkspaceKeys = pendingConfigs
      .filter((config) => {
        if (resultsByQueryKey[config.queryKey] != null) {
          return false;
        }
        const previousGroup = groupCacheRef.current.get(config.workspaceKey);
        return !previousGroup || (previousGroup.items.length === 0 && previousGroup.total === 0);
      })
      .map((config) => config.workspaceKey);
    setLoading((current) => updateBlockingLoadingState(current, blockingWorkspaceKeys));

    try {
      const pendingConfigKeys = new Set(pendingConfigs.map((config) => config.queryKey));
      const entries = (
        await Promise.all(
          endpointShards.map(async (shard) => {
            const shardConfigs = shard.configs.filter((config) =>
              pendingConfigKeys.has(config.queryKey),
            );
            if (shardConfigs.length === 0) {
              return [];
            }

            // Both the local and remote shards build membership sets from their own endpoint's tasks-index rows,
            // then enrich with activity/detail from the same endpoint/workspace's sessions-index.
            const groupByWorkspaceKey = await buildWorkspaceGroupsFromSessions({
              service: shard.services.zcodeTaskService,
              scopes: shardConfigs.map((config) => config.scope),
              sessions: sessionsForRequest,
              sortBy: params.sortBy,
              membershipCacheKey: `${membershipVersion}::workspace::${shard.shardKey}::${shardConfigs
                .map((config) => `${config.workspaceKey}@${taskListVersionSignature}`)
                .join("|")}`,
            });

            return shardConfigs.map((config) => {
              const group = groupByWorkspaceKey.get(config.workspaceKey) ?? {
                workspacePath: config.scope.workspacePath,
                workspaceIdentity: config.scope.workspaceIdentity,
                items: [],
                total: 0,
                hasMore: false,
                unreadTaskKeys: [],
              };
              const visibleItems = group.items.slice(0, config.visibleLimit);
              return {
                queryKey: config.queryKey,
                descriptor: config.descriptor,
                items: visibleItems,
                total: group.total,
                hasMore: group.total > visibleItems.length,
                unreadTaskKeys: group.unreadTaskKeys,
                expectedInvalidationVersion: expectedInvalidationVersionByQueryKey.get(
                  config.queryKey,
                ),
              };
            });
          }),
        )
      ).flat();

      // Previously each workspace's queryKey set the cache individually, and the effect depended on the whole
      // resultsByQueryKey, so "just wrote the first group of results and already judged more missing, triggering another refresh round".
      // Now write in one batch so a single query round produces exactly one store update, breaking the refresh chain.
      // A remote workspace's task index lives in remote sqlite; base services must not be used to query local sqlite.
      // Requests are sharded by remoteSessionId here; while the remote session is not yet registered no empty cache is written, and the query reruns once the session arrives.
      const latestInput = latestRefreshInputRef.current;
      const canCommit =
        inFlightRequestRef.current?.requestId === requestId &&
        latestInput.requestSignature === flight.signature &&
        latestInput.sessionsIndexRevision === flight.activityRevision &&
        latestInput.membershipVersion === flight.membershipVersion;
      if (entries.length > 0 && canCommit) {
        setQueryResults(entries);
      } else if (!canCommit) {
        // Stale activity/membership results must not write to the entity cache or clear stale; the finally block triggers the latest round.
        rerunRequestedRef.current = true;
      }
    } catch (error) {
      logger.error("[useWorkspaceTaskLists] failed to load the workspace task list", error);
    } finally {
      if (inFlightRequestRef.current?.requestId === requestId) {
        inFlightRequestRef.current = null;
        setLoading((current) => updateBlockingLoadingState(current, []));
        const latestInput = latestRefreshInputRef.current;
        const shouldRerun =
          rerunRequestedRef.current ||
          latestInput.requestSignature !== flight.signature ||
          latestInput.sessionsIndexRevision !== flight.activityRevision ||
          latestInput.membershipVersion !== flight.membershipVersion;
        rerunRequestedRef.current = false;
        if (shouldRerun) {
          setRefreshTrigger((generation) => generation + 1);
        }
      }
    }
  }, [
    endpointShards,
    membershipVersion,
    pendingConfigs,
    params.sortBy,
    requestSignature,
    resultsByQueryKey,
    sessionsIndexItems,
    sessionsIndexRevision,
    setQueryResults,
  ]);
  useEffect(() => {
    if (pendingConfigs.length === 0) {
      return;
    }

    void refresh();
  }, [pendingConfigs.length, refresh, refreshTrigger, requestSignature]);

  // A sessions-index list change / pin-archive membership version change → mark the local scope cache stale,
  // triggering the refresh above to recompute with new data. sessions-index is a conflated low-frequency list event, not a high-frequency snapshot.
  // Cycle prevention: marking the cache stale causes a re-render, and if the parent rebuilds the workspaceTabs array on every render,
  // the scope array identity changes with it; only a real change in "items reference / membership version" is recognized here to avoid a setState infinite loop.
  const lastSessionsRefreshRef = useRef<{
    items: ZCodeTaskMeta[];
    membershipVersion: number;
  } | null>(null);
  useEffect(() => {
    if (sessionsIndexScopes.length === 0) {
      return;
    }
    const last = lastSessionsRefreshRef.current;
    if (last && last.items === sessionsIndexItems && last.membershipVersion === membershipVersion) {
      return;
    }
    const membershipChanged = !last || last.membershipVersion !== membershipVersion;
    const previousItems = last?.items ?? null;
    lastSessionsRefreshRef.current = {
      items: sessionsIndexItems,
      membershipVersion,
    };
    if (membershipChanged || previousItems === null) {
      markTaskQueryCacheScopesStale(sessionsIndexScopes);
      return;
    }
    // The sessions-index aggregation layer already stabilizes references — an unchanged item reference means equivalent content.
    // Previously any arriving frame marked every workspace's row cache stale for a refetch, showing up as
    // "open/collapse a task and every workspace list on the left reloads together".
    // Now diff out the workspaces that actually changed and mark only the matching scopes stale.
    const changedWorkspaceKeys = diffChangedWorkspaceKeys(previousItems, sessionsIndexItems);
    if (changedWorkspaceKeys.size === 0) {
      return;
    }
    const changedScopes = sessionsIndexScopes.filter((scope) =>
      changedWorkspaceKeys.has(buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity)),
    );
    if (changedScopes.length > 0) {
      markTaskQueryCacheScopesStale(changedScopes);
    }
  }, [sessionsIndexItems, membershipVersion, sessionsIndexScopes]);

  useEffect(() => {
    const subscribedEndpointShards = endpointShardsRef.current;
    if (subscribedEndpointShards.length === 0) {
      return;
    }

    const disposables: Array<{ dispose(): void }> = [];
    for (const shard of subscribedEndpointShards) {
      const configByWorkspaceKey = new Map(
        shard.configs.map((config) => [config.workspaceKey, config]),
      );

      for (const config of configByWorkspaceKey.values()) {
        const disposable = shard.services.zcodeTaskService.onDynamicWorkspaceEvent({
          workspacePath: config.scope.workspacePath,
          ...(config.scope.workspaceIdentity
            ? { workspaceIdentity: config.scope.workspaceIdentity }
            : {}),
        })((event: ZCodeWorkspaceEvent) => {
          if (event.type !== "workspace_task_list_changed") {
            return;
          }
          const eventWorkspaceKey = buildTaskWorkspaceKey(
            event.workspacePath,
            event.workspaceIdentity,
          );
          if (eventWorkspaceKey !== config.workspaceKey) {
            return;
          }
          syncTaskUnreadFromStatusWorkspaceEvent({
            activeWorkspace: activeWorkspaceRef.current,
            event,
            service: shard.services.zcodeTaskService,
          });
          if (!shouldRefetchTaskListMembershipForWorkspaceEvent(event)) {
            return;
          }

          // When an archive/pin originates from web remote control, the desktop workspace row has no local optimistic mutation;
          // listen only for low-frequency membership events and mark the matching workspace query stale here, so message-stream events do not trigger a full-table refetch.
          logger.info(
            `[useWorkspaceTaskLists] received a workspace_task_list_changed that cannot be applied incrementally, refreshing the workspace row workspace=${config.scope.workspacePath} reason=${event.reason}`,
          );
          // pin/archive/unread membership is persisted in tasks-index; sessions-index does not know about it;
          // membership events (local mutations emit them too; unread/rename go through task_meta_changed)
          // bump the version so the derived list refetches the membership join surface.
          // The same event is also forwarded and bumped by useGlobalTaskList's shared subscription;
          // deduplicated by event content, so one event triggers exactly one round of global membership refetch.
          bumpTaskListMembershipVersionForWorkspaceEvent(event);
          markTaskQueryCacheScopesStale([config.scope]);
        });
        disposables.push(disposable);
      }
    }

    return () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    };
  }, [workspaceEventSubscriptionSignature]);

  const groups = useMemo(() => {
    const result = buildWorkspaceTaskListDisplayGroups({
      queryConfigs,
      resultsByQueryKey,
      taskMetaByEntityKey,
      taskUnreadOverlayByEntityKey,
      optimisticTaskOverlayByWorkspaceKey,
      previousGroupsByWorkspaceKey: groupCacheRef.current,
      sortBy: params.sortBy,
    });
    groupCacheRef.current = result.cache;
    return result.groups;
  }, [
    optimisticTaskOverlayByWorkspaceKey,
    params.sortBy,
    queryConfigs,
    resultsByQueryKey,
    taskMetaByEntityKey,
    taskUnreadOverlayByEntityKey,
  ]);

  return {
    groups,
    loadingByWorkspaceKey: loading,
    refresh,
  };
}
