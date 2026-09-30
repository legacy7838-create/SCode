// ============================================================
// The line in the transliteration that takes effect locally
// ============================================================
// Only the upper limit of concurrency is changed, and when the run is in flight, `AmendWorkflow` does not compile or create a new run, but only changes the upper limit of that run. So
// There is no card to draw in this row: the run card is in the round in which it is started, and drawing another card will read it as a second run; while the original static card
// Compilation verification results are displayed, making a concurrency setting change appear to recompile and start the workflow.
//
// What is drawn is the setting line (`WorkflowSettingsChangeRow`) left by the GUI "Configuration", which is word for word - who does the same thing?
// Initiation should not be read in two ways. The only difference is that it is clickable: the tool line is the landing point of this step of the model, and the user returns to that run from here.

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowSettingsChangeRow } from "@/components/workflow-timeline/WorkflowSettingsChangeRow.js";

/**
 * Enter the number in the parameter → set the metadata of the wheel. The two are originally two notations for the same thing (GUI wheel metadata, tool wheel metadata
 * Input parameters), after mapping to the same shape, there is only one implementation left.
 *
 * `requested` is the unclamped number emitted by the model (readWorkflowRetuneCall), and the CLI will clamp it into
 * `[1, ceiling]`. So here the ceiling is given to the wording rules: `workflowSettingsChangeSegments` Right
 * `to >= ceiling` and the absence of `to` are treated equally, and both mean "the upper limit is restored to the local default" - this is the truth after clamping
 * (Clamped to the ceiling = this run has no bounds of its own). Therefore, a number greater than the upper limit of the local machine will never appear on the line.
 * When the ceiling is unknown (that run has been eliminated from the projection, or the old CLI has not sent it), the request value can only be read. At this time, it can only
 * Too big, not too small - and "at most n" is an upper bound statement and will not mislead users in the direction of "running more than actual".
 *
 * `from` is not filled in: I don’t know what the value of the input parameter was before it was changed, and the wording of this line only reads `to`. `predecessorRunId` is also left blank——
 * There is no predecessor (workflow-row-meta.ts) for in-place effect.
 */
function retuneAsAmendMeta(
  requested: number | null,
  ceiling: number | undefined,
): WorkflowSettingsAmendMeta {
  return {
    maxConcurrency: requested === null ? {} : { to: requested },
    ...(ceiling === undefined ? {} : { ceiling }),
  };
}

export function WorkflowRetuneRow({
  ceiling,
  onOpen,
  requested,
  runId,
}: {
  /** Native concurrency ceiling (the projected reading for that run); absent when unknown. */
  ceiling?: number;
  /** Open the details page of this run; this line is only recorded when the host does not provide it (read-only display or the function is turned off). */
  onOpen?: () => void;
  requested: number | null;
  runId: string;
}) {
  const row = <WorkflowSettingsChangeRow amend={retuneAsAmendMeta(requested, ceiling)} />;
  if (onOpen === undefined) {
    return (
      <div data-testid="workflow-retune-row" data-workflow-retune-run-id={runId}>
        {row}
      </div>
    );
  }
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer rounded-md px-1 text-left transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid="workflow-retune-row"
      data-workflow-retune-run-id={runId}
      onClick={onOpen}
      type="button"
    >
      {row}
    </button>
  );
}
