import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Registers runtime-owned work that outlives the current synchronous call stack.
 *
 * The session residency pool used to observe only the active turns and the task registry; detached Promises such as the
 * title, MCP startup and ledger writes are in neither, so they could be closed as idle while still reading and writing
 * the runtime. The count must be incremented in the same synchronous slice in which the Promise starts, and released only in finally.
 */
export function trackResidencyBlockingWork<T>(
  this: AgentRuntimeInternal,
  work: Promise<T>,
): Promise<T> {
  this.residencyBlockingWorkCount += 1;
  return work.finally(() => {
    this.residencyBlockingWorkCount = Math.max(0, this.residencyBlockingWorkCount - 1);
  });
}

/** The session residency pool consumes only this item, so adding a sidecar no longer means editing bootstrap's guess list. */
export function hasResidencyBlockingWork(this: AgentRuntimeInternal): boolean {
  return (
    this.hasActiveOrQueuedTurnWork() ||
    this.hasRunningBackgroundTasks() ||
    this.residencyBlockingWorkCount > 0
  );
}
