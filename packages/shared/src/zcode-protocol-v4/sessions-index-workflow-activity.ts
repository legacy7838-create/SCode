// ============================================================
// Summary of workflow runs for sessions-index
// ============================================================
// In the sidebar, you need to draw a line "Workflow icon + mini track light + current phase name" under the session title, but you cannot subscribe to the entire
// workflowRuns (that is the conversation authoritative projection, which changes frequently according to the run progress). Here the same snapshot
// `workflowRuns` + `backgroundWorks` derive a bounded summary containing only the fields actually read in the sidebar:
// Pure function, no clock - "When the ended line is folded" is determined by the confirmed collection on the rendering side, and the time is not recorded here.

import { z } from "zod";
import { timestampSchema } from "./core.js";
import type { BackgroundWorkSummary } from "./snapshot.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunSchema,
  type WorkflowRunNode,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/** Maximum number of runs shipped per session: live runs first in launch order, then the most recently ended ones. */
export const SESSION_WORKFLOW_ACTIVITY_MAX_RUNS = 4;

/**
 * The four states of a station light, the same vocabulary as the card timeline (`STATUS_DOT`).
 * The control flow supplies the skeleton: while a run is live the current phase is running, the
 * phases already entered are done, the rest pending; completed → everything entered is done;
 * errored → the current one failed; stopped → the current one pending.
 *
 * Member nodes add one more rule: while the run is live, a node **born at this station** that is
 * genuinely running right now lights it up. Parallel phases can therefore burn at the same time —
 * the control flow only remembers the last marker, while A's subagent is still working after B's
 * marker. A node only ever says "still running", and never rewrites done / failed / pending into
 * something else: the failure word is reserved for the control flow.
 */
export const sessionWorkflowPhaseStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export type SessionWorkflowPhaseStatus = z.infer<typeof sessionWorkflowPhaseStatusSchema>;

export const sessionWorkflowPhaseSummarySchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  status: sessionWorkflowPhaseStatusSchema,
  /**
   * The **indices** of the other stations that were still running when this one was entered (indices
   * into this `phases` array), taken from `run.phaseAlongside`. The sidebar uses it to draw the two
   * parallel stations as a double line segment. Only the declaration-table path has this fact — the
   * fallback path (the entered phases) is assembled in entry order and has no parallelism to speak
   * of, so the whole key is absent there.
   */
  alongside: z.array(z.number().int().nonnegative()).max(WORKFLOW_RUNS_LIMITS.maxPhases).optional(),
});
export type SessionWorkflowPhaseSummary = z.infer<typeof sessionWorkflowPhaseSummarySchema>;

export const sessionWorkflowRunSummarySchema = z.object({
  runId: z.string().min(1),
  /** Tool-call id of the launching row: the key that opens the run pane when the run row is clicked; directly launched runs have one too (the `launch-` prefix). */
  toolCallId: z.string().min(1).optional(),
  /** Title of the workflow's background work (= the run's display name); absent when the projection has no matching background work. */
  name: z.string().min(1).optional(),
  status: workflowRunSchema.shape.status,
  stopReason: workflowRunSchema.shape.stopReason,
  /** Start instant of the background work, used for the tooltip's elapsed; absent when there is no background work. */
  startedAt: timestampSchema.optional(),
  /**
   * The station table in declaration order: `run.phaseNames` (the declaration table run-launched
   * brings) when it is present, otherwise degrading to the entered phases + the current phase (in
   * entry order). When neither exists it is an empty array and the UI draws one implicit station,
   * "Workflow".
   */
  phases: z.array(sessionWorkflowPhaseSummarySchema).max(WORKFLOW_RUNS_LIMITS.maxPhases),
  currentPhase: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /** Number of subagents with status === "running" (the tooltip's "{n} agents working"). */
  agentsWorking: z.number().int().nonnegative(),
});
export type SessionWorkflowRunSummary = z.infer<typeof sessionWorkflowRunSummarySchema>;

export const sessionWorkflowActivitySchema = z.object({
  runs: z.array(sessionWorkflowRunSummarySchema).max(SESSION_WORKFLOW_ACTIVITY_MAX_RUNS),
});
export type SessionWorkflowActivity = z.infer<typeof sessionWorkflowActivitySchema>;

export function isSessionWorkflowRunLive(status: SessionWorkflowRunSummary["status"]): boolean {
  return status === "pending" || status === "running";
}

/**
 * "This node is genuinely running right now": term-for-term the same as the running arm of
 * `statusOfRunNode` in packages/ui, and the same set the reducer uses to push the actor tri-state
 * (workflow-runs-reducer.ts), so the station light and "{n} agents working" always say "running"
 * about the very same thing.
 *
 * `dispatched` / `waiting` do not count: the former is the brief phase of "session ready, first
 * request not yet admitted", the latter is waiting for a slot or backing off — `node-executing`
 * is what says the request actually went out.
 */
function isRunNodeRunning(node: WorkflowRunNode): boolean {
  return node.phase === "executing" || node.phase === "repairing" || node.phase === "nudged";
}

/**
 * The rule that associates a station name with an instance birth stamp. Term-for-term the same as
 * `phaseNameMatches` in packages/ui (workflow-graph/phase-name.ts): an exact match, with a prefix
 * fallback only when the station name **exactly hits the upper bound** — the prefix is enabled only
 * when truncation actually happened, otherwise "Plan" would wrongly match "Plan Fix". That helper
 * lives in the ui layer and shared cannot depend back on it, so the same rule is inlined here.
 */
