/**
 * ZCode Session Store selectors and internal helper functions
 *
 * Split out of zcodeSessionStore.ts, it contains the workspace state read/update helpers, as well
 * as all per-task read-only accessors and standalone selectors.
 */
import type { ZCodeTaskRuntimeStatus, ZCodeTaskMeta } from "@zcode/shared";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import {
  DEFAULT_TASK_UI_STATE,
  DEFAULT_WORKSPACE_INIT_STATE,
  DEFAULT_TASK_RUNTIME_STATE,
  createDefaultWorkspaceState,
  getDefaultWorkspaceState,
  type ZCodeSessionStoreState,
  type WorkspaceInitState,
  type TaskRuntimeState,
  type WorkspaceZCodeUIState,
} from "./zcodeSessionStoreTypes.js";

// ────────────────────────────────────────────
// Internal helpers (the store itself also needs to be used)
// ────────────────────────────────────────────

export function resolveWorkspaceStateKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return workspaceIdentity?.trim() || workspacePath;
}

function copyTaskRecordEntries<T>(
  record: Record<string, T>,
  taskIds: ReadonlySet<string>,
): Record<string, T> {
  const entries = Object.entries(record).filter(([taskId]) => taskIds.has(taskId));
  return entries.length > 0 ? Object.fromEntries(entries) : {};
}

function collectIdentityTaskIds(
  baseState: WorkspaceZCodeUIState,
  workspaceIdentity: string,
): Set<string> {
  const normalizedIdentity = workspaceIdentity.trim();
  const taskIds = new Set<string>();
  for (const task of baseState.taskListCache ?? []) {
    if (task.workspaceIdentity?.trim() === normalizedIdentity) {
      taskIds.add(task.taskId);
    }
  }
  for (const task of Object.values(baseState.optimisticTaskListByTaskId)) {
    if (task.workspaceIdentity?.trim() === normalizedIdentity) {
      taskIds.add(task.taskId);
    }
  }
  return taskIds;
}

function createIdentityWorkspaceStateSeed(
  baseState: WorkspaceZCodeUIState | undefined,
  workspaceIdentity?: string,
): WorkspaceZCodeUIState {
  if (!baseState) {
    return createDefaultWorkspaceState(getDefaultWorkspaceState().selectedProvider);
  }

  const seededState = createDefaultWorkspaceState(baseState.selectedProvider);
  const migratedTaskIds = workspaceIdentity
    ? collectIdentityTaskIds(baseState, workspaceIdentity)
    : new Set<string>();
  const migratedTaskListCache =
    baseState.taskListCache?.filter((task) => migratedTaskIds.has(task.taskId)) ?? null;
  return {
    ...seededState,
    // When identity is first written, you can inherit the workspace/draft level display seed.
    // However, the task status can only be migrated once based on the persisted workspaceIdentity, and the path buckets cannot be dynamically merged.
    selectedSupplierKey: baseState.selectedSupplierKey,
    isGhostSupplier: baseState.isGhostSupplier,
    supplierMismatchReason: baseState.supplierMismatchReason,
    configOptions: baseState.configOptions,
    configOptionsStatus: baseState.configOptionsStatus,
    slashCommands: baseState.slashCommands,
    ...(migratedTaskIds.size > 0
      ? {
          activeTaskId:
            baseState.activeTaskId && migratedTaskIds.has(baseState.activeTaskId)
              ? baseState.activeTaskId
              : seededState.activeTaskId,
          optimisticTaskListByTaskId: copyTaskRecordEntries(
            baseState.optimisticTaskListByTaskId,
            migratedTaskIds,
          ),
          taskConfigOptionsByTaskId: copyTaskRecordEntries(
            baseState.taskConfigOptionsByTaskId,
            migratedTaskIds,
          ),
          taskConfigOptionsStatusByTaskId: copyTaskRecordEntries(
            baseState.taskConfigOptionsStatusByTaskId,
            migratedTaskIds,
          ),
          taskListCache: migratedTaskListCache,
          taskListVersion: baseState.taskListVersion,
          taskRuntimeByTaskId: copyTaskRecordEntries(
            baseState.taskRuntimeByTaskId,
            migratedTaskIds,
          ),
          taskUiByTaskId: copyTaskRecordEntries(baseState.taskUiByTaskId, migratedTaskIds),
          taskUnreadByTaskId: copyTaskRecordEntries(baseState.taskUnreadByTaskId, migratedTaskIds),
        }
      : {}),
  };
}

export function getWorkspaceState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity?: string,
): WorkspaceZCodeUIState {
  const baseState = state.workspaces[workspacePath] ?? getDefaultWorkspaceState();
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  if (workspaceKey === workspacePath) {
    return baseState;
  }

  const identityState = state.workspaces[workspaceKey];
  if (!identityState) {
    return baseState;
  }

  // workspaceIdentity represents the remote/isolated workspace identity, and the path bucket is only used for local fallback
  // and a one-time migration starting point before the first write to the identity bucket. Once the identity bucket exists, it cannot be dynamically merged.
  // path task maps, otherwise different SSH/WSL windows on the same path will read each other's task config, queue, and error status.
  return identityState;
}

