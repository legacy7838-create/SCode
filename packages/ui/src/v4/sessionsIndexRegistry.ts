// SessionsIndexStore registry (reference counting) reused by endpoint + workspaceKey - multi-pane/multi-list
// The foundation of consumer parallel subscription: multiple consumers of the same endpoint and the same workspace share a sessions-index subscription
// (When switching data sources in the sidebar, useGlobalTaskList handles the workspace scope array and cannot adjust hooks by scope.
// Consumers go here). Isomorphic to SessionDataLayer's per-session acquire/release.
// Reuse key plus endpoint dimension - sessions-index of remote shard (web/mobile remote control/SSH workspace)
// Use the agentService proxy of each endpoint. Endpoints with different workspaceKeys cannot share the store.
import type { IZCodeAgentService } from "@zcode/services";
import { logger } from "@/logger.js";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { findRemoteWorkspaceSessionIdForAgentService } from "@/store/remoteWorkspaceSessionStore.js";
import { createAgentSessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";
import { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";

/**
 * The narrow slice of agentService the registry needs (= the transport's dependency surface, which
 * makes test injection easy).
 */
export type SessionsIndexAgentService = Pick<
  IZCodeAgentService,
  | "subscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "helloConversationV4"
  | "initializeConversationV4"
  | "unsubscribeSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "onAgentRuntimeRestarted"
>;

interface RegistryEntry {
  key: string;
  agentService: SessionsIndexAgentService;
  agentServiceGeneration: number;
  store: SessionsIndexStore;
  refCount: number;
}

const registry = new Map<string, RegistryEntry>();
const entriesByStore = new WeakMap<SessionsIndexStore, RegistryEntry>();
/**
 * A scope whose endpoint mismatch has already been reported; repeated acquire on the same scope
 * (re-render/multiple consumers) logs only one line.
 */
const reportedScopeEndpointMismatches = new Set<string>();

/**
 * The reserved key for this machine's endpoint (consistent with the task list shardKey convention).
 */
export const LOCAL_SESSIONS_INDEX_ENDPOINT = "__base__";

export interface SessionsIndexScope {
  /**
   * The workspace reuse key (= the services resolveWorkspaceKey convention: workspaceIdentity ??
   * workspacePath).
   */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /**
   * The endpoint dimension: the remoteSessionId of a remote shard; absent = this machine's
   * __base__.
   */
  endpointKey?: string;
}

/**
 * Diagnostics: the endpoint declared by a scope must match the remote session the agentService
 * actually belongs to, otherwise the same remote workspace gets registered as two entries and
 * issues two subscriptions for the same topic, while the CLI keeps only the latest one per
 * connection/topic — the earlier subscription is silently replaced and the sidebar never receives
 * frames again with no error at all. This kind of key mismatch (e.g. Root losing remoteSessionId
 * when the Settings tab overrides it) leaves no renderer trace in the production logs and can only
 * be reconstructed from the RPC fingerprint; here it is persisted through the lifecycle channel, so
 * such key mismatches are directly visible in the user's logs. Record only; keys are not changed.
 */
function reportScopeEndpointMismatch(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
): void {
  const remoteSessionId = findRemoteWorkspaceSessionIdForAgentService(agentService);
  if (!remoteSessionId) return;
  const endpointKey = scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT;
  if (endpointKey === remoteSessionId) return;
  const reportKey = `${endpointKey}\0${scope.workspaceKey}\0${remoteSessionId}`;
  if (reportedScopeEndpointMismatches.has(reportKey)) return;
  reportedScopeEndpointMismatches.add(reportKey);
  logger.lifecycle.warn(
    "[v4-sessions-index] scope endpoint does not match the remote agent ownership",
    {
      event: "v4.sessions_index.scope_endpoint_mismatch",
      endpointKey,
      remoteSessionId,
      workspaceKey: scope.workspaceKey,
      workspacePath: scope.workspacePath,
    },
  );
}

function createSessionsIndexTransport(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
) {
  const workspaceIdentity = scope.workspaceIdentity?.trim();
  return createAgentSessionsIndexTransport(agentService, {
    workspacePath: scope.workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

/**
 * A registry entry key = endpoint + workspaceKey (the same workspaceKey under a different endpoint
 * is not shared).
 */
export function buildSessionsIndexEntryKey(
  scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  agentService?: SessionsIndexAgentService,
): string {
  const entryKey = `${scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT}\0${scope.workspaceKey}`;
  return agentService
    ? `${entryKey}\0service-generation:${remoteAgentServiceGeneration(agentService)}`
    : entryKey;
}

/**
 * Get or create the shared sessions-index store for an endpoint+workspace, refCount++ (the first
 * acquire starts the subscription).
 */
export function acquireSessionsIndex(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
): SessionsIndexStore {
  reportScopeEndpointMismatch(scope, agentService);
  const entryKey = buildSessionsIndexEntryKey(scope);
  const incomingServiceGeneration = remoteAgentServiceGeneration(agentService);
  const existing = registry.get(entryKey);
  if (existing?.agentService === agentService) {
    existing.refCount += 1;
    return existing.store;
  }
  if (
    existing &&
    (scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT) !== LOCAL_SESSIONS_INDEX_ENDPOINT
  ) {
    existing.refCount += 1;
    // During the remote RPC proxy replacement, different React consumers may temporarily hold the old and new services.
    // The CLI only retains the last subscription to the same connection/topic; if a second store is created in parallel here, the old store
    // Will continue to show live/empty snapshots but never receive frames. The remote scope always reuses the same store and press service
    // Generation one-way, serial switching transport; late old consumers are not allowed to switch the transport back.
    if (incomingServiceGeneration > existing.agentServiceGeneration) {
      existing.agentService = agentService;
      existing.agentServiceGeneration = incomingServiceGeneration;
      const transport = createSessionsIndexTransport(scope, agentService);
      // The subscribe of any intermediate proxy may be permanently pending, and replacement cannot be queued.
      // Previous I/O. The store generation will synchronize detach old transports and let late results expire on their own.
      void existing.store.replaceTransport(transport).catch((error) => {
        logger.warn("[v4-sessions-index] remote transport replacement failed", error);
      });
    }
    return existing.store;
  }
  if (existing) {
    // Local __base__ maintains the original life cycle: a new store is created when the service instance is replaced; the old consumer
    // Subsequent cleanup will still be released accurately according to the store identity, and the refCount of the new entry cannot be reduced by mistake.
    registry.delete(entryKey);
    if (existing.refCount <= 0) {
      existing.store.close();
      entriesByStore.delete(existing.store);
    }
  }
  const store = new SessionsIndexStore();
  const transport = createSessionsIndexTransport(scope, agentService);
  // The initial subscribe may be pending forever after the old RPC proxy is destroyed. The replacement queue cannot
  // Wait for this old I/O; replaceTransport will use store generation to invalidate its late results.
  void store.connect(transport, { forceSnapshot: true });
  const entry: RegistryEntry = {
    key: entryKey,
    agentService,
    agentServiceGeneration: incomingServiceGeneration,
    store,
    refCount: 1,
  };
  registry.set(entryKey, entry);
  entriesByStore.set(store, entry);
  return store;
}

/** refCount--, and when it reaches zero, close + remove (unsubscribe + remove the listener). */
export function releaseSessionsIndex(
  scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  store: SessionsIndexStore,
): void {
  const entryKey = buildSessionsIndexEntryKey(scope);
  const entry = entriesByStore.get(store);
  if (!entry || entry.key !== entryKey) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.store.close();
    entriesByStore.delete(entry.store);
    if (registry.get(entryKey) === entry) registry.delete(entryKey);
  }
}
