import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

/**
 * The join from a tool card to a dwf run.
 *
 * The authoritative source is the `toolCallId` of each run in the `workflowRuns` projection (the
 * schema comment already calls it "the join key from a tool card to the detail page"); the tool
 * row's own output in v4 is reduced to the single sentence `formatCreateWorkflowModelContent`
 * picked out — the structured fields `status` / `backgroundTaskId` are simply not on the row.
 *
 * It is a pure function rather than a stretch of `useMemo` inside a component: the counting
 * semantics (settled vs observed) are the only rule here worth enumerating, and enumerating a Map
 * renders nothing.
 */
export function buildWorkflowRunByToolCallId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, WorkflowRunCardSummary> {
  const byToolCallId = new Map<string, WorkflowRunCardSummary>();
  for (const run of runs ?? []) {
    // A run without toolCallId has no clickable card and is not included in the table.
    if (!run.toolCallId) continue;
    const { settled, total } = workflowRunStepCounts(run);
    byToolCallId.set(run.toolCallId, {
      runId: run.runId,
      status: run.status,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      nodesSettled: settled,
      // Scheduled (observed) rather than the total number of entire processes: the number of nodes in a dynamic workflow is determined by the script at runtime.
      nodesTotal: total,
      agents: run.actors.length,
      // Live projection of the entire strip: Card inline timeline with lights, pills and ink.
      run,
      // Recoverability is a status bit (CLI determines by resume gate on run-settled loads, reducer handling), the UI does not derive it.
      ...(run.resumable === true ? { resumable: true as const } : {}),
    });
  }
  return byToolCallId;
}

/**
 * The join table keyed by runId (for the compact clickable run-state card).
 *
 * A ResumeWorkflowRun tool row will **never** find a run by toolCallId — in the projection
 * run.toolCallId carries over the original CreateWorkflow row across a resume (the deliberate "the
 * detail page join never breaks its chain" semantics; do not change it); the resume row's display
 * payload carries a runId (≡ backgroundTaskId ≡ workId), so joining the same projection by runId is
 * enough. The identity of the sidebar run tab is runId-keyed as well, so opening it from a resume
 * row or the original create row lands on the same tab.
 */
export function buildWorkflowRunByRunId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, WorkflowRunCardSummary> {
  const byRunId = new Map<string, WorkflowRunCardSummary>();
  for (const run of runs ?? []) {
    const { settled, total } = workflowRunStepCounts(run);
    byRunId.set(run.runId, {
      runId: run.runId,
      status: run.status,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      nodesSettled: settled,
      nodesTotal: total,
      agents: run.actors.length,
      run,
      ...(run.resumable === true ? { resumable: true as const } : {}),
      // Open the associated key of the request: WorkflowRunSidePane and use it to find the CreateWorkflow initiation line (picture and script
      // are on that line). The resume row's own id cannot be used - there is no image in its display.
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
    });
  }
  return byRunId;
}

/**
 * Which `toolCallId` the request should carry when opening the sidebar run view. Not "the row that
 * was clicked", but the **CreateWorkflow row that started the run** — `WorkflowRunSidePane` uses it
 * to find the originating row in the row window (the causalityGraph and the original script hang
 * off that row's display / arguments; a resume row's display carries no graph, and filling in its
 * own id would make the detail page report "there is no workflow graph for this in the visible
 * history"). When the join summary carries the projection's `toolCallId`, always use the projection
 * value; when it is absent, fall back to the clicked row's id — the two are equal anyway when a
 * create row is clicked.
 *
 * This also blocks an overwrite hazard: `openWorkflowRunSidePane` merges an existing tab as
 * `{...existing, ...nextTab}`, so a request carrying a wrong id would corrupt a tab that was fine
 * to begin with.
 */
export function resolveWorkflowRunOpenToolCallId(
  rowToolCallId: string,
  workflowRun: WorkflowRunCardSummary | undefined,
): string {
  return workflowRun?.toolCallId ?? rowToolCallId;
}

/**
 * runId → the set of qids on which that run is currently parked. The only data source for flipping
 * a workflow notification manifest from Waiting to Answered.
 *
 * Key present ⟺ the run is in the projection (after a cold replay, pendingQuestions of a terminal
 * run have already been cleared by the reducer's run-settled); the value is a Set (possibly empty =
 * the last one has been answered), a missing key = the run is not in the projection (evicted by the
 * 8-item cap, a neutral Question).
 *
 * When pendingQuestions is empty the whole key is absent (the existing convention of the
 * workflow-runs schema), collapsing to an empty Set.
 */
