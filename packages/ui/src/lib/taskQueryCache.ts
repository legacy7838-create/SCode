import type {
  ZCodeTaskListKind,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { resolveWorkspaceStateKey } from "@/store/zcodeSessionStoreSelectors.js";

export type TaskEntityKey = string;
export type TaskListCacheKey = string;
export type TaskListQueryKind = ZCodeTaskListKind | "workspace";

export interface TaskListCacheDescriptor {
  kind: TaskListQueryKind;
  sortBy: ZCodeTaskListSortBy;
  search: string;
  expanded: boolean;
  visibleLimit: number | null;
  workspaceKeys: string[];
}

export interface CachedTaskListResult {
  taskKeys: TaskEntityKey[];
  /** Complete unread members of workspace before paging; other list queries can be omitted. */
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  fetchedAt: number;
  /** The query scope is incremented each time it expires; old asynchronous results can only be submitted up to the generation observed when it was started. */
  invalidationVersion: number;
  stale: boolean;
  partial: boolean;
  loadingShardKeys: string[];
  failedShardKeys: string[];
  descriptor: TaskListCacheDescriptor;
}

export function buildTaskWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
}

export function buildTaskEntityKey(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): TaskEntityKey {
  return `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}::${task.taskId}`;
}

function normalizeTaskListWorkspaceScopes(
  scopes: ZCodeTaskListWorkspaceScope[],
): ZCodeTaskListWorkspaceScope[] {
  const uniqueScopes = new Map<string, ZCodeTaskListWorkspaceScope>();

  for (const scope of scopes) {
    const workspaceKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
    if (!workspaceKey.trim()) {
      continue;
    }
    uniqueScopes.set(workspaceKey, scope);
  }

  return [...uniqueScopes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scope]) => scope);
}

function normalizeTaskListSearch(search?: string): string {
  return search?.trim().toLocaleLowerCase() ?? "";
}

export function buildTaskListCacheDescriptor(params: {
  kind: TaskListQueryKind;
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  sortBy: ZCodeTaskListSortBy;
  search?: string;
  expanded: boolean;
  visibleLimit?: number | null;
}): TaskListCacheDescriptor {
  const normalizedScopes = normalizeTaskListWorkspaceScopes(params.workspaceScopes);
  const workspaceKeys = normalizedScopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );

  return {
    kind: params.kind,
    sortBy: params.sortBy,
    search: normalizeTaskListSearch(params.search),
    expanded: params.expanded,
    visibleLimit: params.expanded || params.visibleLimit === undefined ? null : params.visibleLimit,
    workspaceKeys,
  };
}

export function buildTaskListCacheKeyFromDescriptor(
  descriptor: TaskListCacheDescriptor,
): TaskListCacheKey {
  const workspaceSegment = descriptor.workspaceKeys.join("|");

  return [
    descriptor.kind,
    descriptor.sortBy,
    descriptor.expanded ? "expanded" : "collapsed",
    // timeline/show more will increase visibleLimit from 20 to 40/60.
    // If the cache key does not contain limit, the expanded query will hit the old first-screen cache and skip refreshing, causing "Show More" to not fill in the data.
    `limit=${descriptor.visibleLimit ?? "all"}`,
    `search=${descriptor.search}`,
    `workspaces=${workspaceSegment}`,
  ].join("::");
}
