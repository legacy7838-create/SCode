/* eslint-disable max-lines -- The Grouped view hook centrally maintains the optimistic overlay,
 * sort persistence and ungroup persistence; splitting them apart would let the same view state
 * drift across several hooks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { buildGroupedTaskViewFromSessions } from "@/lib/buildGroupedTaskViewFromSessions.js";
import { mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import { fetchTaskListMembershipSets } from "@/lib/taskListMembershipSets.js";
import { useTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import {
  useWorkspaceTaskOptimisticOverlayByWorkspaceKey,
  type WorkspaceOptimisticTaskOverlay,
} from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import { moveTaskToGroupStart } from "@/workspace-grouped-tasks/view.js";
import { areStabilizedValuesEquivalent } from "@/v4/taskListItemStabilization.js";
import { taskKey as groupedTaskKey } from "@/workspace-grouped-tasks/ids.js";

function applyPromotedGroupPlacements(
  view: ZCodeGroupedTaskView,
  promotedDraftByTaskKey: ReadonlyMap<
    string,
    WorkspaceOptimisticTaskOverlay["promotedGroupedDraftTaskByTaskId"][string]
  >,
  optimisticTaskByKey: ReadonlyMap<string, ZCodeTaskMeta>,
): ZCodeGroupedTaskView {
  let nextView = view;
  for (const [taskKey, promotedDraft] of promotedDraftByTaskKey) {
    if (promotedDraft.placement.type === "top") {
      const rootIndex = nextView.nodes.findIndex(
        (node) => node.type === "task" && buildTaskEntityKey(node.task) === taskKey,
      );
      if (rootIndex <= 0) continue;
      // When sessions-index and the grouped structure arrive asynchronously, an out-of-order task is temporarily appended to the end.
      // Until the promoted state converges, keep using the draft's root top position to avoid the same row jumping to the bottom and then back to the top.
      const nodes = [...nextView.nodes];
      const [rootTask] = nodes.splice(rootIndex, 1);
      if (rootTask) nodes.unshift(rootTask);
      nextView = { nodes };
      continue;
    }
    const task = optimisticTaskByKey.get(taskKey);
    if (!task) {
      continue;
    }
    if (isTaskFirstInGroup(nextView, taskKey, promotedDraft.placement.groupId)) {
      continue;
    }
    nextView = moveTaskToGroupStart(nextView, {
      activeTaskKey: groupedTaskKey(task),
      groupId: promotedDraft.placement.groupId,
    });
  }
  return nextView;
}

function findTaskInGroupedView(
  view: ZCodeGroupedTaskView,
  taskEntityKey: string,
): ZCodeTaskMeta | undefined {
  for (const node of view.nodes) {
    if (node.type === "group") {
      const task = node.tasks.find((candidate) => buildTaskEntityKey(candidate) === taskEntityKey);
      if (task) return task;
      continue;
    }
    if (buildTaskEntityKey(node.task) === taskEntityKey) return node.task;
  }
  return undefined;
}

function isTaskFirstInGroup(
  view: ZCodeGroupedTaskView,
  taskEntityKey: string,
  groupId: string,
): boolean {
  const group = view.nodes.find((node) => node.type === "group" && node.group.id === groupId);
  return Boolean(
    group?.type === "group" &&
    group.tasks[0] &&
    buildTaskEntityKey(group.tasks[0]) === taskEntityKey,
  );
}

function buildWorkspaceScopes(workspaceTabs: WorkspaceTabState[]) {
  return workspaceTabs.map((tab) => ({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    workspacePurpose: tab.workspacePurpose,
  }));
}

function collectViewWorkspaceScopes(
  view: ZCodeGroupedTaskView,
): Array<{ workspacePath: string; workspaceIdentity?: string }> {
  const workspaceScopes = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
  const addTask = (task: ZCodeTaskMeta) => {
    const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
    workspaceScopes.set(workspaceKey, {
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
    });
  };

  for (const node of view.nodes) {
    if (node.type === "group") {
      node.tasks.forEach(addTask);
      continue;
    }
    addTask(node.task);
  }

  return [...workspaceScopes.values()];
}

function mergeGroupedTaskViewWithOptimistic(params: {
  view: ZCodeGroupedTaskView;
  optimisticOverlays: Iterable<WorkspaceOptimisticTaskOverlay>;
  visibleMissingTaskKeys: ReadonlySet<string>;
}): ZCodeGroupedTaskView {
  const optimisticTaskByKey = new Map<string, ZCodeTaskMeta>();
  const placementTaskByKey = new Map<string, ZCodeTaskMeta>();
  const promotedDraftByTaskKey = new Map<
    string,
    WorkspaceOptimisticTaskOverlay["promotedGroupedDraftTaskByTaskId"][string]
  >();

  for (const node of params.view.nodes) {
    if (node.type === "group") {
      for (const task of node.tasks) placementTaskByKey.set(buildTaskEntityKey(task), task);
      continue;
    }
    placementTaskByKey.set(buildTaskEntityKey(node.task), node.task);
  }

  for (const overlay of params.optimisticOverlays) {
    for (const task of overlay.tasks) {
      const taskKey = buildTaskEntityKey(task);
      optimisticTaskByKey.set(taskKey, task);
      placementTaskByKey.set(taskKey, task);
      // The optimistic overlay is a cross-hook runtime object; old tests and old callers may not have
      // promotedGroupedDraftTaskByTaskId yet. Use an empty object here to tolerate the missing field, so the grouped merge stage
      // doesn't crash outright when draft placement info is absent; when absent, insert at the top level like a normal optimistic task.
    }
    for (const [taskId, promotedDraft] of Object.entries(
      overlay.promotedGroupedDraftTaskByTaskId ?? {},
    )) {
      promotedDraftByTaskKey.set(
        buildTaskEntityKey({
          taskId,
          workspacePath: promotedDraft.workspacePath,
          workspaceIdentity: promotedDraft.workspaceIdentity,
        }),
        promotedDraft,
      );
    }
  }

  if (optimisticTaskByKey.size === 0 && promotedDraftByTaskKey.size === 0) {
    return params.view;
  }

  const visibleTaskKeys = new Set<string>();
  let changed = false;
  const nodes = params.view.nodes.map((node) => {
    if (node.type === "group") {
      let tasksChanged = false;
      const tasks = node.tasks.map((task) => {
        const taskKey = buildTaskEntityKey(task);
        visibleTaskKeys.add(taskKey);
        const optimisticTask = optimisticTaskByKey.get(taskKey);
        if (!optimisticTask) {
          return task;
        }
        tasksChanged = true;
        // Grouped optimistic meta must not overwrite sessions-index with the whole object either.
        // Otherwise, even though the explicit sort_order didn't change, the row's time/phase would be polluted by tasks-index timestamps.
        // A minimal overlay promoted from a grouped draft has an empty title; spreading the whole object
        // would keep suppressing the real title sessions-index sends later. Merge authoritatively by task meta fields first,
        // then keep the membership/activity fields owned by sessions-index.
        return mergeTaskListMembershipFields(
          task,
          mergeTaskWithOptimisticMeta(task, optimisticTask),
        );
      });
      if (!tasksChanged) {
        return node;
      }
      changed = true;
      return { ...node, tasks };
    }

    const taskKey = buildTaskEntityKey(node.task);
    visibleTaskKeys.add(taskKey);
    const optimisticTask = optimisticTaskByKey.get(taskKey);
    if (!optimisticTask) {
      return node;
    }
    changed = true;
    return {
      ...node,
      task: mergeTaskListMembershipFields(
        node.task,
        mergeTaskWithOptimisticMeta(node.task, optimisticTask),
      ),
    };
  });

  const missingVisibleTasks = [...optimisticTaskByKey.entries()]
    .filter(
      ([taskKey]) => params.visibleMissingTaskKeys.has(taskKey) && !visibleTaskKeys.has(taskKey),
    )
    .map(([, task]) => task)
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      if (right.createdAt !== left.createdAt) {
        return right.createdAt - left.createdAt;
      }
      return right.taskId.localeCompare(left.taskId);
    });

  if (missingVisibleTasks.length === 0) {
    return applyPromotedGroupPlacements(
      changed ? { nodes } : params.view,
      promotedDraftByTaskKey,
      placementTaskByKey,
    );
  }

  const groupMissingTasksByGroupId = new Map<string, ZCodeTaskMeta[]>();
  const topMissingTasks: ZCodeTaskMeta[] = [];
  for (const task of missingVisibleTasks) {
    const promotedDraft = promotedDraftByTaskKey.get(buildTaskEntityKey(task));
    if (promotedDraft?.placement.type === "group") {
      const groupTasks = groupMissingTasksByGroupId.get(promotedDraft.placement.groupId) ?? [];
      groupTasks.push(task);
      groupMissingTasksByGroupId.set(promotedDraft.placement.groupId, groupTasks);
      continue;
    }
    topMissingTasks.push(task);
  }

  const nodesWithGroupDraftTasks = nodes.map((node) => {
    if (node.type !== "group") {
      return node;
    }
    const groupTasks = groupMissingTasksByGroupId.get(node.group.id);
    if (!groupTasks?.length) {
      return node;
    }
    return { ...node, tasks: [...groupTasks, ...node.tasks] };
  });
  const missingGroupTasksWithoutGroup = [...groupMissingTasksByGroupId.entries()]
    .filter(([, tasks]) => tasks.length > 0)
    .flatMap(([groupId, tasks]) =>
      nodes.some((node) => node.type === "group" && node.group.id === groupId) ? [] : tasks,
    );

  // The grouped view used to show only sqlite query results; a freshly created task is already written to the local optimistic
  // cache, but the server's initial snapshot delays broadcasting to avoid flashing "New session", so the grouped list wouldn't see the new task until a restart
  // or the next full refresh. Here we only backfill optimistic tasks already marked as temporarily visible by the grouped hook,
  // avoiding mistakenly re-inserting other local caches (archived/pinned, etc.) at the grouped top level; tasks promoted from a grouped draft
  // also keep the group/top position of the temporary entity until the sqlite ordering is saved.
  return applyPromotedGroupPlacements(
    {
      nodes: [
        ...topMissingTasks.concat(missingGroupTasksWithoutGroup).map((task) => ({
          type: "task" as const,
          task,
        })),
        ...nodesWithGroupDraftTasks,
      ],
    },
    promotedDraftByTaskKey,
    placementTaskByKey,
  );
}

function collectGroupedViewTaskKeys(view: ZCodeGroupedTaskView): Set<string> {
  const taskKeys = new Set<string>();
  for (const node of view.nodes) {
    if (node.type === "group") {
      for (const task of node.tasks) {
        taskKeys.add(buildTaskEntityKey(task));
      }
      continue;
    }
    taskKeys.add(buildTaskEntityKey(node.task));
  }
  return taskKeys;
}

export function shouldHideGroupedTaskContent(params: {
  initialized: boolean;
  loading: boolean;
  hasNodes: boolean;
  /**
   * The gate should only hold back the first screen. Returning to the hidden state after the list
   * has already been painted is exactly the "the whole grouped block flashes once" users see —
   * ancestor remounts and background refreshes both land here. Once painted, the previous list is
   * always kept rendering: stale data beats a blank screen.
   */
  hasPaintedOnce?: boolean;
}): boolean {
  if (params.hasPaintedOnce) {
    return false;
  }
  return !params.initialized || (params.loading && !params.hasNodes);
}

