// sessions-index topic: list active data source; conflated latest status, never overflow.
import { z } from "zod";
import { timestampSchema } from "./core.js";
import { sessionWorkflowActivitySchema } from "./sessions-index-workflow-activity.js";
import {
  goalStateSchema,
  interactionAutoResolutionSchema,
  sessionMetaStateSchema,
  sessionPhaseSchema,
} from "./snapshot.js";

export const sessionPendingInteractionSummarySchema = z.object({
  interactionId: z.string(),
  kind: z.enum(["permission", "userInput"]),
  // Only the lightweight tool identity is issued, and the sidebar distinguishes AskUserQuestion from other blocking confirmations based on this; it does not carry questions or answers.
  toolName: z.string().optional(),
  autoResolution: interactionAutoResolutionSchema.optional(),
});
export type SessionPendingInteractionSummary = z.infer<
  typeof sessionPendingInteractionSummarySchema
>;

export const pendingInteractionSummarySchema = z.object({
  permissionCount: z.number().int().nonnegative(),
  userInputCount: z.number().int().nonnegative(),
});
export type PendingInteractionSummary = z.infer<typeof pendingInteractionSummarySchema>;

export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  // fork tree.
  parentSessionId: z.string().optional(),
  title: z.string(),
  // custom = user explicit rename; default/generated are not manual titles in product semantics.
  // Optional is for compatibility with old sessions-index frame / old persistence summary.
  titleSource: sessionMetaStateSchema.shape.titleSource.optional(),
  phase: sessionPhaseSchema,
  sessionEnded: z.boolean(),
  // Used for list dots (keep boolean here to avoid subscribing to the entire backgroundWorks for the sidebar).
  hasBackgroundWork: z.boolean(),
  // Sidebar workflow run lines: bounded run summary,
  // Only the fields required to draw the mini-track are loaded; the session does not run without any absences. optional Compatible with old frames / old CLI.
  workflowActivity: sessionWorkflowActivitySchema.optional(),
  pendingInteraction: sessionPendingInteractionSummarySchema.optional(),
  // The sidebar only requires kind/count and does not issue sensitive payloads such as questions, commands or answers.
  // optional Compatible with old sessions-index frame / stored summary.
  pendingInteractionSummary: pendingInteractionSummarySchema.optional(),
  goalStatus: goalStateSchema.shape.status.optional(),
  // Unread derivation: client local memory lastSeenActivityAt comparison (seq is not used, epoch will be reset).
  lastActivityAt: timestampSchema,
  // ≤120 characters.
  lastAssistantPreview: z.string().optional(),
  createdAt: timestampSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionsIndexSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  workspaceId: z.string(),
  // Host-level list log generation (independent of each session's logEpoch).
  logEpoch: z.string(),
  // Unordered; sorting is client-side display logic.
  sessions: z.array(sessionSummarySchema),
});
export type SessionsIndexSnapshot = z.infer<typeof sessionsIndexSnapshotSchema>;

export const sessionsIndexDeltaSchema = z.discriminatedUnion("op", [
  // conflation key = sessionId.
  z.object({ op: z.literal("session.upserted"), session: sessionSummarySchema }),
  z.object({ op: z.literal("session.removed"), sessionId: z.string() }),
]);
export type SessionsIndexDelta = z.infer<typeof sessionsIndexDeltaSchema>;

/** Builds a sessions-index topic key (dual to parseSessionsIndexTopic). */
export function sessionsIndexTopic(workspaceId: string): string {
  return `sessions-index/${workspaceId}`;
}

/** Parses a sessions-index topic key ("sessions-index/<workspaceId>"). */
export function parseSessionsIndexTopic(topic: string): string | null {
  if (!topic.startsWith("sessions-index/")) return null;
  const workspaceId = topic.slice("sessions-index/".length);
  return workspaceId.length > 0 ? workspaceId : null;
}