export function updateWorkspaceState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  updater: (current: WorkspaceZCodeUIState) => WorkspaceZCodeUIState,
  workspaceIdentity?: string,
): Pick<ZCodeSessionStoreState, "workspaces"> {
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  const current =
    workspaceKey === workspacePath
      ? getWorkspaceState(state, workspacePath, workspaceIdentity)
      : (state.workspaces[workspaceKey] ??
        createIdentityWorkspaceStateSeed(state.workspaces[workspacePath], workspaceIdentity));
  const nextWorkspaceState = updater(current);

  if (nextWorkspaceState === current) {
    // After single ZCode Agent migration, the old provider selection will be normalized to glm, and many calls will not actually change the state.
    // If you still write the merged overlay snapshot back to the identity bucket, it will break the selector's reference cache and trigger meaningless re-rendering.
    return { workspaces: state.workspaces };
  }

  if (workspaceKey === workspacePath) {
    return {
      workspaces: {
        ...state.workspaces,
        [workspacePath]: nextWorkspaceState,
      },
    };
  }

  return {
    workspaces: {
      ...state.workspaces,
      // The workspace-level state of the remote workspace must only write the identity key.
      // To be compatible with calls that do not transparently transmit identity, you cannot write the path key at the same time: another remote window on the same path will fallback from the path.
      // Reading this status causes slashCommands, model switching and initialization status to be serialized. The relevant call chain has been completed with identity.
      // The path bucket is no longer polluted here.
      [workspaceKey]: nextWorkspaceState,
    },
  };
}

// ────────────────────────────────────────────
// Per-task accessor functions
// ────────────────────────────────────────────

export function getTaskRuntimeState(
  workspaceState: WorkspaceZCodeUIState,
  taskId: string,
): TaskRuntimeState {
  return workspaceState.taskRuntimeByTaskId[taskId] ?? DEFAULT_TASK_RUNTIME_STATE;
}

interface WorkspaceDisplayedTaskState {
  taskStatus: ZCodeTaskRuntimeStatus;
  taskError: string | null;
}

export function getWorkspaceDisplayedTaskState(
  workspaceState: WorkspaceZCodeUIState,
): WorkspaceDisplayedTaskState {
  if (!workspaceState.activeTaskId) {
    return {
      taskStatus: workspaceState.draftRuntime.status,
      taskError: workspaceState.draftRuntime.error,
    };
  }

  const runtimeState = getTaskRuntimeState(workspaceState, workspaceState.activeTaskId);
  return {
    taskStatus: runtimeState.status,
    taskError: runtimeState.error,
  };
}

export function getTaskUiState(workspaceState: WorkspaceZCodeUIState, taskId: string) {
  return workspaceState.taskUiByTaskId[taskId] ?? DEFAULT_TASK_UI_STATE;
}

export function getTaskMeta(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<Pick<WorkspaceZCodeUIState, "optimisticTaskListByTaskId" | "taskListCache">>,
  taskId: string,
): ZCodeTaskMeta | null {
  const optimisticTask = workspaceState.optimisticTaskListByTaskId?.[taskId];
  const cachedTask = workspaceState.taskListCache?.find((task) => task.taskId === taskId) ?? null;

  if (!optimisticTask) {
    return cachedTask;
  }

  if (!cachedTask) {
    return optimisticTask;
  }

  return mergeTaskWithOptimisticMeta(cachedTask, optimisticTask);
}

export function getVisibleTaskMetas(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<Pick<WorkspaceZCodeUIState, "optimisticTaskListByTaskId" | "taskListCache">>,
): ZCodeTaskMeta[] {
  const taskById = new Map<string, ZCodeTaskMeta>();

  for (const task of workspaceState.taskListCache ?? []) {
    taskById.set(task.taskId, task);
  }

  for (const task of Object.values(workspaceState.optimisticTaskListByTaskId ?? {})) {
    taskById.set(task.taskId, getTaskMeta(workspaceState, task.taskId) ?? task);
  }

  return Array.from(taskById.values());
}

export function getTaskUnreadIndicator(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<
        Pick<
          WorkspaceZCodeUIState,
          "optimisticTaskListByTaskId" | "taskListCache" | "taskUnreadByTaskId"
        >
      >,
  taskId: string,
  fallbackTask?: Pick<ZCodeTaskMeta, "unreadAt">,
): boolean {
  const storedTask = getTaskMeta(workspaceState, taskId);
  // After the IDE is upgraded or restarted, the task list will be restored from the query cache first, but the session store has not yet been hydrated;
  // At this time, persistent unreadAt only exists in the list task. Only fall back when the store is missing the task, to avoid the old list overwriting the optimistic read state.
  return (
    Boolean((storedTask ?? fallbackTask)?.unreadAt) ||
    workspaceState.taskUnreadByTaskId?.[taskId] === true
  );
}

// ────────────────────────────────────────────
// Standalone selector functions
// ────────────────────────────────────────────

export function selectWorkspaceZCodeState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  return getWorkspaceState(state, workspacePath, workspaceIdentity);
}

export function getWorkspaceInitState(
  workspaceState: Pick<WorkspaceZCodeUIState, "workspaceInit">,
): WorkspaceInitState {
  return workspaceState.workspaceInit ?? DEFAULT_WORKSPACE_INIT_STATE;
}
