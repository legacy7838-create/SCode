// ConversationDelta: seven operations, closed set.
// No row.inserted (intermediate insertion), no row.moved, no field-level JSON patch——
// For any structural changes that cannot be expressed by this model, the server will issue snapshot resync to deliberately compress the client error surface.
//
// The only exception is the last two `workflowRun.*`: `workflowRuns` is a high-frequency status key, and the key level replacement is
// Each engine event requires retransmission of the entire table (O(N) bytes/event, O(N²)/run). They **only** opened one for this one key
// According to the increment of (runId, siteId, ordinal), the semantics is still "replace the entire key, but it is lowered two levels":
// Integer replacement of header keys and entire entries without any field-level deep merging. The rules are in workflow-runs-delta.ts.
import { z } from "zod";
import { streamablePathSchema } from "./core.js";
import { conversationRowSchema } from "./rows.js";
import { sharedContextImportStateSchema } from "./shared-context-import.js";
import {
  backgroundWorkSummarySchema,
  commandStateSummarySchema,
  goalStateSchema,
  inputRoutingSchema,
  pendingInteractionSchema,
  planStateSchema,
  queueStateSchema,
  sessionActionAvailabilitySchema,
  sessionConfigStateSchema,
  sessionControlSchema,
  sessionMetaStateSchema,
  sessionModelTransitionSchema,
  sessionUsageStateSchema,
  subagentProjectionStateSchema,
  workspaceHookAdmissionStateSchema,
} from "./snapshot.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  workflowRunsStateSchema,
} from "./workflow-runs.js";

// StatePatch: Key level overall replacement (Object.assign), key set is closed. There is never a deep merge within a key.
export const statePatchSchema = z.object({
  revision: z.number().optional(),
  control: sessionControlSchema.optional(),
  sharedContextImport: sharedContextImportStateSchema.optional(),
  availability: sessionActionAvailabilitySchema.optional(),
  inputRouting: inputRoutingSchema.optional(),
  meta: sessionMetaStateSchema.optional(),
  config: sessionConfigStateSchema.optional(),
  modelTransition: sessionModelTransitionSchema.nullable().optional(),
  usage: sessionUsageStateSchema.optional(),
  queue: queueStateSchema.optional(),
  pendingInteractions: z.array(pendingInteractionSchema).optional(),
  pendingCommands: z.array(commandStateSummarySchema).optional(),
  backgroundWorks: z.array(backgroundWorkSummarySchema).optional(),
  subagents: subagentProjectionStateSchema.optional(),
  // The real-time running state of workflow run. The container itself is not strict, so the old desktop receives this new key by simply stripping a key,
  // Keep all the rest of the patch keys - that's exactly why it doesn't need any version-deflection defense.
  workflowRuns: workflowRunsStateSchema.optional(),
  goal: goalStateSchema.nullable().optional(),
  plan: planStateSchema.nullable().optional(),
  // Soft access control: null = pending cleared (prompt bar disappears); object = pending review status update.
  workspaceHookAdmission: workspaceHookAdmissionStateSchema.nullable().optional(),
});
export type StatePatch = z.infer<typeof statePatchSchema>;

/**
 * A run's **header** = `workflowRunSchema` minus the actors / nodes tables, the two that sync
 * incrementally per entry.
 *
 * Derived from the same schema via `.omit`, so a separately maintained field list cannot drift
 * and break subscription parsing. The small collections (reports / artifacts / phases /
 * pendingQuestions…) stay in the header and are replaced whole by key: their upper bounds are
 * all a few dozen entries, and a second incremental syntax for them would only be a second thing
 * to get wrong.
 */
export const workflowRunHeaderSchema = workflowRunSchema.omit({ actors: true, nodes: true });
export type WorkflowRunHeader = z.infer<typeof workflowRunHeaderSchema>;

/** Partial update of the header: keys that are present are replaced whole, keys that are absent are left alone (never deep-merged). */
export const workflowRunHeaderPatchSchema = workflowRunHeaderSchema.partial();
export type WorkflowRunHeaderPatch = z.infer<typeof workflowRunHeaderPatchSchema>;

