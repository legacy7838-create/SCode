// ============================================================
// The adaptive concurrency part of workflowRuns reduction
// ============================================================
// Detached from workflow-runs-reducer.ts (max-lines gate): the main reduction only leaves the dispatch of switch.
// The rules of `concurrency-changed` live here. The same discipline as main reduction: pure functions, no clocks - events
// `cooldownMs` is a relative quantity, and the deadline is calculated by the UI according to the time when the status is received.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunConcurrency,
  type WorkflowRunState,
} from "./workflow-runs.js";

/** The `reason` value on the event: the bucket idle-resets back to the ceiling — it is not a cooldown, and receiving it clears any old cooldown. */
const CONCURRENCY_IDLE_RESET_REASON = "idle_reset";

/**
 * `concurrency-changed` → `run.concurrency`.
 *
 * The ceiling is derived from the largest `previous` / `next` this run has seen (the event does not
 * carry it; the bucket starts at the ceiling, so the first event's `previous` is the ceiling, and in
 * a decrease-only sequence it is always the maximum). `cooldownMs` is present only on a rate limit
 * that carried a Retry-After; `idle_reset` clears it. When `next` cannot be read (absent / not a
 * positive integer) the whole event only raises the waterline: without a cap there is nothing to show.
 *
 * `limit` is carried over untouched: it is this run's own bound (brought by `run-started`) and is
 * unrelated to the shared bucket rising and falling — the governor lowering or releasing a provider
 * key does not change the ceiling the user set for this run.
 */
export function reduceConcurrencyChanged(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const next = positiveInteger(payload.next);
  if (next === undefined) return run;
  const previous = positiveInteger(payload.previous) ?? next;
  const ceiling = Math.max(run.concurrency?.ceiling ?? 0, previous, next);
  const key = nonEmptyString(payload.key);
  const limit = run.concurrency?.limit;
  const cooldownMs =
    payload.reason === CONCURRENCY_IDLE_RESET_REASON
      ? undefined
      : nonNegativeInteger(payload.cooldownMs);
  const concurrency: WorkflowRunConcurrency = {
    ...(key === undefined || key.length > WORKFLOW_RUNS_LIMITS.maxConcurrencyKeyLength
      ? {}
      : { key }),
    cap: next,
    ceiling,
    ...(limit === undefined ? {} : { limit }),
    ...(cooldownMs === undefined ? {} : { cooldownMs }),
  };
  return { ...run, concurrency };
}

/**
 * `run-started` → `run.concurrency.limit`: this run's **own** bound. The payload carries the engine's
 * `caps.maxConcurrency` plus the `concurrencyCeiling` the CLI computed at the moment it minted the
 * payload (the ceiling is a process fact, not an engine fact, so the CLI splices it in, the same
 * precedent as `resumedFrom`).
 *
 * Recorded only when `maxConcurrency < ceiling`: a run living at the ceiling is byte-for-byte the
 * same as before, not a single key more. Older CLIs do not send `concurrencyCeiling`, so without a
 * readable ceiling there is no way to tell whether this run was capped — so nothing changes.
 *
 * The shared-bucket side (`cap` / `key` / `cooldownMs`) is kept as-is: a resume sends another
 * `run-started` for the same runId, and by then the process has probably already learned a cap
 * lowered by rate limiting; overwriting it with the ceiling would raise the reading back to a fake
 * value. Likewise `ceiling` only rises, never falls — the same waterline rule as
 * `reduceConcurrencyChanged`.
 */
export function reduceRunStartedConcurrency(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const limit = positiveInteger(plainRecord(payload.caps)?.maxConcurrency);
  const readCeiling = positiveInteger(payload.concurrencyCeiling);
  const ceiling =
    readCeiling !== undefined && readCeiling <= WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling
      ? readCeiling
      : undefined;
  // Record the ceiling itself separately (`run.concurrencyCeiling`): "Configuring" the elastic layer's stepper needs to know where to stop, and
  // A run on the ceiling has no `concurrency` to hang from. If it cannot be read, use the known value - the same degeneracy rule as subagentModel.
  const withCeiling =
    ceiling === undefined || run.concurrencyCeiling === ceiling
      ? run
      : { ...run, concurrencyCeiling: ceiling };
  if (limit === undefined || ceiling === undefined || limit >= ceiling) return withCeiling;
  const existing = withCeiling.concurrency;
  const concurrency: WorkflowRunConcurrency = {
    // When there are no shared bucket readings, cap starts from the ceiling - where the buckets originally started (same as reduceConcurrencyChanged
    // The basis for deriving ceiling).
    ...(existing ?? { cap: ceiling }),
    ceiling: Math.max(existing?.ceiling ?? 0, ceiling),
    limit,
  };
  return { ...withCeiling, concurrency };
}