function isGroupedTaskViewInitialized(params: {
  remoteDataInitialized: boolean;
  hydratingEndpointKeys: readonly string[];
  /**
   * This gate only handles the first screen. It used to read the current hydrating state directly,
   * so every tool result emitted by a running task would make the Controller list re-query once
   * (loading=true), closing the gate and unmounting then remounting the whole grouped subtree —
   * which showed up as the grouped list on the left jittering. After becoming ready once it stays
   * ready for good; background refreshes no longer fall back to the first-screen state.
   */
  previouslyInitialized?: boolean;
}): boolean {
  if (params.previouslyInitialized) {
    return true;
  }
  return params.remoteDataInitialized && params.hydratingEndpointKeys.length === 0;
}

/**
 * A per-key single-flight cache for grouped structure/membership.
 *
 * When switching to the grouped view, the hook mount and the first sessions-index frame refresh
 * concurrently; the old cache only stored settled results, so every cache miss requested all
 * workspaces on its own, causing an RPC storm and constantly cycling the loading state. Here the
 * in-flight Promise is stored as well, and generation/sequence stop late results from a stale key
 * or a superseded request from backfilling the cache.
 */
class GroupedRemoteDataSingleFlight<T> {
  private generation = 0;
  private requestSequence = 0;
  private completed: { key: string; value: T } | null = null;
  private readonly inFlightByKey = new Map<
    string,
    {
      generation: number;
      latestRequestSequence: number;
      promise: Promise<T> | null;
    }
  >();

