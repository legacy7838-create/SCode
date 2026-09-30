/* eslint-disable max-lines -- the descriptor, membership, and mutation of the task query cache must
 * be maintained in the same Zustand transaction; scattering them would increase cache consistency
 * risk.
 */
import { create } from "zustand";
import type { ZCodeTaskListItem } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { getTaskListRowActivity, mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import {
  buildTaskEntityKey,
  buildTaskWorkspaceKey,
  type CachedTaskListResult,
  type TaskListCacheDescriptor,
  type TaskEntityKey,
  type TaskListCacheKey,
} from "@/lib/taskQueryCache.js";
import { notifyTaskLifecycle } from "@/lib/taskLifecycleEvents.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TaskListMembershipState {
  pinned: boolean;
  archived: boolean;
}

interface TaskQueryCacheState {
  resultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult>;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  /**
   * Overrides the unreadAt field for entries that are being submitted or awaiting membership
   * confirmation; null clears it.
   */
  taskUnreadOverlayByEntityKey: Record<TaskEntityKey, number | null>;
  setQueryResult: (params: {
    queryKey: TaskListCacheKey;
    descriptor: TaskListCacheDescriptor;
    items: CachedTaskListItem[];
    total: number;
    hasMore: boolean;
    unreadTaskKeys?: TaskEntityKey[];
    partial?: boolean;
    loadingShardKeys?: string[];
    failedShardKeys?: string[];
  }) => void;
  setQueryResults: (
    entries: Array<{
      queryKey: TaskListCacheKey;
      descriptor: TaskListCacheDescriptor;
      items: CachedTaskListItem[];
      total: number;
      hasMore: boolean;
      unreadTaskKeys?: TaskEntityKey[];
      partial?: boolean;
      loadingShardKeys?: string[];
      failedShardKeys?: string[];
      /**
       * The invalidationVersion observed when this async query started; when it does not match, the
       * entire result is discarded.
       */
      expectedInvalidationVersion?: number;
    }>,
  ) => void;
  upsertTaskMeta: (task: ZCodeTaskMeta) => void;
  updateTaskMetaPreservingMembership: (task: ZCodeTaskMeta) => void;
  applyTaskMutation: (params: {
    previousTask: ZCodeTaskMeta;
    nextTask: ZCodeTaskMeta;
    previousState: TaskListMembershipState;
    nextState: TaskListMembershipState;
  }) => void;
  setTaskUnreadOverlay: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  reconcileTaskUnread: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  rollbackTaskUnread: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  removeTask: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  markWorkspaceKeysStale: (workspaceKeys: string[]) => void;
  invalidateWorkspaceKeys: (workspaceKeys: string[]) => void;
  clearAll: () => void;
}

type CachedTaskListItem = ZCodeTaskListItem & { searchSnippets?: string[] };

function buildCachedTaskListResult(params: {
  descriptor: TaskListCacheDescriptor;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial?: boolean;
  loadingShardKeys?: string[];
  failedShardKeys?: string[];
  invalidationVersion?: number;
}): CachedTaskListResult {
  return {
    taskKeys: params.taskKeys,
    unreadTaskKeys: params.unreadTaskKeys,
    searchSnippetsByTaskKey: params.searchSnippetsByTaskKey,
    searchSnippetListsByTaskKey: params.searchSnippetListsByTaskKey,
    total: params.total,
    hasMore: params.hasMore,
    fetchedAt: Date.now(),
    invalidationVersion: params.invalidationVersion ?? 0,
    stale: false,
    partial: params.partial ?? false,
    loadingShardKeys: params.loadingShardKeys ?? [],
    failedShardKeys: params.failedShardKeys ?? [],
    descriptor: params.descriptor,
  };
}

function matchesTaskMembership(
  descriptor: TaskListCacheDescriptor,
  membership: TaskListMembershipState,
): boolean {
  const kind = descriptor.kind === "workspace" ? "timeline" : descriptor.kind;
  return matchesTaskListMembershipKind(membership, kind);
}

