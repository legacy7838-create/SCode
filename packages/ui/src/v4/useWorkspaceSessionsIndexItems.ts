// Aggregate sessions-index sessions of several workspace scopes into ZCodeTaskMeta[] (responsive),
// Serves as live activity/detail input for each list in the sidebar; persistent row collection provided by tasks-index.
// Multi-consumer sharing: Subscriptions to the same endpoint+workspace are reused through sessionsIndexRegistry reference counting (basic).
// scope carries the endpoint dimension and the agentService of the endpoint (product of resolveWorkspaceServices),
// The remote shard (web/mobile remote control/SSH workspace) takes the same sessions-index link via @zcode/rpc proxy.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { mapSessionSummaryToTaskMeta } from "@/v4/mapSessionSummaryToTaskMeta.js";
import {
  buildTaskListItemIdentityKey,
  stabilizeTaskListItems,
} from "@/v4/taskListItemStabilization.js";
import {
  LOCAL_SESSIONS_INDEX_ENDPOINT,
  buildSessionsIndexEntryKey,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import {
  WorkspaceSessionsIndexSubscriptionSet,
  type WorkspaceSessionsIndexBinding,
} from "@/v4/workspaceSessionsIndexSubscriptionSet.js";

export interface WorkspaceSessionsIndexScope {
  workspacePath: string;
  workspaceIdentity?: string;
  /** The endpoint dimension (the remoteSessionId of a remote shard); default = the local __base__. */
  endpointKey?: string;
  /**
   * The agent service of the endpoint the scope belongs to (the product of
   * resolveWorkspaceServices); default = base services.
   */
  agentService?: SessionsIndexAgentService;
}

interface WorkspaceSessionsIndexItemsResult {
  /**
   * Aggregated conversation meta (running pinned first; the rest sorted by updatedAt descending; a
   * tick drives recomputation, with stable references).
   */
  items: ZCodeTaskMeta[];
  /**
   * A read-only generation per endpoint + workspace scope. It contains the service binding and the
   * store's logEpoch/seq, so that an async tasks-index membership join can precisely reject stale
   * activity snapshots.
   */
  sourceRevisionByScopeKey: Readonly<Record<string, string>>;
  /**
   * Endpoints that are subscribed but have not yet received their first snapshot ("__base__" or a
   * remoteSessionId). Consumers use it to sustain the loading/syncing indication, so the list is
   * not treated as empty before the remote's first frame arrives.
   */
  hydratingEndpointKeys: string[];
}

/** The workspace reuse key = the services' resolveWorkspaceKey notion (identity ?? path). */
function workspaceKeyOf(scope: WorkspaceSessionsIndexScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

function entryKeyOf(scope: WorkspaceSessionsIndexScope): string {
  return buildSessionsIndexEntryKey({
    workspaceKey: workspaceKeyOf(scope),
    ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
  });
}

export function buildWorkspaceSessionsIndexSourceKey(
  scope: Pick<WorkspaceSessionsIndexScope, "workspacePath" | "workspaceIdentity" | "endpointKey">,
): string {
  return entryKeyOf(scope);
}

function toRegistryScope(scope: WorkspaceSessionsIndexScope): SessionsIndexScope {
  return {
    workspaceKey: workspaceKeyOf(scope),
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
  };
}

function buildScopeBindingKey(
  scope: WorkspaceSessionsIndexScope,
  agentService: SessionsIndexAgentService,
): string {
  return `${buildSessionsIndexEntryKey(toRegistryScope(scope), agentService)}\0path:${scope.workspacePath}`;
}

/**
 * The store does not hold any snapshot yet (connecting / first frame not in); an error does not
 * count as hydrating (which would lead to permanent loading).
 */
function isHydratingStore(store: SessionsIndexStore): boolean {
  return (
    store.getState().workspaceId === null &&
    (store.getStatus() === "idle" || store.getStatus() === "connecting")
  );
}

/**
 * Subscribes to the sessions-index of the given workspace scopes and aggregates them into
 * ZCodeTaskMeta[] (running pinned first, the rest sorted by updatedAt descending). Lifecycle: the
 * shared store is acquired/released by reference count when the set of scopes changes; any store
 * change triggers a recomputation. sessions-index changes are conflated low-frequency list events,
 * not high-frequency snapshots.
 */
export function useWorkspaceSessionsIndexItems(
  scopes: WorkspaceSessionsIndexScope[],
): WorkspaceSessionsIndexItemsResult {
  const baseServices = useBaseWorkspaceServices();
  const baseAgentService = baseServices.zcodeAgentService;

  // The scope signature is stabilized to avoid recalculation and coordination for each rendering; effect/memo reads the latest scopes with equivalent content through ref.
  // Changes in endpointKey, workspacePath or agentService generation will change the signature.
  const signature = useMemo(
    () =>
      scopes
        .map((scope) => {
          const agentService = scope.agentService ?? baseAgentService;
          return agentService
            ? buildScopeBindingKey(scope, agentService)
            : `${entryKeyOf(scope)} ${scope.workspacePath} service-unavailable`;
        })
        .sort()
        .join("|"),
    [scopes, baseAgentService],
  );
  const scopesRef = useRef(scopes);
  scopesRef.current = scopes;

  // Tick: Any store change +1, driving aggregation memo recalculation.
  const [tick, setTick] = useState(0);
  const bumpTick = useCallback(() => setTick((n) => n + 1), []);
  const subscriptionSetRef = useRef<WorkspaceSessionsIndexSubscriptionSet | null>(null);
  if (subscriptionSetRef.current === null) {
    subscriptionSetRef.current = new WorkspaceSessionsIndexSubscriptionSet(bumpTick);
  }
  const subscriptionSet = subscriptionSetRef.current;

  useEffect(() => {
    const bindings: WorkspaceSessionsIndexBinding[] = [];
    for (const scope of scopesRef.current) {
      // Defense: The test/downgrade environment may not have zcodeAgentService (sessions-index transport surface), so the scope is not subscribed at this time.
      const agentService = scope.agentService ?? baseAgentService;
      if (!agentService) {
        continue;
      }
      bindings.push({ scope: toRegistryScope(scope), agentService });
    }
    subscriptionSet.reconcile(bindings);
    // signature covers scopes, endpoint, workspacePath and service generation changes;
    // reconcile only acquires/releases bindings that actually changed.
  }, [signature, baseAgentService, subscriptionSet]);

  useEffect(
    () => () => {
      subscriptionSet.dispose();
    },
    [subscriptionSet],
  );

  // Aggregate sessions from each store → ZCodeTaskMeta + hydration status (tick driver recalculation, reference is stable).
  const previousItemsRef = useRef<ZCodeTaskMeta[]>([]);
  const previousHydratingRef = useRef<string[]>([]);
  return useMemo(() => {
    const metas: ZCodeTaskMeta[] = [];
    const hydratingEndpointKeys = new Set<string>();
    const sourceRevisionByScopeKey: Record<string, string> = {};
    const previousByKey = new Map(
      previousItemsRef.current.map((meta) => [buildTaskListItemIdentityKey(meta), meta]),
    );
    for (const scope of scopesRef.current) {
      const sourceKey = entryKeyOf(scope);
      const agentService = scope.agentService ?? baseAgentService;
      const bindingRevision = agentService
        ? buildScopeBindingKey(scope, agentService)
        : `${sourceKey} service-unavailable`;
      const store = subscriptionSet.getStore({
        workspaceKey: workspaceKeyOf(scope),
        ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
      });
      if (!store) {
        sourceRevisionByScopeKey[sourceKey] = `${bindingRevision}:missing`;
        continue;
      }
      const storeState = store.getState();
      sourceRevisionByScopeKey[sourceKey] =
        `${bindingRevision}:${storeState.logEpoch ?? "none"}:${storeState.seq}:${store.getStatus()}`;
      if (isHydratingStore(store)) {
        hydratingEndpointKeys.add(scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT);
      }
      for (const summary of store.getSessions()) {
        metas.push(
          mapSessionSummaryToTaskMeta(summary, {
            workspacePath: scope.workspacePath,
            ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
            previous: previousByKey.get(buildSummaryIdentityKey(scope, summary.sessionId)),
          }),
        );
      }
    }
    metas.sort((a, b) => compareZCodeTaskListItems(a, b, "updated"));
    // Metas are fully rebuilt every tick, even if the content has not changed at all (for example, cold recovery replaces seed with
    // The live projection only changes the preview field that is not consumed by the list), and the downstream will also treat the "new array reference" as new data:
    // Grouped view tree refresh, workspace row cache invalidate, each list republish——
    // The performance is "open a historical task and the entire list on the left is reloaded". Here is the reference-by-reference stabilization:
    // The old objects are reused equally for content; the old arrays are reused equally for the entire table, short-circuiting all effects that depend on the identity of the array.
    const items = stabilizeTaskListItems(previousItemsRef.current, metas);
    previousItemsRef.current = items;
    const nextHydrating = [...hydratingEndpointKeys].sort();
    const hydrating =
      nextHydrating.length === previousHydratingRef.current.length &&
      nextHydrating.every((key, index) => key === previousHydratingRef.current[index])
        ? previousHydratingRef.current
        : nextHydrating;
    previousHydratingRef.current = hydrating;
    return {
      items,
      sourceRevisionByScopeKey,
      hydratingEndpointKeys: hydrating,
    };
  }, [signature, subscriptionSet, tick]);
}

function buildSummaryIdentityKey(scope: WorkspaceSessionsIndexScope, sessionId: string): string {
  return `${scope.workspaceIdentity?.trim() || scope.workspacePath}::${sessionId}`;
}