  load(key: string, fetchValue: () => Promise<T>): Promise<T> {
    const requestSequence = this.requestSequence + 1;
    this.requestSequence = requestSequence;
    if (this.completed?.key === key) {
      return Promise.resolve(this.completed.value);
    }

    const generation = this.generation;
    const existing = this.inFlightByKey.get(key);
    if (existing?.generation === generation && existing.promise) {
      existing.latestRequestSequence = requestSequence;
      return existing.promise;
    }

    const inFlight = {
      generation,
      latestRequestSequence: requestSequence,
      promise: null as Promise<T> | null,
    };
    const promise = Promise.resolve()
      .then(fetchValue)
      .then((value) => {
        if (
          this.generation === generation &&
          this.requestSequence === inFlight.latestRequestSequence
        ) {
          this.completed = { key, value };
        }
        return value;
      })
      .finally(() => {
        if (this.inFlightByKey.get(key)?.promise === promise) {
          this.inFlightByKey.delete(key);
        }
      });
    inFlight.promise = promise;
    this.inFlightByKey.set(key, inFlight);
    return promise;
  }

  isCurrent(key: string, value: T): boolean {
    return this.completed?.key === key && this.completed.value === value;
  }

  invalidate(): void {
    this.generation += 1;
    this.completed = null;
    this.inFlightByKey.clear();
  }
}

function prependTaskGroupToView(
  view: ZCodeGroupedTaskView,
  group: ZCodeTaskGroup,
): ZCodeGroupedTaskView {
  if (view.nodes.some((node) => node.type === "group" && node.group.id === group.id)) {
    return view;
  }
  const minimumSortOrder = view.nodes.reduce(
    (minimum, node) => Math.min(minimum, node.sortOrder ?? 0),
    0,
  );
  return {
    nodes: [
      {
        type: "group",
        group,
        tasks: [],
        sortOrder: minimumSortOrder - 1000,
      },
      ...view.nodes,
    ],
  };
}

