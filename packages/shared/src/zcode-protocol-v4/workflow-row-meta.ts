// ============================================================
// Row-level metadata for the workflow wheel (turnHeader / userInput members of rows.ts)
// ============================================================
// Detached from rows.ts: notification manifest, background result attribution, direct activation of three sections of schema to allow rows.ts to bypass
// Max-lines upper limit (same precedent as create-workflow-display.ts - feature-level schema is separated into modules).
// The external name remains unchanged: rows.ts is exported as it is, and the @zcode/shared bucket and relative import paths remain the same.

import { z } from "zod";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";

// Structured payload for workflow notifications.
// Launch-side casting, bounded; disables text unparsing from the model side. Upper bound principle: load changes with turnHeader row
// Take protocol + snapshot, truncate honesty (resultTruncated / count≠shown ⇒ preview is partial,
// The full amount is available via run id). The batch round deliberately does not carry it (one manifest per round does not hold in batches).
export const workflowNotificationMetaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("terminal"),
    status: z.enum(["completed", "errored", "stopped"]),
    // `status === "stopped"` is only present.
    stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
    summary: z.string().min(1).max(500),
    result: z.string().max(4000).optional(),
    resultForm: z.enum(["prose", "json"]).optional(),
    resultTruncated: z.literal(true).optional(),
    error: z.string().max(2000).optional(),
    reports: z
      .object({
        count: z.number().int().nonnegative(),
        shown: z.number().int().nonnegative(),
        preview: z.array(z.string().max(500)).max(8),
      })
      .optional(),
    // The chips load of the user interface product.
    // ⚠ Terminology: The artifact here is the output of the script published to the user via `artifact.*`, which is the same as the output on the same payload.
    // `result` (the top-level return value of the script, also called artifact inside the engine) has nothing to do with it.
    // Only fields that can be drawn with chip: number of bytes/number of entries can be seen by clicking on the side panel, and cannot be placed on the chip.
    // The upper bound is 8, beyond which (including those filtered out by types) artifactsTruncated; title's 120 and
    // ARTIFACT_CAPS.maxTitleLength has the same value, and is truncated on the transmitting side.
    // The exception is the deliverable (`primary`) one: it also has a `description` (≤ 500, the same as ARTIFACT_CAPS), because
    // Complete the card by drawing it as a line of deliverables with text, only this payload is readable on the cold transcript. List primary first.
    artifacts: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
          title: z.string().max(120).optional(),
          version: z.number().int().positive(),
          contentType: z.string().max(255).optional(),
          primary: z.literal(true).optional(),
          description: z.string().max(500).optional(),
        }),
      )
      .max(8)
      .optional(),
    artifactsTruncated: z.literal(true).optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("escalation"),
    qid: z.string().min(1),
    actor: z.string().min(1),
    question: z.string().min(1).max(4000),
    context: z.string().max(4000).optional(),
    askedAt: z.number().optional(),
  }),
  // Run-level stall: one for each stall segment, not the final state.
  z.object({
    kind: z.literal("stall"),
    sinceMs: z.number().int().nonnegative(),
    reason: z.string().max(64).optional(),
    cap: z.number().int().nonnegative().optional(),
  }),
]);
export type WorkflowNotificationMeta = z.infer<typeof workflowNotificationMetaSchema>;

export const backgroundResultOriginMetaSchema = z.object({
  // The three values ​​​​are synchronized with the BackgroundResultOriginMeta of contracts.
  // "workflow" is dynamic-workflow run (workId ≡ runId), which reuses the entire background notification pipeline.
  backgroundSource: z.enum(["bash", "subagent", "workflow"]),
  workId: z.string().min(1),
  title: z.string().min(1),
  // Only present on single notification wheel with backgroundSource === "workflow"; zod strips unknown keys,
  // If not added here, the entire link will be lost silently - this field is the only data source for manifest rendering.
  workflowNotification: workflowNotificationMetaSchema.optional(),
});
export type BackgroundResultOriginMeta = z.infer<typeof backgroundResultOriginMetaSchema>;

// Launch wheel metadata for direct launch.
// The GUI uses the hub's "Run" to directly start a saved workflow in a new session, and the agent casts a controlOnly wheel;
// Both turnHeader and userInput of this round are projected with origin: "workflowLaunch", and each carries this metadata.
// Cold recovery (message metadata) and live projection (TurnStarted payload) take the same part, and the cold and hot are of the same shape.
// The upper bound principle is consistent with workflowNotificationMetaSchema: emission-side casting, bounded, truncated honesty -
// The full script/diagnosis runId is available in the details side panel, and only this fixed-length summary is drawn on the card.
// Deliberately not reusing the backgroundSource shape of backgroundResultOriginMeta: that is the "background notification ownership",
// This is "activation initiated by the user from the hub". The semantics are different and the shape is independent to prevent the two places from dragging each other down during cross-evolution.
const workflowSubagentModelTextSchema = z
  .string()
  .min(1)
  .max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength);

