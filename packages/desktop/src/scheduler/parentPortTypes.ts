/**
 * Structural typing for the `process.parentPort` utility-process IPC channel, declared locally so the
 * scheduler no longer needs the `electron` ambient types.
 *
 * The scheduler only ever calls `parentPort?.postMessage(...)` and `parentPort?.on("message", ...)`,
 * and it already degrades to logging when `parentPort` is absent (i.e. not launched as a
 * `utilityProcess`). This interface captures exactly that surface. The runtime object provided by
 * Electron's `utilityProcess` (or a Node `worker_threads` port) satisfies this shape.
 */

/** The subset of the parent IPC port the scheduler uses. */
export interface SchedulerParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

declare global {
  namespace NodeJS {
    interface Process {
      /** Utility-process IPC port; absent when the scheduler runs as a plain Node process. */
      parentPort?: SchedulerParentPort;
    }
  }
}