function reconcileGroupedOptimisticTaskKeys(params: {
  view: ZCodeGroupedTaskView;
  optimisticOverlays: Iterable<WorkspaceOptimisticTaskOverlay>;
  previousVisibleMissingTaskKeys: ReadonlySet<string>;
}): Set<string> {
  const groupedViewTaskKeys = collectGroupedViewTaskKeys(params.view);
  const optimisticTaskKeys = new Set<string>();
  const nextVisibleMissingTaskKeys = new Set<string>();

  for (const overlay of params.optimisticOverlays) {
    for (const task of overlay.tasks) {
      const taskKey = buildTaskEntityKey(task);
      optimisticTaskKeys.add(taskKey);
      if (overlay.activeTaskId === task.taskId && !groupedViewTaskKeys.has(taskKey)) {
        nextVisibleMissingTaskKeys.add(taskKey);
      }
    }
  }

  for (const taskKey of params.previousVisibleMissingTaskKeys) {
    if (groupedViewTaskKeys.has(taskKey) || !optimisticTaskKeys.has(taskKey)) {
      continue;
    }
    nextVisibleMissingTaskKeys.add(taskKey);
  }

  return nextVisibleMissingTaskKeys;
}

function groupedNodeIdentityKey(node: ZCodeGroupedTaskView["nodes"][number]): string {
  if (node.type === "group") {
    return `group:${node.group.id}`;
  }
  return `task:${buildTaskWorkspaceKey(node.task.workspacePath, node.task.workspaceIdentity)}:${node.task.taskId}`;
}

function areGroupedNodesEquivalent(
  previous: ZCodeGroupedTaskView["nodes"][number],
  next: ZCodeGroupedTaskView["nodes"][number],
): boolean {
  if (previous.type !== next.type || previous.sortOrder !== next.sortOrder) {
    return false;
  }
  if (previous.type === "group" && next.type === "group") {
    // Compare structurally rather than with JSON.stringify: after group meta is rebuilt through IPC/join the key order isn't guaranteed stable,
    // and string comparison would make the equivalence check always false, silently degrading node stabilization into fresh references every frame.
    if (!areStabilizedValuesEquivalent(previous.group, next.group)) {
      return false;
    }
    // The task objects come from the sessions-index aggregation layer (references already stabilized) + joinTaskListUnreadAt (keeps the reference if unchanged),
    // so identical references element-wise means equivalent content.
    return (
      previous.tasks.length === next.tasks.length &&
      next.tasks.every((task, index) => task === previous.tasks[index])
    );
  }
  return previous.type === "task" && next.type === "task" && previous.task === next.task;
}

/**
 * Every grouped refresh rebuilds the entire view object tree, so even when nothing changed (or only
 * one row did), all group/task rows get new references and re-render wholesale — which shows up as
 * the sidebar's grouped list “reloading”. Here references are stabilized at the node level:
 * equivalent nodes reuse the old objects, and when the whole tree is equivalent the old view is
 * returned (setState bails out on an identical reference).
 */
function stabilizeGroupedView(
  previous: ZCodeGroupedTaskView,
  next: ZCodeGroupedTaskView,
): ZCodeGroupedTaskView {
  if (previous.nodes.length === 0) {
    return next;
  }
  const previousByKey = new Map(previous.nodes.map((node) => [groupedNodeIdentityKey(node), node]));
  let identical = previous.nodes.length === next.nodes.length;
  const nodes = next.nodes.map((node, index) => {
    const previousNode = previousByKey.get(groupedNodeIdentityKey(node));
    if (previousNode && areGroupedNodesEquivalent(previousNode, node)) {
      if (identical && previous.nodes[index] !== previousNode) {
        identical = false;
      }
      return previousNode;
    }
    identical = false;
    return node;
  });
  return identical ? previous : { nodes };
}

function nodeToTopLevelRef(
  node: ZCodeGroupedTaskView["nodes"][number],
): ZCodeGroupedTaskViewTopLevelNodeRef {
  if (node.type === "group") {
    return { type: "group", groupId: node.group.id };
  }
  return {
    type: "task",
    task: {
      workspacePath: node.task.workspacePath,
      workspaceIdentity: node.task.workspaceIdentity,
      taskId: node.task.taskId,
    },
  };
}

function viewToOrderInput(params: { view: ZCodeGroupedTaskView }): ZCodeGroupedTaskViewOrderInput {
  return {
    workspaceScopes: collectViewWorkspaceScopes(params.view),
    topLevelNodes: params.view.nodes.map(nodeToTopLevelRef),
    groups: params.view.nodes
      .filter((node) => node.type === "group")
      .map((node) => ({
        groupId: node.group.id,
        taskRefs: node.tasks.map((task) => ({
          workspacePath: task.workspacePath,
          workspaceIdentity: task.workspaceIdentity,
          taskId: task.taskId,
        })),
      })),
  };
}

