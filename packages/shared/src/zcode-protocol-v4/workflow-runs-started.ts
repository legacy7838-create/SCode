// ============================================================
// workflowRuns reduced `run-started` branch
// ============================================================
// Removed from workflow-runs-reducer.ts (max-lines gate): the main reduction only leaves the dispatch of switch, and
// `concurrency-changed` / `phase-entered` same precedent. This incident has the most to say - resume
// Heavy arm semantics, lineage pointers, this run's own concurrency bounds - and the three are related to each other: the second entry for the same runId
// `run-started` should not only clear the settlement residual image of the previous life, but also cannot erase the shared cap that has been learned in the process back to the ceiling.

import { reduceRunStartedConcurrency } from "./workflow-runs-concurrency.js";
import { workflowRunTablesForNewLife } from "./workflow-runs-eviction.js";
import { readRunIdField } from "./workflow-runs-lineage.js";
import { WORKFLOW_RUNS_LIMITS, type WorkflowRunState } from "./workflow-runs.js";

/**
 * The subagent model on the payload (canonical string `providerId/modelId[$reasoningLevel]`).
 * Over the bound it is dropped whole rather than truncated: a chopped-short model id is a lie,
 * and showing nothing is preferable.
 */
function readSubagentModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= WORKFLOW_RUNS_LIMITS.maxSubagentModelLength
    ? text
    : undefined;
}

/**
 * `run-started` → the run goes back to running, usage resets to zero, and the previous life's
 * settlement ghosts are scrubbed off.
 *
 * The resume fix:
 * The same runId can be run-started again (in-process cancel → resume). Expanding it as-is
 * would leave the previous life's settlement ghosts (error / resultPreview) hanging off a
 * running run — the projection-side counterpart of the journal's clearing semantics
 * (updateRunStatus clearing settlement for a non-terminal status) is exactly these few lines of
 * scrubbing. Pending upgrade questions belong to that same category of "ghosts of the previous
 * life", and they have even less reason to survive than the settlement ghosts: those questions
 * hang off the previous life's parked defer, which was already rejected together with cancelAsk
 * on cancel. In the new life the corresponding ask re-runs, the actor asks again, and gets a
 * **new qid** — keeping the old one would only leave the sidebar showing a question that will
 * never get an answer and that nobody is waiting on any more.
 * `resumable` likewise belongs to the previous life's settlement facts: once a resume starts
 * running, it is no longer resumable.
 *
 * Usage is replaced wholesale by a zero object, so the **two rejected-instance counters
 * (`nodesUnlisted` / `nodesUnlistedSettled`) are zeroed along with it** — which is exactly the
 * semantics they need: a re-arm resends the whole script prefix (the cached settle of
 * already-finished instances, the queued of new ones), so not zeroing them would add the
 * "steps that never made it into the table" of two lives together. See workflow-runs-caps.ts.
 * For the same reason `unlistedByPhase` is cleared (it is where the previous life spent its
 * bounds), and **a run that overflowed has both tables cleared as well** — the rule and the
 * reasoning live in workflowRunTablesForNewLife in workflow-runs-eviction.ts.
 *
 * `concurrency` is **not** among the things scrubbed: it is not a ghost of the previous life but
 * a fact about what concurrency this run is running at (both bounds are), and the shared-bucket
 * side is even process-wide current state. The rule lives in workflow-runs-concurrency.ts.
 * `subagentModel` is the same, and even harder: it is a condition the user set for this run, and
 * a resume re-arm carries the same value.
 */
export function reduceRunStarted(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const {
    error: staleError,
    resultPreview: staleResultPreview,
    pendingQuestions: staleQuestions,
    resumable: staleResumable,
    stopReason: staleStopReason,
    unlistedByPhase: staleUnlisted,
    ...rebased
  } = run;
  void [
    staleError,
    staleResultPreview,
    staleQuestions,
    staleResumable,
    staleStopReason,
    staleUnlisted,
  ];
  // The lineage pointer arrives with `run-started` (CLI is derived from the launch input parameter or journal line); the heavy arm carries the same value and can be moved.
  const resumedFrom = readRunIdField(payload.resumedFrom) ?? rebased.resumedFrom;
  // Subagent model: "this run's own conditions" in the same family as `limit`, only with
  // This event arrives. If it cannot be read, it will return to the known value - the old CLI does not send this key, and erasing the displayed model is degenerate.
  // The worst kind: run seems to have changed the model, but in fact it just lacks one field. Absent means that the entire key is not present (not undefined).
  const subagentModel = readSubagentModel(payload.subagentModel) ?? rebased.subagentModel;
  return reduceRunStartedConcurrency(
    {
      ...rebased,
      ...(resumedFrom === undefined ? {} : { resumedFrom }),
      ...(subagentModel === undefined ? {} : { subagentModel }),
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      ...workflowRunTablesForNewLife(run),
    },
    payload,
  );
}