// Setting wheel: The user is in the "Configuration" of the run card/details page
// After changing the settings, the agent uses the same script to revise a new run, and uses a controlOnly wheel with the same shape as the direct startup to record this.
// This section says **what has been changed**: only the changed settings are present; the from / to of each item is missing one end, that is, that end is the default
// (model = session model, cap = native cap). `ceiling` is the upper limit of this machine, for reading "13 → 4".
export const workflowSettingsAmendMetaSchema = z.object({
  // Which run was revised from. **Absent = take effect in place**: only change the upper limit of concurrency and run
  // When flying again, the "configuration" does not stop this run or start another one, so there is no predecessor to refer to - `runId` refers to the adjusted one
  // That one. Based on this, the rendering end only outputs that line and no longer outputs the card (drawing two cards in the same run will be read as two runs).
  // This field is optional; producers and consumers need to use a consistent schema to parse in-place adjustment settings records.
  predecessorRunId: z.string().min(1).max(128).optional(),
  subagentModel: z
    .object({
      from: workflowSubagentModelTextSchema.optional(),
      to: workflowSubagentModelTextSchema.optional(),
    })
    .optional(),
  maxConcurrency: z
    .object({
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
    })
    .optional(),
  ceiling: z.number().int().positive().optional(),
});
export type WorkflowSettingsAmendMeta = z.infer<typeof workflowSettingsAmendMetaSchema>;

export const workflowLaunchMetaSchema = z.object({
  // runId ≡ workId: The real-time status/number of steps of the run card of the driver start wheel, and also the connection key of the cancel/resume/details side panel.
  runId: z.string().min(1).max(128),
  // launch-<uuid> prefix (different from the model tool call id); the same id as the synthesized CreateWorkflow toolCall.
  toolCallId: z.string().min(1).max(128),
  // The workflow name in the parsing result (to be filled in by the agent, neither the user nor the model can create another one). Center activates constant presence; setting wheel
  // Take the adjusted run's own name, and there will be no unnamed run - the cards and side panels are replaced with the bottom word according to the rules of any unnamed run.
  // Instead of using a run id as the title.
  name: z.string().min(1).max(200).optional(),
  // scope / path only belongs to the hub startup: the setting wheel (`amend` below) changes an existing run, and there is no saved file to refer to.
  // Documented skew: on the old desktop they were required, the new CLI's settings wheel where parse failed and the whole line was lost (unlike
  // The origin closed set bonus is the same); the central starting wheel is always there and is not affected.
  scope: z.enum(["project", "global"]).optional(),
  // Hit script placement path; only for details/diagnosis, the card is not displayed. 1024 Overriding deep global/project paths.
  path: z.string().min(1).max(1024).optional(),
  // Actual parameter key value table (card rendering source). Bounded: Serialization ≤ 4KB, same boundary as TurnStartedPayload on contracts side,
  // Prevents cramming entire large objects into each persistent message and live event.
  args: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= 4096, {
      message: "workflowLaunch.args JSON must be ≤ 4096 bytes",
    })
    .optional(),
  // Description line (if any); the same paragraph of copy as the actual parameter window/hub card, 500 and the same boundary as the notification summary.
  description: z.string().max(500).optional(),
  // Create_workflow display compiled before startup (bounded cause-and-effect diagram + diagnosis): Find the run details side panel by toolCallId
  // "Start line" to get the picture, start directly without tool line, take the picture from here. Same schema as tool line display.
  // There is also no gate: the image parsing fails, but there is no image in this line, and the entire frame is not rejected (see toolDisplay.ts comment).
  display: toolCallCreateWorkflowDisplaySchema.optional().catch(undefined),
  // The original text of the script actually executed by this run (side panel Script area) corresponds to input.script in the tool line; the upper bound is the same as contracts
  // WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS Same value.
  script: z.string().max(256_000).optional(),
  // Set the turn of events: which run was this run revised with "configuration" and what was changed.
  amend: workflowSettingsAmendMetaSchema.optional(),
});
export type WorkflowLaunchMeta = z.infer<typeof workflowLaunchMetaSchema>;