/**
 * A grouped view cache that survives remounts (bucketed by scope signature).
 *
 * grouped is the only sidebar view that keeps the whole list in a component instance's useState;
 * timeline/pinned all render from a module-level query cache. As soon as the section remounts
 * (ancestor remount / HMR), grouped falls back to "empty view + first-screen gate closed" until the
 * two RPCs come back — which shows up as the whole grouped list flashing once. Here the last
 * authoritative view is kept at module level so a remount can keep painting immediately, and the
 * RPCs only converge it.
 *
 * Dirty-read window (an explicit contract, not a defect): the cache is written only when a refresh
 * succeeds and is never proactively invalidated. Deletions / archiving / regrouping that happen
 * while the component is unmounted do not evict the cache, so after a remount those stale rows are
 * immediately visible and clickable until the refresh triggered by the mount effect returns — the
 * upper bound of the window is a single RPC round trip. This is the established "stale data beats a
 * blank screen" trade-off; if reports of clicking stale rows come in later, consider giving cache
 * entries a TTL or downgrading them to placeholders rather than widening this window.
 */
const GROUPED_VIEW_CACHE_MAX_KEYS = 8;
const groupedViewCacheBySignature = new Map<string, ZCodeGroupedTaskView>();

function readCachedGroupedView(signature: string): ZCodeGroupedTaskView | undefined {
  return groupedViewCacheBySignature.get(signature);
}

function writeCachedGroupedView(signature: string, view: ZCodeGroupedTaskView): void {
  groupedViewCacheBySignature.delete(signature);
  groupedViewCacheBySignature.set(signature, view);
  while (groupedViewCacheBySignature.size > GROUPED_VIEW_CACHE_MAX_KEYS) {
    const oldestKey = groupedViewCacheBySignature.keys().next().value;
    if (oldestKey === undefined) break;
    groupedViewCacheBySignature.delete(oldestKey);
  }
}

