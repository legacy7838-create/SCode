/* oxlint-disable eslint(max-lines) -- This file currently carries the task-level state slice, so
 * the draft logic is fixed with a minimal change first and the file is split later in one unified
 * pass
 */
import {
  normalizeAgentProviderToZCodeAgent,
  type ZCodeApiRetryStatus,
  type ZCodeConfigOption,
  type ZCodePermissionRequest,
  type ZCodeElicitationRequest,
  type ZCodeProvider,
  type ZCodeTaskRuntimeStatus,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { removeTaskFromHistory } from "@/lib/taskNavigationHistory.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import type {
  ConfigOptionsStatus,
  ElicitationFormDraft,
  ZCodeSessionStoreState,
  TaskUsageState,
} from "@/store/zcodeSessionStoreTypes.js";
import { getDefaultWorkspaceState } from "@/store/zcodeSessionStoreTypes.js";
import { clearPersistedComposerDraft } from "@/lib/chatComposerDraftStorage.js";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import {
  getTaskRuntimeState,
  getTaskUiState,
  getWorkspaceState,
  resolveWorkspaceStateKey,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;

function sortTasksByUpdatedAt(tasks: readonly ZCodeTaskMeta[]): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

function arePermissionOptionsEqual(
  left: ZCodePermissionRequest["options"],
  right: ZCodePermissionRequest["options"],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((option, index) => {
    const otherOption = right[index];
    if (!otherOption) {
      return false;
    }

    return (
      option.optionId === otherOption.optionId &&
      option.kind === otherOption.kind &&
      option.name === otherOption.name
    );
  });
}

function arePermissionRequestsEquivalent(
  left: ZCodePermissionRequest,
  right: ZCodePermissionRequest,
): boolean {
  if (left === right) {
    return true;
  }

  // The same requestId may be continuously delivered into different objects. raw is only used for display preview, and the requestId on the protocol is the permission request identity;
  // Here we remove duplication based on visible fields to avoid repeated requests to re-render the permission pop-up window and ChatView as a whole.
  return (
    left.requestId === right.requestId &&
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.inputId === right.inputId &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.description === right.description &&
    arePermissionOptionsEqual(left.options, right.options)
  );
}

function areTaskUsageCostsEqual(
  left: TaskUsageState["cost"] | undefined,
  right: TaskUsageState["cost"] | undefined,
): boolean {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft === normalizedRight;
  }
  return (
    normalizedLeft.amount === normalizedRight.amount &&
    normalizedLeft.currency === normalizedRight.currency
  );
}

function areTaskUsageCachesEqual(
  left: TaskUsageState["cache"] | undefined,
  right: TaskUsageState["cache"] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.inputTokens === right.inputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.latestHitRate === right.latestHitRate &&
    left.hitRate === right.hitRate &&
    left.hitRateRequestCount === right.hitRateRequestCount &&
    left.totalInputTokens === right.totalInputTokens &&
    left.totalCacheReadTokens === right.totalCacheReadTokens &&
    left.totalCacheWriteTokens === right.totalCacheWriteTokens
  );
}

function areTaskUsageBreakdownsEqual(
  left: TaskUsageState["breakdown"] | undefined,
  right: TaskUsageState["breakdown"] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every(
    (item, index) => item.source === right[index]?.source && item.chars === right[index]?.chars,
  );
}

function areTaskUsageStatesEqual(
  left: TaskUsageState | null,
  right: TaskUsageState | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.size === right.size &&
    left.used === right.used &&
    areTaskUsageCostsEqual(left.cost, right.cost) &&
    areTaskUsageCachesEqual(left.cache, right.cache) &&
    areTaskUsageBreakdownsEqual(left.breakdown, right.breakdown)
  );
}

