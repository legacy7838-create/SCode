// workspace-config topic (new in v4 additive): Active data source for the workspace-level configuration directory.
// Background: In the old protocol, the provider registry/model directory is hot updated via per-session `state.updated` (settings patch)
// After delivery, the zcodeTaskIndexSyncer on the host side is converted into workspace_config_options_update and broadcast to the UI;
// The old session/subscribe + state.updated vocabulary does not carry the configuration directory, so this topic will be changed uniformly.
// Semantics: conflated latest state (same as sessions-index), the payload is the workspace level configuration directory + slash command directory.
// Note that this is the workspace level, not the session level - the session level current is selected in the conversation topic
// In `config` (sessionConfigStateSchema); the currentValue of this topic represents the workspace default.
// Discipline: additive evolution - adding new topics/adding optional fields is legal, but changing the shape of existing fields is illegal.
import { z } from "zod";

// Aligned with the host side ZCodeConfigSelectValue (zcode-task-types-core) structure:
// When syncer forwards workspace_config_options_update, zero mapping is passed through, and the downstream useZCodeConfig consumption side does not change.
export const workspaceConfigSelectValueSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().optional(),
  // Value source: native model list or session-side injection (UI deduplication and presentation control).
  origin: z.enum(["native", "injected"]).optional(),
  // The provider/group id to which the model option belongs (provider → model group selection).
  modelProviderId: z.string().optional(),
  modelProviderName: z.string().optional(),
  // Missing indicates that the old payload/capability is unknown; an empty array indicates that the catalog is known and has no optional reasoning gear.
  modelThoughtLevels: z.array(z.string()).optional(),
  modelDefaultThoughtLevel: z.string().optional(),
});
export type WorkspaceConfigSelectValue = z.infer<typeof workspaceConfigSelectValueSchema>;

// Aligned with the host side ZCodeConfigOption structure (id: model / mode / thought_level / custom).
export const workspaceConfigOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(["select", "boolean"]),
  currentValue: z.union([z.string(), z.boolean()]),
  options: z.array(workspaceConfigSelectValueSchema).optional(),
});
export type WorkspaceConfigOption = z.infer<typeof workspaceConfigOptionSchema>;

// slash command directory (workspace level; aligned with host-side ZCodeSlashCommand).
export const workspaceSlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputHint: z.string().optional(),
  source: z.enum(["builtin", "custom"]).optional(),
});
export type WorkspaceSlashCommand = z.infer<typeof workspaceSlashCommandSchema>;

// topic payload ontology: overall replacement semantics (conflated is the latest state, never deeply merged - the same discipline).
export const workspaceConfigStateSchema = z.object({
  configOptions: z.array(workspaceConfigOptionSchema),
  slashCommands: z.array(workspaceSlashCommandSchema),
});
export type WorkspaceConfigState = z.infer<typeof workspaceConfigStateSchema>;

export const workspaceConfigSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  workspaceId: z.string(),
  // Host-level configuration log generation (isomorphic to logEpoch of sessions-index and independent of each other).
  logEpoch: z.string(),
  config: workspaceConfigStateSchema,
});
export type WorkspaceConfigSnapshot = z.infer<typeof workspaceConfigSnapshotSchema>;

// The delta set deliberately has only one op: the configuration directory is a small overall replacement state, and no field-level increments are performed.
export const workspaceConfigDeltaSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("config.updated"), config: workspaceConfigStateSchema }),
]);
export type WorkspaceConfigDelta = z.infer<typeof workspaceConfigDeltaSchema>;

/** Builds a workspace-config topic key (dual to parseWorkspaceConfigTopic). */
export function workspaceConfigTopic(workspaceId: string): string {
  return `workspace-config/${workspaceId}`;
}

/** Parses a workspace-config topic key ("workspace-config/<workspaceId>"). */
export function parseWorkspaceConfigTopic(topic: string): string | null {
  if (!topic.startsWith("workspace-config/")) return null;
  const workspaceId = topic.slice("workspace-config/".length);
  return workspaceId.length > 0 ? workspaceId : null;
}
