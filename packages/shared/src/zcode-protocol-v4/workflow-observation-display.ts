// ============================================================
// Observation workflow tools (GetWorkflowRun/ListWorkflowRuns/EvalWorkflowSnippet/
// ListSavedWorkflows / ListModels) tool card display payload
// ============================================================
// Follow the example of create-workflow-display.ts and separate it into a module (feature-level schema is not stacked into toolDisplay.ts).
//
// ⚠ with apps/zcode-cli/packages/contracts/src/tools/workflow-observation-display.ts
// toolResultDisplayPayloadSchema members must be synchronized - strict on both sides, missing the entire row/display on one side
// The verification failed and the tool card degraded into text (the create_workflow display comment recorded the same pitfall).
// The limited-length constants correspond to the CLI construction side one-to-one; display does not go through the result budget.

import { z } from "zod";

/** The reasons for `stopped`. */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
] as const;

export const WORKFLOW_RUN_OBSERVATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "errored",
  "stopped",
] as const;

const usageSchema = z
  .object({
    spentTokens: z.number(),
    nodesObserved: z.number(),
    nodesRunning: z.number(),
    nodesCompleted: z.number(),
    nodesFailed: z.number(),
  })
  .strict();

const actorSchema = z
  .object({
    siteId: z.string(),
    ordinal: z.number(),
    name: z.string().optional(),
  })
  .strict();

// Card surface loadings for situational cross-sections (Phase/Subagent/Health). with CLI side
// The corresponding members of getWorkflowRunToolResultDisplayPayloadSchema are synchronized field by field, and the enumeration set is closed and has the same vocabulary -
// Both sides are strict, if there is one less field or one more enumeration value, the entire row/display verification will fail and the tool card will degrade into text.
// Numeric bounds map one-to-one to CLI-side constants (32 stages / 64 subagents / 240 command headers / 400 digests).
const workflowRunPhaseViewSchema = z
  .object({
    name: z.string().min(1).max(128),
    state: z.enum(["done", "current", "ahead", "unfinished"]),
    rounds: z.number().int().nonnegative(),
    nodesSettled: z.number().int().nonnegative(),
    nodesRunning: z.number().int().nonnegative(),
    enteredAt: z.number().optional(),
    exitedAt: z.number().optional(),
  })
  .strict();

const workflowRunLastToolSchema = z
  .object({
    name: z.string().min(1).max(64),
    target: z.string().max(120).optional(),
    at: z.number().optional(),
  })
  .strict();

const workflowRunSubagentViewSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(128).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(128).optional(),
    instructionsHead: z.string().max(240).optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: workflowRunLastToolSchema.optional(),
    waitCause: z.enum(["slot", "backoff"]).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    waitSince: z.number().optional(),
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

const workflowRunHealthSchema = z
  .object({
    lastProgressAt: z.number().optional(),
    stalledSince: z.number().optional(),
    concurrency: z
      .object({
        effective: z.number().int().nonnegative(),
        cap: z.number().int().positive(),
        reason: z.string().max(240).optional(),
        since: z.number().optional(),
      })
      .strict()
      .optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    cachedSteps: z.number().int().nonnegative(),
    leftoverRunning: z.number().int().positive().optional(),
    pendingQuestionsKnown: z.boolean(),
  })
  .strict();

const diagnosticSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    message: z.string().min(1).max(2_048),
  })
  .strict();

const workflowRunSummaryRowSchema = z
  .object({
    runId: z.string().min(1),
    label: z.string(),
    labelSource: z.enum(["name", "script"]),
    status: z.enum(WORKFLOW_RUN_OBSERVATION_STATUSES),
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    ownedByThisSession: z.boolean(),
    possiblyInterrupted: z.boolean().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    spentTokens: z.number(),
  })
  .strict();

