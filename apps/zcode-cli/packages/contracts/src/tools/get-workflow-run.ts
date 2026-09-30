// ============================================================
// GetWorkflowRun Tool - Adaptation details for a single workflow run (Progress Summary/Product/Failure)
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  GET_WORKFLOW_RUN_ROSTER_LIMITS,
  GetWorkflowRunHealthSchema,
  GetWorkflowRunPhaseSchema,
  GetWorkflowRunSubagentSchema,
} from "./get-workflow-run-roster.js";
import { WorkflowRunSummarySchema } from "./list-workflow-runs.js";

// The schema of the situation section (stage / subagent / health) lives in get-workflow-run-roster.ts, and is exported here as it is.
// to keep the import path of `@zcode/contracts` unchanged.
export * from "./get-workflow-run-roster.js";

export const GET_WORKFLOW_RUN_TOOL_NAME = "GetWorkflowRun";

export const GetWorkflowRunInputSchema = z
  .object({
    // snake_case follows the `task_id` of TaskOutput: in the eyes of the model, these two keys are run/task identifiers of the same family.
    // Forking the naming style will just make it guess between the two tools.
    run_id: z
      .string()
      .min(1)
      .describe("The workflow run ID to inspect (as returned by CreateWorkflow or ListWorkflowRuns)"),
  })
  .strict();

export type GetWorkflowRunInput = z.infer<typeof GetWorkflowRunInputSchema>;

export const GetWorkflowRunInputJsonSchema = toToolJsonSchema(GetWorkflowRunInputSchema);

/**
 * A run's progress and usage (an observation surface with no upper bound at all). `nodesObserved` is the **row count of
 * nodes already persisted** (the sum of the three states) and never pretends to be a "total step count": a dynamic
 * workflow has no static total, and `queued` exists only in the event phase and is never persisted.
 */
export const GetWorkflowRunUsageSchema = z
  .object({
    spentTokens: z.number(),
    nodesObserved: z.number(),
    nodesRunning: z.number(),
    nodesCompleted: z.number(),
    nodesFailed: z.number(),
  })
  .strict();

/** One actor site instance. `persona` is deliberately absent: an entire system prompt is a naturally unbounded field. */
export const GetWorkflowRunActorSchema = z
  .object({
    siteId: z.string(),
    ordinal: z.number(),
    name: z.string().optional(),
  })
  .strict();

/**
 * One `log()` narrative line. `at` is the moment the event landed in the journal (`dwf_event.time_created`), and the
 * model-facing side renders "how long ago" from it; on an old journal without that column it is absent, and such a
 * line then carries no age prefix — **never** fall back to the read-time `Date.now()`, which would label a whole
 * narrative from a week ago as "just now".
 */
export const GetWorkflowRunLogEntrySchema = z
  .object({
    sequence: z.number(),
    message: z.string(),
    at: z.number().optional(),
  })
  .strict();

/**
 * An escalation question parked right now, waiting for the main agent to answer.
 *
 * This is the **query fallback** after an escalation notification is dropped, and also the only discovery surface on
 * the model side: `ResolveWorkflowQuestion` recognizes only `qid`, and the notification has two known drop paths
 * (stale branch generation / shutdown). `askedAt` lets the model see "how long this question has already been
 * waiting" — there is no timeout standing in for it.
 */
export const GetWorkflowRunPendingQuestionSchema = z
  .object({
    qid: z.string(),
    /** The actor that asked, in `site@ordinal` form. */
    actor: z.string(),
    /** The human-readable name of that actor; absent for anonymous actors (the read side decides for itself how to render "unnamed"). */
    actorName: z.string().optional(),
    question: z.string(),
    context: z.string().optional(),
    /** The moment of asking (epoch ms, the same ruler as createdAt / updatedAt). */
    askedAt: z.number(),
  })
  .strict();

/**
 * One **user-facing artifact**: something the script published for the user through `artifact.*`,
 * sitting in front of the user right now as a card.
 *
 * ⚠ Terminology: this is a **different thing** from the `result` on this tool's output (the script's top-level return value,
 * which the engine also calls an artifact). The model-side use differs too: `result` is content to be
 * relayed, while an artifact is something to be **referenced** by
 * title.
 *
 * Deliberately **without a `uri`**: the model cannot read the tool-artifact store. The fields take the **newest
 * version's** values (`version` is the version number; older versions' metadata lives on the UI side panel).
 */
export const GetWorkflowRunArtifactSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
    /** The card title; absent when the script gave none (the facade's default title is the id). */
    title: z.string().optional(),
    /** The newest version number. */
    version: z.number(),
    /** The MIME of a content artifact; absent for a preset dashboard. */
    contentType: z.string().optional(),
    /** The byte size of the newest version of a content artifact; absent for a preset dashboard. */
    bytes: z.number().optional(),
    /** The workspace origin of a content artifact (the bytes are already copied into the store; this only records "where it originally was"). */
    sourcePath: z.string().optional(),
    /** How many `report` labels a preset dashboard received; always 0 for a content artifact. */
    itemCount: z.number(),
    /** The run's deliverable (at most one), ordered first in the list. */
    primary: z.literal(true).optional(),
  })
  .strict();

