// ============================================================
// ResumeWorkflowRun Tool - Resume a canceled / Interrupted workflow run
// ============================================================
// See port
// Contract for `DynamicWorkflowRunPort.resume` (interfaces/dynamic-workflow-run.port.ts).
//
// This is the third entry point for workflow run recovery (after the UI details page button and CLI /dwf resume). The execution base zero
// Change: The same `port.resume(runId)`, the same runId to continue running in place (the script is nailed by scriptHash, and the actual participation
// caps follows journal records, completed nodes are purely replayed, and unfinished nodes are redistributed).
//
// The output is only in the form of success: if it fails, go to ToolHandlerFailure (core side) and do not enter this schema - so all fields are required.
// None optional. `status: "backgrounded"` tells the executor's automatic tracking to claim it according to the output shape, go
// CreateWorkflow same trackBackgroundTask.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RESUME_WORKFLOW_RUN_TOOL_NAME = "ResumeWorkflowRun";

export const ResumeWorkflowRunInputSchema = z
  .object({
    // snake_case looks at the run_id of GetWorkflowRun (which in turn looks at the task_id of TaskOutput): In the eyes of the model, this
    // The three keys are run/task identifiers of the same family. The recoverable set (cancelled ∪ failed+Interrupted) is written in
    // In describe, the authority is determined by the port.resume server - here it is just routing guidance.
    run_id: z
      .string()
      .min(1)
      .describe(
        "The workflow run ID to resume — a cancelled run or one that failed with code `Interrupted`, as seen with GetWorkflowRun or ListWorkflowRuns",
      ),
  })
  .strict();

export type ResumeWorkflowRunInput = z.infer<typeof ResumeWorkflowRunInputSchema>;

export const ResumeWorkflowRunInputJsonSchema = toToolJsonSchema(ResumeWorkflowRunInputSchema);

/**
 * Success output: the run has been resumed and is flying in the background.
 *
 * - `backgroundTaskId ≡ runId` (the same identity as in CreateWorkflow's backgrounded output), a
 *   single key shared by the cancellation, TaskOutput query and terminal notification paths.
 * - `status` only accepts the literal `"backgrounded"`: the executor's background tracking triggers on
 *   this shape, and one more value means one more lifecycle branch to explain.
 * - `response` is guidance text for the model (do not poll, wait for the notification), constructed by
 *   the core handler — it is prose, not a contract field, and the schema only guarantees its presence.
 */
export const ResumeWorkflowRunOutputSchema = z
  .object({
    ok: z.literal(true),
    runId: z.string().min(1),
    response: z.string(),
    status: z.literal("backgrounded"),
    backgroundTaskId: z.string().min(1),
  })
  .strict();

export type ResumeWorkflowRunOutput = z.infer<typeof ResumeWorkflowRunOutputSchema>;

export const ResumeWorkflowRunOutputJsonSchema = toToolJsonSchema(ResumeWorkflowRunOutputSchema);
