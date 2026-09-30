// ============================================================
// ListWorkflowRuns Tool - Enumerate workflow runs by project (cwd) with cross-session history
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_WORKFLOW_RUNS_TOOL_NAME = "ListWorkflowRuns";

/**
 * The lifecycle vocabulary of a run. The literals match the set of `DynamicWorkflowRunLifecycleStatus` (port side), but they are
 * redeclared here as a zod enum: a schema is the **runtime** validation surface and a type-only union type is of no use here. If
 * the two ever diverge, the symptom is a legal status handed down by the model being rejected by the tool — hence the port-side
 * comment points back here.
 */
export const WORKFLOW_RUN_LIFECYCLE_STATUSES = [
  "completed",
  "errored",
  "pending",
  "running",
  "stopped",
] as const;

/** Why a run is `stopped` (the zod face of the port's `DynamicWorkflowRunStopReason`). */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
] as const;

/** The bounds and default of limit. 50 is the ceiling at which, given that runs are low-cardinality entities, cursor pagination is unnecessary. */
export const LIST_WORKFLOW_RUNS_MIN_LIMIT = 1;
export const LIST_WORKFLOW_RUNS_MAX_LIMIT = 50;
export const LIST_WORKFLOW_RUNS_DEFAULT_LIMIT = 20;

export const ListWorkflowRunsInputSchema = z
  .object({
    limit: clampedLimit().describe(
      `Maximum number of runs to return (${LIST_WORKFLOW_RUNS_MIN_LIMIT}-${LIST_WORKFLOW_RUNS_MAX_LIMIT}, default ${LIST_WORKFLOW_RUNS_DEFAULT_LIMIT}). Most recently updated runs come first.`,
    ),
    statuses: z
      .array(z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES))
      .optional()
      .describe(
        "Optional status filter. Omit to see every run in this project. Pass [\"running\", \"pending\"] to see only what is still in flight.",
      ),
  })
  // Deliberately no cwd input: the tool always checks the working directory of the current session (the model does not have permission to scan libraries across projects, which is also
  // `sideEffectScope: "none"` is established). .strict() makes "passing one more cwd" a visible error.
  .strict();

export type ListWorkflowRunsInput = z.infer<typeof ListWorkflowRunsInputSchema>;

export const ListWorkflowRunsInputJsonSchema = toToolJsonSchema(ListWorkflowRunsInputSchema);

/**
 * The **shared slice** of list and detail (the schema face of the port's `DynamicWorkflowRunSummary`).
 *
 * Why one shared field bag rather than two independently evolving field tables: the same run showing a different name or
 * attribution in the list than in the detail is the kind of inconsistency that is hardest for tests to catch and that most
 * directly damages trust. The bag lives on the **list** side, because the list is the shallowest projection of this slice; the
 * detail extends it.
 */
export const WorkflowRunSummarySchema = z.object({
  runId: z.string().min(1),
  /** The fully cooked display label (name → the first line of the script → runId, derived on the service side). */
  label: z.string(),
  /** `"name"` = the name the user gave it; `"script"` = derived from the script on read (with runId as the fallback). */
  labelSource: z.enum(["name", "script"]),
  status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
  /** Only present when `status === "stopped"`. */
  stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
  /** Which run this run was amended from (`dwf_run.resumed_from`); absent when it is not an amendment. */
  resumedFrom: z.string().min(1).optional(),
  /** Which amendment stopped and superseded this run (the settlement bag of `stopped(superseded)`); absent when it was never superseded. */
  supersededBy: z.string().min(1).optional(),
  ownedByThisSession: z.boolean(),
  /** The "this session cannot prove it is still alive" mark; only present when true. Never a status rewrite. */
  possiblyInterrupted: z.boolean().optional(),
  /** epoch ms (the journal's time_created / time_updated). */
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ListWorkflowRunsRunSchema = WorkflowRunSummarySchema.extend({
  spentTokens: z.number(),
}).strict();

export type ListWorkflowRunsRun = z.infer<typeof ListWorkflowRunsRunSchema>;

export const ListWorkflowRunsOutputSchema = z
  .object({
    runs: z.array(ListWorkflowRunsRunSchema),
    /** More runs exist that did not make it into this page (detected by fetching limit+1). Only present when true. */
    truncated: z.boolean().optional(),
  })
  .strict();

export type ListWorkflowRunsOutput = z.infer<typeof ListWorkflowRunsOutputSchema>;

export const ListWorkflowRunsOutputJsonSchema = toToolJsonSchema(ListWorkflowRunsOutputSchema);

/**
 * limit is **clamped** rather than rejected: a read-only enumeration has no reason to turn into a tool error the model has to
 * recover from because of one out-of-range number; `limit` defaults to 20 and is clamped to [1, 50].
 *
 * The clamping goes in preprocess rather than in the handler, aiming at two things holding at once: the JSON schema still
 * projects from the inner schema (`type: integer` plus minimum/maximum/default, so the model can see the bounds), while
 * out-of-range runtime values get folded into the bounds. A `Math.min/max` written in the handler would be rejected ahead of time
 * by this schema's own min/max — dead code that never executes. Routing semantic coercion through preprocess is the existing
 * convention (task-output's semanticBoolean, bash's timeout).
 */
function clampedLimit(): z.ZodEffects<z.ZodDefault<z.ZodNumber>, number, unknown> {
  return z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(
      LIST_WORKFLOW_RUNS_MAX_LIMIT,
      Math.max(LIST_WORKFLOW_RUNS_MIN_LIMIT, Math.trunc(value)),
    );
  }, z.number().int().min(LIST_WORKFLOW_RUNS_MIN_LIMIT).max(LIST_WORKFLOW_RUNS_MAX_LIMIT).default(LIST_WORKFLOW_RUNS_DEFAULT_LIMIT));
}
