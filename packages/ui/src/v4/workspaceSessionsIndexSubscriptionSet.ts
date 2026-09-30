import {
  LOCAL_SESSIONS_INDEX_ENDPOINT,
  acquireSessionsIndex,
  buildSessionsIndexEntryKey,
  releaseSessionsIndex,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import { logger } from "@/logger.js";

export interface WorkspaceSessionsIndexBinding {
  scope: SessionsIndexScope;
  agentService: SessionsIndexAgentService;
}

interface ActiveWorkspaceSessionsIndexEntry extends WorkspaceSessionsIndexBinding {
  store: SessionsIndexStore;
  unsubscribeStore: () => void;
}

function scopeLogKey(scope: SessionsIndexScope): string {
  return `${scope.endpointKey ?? "__base__"}:${scope.workspaceKey}`;
}

function isSameBinding(
  current: ActiveWorkspaceSessionsIndexEntry,
  next: WorkspaceSessionsIndexBinding,
): boolean {
  return (
    current.agentService === next.agentService &&
    current.scope.workspaceKey === next.scope.workspaceKey &&
    current.scope.workspacePath === next.scope.workspacePath &&
    current.scope.workspaceIdentity === next.scope.workspaceIdentity &&
    current.scope.endpointKey === next.scope.endpointKey
  );
}

/**
 * Holds the sessions-index subscription per endpoint + workspaceKey.
 *
 * The old hook put the whole scopes array into one effect with a cleanup; when a workspace was
 * removed, React released all sibling subscriptions first and only then re-acquired the remaining
 * ones, replacing the existing snapshot/watermark with empty state. Here the scope array is
 * interpreted as a desired set, and side effects happen only for keys that are genuinely added,
 * removed, or moved to a new endpoint generation.
 */
export class WorkspaceSessionsIndexSubscriptionSet {
  private readonly active = new Map<string, ActiveWorkspaceSessionsIndexEntry>();

  constructor(private readonly onStoreChange: () => void) {}

  reconcile(bindings: readonly WorkspaceSessionsIndexBinding[]): boolean {
    const desired = new Map<string, WorkspaceSessionsIndexBinding>();
    for (const binding of bindings) {
      desired.set(buildSessionsIndexEntryKey(binding.scope), binding);
    }

    let changed = false;
    const releasedScopeKeys: string[] = [];
    const acquiredScopeKeys: string[] = [];
    for (const [entryKey, current] of this.active) {
      const next = desired.get(entryKey);
      if (next && isSameBinding(current, next)) {
        continue;
      }
      if (
        next &&
        current.agentService !== next.agentService &&
        (current.scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT) !==
          LOCAL_SESSIONS_INDEX_ENDPOINT
      ) {
        // If the remote service is replaced by releasing the only lease first, the registry will immediately close the old store.
        // Subsequent acquires can only rebuild from the empty store. First acquire the registry while the old entry is still alive
        // Rebind the transport in place and then release the old lease. Neither the projection nor the consumer listener will be interrupted.
        const store = acquireSessionsIndex(next.scope, next.agentService);
        const sameStore = store === current.store;
        const unsubscribeStore = sameStore
          ? current.unsubscribeStore
          : store.subscribe(this.onStoreChange);
        if (sameStore) {
          releaseSessionsIndex(current.scope, current.store);
        } else {
          this.disposeEntry(current);
        }
        this.active.set(entryKey, {
          ...next,
          store,
          unsubscribeStore,
        });
        releasedScopeKeys.push(scopeLogKey(current.scope));
        acquiredScopeKeys.push(scopeLogKey(next.scope));
        changed = true;
        continue;
      }
      releasedScopeKeys.push(scopeLogKey(current.scope));
      this.disposeEntry(current);
      this.active.delete(entryKey);
      changed = true;
    }

    for (const [entryKey, binding] of desired) {
      if (this.active.has(entryKey)) {
        continue;
      }
      const store = acquireSessionsIndex(binding.scope, binding.agentService);
      acquiredScopeKeys.push(scopeLogKey(binding.scope));
      this.active.set(entryKey, {
        ...binding,
        store,
        unsubscribeStore: store.subscribe(this.onStoreChange),
      });
      changed = true;
    }

    if (changed) {
      logger.info("[v4-sessions-index] workspace subscription set reconciled", {
        acquiredScopeKeys,
        releasedScopeKeys,
        activeCount: this.active.size,
      });
      this.onStoreChange();
    } else {
      logger.debug("[v4-sessions-index] workspace subscription set unchanged", {
        activeCount: this.active.size,
      });
    }
    return changed;
  }

  getStore(
    scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  ): SessionsIndexStore | undefined {
    return this.active.get(buildSessionsIndexEntryKey(scope))?.store;
  }

  size(): number {
    return this.active.size;
  }

  /**
   * Released together when the hook truly unmounts (including the StrictMode cleanup); a later
   * reconcile can still re-establish them.
   */
  dispose(): void {
    if (this.active.size > 0) {
      logger.info("[v4-sessions-index] workspace subscription set disposed", {
        releasedScopeKeys: [...this.active.values()].map((entry) => scopeLogKey(entry.scope)),
      });
    }
    for (const entry of this.active.values()) {
      this.disposeEntry(entry);
    }
    this.active.clear();
  }

  private disposeEntry(entry: ActiveWorkspaceSessionsIndexEntry): void {
    entry.unsubscribeStore();
    releaseSessionsIndex(entry.scope, entry.store);
  }
}
