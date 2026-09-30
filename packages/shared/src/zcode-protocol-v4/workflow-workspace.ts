// ============================================================
// Protocol glossary for workspace transcript
// ============================================================
// A run `files.*` / `git.*` / `world.run` call, played back as a tool card on the side panel.
// The authority is in the journal's `dwf_node` line (`kind ∈ {world-read, world-run}`): `input_json`
// (Migration 0030) gives op with arguments, and `result_json` gives the body.
//
// Two v4 queries, according to the ①/③ disassembly method of user interface products:
//   Workspace light line list (op/args/status/summary/time), **without body**;
//              Live projection's `lastEventSequence` rechecked on raise
//   NodeResult The text of a node, conformally bounded by maxBytes; fetched when expanded, cached by tab
//
// Layering: The text is never entered into the list; the "how big/exit code/how many items" on the list are determined by the storage layer using SQLite's JSON function
// Calculated in the library. Same family as workflowRunEvents: read-only, stateless, timeout retransmission safe, deliberately not v4 command,
// Without atSeq / atLogEpoch (the journal is read, there is no staleness to prevent). New method naturally biases safety.

import { z } from "zod";

/** Display upper bounds for the workspace transcript. The numbers are the contract. */
export const WORKFLOW_WORKSPACE_LIMITS = {
  /** How many rows one listing holds at most; when over the bound the gateway trims the tail and sets `truncated`. */
  maxNodes: 2000,
  /** Length of an `op` name (`git-changed-files` is the longest one). */
  maxOpLength: 32,
  /** Number of arguments (≤ 8 after the engine side truncates; the untruncated original is ≤ 3 by the facade signature). */
  maxArgs: 16,
  /** Display length of a failure message; the host trims the tail when it is longer. */
  maxErrorMessageLength: 2000,
  /** How many bytes of a result body can be read back at once (truncated rather than refused — this is the audit surface, not the script's data-fetching surface). */
  resultMaxBytes: 32 * 1024,
} as const;

export const workflowRunWorkspaceNodeKindSchema = z.enum(["world-read", "world-run"]);
export type WorkflowRunWorkspaceNodeKind = z.infer<typeof workflowRunWorkspaceNodeKindSchema>;

/** The status of a journal row (the wire mirror of `NodeRecordStatus`). */
export const workflowRunWorkspaceNodeStatusSchema = z.enum(["running", "completed", "failed"]);
export type WorkflowRunWorkspaceNodeStatus = z.infer<typeof workflowRunWorkspaceNodeStatusSchema>;

/** Structured failure: the code + message of the journal's `error_json` (the remaining fields do not leave the protocol). */
export const workflowRunWorkspaceNodeErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().max(WORKFLOW_WORKSPACE_LIMITS.maxErrorMessageLength),
  })
  .strict();
export type WorkflowRunWorkspaceNodeError = z.infer<typeof workflowRunWorkspaceNodeErrorSchema>;

/**
 * The summary of one listing row: a few numbers reportable without decoding the body. Which ones
 * are present depends on the op — an array body (glob / grep / changedFiles) has `resultCount`,
 * `world.run` has `exitCode` plus the byte counts of both outputs, and a string body has only
 * `resultBytes`.
 */
export const workflowRunWorkspaceNodeSummarySchema = z
  .object({
    resultBytes: z.number().int().nonnegative(),
    resultCount: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WorkflowRunWorkspaceNodeSummary = z.infer<typeof workflowRunWorkspaceNodeSummarySchema>;

/**
 * One line of the workspace transcript. `op` / `args` come from `input_json`; historical rows
 * from before the upgrade have neither (the UI falls back to the step label on the static
 * diagram); `inputTruncated` means args is a per-item string preview rather than the real values.
 */
export const workflowRunWorkspaceNodeSchema = z
  .object({
    siteId: z.string().min(1).max(64),
    ordinal: z.number().int().nonnegative(),
    kind: workflowRunWorkspaceNodeKindSchema,
    op: z.string().min(1).max(WORKFLOW_WORKSPACE_LIMITS.maxOpLength).optional(),
    args: z.array(z.unknown()).max(WORKFLOW_WORKSPACE_LIMITS.maxArgs).optional(),
    inputTruncated: z.literal(true).optional(),
    status: workflowRunWorkspaceNodeStatusSchema,
    error: workflowRunWorkspaceNodeErrorSchema.optional(),
    summary: workflowRunWorkspaceNodeSummarySchema.optional(),
    /** The creation / most recent update moment of the journal row (epoch milliseconds); the difference between the two is how long this step took. */
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type WorkflowRunWorkspaceNode = z.infer<typeof workflowRunWorkspaceNodeSchema>;

// ── v4 query ①: workflowRunWorkspace (light line list)──
export const v4ConversationWorkflowRunWorkspaceParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();
export type V4ConversationWorkflowRunWorkspaceParams = z.infer<
  typeof v4ConversationWorkflowRunWorkspaceParamsSchema
>;

export const v4ConversationWorkflowRunWorkspaceResultSchema = z
  .object({
    /** In insertion order (ascending journal row id = the engine's admission order). */
    nodes: z.array(workflowRunWorkspaceNodeSchema).max(WORKFLOW_WORKSPACE_LIMITS.maxNodes),
    /** The listing was trimmed because it exceeded maxNodes. */
    truncated: z.boolean().optional(),
  })
  .strict();
export type V4ConversationWorkflowRunWorkspaceResult = z.infer<
  typeof v4ConversationWorkflowRunWorkspaceResultSchema
>;

// ── v4 query ②: workflowRunNodeResult (the text of a node)──
// Authorization is on the CLI side (port implementation): sessionId must be the parentSessionId of the run, otherwise it will be the same as "no such node"
// Same answer. The text is bounded according to maxBytes **Conformal**: string trimming, array tailing, and stdout/stderr of run
// Cut off the ends of each one - what a card wants is "what ran and what were the first few hundred lines", not all or nothing like a script.
export const v4ConversationWorkflowRunNodeResultParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    siteId: z.string().min(1).max(64),
    ordinal: z.number().int().nonnegative(),
    /** Both the default and the ceiling are resultMaxBytes; the gateway clamps. */
    maxBytes: z.number().int().positive().max(WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunNodeResultParams = z.infer<
  typeof v4ConversationWorkflowRunNodeResultParamsSchema
>;

export const v4ConversationWorkflowRunNodeResultResultSchema = z
  .object({
    status: workflowRunWorkspaceNodeStatusSchema,
    /** The body after bounding; absent for running rows and failed rows. */
    result: z.unknown().optional(),
    error: workflowRunWorkspaceNodeErrorSchema.optional(),
    truncated: z.boolean(),
    /** Serialized byte count before truncation. */
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
export type V4ConversationWorkflowRunNodeResultResult = z.infer<
  typeof v4ConversationWorkflowRunNodeResultResultSchema
>;
