// tasks-index row/membership authoritative version number.
// sessions-index only carries list activity and detail; task create/delete and pin/archive/unread and other organizational states
// Persisted in tasks-index.sqlite, the derived list is not aware of forward row or ownership changes from sessions changes.
// After the mutation is submitted, the version number here is bumped, and all task-row left tables + session detail join are re-read and filtered.
import { useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set<() => void>();

/**
 * Call after a task row or membership mutation: notifies every sessions-index derived list to
 * refetch the left-hand table.
 */
export function bumpTaskListMembershipVersion(): void {
  version += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribeTaskListMembershipVersion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getTaskListMembershipVersion(): number {
  return version;
}

// The same workspace_task_list_changed will go through multiple subscription links (useGlobalTaskList's
// Shared subscription fan-out + independent subscription of useWorkspaceTaskLists, object references are different after cross-RPC deserialization)
// Each bump, one attribution mutation will trigger multiple rounds of global membership re-pull. Here press the event content key
// Deduplication within a short window: the key contains the time field of meta (updatedAt/unreadAt), ensuring that there are only "same events"
// Duplicate submissions are merged; real mutations (pin→unpin, etc.) in rapid succession have different reasons/timestamps and will not be swallowed by mistake.
// Events without meta (bulk archive/group operations) cannot construct reliable keys and are directly released without deduplication.
const BUMP_DEDUPE_WINDOW_MS = 500;
const BUMP_DEDUPE_MAX_KEYS = 256;
const recentBumpAtByKey = new Map<string, number>();

interface MembershipBumpEventLike {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId?: string;
  reason: string;
  taskMeta?: {
    updatedAt: number;
    unreadAt?: number;
  };
}

export function bumpTaskListMembershipVersionForWorkspaceEvent(
  event: MembershipBumpEventLike,
): void {
  if (!event.taskMeta || !event.taskId) {
    bumpTaskListMembershipVersion();
    return;
  }
  const workspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
  const dedupeKey = [
    workspaceKey,
    event.taskId,
    event.reason,
    event.taskMeta.updatedAt,
    event.taskMeta.unreadAt ?? "",
  ].join("::");
  const now = Date.now();
  const lastBumpAt = recentBumpAtByKey.get(dedupeKey);
  if (lastBumpAt !== undefined && now - lastBumpAt < BUMP_DEDUPE_WINDOW_MS) {
    return;
  }
  for (const [key, bumpedAt] of recentBumpAtByKey) {
    if (now - bumpedAt >= BUMP_DEDUPE_WINDOW_MS) {
      recentBumpAtByKey.delete(key);
    }
  }
  if (recentBumpAtByKey.size < BUMP_DEDUPE_MAX_KEYS) {
    recentBumpAtByKey.set(dedupeKey, now);
  }
  bumpTaskListMembershipVersion();
}

/**
 * React binding: a change in the version number triggers a re-render (subscribe/get are
 * module-level functions with stable references).
 */
export function useTaskListMembershipVersion(): number {
  return useSyncExternalStore(subscribeTaskListMembershipVersion, getTaskListMembershipVersion);
}
