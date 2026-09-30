// ============================================================
// GetWorkflowRun's **schema cross-section** schema: Stage/Subagent/Health
// ============================================================
// Detached from get-workflow-run.ts, the reason is the same as dynamic-workflow-run-roster.port.ts on the port side:
// That document is close to oxlint's max-lines limit, and these three sets of schemas are self-contained. The public side remains unchanged——
// get-workflow-run.ts exports each name here in place, and the import path of `@zcode/contracts` remains unchanged.
//
// Here is a **field-by-field mirror** of the port type (DynamicWorkflowRunPhaseView/…SubagentView/…Health),
// There is only one more world of zod. Both sides must be synchronized: the port is the fact of the read side, here is the contract of the model side, missing a field means
// A discovered fact cannot reach the model.

import { z } from "zod";

/**
 * The bounds of the situation snapshot. Every one of them shares the value of an already existing bound rather than introducing a new set:
 * the phase count and phase name follow the reducer's `WORKFLOW_RUNS_LIMITS.maxPhases` / `maxPhaseNameLength`,
 * and the instruction head plus the tool name/target follow the engine-side `INSTRUCTIONS_HEAD_MAX_CHARS` / `LAST_TOOL_TARGET_MAX_CHARS`.
 */
export const GET_WORKFLOW_RUN_ROSTER_LIMITS = {
  /** The upper bound on the row count of the phase table (the same value as the reducer's maxPhases). */
  maxPhases: 32,
  maxPhaseNameLength: 128,
  /**
   * The upper bound on the row count of the roster. Deliberately higher than the phase table's: a 50-way fan-out is routine, and what the reader is asking is exactly
   * "who is doing what". When this bound is exceeded the whole block is trimmed, and `subagentsTruncated` says that trimming happened —
   * a roster that silently lost 18 rows reads like "there are only 64 subagents".
   */
  maxSubagents: 64,
  maxActorNameLength: 128,
  /** The task summary of one ask (the `instructionsHead` of `node-queued`). */
  maxInstructionsHeadLength: 240,
  maxLastToolNameLength: 64,
  maxLastToolTargetLength: 120,
  /** The free-text reason of `node-waiting` (a one-line provider error during backoff). */
  maxWaitReasonLength: 240,
} as const;

/** Where one phase stands in the situation snapshot (a mirror of the port's `DynamicWorkflowRunPhaseView`). */
export const GetWorkflowRunPhaseSchema = z
  .object({
    name: z.string().min(1).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength),
    /** `ahead` = the script declared it but control flow has not reached it yet, and the only state with `rounds: 0`. */
    state: z.enum(["done", "current", "ahead", "unfinished"]),
    rounds: z.number().int().nonnegative(),
    nodesSettled: z.number().int().nonnegative(),
    nodesRunning: z.number().int().nonnegative(),
    /** The instant of the latest entry / exit (epoch ms). Absent when the event has no timestamp; never 0. */
    enteredAt: z.number().optional(),
    exitedAt: z.number().optional(),
  })
  .strict();

/** The most recently observed tool call within one ask. `target` is a clue (path / command head), not the full argument text. */
export const GetWorkflowRunSubagentLastToolSchema = z
  .object({
    name: z.string().min(1).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxLastToolNameLength),
    target: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxLastToolTargetLength).optional(),
    at: z.number().optional(),
  })
  .strict();

/**
 * The ask the subagent is running right now. An **absent `turn` / `toolCalls` reads as "unknown"**, while `0` reads as
 * "not a single tool was called" — old journals have no `node-progress`, so the two must be distinguishable.
 */
export const GetWorkflowRunSubagentAskSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    actorSeq: z.number().int().nonnegative().optional(),
    instructionsHead: z
      .string()
      .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxInstructionsHeadLength)
      .optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: GetWorkflowRunSubagentLastToolSchema.optional(),
  })
  .strict();

/** What the current ask is waiting for. `slot` = waiting on the process-level admission gate; `backoff` = the runner is retrying with backoff. */
export const GetWorkflowRunSubagentWaitSchema = z
  .object({
    cause: z.enum(["slot", "backoff"]),
    reason: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxWaitReasonLength).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    since: z.number().optional(),
  })
  .strict();

/**
 * One subagent in the roster (a mirror of the port's `DynamicWorkflowRunSubagentView`).
 *
 * The seven words of `state` are a closed set, and the read order is the write order (the port comment carries the full decision chain): while the run is alive
 * `parked` → `waiting` → `executing` → `failed` → `idle`; in a terminal run state only
 * `unfinished` → `failed` → `done` remain.
 */
export const GetWorkflowRunSubagentSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxActorNameLength).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength).optional(),
    currentAsk: GetWorkflowRunSubagentAskSchema.optional(),
    wait: GetWorkflowRunSubagentWaitSchema.optional(),
    /** Which question it is stuck on; it is never present in a read where `health.pendingQuestionsKnown` is false. */
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

/**
 * The run-level concurrency status. **The whole object is only present when it has been pushed below its own bound**: a run running at its full bound has
 * nothing to report, and its presence would itself mean "it is currently being throttled".
 */
export const GetWorkflowRunConcurrencyHealthSchema = z
  .object({
    effective: z.number().int().nonnegative(),
    cap: z.number().int().positive(),
    reason: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxWaitReasonLength).optional(),
    since: z.number().optional(),
  })
  .strict();

/** Whether the run as a whole is still moving (a mirror of the port's `DynamicWorkflowRunHealth`). */
export const GetWorkflowRunHealthSchema = z
  .object({
    lastProgressAt: z.number().optional(),
    stalledSince: z.number().optional(),
    concurrency: GetWorkflowRunConcurrencyHealthSchema.optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    cachedSteps: z.number().int().nonnegative(),
    /** Terminal runs only: the number of node rows still marked `running` (the process died under them). Absent when it is 0. */
    leftoverRunning: z.number().int().positive().optional(),
    /**
     * Whether this read can answer "is there a question waiting for an answer". When false the whole `pendingQuestions` field is absent,
     * and no subagent is ever reported as `parked` — "nobody is waiting" and "I don't know" are two different facts.
     */
    pendingQuestionsKnown: z.boolean(),
  })
  .strict();

export type GetWorkflowRunPhase = z.infer<typeof GetWorkflowRunPhaseSchema>;
export type GetWorkflowRunSubagent = z.infer<typeof GetWorkflowRunSubagentSchema>;
export type GetWorkflowRunSubagentAsk = z.infer<typeof GetWorkflowRunSubagentAskSchema>;
export type GetWorkflowRunHealth = z.infer<typeof GetWorkflowRunHealthSchema>;
