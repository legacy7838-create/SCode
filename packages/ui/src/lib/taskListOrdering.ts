import type { ZCodeTaskMeta } from "@zcode/shared";
import { isTaskListRowActive } from "@/v4/taskListRowActivity.js";

type TaskListTimeSortBy = "created" | "updated";

interface TaskListSortableItem {
  taskId: string;
  createdAt: number;
  updatedAt: number;
}

function compareTaskListItemsByTime(
  left: TaskListSortableItem,
  right: TaskListSortableItem,
  sortBy: TaskListTimeSortBy,
): number {
  if (sortBy === "created") {
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return right.taskId.localeCompare(left.taskId);
  }

  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return right.taskId.localeCompare(left.taskId);
}

/**
 * Two-level task sorting: running tasks are placed at the top and stably sorted by creation time, and non-running tasks are subject to the user's time preference.
 *
 * The original task and fork child running concurrently will alternately refresh updatedAt. If the running layer still reads
 * updatedAt (including secondary sorting), every streaming/tool event causes the two rows to swap positions.
 * Members of the run layer include both tasks running in rounds and tasks with background work (such as dynamic workflow run):
 * The latter round has been closed but the activity time is still advanced by background events. If you do not enter the running layer, the same type of transposition will happen again.
 */
function compareTaskListItemsWithRunningFirst<T extends TaskListSortableItem>(
  left: T,
  right: T,
  sortBy: TaskListTimeSortBy,
  isRunning: (task: T) => boolean,
): number {
  const leftRunning = isRunning(left);
  const rightRunning = isRunning(right);
  if (leftRunning !== rightRunning) {
    return leftRunning ? -1 : 1;
  }
  if (leftRunning) {
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    // The running layer prohibits updatedAt tie-break; taskId is a stable tie-break that does not change with events.
    return right.taskId.localeCompare(left.taskId);
  }
  return compareTaskListItemsByTime(left, right, sortBy);
}

export function compareZCodeTaskListItems(
  left: ZCodeTaskMeta,
  right: ZCodeTaskMeta,
  sortBy: TaskListTimeSortBy,
): number {
  return compareTaskListItemsWithRunningFirst(left, right, sortBy, isTaskListRowActive);
}
