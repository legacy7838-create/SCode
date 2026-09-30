// ============================================================
// Adaptive concurrency on the driver side: per-actor admission + model state observation + failure attribution
// ============================================================
// From workflow-driver.ts
// Breaking it down: That file just deals with "session and turn orchestration", and the three things here don't touch turn orchestration - they just wrap the manager port into
// An actor's `ModelRequestAdmission`, read-only actor runtime session event stream, run-level success/retry beats only
// (stall clock). Model failure attribution (formerly modelFailureReasonOf)
// Moved to adapters' policy table (`inspectWorkflowModelFailure`): runner and driver read the same copy.

import {
  SessionEventType,
  type ModelNetworkStatusEvent,
  type ModelRequestAdmission,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type {
  AskLastTool,
  AskProgress,
  AskWaitInfo,
  InstanceRef,
  RunStallInfo,
} from "@zcode/dynamic-workflow";
import { createActorToolActivity, type ActorToolCounts } from "./workflow-driver-tool-activity.js";
import {
  workflowConcurrencyKey,
  type WorkflowConcurrencyPort,
} from "./workflow-concurrency-governor.js";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

/** The same discipline as on the governor: these two kinds of retry are not provider failures and do not deserve a badge. */
const NON_FAILURE_RETRY_REASONS: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

interface ActorModelActivityHandlers {
  /** What the next model request for this ask is waiting on: a slot (`cause: "slot"`) or a backoff (`cause: "backoff"`). */
  onWaiting(info: AskWaitInfo): void;
  /** This ask's model request really went out (the first request, or the one after a stretch of waiting). */
  onExecuting(): void;
  /** Any model request (turn or tool side) of this actor completed successfully — the reset signal for the run-level stall clock. */
  onRequestCompleted?(): void;
  /** The runner scheduled a retry (excluding signature repair / auth refresh) — the arming signal for the run-level stall clock. */
  onRetryScheduled?(reason: string): void;
  /**
   * A live ask's subagent is about to execute a tool that rewrites the workspace (at most once per ask; the instance is resolved
   * as `live` by this module, and nothing is reported when it is not live). The engine uses this to close the amend-resume import cache.
   */
  onMutating?(instance: InstanceRef): void;
}

/**
 * An actor's **observation surface**: the `ModelRequestAdmission` of its runtime (admission), the model state in its session
 * event stream (the source of the executing / waiting badges), and the tool calls in that same stream (the first workspace
 * write → close the import cache, plus the tool count for this ask; see workflow-driver-tool-activity.ts). All three share the
 * same per-ask lifetime, so the driver holds a single object and observes / resets / unsubscribes exactly once; that is also
 * why the `model_request_started` after waiting for a slot can be recognized as a resumption.
 */
export interface ActorModelActivity {
  /** The admission port handed to runtime deps; undefined when the governor port is absent (not gated). */
  readonly admission: ModelRequestAdmission | undefined;
  /** Reset when switching asks: the previous ask's waiting / executing phases and tool count must not carry over to the next ask. */
  reset(): void;
  /** The number of tool calls observed for this ask so far (fed to AskStats). */
  toolCounts(): ActorToolCounts;
  /** The most recent tool call to start for this ask so far (fed to the lastTool of `node-progress`). */
  lastTool(): AskLastTool | undefined;
  /**
   * Records "another turn resolved" and reports this ask's progress at this moment (`turn` starts at 1). The count lives here
   * rather than on SessionState because it shares the same per-ask lifetime as the tool count: the same reset zeroes it, it
   * accumulates within one ask, and a new round started by a nudge counts as a second turn.
   */
  noteTurnResolved(): AskProgress;
  /** Subscribes to the runtime's session events (model state + tool calls); a no-op when the minimal stub runtime has no subscribeEvents. */
  observe(runtime: AgentRuntime, sessionId: SessionId): void;
  unsubscribe(): void;
}

/**
 * The phase of a request chain. A chain = "one logical request and all of its retries", keyed by (querySource, queryId, toolCallId):
 * a turn step has a queryId but no toolCallId, two parallel WebSearches each have their own toolCallId, and the compaction / title
 * sidecars each have a querySource — a retry changes requestId but not the key, so a chain in backoff and its next attempt are the same chain.
 */
type ChainPhase = "queued" | "executing" | "backoff";

interface Chain {
  phase: ChainPhase;
  /** The most recent waiting info (queued / backoff); after a chain ends, if only waiters remain, the newest one is reported as waiting. */
  wait?: AskWaitInfo;
  waitSeq: number;
}

/**
 * Aggregation rule (replaces the single phase): the driver maintains, per actor, the set of in-flight request chains —
 *   - `model_request_queued` (`tryAcquire` missed) → chain queued;
 *   - `model_request_admitted` / `model_request_started` → chain executing;
 *   - `model_retry_scheduled` (excluding `reasoning_signature_repair` / `auth_refresh`) → chain backoff;
 *   - `model_request_completed` / non-retryable `model_request_failed` → chain ends (it leaves the set).
 * Subagent phase: any chain executing → executing; otherwise a chain waiting → waiting (with the most recent waiting info);
 * an empty set → keep the previous phase and emit no event (during tool execution within one ask, when the tool itself
 * does not queue, the subagent still shows executing). One subagent can hold several tickets at once (parallel tool calls), so a single phase can no longer be used.
 *
 * This is an observation subscription **inside** the driver, not a live channel for the transcript: the v4 gateway only
 * drains contiguous seq, so a transcript live stream must go through the child runtime's construction-time eventSink (a run
 * service test pins this); here we only read the model's network state, so missing seq 1 does not matter.
 */
export function createActorModelActivity(input: {
  port: WorkflowConcurrencyPort | undefined;
  runId: string;
  /** The instance of the currently live ask (undefined after settlement / cancellation); only tool-activity reporting needs it. */
  live?: () => InstanceRef | undefined;
  handlers: ActorModelActivityHandlers;
  /**
   * This run's seat gate and the key of this subagent inside the gate. When present the admission port is wrapped with one more layer: first wait for a seat, then pass the governor.
   * Absent means this run's bound never changes mid-flight (snippet execution, an assembly without a gate), and the admission port is exactly as it was before.
   */
  seat?: { gate: WorkflowRunSeatGate; key: string };
}): ActorModelActivity {
  const chains = new Map<string, Chain>();
  let executing = false;
  /** The most recently reported waiting info; cleared as soon as executing is reported. Within the same wait, an identical wait is reported only once. */
  let reportedWait: AskWaitInfo | undefined;
  /** The number of turns resolved within this ask (`turn` of `node-progress`); reset when switching asks. */
  let turnsResolved = 0;
  let waitSeq = 0;
  let unsubscribeEvents: (() => void) | undefined;
  const { handlers, live, port, runId, seat } = input;
  // Second reader of the same session event stream: tool calls. The implementation is separated into a file (the judgment and counting are all there), here only put it
  // Coded into the same life cycle, so that there is still only one observation object on the driver side.
  const toolActivity = createActorToolActivity({
    onMutating: () => {
      const instance = live?.();
      if (instance !== undefined) handlers.onMutating?.(instance);
    },
  });

  const anyExecuting = (): boolean => {
    for (const chain of chains.values()) if (chain.phase === "executing") return true;
    return false;
  };
  /**
   * Still waiting after aggregation: report waiting once (exactly one per stretch of waiting). A subagent issuing 4 parallel WebSearches
   * queues all four chains in the same millisecond, and the four queued events each report `waiting(slot)` — in measurement, 26 of 80
   * waiting records were such same-millisecond same-text duplicates. The subagent's phase has not changed, so no event should be emitted
   * again: swallow it when it is field-for-field identical to the last reported waiting info; only after switching to executing and waiting again is it reported anew.
   */
  const reportWaiting = (info: AskWaitInfo): void => {
    if (anyExecuting()) return;
    executing = false;
    if (reportedWait !== undefined && sameWait(reportedWait, info)) return;
    reportedWait = info;
    handlers.onWaiting(info);
  };
  const reportExecuting = (): void => {
    reportedWait = undefined;
    if (executing) return;
    executing = true;
    handlers.onExecuting();
  };
  const setWaiting = (key: string, phase: "queued" | "backoff", wait: AskWaitInfo): void => {
    waitSeq += 1;
    chains.set(key, { phase, wait, waitSeq });
    reportWaiting(wait);
  };
  /** A chain ends: if no chain is executing yet some chain is still waiting, the subagent truly enters waiting now — report with the newest waiting info. */
  const endChain = (key: string): void => {
    if (!chains.delete(key) || anyExecuting()) return;
    let latest: Chain | undefined;
    for (const chain of chains.values()) {
      if (chain.wait !== undefined && (latest === undefined || chain.waitSeq > latest.waitSeq))
        latest = chain;
    }
    if (latest?.wait !== undefined) reportWaiting(latest.wait);
  };

  // The admission port is a narrow wrapper of the manager port: fast path = tryAdmit, queuing = admit(waiting(slot)
  // Reported by the queued event of the runner, it will not be sent by itself here). acquire still tries the fast path first, which is compatible with callers that don't use tryAcquire.
  const governed: ModelRequestAdmission | undefined =
    port === undefined
      ? undefined
      : {
          tryAcquire: ({ model }) => port.tryAdmit(runId, workflowConcurrencyKey(model)),
          acquire: async ({ model, signal }) => {
            const key = workflowConcurrencyKey(model);
            return (
              port.tryAdmit(runId, key) ??
              (await port.admit(runId, key, signal ?? new AbortController().signal))
            );
          },
        };
  // The upper bound of this run is one layer above the shared cap. The piece of information Zhamen wants represents the fact——
  // Is there any object running at this moment? It is taken from the object observation surface in the same object, so the two readers share the same account.
  const admission =
    seat === undefined
      ? governed
      : seat.gate.wrap(seat.key, { toolsInFlight: () => toolActivity.inFlight() }, governed);

  return {
    admission,
    reset: () => {
      chains.clear();
      executing = false;
      reportedWait = undefined;
      turnsResolved = 0;
      toolActivity.reset();
    },
    toolCounts: () => toolActivity.counts(),
    lastTool: () => toolActivity.lastTool(),
    noteTurnResolved: () => {
      turnsResolved++;
      const lastTool = toolActivity.lastTool();
      return {
        turn: turnsResolved,
        toolCalls: toolActivity.counts().toolCalls,
        ...(lastTool === undefined ? {} : { lastTool }),
      };
    },
    observe: (runtime, sessionId) => {
      toolActivity.observe(runtime, sessionId);
      if (typeof (runtime as Partial<AgentRuntime>).subscribeEvents !== "function") return;
      unsubscribeEvents = runtime.subscribeEvents({
        onSessionEvent: (event: SessionEvent) => {
          if (event.type !== SessionEventType.ModelNetworkStatus || event.sessionId !== sessionId)
            return;
          const status = event.payload as ModelNetworkStatusEvent;
          const key = chainKey(status);
          switch (status.type) {
            case "model_request_queued":
              setWaiting(key, "queued", { cause: "slot" });
              return;
            case "model_request_admitted":
            case "model_request_started":
              chains.set(key, { phase: "executing", waitSeq: chains.get(key)?.waitSeq ?? 0 });
              reportExecuting();
              return;
            case "model_retry_scheduled": {
              if (NON_FAILURE_RETRY_REASONS.has(status.reason)) return;
              handlers.onRetryScheduled?.(status.reason);
              setWaiting(key, "backoff", {
                cause: "backoff",
                reason: status.reason,
                attempt: status.nextAttempt,
                delayMs: status.delayMs,
                ...(status.retryAfterMs === undefined ? {} : { retryAfterMs: status.retryAfterMs }),
              });
              return;
            }
            case "model_request_completed":
              handlers.onRequestCompleted?.();
              endChain(key);
              return;
            case "model_request_failed":
              // The failed retryable:true is followed by a retry_scheduled - that one changes the phase.
              if (!status.retryable) endChain(key);
              return;
            default:
              return;
          }
        },
      });
    },
    unsubscribe: () => {
      toolActivity.unsubscribe();
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
    },
  };
}

function sameWait(a: AskWaitInfo, b: AskWaitInfo): boolean {
  return (
    a.cause === b.cause &&
    a.reason === b.reason &&
    a.attempt === b.attempt &&
    a.delayMs === b.delayMs &&
    a.retryAfterMs === b.retryAfterMs
  );
}

function chainKey(status: ModelNetworkStatusEvent): string {
  const parts = [status.querySource, status.queryId, status.toolCallId].map((part) =>
    part === undefined ? "" : String(part),
  );
  return parts.some((part) => part.length > 0) ? parts.join("|") : status.requestId;
}

// —————————————————————————— Run level stall clock ————————————————————————————

/** How long without a single successful model request before the main agent is notified once. */
const WORKFLOW_STALL_NOTIFY_AFTER_MS = 20 * 60_000;

/** Clock and timers (injectable, fake time for tests). */
export interface WorkflowClock {
  now?: () => number;
  /** Returns a cancel function. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

interface RunStallClockOptions extends WorkflowClock {
  /** Default {@link WORKFLOW_STALL_NOTIFY_AFTER_MS}. */
  afterMs?: number;
  onStalled: (info: RunStallInfo) => void;
}

/**
 * Stall observation for one run: all actors (turn and tool-side requests alike) share one clock.
 *   - `noteSuccess`: any `model_request_completed` → reset, cancel the alarm, clear the reason count; this stretch ends;
 *   - `noteRetryScheduled`: one `model_retry_scheduled` → count the reason; if this stretch is not armed yet, set the alarm for
 *     "last success + afterMs";
 *   - The alarm fires: at least afterMs since the last success and at least one retry scheduled in this stretch → `onStalled`
 *     exactly once (one per stall stretch), re-armed only after the next success;
 *   - `noteCap`: a cap change fanned out by the governor — the notification reports the current cap as well (the most recent
 *     fanned-out value; absent if never seen). Pure observation, it makes no decisions; `dispose` after a run settles cancels the alarm.
 */
export interface RunStallClock {
  noteSuccess(): void;
  noteRetryScheduled(reason: string): void;
  noteCap(cap: number): void;
  dispose(): void;
}

export function createRunStallClock(options: RunStallClockOptions): RunStallClock {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const afterMs = options.afterMs ?? WORKFLOW_STALL_NOTIFY_AFTER_MS;
  let lastSuccessAt = now();
  let notified = false;
  let cancelTimer: (() => void) | undefined;
  let cap: number | undefined;
  const reasons = new Map<string, number>();
  let disposed = false;

  const dominantReason = (): string | undefined => {
    let best: string | undefined;
    let bestCount = 0;
    for (const [reason, count] of reasons) {
      if (count > bestCount) {
        best = reason;
        bestCount = count;
      }
    }
    return best;
  };
  const fire = (): void => {
    cancelTimer = undefined;
    if (disposed || notified) return;
    const sinceMs = now() - lastSuccessAt;
    if (sinceMs < afterMs) {
      // Clock drift/injected clock is not monotonic: wait one more time for the remaining amount instead of missing this segment.
      cancelTimer = schedule(fire, afterMs - sinceMs);
      return;
    }
    if (reasons.size === 0) return;
    notified = true;
    const reason = dominantReason();
    options.onStalled({
      sinceMs,
      ...(reason === undefined ? {} : { reason }),
      ...(cap === undefined ? {} : { cap }),
    });
  };

  return {
    noteSuccess: () => {
      if (disposed) return;
      lastSuccessAt = now();
      notified = false;
      reasons.clear();
      cancelTimer?.();
      cancelTimer = undefined;
    },
    noteRetryScheduled: (reason) => {
      if (disposed || notified) return;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      if (cancelTimer !== undefined) return;
      cancelTimer = schedule(fire, Math.max(0, afterMs - (now() - lastSuccessAt)));
    },
    noteCap: (next) => {
      cap = next;
    },
    dispose: () => {
      disposed = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // Don't let a stalled timer peg the process: it shouldn't have voting rights when the run ends and the process wants to exit.
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};
