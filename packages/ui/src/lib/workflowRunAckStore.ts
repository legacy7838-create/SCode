// Confirmed workflow run.
// The finished running line hangs until the user opens that session - no timer, no settledAt, just this bounded,
// Persistent runId collection: When opening a session, put in the entire batch of all completed runs at that time. The desktop goes to localStorage,
// The mobile phone remote control uses the same code and its own storage in its own browser.
import { useMemo, useSyncExternalStore } from "react";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const WORKFLOW_RUN_ACK_STORAGE_KEY = "zcode-workflow-run-acknowledged";
/**
 * Set cap; when it is full, the earliest acknowledged entry is evicted. 256 is far larger than the
 * number of finished runs any session list can hold at once.
 */
const WORKFLOW_RUN_ACK_LIMIT = 256;

interface WorkflowRunAckStore {
  isAcknowledged(runId: string): boolean;
  acknowledge(runIds: readonly string[]): void;
  subscribe(listener: () => void): () => void;
  /** Version snapshot: incremented on every set change, for useSyncExternalStore to compare by. */
  getVersion(): number;
}

function readStored(storage: StorageLike | null): string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(WORKFLOW_RUN_ACK_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function createWorkflowRunAckStore(storage: StorageLike | null): WorkflowRunAckStore {
  // Insertion order = confirmation order; the iteration order of Set ensures that the oldest one is eliminated.
  const acknowledged = new Set<string>(readStored(storage).slice(-WORKFLOW_RUN_ACK_LIMIT));
  const listeners = new Set<() => void>();
  let version = 0;
  const persist = () => {
    if (storage === null) return;
    try {
      storage.setItem(WORKFLOW_RUN_ACK_STORAGE_KEY, JSON.stringify([...acknowledged]));
    } catch {
      // Storage is unavailable (privacy mode, quota): It still takes effect within this session, but it does not span restarts.
    }
  };
  return {
    isAcknowledged: (runId) => acknowledged.has(runId),
    acknowledge: (runIds) => {
      let changed = false;
      for (const runId of runIds) {
        if (acknowledged.has(runId)) continue;
        acknowledged.add(runId);
        changed = true;
      }
      if (!changed) return;
      while (acknowledged.size > WORKFLOW_RUN_ACK_LIMIT) {
        const oldest = acknowledged.values().next().value;
        if (oldest === undefined) break;
        acknowledged.delete(oldest);
      }
      version += 1;
      persist();
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
  };
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let defaultStore: WorkflowRunAckStore | null = null;

export function getWorkflowRunAckStore(): WorkflowRunAckStore {
  defaultStore ??= createWorkflowRunAckStore(getBrowserStorage());
  return defaultStore;
}

/**
 * The version of the subscribed ack set; the returned predicate changes reference as the version
 * changes, so callers recompute their row selection.
 */
export function useWorkflowRunAcknowledged(): (runId: string) => boolean {
  const store = getWorkflowRunAckStore();
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  // The predicate changes references from version to version: the caller puts it into the useMemo dependency, and the row selection is recalculated as soon as the collection changes.
  return useMemo(() => (runId: string) => store.isAcknowledged(runId), [store, version]);
}
