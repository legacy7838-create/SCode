import { z } from "zod";

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  createWorkflowToolResultDisplayDiagnosticSchema,
} from "./create-workflow.js";
import {
  GET_WORKFLOW_RUN_ROSTER_LIMITS,
  GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS,
  GetWorkflowRunActorSchema,
  GetWorkflowRunHealthSchema,
  GetWorkflowRunPhaseSchema,
  GetWorkflowRunSubagentLastToolSchema,
  GetWorkflowRunUsageSchema,
} from "./get-workflow-run.js";
import {
  ListWorkflowRunsRunSchema,
  WORKFLOW_RUN_LIFECYCLE_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "./list-workflow-runs.js";

/**
 * The display payload of the result card for the observation workflow tools (GetWorkflowRun / ListWorkflowRuns / EvalWorkflowSnippet /
 * ListSavedWorkflows / ListModels).
 *
 * The length caps correspond one-to-one with the construction side (workflow-observation-display.ts in core): display does not go through the
 * result budget, so text fields and array lengths must be bounded independently before they enter live events and persisted metadata,
 * and it is the construction side that marks them truncated when they exceed the cap.
 */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES = 40;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS = 1_024;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS = 32;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS = 4_000;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS = 2_048;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS = 50;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS = 32;
/** How many model rows a catalog card draws at once (the excess is sliced off by the construction side and marked truncated). */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS = 100;
/** The bound on the situation cross-section in the card, the same value as on the tool surface ({@link GET_WORKFLOW_RUN_ROSTER_LIMITS}). */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES = GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS =
  GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents;

/**
 * One subagent on the card. Deliberately a **flat row** rather than the nested shape of the tool output: the card draws one line,
 * and the things inside `currentAsk` (what it was dispatched for, which turn, which tool it last touched) are the second half of that line, so
 * one more level of nesting would only make the rendering side destructure and then reassemble it.
 *
 * The enum set is **word for word identical to the tool surface's and closed**: the consuming bundle rejects unknown enum values (which once invalidated
 * a whole subscription), so these two always change together.
 */
export const getWorkflowRunToolResultDisplaySubagentSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxActorNameLength).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength).optional(),
    /** The task summary and progress reading of the current ask (absent = unknown, never 0). */
    instructionsHead: z
      .string()
      .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxInstructionsHeadLength)
      .optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: GetWorkflowRunSubagentLastToolSchema.optional(),
    /** What it is waiting for (the reason text does not go on the card: the card only needs "waiting for a slot" versus "backing off", and how much longer it has to wait). */
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

export const getWorkflowRunToolResultDisplayLogEntrySchema = z
  .object({
    sequence: z.number(),
    message: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS),
    // The time when the event falls into the journal (epoch ms) has the same origin as the `logTail[].at` output by the tool; the age on the card corresponds to
    // `generatedAt` counts. Optional: Loads before the section are not available without it, synchronization with the shared side is optional.
    at: z.number().optional(),
  })
  .strict();

/**
 * A structured failure on the tool card: **only the code and the message**, deliberately not reusing the tool output's
 * `GetWorkflowRunErrorSchema`.
 *
 * The two channels have different readers: the output is read by the model, which needs `providerStop` to know what to fix; the display is
 * read by the rendering side, which strictly validates every frame with the mirror schema in packages/shared. Reuse would mean
 * display growing fields along with the output, and if the mirror fell behind the whole row would be rejected and session recovery would fail closed.
 * This definition is the opposite side of that mirror, and the two are kept in sync field by field.
 */
export const getWorkflowRunToolResultDisplayErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

/**
 * The result card payload of GetWorkflowRun. Budget / actor directly reuse the tool output schema (they are pure small numbers or already-bounded
 * small structures); errors go through the display-specific schema above; logTail and result are bounded independently on the display side --
 * the 2048 characters per entry on the output side and the artifact serialization cap belong to the model channel, and neither bound replaces the other.
 */
