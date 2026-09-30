// Sidebar persistent rows read authoritatively with pin/archive/groups. tasks-index.sqlite provides a collection of rows and
// membership, sessions-index only supplement real-time activity/detail in subsequent projections.
// unread is also in the organizational state (setTaskUnread writes tasks-index), which is similar to pin/archive.
// Do not enter the frozen sessions-index schema; here the unreadAt map is pulled in parallel and joined when the list is built.
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";

interface TaskListMembershipScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

type TaskListMembershipService = Pick<
  IZCodeTaskService,
  "listPinnedTaskIds" | "listArchivedTasks" | "listTasks" | "listPinnedTasks"
> &
  Partial<Pick<IZCodeTaskService, "listDeletedTaskIds">>;

interface TaskListMembershipSets {
  /**
   * The union of full task rows across the three persisted tasks-index partitions
   * (active/pinned/archived).
   */
  taskIndexItems: ZCodeTaskMeta[];
  pinnedIds: Set<string>;
  archivedIds: Set<string>;
  /** The persisted deletion tombstone in tasks-index; it takes precedence over every list kind. */
  deletedIds: Set<string>;
  /**
   * taskId → unreadAt (organization state in tasks-index; not carried by sessions-index, used for
   * joins).
   */
  unreadAtByTaskId: Map<string, number>;
  /**
   * taskId → terminal status (historical final state in tasks-index; used to backfill the unread
   * dot on cold-start stored summaries).
   */
  terminalStatusByTaskId: Map<string, Extract<ZCodeTaskMeta["status"], "completed" | "error">>;
  /**
   * taskId → the legacy task-index manual title.
   *
   * The v4 sessions-index main list comes from the CLI session store; user renames in legacy data
   * live only in tasks-index.title/titleOverridden. This rides along on the existing membership
   * read, with no table migration.
   */
  titleOverrideByTaskId: Map<string, string>;
  /**
   * taskId -> cronAutomationId (identity persisted in tasks-index; not carried by the frozen
   * sessions-index schema).
   */
  cronAutomationIdByTaskId: Map<string, string>;
}

export interface TaskListMembershipRefreshHoldState {
  armed: boolean;
  enteredCallCount: number;
  released: boolean;
}

interface ActiveTaskListMembershipRefreshHold {
  released: Promise<void>;
  release: () => void;
}

let activeTaskListMembershipRefreshHold: ActiveTaskListMembershipRefreshHold | null = null;
let taskListMembershipRefreshHoldState: TaskListMembershipRefreshHoldState = {
  armed: false,
  enteredCallCount: 0,
  released: true,
};

/**
 * E2E-only: pause a membership snapshot that has finished reading but has not yet been returned to
 * the renderer join. TSL18 has to deterministically create the window where a “stale running
 * snapshot returns after the Stop terminal state”; real SQLite is too fast to gamble on with sleep.
 * The entry point is exposed only through the protected window.__testActions.
 */
export function armTaskListMembershipRefreshHoldForE2E(): void {
  if (activeTaskListMembershipRefreshHold) {
    throw new Error("task list membership refresh hold is already armed");
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeTaskListMembershipRefreshHold = { released, release };
  taskListMembershipRefreshHoldState = {
    armed: true,
    enteredCallCount: 0,
    released: false,
  };
  clearTaskListMembershipCache();
}

export function releaseTaskListMembershipRefreshHoldForE2E(): void {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  activeTaskListMembershipRefreshHold = null;
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    armed: false,
    released: true,
  };
  hold.release();
}

export function getTaskListMembershipRefreshHoldStateForE2E(): TaskListMembershipRefreshHoldState {
  return { ...taskListMembershipRefreshHoldState };
}

async function holdTaskListMembershipRefreshResultForE2E(): Promise<void> {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    enteredCallCount: taskListMembershipRefreshHoldState.enteredCallCount + 1,
  };
  await hold.released;
}

/**
 * A remote shard's membership lives in the tasks-index of its own endpoint; the per-endpoint shards
 * are fetched and unioned.
 */
interface TaskListMembershipEndpoint {
  service: TaskListMembershipService;
  scopes: TaskListMembershipScope[];
}

function scopeParams(scope: TaskListMembershipScope): {
  workspacePath: string;
  workspaceIdentity?: string;
} {
  return {
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  };
}

/** When an optional auxiliary set fails to read, fall back to the empty set. */
async function listOrEmpty<T>(list: () => Promise<T[]>): Promise<T[]> {
  try {
    return await list();
  } catch {
    return [];
  }
}

async function listWithAvailability<T>(
  list: () => Promise<T[]>,
): Promise<{ items: T[]; available: boolean }> {
  try {
    return { items: await list(), available: true };
  } catch {
    return { items: [], available: false };
  }
}

