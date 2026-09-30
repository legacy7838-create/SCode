// ============================================================
// Dynamic Workflow Run: The life cycle bookkeeping of the run owned by this session (settlement/closure/closing the gate/external final state line leaving traces)
// ============================================================
// Reason for splitting: dynamic-workflow-run-service.ts reaches the upper limit of oxlint max-lines (400 lines), and the run is moved from settlement to
// The closed life cycle is divided into this document - settlement bookkeeping (final state entry, failure normalization, permanent registration, settlement notification, final state
// Entry elimination) Closures with service-side shutdown and foreign final state line checks.
// They only borrow the registry and journal of service and pass it in through narrow dependencies; invariants 6 and 7 of the service file header are still their specifications.

import type { Logger } from "@zcode/contracts";
import type { JournalStorePort, RunSettlement } from "@zcode/dynamic-workflow";
import {
  TERMINAL_RUN_STATUSES,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";

/** How many terminal runs are retained in the in-memory registry (artifacts live only in the settlement; the journal does not store script return values). */
const TERMINAL_REGISTRY_LIMIT = 32;

/** Notification emitted after a run settles; `liveRunCount` is the number of runs still in flight under this service at the moment of the notification. */
export interface DynamicWorkflowRunSettledNotice {
  runId: string;
  liveRunCount: number;
}

interface RunServiceLifecycleDeps {
  /** Read-only `getRun`: deciding whether a row is foreign requires the status carried on the row. */
  journal: Pick<JournalStorePort, "getRun">;
  logger?: Logger;
  parentSessionId: string;
  /** See the service's `DynamicWorkflowRunServiceDeps.registerResidencyBlockingWork` (invariant 6). */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /** The service's registry proper (not a snapshot): at settlement it evicts old terminal entries, at close it enumerates in-flight entries, and when recording a trace it sets the flag. */
  runs: Map<string, RunRegistryEntry>;
}

interface RunServiceLifecycle {
  /** Number of runs that have still not settled at this moment (entries in the registry with `terminal === undefined`). */
  countLiveRuns(): number;
  /** Subscribes to settlement notifications (emitted after the bookkeeping; a listener that throws is only logged). Returns the unsubscribe function. */
  subscribeRunSettled(listener: (notice: DynamicWorkflowRunSettledNotice) => void): () => void;
  /** Settlement bookkeeping (shared by submit / amend / resume): terminal entries are recorded, failures normalized, residency registered. Never rejects. */
  trackSettlement(
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ): Promise<RunSettlement>;
  /** See the close description of {@link createRunServiceLifecycle}. Idempotent. */
  close(): Promise<void>;
  /** A launch after close is a wiring error: throw, instead of adding a member to the contracts' rejection enum. */
  assertOpen(): void;
  /** A terminal row under a live entry ⇒ a foreign write; one warn is recorded per entry. */
  noteForeignTerminalRow(runId: string): void;
}

/**
 * Close (invariant 7 in the service file header).
 *
 * The engine is a closure of this App (the actor runtime, the event chain, the cancellation controller and the
 * settlement promise all live here), so once the App is closed the engine has no host while journal rows are still stuck
 * at running -- the next activation could only guess via orphan convergence. So closing must **stop
 * proactively**: abort every in-flight entry with `"interrupted"`, the harness normalizes it into
 * `engine.stop("interrupted", Interrupted)`, and the engine itself writes the row as a resumable stopped.
 *
 * Wait with no timeout: after receiving the stop the harness settles synchronously, and waiting for the predecessor's own settlement promise is exactly the discipline amend already uses (never substitute a timer for state). The settlement promise never rejects (see {@link RunServiceLifecycle.trackSettlement}).
 */
export function createRunServiceLifecycle(deps: RunServiceLifecycleDeps): RunServiceLifecycle {
  const { runs } = deps;
  const terminalOrder: string[] = [];
  const settledListeners = new Set<(notice: DynamicWorkflowRunSettledNotice) => void>();
  const countLiveRuns = (): number => {
    let live = 0;
    for (const entry of runs.values()) if (entry.terminal === undefined) live += 1;
    return live;
  };
  // Settlement notifications are issued after bookkeeping: the count read by the listener (the host's registry security boundary) must have been deducted from this run.
  const notifySettled = (runId: string): void => {
    if (settledListeners.size === 0) return;
    const notice: DynamicWorkflowRunSettledNotice = { runId, liveRunCount: countLiveRuns() };
    for (const listener of settledListeners) {
      try {
        listener(notice);
      } catch (error: unknown) {
        deps.logger?.warn?.("Dynamic workflow run settled listener threw", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.settled_listener_failed",
          module: "bootstrap.app",
          runId,
        });
      }
    }
  };
  const subscribeRunSettled = (
    listener: (notice: DynamicWorkflowRunSettledNotice) => void,
  ): (() => void) => {
    settledListeners.add(listener);
    return () => {
      settledListeners.delete(listener);
    };
  };

  const rememberTerminal = (runId: string): void => {
    terminalOrder.push(runId);
    while (terminalOrder.length > TERMINAL_REGISTRY_LIMIT) {
      const evicted = terminalOrder.shift();
      if (evicted !== undefined && runs.get(evicted)?.terminal !== undefined) runs.delete(evicted);
    }
  };

  /**
   * Settlement bookkeeping (shared by submit and resume): record the terminal state in the entry, normalize failures.
   * Failures outside the harness (e.g. the engine constructor throwing) are normalized into an errored terminal state: never encoded as stopped -- in the journal the two have different semantics and a different resume UX (stopped is resumable, errored can only be amended).
   */
  const trackSettlement = (
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ): Promise<RunSettlement> => {
    const settlement = launched.then(
      (result) => {
        entry.terminal = result;
        entry.completedAt = new Date();
        rememberTerminal(runId);
        notifySettled(runId);
        return result;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger?.warn?.("Dynamic workflow run failed before settling", {
          errorMessage: message,
          event: "dynamic_workflow.run.start_failed",
          module: "bootstrap.app",
          runId,
        });
        entry.completedAt = new Date();
        const result: RunSettlement = {
          status: "errored",
          error: error instanceof Error ? (error as never) : (new Error(message) as never),
        };
        entry.terminal = result;
        rememberTerminal(runId);
        notifySettled(runId);
        return result;
      },
    );
    // Service file header invariant 6: Three entries (submit / amend / resume) share this registration point and must be in launch
    // Registration of the same sync slice - one microtask later, a resident rebalancing can fall between startup and registration. Registration is **after settlement**
    // promise (`settlement` never rejects, bookkeeping is done), the count is released with its finally.
    deps.registerResidencyBlockingWork?.(settlement);
    return settlement;
  };

  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // Idempotent + **sync** set: `closed` must be true in this sync slice, otherwise a launch arrives during close
    // would slip in and build an engine that no one had.
    closePromise ??= (async () => {
      closed = true;
      const live = [...deps.runs.values()].filter((entry) => entry.terminal === undefined);
      deps.logger?.info?.("Dynamic workflow run service closing", {
        event: "dynamic_workflow.service.closing",
        liveRunCount: live.length,
        module: "bootstrap.app",
        parentSessionId: deps.parentSessionId,
      });
      for (const entry of live) entry.controller.abort("interrupted");
      await Promise.all(live.map((entry) => entry.settlement));
      deps.logger?.info?.("Dynamic workflow run service closed", {
        event: "dynamic_workflow.service.closed",
        module: "bootstrap.app",
        parentSessionId: deps.parentSessionId,
        stoppedRunCount: live.length,
      });
    })();
    return closePromise;
  };

  /**
   * A launch after close is a **wiring error**, not a business rejection: the residency pool's close gate has already
   * blocked the command surface, so reaching here means someone bypassed it. So we throw, instead of adding a member to
   * the contracts' rejection enum -- that would force every caller to handle a branch that never occurs in normal operation.
   */
  const assertOpen = (): void => {
    if (closed) {
      throw new Error(
        "dynamic workflow run service is closed; a launch after App close is a wiring fault",
      );
    }
  };

  /**
   * A terminal row under a live entry ⇒ a foreign write; one warn is recorded per entry.
   *
   * A second desktop instance cold-restored the same session, and its orphan convergence wrote
   * terminal rows for runs that this process is still running. The read surface already ignores it for live entries per
   * {@link RunRegistryEntry} (synthesizeRunStatus in the observation), but the event itself must leave a trace --
   * otherwise "two instances stepping on each other" could only be guessed after the fact.
   *
   * Once per entry: the tracker polls `getTask` every second, and without a flag that is the same warn every second.
   * While the flag is unset we read `getRun` one extra time (an indexed single-row query); once set, even that is saved.
   */
  const noteForeignTerminalRow = (runId: string): void => {
    const entry = deps.runs.get(runId);
    if (entry === undefined || entry.terminal !== undefined || entry.foreignTerminalLogged) return;
    const record = deps.journal.getRun(runId);
    if (record === undefined || !TERMINAL_RUN_STATUSES.has(record.status)) return;
    entry.foreignTerminalLogged = true;
    deps.logger?.warn?.("Dynamic workflow run has a foreign terminal row under a live engine", {
      event: "dynamic_workflow.run.foreign_terminal_row",
      journalStatus: record.status,
      module: "bootstrap.app",
      runId,
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
    });
  };

  return {
    countLiveRuns,
    subscribeRunSettled,
    trackSettlement,
    close,
    assertOpen,
    noteForeignTerminalRow,
  };
}