/** Header keys that become **absent**. "Zero entries ⇒ key absent" is the protocol contract for keys like reports / pendingQuestions, so a delta has to be able to say it. */
export const workflowRunHeaderKeySchema = workflowRunHeaderSchema.keyof();
export type WorkflowRunHeaderKey = z.infer<typeof workflowRunHeaderKeySchema>;

/**
 * The **identity** of an evicted entry (the dedup key both tables share). Picked with `.pick` off
 * the actor schema instead of hand-writing the two fields: those bounds should be defined in
 * exactly one place, for the same reason as the `.omit` in `workflowRunHeaderSchema`.
 *
 * Deliberately **identity only**: all an eviction has to say is "this one is gone"; carrying the
 * entry itself would only make consumers think it was an upsert.
 */
export const workflowRunEntryRefSchema = workflowRunActorSchema.pick({
  siteId: true,
  ordinal: true,
});
export type WorkflowRunEntryRef = z.infer<typeof workflowRunEntryRefSchema>;

export const conversationDeltaSchema = z.discriminatedUnion("op", [
  // Append to the end (99%).
  z.object({ op: z.literal("row.appended"), row: conversationRowSchema }),
  // Replace entire row by rowId (state machine migration).
  z.object({ op: z.literal("row.upserted"), row: conversationRowSchema }),
  // Delete this line and everything after it (edit/retry branch). Acts on all rows with rowId >= fromRowId in the client-loaded collection.
  z.object({ op: z.literal("row.removed"), fromRowId: z.number() }),
  // Streaming text append. Only allowed to act on streaming behavior (guaranteed by the server, assertable by the client).
  z.object({
    op: z.literal("row.delta"),
    rowId: z.number(),
    path: streamablePathSchema,
    append: z.string(),
  }),
  z.object({ op: z.literal("state.updated"), patch: statePatchSchema }),
  /**
   * Key-level delta for one dwf run. `revision` is `workflowRuns.revision` **after** this change
   * (an absolute value); one engine event yields at most one such op (node phase, derived actor
   * status, usage, and watermark all land atomically together).
   *
   * The six payloads each have their own semantics: `run` replaces whole by key, `cleared` says
   * which keys became absent, `removedActors` / `removedNodes` delete entries by
   * (siteId, ordinal), and `actors` / `nodes` upsert whole entries under the same key. All four
   * tables share the state key's bounds — a delta must not be able to assemble an illegal state.
   *
   * **Application order is header → removals → upserts**, written here and in the field order: a
   * key both removed and re-added in one op (an overflowed run whose tables are cleared and
   * reopened on resume, or an entry that was evicted and came back) must land at the tail of the
   * table, so applying the two ops in order gives the same result.
   */
  z.object({
    op: z.literal("workflowRun.updated"),
    runId: workflowRunSchema.shape.runId,
    revision: workflowRunsStateSchema.shape.revision,
    run: workflowRunHeaderPatchSchema.optional(),
    cleared: z
      .array(workflowRunHeaderKeySchema)
      .max(workflowRunHeaderKeySchema.options.length)
      .optional(),
    removedActors: z
      .array(workflowRunEntryRefSchema)
      .max(WORKFLOW_RUNS_LIMITS.maxActors)
      .optional(),
    removedNodes: z.array(workflowRunEntryRefSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
    actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors).optional(),
    nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
  }),
  /** This run was evicted by the producer (only the producer evicts, and it has to say so — clients never enforce the upper bounds themselves). */
  z.object({
    op: z.literal("workflowRun.removed"),
    runId: workflowRunSchema.shape.runId,
    revision: workflowRunsStateSchema.shape.revision,
  }),
]);
export type ConversationDelta = z.infer<typeof conversationDeltaSchema>;
export type WorkflowRunUpdatedDelta = Extract<ConversationDelta, { op: "workflowRun.updated" }>;
export type WorkflowRunRemovedDelta = Extract<ConversationDelta, { op: "workflowRun.removed" }>;
