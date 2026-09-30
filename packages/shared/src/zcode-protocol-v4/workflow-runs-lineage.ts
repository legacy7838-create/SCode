// The reading of the lineage field: reducer from the progress load
// Two narrow readers used when handling `resumedFrom` / `supersededBy` and stop reasons. It is a separate file because the reducer itself has been
// 400 line limit for oxlint.

import { WORKFLOW_RUN_STOP_REASONS } from "./workflow-observation-display.js";
import type { WorkflowRunState } from "./workflow-runs.js";

/** The run id field on a payload: only a non-empty string counts as present. */
export function readRunIdField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The stop reason on a payload: anything outside the whitelist (a new word an old CLI does not know, or a corrupted payload) reads as absent rather than dropping the whole frame. */
export function readWorkflowRunStopReason(value: unknown): WorkflowRunState["stopReason"] {
  return typeof value === "string" &&
    (WORKFLOW_RUN_STOP_REASONS as readonly string[]).includes(value)
    ? (value as WorkflowRunState["stopReason"])
    : undefined;
}
