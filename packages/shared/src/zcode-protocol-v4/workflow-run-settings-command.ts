// ============================================================
// amendWorkflowRunSettings: Change two settings of a run from the GUI
// ============================================================
// Removed from command.ts (max-lines gate): payload, accepted result and rejected vocabulary list belong to the same command.
// Bootstrap casts fault code and UI anti-checking copywriting, and both sides share this vocabulary to avoid drift.

import { z } from "zod";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";

/**
 * Command payload. The two settings obey the same three-state rule as the tool does: omitted =
 * keep the current value, `null` = go back to the default (session model / local ceiling), a
 * value = set it. The GUI only sends the items the user actually changed. Deliberately carries no
 * baseRevision: same family as cancelBackgroundWork / resumeWorkflowRun (the workflowRuns surface
 * is revision-free).
 */
export const amendWorkflowRunSettingsPayloadSchema = z.object({
  /** ≡ runId — the same identity equation as cancel and resume. */
  workId: z.string(),
  /** Canonical string `providerId/modelId[$level]`; `null` = subagents go back to the session model. */
  subagentModel: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength)
    .nullable()
    .optional(),
  /** Upper bound on subagents running at once; `null` = remove this run's own bound (back to the local ceiling). The agent side clamps to `[1, ceiling]`. */
  maxConcurrency: z.number().int().min(1).nullable().optional(),
});
export type AmendWorkflowRunSettingsPayload = z.infer<typeof amendWorkflowRunSettingsPayloadSchema>;

/**
 * The result of an accepted ACK. `runId` / `toolCallId` refer to the **new** run (toolCallId =
 * `settings-<uuid>`, which links the settings round's run card to the detail page);
 * `supersededRunId` is present only when the old run was still in flight and was stopped by this
 * adjustment.
 */
export const amendWorkflowRunSettingsResultSchema = z.object({
  type: z.literal("amendWorkflowRunSettings"),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  supersededRunId: z.string().min(1).optional(),
});

/**
 * The rejection vocabulary. Every rejection happens before anything is stopped or created:
 * not_found / not_configurable / unchanged / script_missing / model_unavailable / compile_failed
 * are the command's own checks, missing_boundaries is the port pre-check, and start_failed is a
 * missing port or a throw.
 */
export const workflowRunSettingsRejectionReasonSchema = z.enum([
  "not_found",
  "not_configurable",
  "unchanged",
  "script_missing",
  "model_unavailable",
  "compile_failed",
  "missing_boundaries",
  "start_failed",
]);
export type WorkflowRunSettingsRejectionReason = z.infer<
  typeof workflowRunSettingsRejectionReasonSchema
>;

/** The full fault code = prefix + reason; same family as workflowRunResumeRejected. */
export const WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunSettingsRejected." as const;