/** A structured failure. `code` is the stable discriminator — the model must be able to tell "the process died" from "the script genuinely failed". */
export const GetWorkflowRunErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    /** Present only when `code === "ProviderStop"`. */
    providerStop: z
      .object({
        kind: z.enum([
          "auth",
          "not_configured",
          "model_unavailable",
          "invalid_request",
          "quota",
          "other",
        ]),
        reason: z.string(),
        providerId: z.string().optional(),
        providerLabel: z.string().optional(),
        modelId: z.string().optional(),
        providerCode: z.string().optional(),
        subagent: z.string().optional(),
        subagentName: z.string().optional(),
        phase: z.string().optional(),
        rawMessage: z.string().optional(),
        resetAt: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The character upper bound of `summary`. The budget of a one-liner: what exceeds it is not a summary but yet another report. */
export const GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS = 400;

export const GetWorkflowRunOutputSchema = WorkflowRunSummarySchema.extend({
  /**
   * One sentence about the situation: state + how long it has been running / how long since it finished + phase position + step count
   * with an in-flight breakdown + pending questions + last progress. The handler assembles it **deterministically** from
   * the structured fields below (no model is involved), so the same snapshot always yields the same sentence; the
   * upper bound is {@link GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS}, and past it the tail is dropped whole sentence by whole sentence.
   */
  summary: z.string().max(GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS),
  /**
   * The moment this snapshot was read (epoch ms). Every "how long ago" on the model side is computed against
   * it — one ruler per output, otherwise two ages are not comparable. `formatModelContent` takes a single argument
   * (core's ToolEntry contract), so the clock can only be read inside the handler, with the result carried over
   * alongside the output; the formatter is therefore a pure `(output) => text` function, pinnable verbatim.
   */
  generatedAt: z.number(),
  usage: GetWorkflowRunUsageSchema,
  /**
   * This run's own concurrency ceiling (the number of subagents in flight at once), **present only when it is below
   * the current ceiling**: a run running at the ceiling has nothing to say (same rule as pendingQuestions' "absent
   * when none"). This is the value AmendWorkflow inherits when it omits `max_concurrency` — so the
   * model knows what a revision will inherit.
   */
  maxConcurrency: z.number().int().positive().optional(),
  /**
   * Which model this run's subagents run on, in canonical form `providerId/modelId[$reasoningLevel]`, **present
   * only when it was set**: a run following the session model has nothing to say (same rule as `maxConcurrency`'s
   * "absent when none"). This is the value AmendWorkflow inherits when it
   * omits `subagent_model`.
   */
  subagentModel: z.string().optional(),
  /**
   * This run's script file, **already written the way the model side should see it** (a workspace-relative path when it sits under
   * the session working directory, an absolute path otherwise). **Present only when this run
   * recorded a file** (same rule as `subagentModel`'s "absent when none"): a project whose draft could not be
   * written, and a run started before this feature, have nothing to say. When present it is exactly the `path`
   * the next `AmendWorkflow` should pass.
   */
  scriptPath: z.string().optional(),
  actors: z.array(GetWorkflowRunActorSchema),
  /** The tail of the `log()` events, in chronological order (ascending sequence). No log events means an empty array. */
  logTail: z.array(GetWorkflowRunLogEntrySchema),
  /**
   * The phase table: the declared phases in declaration order, followed by those "entered but never declared".
   * **When the script declares no phases and none was ever entered, the whole field is absent** — such a
   * run has no notion of phases, and an empty array would read as "the phase table is empty".
   */
  phases: z.array(GetWorkflowRunPhaseSchema).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases).optional(),
  /**
   * The subagent roster, in minting order. **Always present**; a run with not a single actor is an empty array: unlike
   * `phases`, "how many subagents does this run have" always has an answer, and 0 is that answer.
   *
   * Deliberately not merged with the parallel `actors`: that is a constant identity table, whereas every entry here is
   * a read-time snapshot.
   */
  subagents: z.array(GetWorkflowRunSubagentSchema).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents),
  /** Whether the roster was cut by this bound. Absent otherwise (same as the `truncated` family: never report `false`). */
  subagentsTruncated: z.literal(true).optional(),
  /** Whether the run as a whole is still moving. Always present. */
  health: GetWorkflowRunHealthSchema,
  /**
   * The script's top-level return value, **already serialized to text** (a string as-is, everything else as pretty JSON). Only a
   * completed run has it; an `undefined` result means the whole field
   * is absent.
   *
   * Why a string is accepted instead of the raw value: the model-facing serialization has exactly one implementation in
   * core (`serializeWorkflowArtifact`, shared with the completion notification and TaskOutput). Letting the raw value
   * through would allow "one and the same run's artifact to look different in the notification and in this tool".
   */
  result: z.string().optional(),
  /** errored is always present; stopped is present only for provider / interrupted. The code is passed through as-is, never collapsed. */
  error: GetWorkflowRunErrorSchema.optional(),
  /**
   * The escalation questions still owing an answer at this moment, in asking order. **With zero of them the whole
   * field is absent** (same rule as the port projection, no empty array): the read side uses that to make the
   * entire pending section disappear instead of rendering an empty one.
   */
  pendingQuestions: z.array(GetWorkflowRunPendingQuestionSchema).optional(),
  /**
   * The user-facing artifacts this run has published, in first-publication order, **attached in any state** (a still-running
   * run may already have delivered its first image). **With no artifacts the whole field is absent**, same rule as
   * pendingQuestions. Bounded at 32
   * (= `ARTIFACT_CAPS.maxArtifactsPerRun`, the largest number of ids one run can have).
   */
  artifacts: z.array(GetWorkflowRunArtifactSchema).optional(),
}).strict();

export type GetWorkflowRunOutput = z.infer<typeof GetWorkflowRunOutputSchema>;

export const GetWorkflowRunOutputJsonSchema = toToolJsonSchema(GetWorkflowRunOutputSchema);
