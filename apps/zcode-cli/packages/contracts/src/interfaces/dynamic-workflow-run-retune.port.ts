// Dynamic Workflow Run Port: Adjust the upper limit of concurrency in running.
// Define requests, results and capability boundaries, which are unified and then exported by dynamic-workflow-run.port.ts.
// Used by callers via `@zcode/contracts`.

/**
 * The request of
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.retuneConcurrency}.
 */
export interface DynamicWorkflowRunRetuneRequest {
  runId: string;
  /**
   * The new concurrency ceiling. `null` = the ceiling = lifting this run's own limit (synonymous with
   * `AmendWorkflow`'s `max_concurrency: null`). A number is clamped to `[1, the ceiling]`: the clamping uses the
   * port's own implementation, so the tool layer neither needs to nor should clamp again into a second
   * answer.
   */
  maxConcurrency: number | null;
}

/**
 * The structured reason a retune was rejected. The two are **two different next steps** for the caller, so
 * they must be distinguishable:
 *
 *   - `not_live`: this service does not hold that in-flight run (it was never this process's, it already
 *     settled), or it happened to settle between the liveness check and this call. The caller falls back to a
 *     real amendment (the existing path of `AmendWorkflow`).
 *   - `unchanged`: the value equals the ceiling in effect right now. Nothing was written and nothing was
 *     stopped: `current` is that value, and the caller writes "it is already n" from it.
 */
export type DynamicWorkflowRunRetuneRefusalReason = "not_live" | "unchanged";

/**
 * The structured result of a retune. Failure travels as a reason rather than a throw, by the same argument as
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunAmendResult}: both reasons are business
 * branches the caller can anticipate.
 *
 * `ceiling` and `previous` are not gold-plating: the model-facing reply has to say "at most n subagents
 * running at the same time", and when n equals the ceiling what it should say is "the limit is lifted" (the
 * same criterion as `CreateWorkflow`'s reply); the event log has to say "8 -> 2", and the previous value cannot
 * be inferred from a single new one. Only the port side knows both, and leaving them for the caller to
 * recompute would be a second implementation of the ceiling.
 */
export type DynamicWorkflowRunRetuneResult =
  | { ok: true; maxConcurrency: number; previous: number; ceiling: number }
  | {
      ok: false;
      reason: DynamicWorkflowRunRetuneRefusalReason;
      /** The ceiling in effect right now; always present for `unchanged`, and for `not_live` only when it is still readable. */
      current?: number;
    };
