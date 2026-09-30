// AgentRuntime-backed WorkflowDriver: Session release and silent state when dispose.
// `dispose()` does not wait for a turn that is still executing; these promises are recorded when the session is released, allowing amend to determine which sessions have stopped writing.
//
// Engine settlement does not mean that the aborted turn has completed the last message persistence. amend needs to wait for the session to be silent first,
// Then read the number of messages as `inFlight.messageBoundary`. The boundaries of completed ask are already recorded in the journal and are not affected by this.
// Sessions waiting for a timeout do not import the unfinished part, subsequent re-executions from the complete prefix, and the timeout cannot be considered silent.
//
// Here we only wait for the main line of turn, and there is no guarantee that all streaming tool parts have been dropped: some tool handles may have been compared with turn's
// promise breaks away. Transcription replication reads the part that is visible at the time; historical recovery will treat pending/running tools as interruptions,
// Missing parts will not generate a fruitless tool_use, and empty assistant messages will be skipped.
// The part is updated according to the same ID without increasing the number of messages, so the late part will not change the message boundary.

import type { WorkflowClock } from "./workflow-driver-concurrency.js";
import { defaultSchedule } from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * The upper bound for waiting out an aborted turn to finish writing its tail.
 *
 * The reasoning behind the value: it waits for an **already aborted** turn to walk through the handful of
 * already-awaited core-side persistence steps (abandon → cancellation snapshot → assistant message), a millisecond-scale wrap-up rather than a
 * model request. Five seconds leaves plenty of room for a slow disk and one retry, without making
 * the "amend an in-flight run" interaction noticeably slower — and overshooting only costs one resumption, not a failure.
 */
export const AMEND_TRANSCRIPT_QUIESCE_MS = 5_000;

/** The probing surface that reports whether a run's actor sessions are quiet. A private driver capability, deliberately **not** on Boundary B's `WorkflowDriver`. */
export interface ActorSessionQuiescence {
  /**
   * The ids of sessions that are quiet right now (no more turns being written); the wait is bounded, see {@link AMEND_TRANSCRIPT_QUIESCE_MS}.
   *
   * "Not in the set" has two causes, treated alike by the caller (neither resumes): still writing at the deadline, or
   * unknown to this driver — which happens only when the predecessor never created a session for that actor, so
   * reading it as not quiet costs one lost resumption rather than a transcript truncated by an unaccountable count.
   */
  quietSessions(): Promise<ReadonlySet<string>>;
}

/** The driver-side write surface: {@link ActorSessionQuiescence} plus a registration entry point at dispose time. */
export interface ActorSessionQuiescenceLedger extends ActorSessionQuiescence {
  /**
   * Register a session together with the wrap-up chain of the turn **currently** in flight for it
   * (`SessionState.turn`). A missing `pendingTurn` means the session has no in-flight turn and counts as quiet immediately.
   *
   * `dispose()` calls it once for each session under its name: that is the only moment that still
   * sees every session and where no new turn can be started (after dispose, `sessions` is already emptied).
   */
  noteDisposed(sessionId: string, pendingTurn: Promise<unknown> | undefined): void;
}

/**
 * Create a session quiescence ledger. Purely in memory, no I/O; the clock is injected by the caller.
 *
 * Ownership: exactly one ledger per driver instance, born and buried with the driver. Deliberately **not** a process-level registry — the driver's ownership relations already
 * say which run a session belongs to, and a second table would only raise the question "which side do we trust when they disagree".
 */
export function createActorSessionQuiescence(options?: {
  clock?: WorkflowClock;
  /** The default {@link AMEND_TRANSCRIPT_QUIESCE_MS}. */
  quiesceMs?: number;
}): ActorSessionQuiescenceLedger {
  /** sessionId → the turn still in flight at the moment of dispose (`undefined` = no turn was in flight then). */
  const disposed = new Map<string, Promise<unknown> | undefined>();
  const schedule = options?.clock?.schedule ?? defaultSchedule;
  const quiesceMs = options?.quiesceMs ?? AMEND_TRANSCRIPT_QUIESCE_MS;

  return {
    noteDisposed(sessionId, pendingTurn) {
      disposed.set(sessionId, pendingTurn);
    },

    async quietSessions() {
      const quiet = new Set<string>();
      const waits: Promise<unknown>[] = [];
      for (const [sessionId, pending] of disposed) {
        if (pending === undefined) {
          quiet.add(sessionId);
          continue;
        }
        // The success or failure of the turn closing chain has nothing to do with silence: regardless of resolve or reject, it will not write to the session again.
        waits.push(
          pending.then(
            () => quiet.add(sessionId),
            () => quiet.add(sessionId),
          ),
        );
      }
      if (waits.length > 0) await settleWithin(Promise.all(waits), quiesceMs, schedule);
      // Take a snapshot and hand it over: Sessions that are launched after the point will still be written to `quiet`, and what the caller reads must be
      // The "moment of asking" fact - a collection that grows on its own behind the scenes is much more dangerous than a conservative collection.
      return new Set(quiet);
    },
  };
}

/**
 * The per-session release on dispose: unsubscribe the activity observer, cancel the backoff
 * re-drive, **register quiescence**, then close the actor runtime after the in-flight turn has settled.
 *
 * Each runtime runs the **same** chain the app uses to close a session —
 * `closeBrowserSession` internally does beginShutdown, node_repl session release, browser session close in order; a separate
 * subagent-close chain would drift. A failed close only warns, settlement never throws because of it.
 *
 * Registration must happen **before** `state.turn.then(...)`: at that moment `state.turn` is the very chain to wait for, and the then replaces
 * it with another promise. The whole function returns synchronously (the close hangs off the then), so dispose is, as always, non-blocking.
 */
export function releaseActorSessions(
  deps: AgentRuntimeWorkflowDriverDeps,
  sessions: Iterable<SessionState>,
  ledger: ActorSessionQuiescenceLedger,
): void {
  for (const state of sessions) {
    state.modelActivity.unsubscribe();
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    ledger.noteDisposed(state.sessionId, state.turn);
    const close = (): void => closeActorRuntime(deps, state);
    if (state.turn === undefined) close();
    else state.turn.then(close, close);
  }
}

function closeActorRuntime(deps: AgentRuntimeWorkflowDriverDeps, state: SessionState): void {
  // Promise.resolve().then(...): Put synchronization throws into the same warn path (the minimum stub runtime does not have this method).
  void Promise.resolve()
    .then(() => state.runtime.closeBrowserSession())
    .catch((error: unknown) => {
      deps.logger?.warn?.("Dynamic workflow actor runtime close failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.actor_runtime.close_failed",
        module: "bootstrap.app",
        sessionId: state.sessionId,
      });
    });
}

/** Wait for `work` to settle, at most `delayMs`. Returns as soon as the deadline passes (never throws); the timer is cleared on either branch. */
async function settleWithin(
  work: Promise<unknown>,
  delayMs: number,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<void> {
  let cancel: (() => void) | undefined;
  const deadline = new Promise<void>((resolve) => {
    cancel = schedule(resolve, delayMs);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    // The alarm clock must be removed when work is landed first: a setTimeout that has not yet sounded will drag the CLI exit to the upper limit.
    cancel?.();
  }
}