function collectUnreadAt(unreadAtByTaskId: Map<string, number>, tasks: ZCodeTaskMeta[]): void {
  for (const task of tasks) {
    if (typeof task.unreadAt === "number") {
      unreadAtByTaskId.set(task.taskId, task.unreadAt);
    }
  }
}

function collectTerminalStatuses(
  terminalStatusByTaskId: TaskListMembershipSets["terminalStatusByTaskId"],
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "error") {
      terminalStatusByTaskId.set(task.taskId, task.status);
    }
  }
}

function collectTitleOverrides(
  titleOverrideByTaskId: Map<string, string>,
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.titleOverridden === true && task.title.trim().length > 0) {
      titleOverrideByTaskId.set(task.taskId, task.title);
    }
  }
}

function collectCronAutomationIds(
  cronAutomationIdByTaskId: Map<string, string>,
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.cronAutomationId) {
      cronAutomationIdByTaskId.set(task.taskId, task.cronAutomationId);
    }
  }
}

function mergeTaskIndexItems(lists: ZCodeTaskMeta[][]): ZCodeTaskMeta[] {
  const itemByEntityKey = new Map<string, ZCodeTaskMeta>();
  for (const task of lists.flat()) {
    itemByEntityKey.set(buildTaskEntityKey(task), task);
  }
  return [...itemByEntityKey.values()];
}

/**
 * Fetches the server-authoritative task rows, the pinned/archived id sets, and other persisted
 * metadata.
 */
export async function fetchTaskListMembershipSets(params: {
  service: TaskListMembershipService;
  scopes: TaskListMembershipScope[];
}): Promise<TaskListMembershipSets> {
  const [
    pinnedList,
    archivedListResults,
    activeListResults,
    pinnedMetaListResults,
    deletedIdLists,
  ] = await Promise.all([
    listOrEmpty(() => params.service.listPinnedTaskIds()),
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listArchivedTasks(scopeParams(scope))),
      ),
    ),
    // unread covers three types of members: active (listTasks = non-pinned, non-archived), pinned, and archived.
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listTasks(scopeParams(scope))),
      ),
    ),
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listPinnedTasks(scopeParams(scope))),
      ),
    ),
    Promise.all(
      params.scopes.map((scope) =>
        params.service.listDeletedTaskIds
          ? listOrEmpty(() => params.service.listDeletedTaskIds!(scopeParams(scope)))
          : Promise.resolve([]),
      ),
    ),
  ]);
  await holdTaskListMembershipRefreshResultForE2E();
  // The task row is now the left table of all sidebar lists. Any partition RPC failure cannot
  // Publish it as the "authoritative empty set", otherwise the entire old cache will be cleared; after throwing, the hook will retain the old view.
  if (
    activeListResults.some((result) => !result.available) ||
    archivedListResults.some((result) => !result.available) ||
    pinnedMetaListResults.some((result) => !result.available)
  ) {
    throw new Error("incomplete tasks-index task row read");
  }
  const archivedLists = archivedListResults.map((result) => result.items);
  const activeLists = activeListResults.map((result) => result.items);
  const pinnedMetaLists = pinnedMetaListResults.map((result) => result.items);
  const unreadAtByTaskId = new Map<string, number>();
  const terminalStatusByTaskId: TaskListMembershipSets["terminalStatusByTaskId"] = new Map();
  const titleOverrideByTaskId = new Map<string, string>();
  const cronAutomationIdByTaskId = new Map<string, string>();
  collectUnreadAt(unreadAtByTaskId, archivedLists.flat());
  collectUnreadAt(unreadAtByTaskId, activeLists.flat());
  collectUnreadAt(unreadAtByTaskId, pinnedMetaLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, archivedLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, activeLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, pinnedMetaLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, archivedLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, activeLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, pinnedMetaLists.flat());
  // After the V4 sidebar main data source is switched to sessions-index, the frozen SessionSummary does not
  // cronAutomationId; if it is not collected from tasks-index here, even though the persistent column has a value, the UI task will still lose its identity.
  collectCronAutomationIds(cronAutomationIdByTaskId, archivedLists.flat());
  collectCronAutomationIds(cronAutomationIdByTaskId, activeLists.flat());
  collectCronAutomationIds(cronAutomationIdByTaskId, pinnedMetaLists.flat());
  return {
    // Persistent task row existence must be determined by tasks-index. Previously, only memberships were reserved here.
    // Collects and discards the task meta that has been read, forcing all lists to be enumerated backwards from sessions-index.
    taskIndexItems: mergeTaskIndexItems([
      activeLists.flat(),
      pinnedMetaLists.flat(),
      archivedLists.flat(),
    ]),
    // The pinned task line itself is evidence of membership; even if the secondary id RPC fails briefly,
    // Pinned lines that have been successfully read should not be mistakenly assigned to the timeline.
    pinnedIds: new Set([...pinnedList, ...pinnedMetaLists.flat().map((task) => task.taskId)]),
    archivedIds: new Set(archivedLists.flat().map((task) => task.taskId)),
    deletedIds: new Set(deletedIdLists.flat()),
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  };
}