export function buildWorkflowRunPendingQuestionsByRunId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const byRunId = new Map<string, ReadonlySet<string>>();
  for (const run of runs ?? []) {
    byRunId.set(run.runId, new Set((run.pendingQuestions ?? []).map((question) => question.qid)));
  }
  return byRunId;
}

/**
 * The "originating graph" hanging off a row: the graph is an attribute of the **run**, found by the
 * toolCallId that started that run, and it does not matter which kind of row it hangs on —
 * - a CreateWorkflow tool row: the `causalityGraph` of `display.kind === "create_workflow"`;
 * - a direct launch from the hub with no tool row: the graph hangs off the `workflowLaunch`
 *   metadata of the launching turn's turnHeader / userInput row (the same toolCallId, the same
 *   display schema).
 *
 * An empty graph (no ask at all and no files.* in the script) is not worth an empty track and is
 * treated as "no graph"; it is the same check as for the tool card.
 */
function workflowGraphOfRow(
  row: ConversationRow,
): { toolCallId: string; graph: WorkflowCausalityGraphData } | undefined {
  if (row.kind === "toolCall") {
    const display = row.display;
    if (display?.kind !== "create_workflow") return undefined;
    const graph = display.causalityGraph;
    return graph !== undefined && graph.steps.length > 0
      ? { toolCallId: row.toolCallId, graph }
      : undefined;
  }
  if (row.kind === "turnHeader" || row.kind === "userInput") {
    const launch = row.workflowLaunch;
    const display = launch?.display;
    if (launch === undefined || display?.kind !== "create_workflow") return undefined;
    const graph = display.causalityGraph;
    return graph !== undefined && graph.steps.length > 0
      ? { toolCallId: launch.toolCallId, graph }
      : undefined;
  }
  return undefined;
}

/**
 * The join table from originating toolCallId → graph, built in a single pass over the row window.
 * The end-of-turn run card (three sources: a CreateWorkflow row, a ResumeWorkflowRun row, a
 * directly launched turn) and the run detail / script transcript side pane all take the graph from
 * this one table — "the graph is found by the originating toolCallId" has exactly one
 * implementation. The row window is bounded, so failing to find the originating row in an old
 * conversation is normal rather than an error: there is simply no graph to hand over, the card
 * degrades to a single-line header and the side pane says "graph unavailable".
 */
export function buildWorkflowGraphByToolCallId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowCausalityGraphData> {
  const byToolCallId = new Map<string, WorkflowCausalityGraphData>();
  for (const row of rows ?? []) {
    const found = workflowGraphOfRow(row);
    // The launch wheel's turnHeader and userInput each carry a copy of the same metadata: it's a given at first sight.
    if (found !== undefined && !byToolCallId.has(found.toolCallId)) {
      byToolCallId.set(found.toolCallId, found.graph);
    }
  }
  return byToolCallId;
}

/**
 * The originating-toolCallId prefix of a run produced by a "Configure" revision (the agent mints
 * `settings-<uuid>`).
 */
const WORKFLOW_SETTINGS_TOOL_CALL_PREFIX = "settings-";

/**
 * Take the graph by originating toolCallId, plus the single rule for borrowing a graph: before the
 * settings turn of a run produced by a "Configure" revision (`settings-…`) has landed — the main
 * agent is inside one conversation turn and the settings turn has to wait for that turn to end —
 * the row window does not have its graph yet, so it borrows the predecessor's graph via
 * `resumedFrom`: by construction its script is the predecessor's. No other run ever borrows — a
 * modified script draws a different graph. The predecessor may itself be a "Configure" revision, so
 * the chain is walked upward with cycle protection.
 */
export function resolveWorkflowRunGraph(
  graphs: ReadonlyMap<string, WorkflowCausalityGraphData>,
  toolCallId: string,
  runs: readonly WorkflowRunState[] | undefined,
): WorkflowCausalityGraphData | undefined {
  const visited = new Set<string>();
  let current: string | undefined = toolCallId;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const graph = graphs.get(current);
    if (graph !== undefined) return graph;
    if (!current.startsWith(WORKFLOW_SETTINGS_TOOL_CALL_PREFIX)) return undefined;
    const settingsToolCallId: string = current;
    const run: WorkflowRunState | undefined = runs?.find(
      (candidate) => candidate.toolCallId === settingsToolCallId,
    );
    const predecessorId: string | undefined = run?.resumedFrom;
    current =
      predecessorId === undefined
        ? undefined
        : runs?.find((candidate) => candidate.runId === predecessorId)?.toolCallId;
  }
  return undefined;
}
