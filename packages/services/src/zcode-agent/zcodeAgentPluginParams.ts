import type {
  ZCodeAgentMcpServer,
  ZCodeAutomationScheduleRule,
  ZCodeMcpListMode,
  ModelSelection,
} from "@zcode/shared";

export interface ZCodeAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** The runtime session identity of the remote workspace; only used for isolation/routing, not a replacement for the workspacePath. */
  remoteSessionId?: string;
}

export interface ZCodeAgentPluginViewParams extends ZCodeAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface ZCodeAgentListMcpServerStatusesParams extends ZCodeAgentWorkspaceTarget {
  mcpServers?: ZCodeAgentMcpServer[];
  mode?: ZCodeMcpListMode;
}

export interface ZCodeAgentAddPluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface ZCodeAgentRemovePluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  marketplace: string;
}

export interface ZCodeAgentUpdatePluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  operationId?: string;
}

export interface ZCodeAgentInstallPluginParams extends ZCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentCancelPluginOperationParams {
  operationId: string;
}

export interface ZCodeAgentUninstallPluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface ZCodeAgentUpdatePluginParams extends ZCodeAgentWorkspaceTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface ZCodeAgentRestoreBuiltinPluginParams extends ZCodeAgentWorkspaceTarget {
  pluginId: string;
}

export interface ZCodeAgentConfigurePluginParams extends ZCodeAgentWorkspaceTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentResetPluginConfigParams extends ZCodeAgentWorkspaceTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentValidatePluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface ZCodeAgentDescribePluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface ZCodeAgentSetPluginEnabledParams extends ZCodeAgentWorkspaceTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// The Plugin dialog references the catalog:
// With sessionId → session-owned frozen catalog (must be routed to the workspace client holding the session);
// Without → workspace current catalog (new draft Picker).
export interface ZCodeAgentPluginReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog: Same as Plugin reference, using sessionId to distinguish workspace current directory and
// Resident Session runtime snapshot; does not participate in the Settings management directory.
export interface ZCodeAgentSkillReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}
export interface ZCodeAgentResolveSuggestedPluginReferenceParams extends ZCodeAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- Scheduled task (automation) management parameters ----

export interface ZCodeAgentCreateAutomationParams extends ZCodeAgentWorkspaceTarget {
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
}

export interface ZCodeAgentUpdateAutomationParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface ZCodeAgentAutomationIdParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
}

export interface ZCodeAgentSetAutomationEnabledParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface ZCodeAgentDeleteAutomationRunParams extends ZCodeAgentWorkspaceTarget {
  runId: string;
}
