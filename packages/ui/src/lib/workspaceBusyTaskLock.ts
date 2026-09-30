import type { ZCodeProvider, ZCodeTaskRuntimeStatus } from "@zcode/shared";

function isBusyTaskRuntimeStatus(status: ZCodeTaskRuntimeStatus): boolean {
  return status === "creating" || status === "restoring" || status === "streaming";
}

function buildTaskProviderByTaskId(
  optimisticTaskMetaByTaskId: Record<string, { provider?: ZCodeProvider }>,
  taskListCache?: Array<{ taskId: string; provider?: ZCodeProvider }> | null,
): Record<string, ZCodeProvider | undefined> {
  const providerByTaskId: Record<string, ZCodeProvider | undefined> = {};

  for (const task of taskListCache ?? []) {
    if (!task.provider) {
      continue;
    }
    providerByTaskId[task.taskId] = task.provider;
  }

  for (const [taskId, meta] of Object.entries(optimisticTaskMetaByTaskId)) {
    if (!meta.provider) {
      continue;
    }
    providerByTaskId[taskId] = meta.provider;
  }

  return providerByTaskId;
}

export function hasBusyTaskInWorkspaceProvider(
  selectedProvider: ZCodeProvider,
  taskRuntimeByTaskId: Record<string, { status: ZCodeTaskRuntimeStatus; provider?: ZCodeProvider }>,
  optimisticTaskMetaByTaskId: Record<string, { provider?: ZCodeProvider }>,
  taskListCache?: Array<{ taskId: string; provider?: ZCodeProvider }> | null,
  activeTaskId?: string | null,
): boolean {
  const providerByTaskId = buildTaskProviderByTaskId(optimisticTaskMetaByTaskId, taskListCache);
  const normalizedActiveTaskId = activeTaskId?.trim() ?? "";

  for (const [taskId, runtimeState] of Object.entries(taskRuntimeByTaskId)) {
    if (!isBusyTaskRuntimeStatus(runtimeState.status)) {
      continue;
    }

    // The runtime map also contains non-optimistic tasks. If the provider is missing, it cannot be directly assigned to the fixed provider.
    // Otherwise, irrelevant tasks may be misjudged as busy, and the reload/sync menu may be disabled for a long time.
    // Busy lock protects the provider process in the workspace, giving priority to the runtime that is closer to the current running state.
    // provider, and then fall back to taskList/cache; if it is still unable to determine, only the current activeTask is fully locked.
    const taskProvider = runtimeState.provider ?? providerByTaskId[taskId];
    if (!taskProvider) {
      // During the first message sending/runtime switching phase, the task provider may not have been synchronized into the taskList yet.
      // Directly determining "not busy" will allow models to be switched across suppliers during loading.
      // Lock the busy state of the current activeTask to prevent accidental switching of suppliers during loading.
      if (normalizedActiveTaskId.length > 0 && normalizedActiveTaskId === taskId) {
        return true;
      }
      continue;
    }

    if (taskProvider === selectedProvider) {
      return true;
    }
  }

  return false;
}
