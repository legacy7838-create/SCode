// ============================================================
// Workflow concurrency ceiling: the only implementation of CPU derived values
// ============================================================
// `max(1, min(16, availableParallelism() − 2))`
// It is not only the concurrency upper bound of each run (commit timing, dwf_run, and resume are still used), but also the upper bound of each process-level manager.
// The **start and ceiling** of the provider bucket. The formula must converge to a single function: copy in run service / snippet
// Service/legacy `Workflow` tools drift in three places, which will make the "run upper bound" and "bucket ceiling" misaligned.

import { availableParallelism as osAvailableParallelism } from "node:os";

/** Hard ceiling of the concurrency bound (keeps the legacy concurrency formula). */
const WORKFLOW_CONCURRENCY_CEILING_MAX = 16;
/** Number of cores left aside for the main agent and the host process. */
const RESERVED_PARALLELISM = 2;
/** Floor: on a dual-core machine parallelism − 2 == 0, and at least one probe has to stay running. */
const WORKFLOW_CONCURRENCY_FLOOR = 1;

/**
 * The concurrency ceiling derived from the CPU. `availableParallelism` is injectable so tests can pin the core count (the floor / hard-ceiling cases).
 */
export function resolveWorkflowConcurrencyCeiling(
  availableParallelism: () => number = osAvailableParallelism,
): number {
  return Math.max(
    WORKFLOW_CONCURRENCY_FLOOR,
    Math.min(WORKFLOW_CONCURRENCY_CEILING_MAX, availableParallelism() - RESERVED_PARALLELISM),
  );
}

/**
 * The requested concurrency bound → the bound actually in effect for this run.
 *
 * **Clamp, never reject**: this knob exists only to lower concurrency, and an over-large value expresses the intent
 * "do not limit me"; turning it into a tool failure would only send the model off guessing how many cores the machine
 * has. Absent / non-finite values likewise read as "do not limit" = the ceiling, and non-integers are floored ("3.7 in-flight asks" is meaningless, and rounding up would silently exceed the number the user gave).
 *
 * It lives in the same file as the ceiling on purpose: the ceiling set at submit time and the mid-flight retune MUST
 * go through the very same clamp (otherwise one `max_concurrency` would land on two different numbers via two paths), and those two paths sit in the run service and the retune module respectively.
 */
export function clampRunConcurrency(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.max(1, Math.min(ceiling, Math.floor(requested)));
}
