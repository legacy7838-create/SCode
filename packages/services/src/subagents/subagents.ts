import type {
  ZCodeProvider,
  AgentSummary,
  AgentsListResult,
  AgentCreateParams,
  AgentUpdateParams,
  AgentDeleteParams,
  BuiltInSubagentModelOverrideParams,
  PluginSubagentModelOverrideParams,
  SubagentsListMode,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISubagentsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    mode?: SubagentsListMode;
  }): Promise<AgentsListResult>;

  setEnabled(params: { agentId: string; enabled: boolean }): Promise<void>;

  setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void>;

  /** Only writes complete coverage of user state, without changing the plugin Markdown. */
  setPluginAgentModelOverride(params: PluginSubagentModelOverrideParams): Promise<void>;

  /** The user-level agent root directory corresponding to the current filtering source (consistent with the built-in scanning order, take the first item of buildUserRoots). */
  getPrimaryUserAgentsDirectory(params: { provider: ZCodeProvider }): Promise<{ path: string }>;

  /** Create new agent file */
  createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }>;

  /** Update existing agent file */
  updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }>;

  /** Delete agent file */
  deleteAgent(params: AgentDeleteParams): Promise<void>;
}

export const ISubagentsService = createServiceDescriptor<ISubagentsService>(
  ServiceChannels.Subagents,
);
