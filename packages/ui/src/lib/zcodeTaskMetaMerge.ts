import type { ZCodeTaskMeta } from "@zcode/shared";

function hasOwnTaskMetaField<T extends keyof ZCodeTaskMeta>(task: ZCodeTaskMeta, key: T) {
  return Object.prototype.hasOwnProperty.call(task, key);
}

function isPlaceholderTaskTitle(title: string): boolean {
  const normalizedTitle = title.trim().toLocaleLowerCase();
  return normalizedTitle.length === 0 || normalizedTitle === "new session";
}

function resolveMergedTaskTitle(preferredTask: ZCodeTaskMeta, fallbackTask: ZCodeTaskMeta): string {
  if (fallbackTask.titleOverridden && !preferredTask.titleOverridden) {
    return fallbackTask.title;
  }
  // session/send is an immediate ACK, and the readSession after the first ACK may be earlier than the background first_input title projection.
  // At this time, the snapshot will bring back the agent default placeholder "New session"; if its updatedAt is updated, the old merge logic will
  // User query optimistic title briefly blocked. Here only the empty title/default placeholder is regarded as not being able to overwrite the real title, and the generated title will still be covered as usual.
  if (isPlaceholderTaskTitle(preferredTask.title) && !isPlaceholderTaskTitle(fallbackTask.title)) {
    return fallbackTask.title;
  }
  return preferredTask.title;
}

export function mergeTaskWithOptimisticMeta(
  task: ZCodeTaskMeta,
  optimisticTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const shouldKeepOptimisticTask =
    optimisticTask.updatedAt > task.updatedAt ||
    (optimisticTask.updatedAt === task.updatedAt &&
      optimisticTask.title.length > task.title.length);
  const preferredTask = shouldKeepOptimisticTask ? optimisticTask : task;
  const fallbackTask = shouldKeepOptimisticTask ? task : optimisticTask;

  const unreadAt = hasOwnTaskMetaField(optimisticTask, "unreadAt")
    ? optimisticTask.unreadAt
    : (preferredTask.unreadAt ?? fallbackTask.unreadAt);

  return {
    ...preferredTask,
    changeSummary: preferredTask.changeSummary ?? fallbackTask.changeSummary,
    model: preferredTask.model ?? fallbackTask.model,
    provider: preferredTask.provider ?? fallbackTask.provider,
    title: resolveMergedTaskTitle(preferredTask, fallbackTask),
    titleOverridden:
      preferredTask.titleOverridden === true || fallbackTask.titleOverridden === true
        ? true
        : (preferredTask.titleOverridden ?? fallbackTask.titleOverridden),
    // The remote control homepage "Running" relies on task.meta.status as a backup when the runtime is not subscribed.
    // After the previous optimistic metadata updatedAt is updated, if it does not have status, the persistent status will be overwritten to undefined.
    // The final list incorrectly shows idle. Add status fallback here to prevent running/completed/error from being swallowed by the optimistic layer.
    status: preferredTask.status ?? fallbackTask.status,
    unreadAt,
  };
}

export function mergeTaskMetaCandidates(
  ...candidates: Array<ZCodeTaskMeta | null | undefined>
): ZCodeTaskMeta | undefined {
  let merged: ZCodeTaskMeta | undefined;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    merged = merged ? mergeTaskWithOptimisticMeta(candidate, merged) : candidate;
  }
  return merged;
}