function normalizeTaskContextWindow(contextWindow: number | null): number | null {
  if (contextWindow === null) {
    return null;
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return Math.floor(contextWindow);
}

function updateWorkspaceStateForIdentityScopedTaskState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  updater: (
    current: ReturnType<typeof getDefaultWorkspaceState>,
  ) => ReturnType<typeof getDefaultWorkspaceState>,
): Pick<ZCodeSessionStoreState, "workspaces"> {
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  if (workspaceKey === workspacePath) {
    return updateWorkspaceState(state, workspacePath, updater);
  }
  const current = state.workspaces[workspaceKey] ?? getDefaultWorkspaceState();
  return {
    workspaces: {
      ...state.workspaces,
      [workspaceKey]: updater(current),
    },
  };
}

export function createTaskSlice(set: SetFn) {
  return {
    setTaskRuntimeState: (
      workspacePath: string,
      taskId: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
      provider?: ZCodeProvider,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const currentTaskRuntime = getTaskRuntimeState(current, taskId);
            const isRunningStatus =
              status === "creating" || status === "restoring" || status === "streaming";
            const nextTaskRuntime = {
              ...currentTaskRuntime,
              status,
              error: error ?? null,
              provider: provider ?? currentTaskRuntime.provider,
              // activeInputId is the command routing ID of the current generation round.
              // If the old inputId is retained in the final/non-running state, the mobile terminal will misjudge the completed task as still loading when it only relies on snapshots.
              // activeTurnKind is also in the session running state; it must be cleared after compact is completed.
              // Otherwise, the app layer will continue to misjudge the sending of the same task as "compressing" and swallow it.
              activeTurnKind: isRunningStatus ? currentTaskRuntime.activeTurnKind : undefined,
              activeInputId: isRunningStatus ? currentTaskRuntime.activeInputId : undefined,
              activeInputOwnerClientId: isRunningStatus
                ? currentTaskRuntime.activeInputOwnerClientId
                : undefined,
            };
            return {
              ...current,
              taskRuntimeByTaskId: {
                ...current.taskRuntimeByTaskId,
                [taskId]: nextTaskRuntime,
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskUsage: (
      workspacePath: string,
      taskId: string,
      usage: TaskUsageState | null,
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentRuntime = getTaskRuntimeState(current, taskId);
        if (areTaskUsageStatesEqual(currentRuntime.usage, usage)) {
          // usage_update may arrive repeatedly with the same value during streaming.
          // If you continue to create new workspace/taskRuntime objects, React will be woken up meaninglessly and cause frame drops.
          return state;
        }
        return updateWorkspaceStateForIdentityScopedTaskState(
          state,
          workspacePath,
          workspaceIdentity,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                usage,
              },
            },
          }),
        );
      });
    },

    setTaskContextWindow: (
      workspacePath: string,
      taskId: string,
      contextWindow: number | null,
      workspaceIdentity?: string,
    ) => {
      const normalizedContextWindow = normalizeTaskContextWindow(contextWindow);
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentRuntime = getTaskRuntimeState(current, taskId);
        if (currentRuntime.contextWindow === normalizedContextWindow) {
          return state;
        }
        return updateWorkspaceStateForIdentityScopedTaskState(
          state,
          workspacePath,
          workspaceIdentity,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                // contextWindow comes from the model state and usage.used comes from the runtime token statistics.
                // The arrival order of the two streams is different. Window refresh cannot reconstruct the usage object, otherwise the positive number used will be overwritten to 0.
                contextWindow: normalizedContextWindow,
              },
            },
          }),
        );
      });
    },

    setTaskApiRetryStatus: (
      workspacePath: string,
      taskId: string,
      apiRetry: ZCodeApiRetryStatus | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                apiRetry,
              },
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskConfigOptions: (
      workspacePath: string,
      taskId: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
      status: ConfigOptionsStatus = "ready",
    ) => {
      const normalizedOptions = [...options];
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentOptions = current.taskConfigOptionsByTaskId[taskId] ?? [];
        const currentStatus = current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready";
        if (
          currentStatus === status &&
          areConfigOptionsEquivalent(currentOptions, normalizedOptions)
        ) {
          // When a historical task restores an old model or automatically clears a model without an API key, multiple recovery paths may be submitted repeatedly.
          // Same content but different reference to configOptions. Here we skip equivalent writing directly to avoid Zustand notification triggering React effect loop.
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            return {
              ...current,
              taskConfigOptionsByTaskId: {
                ...current.taskConfigOptionsByTaskId,
                [taskId]: normalizedOptions,
              },
              taskConfigOptionsStatusByTaskId: {
                ...current.taskConfigOptionsStatusByTaskId,
                [taskId]: status,
              },
            };
          },
          workspaceIdentity,
        );
      });
    },

    setTaskPermissionRequest: (
      workspacePath: string,
      taskId: string,
      request: ZCodePermissionRequest | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (request === null) {
              if (
                taskUiState.permissionRequest === null &&
                taskUiState.pendingPermissionRequests.length === 0
              ) {
                return current;
              }

              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    permissionRequest: null,
                    pendingPermissionRequests: [],
                  },
                },
              };
            }

            const currentPermissionRequest = taskUiState.permissionRequest;
            const pendingPermissionRequests = taskUiState.pendingPermissionRequests ?? [];

            let nextPermissionRequest = currentPermissionRequest;
            let nextPendingPermissionRequests = pendingPermissionRequests;

            if (currentPermissionRequest?.requestId === request.requestId) {
              if (arePermissionRequestsEquivalent(currentPermissionRequest, request)) {
                return current;
              }
              nextPermissionRequest = request;
            } else if (currentPermissionRequest === null) {
              nextPermissionRequest = request;
              nextPendingPermissionRequests = pendingPermissionRequests.filter(
                (item) => item.requestId !== request.requestId,
              );
            } else {
              const existingPendingIndex = pendingPermissionRequests.findIndex(
                (item) => item.requestId === request.requestId,
              );
              if (existingPendingIndex >= 0) {
                const existingPendingRequest = pendingPermissionRequests[existingPendingIndex];
                if (!existingPendingRequest) {
                  return current;
                }
                if (arePermissionRequestsEquivalent(existingPendingRequest, request)) {
                  return current;
                }
                nextPendingPermissionRequests = pendingPermissionRequests.map((item, index) =>
                  index === existingPendingIndex ? request : item,
                );
              } else {
                // Multiple permission requests may appear continuously in the same task. When there is only one permissionRequest field,
                // The later request will directly overwrite the previous one, causing the previous pending permission to never be responded to, and the task will appear to be "stuck" on the surface.
                // Here, subsequent requests are queued by task to ensure that after the user confirms the current request, the next one can be automatically added to continue processing.
                nextPendingPermissionRequests = [...pendingPermissionRequests, request];
              }
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  permissionRequest: nextPermissionRequest,
                  pendingPermissionRequests: nextPendingPermissionRequests,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskPermissionRequest: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            const currentPermissionRequest = taskUiState.permissionRequest;
            const pendingPermissionRequests = taskUiState.pendingPermissionRequests ?? [];

            if (currentPermissionRequest?.requestId === requestId) {
              const [nextPermissionRequest, ...restPendingPermissionRequests] =
                pendingPermissionRequests;
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    permissionRequest: nextPermissionRequest ?? null,
                    pendingPermissionRequests: restPendingPermissionRequests,
                  },
                },
              };
            }

            const pendingPermissionIndex = pendingPermissionRequests.findIndex(
              (item) => item.requestId === requestId,
            );
            if (pendingPermissionIndex < 0) {
              // The permission response will go through local optimistic cleaning, and the permission_response of stream playback will be received again.
              // If you continue to rebuild taskUiState during the second cleanup, it will trigger meaningless re-rendering of ChatView and the permission preview tree, causing the CPU to spike after confirmation.
              return current;
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  pendingPermissionRequests: pendingPermissionRequests.filter(
                    (_item, index) => index !== pendingPermissionIndex,
                  ),
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskElicitationRequest: (
      workspacePath: string,
      taskId: string,
      request: ZCodeElicitationRequest | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (request === null) {
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    elicitationRequest: null,
                    pendingElicitationRequests: [],
                  },
                },
              };
            }

            const currentElicitationRequest = taskUiState.elicitationRequest;
            const pendingElicitationRequests = taskUiState.pendingElicitationRequests ?? [];

            let nextElicitationRequest = currentElicitationRequest;
            let nextPendingElicitationRequests = pendingElicitationRequests;

            if (currentElicitationRequest?.requestId === request.requestId) {
              nextElicitationRequest = request;
            } else if (currentElicitationRequest === null) {
              nextElicitationRequest = request;
              nextPendingElicitationRequests = pendingElicitationRequests.filter(
                (item) => item.requestId !== request.requestId,
              );
            } else {
              const existingPendingIndex = pendingElicitationRequests.findIndex(
                (item) => item.requestId === request.requestId,
              );
              if (existingPendingIndex >= 0) {
                nextPendingElicitationRequests = pendingElicitationRequests.map((item, index) =>
                  index === existingPendingIndex ? request : item,
                );
              } else {
                nextPendingElicitationRequests = [...pendingElicitationRequests, request];
              }
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  elicitationRequest: nextElicitationRequest,
                  pendingElicitationRequests: nextPendingElicitationRequests,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskElicitationRequest: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            const currentElicitationRequest = taskUiState.elicitationRequest;
            const pendingElicitationRequests = taskUiState.pendingElicitationRequests ?? [];

            if (currentElicitationRequest?.requestId === requestId) {
              const [nextElicitationRequest, ...restPendingElicitationRequests] =
                pendingElicitationRequests;
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    elicitationRequest: nextElicitationRequest ?? null,
                    pendingElicitationRequests: restPendingElicitationRequests,
                  },
                },
              };
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  pendingElicitationRequests: pendingElicitationRequests.filter(
                    (item) => item.requestId !== requestId,
                  ),
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskElicitationFormDraft: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      draft: ElicitationFormDraft,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  // The question and answer progress originally only had pop-up window useState. After switching tasks, the component was uninstalled.
                  // Remounting can only be initialized from the original request. Promote to renderer store by task/request,
                  // It can not only restore the local draft, but also won’t write the sub-topic status to the runtime/replayable snapshot by mistake.
                  elicitationFormDraftsByRequestId: {
                    ...taskUiState.elicitationFormDraftsByRequestId,
                    [requestId]: draft,
                  },
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskElicitationFormDraft: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (!(requestId in taskUiState.elicitationFormDraftsByRequestId)) {
              return current;
            }
            const nextDrafts = { ...taskUiState.elicitationFormDraftsByRequestId };
            delete nextDrafts[requestId];
            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  elicitationFormDraftsByRequestId: nextDrafts,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskError: (
      workspacePath: string,
      taskId: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskUiByTaskId: {
              ...current.taskUiByTaskId,
              [taskId]: {
                ...getTaskUiState(current, taskId),
                // The complete error object was previously only placed in the local state of ChatView/useZCodeChat.
                // Once the page or task is switched, the traceId/code will be lost together after the component is uninstalled, leaving only the plain text of taskRuntime.error.
                // Here it is changed to write to the store by task, so that error prompts can be restored across pages like plan/permission.
                error,
              },
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    initializeBackgroundTaskRuntime: (
      workspacePath: string,
      params: {
        task: ZCodeTaskMeta;
        provider: ZCodeProvider;
        activeInputId: string;
        workspaceIdentity?: string;
      },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const existingTask = current.optimisticTaskListByTaskId[params.task.taskId];
            const nextTask = existingTask
              ? mergeTaskWithOptimisticMeta(params.task, existingTask)
              : params.task;
            const currentTaskRuntime = getTaskRuntimeState(current, params.task.taskId);
            const cachedTasks = current.taskListCache ?? [];
            const nextTaskListCache =
              current.taskListCache === null
                ? current.taskListCache
                : sortTasksByUpdatedAt([
                    nextTask,
                    ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== params.task.taskId),
                  ]);

            return {
              ...current,
              selectedProvider: normalizeAgentProviderToZCodeAgent(params.provider),
              // Performance optimization: Background launch does not need to go through multiple rounds of optimistic -> cache -> runtime sets first.
              // Combining write-once can eliminate the renderer subscription storm when creating tasks for concurrent stress testing.
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                [params.task.taskId]: nextTask,
              },
              taskListCache: nextTaskListCache,
              taskRuntimeByTaskId: {
                ...current.taskRuntimeByTaskId,
                [params.task.taskId]: {
                  ...currentTaskRuntime,
                  status: "streaming",
                  error: null,
                  provider: params.provider,
                  activeInputId: params.activeInputId,
                },
              },
            };
          },
          params.workspaceIdentity ?? params.task.workspaceIdentity,
        ),
      );
    },

    upsertOptimisticTaskListItem: (
      workspacePath: string,
      task: ZCodeTaskMeta,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const existingTask = current.optimisticTaskListByTaskId[task.taskId];
            const nextTask = existingTask ? mergeTaskWithOptimisticMeta(task, existingTask) : task;

            return {
              ...current,
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                // The desktop-continuous readSession snapshot may be older than the initial optimistic Date.now().
                // Here, press updatedAt to merge monotonically to prevent the old snapshot from pushing the new task back to the bottom of the list.
                [task.taskId]: nextTask,
              },
            };
          },
          workspaceIdentity ?? task.workspaceIdentity,
        ),
      );
    },

    removeOptimisticTaskListItem: (
      workspacePath: string,
      taskId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [taskId]: _removedTaskMeta, ...restOptimisticTaskListByTaskId } =
              current.optimisticTaskListByTaskId;
            return {
              ...current,
              optimisticTaskListByTaskId: restOptimisticTaskListByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      // Task deletion will clear the memory task state, but the composer draft also has a localStorage bucket on the desktop.
      // If you do not synchronize the cleanup in the unified deletion action, the drafts of the deleted tasks will continue to remain after restarting.
      clearPersistedComposerDraft(workspacePath, taskId, workspaceIdentity);
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [taskId]: _removedTaskRuntime, ...restTaskRuntimeByTaskId } =
              current.taskRuntimeByTaskId;
            const { [taskId]: _removedTaskUi, ...restTaskUiByTaskId } = current.taskUiByTaskId;
            const { [taskId]: _removedTaskConfigOptions, ...restTaskConfigOptionsByTaskId } =
              current.taskConfigOptionsByTaskId;
            const {
              [taskId]: _removedTaskConfigOptionsStatus,
              ...restTaskConfigOptionsStatusByTaskId
            } = current.taskConfigOptionsStatusByTaskId;
            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const { [taskId]: _removedTaskMeta, ...restOptimisticTaskListByTaskId } =
              current.optimisticTaskListByTaskId;
            const {
              [taskId]: _removedPromotedGroupedDraftTask,
              ...restPromotedGroupedDraftTaskByTaskId
            } = current.promotedGroupedDraftTaskByTaskId;
            const shouldCloseDeletedTask = current.activeTaskId === taskId;

            // When deleting the task currently being viewed on the left, only the task list data was updated before.
            // The activeTaskId in the workspace still points to the deleted task, and the main area on the right will continue to render details based on the old taskId.
            // Here, after the deletion is successful, the selected state and running state will be recycled uniformly, so that the main area can immediately exit the deleted task.
            return {
              ...current,
              activeTaskId: shouldCloseDeletedTask ? null : current.activeTaskId,
              draftRuntime: shouldCloseDeletedTask
                ? { status: "idle", error: null }
                : current.draftRuntime,
              taskRuntimeByTaskId: restTaskRuntimeByTaskId,
              taskUiByTaskId: restTaskUiByTaskId,
              taskConfigOptionsByTaskId: restTaskConfigOptionsByTaskId,
              taskConfigOptionsStatusByTaskId: restTaskConfigOptionsStatusByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: restOptimisticTaskListByTaskId,
              promotedGroupedDraftTaskByTaskId: restPromotedGroupedDraftTaskByTaskId,
            };
          },
          workspaceIdentity,
        );

        return {
          ...workspaceUpdate,
          taskNavHistory: removeTaskFromHistory(state.taskNavHistory, taskId),
        };
      });
    },
  };
}
