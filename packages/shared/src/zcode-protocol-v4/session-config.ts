import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

// ── config──
export const sessionConfigStateSchema = z.object({
  /** Session accepts and persists sparse selection intent; provider/model/thought is only UI effective projection. */
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string(),
  model: z.string(),
  thought: z.string(),
  // Thinking gear is a capability of the current model, not a workspace/UI preference.
  // default is only for compatibility with old snapshots; new agents must project the actual collection from the runtime.
  thoughtLevels: z.array(z.string()).default([]),
  followupMode: z.enum(["queue", "guide"]),
  // Additive (frozen surface evolution, same as meta’s ruling caliber): agent collaboration mode (core CollaborationMode).
  // Default must be used so as not to destroy the resolution of old snapshots/old senders; the projection is updated by the SessionModeChanged event.
  mode: z.string().default("build"),
  planEnabled: z.boolean().optional(),
  /** The approval result is clear; the draft is consumed once according to the interactionId, and ordinary mode updates do not reset it. */
  permissionGrant: z.object({ interactionId: z.string().min(1) }).optional(),
  /** The association of recent tool conversions is used for draft directed synchronization; no visible historical events will be added. */
  planTransition: z
    .object({
      toolCallId: z.string(),
      planEnabled: z.boolean(),
    })
    .optional(),
});
export type SessionConfigState = z.infer<typeof sessionConfigStateSchema>;

export const sessionModelTransitionSchema = z.object({
  eventId: z.string().min(1),
  origin: z.literal("registryFallback"),
  from: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  to: z.object({
    provider: z.string(),
    model: z.string(),
  }),
});
export type SessionModelTransition = z.infer<typeof sessionModelTransitionSchema>;
