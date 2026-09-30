import type { BackgroundBashOutputResult, SessionDebugSnapshot } from "@zcode/shared";
/* eslint-disable max-lines -- the ZCode agent service interface declares the protocol/session/workspace methods in one place; splitting it would raise the cost of migrating the service descriptor. */
import type { Event, IDisposable } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { AppUsageRange, AppUsageSnapshot, ZCodeTaskTokenUsageResult } from "@zcode/shared";
import type { ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";
import type {
  ZCodeStorageStartupState,
  ZCodeDeliveryKind,
  ZCodeAgentMcpServer,
  ZCodeBackgroundTurnAttribution,
  TraceId,
  ZCodeSessionCompactResult,
  ZCodeSessionGoalAction,
  ZCodeSessionGoalResult,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodeSessionImportHistory,
  ZCodePermissionRequestParams,
  AgentLaneResourceSample,
  ZCodeMcpTelemetryEvent,
  ZCodeMcpResourceSample,
  ZCodeToolExecResource,
  ZCodeProcessChildProcess,
  ZCodeMcpListResult,
  ZCodePluginsListResult,
  ZCodePluginsOverviewResult,
  ZCodePluginsMarketplaceMutationResult,
  ZCodePluginsInstallResult,
  ZCodePluginsReferenceCatalogResult,
  ZCodeSkillsReferenceCatalogResult,
  ZCodeWorkflowsDeleteResult,
  ZCodeWorkflowsGetResult,
  ZCodeWorkflowsListResult,
  ZCodeWorkflowsMoveResult,
  ZCodeWorkflowsRunsResult,
  ZCodeWorkflowsUpdateMetaResult,
  ZCodePluginsUninstallResult,
  ZCodePluginsRestoreBuiltinResult,
  ZCodePluginsConfigureResult,
  ZCodePluginsDescribeResult,
  ZCodePluginsValidateResult,
  ZCodePluginsSetEnabledResult,
  ZCodePluginsCancelOperationResult,
  ZCodePluginOperationProgressNotification,
  ZCodeProviderTestModelConnectivityParams,
  ZCodeProviderTestModelConnectivityResult,
  ZCodeUserInputRequestParams,
  ZCodeUserInputResponse,
  ZCodeSessionEvent,
  ZCodeSessionInfo,
  ZCodeSessionMode,
  ZCodeSessionPersistence,
  ZCodeSessionSendResult,
  ZCodeSessionRequestRuntimePreferencesParams,
  ZCodeSessionRuntimePreferencesResult,
  ZCodeSessionStateSnapshot,
  ZCodeSessionSubagentsResult,
  ZCodeStateUpdatedNotification,
  ZCodeTaskClientMode,
  ZCodeBrowserAmbientContext,
  ZCodeWorkspacePresentation,
  ZCodeWorkspaceGenerateTextResult,
  ZCodeWorkspaceGenerateTextParams,
  ZCodeWorkspaceHookTrustGrantResult,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type {
  ClientHello,
  CommandAck,
  CommandEnvelope,
  CommandKey,
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationRowTarget,
  HelloMessage,
  SessionsIndexTopicWireCandidate,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConnectionFlowState,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";

export * from "./zcodeAgentPluginParams.js";
export * from "./zcodeAgentWorkflowParams.js";
import type {
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentAutomationIdParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentCreateAutomationParams,
  ZCodeAgentDeleteAutomationRunParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentListMcpServerStatusesParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentSkillReferenceCatalogParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentSetAutomationEnabledParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentUpdateAutomationParams,
  ZCodeAgentValidatePluginParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgentPluginParams.js";
import type {
  ZCodeAgentDeleteSavedWorkflowParams,
  ZCodeAgentGetSavedWorkflowParams,
  ZCodeAgentListSavedWorkflowRunsParams,
  ZCodeAgentListSavedWorkflowsParams,
  ZCodeAgentMoveSavedWorkflowParams,
  ZCodeAgentUpdateSavedWorkflowMetaParams,
} from "./zcodeAgentWorkflowParams.js";

export interface ZCodeAgentSessionTarget extends ZCodeAgentWorkspaceTarget {
  sessionId: string;
}

export interface ZCodeAgentResumeSessionParams extends ZCodeAgentSessionTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  // Cold recovery will rebuild the runtime, and the tool plane isolation must maintain the same security boundary as create (CUA only releases the zcode-cua tool,
  // Ban Bash, etc.). Otherwise, the visible tool surface/execution permissions of the model after resume will be wider than when created.
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface ZCodeAgentInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface ZCodeAgentRunAutomationNowResult {
  status: "queued" | "duplicate";
}

export interface ZCodeAgentWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export const ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE = "ZCODE_AGENT_RUNTIME_UNAVAILABLE";

export type ZCodeAgentRuntimePolicy = "start-if-needed" | "existing-only";

export interface ZCodeAgentRuntimeLifecycleEvent extends ZCodeAgentWorkspaceTarget {
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentWorkspaceRuntimeIdentity;
  state: "available" | "unavailable";
}

export type ZCodeAgentCuaPermissionObservation = CuaPermissionObservation &
  ZCodeAgentWorkspaceTarget;

export interface ZCodeAgentCreateSessionParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ZCodeSessionMode;
  model?: ModelSelection;
  persistence?: ZCodeSessionPersistence;
  thoughtLevel?: string;
  /** Automation execution sessions turn off model-based secondary naming, keeping the first user query as a stable title. */
  titleGenerationEnabled?: boolean;
  mcpServers?: ZCodeAgentMcpServer[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  importedHistory?: ZCodeSessionImportHistory;
}

export interface ZCodeAgentListSessionsParams extends ZCodeAgentWorkspaceTarget {
  sessionIds?: string[];
  runtimePolicy?: ZCodeAgentRuntimePolicy;
  includeArchived?: boolean;
  limit?: number;
}

export interface ZCodeAgentListSessionSubagentsParams extends ZCodeAgentSessionTarget {
  endedCursor?: string;
  endedLimit?: number;
  /** The host connection identity of a remote workspace; only used to select an existing Host and never enters the CLI wire query. */
  remoteSessionId?: string;
}

export interface ZCodeAgentAppUsageParams {
  range: AppUsageRange;
  timeZone?: string;
}

export interface ZCodeAgentTaskTokenUsageParams extends ZCodeAgentSessionTarget {}

export interface ZCodeAgentReadSessionParams extends ZCodeAgentSessionTarget {
  deliveryKind?: ZCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
  /** Passive indexers/observers may only read an existing runtime; spinning up a session just to read a snapshot is forbidden. */
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

export interface ZCodeAgentReadSessionMessagesParams extends ZCodeAgentSessionTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ZCodeAgentReadSessionEventsParams extends ZCodeAgentSessionTarget {
  afterSeq?: number;
  limit?: number;
}

export type ZCodeAgentReadWorkspacePresentationParams = ZCodeAgentWorkspaceTarget;

export interface ZCodeAgentGrantWorkspaceHookTrustParams extends ZCodeAgentWorkspaceTarget {
  bundleDigest: string;
  hookDeclarationDigest: string;
}

export interface ZCodeAgentSendPromptParamsBase extends ZCodeAgentSessionTarget {
  modelSelection?: ModelSelection;
  modelExecution?: import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["sendText"]["modelExecution"];
  inputId?: string;
  queryId?: string;
  messageId?: string;
  sessionTraceId?: TraceId;
  content: string;
  attachments?: Record<string, unknown>[];
  /** The current IAB state for provider-only use; UI/session persistence still uses the original content text. */
  browserAmbientContext?: ZCodeBrowserAmbientContext;
  clientMode?: ZCodeTaskClientMode;
  expectedRevision?: number;
  expectedProviderRevision?: string;
  runtimeProviderHeaders?: Record<string, string>;
  toolDenylist?: string[];
  /** The stable callback address for a bot-sourced turn; read by CronCreate only within the current turn. */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
}

export type ZCodeAgentSendPromptParams = ZCodeAgentSendPromptParamsBase &
  ZCodeBackgroundTurnAttribution;

export interface ZCodeAgentCompactParams extends ZCodeAgentSessionTarget {
  inputId?: string;
  instructions?: string;
  expectedRevision?: number;
}

export interface ZCodeAgentGoalParams extends ZCodeAgentSessionTarget {
  inputId?: string;
  action: ZCodeSessionGoalAction;
  objective?: string;
  expectedRevision?: number;
}

export interface ZCodeAgentSetModelParams extends ZCodeAgentSessionTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeAgentSetThoughtLevelParams extends ZCodeAgentSessionTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeAgentSetModeParams extends ZCodeAgentSessionTarget {
  mode: ZCodeSessionMode;
  expectedRevision?: number;
}

export interface ZCodeAgentGenerateWorkspaceTextParams extends ZCodeAgentWorkspaceTarget {
  selection: ZCodeWorkspaceGenerateTextParams["selection"];
  prompt?: string;
  messages?: ZCodeWorkspaceGenerateTextParams["messages"];
  tools?: ZCodeWorkspaceGenerateTextParams["tools"];
  querySource: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * The protocol-level RPC timeout. Long requests to thinking models exceed the protocol client's
   * default 3 minutes; callers must pass their own deadline through here, otherwise the default
   * timeout fires first and onRequestTimeout also misjudges it as stale and kills the process.
   */
  requestTimeoutMs?: number;
}

export interface ZCodeAgentTestModelConnectivityParams extends ZCodeAgentWorkspaceTarget {
  selection: ZCodeProviderTestModelConnectivityParams["selection"];
  signal?: AbortSignal;
}

export interface ZCodeAgentSessionRuntimePreferencesRequest extends ZCodeSessionRequestRuntimePreferencesParams {
  requestId: string;
}

export interface ZCodeAgentRespondSessionRuntimePreferencesParams {
  requestId: string;
  resolution:
    | { status: "resolved"; preferences: ZCodeSessionRuntimePreferencesResult }
    | { status: "failed"; message: string };
}

export interface ZCodeAgentSessionSubscribeParams extends ZCodeAgentSessionTarget {
  deliveryKind: ZCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

// ── v4 conversation channel (vertical cut)──
// The host only forwards: subscribe/unsubscribe/command is transparently transmitted to the CLI v4 gateway.
// v4/conversation/frame notifications are given to renderers by workspace fan-out.

export interface ZCodeAgentConversationSubscribeParams extends ZCodeAgentSessionTarget {
  /** Watermark invariant: only allowed to be provided when the client really holds consistent state at that instant. */
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
}

export interface ZCodeAgentConversationUnsubscribeParams extends ZCodeAgentWorkspaceTarget {
  subscriptionId: string;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

export interface ZCodeAgentConversationResyncParams extends ZCodeAgentWorkspaceTarget {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

/** Row-paginated query (rows/range): takes one window of history rows by walking the cursor backwards. */
export interface ZCodeAgentConversationRowsRangeParams extends ZCodeAgentSessionTarget {
  /** Takes the rows with rowId < beforeRowId; by default = from the current tail backwards. */
  beforeRowId?: number;
  /** 1..rowsRangeMaxLimit (200). */
  limit: number;
}

/** The terminal-state ExitPlanMode catalog in the currently effective branch. */
export type ZCodeAgentConversationPlansParams = ZCodeAgentSessionTarget;

/** Event log pagination for a workflow run (the audit surface of the details page); cursor = journal sequence. */
export interface ZCodeAgentConversationWorkflowRunEventsParams extends ZCodeAgentSessionTarget {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

/** Enumeration of dwf runs (the discovery query after a restart). */
export interface ZCodeAgentConversationWorkflowRunsParams extends ZCodeAgentSessionTarget {
  limit?: number;
}

// ── dwf user interface product──
// ⚠ Terminology: artifact = the output of the script published to **users** via `artifact.*` (file/markdown/preset Kanban),
// Not the top-level return value of run (the engine's internal name for the latter).

/** The artifact manifest; the durable read path for UI cold recovery and the hub details. */
export interface ZCodeAgentConversationWorkflowRunArtifactsParams extends ZCodeAgentSessionTarget {
  runId: string;
}

/** The data-fetch surface for preset dashboards; cursor = journal sequence (strictly greater than). */
export interface ZCodeAgentConversationWorkflowRunArtifactDataParams extends ZCodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  afterSequence?: number;
  limit?: number;
}

/** The bytes of a content artifact, one chunk at a time (≤ 512 KiB, shaped exactly like attachmentRead). */
export interface ZCodeAgentConversationWorkflowRunArtifactReadParams extends ZCodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  version: number;
  offset: number;
  limit: number;
}

// ── dwf workspace transcript──
/** The light row manifest: the files.* / git.* / world.run rows of a run, without the body text. */
export interface ZCodeAgentConversationWorkflowRunWorkspaceParams extends ZCodeAgentSessionTarget {
  runId: string;
}

/** The body text of one workspace node, shape-preservingly bounded by maxBytes (the default and the cap live on the CLI gateway side). */
export interface ZCodeAgentConversationWorkflowRunNodeResultParams extends ZCodeAgentSessionTarget {
  runId: string;
  siteId: string;
  ordinal: number;
  maxBytes?: number;
}

export interface ZCodeAgentBackgroundBashOutputParams extends ZCodeAgentSessionTarget {
  workId: string;
}

export interface ZCodeAgentConversationFileChangesParams extends ZCodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ZCodeAgentConversationFileRewindPreviewParams extends ZCodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ZCodeAgentConversationCommandParams extends ZCodeAgentWorkspaceTarget {
  envelope: CommandEnvelope;
  /** Host-internal only, used for the Browser Use runtime boundary; it does not enter the v4 wire envelope. */
  clientMode?: ZCodeTaskClientMode;
}

export interface ZCodeAgentCommandsQueryParams extends ZCodeAgentWorkspaceTarget {
  clock?: true;
  commands: CommandKey[];
}

/** The UI does not carry a connectionId; the connection scope injects the wire identity through a trusted carrier. */
export interface ZCodeAgentAttachmentBeginParams extends ZCodeAgentSessionTarget {
  uploadId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export interface ZCodeAgentAttachmentChunkParams extends ZCodeAgentSessionTarget {
  uploadId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface ZCodeAgentAttachmentTerminalParams extends ZCodeAgentSessionTarget {
  uploadId: string;
}

export interface ZCodeAgentAttachmentReadParams extends ZCodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  offset: number;
  limit: number;
}

export interface ZCodeAgentConversationAttachmentReadParams extends ZCodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
  offset: number;
  limit: number;
}

export interface ZCodeAgentConversationAttachmentStatParams extends ZCodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
}

export interface ZCodeAgentAttachmentPreviewSourceParams extends ZCodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
}

/** The transport control plane inside the host scope; the connectionId may only be injected through a trusted carrier. */
export interface ZCodeAgentConnectionFlowParams extends ZCodeAgentWorkspaceTarget {
  state: V4ConnectionFlowState;
}

/** sessions-index: the workspace-level list subscription (no sessionId dimension). */
export interface ZCodeAgentSessionsIndexSubscribeParams extends ZCodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  /**
   * The subscriber scope suffix: on the CLI side, subscription replacement is decided by
   * (connectionId, topic), so when several independent consumers inside the host process
   * (the renderer sidebar / the task-index syncer) subscribe to the same topic they must use
   * different connectionIds, otherwise they replace each other's subscription generations.
   * By default the shared host connection id is used.
   */
  subscriberScope?: string;
  /**
   * Passive observers such as task-list must use existing-only; when the runtime does not exist a
   * stable unavailable is returned, and starting the Agent just to establish a list subscription is
   * forbidden. The default preserves the old behavior of explicit session entry points.
   */
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

/** workspace-config: the workspace-level config catalog subscription (config options + the slash catalog). */
export interface ZCodeAgentWorkspaceConfigSubscribeParams extends ZCodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

export type ZCodeAgentServiceEvent =
  | { type: "session.event"; event: ZCodeSessionEvent }
  | { type: "state.updated"; notification: ZCodeStateUpdatedNotification }
  | { type: "permission.request"; request: ZCodePermissionRequestParams }
  | { type: "userInput.request"; request: ZCodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: ZCodeUserInputResponse;
    }
  | { type: "snapshot"; snapshot: ZCodeSessionStateSnapshot };

export interface ZCodeAgentAppRuntimePreferences {
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled?: boolean;
}

export interface ZCodeAgentLocalRuntimeChildProcesses {
  pid: number;
  provider: string;
  workspacePath: string;
  lane?: string;
  children: ZCodeProcessChildProcess[];
}

export interface ZCodeAgentStorageStartupSnapshot {
  generation: number;
  state: ZCodeStorageStartupState | null;
}

export interface IZCodeAgentService {
  /** The control plane needs no account or model and sends no ordinary protocol request. */
  prepareStorage(params: ZCodeAgentWorkspaceTarget): Promise<void>;
  getStorageStartupState(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodeAgentStorageStartupSnapshot | null>;
  onDynamicStorageStartupState(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ZCodeAgentStorageStartupSnapshot>;
  initialize(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAgentInitializeResult>;
  /**
   * Syncs the App's global runtime preferences to every already-active workspace; idle Agents must
   * not be started for this.
   */
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  getWorkspaceRuntimeIdentity(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodeAgentWorkspaceRuntimeIdentity>;
  createSession(params: ZCodeAgentCreateSessionParams): Promise<ZCodeSessionStateSnapshot>;
  resumeSession(params: ZCodeAgentResumeSessionParams): Promise<ZCodeSessionStateSnapshot>;
  listSessions(params: ZCodeAgentListSessionsParams): Promise<ZCodeSessionInfo[]>;
  listSessionSubagents(
    params: ZCodeAgentListSessionSubagentsParams,
  ): Promise<ZCodeSessionSubagentsResult>;
  getAppUsageStats(params: ZCodeAgentAppUsageParams): Promise<AppUsageSnapshot>;
  getTaskTokenUsage(params: ZCodeAgentTaskTokenUsageParams): Promise<ZCodeTaskTokenUsageResult>;
  readSession(params: ZCodeAgentReadSessionParams): Promise<ZCodeSessionStateSnapshot>;
  readSessionMessages(
    params: ZCodeAgentReadSessionMessagesParams,
  ): Promise<ZCodeMessageWithParts[]>;
  readSessionDebug(params: ZCodeAgentSessionTarget): Promise<SessionDebugSnapshot>;
  readSessionEvents(params: ZCodeAgentReadSessionEventsParams): Promise<ZCodeSessionEvent[]>;
  readWorkspacePresentation(
    params: ZCodeAgentReadWorkspacePresentationParams,
  ): Promise<ZCodeWorkspacePresentation>;
  /** Pre-trust for Settings without a task/session; the Agent re-discovers and validates the canonical snapshot. */
  grantWorkspaceHookTrust(
    params: ZCodeAgentGrantWorkspaceHookTrustParams,
  ): Promise<ZCodeWorkspaceHookTrustGrantResult>;
  listMcpServerStatuses(params: ZCodeAgentListMcpServerStatusesParams): Promise<ZCodeMcpListResult>;
  listPlugins(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsListResult>;
  /**
   * The Plugin conversation reference catalog: a session-scoped read-only projection.
   * It goes through the workspace-level agent client (session records only exist in that process),
   * not a separate plugin management process.
   */
  getPluginReferenceCatalog(
    params: ZCodeAgentPluginReferenceCatalogParams,
  ): Promise<ZCodePluginsReferenceCatalogResult>;
  /** The Composer Skill reference catalog; with a sessionId it reads that runtime's frozen snapshot. */
  getSkillReferenceCatalog(
    params: ZCodeAgentSkillReferenceCatalogParams,
  ): Promise<ZCodeSkillsReferenceCatalogResult>;
  // GUI hub for saved workflows: workspace level, no session, scan `<cwd>/.zcode/workflows/` for each call.
  // Global file transfer `scope: "global"`: If the workspace is provided, it will be used as the carrier. If it is not provided, the services layer will choose the local carrier runtime.
  listSavedWorkflows(params: ZCodeAgentListSavedWorkflowsParams): Promise<ZCodeWorkflowsListResult>;
  getSavedWorkflow(params: ZCodeAgentGetSavedWorkflowParams): Promise<ZCodeWorkflowsGetResult>;
  updateSavedWorkflowMeta(
    params: ZCodeAgentUpdateSavedWorkflowMetaParams,
  ): Promise<ZCodeWorkflowsUpdateMetaResult>;
  deleteSavedWorkflow(
    params: ZCodeAgentDeleteSavedWorkflowParams,
  ): Promise<ZCodeWorkflowsDeleteResult>;
  listSavedWorkflowRuns(
    params: ZCodeAgentListSavedWorkflowRunsParams,
  ): Promise<ZCodeWorkflowsRunsResult>;
  // Move files with the same name between project files/global files:
  // `workspace` is the carrier (move to the project to transfer the target project, move to the global transfer to the source project), `to` is the drop-in file; it does not overwrite the existing target.
  moveSavedWorkflow(params: ZCodeAgentMoveSavedWorkflowParams): Promise<ZCodeWorkflowsMoveResult>;
  resolveSuggestedPluginReference(
    params: ZCodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@zcode/shared").ZCodePluginsResolveSuggestedReferenceResult>;
  /** Operation-scoped refresh progress for a suggested Plugin that was missing on its first local check. */
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<ZCodePluginOperationProgressNotification>;
  getPluginsOverview(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsOverviewResult>;
  /**
   * The resource manager: enumerates every local Agent process in this Host (including the plugin /
   * mcp-status lanes) and asks each live runtime for `process/childProcesses`; a single runtime
   * failure only leaves its children empty.
   */
  collectLocalRuntimeChildProcesses(
    signal?: AbortSignal,
  ): Promise<ZCodeAgentLocalRuntimeChildProcesses[]>;
  addPluginMarketplace(
    params: ZCodeAgentAddPluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: ZCodeAgentRemovePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: ZCodeAgentUpdatePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  installPlugin(params: ZCodeAgentInstallPluginParams): Promise<ZCodePluginsInstallResult>;
  cancelPluginOperation(
    params: ZCodeAgentCancelPluginOperationParams,
  ): Promise<ZCodePluginsCancelOperationResult>;
  uninstallPlugin(params: ZCodeAgentUninstallPluginParams): Promise<ZCodePluginsUninstallResult>;
  updatePlugin(params: ZCodeAgentUpdatePluginParams): Promise<ZCodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: ZCodeAgentRestoreBuiltinPluginParams,
  ): Promise<ZCodePluginsRestoreBuiltinResult>;
  configurePlugin(params: ZCodeAgentConfigurePluginParams): Promise<ZCodePluginsConfigureResult>;
  resetPluginConfig(
    params: ZCodeAgentResetPluginConfigParams,
  ): Promise<ZCodePluginsConfigureResult>;
  validatePlugin(params: ZCodeAgentValidatePluginParams): Promise<ZCodePluginsValidateResult>;
  describePlugin(params: ZCodeAgentDescribePluginParams): Promise<ZCodePluginsDescribeResult>;
  setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams): Promise<ZCodePluginsSetEnabledResult>;
  // ---- Scheduled task (automation) management ----
  listAutomations(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAutomation[]>;
  listAllAutomations(): Promise<ZCodeAutomation[]>;
  createAutomation(params: ZCodeAgentCreateAutomationParams): Promise<ZCodeAutomation>;
  updateAutomation(params: ZCodeAgentUpdateAutomationParams): Promise<ZCodeAutomation | null>;
  deleteAutomation(params: ZCodeAgentAutomationIdParams): Promise<void>;
  setAutomationEnabled(params: ZCodeAgentSetAutomationEnabledParams): Promise<void>;
  restartAutomation(params: ZCodeAgentAutomationIdParams): Promise<void>;
  runAutomationNow(params: ZCodeAgentAutomationIdParams): Promise<ZCodeAgentRunAutomationNowResult>;
  listAutomationRuns(params: ZCodeAgentAutomationIdParams): Promise<ZCodeAutomationRun[]>;
  deleteAutomationRun(params: ZCodeAgentDeleteAutomationRunParams): Promise<void>;
  generateWorkspaceText(
    params: ZCodeAgentGenerateWorkspaceTextParams,
  ): Promise<ZCodeWorkspaceGenerateTextResult>;
  testModelConnectivity(
    params: ZCodeAgentTestModelConnectivityParams,
  ): Promise<ZCodeProviderTestModelConnectivityResult>;
  /**
   * @deprecated: the send main path has converged on the v4 sendText command. Only two consumers
   * remain — the adapter's fallback for attachment input (to be removed once the attachment command
   * surface lands) and the zcodeSessionService pass-through; new code must not use it again.
   */
  sendPrompt(params: ZCodeAgentSendPromptParams): Promise<ZCodeSessionSendResult>;
  compactSession(params: ZCodeAgentCompactParams): Promise<ZCodeSessionCompactResult>;
  goalSession(params: ZCodeAgentGoalParams): Promise<ZCodeSessionGoalResult>;
  closeSession(
    params: ZCodeAgentSessionTarget & { expectedPersistence?: "deferred" | "immediate" },
  ): Promise<boolean>;
  setModel(params: ZCodeAgentSetModelParams): Promise<ZCodeSessionStateSnapshot>;
  setThoughtLevel(params: ZCodeAgentSetThoughtLevelParams): Promise<ZCodeSessionStateSnapshot>;
  setMode(params: ZCodeAgentSetModeParams): Promise<ZCodeSessionStateSnapshot>;
  respondSessionRuntimePreferences(
    params: ZCodeAgentRespondSessionRuntimePreferencesParams,
  ): Promise<void>;
  onDynamicSessionRuntimePreferencesRequest(): Event<ZCodeAgentSessionRuntimePreferencesRequest>;
  /**
   * A CLI process-level resource sample, carrying the lane label applied by services (the CLI itself
   * does not know the lane). A dynamic event is used so the RPC service does not buffer periodic
   * events when nobody subscribes; this event is not part of the session/conversation continuous or
   * replayable state.
   */
  onDynamicProcessResourceSample(): Event<AgentLaneResourceSample>;
  /** MCP process lifecycle and low-frequency memory events, only for a trusted Host relay to report to ARMS. */
  onDynamicMcpTelemetry(): Event<ZCodeMcpTelemetryEvent>;
  /** MCP process tree resource facts, only for a trusted Host to aggregate and report. */
  onDynamicMcpResourceSamples(): Event<ZCodeMcpResourceSample[]>;
  /** Bash completion facts, subscribed to only by a trusted Host resource side channel. */
  onDynamicToolExecResource(): Event<ZCodeToolExecResource>;
  /**
   * @deprecated The legacy protocol subscription surface (session/subscribe + session/event + state.updated).
   * The task-index syncer has migrated to v4 sessions-index/workspace-config frames; only
   * zcodeTaskServiceAdapter.onDynamicTaskEvent (the replayable read path) still consumes it.
   * The write path has converged on the v4 command surface; this subscription is the projection
   * source for the read path.
   */
  onDynamicSessionEvent(params: ZCodeAgentSessionSubscribeParams): Event<ZCodeAgentServiceEvent>;
  // ── v4 conversation channel (vertical cut)──
  /** Reads the host-trusted hello first, after the RPC attachment is established. */
  helloConversationV4(): Promise<HelloMessage>;
  /** Sends back the clientHello after hello validation; metadata cannot override the connection mode/profile. */
  initializeConversationV4(clientHello: ClientHello): Promise<void>;
  /** For the trusted host relay/facade only; a terminal RPC caller must be rejected by the connection scope. */
  setConnectionFlowStateV4(params: ZCodeAgentConnectionFlowParams): Promise<void>;
  subscribeConversationV4(
    params: ZCodeAgentConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** The rows/range row-paginated query (loadOlder walks the cursor backwards to backfill history). */
  conversationRowsRangeV4(
    params: ZCodeAgentConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  conversationPlansV4(
    params: ZCodeAgentConversationPlansParams,
  ): Promise<V4ConversationPlansResult>;
  /** Workflow run event log pagination; of the same family as plans (read-only, stateless, safe to resend after a timeout). */
  conversationWorkflowRunEventsV4(
    params: ZCodeAgentConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** Workflow run enumeration; the journal-backed discovery surface after a restart. */
  conversationWorkflowRunsV4(
    params: ZCodeAgentConversationWorkflowRunsParams,
  ): Promise<V4ConversationWorkflowRunsResult>;
  /** The user-facing artifact manifest of a workflow run; of the same family as plans (read-only, stateless, safe to resend after a timeout). */
  conversationWorkflowRunArtifactsV4(
    params: ZCodeAgentConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** Item pagination for preset dashboards; the hook pulls incrementally, using itemCount changes as the signal. */
  conversationWorkflowRunArtifactDataV4(
    params: ZCodeAgentConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** The bytes of a content artifact, one chunk at a time; authorization lives on the CLI side (only the journal row is grounds for reading the bytes). */
  conversationWorkflowRunArtifactReadV4(
    params: ZCodeAgentConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** The manifest of the dwf workspace transcript. */
  conversationWorkflowRunWorkspaceV4(
    params: ZCodeAgentConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** The bounded body text of one workspace node. */
  conversationWorkflowRunNodeResultV4(
    params: ZCodeAgentConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  backgroundBashOutputV4(
    params: ZCodeAgentBackgroundBashOutputParams,
  ): Promise<BackgroundBashOutputResult>;
  conversationFileChangesV4(
    params: ZCodeAgentConversationFileChangesParams,
  ): Promise<V4ConversationFileChangesResult>;
  conversationFileRewindPreviewV4(
    params: ZCodeAgentConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  sendConversationCommandV4(params: ZCodeAgentConversationCommandParams): Promise<CommandAck>;
  queryConversationCommandsV4(params: ZCodeAgentCommandsQueryParams): Promise<CommandsQueryResult>;
  attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams): Promise<V4AttachmentCommitResult>;
  attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams): Promise<void>;
  /** The source query for a video already sent by Desktop local; remote and Web return chunked. */
  attachmentPreviewSourceV4(
    params: ZCodeAgentAttachmentPreviewSourceParams,
  ): Promise<V4AttachmentPreviewSourceResult>;
  /** The read-only chunked query for an already-sent image/video; the connection scope injects the trusted workspace connection. */
  attachmentReadV4(params: ZCodeAgentAttachmentReadParams): Promise<V4AttachmentReadResult>;
  /** Share reads a userInput attachment, allowing non-media types such as text/plain. */
  conversationAttachmentReadV4(
    params: ZCodeAgentConversationAttachmentReadParams,
  ): Promise<V4ConversationAttachmentReadResult>;
  /** The Share selection phase only reads userInput attachment metadata, not the full content. */
  conversationAttachmentStatV4(
    params: ZCodeAgentConversationAttachmentStatParams,
  ): Promise<V4ConversationAttachmentStatResult>;
  /** The workspace-level downstream frame stream (v4/conversation/frame); the renderer side routes by topic itself. */
  onDynamicConversationFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ConversationTopicWireCandidate>;
  /** Workspace-level live telemetry facts; the connection facade only exposes them to trusted desktop-continuous downstreams. */
  onDynamicLocalTtftFacts(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<import("@zcode/shared").LocalTtftFacts>;
  onDynamicConversationTelemetryFact(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ConversationTelemetryFact>;
  /** CUA permission observations for every local live task in the current window; history, remote and replayable are not on this event surface. */
  onDynamicCuaPermissionObservation(): Event<ZCodeAgentCuaPermissionObservation>;
  // ── sessions-index channel (list active)──
  subscribeSessionsIndexV4(
    params: ZCodeAgentSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult>;
  resyncSessionsIndexV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeSessionsIndexV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** The workspace-level sessions-index downstream frame stream (the same notification as conversation, demultiplexed by topic prefix). */
  onDynamicSessionsIndexFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<SessionsIndexTopicWireCandidate>;
  // ── workspace-config channel (configuration directory activity; task-index syncer consumption)──
  subscribeWorkspaceConfigV4(
    params: ZCodeAgentWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult>;
  resyncWorkspaceConfigV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeWorkspaceConfigV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** The workspace-level workspace-config downstream frame stream (the same notification as conversation, demultiplexed by topic prefix). */
  onDynamicWorkspaceConfigFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate>;
  /**
   * (CLI reconnect resubscribe): notification that the agent process generation changed (restarted
   * after a timeout reclaim or a crash). A v4 subscription lives in the CLI process's memory, so it
   * dies with the process; subscribers (the task-index syncer and others) must resend subscribe for
   * that workspaceKey once they receive this, otherwise the frame stream breaks silently.
   */
  onAgentRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): IDisposable;
  /**
   * Publishes available once the Agent client has finished registering inside the service, and
   * unavailable after the current client closes. This is the only lifecycle signal for a passive
   * observer's attach/detach and does not express a user usage lease.
   */
  onAgentRuntimeLifecycle?: (
    listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void,
  ) => IDisposable;
  /** Whether the current desktop-local CUA turn is still executing, used by Helper recovery so it does not reclaim the Agent midway. */
  hasActiveCuaOperationTurn(): boolean;
  disposeWorkspace(params: ZCodeAgentWorkspaceTarget): Promise<void>;
  disposeAll(): void;
}

export const IZCodeAgentService = createServiceDescriptor<IZCodeAgentService>(
  ServiceChannels.ZCodeAgent,
);