function matchesTaskSearch(descriptor: TaskListCacheDescriptor, task: ZCodeTaskMeta): boolean {
  if (!descriptor.search) {
    return true;
  }

  return task.title.toLocaleLowerCase().includes(descriptor.search);
}

function matchesTaskDescriptor(
  descriptor: TaskListCacheDescriptor,
  task: ZCodeTaskMeta,
  membership: TaskListMembershipState,
): boolean {
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  if (!descriptor.workspaceKeys.includes(workspaceKey)) {
    return false;
  }

  return matchesTaskMembership(descriptor, membership) && matchesTaskSearch(descriptor, task);
}

function sortTaskKeysByDescriptor(params: {
  taskKeys: TaskEntityKey[];
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): TaskEntityKey[] {
  const uniqueTaskKeys = [...new Set(params.taskKeys)];
  return uniqueTaskKeys.sort((leftKey, rightKey) => {
    const leftTask = params.taskMetaByEntityKey[leftKey];
    const rightTask = params.taskMetaByEntityKey[rightKey];
    if (!leftTask && !rightTask) {
      return leftKey.localeCompare(rightKey);
    }
    if (!leftTask) {
      return 1;
    }
    if (!rightTask) {
      return -1;
    }
    return compareZCodeTaskListItems(leftTask, rightTask, params.descriptor.sortBy);
  });
}

// The items produced by republish (membership re-pull, sessions-index frame) are all new object references.
// If the reference is still changed when the content has not changed, taskMetaByEntityKey and derived items memo will replace the entire list.
// All list rows are invalid and re-rendered. Field-by-field equivalence judgments are made here, and old references are retained for equivalence.
// Nested fields (lastError/target, etc.) are compared using JSON; task meta is a small object at an acceptable cost.
function areCachedTaskListItemsEquivalent(
  left: CachedTaskListItem,
  right: CachedTaskListItem,
): boolean {
  if (left === right) {
    return true;
  }
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) {
    return false;
  }
  for (const key of leftKeys) {
    const leftValue = leftRecord[key];
    const rightValue = rightRecord[key];
    if (leftValue === rightValue) {
      continue;
    }
    if (
      typeof leftValue === "object" &&
      leftValue !== null &&
      typeof rightValue === "object" &&
      rightValue !== null
    ) {
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

function mergeIncomingTaskListItem(params: {
  item: CachedTaskListItem;
  existingItem: CachedTaskListItem | undefined;
  descriptor: TaskListCacheDescriptor;
  hasUnreadOverlay: boolean;
  unreadAtOverlay: number | null | undefined;
}): CachedTaskListItem {
  const incomingActivity = getTaskListRowActivity(params.item);
  const existingActivity = params.existingItem ? getTaskListRowActivity(params.existingItem) : null;
  // The search results come from tasks-index, but the entity cache may already have sessions-index activity.
  // Keep the sidecar when merging, otherwise running/waiting for confirmation will disappear as soon as the user enters a search term.
  const incomingWithActivity =
    params.descriptor.search && params.existingItem && existingActivity && !incomingActivity
      ? (mergeTaskListMembershipFields(params.existingItem, params.item) as CachedTaskListItem)
      : params.item;
  const keepExistingNonPlaceholderTitle =
    params.existingItem &&
    incomingActivity &&
    (params.item.title.trim().length === 0 ||
      params.item.title.trim().toLocaleLowerCase() === "new session") &&
    params.existingItem.title.trim().length > 0 &&
    params.existingItem.title.trim().toLocaleLowerCase() !== "new session";
  // The incoming item of the non-search list is sessions-index activity + latest membership join,
  // You can no longer do whole-meta winner by tasks-index updatedAt; otherwise the rename/unread response will overwrite the real-time
  // phase/lastActivityAt. Only retain the initial title and non-activity display fields when sessions-index has not been completed.
  const mergedItem = params.descriptor.search
    ? incomingWithActivity
    : ({
        ...incomingWithActivity,
        ...(keepExistingNonPlaceholderTitle ? { title: params.existingItem?.title } : {}),
        changeSummary: incomingWithActivity.changeSummary ?? params.existingItem?.changeSummary,
        model: incomingWithActivity.model ?? params.existingItem?.model,
        provider: incomingWithActivity.provider ?? params.existingItem?.provider,
      } as CachedTaskListItem);
  const itemWithUnreadOverlay = params.hasUnreadOverlay
    ? ({
        ...mergedItem,
        unreadAt: params.unreadAtOverlay ?? undefined,
      } as CachedTaskListItem)
    : mergedItem;
  const nextItem =
    params.descriptor.search || !params.existingItem?.searchSnippet
      ? itemWithUnreadOverlay
      : {
          ...itemWithUnreadOverlay,
          searchSnippet: params.existingItem.searchSnippet,
          searchSnippets: params.existingItem.searchSnippets,
        };
  // Reference retention: Use the old object when the merged result is equivalent to the current value, short-circuiting downstream memo/shallow comparisons.
  return params.existingItem && areCachedTaskListItemsEquivalent(nextItem, params.existingItem)
    ? params.existingItem
    : nextItem;
}

// When the republish content is completely equivalent to the current cache, the entire setState is skipped directly.
// Prevent resultsByQueryKey/taskMetaByEntityKey from replacing new references, which may cause invalid re-rendering of the entire list.
// fetchedAt/stale does not participate in the comparison (retaining the old value does not affect the correctness, the preserve window will only be more conservative).
function isQueryResultEquivalent(params: {
  previousResult: CachedTaskListResult | undefined;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial: boolean;
  loadingShardKeys: string[];
  failedShardKeys: string[];
}): boolean {
  const previous = params.previousResult;
  if (!previous || previous.stale) {
    return false;
  }
  if (
    previous.total !== params.total ||
    previous.hasMore !== params.hasMore ||
    previous.partial !== params.partial
  ) {
    return false;
  }
  if (
    previous.taskKeys.length !== params.taskKeys.length ||
    previous.taskKeys.some((taskKey, index) => taskKey !== params.taskKeys[index])
  ) {
    return false;
  }
  const sameStringArray = (left: string[], right: string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  if (
    !sameStringArray(previous.unreadTaskKeys ?? [], params.unreadTaskKeys ?? []) ||
    !sameStringArray(previous.loadingShardKeys, params.loadingShardKeys) ||
    !sameStringArray(previous.failedShardKeys, params.failedShardKeys)
  ) {
    return false;
  }
  return (
    JSON.stringify(previous.searchSnippetsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetsByTaskKey ?? null) &&
    JSON.stringify(previous.searchSnippetListsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetListsByTaskKey ?? null)
  );
}

function preserveFreshLocalTaskKeys(params: {
  incomingTaskKeys: TaskEntityKey[];
  previousResult: CachedTaskListResult | undefined;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): { taskKeys: TaskEntityKey[]; preservedCount: number } {
  if (!params.previousResult || params.descriptor.search) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const previousResult = params.previousResult;
  const incomingTaskKeySet = new Set(params.incomingTaskKeys);
  const preservedTaskKeys = previousResult.taskKeys.filter((taskKey) => {
    if (incomingTaskKeySet.has(taskKey)) {
      return false;
    }
    const task = params.taskMetaByEntityKey[taskKey];
    return Boolean(task && task.updatedAt > previousResult.fetchedAt);
  });
  if (preservedTaskKeys.length === 0) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const sortedTaskKeys = sortTaskKeysByDescriptor({
    // SQLite list refresh may occur later than first optimistic insert.
    // Only keys whose local update time is newer than the previous round of list snapshots are temporarily retained to prevent old refreshes from erasing new tasks from the sidebar.
    taskKeys: [...params.incomingTaskKeys, ...preservedTaskKeys],
    taskMetaByEntityKey: params.taskMetaByEntityKey,
    descriptor: params.descriptor,
  });
  const visibleTaskKeys =
    params.descriptor.visibleLimit === null
      ? sortedTaskKeys
      : sortedTaskKeys.slice(0, params.descriptor.visibleLimit);
  return {
    taskKeys: visibleTaskKeys,
    preservedCount: preservedTaskKeys.length,
  };
}

export const useTaskQueryCacheStore = create<TaskQueryCacheState>()((set) => ({
  resultsByQueryKey: {},
  taskMetaByEntityKey: {},
  taskUnreadOverlayByEntityKey: {},
  setQueryResult: ({
    queryKey,
    descriptor,
    items,
    total,
    hasMore,
    unreadTaskKeys,
    partial,
    loadingShardKeys,
    failedShardKeys,
  }) =>
    set((state) => {
      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      let taskMetaChanged = false;
      let taskUnreadOverlayChanged = false;
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
      const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
      const incomingTaskKeys = items.map((item) => {
        const entityKey = buildTaskEntityKey(item);
        if (item.searchSnippet) {
          searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
        }
        if (item.searchSnippets?.length) {
          searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
        }
        const existingItem = nextTaskMetaByEntityKey[entityKey];
        const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
          state.taskUnreadOverlayByEntityKey,
          entityKey,
        );
        const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
        const mergedItem = mergeIncomingTaskListItem({
          item,
          existingItem,
          descriptor,
          hasUnreadOverlay,
          unreadAtOverlay,
        });
        if (
          hasUnreadOverlay &&
          (unreadAtOverlay === null
            ? typeof item.unreadAt !== "number"
            : item.unreadAt === unreadAtOverlay)
        ) {
          // A successful RPC does not mean that all in-flight membership queries have been updated.
          // The overlay can only be released after the query actually publishes the same field value, and the new state cannot be overwritten before and after the old return packet.
          delete nextTaskUnreadOverlayByEntityKey[entityKey];
          taskUnreadOverlayChanged = true;
        }
        if (mergedItem !== existingItem) {
          taskMetaChanged = true;
          nextTaskMetaByEntityKey[entityKey] = mergedItem;
        }
        return entityKey;
      });
      const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
        incomingTaskKeys,
        previousResult: state.resultsByQueryKey[queryKey],
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
        descriptor,
      });

      const resultParams = {
        descriptor,
        taskKeys,
        unreadTaskKeys,
        searchSnippetsByTaskKey:
          Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
        searchSnippetListsByTaskKey:
          Object.keys(searchSnippetListsByTaskKey).length > 0
            ? searchSnippetListsByTaskKey
            : undefined,
        total:
          preservedCount > 0
            ? Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length)
            : total,
        hasMore:
          hasMore ||
          (preservedCount > 0 &&
            Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length) >
              taskKeys.length),
        partial,
        loadingShardKeys,
        failedShardKeys,
        invalidationVersion: state.resultsByQueryKey[queryKey]?.invalidationVersion ?? 0,
      };
      // SetState is skipped when the content is completely equivalent to the current cache, and republish no longer triggers full list invalidation and re-rendering.
      if (
        !taskMetaChanged &&
        !taskUnreadOverlayChanged &&
        isQueryResultEquivalent({
          previousResult: state.resultsByQueryKey[queryKey],
          taskKeys,
          unreadTaskKeys: resultParams.unreadTaskKeys,
          searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
          searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
          total: resultParams.total,
          hasMore: resultParams.hasMore,
          partial: partial ?? false,
          loadingShardKeys: loadingShardKeys ?? [],
          failedShardKeys: failedShardKeys ?? [],
        })
      ) {
        return state;
      }

      return {
        resultsByQueryKey: {
          ...state.resultsByQueryKey,
          [queryKey]: buildCachedTaskListResult(resultParams),
        },
        taskMetaByEntityKey: taskMetaChanged ? nextTaskMetaByEntityKey : state.taskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
          ? nextTaskUnreadOverlayByEntityKey
          : state.taskUnreadOverlayByEntityKey,
      };
    }),
  setQueryResults: (entries) =>
    set((state) => {
      if (entries.length === 0) {
        return state;
      }

      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      let taskMetaChanged = false;
      let taskUnreadOverlayChanged = false;
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      let resultsChanged = false;

      for (const entry of entries) {
        const previousResult = state.resultsByQueryKey[entry.queryKey];
        const currentInvalidationVersion = previousResult?.invalidationVersion ?? 0;
        if (
          entry.expectedInvalidationVersion !== undefined &&
          entry.expectedInvalidationVersion !== currentInvalidationVersion
        ) {
          // sessions-index activity and tasks-index membership are asynchronous joins.
          // When it expires again while in transit, the old result cannot be written to entity, release unread overlay, or mark query as fresh;
          // The hook will be automatically recalculated based on the latest activity/membership revision.
          continue;
        }
        const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
        const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
        const incomingTaskKeys = entry.items.map((item) => {
          const entityKey = buildTaskEntityKey(item);
          if (item.searchSnippet) {
            searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
          }
          if (item.searchSnippets?.length) {
            searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
          }
          const existingItem = nextTaskMetaByEntityKey[entityKey];
          const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
            state.taskUnreadOverlayByEntityKey,
            entityKey,
          );
          const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
          const mergedItem = mergeIncomingTaskListItem({
            item,
            existingItem,
            descriptor: entry.descriptor,
            hasUnreadOverlay,
            unreadAtOverlay,
          });
          if (
            hasUnreadOverlay &&
            (unreadAtOverlay === null
              ? typeof item.unreadAt !== "number"
              : item.unreadAt === unreadAtOverlay)
          ) {
            delete nextTaskUnreadOverlayByEntityKey[entityKey];
            taskUnreadOverlayChanged = true;
          }
          if (mergedItem !== existingItem) {
            taskMetaChanged = true;
            nextTaskMetaByEntityKey[entityKey] = mergedItem;
          }
          return entityKey;
        });
        const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
          incomingTaskKeys,
          previousResult,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor: entry.descriptor,
        });

        const resultParams = {
          descriptor: entry.descriptor,
          taskKeys,
          unreadTaskKeys: entry.unreadTaskKeys,
          searchSnippetsByTaskKey:
            Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
          searchSnippetListsByTaskKey:
            Object.keys(searchSnippetListsByTaskKey).length > 0
              ? searchSnippetListsByTaskKey
              : undefined,
          total:
            preservedCount > 0
              ? Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length)
              : entry.total,
          hasMore:
            entry.hasMore ||
            (preservedCount > 0 &&
              Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length) > taskKeys.length),
          partial: entry.partial,
          loadingShardKeys: entry.loadingShardKeys,
          failedShardKeys: entry.failedShardKeys,
          invalidationVersion: currentInvalidationVersion,
        };
        // The same short-circuit as a single setQueryResult - entries whose content has not changed retain references to the old results.
        if (
          isQueryResultEquivalent({
            previousResult,
            taskKeys,
            unreadTaskKeys: resultParams.unreadTaskKeys,
            searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
            searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
            total: resultParams.total,
            hasMore: resultParams.hasMore,
            partial: entry.partial ?? false,
            loadingShardKeys: entry.loadingShardKeys ?? [],
            failedShardKeys: entry.failedShardKeys ?? [],
          })
        ) {
          continue;
        }
        resultsChanged = true;
        nextResultsByQueryKey[entry.queryKey] = buildCachedTaskListResult(resultParams);
      }

      if (!taskMetaChanged && !resultsChanged && !taskUnreadOverlayChanged) {
        return state;
      }

      return {
        resultsByQueryKey: resultsChanged ? nextResultsByQueryKey : state.resultsByQueryKey,
        taskMetaByEntityKey: taskMetaChanged ? nextTaskMetaByEntityKey : state.taskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
          ? nextTaskUnreadOverlayByEntityKey
          : state.taskUnreadOverlayByEntityKey,
      };
    }),
  upsertTaskMeta: (task) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // During restart and recovery, the raw session snapshot may be written to the query cache before the list is refreshed.
      // This must be merged with the existing indexed meta to avoid the snapshot lacking titleOverridden from overwriting the user's manual title.
      const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
      const nextTask = getTaskListRowActivity(task)
        ? mergeTaskListMembershipFields(task, mergedTask)
        : existingTask
          ? mergeTaskListMembershipFields(existingTask, mergedTask)
          : mergedTask;
      return {
        ...state,
        taskMetaByEntityKey: {
          ...state.taskMetaByEntityKey,
          [entityKey]: nextTask,
        },
      };
    }),
  updateTaskMetaPreservingMembership: (task) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // workspace_task_list_changed may carry the runtime snapshot projection header.
      // Keep the manually renamed fact source that already exists in the query cache, and only use the new meta to fill the status/updatedAt and other running status fields.
      const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
      // tasks-index updatedAt brought by workspace_task_list_changed
      // It's just a metadata update, not the user's actual session activity. When sessions-index sidecar already exists
      // Only merge membership/meta fields, otherwise rename/unread will cause task errors to jump to the top.
      const nextTask = existingTask
        ? mergeTaskListMembershipFields(existingTask, mergedTask)
        : mergedTask;
      const nextTaskMetaByEntityKey = {
        ...state.taskMetaByEntityKey,
        [entityKey]: nextTask,
      };
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };

      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (!result.taskKeys.includes(entityKey)) {
          continue;
        }

        // The meta increment of workspace_task_list_changed only describes the task content/status changes.
        // It does not represent a change in the pinned/archived membership; therefore, it only rearranges the list that already contains the task, but cannot move it from the pinned area.
        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys: sortTaskKeysByDescriptor({
            taskKeys: result.taskKeys,
            taskMetaByEntityKey: nextTaskMetaByEntityKey,
            descriptor: result.descriptor,
          }),
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  applyTaskMutation: ({ previousTask, nextTask, previousState, nextState }) =>
    set((state) => {
      const previousEntityKey = buildTaskEntityKey(previousTask);
      const nextEntityKey = buildTaskEntityKey(nextTask);
      const existingTask =
        state.taskMetaByEntityKey[nextEntityKey] ?? state.taskMetaByEntityKey[previousEntityKey];
      const mergedNextTask = existingTask
        ? mergeTaskListMembershipFields(existingTask, nextTask)
        : nextTask;
      const nextTaskMetaByEntityKey = {
        ...state.taskMetaByEntityKey,
        [nextEntityKey]: mergedNextTask,
      };
      if (previousEntityKey !== nextEntityKey) {
        delete nextTaskMetaByEntityKey[previousEntityKey];
      }

      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (result.descriptor.search) {
          // The text search results are determined by the server-side sqlite searchable_text, and the front-end cache only has task meta/title.
          // Title-only rules cannot be used to determine incremental list membership; otherwise sessions with body hits will be misjudged as mismatches by the local cache.
          nextResultsByQueryKey[queryKey] = {
            ...result,
            invalidationVersion: result.invalidationVersion + 1,
            stale: true,
          };
          continue;
        }

        const previousIncluded = matchesTaskDescriptor(
          result.descriptor,
          previousTask,
          previousState,
        );
        const nextIncluded = matchesTaskDescriptor(result.descriptor, nextTask, nextState);
        const wasVisible =
          result.taskKeys.includes(previousEntityKey) || result.taskKeys.includes(nextEntityKey);

        if (!previousIncluded && !nextIncluded && !wasVisible) {
          continue;
        }

        const taskKeysWithoutTarget = result.taskKeys.filter(
          (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
        );
        const unreadTaskKeysWithoutTarget = (result.unreadTaskKeys ?? []).filter(
          (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
        );
        const visibleCandidateKeys = nextIncluded
          ? [...taskKeysWithoutTarget, nextEntityKey]
          : taskKeysWithoutTarget;
        const nextUnreadTaskKeys =
          nextIncluded && typeof mergedNextTask.unreadAt === "number"
            ? [...unreadTaskKeysWithoutTarget, nextEntityKey]
            : unreadTaskKeysWithoutTarget;
        const sortedTaskKeys = sortTaskKeysByDescriptor({
          taskKeys: visibleCandidateKeys,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor: result.descriptor,
        });
        const visibleTaskKeys =
          result.descriptor.visibleLimit === null
            ? sortedTaskKeys
            : sortedTaskKeys.slice(0, result.descriptor.visibleLimit);
        const nextTotal = Math.max(
          0,
          result.total + Number(nextIncluded) - Number(previousIncluded),
        );
        const shouldBackgroundRefresh =
          result.descriptor.visibleLimit !== null &&
          previousIncluded !== nextIncluded &&
          nextTotal > visibleTaskKeys.length;

        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys: visibleTaskKeys,
          ...(result.unreadTaskKeys ? { unreadTaskKeys: nextUnreadTaskKeys } : {}),
          total: nextTotal,
          hasMore: nextTotal > visibleTaskKeys.length,
          stale: result.stale || shouldBackgroundRefresh,
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  setTaskUnreadOverlay: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      return {
        taskUnreadOverlayByEntityKey: {
          ...state.taskUnreadOverlayByEntityKey,
          [entityKey]: unreadAt ?? null,
        },
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  reconcileTaskUnread: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // The server response only confirms that the mutation has been persisted; the old membership request may still return later.
      // Update the overlay to the server value until setQueryResult observes the same value and then automatically releases it.
      return {
        taskUnreadOverlayByEntityKey: {
          ...state.taskUnreadOverlayByEntityKey,
          [entityKey]: unreadAt ?? null,
        },
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  rollbackTaskUnread: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      const nextOverlays = { ...state.taskUnreadOverlayByEntityKey };
      delete nextOverlays[entityKey];
      return {
        taskUnreadOverlayByEntityKey: nextOverlays,
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  removeTask: (task) => {
    let removedFromVisibleCache = false;
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      if (!state.taskMetaByEntityKey[entityKey]) {
        const hasCachedResult = Object.values(state.resultsByQueryKey).some((result) =>
          result.taskKeys.includes(entityKey),
        );
        if (!hasCachedResult) {
          return state;
        }
      }

      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      delete nextTaskMetaByEntityKey[entityKey];
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      delete nextTaskUnreadOverlayByEntityKey[entityKey];

      const nextResultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult> = {};
      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (!result.taskKeys.includes(entityKey)) {
          nextResultsByQueryKey[queryKey] = result;
          continue;
        }

        const taskKeys = result.taskKeys.filter((taskKey) => taskKey !== entityKey);
        removedFromVisibleCache = true;
        // Before deleting a task, only the entire table could be refreshed; here only the total is deducted from the list of actual visible cache hits.
        // Do not guess the membership of hidden items that do not appear in the folded visible area to avoid accidentally deducting other list counts.
        const total = Math.max(0, result.total - 1);
        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys,
          total,
          hasMore: total > taskKeys.length,
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: nextTaskUnreadOverlayByEntityKey,
      };
    });
    return removedFromVisibleCache;
  },
  markWorkspaceKeysStale: (workspaceKeys) =>
    set((state) => {
      if (workspaceKeys.length === 0) {
        return state;
      }

      const staleWorkspaceKeySet = new Set(workspaceKeys);
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      let changed = false;

      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (
          !result.descriptor.workspaceKeys.some((workspaceKey) =>
            staleWorkspaceKeySet.has(workspaceKey),
          )
        ) {
          continue;
        }

        // When deleting a folding/pagination hidden task, the total cannot be safely deducted by taskId alone.
        // The current visible list is retained here, and only the dirty matching workspace is marked, so that the next round of effect of the hook can actually go back to the source and refresh the count.
        nextResultsByQueryKey[queryKey] = {
          ...result,
          invalidationVersion: result.invalidationVersion + 1,
          stale: true,
        };
        changed = true;
      }

      if (!changed) {
        return state;
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
      };
    }),
  invalidateWorkspaceKeys: (workspaceKeys) =>
    set((state) => {
      if (workspaceKeys.length === 0) {
        return state;
      }

      const invalidatedWorkspaceKeySet = new Set(workspaceKeys);
      const nextResultsByQueryKey = Object.fromEntries(
        Object.entries(state.resultsByQueryKey).filter(([queryKey]) => {
          return ![...invalidatedWorkspaceKeySet].some(
            (workspaceKey) =>
              queryKey.includes(`workspaces=${workspaceKey}`) ||
              queryKey.includes(`|${workspaceKey}`),
          );
        }),
      );
      const nextTaskMetaByEntityKey = Object.fromEntries(
        Object.entries(state.taskMetaByEntityKey).filter(([entityKey]) => {
          const workspaceKey = entityKey.split("::")[0] ?? "";
          return !invalidatedWorkspaceKeySet.has(workspaceKey);
        }),
      );

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  clearAll: () =>
    set(() => ({
      // clearAll is a Zustand action and must be written back to the store through set.
      // Previously, only objects were returned, and the old task meta would continue to remain when cleaning the query cache in test and development states.
      resultsByQueryKey: {},
      taskMetaByEntityKey: {},
      taskUnreadOverlayByEntityKey: {},
    })),
}));

export function invalidateTaskQueryCacheByScopes(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().invalidateWorkspaceKeys(workspaceKeys);
}

export function markTaskQueryCacheScopesStale(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().markWorkspaceKeysStale(workspaceKeys);
}

export function upsertTaskQueryCacheTaskMeta(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().upsertTaskMeta(task);
}

export function updateTaskQueryCacheTaskMetaPreservingMembership(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().updateTaskMetaPreservingMembership(task);
}

export function applyTaskQueryCacheMutation(params: {
  previousTask: ZCodeTaskMeta;
  nextTask: ZCodeTaskMeta;
  previousState: TaskListMembershipState;
  nextState: TaskListMembershipState;
}): void {
  useTaskQueryCacheStore.getState().applyTaskMutation(params);
  if (!params.previousState.archived && params.nextState.archived) {
    notifyTaskLifecycle({
      type: "archived",
      taskId: params.nextTask.taskId,
      workspaceKey: buildTaskWorkspaceKey(
        params.nextTask.workspacePath,
        params.nextTask.workspaceIdentity,
      ),
    });
  }
}

export function setTaskQueryCacheUnreadOverlay(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().setTaskUnreadOverlay(task, unreadAt);
}

export function reconcileTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().reconcileTaskUnread(task, unreadAt);
}

export function rollbackTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().rollbackTaskUnread(task, unreadAt);
}

export function removeTaskFromTaskQueryCaches(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): boolean {
  const removed = useTaskQueryCacheStore.getState().removeTask(task);
  notifyTaskLifecycle({
    type: "deleted",
    taskId: task.taskId,
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
  });
  return removed;
}

// Memory diagnostic counter: versioned queryKey only adds but does not delete, log first.
uiMemoryDiagnosticsRegistry.register("taskQueryCache", () => {
  const state = useTaskQueryCacheStore.getState();
  return {
    queryKeys: Object.keys(state.resultsByQueryKey).length,
    taskMetas: Object.keys(state.taskMetaByEntityKey).length,
  };
});
