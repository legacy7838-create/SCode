import type { ZCodeProvider } from "./zcode-task-types-core.js";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";

export type AgentScope = "built-in" | "workspace" | "user";

export type AgentSource = "built-in" | "user" | "plugin";

export type BuiltInSubagentName = "general-purpose" | "Explore";

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<BuiltInSubagentName, ModelSelection>
>;

export type PluginSubagentModelSelectionOverrides = Readonly<Record<string, ModelSelection>>;

/** The real reader only accepts structured overrides; it does not interpret the legacy dual map on read or re-match the Provider. */
export function parsePluginSubagentModelSelectionOverrides(
  value: unknown,
): PluginSubagentModelSelectionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, candidate]) => {
      const selection = modelSelectionSchema.safeParse(candidate);
      return id.startsWith("plugin:") && selection.success ? [[id, selection.data]] : [];
    }),
  );
}

export type AgentPermissionMode = "auto" | "plan";

export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export type SubagentsListMode = "allRuntimeScopes" | "settingsUserOnly";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  defaultModelSelection?: ModelSelection;
  modelSelectionOverride?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: AgentScope;
  source: AgentSource;
  enabled: boolean;
  readOnly?: boolean;
  projectPath?: string;
  pluginId?: string;
  pluginName?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export interface AgentsListResult {
  agents: AgentSummary[];
  userAgents: AgentSummary[];
  pluginAgents: AgentSummary[];
  capability: AgentsCapability;
  diagnostics?: AgentDiagnostic[];
}

/** Agent configuration, used to create/update an agent */
export interface SubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
}

/** Agent creation parameters */
export interface AgentCreateParams {
  config: SubAgentConfig;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent update parameters */
export interface AgentUpdateParams {
  agentId: string;
  config: SubAgentConfig;
  oldFilePath?: string;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent deletion parameters */
export interface AgentDeleteParams {
  agentId: string;
  filePath: string;
}

export interface BuiltInSubagentModelOverrideParams {
  agentName: BuiltInSubagentName;
  modelSelection?: ModelSelection;
}

export interface PluginSubagentModelOverrideParams {
  agentId: string;
  modelSelection?: ModelSelection;
}

/**
 * Stable id of a plugin subagent: `plugin:<pluginId>:<bare name lowercased>`.
 * pluginId is `<name>@<marketplace>` and carries no version, so the id survives a plugin upgrade
 * and the override is preserved along with it.
 * Both services and the CLI bootstrap use it as the key in agents-state.json, so they must share
 * one implementation.
 */
export function createPluginAgentStateId(pluginId: string, agentName: string): string {
  return `plugin:${pluginId}:${agentName.trim().toLowerCase()}`;
}

export function createAgentStateId(input: {
  name: string;
  scope: AgentScope;
  source: AgentSource;
}): string {
  return `${input.source}:${input.scope}:${input.name.trim().toLowerCase()}`;
}