/**
 * `run-caps-changed` → `run.concurrency.limit`: the run's own bound changed **while it was in
 * flight**. A revision that only touches `max_concurrency` takes effect in place — it neither
 * stops this run nor starts another one — the engine emits this event after changing the caps, with
 * a payload shaped exactly like `run-started`'s (the engine's `caps.maxConcurrency` plus the
 * `concurrencyCeiling` the CLI splices in). So this reads the same two fields as
 * `reduceRunStartedConcurrency` and keeps the same "record only when below the ceiling" rule: the
 * same number arriving by two paths must not produce two readings.
 *
 * The ceiling is taken "from the payload, then from this run's known value". It is a process fact,
 * constant for the whole run, and `run-started` already recorded it on `run.concurrencyCeiling`, so
 * this event has one extra fallback over `run-started`; only when neither is there is there no way to
 * tell whether the number was capped — and nothing changes. The same goes for an unreadable `caps`.
 *
 * Climbing back to the ceiling must **remove** `limit` rather than write the ceiling into it: by
 * protocol a run living at the ceiling has no bound of its own. Once removed, if the shared-bucket
 * side has nothing to say either (cap at the waterline, not in cooldown), the whole `concurrency`
 * key is absent — byte-for-byte the same as a run that was never capped. When there was no `limit` to
 * begin with, not a single thing changes (the idempotent pivot).
 */
export function reduceRunCapsChanged(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const maxConcurrency = positiveInteger(plainRecord(payload.caps)?.maxConcurrency);
  const readCeiling = positiveInteger(payload.concurrencyCeiling);
  const payloadCeiling =
    readCeiling !== undefined && readCeiling <= WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling
      ? readCeiling
      : undefined;
  const withCeiling =
    payloadCeiling === undefined || run.concurrencyCeiling === payloadCeiling
      ? run
      : { ...run, concurrencyCeiling: payloadCeiling };
  const ceiling = payloadCeiling ?? withCeiling.concurrencyCeiling;
  if (maxConcurrency === undefined || ceiling === undefined) return withCeiling;
  const existing = withCeiling.concurrency;
  if (maxConcurrency < ceiling) {
    const concurrency: WorkflowRunConcurrency = {
      // Cap starts from the ceiling when there are no shared bucket readings - the same basis as reduceRunStartedConcurrency.
      ...(existing ?? { cap: ceiling }),
      ceiling: Math.max(existing?.ceiling ?? 0, ceiling),
      limit: maxConcurrency,
    };
    return { ...withCeiling, concurrency };
  }
  if (existing?.limit === undefined) return withCeiling;
  const { limit: _lifted, ...shared } = existing;
  return shared.cooldownMs === undefined && shared.cap >= shared.ceiling
    ? withoutConcurrency(withCeiling)
    : { ...withCeiling, concurrency: shared };
}

/** Removes the whole `concurrency` key (rather than leaving an empty object): on the protocol, "living at the ceiling" means exactly that this key is absent. */
function withoutConcurrency(run: WorkflowRunState): WorkflowRunState {
  const { concurrency: _cleared, ...rest } = run;
  return rest;
}

/**
 * Removes `concurrency.cooldownMs` (terminal run state: nothing is dispatched any more, so a
 * cooldown has no object). When there is nothing to remove it returns the input unchanged — the
 * idempotent-replay pivot, same idea as the main reducer's withoutPendingQuestions. cap / ceiling
 * are kept: they are the historical fact of what concurrency this run actually ran at.
 */
export function withoutCooldown(run: WorkflowRunState): WorkflowRunState {
  if (run.concurrency?.cooldownMs === undefined) return run;
  const { cooldownMs: _expired, ...rest } = run.concurrency;
  return { ...run, concurrency: rest };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
