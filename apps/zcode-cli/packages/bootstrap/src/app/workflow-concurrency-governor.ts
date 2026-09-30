// ============================================================
// Workflow concurrency manager (process level, bucketed by provider key, **per model request** admission)
// ============================================================
// All runs plus the main agent in a CLI process
// Share a provider quota, so the manager is **process level**: one bucket for each `${providerId}/${modelId}`,
// There is a pure AIMD state machine in the bucket (`ConcurrencyController`, @zcode/dynamic-workflow) + one that rotates according to run
// Admission queue.
//
// The gate granularity is **each attempt of the model request**: runner `acquire` before each attempt, `release` after the attempt,
// Slots are not held during backoff sleep. The ticket is the status event sink of the attempt: the runner puts the
// The `ModelNetworkStatus` event is also delivered to the ticket, and the manager reads the results from the ticket. This plan
// **Do not** use adapter-level `addStatusSink` - the same event cannot be fed through both the ticket and the adapter sink.
//
// This is the **only** place in the manager where clocks and timers are touched: the controller only accepts `now`; when the cooldown expires, the waiter must be awakened.
// So a setTimeout (injectable, unref) is needed.

import type {
  ModelNetworkStatusEvent,
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";
import {
  ConcurrencyController,
  type ConcurrencyChange,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "@zcode/dynamic-workflow";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";

/** provider key: the most specific quota key. */
export function workflowConcurrencyKey(model: ModelRequestTarget): string {
  return `${String(model.providerId)}/${String(model.modelId)}`;
}

/**
 * The narrow port the driver sees (not the whole governor).
 *
 * - `tryAdmit`: the synchronous fast path — it hands out a ticket only when the gate is open
 *   **and nobody is queued**; otherwise it returns undefined and the caller falls through to
 *   `admit` and reports "waiting for a slot". Skipping the fast path while someone waits is
 *   a fairness matter: otherwise a request-heavy run could overtake other runs' queues via
 *   the fast path.
 * - `admit`: queues (round-robin across runs) until `inFlight < cap` and no Retry-After
 *   cooldown is active; once `signal` is aborted it dequeues and rejects (with
 *   `signal.reason` as the rejection reason).
 * - `subscribe`: cap changes on any key this run touches. Fan-out reaches only the runs that
 *   **right now have an in-flight or queued request on that key**.
 */
export interface WorkflowConcurrencyPort {
  tryAdmit(runId: string, key: string): ModelRequestAdmissionTicket | undefined;
  admit(runId: string, key: string, signal: AbortSignal): Promise<ModelRequestAdmissionTicket>;
  subscribe(runId: string, listener: (change: ConcurrencyChange) => void): () => void;
}

interface WorkflowConcurrencyGovernor extends WorkflowConcurrencyPort {
  /**
   * Admission for the main agent: acquire lets it through immediately — no queueing, no
   * cooldown check — but it still **counts toward inFlight** and still feeds the signal (its
   * request's provider sees it too). The main agent's turn is never blocked by workflow
   * traffic.
   */
  observer(): ModelRequestAdmission;
  /** A read-only snapshot of the controller; undefined when there is no bucket for this key. */
  snapshot(key: string): ConcurrencyControllerSnapshot | undefined;
}

interface WorkflowConcurrencyGovernorOptions {
  /** The ceiling: both the initial value at bucket creation and the upper bound; computed once at process start. */
  ceiling: number;
  /** The clock (injectable). */
  now?: () => number;
  /** The timer (injectable): wakes waiters when a cooldown expires. Returns a cancel function. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** A rate-limit-class retry reason → the controller's throttled signal. */
const THROTTLE_REASONS: ReadonlySet<string> = new Set<ConcurrencyThrottleReason>([
  "rate_limited",
  "provider_overloaded",
  "offpeak_queued",
]);
/** A retry reason that is not a provider failure: it neither lowers the cap nor clears the streak — it only ends the attempt. */
const NON_FAILURE_RETRY_REASONS: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

interface Waiter {
  runId: string;
  resolve: (ticket: ModelRequestAdmissionTicket) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface Bucket {
  readonly key: string;
  readonly controller: ConcurrencyController;
  /** The per-run count of in-flight (admitted, not yet settled) requests — the basis for fan-out: only runs with in-flight or queued requests receive cap changes. */
  readonly inFlightByRun: Map<string, number>;
  /** Waiters are queued per run (round-robin across runs, so a large fan-out cannot starve a small run that arrives later). */
  readonly queues: Map<string, Waiter[]>;
  /** The round-robin cursor: the run admitted last; the next search starts after it. */
  lastGrantedRun?: string;
  cancelCooldownWake?: () => void;
}

/** The run identity of the observer (the main agent): it does not queue and does not subscribe, appearing only in the fan-out filter as "not any run". */
const OBSERVER_RUN_ID = "\0observer";

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // Don't let a cooldown timer lock the process: it shouldn't have voting rights when the run ends and the process wants to exit.
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

function createWorkflowConcurrencyGovernor(
  options: WorkflowConcurrencyGovernorOptions,
): WorkflowConcurrencyGovernor {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const buckets = new Map<string, Bucket>();
  /** A run-level subscription (not per key): fan-out filters by the bucket's engaged set. */
  const listeners = new Map<string, Set<(change: ConcurrencyChange) => void>>();

  const bucketFor = (key: string): Bucket => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      // Lazy bucket creation, initial value = ceiling; thereafter, the run will not reset it when it comes and goes (only when it is idle for 5 minutes).
      bucket = {
        key,
        controller: new ConcurrencyController(key, options.ceiling),
        inFlightByRun: new Map(),
        queues: new Map(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const waiterCount = (bucket: Bucket): number => {
    let total = 0;
    for (const queue of bucket.queues.values()) total += queue.length;
    return total;
  };

  /** Fan-out: only to the runs that right now have an in-flight or queued request on this key. */
  const fanOut = (bucket: Bucket, changes: ConcurrencyChange[]): void => {
    if (changes.length === 0) return;
    for (const [runId, set] of listeners) {
      const engaged =
        (bucket.inFlightByRun.get(runId) ?? 0) > 0 || (bucket.queues.get(runId)?.length ?? 0) > 0;
      if (!engaged) continue;
      for (const change of changes) {
        for (const listener of set) listener(change);
      }
    }
  };

  const bumpInFlight = (bucket: Bucket, runId: string, delta: number): void => {
    const next = (bucket.inFlightByRun.get(runId) ?? 0) + delta;
    if (next <= 0) bucket.inFlightByRun.delete(runId);
    else bucket.inFlightByRun.set(runId, next);
  };

  /**
   * The ticket of one admitted attempt: the event mapping stays consistent. Settlement happens
   * after whichever terminal mapping arrives (idempotent); a `release()` that has seen no
   * terminal event is treated as `ended`. Every publish / release after settlement is lazy —
   * on a few rare paths (fallback events after an attempt has already ended) the runner may
   * still deliver one.
   */
  const mintTicket = (
    bucket: Bucket,
    runId: string,
    epoch: number,
  ): ModelRequestAdmissionTicket => {
    let settled = false;
    const settle = (signal: (at: number) => ConcurrencyChange[]): void => {
      if (settled) return;
      settled = true;
      const changes = signal(now());
      // First fan out and then reduce on the fly: the request that produced this change is for this run, and it is still considered engaged at this moment - otherwise the only one for a run
      // If it is flying and requests to be knocked out in half, it will be missed to itself because it is "no longer flying".
      fanOut(bucket, changes);
      bumpInFlight(bucket, runId, -1);
      // Settlement releases a slot (or changes the cap), and those in line may be released.
      drain(bucket);
    };
    return {
      publish(event: ModelNetworkStatusEvent) {
        if (settled) return;
        switch (event.type) {
          case "model_request_started":
            // InFlight is already accounted for at admission, no new information here.
            return;
          case "model_request_completed":
            settle((at) => bucket.controller.succeeded(at, epoch));
            return;
          case "model_retry_scheduled": {
            const reason: string = event.reason;
            if (NON_FAILURE_RETRY_REASONS.has(reason)) {
              settle((at) => bucket.controller.ended(at));
              return;
            }
            if (THROTTLE_REASONS.has(reason)) {
              settle((at) =>
                bucket.controller.throttled(
                  at,
                  epoch,
                  reason as ConcurrencyThrottleReason,
                  event.retryAfterMs,
                ),
              );
              return;
            }
            settle((at) => bucket.controller.failedTransient(at));
            return;
          }
          case "model_request_failed":
            // The failed retryable:true is followed by a retry_scheduled - that one is the signal.
            if (event.retryable) return;
            // Non-retryable current limit:
            // The main dialogue/tool side collision with 3008, such as 429, which is terminated by the classifier, is still a literal concurrent signal——
            // Only when the "chain ends" will the cap never be lowered due to it. The quota code also goes like this: if you reduce it by one and a half times more, the run will stop immediately, which is harmless.
            if (event.reason === "rate_limited") {
              settle((at) =>
                bucket.controller.throttled(at, epoch, "rate_limited", event.retryAfterMs),
              );
              return;
            }
            settle((at) => bucket.controller.ended(at));
            return;
          default:
            return;
        }
      },
      release() {
        settle((at) => bucket.controller.ended(at));
      },
    };
  };

  /** Admit one request: `observe` comes first (admission is a "signal" too), then `admitted` takes the epoch. */
  const grant = (bucket: Bucket, runId: string): ModelRequestAdmissionTicket => {
    fanOut(bucket, bucket.controller.observe(now()));
    const epoch = bucket.controller.admitted(now());
    bumpInFlight(bucket, runId, 1);
    bucket.lastGrantedRun = runId;
    return mintTicket(bucket, runId, epoch);
  };

  /** Pick the next run that has waiters, in round-robin order. */
  const nextRunWithWaiters = (bucket: Bucket): string | undefined => {
    const runs = [...bucket.queues.keys()].filter(
      (runId) => (bucket.queues.get(runId)?.length ?? 0) > 0,
    );
    if (runs.length === 0) return undefined;
    const last = bucket.lastGrantedRun;
    const lastIndex = last === undefined ? -1 : runs.indexOf(last);
    return runs[(lastIndex + 1) % runs.length];
  };

  const armCooldownWake = (bucket: Bucket): void => {
    bucket.cancelCooldownWake?.();
    bucket.cancelCooldownWake = undefined;
    if (waiterCount(bucket) === 0) return;
    const until = bucket.controller.snapshot().cooldownUntil;
    if (until === undefined) return;
    const delay = Math.max(0, until - now());
    bucket.cancelCooldownWake = schedule(() => {
      bucket.cancelCooldownWake = undefined;
      drain(bucket);
    }, delay);
  };

  /** Admit as many waiters as possible (gate: inFlight < cap and not in cooldown), wake the waiters, and set the cooldown alarm when needed. */
  const drain = (bucket: Bucket): void => {
    fanOut(bucket, bucket.controller.observe(now()));
    for (;;) {
      fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
      if (!bucket.controller.canAdmit(now())) break;
      const runId = nextRunWithWaiters(bucket);
      if (runId === undefined) break;
      const queue = bucket.queues.get(runId)!;
      const waiter = queue.shift()!;
      if (queue.length === 0) bucket.queues.delete(runId);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(grant(bucket, runId));
    }
    fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
    armCooldownWake(bucket);
  };

  const tryAdmit: WorkflowConcurrencyPort["tryAdmit"] = (runId, key) => {
    const bucket = bucketFor(key);
    fanOut(bucket, bucket.controller.observe(now()));
    if (waiterCount(bucket) > 0 || !bucket.controller.canAdmit(now())) return undefined;
    return grant(bucket, runId);
  };

  const admit: WorkflowConcurrencyPort["admit"] = (runId, key, signal) => {
    const bucket = bucketFor(key);
    if (signal.aborted) return Promise.reject(abortedError(signal));
    return new Promise<ModelRequestAdmissionTicket>((resolve, reject) => {
      const waiter: Waiter = { runId, resolve, reject, signal, onAbort: () => {} };
      waiter.onAbort = () => {
        const queue = bucket.queues.get(runId);
        if (queue !== undefined) {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) bucket.queues.delete(runId);
        }
        reject(abortedError(signal));
        fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
        armCooldownWake(bucket);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const queue = bucket.queues.get(runId) ?? [];
      queue.push(waiter);
      bucket.queues.set(runId, queue);
      drain(bucket);
    });
  };

  const subscribe: WorkflowConcurrencyPort["subscribe"] = (runId, listener) => {
    const set = listeners.get(runId) ?? new Set();
    set.add(listener);
    listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(runId);
    };
  };

  // No queuing, no cooling; observe in grant. The fast path always hits, so the runner is never the primary agent
  // The request is queued/admitted.
  const observerAdmission: ModelRequestAdmission = {
    tryAcquire: ({ model }) => grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID),
    acquire: ({ model }) =>
      Promise.resolve(grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID)),
  };

  return {
    tryAdmit,
    admit,
    subscribe,
    observer: () => observerAdmission,
    snapshot(key) {
      return buckets.get(key)?.controller.snapshot();
    },
  };
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("workflow request admission aborted");
}

let processGovernor: WorkflowConcurrencyGovernor | undefined;

/**
 * The process-level singleton: the ceiling is computed once, on first use; from then on
 * every app's (session's) main runtime attaches its observer, and the run service hands the
 * driver the same port.
 */
export function getWorkflowConcurrencyGovernor(): WorkflowConcurrencyGovernor {
  processGovernor ??= createWorkflowConcurrencyGovernor({
    ceiling: resolveWorkflowConcurrencyCeiling(),
  });
  return processGovernor;
}
