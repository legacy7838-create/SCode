import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskNavEntry } from "@/lib/taskNavigationHistory.js";
import type { TaskEntityKey } from "@/lib/taskQueryCache.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";

export function taskNavigationTargetExists(params: {
  entry: TaskNavEntry;
  visibleTasks: readonly Pick<ZCodeTaskMeta, "taskId">[];
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskMeta>;
}): boolean {
  if (params.visibleTasks.some((task) => task.taskId === params.entry.taskId)) {
    return true;
  }

  const cachedTask = params.taskMetaByEntityKey[buildTaskEntityKey(params.entry)];
  if (!cachedTask) {
    return false;
  }

  // After the task list is moved to the task query cache, the old taskListCache may be empty.
  // When going back/forward, you cannot just look at the old visibleTasks, otherwise the real historical target will be deleted by mistake, which will appear as if the button does not respond when clicked.
  return cachedTask.taskId === params.entry.taskId;
}