// Delta update correction: membership (pin/archive/unread) only changes with the attribution mutation (membershipVersion bump),
// Has nothing to do with sessions-index content frames (title/status/lastActivity). Previously, every frame was repulsed - a title change
// All list instances will each send a round of 1+3×scopes RPC (hundreds of calls per frame under multiple workspaces and multiple instances).
// Here, in-flight promises are cached according to "membershipVersion + endpoints signature" and shared across hook instances;
// When the version bump or endpoint topology changes, the key will be naturally changed and re-pulled. The cache is bounded to avoid accumulation of historical versions.
const membershipPromiseByCacheKey = new Map<string, Promise<TaskListMembershipSets>>();
const MEMBERSHIP_CACHE_MAX_KEYS = 8;
// Service instance identity key: Different endpoint services (including test mocks and new proxies after reconnection) must not share cache.
const membershipServiceIds = new WeakMap<TaskListMembershipService, number>();
let nextMembershipServiceId = 1;

function membershipServiceIdOf(service: TaskListMembershipService): number {
  let id = membershipServiceIds.get(service);
  if (id === undefined) {
    id = nextMembershipServiceId++;
    membershipServiceIds.set(service, id);
  }
  return id;
}

export function fetchTaskListMembershipSetsForEndpointsCached(params: {
  /** Suggested shape: `${membershipVersion}::${endpoints signature}`. */
  cacheKey: string;
  endpoints: TaskListMembershipEndpoint[];
}): Promise<TaskListMembershipSets> {
  const fullCacheKey = `${params.cacheKey}::svc=${params.endpoints
    .map((endpoint) => membershipServiceIdOf(endpoint.service))
    .join(",")}`;
  const cached = membershipPromiseByCacheKey.get(fullCacheKey);
  if (cached) {
    return cached;
  }
  const promise = fetchTaskListMembershipSetsForEndpoints(params.endpoints);
  membershipPromiseByCacheKey.set(fullCacheKey, promise);
  // The auxiliary set can be downgraded according to the empty set, but incomplete reading of the task row partition will reject; failure will not be cached,
  // Prevent a short-lived RPC exception from being stuck in the current version.
  promise.catch(() => membershipPromiseByCacheKey.delete(fullCacheKey));
  while (membershipPromiseByCacheKey.size > MEMBERSHIP_CACHE_MAX_KEYS) {
    const oldestKey = membershipPromiseByCacheKey.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    membershipPromiseByCacheKey.delete(oldestKey);
  }
  return promise;
}

/** For tests / failure recovery: clear the membership cache. */
function clearTaskListMembershipCache(): void {
  membershipPromiseByCacheKey.clear();
}

/**
 * Fetches membership per endpoint in parallel and unions it (taskId is the sessionId, so it does
 * not collide across endpoints).
 */
async function fetchTaskListMembershipSetsForEndpoints(
  endpoints: TaskListMembershipEndpoint[],
): Promise<TaskListMembershipSets> {
  const results = await Promise.all(
    endpoints
      .filter((endpoint) => endpoint.scopes.length > 0)
      .map((endpoint) =>
        fetchTaskListMembershipSets({
          service: endpoint.service,
          scopes: endpoint.scopes,
        }),
      ),
  );
  const merged: TaskListMembershipSets = {
    taskIndexItems: [],
    pinnedIds: new Set<string>(),
    archivedIds: new Set<string>(),
    deletedIds: new Set<string>(),
    unreadAtByTaskId: new Map<string, number>(),
    terminalStatusByTaskId: new Map(),
    titleOverrideByTaskId: new Map<string, string>(),
    cronAutomationIdByTaskId: new Map<string, string>(),
  };
  const taskIndexItemByEntityKey = new Map<string, ZCodeTaskMeta>();
  for (const result of results) {
    for (const task of result.taskIndexItems) {
      taskIndexItemByEntityKey.set(buildTaskEntityKey(task), task);
    }
    for (const taskId of result.pinnedIds) merged.pinnedIds.add(taskId);
    for (const taskId of result.archivedIds) merged.archivedIds.add(taskId);
    for (const taskId of result.deletedIds) merged.deletedIds.add(taskId);
    for (const [taskId, unreadAt] of result.unreadAtByTaskId) {
      merged.unreadAtByTaskId.set(taskId, unreadAt);
    }
    for (const [taskId, status] of result.terminalStatusByTaskId) {
      merged.terminalStatusByTaskId.set(taskId, status);
    }
    for (const [taskId, title] of result.titleOverrideByTaskId) {
      merged.titleOverrideByTaskId.set(taskId, title);
    }
    for (const [taskId, automationId] of result.cronAutomationIdByTaskId) {
      merged.cronAutomationIdByTaskId.set(taskId, automationId);
    }
  }
  merged.taskIndexItems = [...taskIndexItemByEntityKey.values()];
  return merged;
}