export const getWorkflowRunToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("get_workflow_run"),
    runId: z.string().min(1),
    label: z.string(),
    status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
    /** Present only when `status === "stopped"`. */
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    possiblyInterrupted: z.boolean().optional(),
    /**
     * The situation cross-section: the one-line summary, the snapshot moment, the phase table, the roster, the health.
     *
     * All five fields are **optional**, even though the construction side fills them in every time. The reason is the **transcripts already lying in the database**:
     * the `get_workflow_run` payloads persisted before the situation cross-section shipped have none of these keys, and the display schema is
     * strict -- making them required would mean that this card fails validation as a whole in every historical session opened after the upgrade and
     * degrades to plain text. The text fallback only applies to old rows with **no payload at all**, not to rows that have one.
     *
     * `generatedAt` is the baseline for every "how long ago" on the card: it must be computed against the snapshot moment, not against the render-time
     * `Date.now()` -- when a transcript from three days ago is reopened, the age on the card is still the age it had back then.
     */
    summary: z.string().max(GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS).optional(),
    generatedAt: z.number().optional(),
    usage: GetWorkflowRunUsageSchema,
    phases: z
      .array(GetWorkflowRunPhaseSchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES)
      .optional(),
    subagents: z
      .array(getWorkflowRunToolResultDisplaySubagentSchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS)
      .optional(),
    health: GetWorkflowRunHealthSchema.optional(),
    actors: z.array(GetWorkflowRunActorSchema).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS),
    logTail: z
      .array(getWorkflowRunToolResultDisplayLogEntrySchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES),
    result: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS).optional(),
    error: getWorkflowRunToolResultDisplayErrorSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/** The result card payload of ListWorkflowRuns: the run rows directly reuse the output schema (limit is already capped at 50). */
export const listWorkflowRunsToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("list_workflow_runs"),
    runs: z.array(ListWorkflowRunsRunSchema).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * The result card payload of EvalWorkflowSnippet. Diagnostics reuse create_workflow's display diagnostic schema
 * (the same TS diagnostic shape, the same length bound); logs take the tail and response is bounded independently.
 */
export const evalWorkflowSnippetToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("eval_workflow_snippet"),
    ok: z.boolean(),
    diagnostics: z
      .array(createWorkflowToolResultDisplayDiagnosticSchema)
      .max(CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS),
    logs: z
      .array(z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS))
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES),
    response: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS),
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * The result card payload of ListSavedWorkflows. Root cause: on the v4 wire output.text is formatModelContent's
 * XML-style projection, so the JSON probe on the UI side never hits (it falls into the raw JSON fallback card) -- a structured list must go through
 * this display channel. description / whenToUse are bounded independently; args keeps only the names (the declaration details belong to the confirmation dialog).
 */
export const savedWorkflowListToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("saved_workflow_list"),
    workflows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            whenToUse: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            scope: z.string(),
            path: z.string().min(1),
            argNames: z.array(z.string()).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS),
          })
          .strict(),
      )
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS),
    invalid: z
      .array(
        z
          .object({
            path: z.string().min(1),
            reason: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS).optional(),
          })
          .strict(),
      )
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * The result card payload of ListModels. The root cause is the same one as for saved_workflow_list: on the v4 wire output.text is
 * formatModelContent's `<models>` projection, so the JSON probe on the UI side never hits -- a structured catalog can only go through this channel.
 *
 * The fields are the tool output itself (all three things the reading side has to draw -- "what exists, where it comes from, which one is current" -- are in there),
 * plus one truncated. providerLabel / disabledReason are free text coming from the registry, and display does not go through the result
 * budget, so they must be bounded independently here; the rest are short ids and small numbers, passed through as-is.
 */
export const listModelsToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("list_models"),
    /** The session's model right now (canonical form); absent when not a single catalog entry matches. */
    current: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            providerLabel: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            reasoningLevels: z.array(z.string()),
            defaultReasoningLevel: z.string().optional(),
            contextWindow: z.number().optional(),
            disabledReason: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
          })
          .strict(),
      )
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS),
    truncated: z.boolean().optional(),
  })
  .strict();

export type GetWorkflowRunToolResultDisplayPayload = z.infer<
  typeof getWorkflowRunToolResultDisplayPayloadSchema
>;
export type ListWorkflowRunsToolResultDisplayPayload = z.infer<
  typeof listWorkflowRunsToolResultDisplayPayloadSchema
>;
export type EvalWorkflowSnippetToolResultDisplayPayload = z.infer<
  typeof evalWorkflowSnippetToolResultDisplayPayloadSchema
>;
export type SavedWorkflowListToolResultDisplayPayload = z.infer<
  typeof savedWorkflowListToolResultDisplayPayloadSchema
>;
export type ListModelsToolResultDisplayPayload = z.infer<
  typeof listModelsToolResultDisplayPayloadSchema
>;

/**
 * The result card payload of ResumeWorkflowRun.
 *
 * Deliberately the minimal `{runId}`: the information a resume card has to convey is exactly "which run continues in the background" -- the response
 * guidance text is the model channel's wording, while the UI has its own localized vocabulary, and extra fields only add wire bytes with no consumer. The construction side
 * safeParses the output schema and returns undefined on failure (falling back to text), sharing the same skeleton as the four constructors above.
 */
export const resumeWorkflowRunToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("resume_workflow_run"),
    runId: z.string().min(1),
  })
  .strict();
export type ResumeWorkflowRunToolResultDisplayPayload = z.infer<
  typeof resumeWorkflowRunToolResultDisplayPayloadSchema
>;
