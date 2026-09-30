export interface CuaAgentSpawnAdmissionContext {
  workspaceKey: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  signal?: AbortSignal;
}

interface AdmissionWaiter {
  reject: (reason?: unknown) => void;
  resolve: () => void;
}

/**
 * @deprecated The default CUA assembly no longer injects this admission barrier; the compatible export is kept only for legacy callers.
 * The current Helper recovery only affects subsequent Agent admissions; it does not block or reclaim existing Agents.
 *
 * Kept for API compatibility only: the default lifecycle no longer uses this mechanism to isolate the concurrency between Helper recovery and
 * command/env resolve. No workspace/session state is held here.
 */
export class CuaAgentAdmissionGate {
  private nextEpoch = 0;
  private activeEpoch: number | undefined;
  private readonly waiters = new Set<AdmissionWaiter>();

  beginRecovery(): number {
    if (this.activeEpoch !== undefined) {
      return this.activeEpoch;
    }
    this.activeEpoch = ++this.nextEpoch;
    return this.activeEpoch;
  }

  isRecovering(): boolean {
    return this.activeEpoch !== undefined;
  }

  waitForSpawnAdmission(context: CuaAgentSpawnAdmissionContext): Promise<void> {
    const signal = context.signal;
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("ZCode agent process start was cancelled."));
    }
    if (this.activeEpoch === undefined) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let waiter!: AdmissionWaiter;
      const onAbort = (): void => {
        this.waiters.delete(waiter);
        reject(signal?.reason ?? new Error("ZCode agent process start was cancelled."));
      };
      waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  commitRecovery(epoch: number): boolean {
    if (this.activeEpoch !== epoch) {
      return false;
    }
    this.activeEpoch = undefined;
    this.releaseWaiters();
    return true;
  }

  failRecovery(epoch: number, error: unknown): boolean {
    if (this.activeEpoch !== epoch) {
      return false;
    }
    this.activeEpoch = undefined;
    const reason = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.waiters) {
      waiter.reject(reason);
    }
    this.waiters.clear();
    return true;
  }

  private releaseWaiters(): void {
    for (const waiter of this.waiters) {
      waiter.resolve();
    }
    this.waiters.clear();
  }
}