export function useGroupedTaskView(params: { workspaceTabs: WorkspaceTabState[] }) {
  const services = useBaseWorkspaceServices();
  // Grouped remains local workspace-only, but task facts must also come from the window Controller — no separate
  // sessions-index join in the Renderer. Grouping structure/ordering continues through the local task service, avoiding capability creep.
  const localWorkspaceTabs = useLocalWorkspaceScopes({
    workspaceTabs: params.workspaceTabs,
  });
  // scopes used to be memoized on the tabs array identity. The parent rebuilding an equal-valued array would swap the refresh identity,
  // letting the "refresh changes → re-fetch" effect run another setState round and trigger the next render — a self-triggering refresh loop,
  // issuing RPCs every frame and giving the gate/empty state a chance to flash. Here it's changed to a value signature, consistent with useGlobalTaskList.
  const localWorkspaceScopeSignature = JSON.stringify(
    localWorkspaceTabs
      .map(
        (tab) =>
          [
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
            tab.workspacePath,
            tab.workspaceIdentity ?? null,
            tab.workspacePurpose ?? null,
          ] as const,
      )
      .sort(
        (
          [leftKey, leftPath, leftIdentity, leftPurpose],
          [rightKey, rightPath, rightIdentity, rightPurpose],
        ) =>
          // Level-by-level tie-break: sorting by workspaceKey alone, two tabs with the same key but different purpose compare as 0,
          // and a stable sort preserves input order — swapping positions in the tabs array would produce a new signature and trigger a redundant refresh.
          String(leftKey).localeCompare(String(rightKey)) ||
          String(leftPath).localeCompare(String(rightPath)) ||
          String(leftIdentity ?? "").localeCompare(String(rightIdentity ?? "")) ||
          String(leftPurpose ?? "").localeCompare(String(rightPurpose ?? "")),
      ),
  );
  const scopes = useMemo(
    () => buildWorkspaceScopes(localWorkspaceTabs),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reuse when the value signature is equivalent, avoiding a refresh loop from the parent array changing identity.
    [localWorkspaceScopeSignature],
  );
  const sessionsIndexScopes = useMemo(
    () =>
      scopes.map((scope) => ({
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      })),
    [scopes],
  );
  const [view, setView] = useState<ZCodeGroupedTaskView>(
    () => readCachedGroupedView(localWorkspaceScopeSignature) ?? { nodes: [] },
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const [loading, setLoading] = useState(false);
  const [remoteDataInitialized, setRemoteDataInitialized] = useState(
    () => readCachedGroupedView(localWorkspaceScopeSignature) !== undefined,
  );
  const [saving, setSaving] = useState(false);
  const requestIdRef = useRef(0);
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
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
  const controllerTaskFacts = useGlobalTaskList({
    kind: "active",
    workspaceTabs: localWorkspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 1,
  });
  const sessionsIndexItems = controllerTaskFacts.items;
  // A cache hit counts as initialized: after remount the Controller list goes back into loading, and unless the latch is also
  // seeded from the cache, the first frame would still close the gate and flash.
  const initializedLatchRef = useRef(
    readCachedGroupedView(localWorkspaceScopeSignature) !== undefined,
  );
  const initialized = isGroupedTaskViewInitialized({
    remoteDataInitialized,
    hydratingEndpointKeys: controllerTaskFacts.loading ? ["window-controller"] : [],
    previouslyInitialized: initializedLatchRef.current,
  });
  // Prerequisite for writing ref during rendering (copying to non-monotonic state is prohibited): This ref is a monotonic latch (false→true, never falls back),
  // and the new value is derived entirely from this render's inputs. Renders discarded under React 18 concurrent still execute this assignment,
  // but for a monotonic latch "setting early" equals "ready early" — it only opens the gate sooner and cannot produce a wrong state.
  // Swap in any state that can fall back or depends on commit order, and this pattern would drop frames irreproducibly — such state must use an effect.
  initializedLatchRef.current = initialized;
  const sessionsIndexItemsRef = useRef(sessionsIndexItems);
  sessionsIndexItemsRef.current = sessionsIndexItems;
  // Pin/archive ownership version: bumped after a mutation, so the grouped view (non-pinned, non-archived) authoritatively re-filters.
  const membershipVersion = useTaskListMembershipVersion();
  const optimisticTaskOverlayByWorkspaceKey = useWorkspaceTaskOptimisticOverlayByWorkspaceKey(
    params.workspaceTabs,
  );
  const clearPromotedGroupedDraftTask = useZCodeSessionStore(
    (state) => state.clearPromotedGroupedDraftTask,
  );
  const visibleMissingTaskKeysRef = useRef<Set<string>>(new Set());
  const promotedGroupPersistenceRef = useRef<Set<string>>(new Set());
  const displayedViewRef = useRef<ZCodeGroupedTaskView>({ nodes: [] });
  const displayedView = useMemo(() => {
    const optimisticOverlays = [...optimisticTaskOverlayByWorkspaceKey.values()];
    const visibleMissingTaskKeys = reconcileGroupedOptimisticTaskKeys({
      view,
      optimisticOverlays,
      previousVisibleMissingTaskKeys: visibleMissingTaskKeysRef.current,
    });
    visibleMissingTaskKeysRef.current = visibleMissingTaskKeys;
    // Overlay frames (optimistic meta write-backs of running tasks) bypass the view's node stabilization,
    // producing fresh group/task node objects every time, which re-renders the whole sidebar list and re-measures the virtualizer.
    // The display view runs the same node-level stabilization again, keeping even array identity unchanged when equivalent.
    const nextDisplayedView = stabilizeGroupedView(
      displayedViewRef.current,
      mergeGroupedTaskViewWithOptimistic({
        view,
        optimisticOverlays,
        visibleMissingTaskKeys,
      }),
    );
    displayedViewRef.current = nextDisplayedView;
    return nextDisplayedView;
  }, [optimisticTaskOverlayByWorkspaceKey, view]);

  // Differential update: the grouped structure (grouping/order) and membership (pin/archive/unread) don't change with
  // sessions-index content frames (title/status). Cache by "membershipVersion + structure version + scope signature";
  // refreshes triggered by content frames only do an in-memory join, issuing no RPC. Grouping mutation paths invalidate explicitly.
  const [remoteDataLoader] = useState(
    () =>
      new GroupedRemoteDataSingleFlight<{
        structure: ZCodeGroupedTaskViewStructure;
        membership: Awaited<ReturnType<typeof fetchTaskListMembershipSets>>;
      }>(),
  );
  const invalidateRemoteData = useCallback(() => {
    remoteDataLoader.invalidate();
  }, [remoteDataLoader]);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    // loading only means "there are no authoritative nodes on first screen yet". Every tool result a running task emits
    // triggers a background refresh; setting this unconditionally would flash both the empty-state text and the first-screen gate.
    if (viewRef.current.nodes.length === 0) {
      setLoading(true);
    }
    try {
      // tasks-index provides both persistent task rows and the grouping structure; sessions-index only enriches activity/detail.
      // The grouped sidebar must follow the currently open workspace scope,
      // so includeAllWorkspaces is not passed, keeping other workspaces' groupings out.
      const remoteDataKey = [
        membershipVersion,
        taskListVersionSignature,
        scopes
          .map((scope) => buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity))
          .join("|"),
      ].join("::");
      const remoteData = await remoteDataLoader.load(remoteDataKey, async () => {
        const [structureResult, membershipResult] = await Promise.all([
          services.zcodeTaskService.listGroupedTaskViewStructure({
            workspaceScopes: scopes,
          }),
          fetchTaskListMembershipSets({
            service: services.zcodeTaskService,
            scopes: sessionsIndexScopes,
          }),
        ]);
        return {
          structure: structureResult,
          membership: membershipResult,
        };
      });
      if (
        requestIdRef.current === requestId &&
        remoteDataLoader.isCurrent(remoteDataKey, remoteData)
      ) {
        const { structure, membership } = remoteData;
        const nextView = buildGroupedTaskViewFromSessions({
          structure,
          taskIndexItems: membership.taskIndexItems,
          sessions: sessionsIndexItemsRef.current,
          pinnedIds: membership.pinnedIds,
          archivedIds: membership.archivedIds,
          deletedIds: membership.deletedIds,
        });
        // When content is unchanged, reuse the old view/old node references; setState bails on the same reference, avoiding an invalid re-render of the whole list.
        // Read the current view via viewRef instead of doing side effects in the updater: StrictMode calls the updater twice.
        const stabilizedView = stabilizeGroupedView(viewRef.current, nextView);
        writeCachedGroupedView(localWorkspaceScopeSignature, stabilizedView);
        setView(stabilizedView);
      }
    } catch (error) {
      // The same remote Promise may be shared by several refreshes; only the latest request records the failure once, keeping the error path
      // from turning into another log storm. Old requests still reach finally, but must not close the latest generation's loading.
      if (requestIdRef.current === requestId) {
        logger.error("[useGroupedTaskView] failed to load grouped task view", error);
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
        // The first request ends the initialization gate whether it succeeds or fails; failures are logged and fall into the empty state,
        // avoiding a permanent loading. Later refreshes keep the existing list and never return to the first-load state.
        setRemoteDataInitialized(true);
      }
    }
  }, [
    localWorkspaceScopeSignature,
    membershipVersion,
    remoteDataLoader,
    scopes,
    sessionsIndexScopes,
    services.zcodeTaskService,
    taskListVersionSignature,
  ]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const authoritativeTaskKeys = collectGroupedViewTaskKeys(view);
    const promotedGroupTasks: ZCodeTaskMeta[] = [];
    const settledRootTasks: ZCodeTaskMeta[] = [];
    for (const overlay of optimisticTaskOverlayByWorkspaceKey.values()) {
      for (const [taskId, promotedDraft] of Object.entries(
        overlay.promotedGroupedDraftTaskByTaskId ?? {},
      )) {
        const key = buildTaskEntityKey({
          taskId,
          workspacePath: promotedDraft.workspacePath,
          workspaceIdentity: promotedDraft.workspaceIdentity,
        });
        const task = findTaskInGroupedView(displayedView, key);
        if (promotedDraft?.placement.type === "top") {
          const firstNode = view.nodes[0];
          if (task && firstNode?.type === "task" && buildTaskEntityKey(firstNode.task) === key) {
            settledRootTasks.push(task);
          }
        } else if (
          task &&
          (authoritativeTaskKeys.has(key) || visibleMissingTaskKeysRef.current.has(key)) &&
          !isTaskFirstInGroup(view, key, promotedDraft.placement.groupId)
        ) {
          promotedGroupTasks.push(task);
        }
      }
    }
    for (const task of settledRootTasks) {
      clearPromotedGroupedDraftTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    }
    if (promotedGroupTasks.length === 0) {
      return;
    }
    const signature = promotedGroupTasks.map(buildTaskEntityKey).sort().join("|");
    if (promotedGroupPersistenceRef.current.has(signature)) {
      return;
    }
    promotedGroupPersistenceRef.current.add(signature);
    // A "New task" inside a group used to inherit the draft position only in the optimistic view; SQLite still topped root
    // new tasks, so the task would drop out of the group after refresh. Once the task is in the optimistic index, persist the same display
    // view as a complete ordering transaction, letting membership and the first-in-group order converge together.
    void services.zcodeTaskService
      .applyGroupedTaskViewOrder(viewToOrderInput({ view: displayedView }))
      .then(() => {
        invalidateRemoteData();
        return refreshRef.current().then(() => {
          for (const task of promotedGroupTasks) {
            clearPromotedGroupedDraftTask(task.workspacePath, task.taskId, task.workspaceIdentity);
          }
        });
      })
      .catch((error) => {
        promotedGroupPersistenceRef.current.delete(signature);
        logger.error("[useGroupedTaskView] failed to save promoted grouped draft position", error);
      });
  }, [
    clearPromotedGroupedDraftTask,
    displayedView,
    invalidateRemoteData,
    optimisticTaskOverlayByWorkspaceKey,
    services.zcodeTaskService,
    view,
  ]);

  useEffect(() => {
    const disposables = scopes.map((scope) =>
      services.zcodeTaskService.onDynamicWorkspaceEvent(scope)((event) => {
        if (event.type !== "workspace_task_list_changed" || event.reason !== "task_created") {
          return;
        }
        // The sessions-index visible frame may arrive before the SQLite grouped sort_order write.
        // task_created is the boundary where the first ordering has already committed; the old structure cache must be discarded and refetched —
        // otherwise running items get appended to the end as out-of-order nodes, only recovering after a restart rebuilds the cache.
        invalidateRemoteData();
        void refreshRef.current();
      }),
    );
    return () => disposables.forEach((disposable) => disposable.dispose());
  }, [invalidateRemoteData, scopes, services.zcodeTaskService]);

  // The single automatic refresh entry. The refresh identity already includes the membership/structure/scope versions,
  // and sessions-index content changes only trigger an in-memory join; this avoids the mount effect and the index effect issuing duplicate requests on the first frame.
  useEffect(() => {
    void refresh();
  }, [refresh, sessionsIndexItems]);

  const createGroup = useCallback(async (): Promise<ZCodeTaskGroup> => {
    setSaving(true);
    try {
      const group = await services.zcodeTaskService.createTaskGroup();
      // The new group's SQLite ordering is already topped, but waiting for the async refresh to display would briefly reuse the old tree and
      // land at the end of out-of-order nodes; optimistically insert at the top with the same sort_order semantics first, then let refresh converge with SQLite.
      setView((current) => prependTaskGroupToView(current, group));
      // The grouping structure changed; invalidate the remote data cache before rebuilding (the membershipVersion bump may trail the local refresh).
      invalidateRemoteData();
      await refresh();
      return group;
    } catch (error) {
      logger.error("[useGroupedTaskView] failed to create task group", error);
      throw error;
    } finally {
      setSaving(false);
    }
  }, [invalidateRemoteData, refresh, services.zcodeTaskService]);

  const renameGroup = useCallback(
    async (groupId: string, title: string) => {
      const previousView = view;
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      const nextTitle = title.trim() || (groupNode?.type === "group" ? groupNode.group.title : "");
      if (!groupNode || groupNode.type !== "group" || groupNode.group.title === nextTitle) {
        return;
      }

      const optimisticView: ZCodeGroupedTaskView = {
        nodes: view.nodes.map((node) =>
          node.type === "group" && node.group.id === groupId
            ? {
                ...node,
                group: {
                  ...node.group,
                  title: nextTitle,
                  updatedAt: Date.now(),
                },
              }
            : node,
        ),
      };
      setView(optimisticView);
      setSaving(true);
      try {
        const renamedGroup = await services.zcodeTaskService.renameTaskGroup({
          groupId,
          title: nextTitle,
          workspaceScopes: collectViewWorkspaceScopes(optimisticView),
        });
        invalidateRemoteData();
        setView({
          nodes: optimisticView.nodes.map((node) =>
            node.type === "group" && node.group.id === groupId
              ? { ...node, group: renamedGroup }
              : node,
          ),
        });
      } catch (error) {
        setView(previousView);
        logger.error("[useGroupedTaskView] failed to rename task group", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, scopes, services.zcodeTaskService, view],
  );

  const updateGroupColor = useCallback(
    async (groupId: string, color: ZCodeTaskGroupColor) => {
      const previousView = view;
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      if (!groupNode || groupNode.type !== "group" || groupNode.group.color === color) {
        return;
      }

      const optimisticView: ZCodeGroupedTaskView = {
        nodes: view.nodes.map((node) =>
          node.type === "group" && node.group.id === groupId
            ? {
                ...node,
                group: {
                  ...node.group,
                  color,
                  updatedAt: Date.now(),
                },
              }
            : node,
        ),
      };
      setView(optimisticView);
      setSaving(true);
      try {
        const updatedGroup = await services.zcodeTaskService.updateTaskGroupColor({
          groupId,
          color,
          workspaceScopes: collectViewWorkspaceScopes(optimisticView),
        });
        invalidateRemoteData();
        setView({
          nodes: optimisticView.nodes.map((node) =>
            node.type === "group" && node.group.id === groupId
              ? { ...node, group: updatedGroup }
              : node,
          ),
        });
      } catch (error) {
        setView(previousView);
        logger.error("[useGroupedTaskView] failed to update task group color", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, scopes, services.zcodeTaskService, view],
  );

  const applyOrder = useCallback(
    async (nextView: ZCodeGroupedTaskView) => {
      const previousView = view;
      setView(nextView);
      setSaving(true);
      try {
        // The view returned in the apply response is still joined from the tasks table (the old data source) and is no longer trusted;
        // after persistence succeeds, rebuild and converge from "structure + sessions-index" (refresh).
        await services.zcodeTaskService.applyGroupedTaskViewOrder(
          viewToOrderInput({
            view: nextView,
          }),
        );
        invalidateRemoteData();
        await refreshRef.current();
      } catch (error) {
        // When writing the grouped view fails, roll back the local optimistic view, then trigger another refresh to converge to the sqlite source of truth.
        setView(previousView);
        void refresh();
        logger.error("[useGroupedTaskView] failed to save grouped task order", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, refresh, services.zcodeTaskService, view],
  );

  const ungroupGroup = useCallback(
    async (groupId: string) => {
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      if (!groupNode || groupNode.type !== "group") {
        return;
      }
      const nextView: ZCodeGroupedTaskView = {
        nodes: view.nodes.flatMap((node) =>
          node.type === "group" && node.group.id === groupId
            ? node.tasks.map((task) => ({ type: "task" as const, task }))
            : [node],
        ),
      };

      setSaving(true);
      try {
        await applyOrder(nextView);
        await services.zcodeTaskService.deleteTaskGroup({
          groupId,
          workspaceScopes: collectViewWorkspaceScopes(nextView),
        });
        invalidateRemoteData();
        await refresh();
      } catch (error) {
        logger.error("[useGroupedTaskView] failed to ungroup task group", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [applyOrder, invalidateRemoteData, refresh, scopes, services.zcodeTaskService, view],
  );

  return {
    view: displayedView,
    setView,
    loading,
    initialized,
    saving,
    refresh,
    createGroup,
    renameGroup,
    updateGroupColor,
    ungroupGroup,
    applyOrder,
  };
}
