import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskListRowActivity } from "@/v4/taskListRowActivity.js";

export function deriveTaskLeadingIndicator(
  task: ZCodeTaskMeta,
  activity: TaskListRowActivity | null,
): "error" | "unread" | "loading" | "none" {
  if (activity?.phase === "error") {
    return "error";
  }

  // There may be no activity sidecar when search results or sessions-index are not yet hydrated.
  // In this case only persistent errors are rolled back; once there is a sessions-index, the phase is real-time authoritative.
  if (!activity && task.status === "error") {
    return "error";
  }

  // unread is the tasks-index membership field, and the blue dot must directly read the current
  // query-cache row; no longer rolls back the old Zustand map to prevent two unread authorities from fighting with each other.
  if (typeof task.unreadAt === "number") {
    return "unread";
  }

  if (activity?.phase === "prewarming" || activity?.phase === "running") {
    return "loading";
  }

  // persisted status=running only means that the final status has not been received when the last disk was placed, but it does not mean that the new app is still running in real time.
  // Loading must be clearly proven by the current runtime, otherwise the history list will always display the last unfinished task as a circle.
  return "none";
}

export function formatTaskRelativeTime(
  timestamp: number,
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  },
): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return intl.formatMessage({ id: "taskList.justNow" });
  if (minutes < 60) {
    return intl.formatMessage({ id: "taskList.minutesAgo" }, { minutes: String(minutes) });
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return intl.formatMessage({ id: "taskList.hoursAgo" }, { hours: String(hours) });
  }

  const days = Math.floor(hours / 24);
  return intl.formatMessage({ id: "taskList.daysAgo" }, { days: String(days) });
}