function phaseNameMatches(stationName: string, stamp: string): boolean {
  return (
    stationName === stamp ||
    (stationName.length >= WORKFLOW_RUNS_LIMITS.maxPhaseNameLength && stamp.startsWith(stationName))
  );
}

function derivePhases(run: WorkflowRunState): SessionWorkflowPhaseSummary[] {
  const entered = new Set((run.phases ?? []).map((phase) => phase.name));
  const current = run.currentPhase;
  let names: string[];
  // The subscript of "running at the same time" refers to the position in the declaration table, so it only makes sense when taking the declaration table path; the degenerate path
  // (Entered phase + current phase) is another subscript space, and the entire table does not have it at that time.
  let alongside: readonly (readonly number[])[] | undefined;
  if (run.phaseNames !== undefined && run.phaseNames.length > 0) {
    names = run.phaseNames;
    alongside = run.phaseAlongside;
  } else {
    names = (run.phases ?? []).map((phase) => phase.name);
    if (current !== undefined && !entered.has(current)) names = [...names, current];
  }
  const live = isSessionWorkflowRunLive(run.status);
  // The birth stamp of the running node. The entire table is empty when run is not running: no one is still working in the final state run, even if a certain item is settled
  // The incident didn't have time to come to an end (the same attitude as "the final state overwhelms everything" in the actor's three states).
  const burning = live
    ? run.nodes.filter(isRunNodeRunning).flatMap((node) => node.phaseName ?? [])
    : [];
  const emitted = Math.min(names.length, WORKFLOW_RUNS_LIMITS.maxPhases);
  return names.slice(0, WORKFLOW_RUNS_LIMITS.maxPhases).map((name, index) => {
    const isCurrent = name === current;
    const wasEntered = entered.has(name) || isCurrent;
    // The node born at this station is still running → this station is still burning, even if the control flow has already reached the next mark.
    const burningHere = burning.some((stamp) => phaseNameMatches(name, stamp));
    let status: SessionWorkflowPhaseStatus;
    if (live) {
      status = isCurrent || burningHere ? "running" : wasEntered ? "done" : "pending";
    } else if (run.status === "completed") {
      status = wasEntered ? "done" : "pending";
    } else if (run.status === "errored") {
      status = isCurrent ? "failed" : wasEntered ? "done" : "pending";
    } else {
      // stopped: The control flow is stopped at the current phase, it has not completed or failed - leave an empty light.
      status = isCurrent ? "pending" : wasEntered ? "done" : "pending";
    }
    // After the table is cut, the subscript space becomes narrower: references pointing to the cut sites are discarded, and no keys are created for the remaining empty ones.
    const beside = (alongside?.[index] ?? []).filter(
      (other) => Number.isInteger(other) && other >= 0 && other < emitted && other !== index,
    );
    return { name, status, ...(beside.length === 0 ? {} : { alongside: beside }) };
  });
}

function summarizeRun(
  run: WorkflowRunState,
  work: BackgroundWorkSummary | undefined,
): SessionWorkflowRunSummary {
  const name = work?.title.trim();
  return {
    runId: run.runId,
    ...(run.toolCallId === undefined ? {} : { toolCallId: run.toolCallId }),
    ...(name === undefined || name.length === 0 ? {} : { name }),
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    ...(work === undefined ? {} : { startedAt: work.startedAt }),
    phases: derivePhases(run),
    ...(run.currentPhase === undefined ? {} : { currentPhase: run.currentPhase }),
    agentsWorking: run.actors.filter((actor) => actor.status === "running").length,
  };
}

/**
 * Derives a session's workflow run summary from the same snapshot's `workflowRuns` +
 * `backgroundWorks`. Live runs (pending / running) come first in `runs[]` order (= launch order);
 * ended ones follow, newest first by the background work's `endedAt`, and in `runs[]` order when
 * there is no endedAt (later-created is newer). The total is trimmed to 4.
 * A session with no run at all → `undefined` (the key is absent entirely, so older CLIs change
 * nothing).
 */
export function deriveSessionWorkflowActivity(input: {
  workflowRuns: WorkflowRunsState | undefined;
  backgroundWorks: readonly BackgroundWorkSummary[];
}): SessionWorkflowActivity | undefined {
  const runs = input.workflowRuns?.runs;
  if (runs === undefined || runs.length === 0) return undefined;
  const workByRunId = new Map<string, BackgroundWorkSummary>();
  for (const work of input.backgroundWorks) {
    if (work.kind === "workflow") workByRunId.set(work.workId, work);
  }
  const live: SessionWorkflowRunSummary[] = [];
  const settled: { summary: SessionWorkflowRunSummary; endedAt: number; index: number }[] = [];
  runs.forEach((run, index) => {
    const work = workByRunId.get(run.runId);
    const summary = summarizeRun(run, work);
    if (isSessionWorkflowRunLive(run.status)) live.push(summary);
    else settled.push({ summary, endedAt: work?.endedAt ?? 0, index });
  });
  settled.sort((a, b) => b.endedAt - a.endedAt || b.index - a.index);
  return {
    runs: [...live, ...settled.map((entry) => entry.summary)].slice(
      0,
      SESSION_WORKFLOW_ACTIVITY_MAX_RUNS,
    ),
  };
}
