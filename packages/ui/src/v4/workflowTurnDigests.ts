import type {
  WorkflowLaunchMeta,
  WorkflowSettingsAmendMeta,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { readWorkflowName } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";

/**
 * Resolution of the run cards at the end of a turn: which **sources** in this turn named a given
 * run. A pure function, cut along the same seam as `resolveCronAutomationTurnCards`.
 *
 * Three sources, one rule — every source that names a runId gets a card:
 * - a direct launch turn (`unit.workflowLaunch`): the metadata carries the runId / toolCallId /
 *   name itself; it is the only presentation for that turn (the user row is invisible);
 * - a CreateWorkflow row: joined by toolCallId (the projected `run.toolCallId` is the originating
 *   row); the row itself names no runId, so a row that joins no run (rejected / fails to compile)
 *   gets no card;
 * - a ResumeWorkflowRun row: the display payload carries the runId (the projected toolCallId is
 *   carried over from the originating row across a resume, so it can never be found by toolCallId).
 *
 * The graph is an attribute of the run: it is looked up in the host-built graph table by the run's
 * **originating** toolCallId, without asking which row the card hangs on — a resume row therefore
 * shares one graph with the originating row. A source that cannot join a live projection (evicted /
 * cold-recovered) still gets a card, with `summary` absent and the card degraded to a neutral
 * single row. Within one turn, the same run yields only one card (the first source seen).
 *
 * One exception: an **in-place settings turn** (`rowOnly`) names a run yet neither launched nor
 * resumed it — it only changed that run's concurrency limit. The card for that run already appeared
 * in the turn that launched it, so this source only produces the row described above.
 */
export interface WorkflowTurnDigest {
  key: string;
  /**
   * The id of the source this card hangs on (converted to the originating row id via
   * `resolveWorkflowRunOpenToolCallId` when the side panel is opened).
   */
  toolCallId: string;
  runId: string;
  /** The script `name`; when absent, the renderer falls back to a localized name. */
  name: string | undefined;
  graph: WorkflowCausalityGraphData | undefined;
  /**
   * The join summary from the live projection; absent = the run is not in the projection, so the
   * card degrades to a neutral single row ("Finished").
   */
  summary: WorkflowRunCardSummary | undefined;
  /**
   * Settings turn: this card's run is a "configuration" revised from another run — which one, and
   * what changed. When present, an extra row "Settings changed · …" appears above the card; `at` is
   * that turn's timestamp.
   */
  settings?: { amend: WorkflowSettingsAmendMeta; at?: number };
  /**
   * **Produces that row only, no card**: an in-place settings turn (it only changes the concurrency
   * limit, the run is still going, and the `amend` carries no `predecessorRunId`). The run it names
   * was not replaced and its identity did not change, and the card already appeared in the turn
   * that launched it — drawing another one here would read as a second run. Always present together
   * with `settings`.
   */
  rowOnly?: true;
}

interface WorkflowTurnDigestSource {
  workflowLaunch?: WorkflowLaunchMeta;
  assistantWorkRows: readonly AssistantWorkRow[];
  /** When this turn started (the timestamp of that settings row). */
  startedAt?: number;
}

interface WorkflowTurnDigestJoin {
  byToolCallId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  byRunId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  graphByToolCallId?: ReadonlyMap<string, WorkflowCausalityGraphData>;
}

export function resolveWorkflowTurnDigests(
  unit: WorkflowTurnDigestSource,
  join: WorkflowTurnDigestJoin,
): WorkflowTurnDigest[] {
  const digests: WorkflowTurnDigest[] = [];
  const seen = new Set<string>();
  const graphOf = (originToolCallId: string | undefined) =>
    originToolCallId === undefined ? undefined : join.graphByToolCallId?.get(originToolCallId);

  const launch = unit.workflowLaunch;
  if (launch !== undefined) {
    // Locally effective setting wheel: `amend` without predecessorRunId (absence means "there is no predecessor, the one who changes is himself",
    // workflow-row-meta.ts). It's the only source that names run but doesn't "start/resume it", so
    // **Does not count** the card playing quota in this round - the source that actually initiated this run in the same round will play its card as usual.
    const rowOnly = launch.amend !== undefined && launch.amend.predecessorRunId === undefined;
    if (!rowOnly) seen.add(launch.runId);
    digests.push({
      graph: graphOf(launch.toolCallId),
      key: `launch:${launch.toolCallId}`,
      name: launch.name,
      runId: launch.runId,
      summary: join.byRunId?.get(launch.runId),
      toolCallId: launch.toolCallId,
      ...(rowOnly ? { rowOnly: true as const } : {}),
      ...(launch.amend === undefined
        ? {}
        : {
            settings: {
              amend: launch.amend,
              ...(unit.startedAt === undefined ? {} : { at: unit.startedAt }),
            },
          }),
    });
  }

  for (const row of unit.assistantWorkRows) {
    if (row.kind !== "toolCall") continue;
    const created = join.byToolCallId?.get(row.toolCallId);
    if (created !== undefined) {
      if (seen.has(created.runId)) continue;
      seen.add(created.runId);
      digests.push({
        graph: graphOf(row.toolCallId),
        key: `${row.rowId}:${row.toolCallId}`,
        name: readWorkflowName(row.input),
        runId: created.runId,
        summary: created,
        toolCallId: row.toolCallId,
      });
      continue;
    }
    if (row.display?.kind !== "resume_workflow_run") continue;
    const runId = row.display.runId;
    if (seen.has(runId)) continue;
    seen.add(runId);
    const resumed = join.byRunId?.get(runId);
    digests.push({
      // The initiating row id is only known when connected to the projection; there is no picture to be found for resume cards that are not in the projection.
      graph: graphOf(resumed?.toolCallId),
      key: `${row.rowId}:${row.toolCallId}`,
      name: undefined,
      runId,
      summary: resumed,
      toolCallId: row.toolCallId,
    });
  }
  return digests;
}