export const toolCallGetWorkflowRunDisplaySchema = z
  .object({
    kind: z.literal("get_workflow_run"),
    runId: z.string().min(1),
    label: z.string(),
    status: z.enum(WORKFLOW_RUN_OBSERVATION_STATUSES),
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    possiblyInterrupted: z.boolean().optional(),
    // All five parts of the situation section are optional: the transcript payload that was persisted before the situation went online does not have these keys, and this schema is
    // Strict - Setting it to required will cause the entire card to be stripped and degraded into plain text in every historical session opened after upgrading.
    // The construction side is still fully filled in every time (same comment as the CLI side).
    summary: z.string().max(400).optional(),
    generatedAt: z.number().optional(),
    usage: usageSchema,
    phases: z.array(workflowRunPhaseViewSchema).max(32).optional(),
    subagents: z.array(workflowRunSubagentViewSchema).max(64).optional(),
    health: workflowRunHealthSchema.optional(),
    actors: z.array(actorSchema).max(32),
    logTail: z
      .array(
        z
          .object({
            sequence: z.number(),
            message: z.string().max(1_024),
            // The time when the event was logged into the journal (epoch ms); the "how long ago" on the card counts against generatedAt.
            // Optional: This column did not exist on the previous load of the situation section, and is absent rather than rejected when reading the old row.
            at: z.number().optional(),
          })
          .strict(),
      )
      .max(40),
    result: z.string().max(4_000).optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict()
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallGetWorkflowRunDisplay = z.infer<typeof toolCallGetWorkflowRunDisplaySchema>;

export const toolCallListWorkflowRunsDisplaySchema = z
  .object({
    kind: z.literal("list_workflow_runs"),
    runs: z.array(workflowRunSummaryRowSchema).max(50),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallListWorkflowRunsDisplay = z.infer<typeof toolCallListWorkflowRunsDisplaySchema>;

export const toolCallEvalWorkflowSnippetDisplaySchema = z
  .object({
    kind: z.literal("eval_workflow_snippet"),
    ok: z.boolean(),
    diagnostics: z.array(diagnosticSchema).max(100),
    logs: z.array(z.string().max(1_024)).max(40),
    response: z.string().max(4_000),
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallEvalWorkflowSnippetDisplay = z.infer<
  typeof toolCallEvalWorkflowSnippetDisplaySchema
>;

export const toolCallSavedWorkflowListDisplaySchema = z
  .object({
    kind: z.literal("saved_workflow_list"),
    workflows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().max(2_048).optional(),
            whenToUse: z.string().max(2_048).optional(),
            scope: z.string(),
            path: z.string().min(1),
            argNames: z.array(z.string()).max(32),
          })
          .strict(),
      )
      .max(50),
    invalid: z
      .array(
        z
          .object({
            path: z.string().min(1),
            reason: z.string().max(1_024).optional(),
          })
          .strict(),
      )
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallSavedWorkflowListDisplay = z.infer<
  typeof toolCallSavedWorkflowListDisplaySchema
>;

// Catalog card payload for ListModels. with
// Synchronization of listModelsToolResultDisplayPayloadSchema members on the contracts side - strict on both sides, missing entire member
// When stripped, the tool card degenerates into `<models>` text. The limited length number corresponds to the CLI-side constant (100 lines / 2048 characters).
export const toolCallListModelsDisplaySchema = z
  .object({
    kind: z.literal("list_models"),
    current: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            providerLabel: z.string().max(2_048).optional(),
            reasoningLevels: z.array(z.string()),
            defaultReasoningLevel: z.string().optional(),
            contextWindow: z.number().optional(),
            disabledReason: z.string().max(2_048).optional(),
          })
          .strict(),
      )
      .max(100),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallListModelsDisplay = z.infer<typeof toolCallListModelsDisplaySchema>;

// ResumeWorkflowRun's result card payload. with contracts side
// resumeWorkflowRunToolResultDisplayPayloadSchema member synchronization - strict on both sides, missing members will be stripped whole.
// Tool cards degrade into text. The payload is intentionally minimal {runId} (see the comments on the contracts side for the reason).
export const toolCallResumeWorkflowRunDisplaySchema = z
  .object({
    kind: z.literal("resume_workflow_run"),
    runId: z.string().min(1),
  })
  .strict();
export type ToolCallResumeWorkflowRunDisplay = z.infer<
  typeof toolCallResumeWorkflowRunDisplaySchema
>;
