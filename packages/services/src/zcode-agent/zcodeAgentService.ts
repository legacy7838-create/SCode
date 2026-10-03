import { requestPluginReferenceCatalog } from "#src/zcode-agent/pluginReferenceCatalogRequest.js";
import {
  localTtftFactsSchema,
  sessionDebugSnapshotSchema,
  type LocalTtftFacts,
} from "@zcode/shared";
/* oxlint-disable eslint(max-lines) -- ZCode Protocol transport, notification wiring, and app-facing session methods must share the same client/emitter context. */
import { randomUUID } from "node:crypto";
import { ensureIndependentPlanSupport } from "./independentPlanSupport.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import type { IDisposable } from "@zcode/rpc";
import type {
  AccountProviderConfigSnapshot,
  ModelSelectionView,
  ProviderSource,
} from "@zcode/provider";
import { completeNewModelSelection } from "@zcode/provider";
import type { OffPeakClientConfig } from "#src/coding-plan-subscription/codingPlanSubscription.js";
import {
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  formatLogPrefix,
  resolveWorkspaceKey,
  type TraceId,
  ZCODE_AGENT_PROVIDER,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
  ZCODE_MODEL_REASONING_SEPARATOR,
  isRemoteWorkspaceIdentity,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeMcpListResultSchema,
  zcodePermissionRequestParamsSchema,
  zcodeBrowserListParamsSchema,
  zcodeBrowserExecuteParamsSchema,
  zcodePluginsConfigureResultSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsListResultSchema,
  zcodePluginsMarketplaceMutationResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodeProcessChildProcessesResultSchema,
  type ZCodeProcessChildProcess,
  zcodeSkillsReferenceCatalogResultSchema,
  zcodeWorkflowsDeleteResultSchema,
  zcodeWorkflowsGetResultSchema,
  zcodeWorkflowsListResultSchema,
  zcodeWorkflowsMoveResultSchema,
  zcodeWorkflowsRunsResultSchema,
  zcodeWorkflowsUpdateMetaResultSchema,
  zcodePluginsResolveSuggestedReferenceResultSchema,
  zcodePluginOperationProgressNotificationSchema,
  zcodePluginsRestoreBuiltinResultSchema,
  zcodePluginsSetEnabledResultSchema,
  zcodePluginsCancelOperationResultSchema,
  zcodePluginsUninstallResultSchema,
  zcodePluginsValidateResultSchema,
  zcodePluginsDescribeResultSchema,
  zcodeAutomationCheckTaskBindingParamsSchema,
  zcodeAutomationCreateParamsSchema,
  zcodeAutomationDeleteParamsSchema,
  zcodeAutomationListParamsSchema,
  zcodeAutomationUpdateParamsSchema,
  zcodeOffPeakCreateParamsSchema,
  zcodeOffPeakListParamsSchema,
  OFF_PEAK_PROVIDER_IDS,
  zcodeComputerUseOperationEventSchema,
  zcodeProviderRuntimeHeadersCancelledSchema,
  zcodeProviderRuntimeHeadersRequestParamsSchema,
  zcodeProviderTestModelConnectivityResultSchema,
  zcodeOfficialMcpAuthHeadersRequestParamsSchema,
  summarizeOfficialMcpIdentityHeaders,
  zcodeProtocolEmptyResultSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeMcpTelemetryEventSchema,
  zcodeMcpResourceSamplesSchema,
  zcodeToolExecResourceSchema,
  zcodeProcessResourceSampleSchema,
  zcodeSessionCloseResultSchema,
  zcodeSessionCompactResultSchema,
  zcodeSessionEventsResultSchema,
  zcodeSessionGoalResultSchema,
  zcodeSessionListResultSchema,
  zcodeSessionSubagentsResultSchema,
  zcodeSessionMessagesResultSchema,
  zcodeSessionEventSchema,
  zcodeSessionSendResultSchema,
  zcodeSessionRequestRuntimePreferencesParamsSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeSessionSubscribeResultSchema,
  zcodeStateUpdatedNotificationSchema,
  zcodeUserInputRequestParamsSchema,
  zcodeWorkspacePresentationSchema,
  zcodeWorkspaceCancelGenerateTextResultSchema,
  zcodeWorkspaceGenerateTextResultSchema,
  zcodeWorkspaceHookTrustGrantResultSchema,
  zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
  zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
  zcodeProviderUpdateAccountConfigResultSchema,
  type ZCodeSessionStateSnapshot,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
  zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
  type DynamicWorkflowClientConfig,
  type AgentLaneResourceSample,
  type ProcessResourceCliLane,
  type ZCodeMcpTelemetryEvent,
  type ZCodeMcpResourceSample,
  type ZCodeToolExecResource,
  type ZCodePluginOperationProgressNotification,
  type ZCodeTaskMode,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { createOfficialMcpIssuanceAudit } from "#src/official-mcp/officialMcpIssuanceAudit.js";
import type {
  AccountRequestAuthMaterial,
  IAccountRequestAuthService,
} from "#src/model-provider/accountRequestAuthService.js";
import {
  mergeAutomationMutationToolDenylist,
  mergeOffPeakMutationToolDenylist,
} from "#src/zcode-agent/automationToolPolicy.js";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./zcodeAgent.js";
import type {
  ZCodeProtocolRequestId,
  ModelSelection,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeSessionEvent,
  ZCodeSessionRuntimePreferencesScope,
  ZCodeSavedWorkflowScope,
  ZCodeStateUpdatedNotification,
  ZCodeWorkspacePresentation,
  ZCodeWorkspaceRef,
  ZCodeSessionRuntimePreferencesResult,
} from "@zcode/shared";
import type {
  IZCodeAgentService,
  ZCodeAgentBackgroundBashOutputParams,
  ZCodeAgentAppRuntimePreferences,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentAppUsageParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentCompactParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentGenerateWorkspaceTextParams,
  ZCodeAgentTestModelConnectivityParams,
  ZCodeAgentGoalParams,
  ZCodeAgentGrantWorkspaceHookTrustParams,
  ZCodeAgentInitializeResult,
  ZCodeAgentListSessionsParams,
  ZCodeAgentListSessionSubagentsParams,
  ZCodeAgentReadWorkspacePresentationParams,
  ZCodeAgentReadSessionEventsParams,
  ZCodeAgentReadSessionMessagesParams,
  ZCodeAgentReadSessionParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentRespondSessionRuntimePreferencesParams,
  ZCodeAgentResumeSessionParams,
  ZCodeAgentSendPromptParams,
  ZCodeAgentServiceEvent,
  ZCodeAgentSessionSubscribeParams,
  ZCodeAgentSessionTarget,
  ZCodeAgentSessionRuntimePreferencesRequest,
  ZCodeAgentTaskTokenUsageParams,
  ZCodeAgentSetModeParams,
  ZCodeAgentSetModelParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentSetThoughtLevelParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentSkillReferenceCatalogParams,
  ZCodeAgentDeleteSavedWorkflowParams,
  ZCodeAgentGetSavedWorkflowParams,
  ZCodeAgentListSavedWorkflowRunsParams,
  ZCodeAgentListSavedWorkflowsParams,
  ZCodeAgentMoveSavedWorkflowParams,
  ZCodeAgentSavedWorkflowTarget,
  ZCodeAgentUpdateSavedWorkflowMetaParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentValidatePluginParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentListMcpServerStatusesParams,
  ZCodeAgentWorkspaceTarget,
  ZCodeAgentCuaPermissionObservation,
  ZCodeAgentCreateAutomationParams,
  ZCodeAgentUpdateAutomationParams,
  ZCodeAgentAutomationIdParams,
  ZCodeAgentSetAutomationEnabledParams,
  ZCodeAgentDeleteAutomationRunParams,
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentReadParams,
  ZCodeAgentConversationAttachmentReadParams,
  ZCodeAgentConversationAttachmentStatParams,
  ZCodeAgentAttachmentPreviewSourceParams,
  ZCodeAgentAttachmentTerminalParams,
  ZCodeAgentConversationCommandParams,
  ZCodeAgentCommandsQueryParams,
  ZCodeAgentConversationFileChangesParams,
  ZCodeAgentConversationFileRewindPreviewParams,
  ZCodeAgentConversationRowsRangeParams,
  ZCodeAgentConversationPlansParams,
  ZCodeAgentConversationWorkflowRunEventsParams,
  ZCodeAgentConversationWorkflowRunArtifactDataParams,
  ZCodeAgentConversationWorkflowRunArtifactReadParams,
  ZCodeAgentConversationWorkflowRunArtifactsParams,
  ZCodeAgentConversationWorkflowRunNodeResultParams,
  ZCodeAgentConversationWorkflowRunWorkspaceParams,
  ZCodeAgentConversationWorkflowRunsParams,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationSubscribeParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentConnectionFlowParams,
  ZCodeAgentSessionsIndexSubscribeParams,
  ZCodeAgentWorkspaceConfigSubscribeParams,
} from "./zcodeAgent.js";
import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  V4_WIRE_PROTOCOL_VERSION,
  PROTOCOL_V4_LIMITS,
  clientHelloSchema,
  commandAckSchema,
  commandPayloadSchemas,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  conversationTopic,
  conversationTopicWireCandidateSchema,
  conversationTelemetryFactSchema,
  cuaPermissionObservationSchema,
  sessionsIndexTopic,
  sessionsIndexTopicWireCandidateSchema,
  MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE,
  V4_METHODS,
  V4_NOTIFICATIONS,
  v4AttachmentAbortResultSchema,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4AttachmentReadResultSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  v4ConnectionFlowResultSchema,
  v4ConversationFileChangesResultSchema,
  v4ConversationFileRewindPreviewResultSchema,
  v4ConversationRowsRangeResultSchema,
  v4ConversationPlansResultSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  v4ConversationWorkflowRunsResultSchema,
  v4ConversationResyncResultSchema,
  v4ConversationSubscribeResultSchema,
  v4ConversationUsageResultSchema,
  v4SessionsIndexSubscribeResultSchema,
  v4UsageStatsResultSchema,
  v4WorkspaceConfigSubscribeResultSchema,
  workspaceConfigTopic,
  workspaceConfigTopicWireCandidateSchema,
  utf8JsonByteLength,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  type CommandAck,
  type ConversationTopicWireCandidate,
  type ConversationTelemetryFact,
  type SessionsIndexTopicWireCandidate,
  type WorkspaceConfigTopicWireCandidate,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import {
  readTrustedZCodeAgentV4Connection,
  readTrustedZCodeAgentV4UnsubscribeRoute,
  type ZCodeAgentV4ConnectionContext,
} from "./zcodeAgentConnectionScope.js";
import { createBackgroundSessionEventCoalescer } from "#src/zcode-agent/zcodeSessionEventCoalescer.js";
import { AutomationService } from "#src/session/automationService.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { ZCodeAgentMcpStatusModeUnsupportedError } from "#src/zcode-agent/zcodeAgentErrors.js";
import { ZCodeAgentProcessManager } from "./zcodeAgentProcessManager.js";
import type { ZCodeAgentProcessManagerOptions } from "./zcodeAgentProcessManager.js";
import type { IOffPeakTaskService } from "#src/session/offPeakTask.js";
import {
  ZCodeProtocolRequestTimeoutError,
  type ZCodeProtocolClient,
} from "./zcodeProtocolClient.js";
import { getDataBaseDir } from "../paths.js";
import {
  collectBrowserAmbientContext,
  type BrowserAmbientContextExecutor,
} from "./zcodeAgentBrowserAmbientContext.js";
import {
  createCuaOperationTurnTracker,
  type CuaOperationWorkspaceTarget,
  type CuaOperationStateReporter,
} from "./cuaOperationTurnTracker.js";
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

const logger = createServiceLogger("zcode-agent-service");
const cuaOperationLogger = createServiceLogger("cua-operation-turn");
const PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME = "plugin-workspace";
// After the status detection is completed, the idle MCP sub-process is released; it only acts on the control plane and does not recycle the session process.
const MCP_STATUS_LANE_IDLE_TIMEOUT_MS = 5 * 60_000;
// The first access to the official Claude marketplace requires cloning/copying the GitHub repository. The default protocol timeout of 30 seconds will kill the health agent.
// Plug-in market management is a low-frequency network I/O operation. Relaxing the timeout independently does not affect the real-time failure boundary of ordinary session messages.
const PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** The resource manager is refreshed every second; sub-process mapping is a pure memory request. If it times out, it will be treated as if there is no mapping in this round, and the sampling rhythm cannot be slowed down. */
const CHILD_PROCESSES_REQUEST_TIMEOUT_MS = 800;
const PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS = 5_000;
const SESSION_COMPACT_REQUEST_TIMEOUT_MS = 5 * 60_000;

interface PendingPermissionRequest {
  client: ZCodeProtocolClient;
  protocolRequestId: ZCodeProtocolRequestId;
}

interface PendingProviderRuntimeHeadersRequest extends PendingPermissionRequest {
  request: ZCodeProviderRuntimeHeadersRequestParams;
  responding?: boolean;
}

interface PendingSessionRuntimePreferencesRequest extends PendingPermissionRequest {
  request: ZCodeAgentSessionRuntimePreferencesRequest;
  timeout: ReturnType<typeof setTimeout>;
  workspaceKey: string;
}

type SessionCreateCompatField =
  | "persistence"
  | "thoughtLevel"
  | "mcpServers"
  | "toolAllowlist"
  | "toolDenylist"
  | "offPeakToolEnabled"
  | "dynamicWorkflowEnabled";
type SessionResumeCompatField =
  | "thoughtLevel"
  | "mcpServers"
  | "toolAllowlist"
  | "toolDenylist"
  | "offPeakToolEnabled"
  | "dynamicWorkflowEnabled";
type SessionSendCompatField =
  | "browserAmbientContext"
  | "automationId"
  | "offPeakTaskId"
  | "offPeakRunType"
  | "botDeliveryTarget"
  | "toolDenylist";

const SESSION_CREATE_OPTIONAL_COMPAT_FIELDS = new Set<SessionCreateCompatField>([
  "persistence",
  "thoughtLevel",
  "mcpServers",
  // CUA tool isolation is new: buildSessionCreateParams will bring toolAllowlist/toolDenylist. If the old app-server
  // The .strict() schema is not recognized and needs to be downgraded and retried instead of the entire createSession hard failing.
  "toolAllowlist",
  "toolDenylist",
  // The Off-Peak tool surface flag is also a downgradeable field; if the old app-server does not recognize it, retry will be omitted (the tool will not be registered and will fail-closed).
  "offPeakToolEnabled",
  // Dynamic workflow grayscale flag Same reason: the old CLI does not recognize time
  // By omitting the retry, the workflow tool cluster is not registered, never causing the entire create to hard fail.
  "dynamicWorkflowEnabled",
]);
const SESSION_RESUME_OPTIONAL_COMPAT_FIELDS = new Set<SessionResumeCompatField>([
  "thoughtLevel",
  "mcpServers",
  // Cold recovery also comes with tool surface constraints; old app-server does not retry when downgraded instead of hard failing (consistent with create).
  "toolAllowlist",
  "toolDenylist",
  "offPeakToolEnabled",
  "dynamicWorkflowEnabled",
]);
const SESSION_SEND_OPTIONAL_COMPAT_FIELDS = new Set<SessionSendCompatField>([
  "browserAmbientContext",
  "automationId",
  "offPeakTaskId",
  "offPeakRunType",
  "botDeliveryTarget",
  "toolDenylist",
]);
// onDynamicSessionEvent If getClient / sessionSubscribe fails instantaneously when establishing an upstream subscription
// (The agent process has just started, the runtime throws "Session is not active" race condition, and the transport jitters),
// If .catch(() => {}) is swallowed silently without retrying, the caller (including syncer shadow subscription) will
// emitter.event is cached as "subscription successful" and will never be rebuilt - the final event of this session will never arrive again.
// SQLite is stuck in the old state and the sidebar spinner keeps spinning. This is changed to a limited number of exponential backoff retries to cover the instantaneous failure window.
const SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS = 500;
const SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS = 5_000;
const SESSION_SUBSCRIBE_MAX_ATTEMPTS = 8;
const MAX_TRACKED_SESSION_EVENT_IDS = 10_000;
const SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:ssh:";
const WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:wsl:";

function supportsLegacyRemoteTaskAllowlist(workspaceIdentity: string | undefined): boolean {
  return Boolean(
    workspaceIdentity?.startsWith(SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX) ||
    workspaceIdentity?.startsWith(WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX),
  );
}

function isClosedStdioTransportError(error: unknown): boolean {
  return error instanceof Error && error.message === "ZCode agent stdio transport is closed";
}

interface SessionEventSequenceState {
  assignedSeqByEventId: Map<string, number>;
  assignedSeqEventIds: string[];
  liveEventIds: Set<string>;
  liveEventIdOrder: string[];
  lastAssignedSeq: number;
}

function isProtocolMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

function buildWorkspaceRef(params: ZCodeAgentWorkspaceTarget): ZCodeWorkspaceRef {
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    remoteSessionId: params.remoteSessionId,
    workspaceKey: resolveWorkspaceKey(params),
  };
}

// Whether the target of the saved workflow contains workspace: project file, and
// The GUI project team clearly states that all actions with `scope: "global"` have workspacePath; only those with `{ scope: "global" }`
// The global group action is not taken and is given to the services optional carrier.
function savedWorkflowTargetHasWorkspace(
  params: ZCodeAgentSavedWorkflowTarget,
): params is ZCodeAgentWorkspaceTarget & { scope?: ZCodeSavedWorkflowScope } {
  return typeof (params as Partial<ZCodeAgentWorkspaceTarget>).workspacePath === "string";
}

// Only push down to RPC params if `scope` is defined: project files that do not give a scope keep the same online shape as they do today verbatim.
function savedWorkflowScopeParam(params: ZCodeAgentSavedWorkflowTarget): {
  scope?: ZCodeSavedWorkflowScope;
} {
  return params.scope === undefined ? {} : { scope: params.scope };
}

function ensurePluginManagementWorkspacePath(): string {
  const workspacePath = join(getDataBaseDir(), ".zcode", PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME);
  // Plug-in management is a control plane capability and cannot reuse session processes that may EPIPE due to the real workspace being deleted.
  // Here, an internal cwd is fixed for it; the real workspace is still passed to the CLI through the protocol parameters for workspace-scope determination.
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

// NOTE: this counts ONLY the per-session MCP servers passed through the ZCode Protocol
// session/create params (the app→protocol channel). It is deliberately independent of the
// CLI/bootstrap MCP servers configured in ~/.zcode/cli/config.json (mcp.servers), which the agent
// runtime connects separately and reports via the `mcp.server.connected`/toolCount events. So a
// createSession log line with mcpServerCount:0 is EXPECTED when zcode-cua is a CLI-config MCP server
// (e.g. the product Helper broker path injected through the gated bootstrap env): the model still receives those
// tools — the two numbers describe different channels, not a missing tool set. Verified on-machine:
// real kimi-k2.6 turns call mcp__zcode-cua__* tools (get_app_state/type/open_application, status
// completed) in sessions whose createSession logged mcpServerCount:0.
function getMcpServerCount(params: { mcpServers?: readonly unknown[] }): number {
  return params.mcpServers?.length ?? 0;
}

function getMcpServerNames(params: { mcpServers?: readonly { name: string }[] }): string[] {
  return params.mcpServers?.map((server) => server.name) ?? [];
}

function parseInvalidParamsIssues(error: unknown): unknown[] {
  const errorLike = error as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
  };
  const message = errorLike.message;
  if (
    errorLike.code !== -32602 ||
    typeof message !== "string" ||
    (message !== "Invalid params" && !message.startsWith("Invalid params — "))
  ) {
    return [];
  }
  const data = errorLike.data;
  if (!data || typeof data !== "object") {
    return [];
  }
  // The new version of Agent will append the Zod digest to the top-level message, but the old compatible parsing will only accept strict equals
  // "Invalid params" causes the App/Agent version to be misaligned and the new field cannot be omitted to retry. Field judgment is still only trusted
  // Structured issues in data, field names cannot be guessed from mutable human-readable summaries.
  const serializedIssues = (data as { message?: unknown }).message;
  if (typeof serializedIssues !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(serializedIssues) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getUnrecognizedTopLevelKeys(error: unknown): string[] {
  const keys = new Set<string>();
  for (const issue of parseInvalidParamsIssues(error)) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const issueLike = issue as {
      code?: unknown;
      keys?: unknown;
      path?: unknown;
    };
    if (
      issueLike.code !== "unrecognized_keys" ||
      (Array.isArray(issueLike.path) && issueLike.path.length > 0) ||
      !Array.isArray(issueLike.keys)
    ) {
      continue;
    }
    for (const key of issueLike.keys) {
      if (typeof key === "string") {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

function getSessionCreateCompatFields(error: unknown): SessionCreateCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionCreateCompatField =>
      SESSION_CREATE_OPTIONAL_COMPAT_FIELDS.has(key as SessionCreateCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

function getSessionResumeCompatFields(error: unknown): SessionResumeCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionResumeCompatField =>
      SESSION_RESUME_OPTIONAL_COMPAT_FIELDS.has(key as SessionResumeCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

function getSessionSendCompatFields(error: unknown): SessionSendCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionSendCompatField =>
      SESSION_SEND_OPTIONAL_COMPAT_FIELDS.has(key as SessionSendCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

function isProtocolRequestTimeout(error: unknown, method: string): boolean {
  if (error instanceof ZCodeProtocolRequestTimeoutError) {
    return error.method === method;
  }
  return error instanceof Error && error.message === `ZCode Protocol request timed out: ${method}`;
}

function assertV4AttachmentNdjsonEnvelope(method: string, params: unknown): void {
  // Actual CLI request ids are increasing integers; here the wider 32-char id is used for a conservative exact-JSON meter.
  const bytes = utf8JsonByteLength({ id: "9".repeat(32), method, params }) + 1; // NDJSON newline
  if (bytes > PROTOCOL_V4_LIMITS.maxFrameBytes) {
    throw new Error("proto.frameTooLarge");
  }
}

function buildSessionCreateParams(
  params: ZCodeAgentCreateSessionParams & {
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
  },
  omittedFields: ReadonlySet<SessionCreateCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    workspace: buildWorkspaceRef(params),
    parentSessionId: params.parentSessionId,
    mode: params.mode,
    model: params.model,
    ...(params.persistence !== undefined && !omittedFields.has("persistence")
      ? { persistence: params.persistence }
      : {}),
    ...(params.thoughtLevel !== undefined && !omittedFields.has("thoughtLevel")
      ? { thoughtLevel: params.thoughtLevel }
      : {}),
    ...(params.titleGenerationEnabled !== undefined
      ? { titleGenerationEnabled: params.titleGenerationEnabled }
      : {}),
    // Desktop-continuous starts/restores the session service without going through the legacy task adapter.
    // Previously, the UI-parsed MCP was not brought into strict protocol params, and runtimeConfig could only see empty MCP.
    // MCP is a runtime startup configuration and must be passed explicitly at the create/resume request boundary. Subsequent sendPrompt cannot make up for it.
    ...(params.mcpServers !== undefined && !omittedFields.has("mcpServers")
      ? { mcpServers: params.mcpServers }
      : {}),
    // CUA tool isolation fields are downgradeable: if the old app-server's .strict() schema is not recognized, the compatibility retry will put them in
    // Retry after omitting omittedFields (instead of hard failing). Therefore, this must also be gated by omittedFields.
    ...(params.toolAllowlist !== undefined && !omittedFields.has("toolAllowlist")
      ? { toolAllowlist: params.toolAllowlist }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
    // importedHistory is the integrity boundary of imported history and cannot be like thoughtLevel/persistence
    // This is omitted in the old protocol compatibility retry, otherwise an empty session with a cuttable model but no historical content will be created.
    ...(params.importedHistory !== undefined ? { importedHistory: params.importedHistory } : {}),
    // True is only sent when grayscale hits (fields are not sent by default); compat is omitted when the old CLI strict schema does not recognize it.
    ...(params.offPeakToolEnabled === true && !omittedFields.has("offPeakToolEnabled")
      ? { offPeakToolEnabled: true }
      : {}),
    // Dynamic workflow grayscale: Same as Off-Peak’s delivery shape,
    // Do not write fields when closing - The CLI's default is not to register those nine tools.
    ...(params.dynamicWorkflowEnabled === true && !omittedFields.has("dynamicWorkflowEnabled")
      ? { dynamicWorkflowEnabled: true }
      : {}),
  };
}

function buildSessionResumeParams(
  params: ZCodeAgentResumeSessionParams & {
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
  },
  omittedFields: ReadonlySet<SessionResumeCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    workspace: buildWorkspaceRef(params),
    ...(params.thoughtLevel !== undefined && !omittedFields.has("thoughtLevel")
      ? { thoughtLevel: params.thoughtLevel }
      : {}),
    // When cold resuming a session, app-server may re-create the runtime; MCP also needs to be issued with the resume request.
    ...(params.mcpServers !== undefined && !omittedFields.has("mcpServers")
      ? { mcpServers: params.mcpServers }
      : {}),
    // Tool surface constraints must be consistent with the create path and be issued with resume, otherwise allow/deny will be lost after cold recovery rebuilds the runtime.
    // Quarantine (CUA sessions become visible again to banned tools like Bash). The old app-server does not recognize omittedFields when downgraded.
    ...(params.toolAllowlist !== undefined && !omittedFields.has("toolAllowlist")
      ? { toolAllowlist: params.toolAllowlist }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
    // Resume without this flag will cause cold recovery to lose the Off-Peak tool surface (same reason as toolAllowlist).
    ...(params.offPeakToolEnabled === true && !omittedFields.has("offPeakToolEnabled")
      ? { offPeakToolEnabled: true }
      : {}),
    // Same reason: Resume without this flag will cause cold recovery to lose the workflow tool cluster.
    ...(params.dynamicWorkflowEnabled === true && !omittedFields.has("dynamicWorkflowEnabled")
      ? { dynamicWorkflowEnabled: true }
      : {}),
  };
}

function buildSessionSendParams(
  params: ZCodeAgentSendPromptParams,
  omittedFields: ReadonlySet<SessionSendCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    // Execution identities/constraints are not ignorable compatibility fields; old Workers must fail when not supported and cannot be stripped silently.
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
    inputId: params.inputId,
    queryId: params.queryId,
    content: params.content,
    attachments: params.attachments,
    ...(params.browserAmbientContext !== undefined && !omittedFields.has("browserAmbientContext")
      ? { browserAmbientContext: params.browserAmbientContext }
      : {}),
    expectedRevision: params.expectedRevision,
    expectedProviderRevision: params.expectedProviderRevision,
    ...(params.automationId !== undefined && !omittedFields.has("automationId")
      ? { automationId: params.automationId }
      : {}),
    ...(params.offPeakTaskId !== undefined && !omittedFields.has("offPeakTaskId")
      ? { offPeakTaskId: params.offPeakTaskId }
      : {}),
    ...(params.offPeakRunType !== undefined && !omittedFields.has("offPeakRunType")
      ? { offPeakRunType: params.offPeakRunType }
      : {}),
    ...(params.botDeliveryTarget !== undefined && !omittedFields.has("botDeliveryTarget")
      ? { botDeliveryTarget: params.botDeliveryTarget }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
  };
}

function buildSessionCompactParams(params: ZCodeAgentCompactParams) {
  return {
    sessionId: params.sessionId,
    inputId: params.inputId,
    instructions: params.instructions,
    expectedRevision: params.expectedRevision,
  };
}

function formatModelSelectionForLog(ref: ModelSelection | undefined): string | null {
  if (!ref) {
    return null;
  }

  const base = `${ref.providerId}/${ref.modelId}`;
  const reasoningLevel = ref.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

function sessionEventKey(params: ZCodeAgentSessionTarget): string {
  return `${resolveWorkspaceKey(params)}\u0000${params.sessionId}`;
}

function rememberBoundedEventId(ids: Set<string>, order: string[], eventId: string): boolean {
  if (ids.has(eventId)) {
    return false;
  }
  ids.add(eventId);
  order.push(eventId);
  while (order.length > MAX_TRACKED_SESSION_EVENT_IDS) {
    const removed = order.shift();
    if (removed) {
      ids.delete(removed);
    }
  }
  return true;
}

function permissionRequestKey(params: ZCodeAgentSessionTarget & { requestId: string }): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

function userInputRequestKey(params: ZCodeAgentSessionTarget & { requestId: string }): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

function providerRuntimeHeadersRequestKey(
  params: ZCodeAgentSessionTarget & { requestId: string },
): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

/**
 * A read-only selection projection of the process-level Provider Registry.
 *
 * The local Worker holds the complete Registry; the Host only uses this projection to determine whether model execution can be started.
 * It can no longer be expanded into a runtimeModel and override the Worker's execution fact source.
 */
interface ModelSelectionReadinessSource {
  getView(): Promise<ModelSelectionView>;
  onDidChange?: (listener: (view: ModelSelectionView) => void) => IDisposable;
}

interface ZCodeAgentProviderReadinessSnapshot {
  readonly providerCount: number;
  readonly revision: string;
  readonly readiness: {
    readonly ready: boolean;
    readonly providerId?: string;
    readonly modelId?: string;
  };
}

function createProviderReadinessSnapshotFromSelectionView(
  view: ModelSelectionView,
): ZCodeAgentProviderReadinessSnapshot {
  for (const provider of view.providers) {
    const model = provider.models[0];
    if (!model) continue;
    return {
      providerCount: view.providers.length,
      revision: `model-selection:${view.revision}`,
      readiness: {
        ready: true,
        providerId: provider.providerId,
        modelId: model.modelId,
      },
    };
  }
  return {
    providerCount: view.providers.length,
    revision: `model-selection:${view.revision}`,
    readiness: { ready: false },
  };
}

interface WaitingWorkspaceStartup {
  cancelled: boolean;
  lastLoggedRevision?: string;
  workspace: ZCodeAgentWorkspaceTarget;
}

interface ActiveWorkspaceClient {
  client: ZCodeProtocolClient;
  interactionPreferencesReady?: Promise<void>;
  /**
   * Only records whether access control has been started through provider/model during the life cycle of the process.
   * A read-only topic can start the CLI first, but it cannot allow subsequent create/command to bypass the access control.
   */
  modelExecutionEnabled: boolean;
  workspace: ZCodeAgentWorkspaceTarget;
}

function createRuntimeUnavailableError(params: ZCodeAgentWorkspaceTarget): Error & {
  code: typeof ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  workspaceKey: string;
} {
  const error = new Error("ZCode Agent runtime is not running.") as Error & {
    code: typeof ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
    workspaceKey: string;
  };
  error.code = ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  error.workspaceKey = resolveWorkspaceKey(params);
  return error;
}

interface CreateZCodeAgentServiceOptions extends Omit<
  ZCodeAgentProcessManagerOptions,
  "idleTimeoutMs"
> {
  /** Only used by MCP status detection process, idle collection cannot be passed to chat. */
  mcpStatusIdleTimeoutMs?: number;
  accountProviderConfigSource?: ProviderSource<AccountProviderConfigSnapshot>;
  accountRequestAuthService?: IAccountRequestAuthService;
  /** The Desktop Host requests the Main to register the exact local video path that the Agent has authorized. */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  modelSelectionReadinessSource?: ModelSelectionReadinessSource;
  sessionRuntimePreferencesAuthority?: "local" | "external";
  resolveSessionRuntimePreferences?: (
    scope: ZCodeSessionRuntimePreferencesScope,
  ) => Promise<ZCodeSessionRuntimePreferencesResult>;
  /** Manual run is dispatched directly by the current host after being dropped into the library; when returning, prompt must have been accepted by the session. */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /**
   * Off-Peak created within a session. config also assumes the exposure gate (enabled && Selection View is not empty →
   * session create/resume issues offPeakToolEnabled) and default parsing (model=last of whitelist /
   * thoughtLevel=highest level); service is called by offPeak/create, offPeak/list protocol handlers.
   * Either one is turned off entirely by default (pure CLI/desktop-attached-remote assembly is not passed).
   */
  resolveOffPeakClientConfig?: () => Promise<OffPeakClientConfig | undefined>;
  /**
   * Grayscale snapshot of dynamic workflow. Host is the sole arbiter:
   * The results are not only sent to the CLI as workspace-level facts, but also determine whether session create/resume/v4 has
   * dynamicWorkflowEnabled. Default is not passed (pure CLI assembly) = always closed, consistent with CLI default.
   */
  resolveDynamicWorkflowClientConfig?: () => Promise<DynamicWorkflowClientConfig | undefined>;
  resolveOffPeakTaskService?: () =>
    | Pick<IOffPeakTaskService, "createTask" | "list" | "getCodingPlanSupport">
    | undefined;
  /**
   * browser-use execution bridge: forward the agent's interaction/browserExecute reverse request to main
   * (WebContentsView+CDP). Desktop host is injected during assembly; the default (pure CLI/remote control without main) is
   * The browser command returns backend_unavailable and does not affect other functions.
   */
  browserControlExecutor?: BrowserAmbientContextExecutor;
  /**
   * Official Server MCP identity header parser. The Agent process does not hold user identity authority,
   * Obtain the identity header of this request from the host via interaction/requestOfficialMcpAuthHeaders.
   *
   * By default, this request will always return official_auth_unavailable and will never be downgraded to an anonymous request——
   * For example, the standalone CLI does not have a host auth port.
   */
  officialMcpAuthHeadersResolver?: {
    resolveHeaders(request: {
      mcpKey: string;
      pluginId: string;
      targetOrigin: string;
      workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
    }): Promise<
      | { ok: true; headers: Record<string, string> }
      | { ok: false; reason: "official_auth_unavailable" | "official_auth_plan_required" }
    >;
  };
  /**
   * Official MCP trusted Origin validator. **host is the identity authority boundary**, so
   * The verification of targetOrigin must be performed here, and cannot only rely on the fetch wrapper of the agent adapter - that is equivalent to letting
   * The party being reviewed shall act as the reviewer. In the desktop-attached remote scenario, the agent runs remotely and the host holds the local user identity.
   *
   * This check constrains the target origin of the credential request and does not provide per-plugin permission control.
   * HTTP authentication is injected by the host fetch wrapper, and stdio authentication will hand over the credentials to the plug-in process; the latter
   * Must be managed as trusted executable code. The server must still verify identity, permissions, and quotas for each call.
   *
   * By default, it is always rejected (fail closed) and does not degenerate into "only do schema verification and then issue credentials".
   */
  officialMcpTrustedOrigins?: {
    isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
      detail?: string;
      trusted: boolean;
    }>;
  };
  /** desktop-local Host injection; only consumes verified and deduplicated live session events. */
  cuaOperationStateReporter?: CuaOperationStateReporter;
  onCuaPipSessionLifecycle?: (
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ) => void;
}

function toProtocolAutomation(automation: ZCodeAutomation) {
  return {
    automationId: automation.automationId,
    title: automation.title,
    cronExpr: automation.cronExpr,
    prompt: automation.prompt,
    modelSelection: automation.modelSelection,
    mode: automation.mode,
    targetTaskId: automation.targetTaskId,
    enabled: automation.enabled,
    lifecycleStatus: automation.lifecycleStatus,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    runCount: automation.runCount,
    recurring: automation.recurring,
    maxRuns: automation.maxRuns,
    // Transparently transmits the authoritative scheduleRule; the session card must read this field to display the real interval that cron cannot express
    // (such as every 50 hours, every 40 days), otherwise error displays such as "00th minute of every hour" can only be inferred from compatible cronExpr.
    scheduleRule: automation.scheduleRule,
  };
}

function toProtocolOffPeakTaskSnapshot(task: {
  offPeakTaskId: string;
  title: string;
  status: "queued" | "paused" | "running" | "completed" | "failed" | "cancelled";
  queuePosition?: number;
  sessionId?: string;
  createdAt: number;
}) {
  // Minimal aspect of the protocol: Do not expose serverTicketId / providerName / workspace details.
  return {
    offPeakTaskId: task.offPeakTaskId,
    title: task.title,
    status: task.status,
    ...(typeof task.queuePosition === "number" && task.queuePosition > 0
      ? { queuePosition: task.queuePosition }
      : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    createdAt: task.createdAt,
  };
}

const OFF_PEAK_INTERNAL_ERROR_CODE = "offpeak_internal_error";
const OFF_PEAK_INTERNAL_ERROR_MESSAGE = "Internal off-peak service error";

/**
 * The catch of offPeak/create and offPeak/list must not include the cross-layer exception text (SQLite/file path/
 * Upstream response fragment) echoes the protocol as-is - it will go into the CLI log with model-visible errors. The original error is only entered into the server log.
 * Externally fixed and stable error codes + general copywriting; business failure classification still uses respond({ok:false}) instead of here.
 */
async function respondOffPeakInternalError(
  client: Pick<ZCodeProtocolClient, "respondError">,
  request: { id: ZCodeProtocolRequestId; method: string },
  workspace: ZCodeAgentWorkspaceTarget,
  error: unknown,
): Promise<void> {
  logger.warn(undefined, "Off-peak protocol request failed", {
    method: request.method,
    workspaceKey: resolveWorkspaceKey(workspace),
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  await client.respondError(request.id, {
    code: -32603,
    message: OFF_PEAK_INTERNAL_ERROR_MESSAGE,
    data: { errorCode: OFF_PEAK_INTERNAL_ERROR_CODE },
  });
}

/** Only when grayscale is effectively turned on and the whitelist is not empty can it be considered "creatable"; the rest are considered closed (empty array). */
function resolveOffPeakAllowedModels(
  grayConfig: OffPeakClientConfig | undefined,
  providerId?: string,
): readonly string[] {
  if (grayConfig?.enabled !== true) return [];
  return grayConfig.modelSelectionView.providers
    .filter((provider) => providerId === undefined || provider.providerId === providerId)
    .flatMap((provider) => provider.models.map((model) => model.modelId));
}

/**
 * Model parsing: omitted → the last position in the whitelist (the last position in the server order ≈ the latest and strongest); explicit → trim + case-insensitive matching,
 * A hit returns the original whitelist method, a miss returns null (the caller returns model_not_allowed).
 */
function resolveOffPeakCreateModel(
  allowedModels: readonly string[],
  requested: string | undefined,
): string | null {
  const wanted = requested?.trim();
  if (!wanted) return allowedModels[allowedModels.length - 1] ?? null;
  const lower = wanted.toLowerCase();
  return allowedModels.find((model) => model.trim().toLowerCase() === lower) ?? null;
}

/**
 * New tool tasks reuse common top-level completions; old metadata/model specializations deviate from the semantic ordering of values.
 * Explicit gearing is left to the existing verification of createTask, and no unauthorized shifting is allowed at the entry.
 */
function resolveOffPeakToolSelection(
  view: ModelSelectionView,
  providerId: string,
  modelId: string,
  thoughtLevel?: string,
): ModelSelection | undefined {
  const selection = completeNewModelSelection(view, { providerId, modelId });
  if (!selection) return undefined;
  return thoughtLevel === undefined
    ? selection
    : { ...selection, options: { reasoningLevel: thoughtLevel } };
}
export function createZCodeAgentService(
  options?: CreateZCodeAgentServiceOptions,
): IZCodeAgentService & { disposeAllAndWait(): Promise<void> } {
  const processManager = new ZCodeAgentProcessManager(options);
  // Windows indicator and macOS producer lifecycle client share verified and deduplicated sideband facts.
  const cuaOperationTurnTracker =
    options?.cuaOperationStateReporter || options?.onCuaPipSessionLifecycle
      ? createCuaOperationTurnTracker({
          ...(options?.cuaOperationStateReporter
            ? { reporter: options.cuaOperationStateReporter }
            : {}),
          ...(options?.onCuaPipSessionLifecycle
            ? { onPipSessionLifecycle: options.onCuaPipSessionLifecycle }
            : {}),
          logger: {
            debug: (message) => cuaOperationLogger.debug(undefined, message),
            info: (message) => cuaOperationLogger.info(undefined, message),
            warn: (message) => cuaOperationLogger.warn(undefined, message),
          },
        })
      : undefined;
  // AutomationRepo also holds the tasks-index.sqlite connection, and disposeAll needs to be closed together (see the disposeAll comment below)
  const automationRepo = new AutomationRepo();
  const automationService = new AutomationService(automationRepo);
  const automationTaskIndexRepo = new TaskIndexRepo();
  const pluginProcessManager = new ZCodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
  });
  // An independent process was mistakenly deleted during the merge: the slow handshake of mcp/list will block the serial stdio queue and also block the plug-in uninstallation.
  // Restore dedicated control plane processes and idle recycling; share workspace paths, not request queues or watchdogs.
  const mcpStatusProcessManager = new ZCodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    processLifecycleReporter: options?.processLifecycleReporter,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
    lane: "mcp-status",
    idleTimeoutMs: options?.mcpStatusIdleTimeoutMs ?? MCP_STATUS_LANE_IDLE_TIMEOUT_MS,
  });
  const sessionEmitters = new Map<string, Emitter<ZCodeAgentServiceEvent>>();
  /**
   * The "First Issuance of Official Identity Header" audit log has been recorded (pluginId, mcpKey, workspaceKey).
   *
   * Reason for existence: The path to success cannot just remember debug - the lowest level of the production build is Info, which cannot be answered afterwards.
   * "Which plug-in took the credentials?" But each time initialize / tools\_list / tools\_call will trigger an issuance,
   * Fully logging info is message-level log expansion. Compromise: Each triplet is only recorded with an info when it is first issued in this process.
   * Then still use debug. The audit trail goes to the granularity of "which plug-in, which workspace, and when was it first taken".
   */
  const officialMcpIssuanceAudit = createOfficialMcpIssuanceAudit();
  function cancelProviderRuntimeHeaders(
    key: string,
    pending: PendingProviderRuntimeHeadersRequest,
  ): void {
    pendingProviderRuntimeHeaders.delete(key);
    const { requestId, sessionId, workspace } = pending.request;
    logger.info(undefined, "Provider runtime headers request was cancelled", {
      requestId,
      sessionId,
      workspaceKey: resolveWorkspaceKey(workspace),
    });
  }
  const sessionRuntimePreferencesRequestEmitter =
    new Emitter<ZCodeAgentSessionRuntimePreferencesRequest>();
  const processResourceSampleEmitter = new Emitter<AgentLaneResourceSample>();
  const toolExecResourceEmitter = new Emitter<ZCodeToolExecResource>();
  const mcpResourceSamplesEmitter = new Emitter<ZCodeMcpResourceSample[]>();
  const mcpTelemetryEmitter = new Emitter<ZCodeMcpTelemetryEvent>();
  const pluginOperationProgressEmitters = new Map<
    string,
    Emitter<ZCodePluginOperationProgressNotification>
  >();
  // v4 conversation frame fan-out: workspace-level emitter, renderer routes by itself according to the topic.
  const conversationFrameEmitters = new Map<string, Emitter<ConversationTopicWireCandidate>>();
  const localTtftFactsEmitter = new Emitter<{ workspaceKey: string; facts: LocalTtftFacts }>();
  const conversationTelemetryFactEmitters = new Map<string, Emitter<ConversationTelemetryFact>>();
  const cuaPermissionObservationEmitter = new Emitter<ZCodeAgentCuaPermissionObservation>();
  // sessions-index frame fan-out: The same conversationFrame notification as conversation, shunted to this emitter according to the topic prefix.
  const sessionsIndexFrameEmitters = new Map<string, Emitter<SessionsIndexTopicWireCandidate>>();
  // workspace-config frame fan-out: configure directory activity (task-index syncer consumption), the same notification is distributed by prefix.
  const workspaceConfigFrameEmitters = new Map<
    string,
    Emitter<WorkspaceConfigTopicWireCandidate>
  >();
  // v4 subscription replacement is determined by (connectionId, topic); each host process serves one
  // renderer window, a stable connectionId allows re-subscription to naturally replace the old subscription.
  const v4ConnectionId = `host-${randomUUID()}`;
  interface V4SubscriptionRoute {
    workspaceKey: string;
    topic: string;
    subscriptionId: string;
    connectionId: string;
  }
  const v4SubscriptionRoutes = new Map<string, V4SubscriptionRoute>();
  const v4RouteKeyByOwnership = new Map<string, string>();
  const v4RouteRuntimeRestartDisposable = processManager.onRuntimeRestarted(({ workspaceKey }) => {
    clearV4SubscriptionRoutes(workspaceKey);
    cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
  });
  const sessionEventSequenceStates = new Map<string, SessionEventSequenceState>();
  const wiredClients = new WeakSet<ZCodeProtocolClient>();
  const clientDisposables = new WeakMap<ZCodeProtocolClient, IDisposable[]>();
  const pendingPermissions = new Map<string, PendingPermissionRequest>();
  const pendingUserInputs = new Map<string, PendingPermissionRequest>();
  // Memory diagnostic counter: Read only the size of each per-session mirror table.
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("agent", () => ({
    sessionEmitters: sessionEmitters.size,
    seqStates: sessionEventSequenceStates.size,
    pendingPermissions: pendingPermissions.size,
    pendingUserInputs: pendingUserInputs.size,
  }));
  const pendingProviderRuntimeHeaders = new Map<string, PendingProviderRuntimeHeadersRequest>();
  const pendingSessionRuntimePreferences = new Map<
    string,
    PendingSessionRuntimePreferencesRequest
  >();
  const activeClientsByWorkspaceKey = new Map<string, ActiveWorkspaceClient>();
  const interactionPreferenceSyncByWorkspaceKey = new Map<string, Promise<void>>();
  let latestAppRuntimePreferences: ZCodeAgentAppRuntimePreferences | undefined;
  /** In-process single determination of dynamic workflow grayscale gate; see comments on resolveDynamicWorkflowGate. */
  let dynamicWorkflowGate: Promise<boolean> | undefined;
  const waitingWorkspaceStartups = new Map<string, WaitingWorkspaceStartup>();
  function cancelWaitingWorkspaceStartup(workspaceKey: string): void {
    const waiting = waitingWorkspaceStartups.get(workspaceKey);
    if (waiting) {
      waiting.cancelled = true;
      waitingWorkspaceStartups.delete(workspaceKey);
    }
  }
  function cancelAllWaitingWorkspaceStartups(): void {
    for (const waiting of waitingWorkspaceStartups.values()) {
      waiting.cancelled = true;
    }
    waitingWorkspaceStartups.clear();
  }
  const accountConfigSyncByClient = new WeakMap<ZCodeProtocolClient, Promise<void>>();
  // This cache only deduplicates the delivered account snapshot and does not mean that the Worker's Registry has applied this version.
  const accountConfigReceivedRevisionByClient = new WeakMap<ZCodeProtocolClient, string>();
  const sessionTraceIdBySessionKey = new Map<string, TraceId>();
  const accountRequestAuthService = options?.accountRequestAuthService;
  const accountProviderConfigSource = options?.accountProviderConfigSource;
  const modelSelectionReadinessSource = options?.modelSelectionReadinessSource;
  const sessionRuntimePreferencesAuthority = options?.sessionRuntimePreferencesAuthority ?? "local";
  const resolveSessionRuntimePreferences = options?.resolveSessionRuntimePreferences;

  function invalidateWorkspaceClient(workspaceKey: string, client: ZCodeProtocolClient): void {
    for (const [key, pending] of pendingPermissions) {
      if (pending.client === client) {
        pendingPermissions.delete(key);
      }
    }
    for (const [key, pending] of pendingUserInputs) {
      if (pending.client === client) {
        pendingUserInputs.delete(key);
      }
    }
    for (const [key, pending] of pendingProviderRuntimeHeaders) {
      if (pending.client === client) {
        cancelProviderRuntimeHeaders(key, pending);
      }
    }
    for (const [key, pending] of pendingSessionRuntimePreferences) {
      if (pending.client === client) {
        clearTimeout(pending.timeout);
        pendingSessionRuntimePreferences.delete(key);
      }
    }
    for (const disposable of clientDisposables.get(client) ?? []) {
      disposable.dispose();
    }
    clientDisposables.delete(client);

    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.client !== client) {
      // Runtime lifecycle events may interleave with next-generation startup; late cleanup of old clients can only release
      // Bind to itself, and the new client and new runtime status registered in the same workspace must not be deleted.
      return;
    }
    activeClientsByWorkspaceKey.delete(workspaceKey);
    // Interaction preference is the CLI process memory state; even after app revision, the runtime is replaced.
    // If there is no change, it must be resynchronized, and the completion Promise of the old client cannot be used.
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
  }

  const runtimeLifecycleDisposable = processManager.onRuntimeLifecycle((event) => {
    if (event.state !== "unavailable") return;
    // When the protocol is closed, the process crashes, or the request times out, the runtime may no longer send turn-failed/
    // session-closed, it may not be able to successfully start the next generation runtime. This authority must be unavailable
    // Clear the CUA tracker at the life cycle boundary, otherwise the Windows top prompt and Helper recovery gate will remain permanently.
    cuaOperationTurnTracker?.clearWorkspaceKey(event.workspaceKey);
    const active = activeClientsByWorkspaceKey.get(event.workspaceKey);
    if (!active) return;
    // Process manager will only publish unavailable for the current available runtime; bind the current
    // The active client acts as the second layer of identity guard to prevent the late recycling of the old runtime from accidentally damaging the replacement results.
    invalidateWorkspaceClient(event.workspaceKey, active.client);
  });

  async function resolveAccountRequestAuth(
    request: ZCodeProviderRuntimeHeadersRequestParams,
  ): Promise<AccountRequestAuthMaterial | undefined> {
    if (!request.accountAccess || !accountRequestAuthService) {
      return undefined;
    }
    return accountRequestAuthService.resolveCurrent({
      providerId: request.providerId,
      modelId: request.modelSelection.modelId,
      accountAccess: request.accountAccess,
      reason: request.reason,
    });
  }

  async function respondAccountRequestAuthWithoutInteraction(params: {
    key: string;
    pending: PendingProviderRuntimeHeadersRequest;
  }): Promise<void> {
    params.pending.responding = true;
    try {
      const requestAuth = await resolveAccountRequestAuth(params.pending.request);
      // Account resolution is asynchronous IO; late materials cannot be sent to canceled requests after cancellation/process exit.
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      if (!requestAuth) {
        throw new Error("Account request auth resolver returned no material");
      }
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: true,
        requestAuth,
      });
      logger.info(undefined, "ZCode provider runtime headers applied", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
    } catch (error) {
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      logger.warn(undefined, "failed to apply ZCode provider runtime headers", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        error: error instanceof Error ? error.message : String(error),
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (pendingProviderRuntimeHeaders.get(params.key) === params.pending) {
        pendingProviderRuntimeHeaders.delete(params.key);
      }
    }
  }

  function takePendingSessionRuntimePreferences(
    requestId: string,
  ): PendingSessionRuntimePreferencesRequest | undefined {
    const pending = pendingSessionRuntimePreferences.get(requestId);
    if (!pending) {
      return undefined;
    }
    pendingSessionRuntimePreferences.delete(requestId);
    clearTimeout(pending.timeout);
    return pending;
  }

  function expireSessionRuntimePreferencesRequest(requestId: string): void {
    const pending = takePendingSessionRuntimePreferences(requestId);
    if (!pending) {
      return;
    }
    // When the remote Host transport is still alive but the set responder does not return, the old pending
    // Without a termination condition, the Session life cycle will be blocked. Timeout only ends this request without retrying or downgrading.
    logger.warn(undefined, "runtime preferences request timed out waiting for the Host response", {
      event: "zcode_agent.runtime_preferences.host_response_timeout",
      module: "services.zcode_agent",
      requestId,
      scope: pending.request.scope,
      sessionId: pending.request.sessionId,
      timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
      workspaceKey: pending.workspaceKey,
    });
    void pending.client
      .respondError(pending.protocolRequestId, {
        code: -32022,
        message: "Session runtime preferences request timed out",
        data: {
          timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        },
      })
      .catch((error: unknown) => {
        logger.debug(undefined, "failed to send the runtime preferences timeout response", {
          error: error instanceof Error ? error.message : String(error),
          requestId,
          scope: pending.request.scope,
          sessionId: pending.request.sessionId,
        });
      });
  }

  let modelSelectionSubscription = modelSelectionReadinessSource?.onDidChange?.((view) => {
    void handleProviderReadinessChanged({
      reason: "model_selection_changed",
      snapshot: createProviderReadinessSnapshotFromSelectionView(view),
    }).catch((error) => {
      logger.warn(undefined, "model selection readiness hot sync failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  let accountProviderConfigUnsubscribe = accountProviderConfigSource?.onDidChange((reason) => {
    void handleAccountProviderConfigChanged(reason).catch((error) => {
      logger.warn(undefined, "account provider config hot sync failed", {
        message: error instanceof Error ? error.message : String(error),
        reason,
      });
    });
  });

  async function syncAccountProviderConfigToClient(params: {
    client: ZCodeProtocolClient;
    reason: string;
  }): Promise<void> {
    if (!accountProviderConfigSource) return;
    const previous = accountConfigSyncByClient.get(params.client) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // A previous failure cannot block subsequent newer Account Config; the current call will be retried.
      })
      .then(async () => {
        // Asynchronous reads before queuing may return late, queuing old results after new results. read and deliver
        // Share the existing Client serial queue; no new send barriers are added, and no time order is guessed based on content revision.
        const snapshot = await accountProviderConfigSource.read();
        if (accountConfigReceivedRevisionByClient.get(params.client) === snapshot.revision) return;
        const result = await params.client.request(
          zcodeProtocolMethods.providerUpdateAccountConfig,
          {
            revision: snapshot.revision,
            basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
            // Account is a runtime fact envelope, not a collection of disk Provider rules; keep the original protocol dictionary.
            providers: Object.fromEntries(
              [...snapshot.providers.entries()].map(([providerId, config]) => [
                providerId,
                config.toJSON(),
              ]),
            ),
            states: snapshot.states ?? {},
          },
          zcodeProviderUpdateAccountConfigResultSchema,
        );
        if (result.receivedRevision !== snapshot.revision) {
          throw new Error("Account Config receipt revision does not match the delivered revision");
        }
        accountConfigReceivedRevisionByClient.set(params.client, result.receivedRevision);
        logger.info(undefined, "account provider config delivered to the ZCode agent", {
          providerCount: result.providerCount,
          reason: params.reason,
          receivedRevision: result.receivedRevision,
          status: result.status,
        });
      });
    accountConfigSyncByClient.set(params.client, current);
    try {
      await current;
    } finally {
      if (accountConfigSyncByClient.get(params.client) === current) {
        accountConfigSyncByClient.delete(params.client);
      }
    }
  }

  async function ensureAccountProviderConfigSynced(params: {
    client: ZCodeProtocolClient;
    reason: string;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Promise<void> {
    await syncAccountProviderConfigToClient({
      client: params.client,
      reason: params.reason,
    });
  }

  async function handleAccountProviderConfigChanged(reason: string): Promise<void> {
    await Promise.all(
      Array.from(activeClientsByWorkspaceKey.values()).map(async (active) => {
        await syncAccountProviderConfigToClient({
          client: active.client,
          reason,
        });
      }),
    );
  }

  function enqueueInteractionPreferenceSync(params: {
    client: ZCodeProtocolClient;
    preferences: ZCodeAgentAppRuntimePreferences;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const previous = interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // The previous failure cannot disrupt the order of subsequent switch submissions; the current snapshot must still be attempted.
      })
      .then(async () => {
        await params.client.request(
          zcodeProtocolMethods.workspaceUpdateInteractionPreferences,
          {
            workspace: buildWorkspaceRef(params.workspace),
            preferences: {
              askUserQuestionAutoResolutionEnabled:
                params.preferences.askUserQuestionAutoResolutionEnabled,
            },
          },
          zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
        );
        try {
          await params.client.request(
            zcodeProtocolMethods.workspaceUpdateModelIoPreferences,
            {
              workspace: buildWorkspaceRef(params.workspace),
              preferences: {
                fullRetentionEnabled: params.preferences.modelIoFullRetentionEnabled === true,
              },
            },
            zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
          );
        } catch (error) {
          // The new Host is compatible with CLI that has not yet been upgraded: only method-not-found can be downgraded, other synchronization failures still need to be thrown up.
          if (!isProtocolMethodNotFoundError(error)) throw error;
        }
      });
    interactionPreferenceSyncByWorkspaceKey.set(workspaceKey, current);
    void current.then(
      () => {
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
      () => {
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
    );
    return current;
  }

  async function handleProviderReadinessChanged(event: {
    reason: string;
    snapshot: ZCodeAgentProviderReadinessSnapshot;
  }): Promise<void> {
    if (event.snapshot.readiness.ready) {
      await Promise.allSettled(
        Array.from(waitingWorkspaceStartups.entries()).map(async ([workspaceKey, waiting]) => {
          // The provider-ready event will first snapshot the waiting list and then start asynchronously; the workspace is
          // After being removed during the await period, the old snapshot will still pull up the released Agent again. Only allow current
          // The generation corresponding to waiting identity continues, and the callback after deletion or replacement must be invalid.
          if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
            return;
          }
          const { workspace } = waiting;
          const client = await getClient(workspace);
          await ensureAccountProviderConfigSynced({
            client,
            reason: `startup_ready:${event.reason}`,
            workspace,
          });
          logger.info(
            undefined,
            "started the waiting ZCode agent after provider/model became ready",
            {
              providerCount: event.snapshot.providerCount,
              reason: event.reason,
              revision: event.snapshot.revision,
              workspaceKey: resolveWorkspaceKey(workspace),
              workspacePath: workspace.workspacePath,
            },
          );
        }),
      );
    }
  }

  function getSessionEmitter(params: ZCodeAgentSessionTarget) {
    const key = sessionEventKey(params);
    const existing = sessionEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ZCodeAgentServiceEvent>();
    sessionEmitters.set(key, created);
    return created;
  }

  function getPluginOperationProgressEmitter(operationId: string) {
    const existing = pluginOperationProgressEmitters.get(operationId);
    if (existing) return existing;
    let created: Emitter<ZCodePluginOperationProgressNotification>;
    created = new Emitter({
      onDidRemoveLastListener: () => {
        if (pluginOperationProgressEmitters.get(operationId) !== created) return;
        pluginOperationProgressEmitters.delete(operationId);
        created.dispose();
      },
    });
    pluginOperationProgressEmitters.set(operationId, created);
    return created;
  }

  function getConversationFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ConversationTopicWireCandidate>();
    conversationFrameEmitters.set(key, created);
    return created;
  }

  function getConversationTelemetryFactEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationTelemetryFactEmitters.get(key);
    if (existing) return existing;
    const created = new Emitter<ConversationTelemetryFact>();
    conversationTelemetryFactEmitters.set(key, created);
    return created;
  }

  function getSessionsIndexFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = sessionsIndexFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<SessionsIndexTopicWireCandidate>();
    sessionsIndexFrameEmitters.set(key, created);
    return created;
  }

  function getWorkspaceConfigFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = workspaceConfigFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<WorkspaceConfigTopicWireCandidate>();
    workspaceConfigFrameEmitters.set(key, created);
    return created;
  }

  /** v4 subscription connectionId: Multiple independent consumers (renderer/syncer) in the same host process are distinguished by the scope suffix. */
  function v4ConnectionIdFor(subscriberScope?: string): string {
    return subscriberScope ? `${v4ConnectionId}#${subscriberScope}` : v4ConnectionId;
  }

  function resolveV4Connection(
    params: unknown,
    fallbackConnectionId: string = v4ConnectionId,
  ): ZCodeAgentV4ConnectionContext {
    return (
      readTrustedZCodeAgentV4Connection(params) ?? {
        // Without a trusted carrier, it is a direct adjustment within the host: subscribe to the old consumer (whole key patch), without guessing the capabilities.
        connectionId: fallbackConnectionId,
        clientMode: "desktop-continuous" as const,
      }
    );
  }

  function v4SubscriptionRouteKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.subscriptionId}\0${route.connectionId}`;
  }

  function v4SubscriptionOwnershipKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.connectionId}`;
  }

  function rememberV4SubscriptionRoute(
    workspace: ZCodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ): void {
    const route: V4SubscriptionRoute = {
      workspaceKey: resolveWorkspaceKey(workspace),
      topic,
      subscriptionId,
      connectionId,
    };
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    const previous = v4RouteKeyByOwnership.get(ownershipKey);
    if (previous) v4SubscriptionRoutes.delete(previous);
    const routeKey = v4SubscriptionRouteKey(route);
    v4RouteKeyByOwnership.set(ownershipKey, routeKey);
    v4SubscriptionRoutes.set(routeKey, route);
  }

  function forgetV4SubscriptionRoute(route: V4SubscriptionRoute): void {
    const routeKey = v4SubscriptionRouteKey(route);
    v4SubscriptionRoutes.delete(routeKey);
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    if (v4RouteKeyByOwnership.get(ownershipKey) === routeKey) {
      v4RouteKeyByOwnership.delete(ownershipKey);
    }
  }

  function isCurrentV4SubscriptionRoute(route: V4SubscriptionRoute): boolean {
    return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) === route;
  }

  function clearV4SubscriptionRoutes(workspaceKey?: string): void {
    for (const route of v4SubscriptionRoutes.values()) {
      if (workspaceKey !== undefined && route.workspaceKey !== workspaceKey) {
        continue;
      }
      forgetV4SubscriptionRoute(route);
    }
  }

  function resolveV4UnsubscribeRoute(
    params: ZCodeAgentConversationUnsubscribeParams | ZCodeAgentConversationResyncParams,
    topicPrefix: string,
  ): V4SubscriptionRoute | null {
    const expectedWorkspaceKey = resolveWorkspaceKey(params);
    const trusted = readTrustedZCodeAgentV4UnsubscribeRoute(params);
    if (trusted) {
      if (!trusted.topic.startsWith(topicPrefix)) return null;
      const route: V4SubscriptionRoute = {
        workspaceKey: expectedWorkspaceKey,
        topic: trusted.topic,
        subscriptionId: params.subscriptionId,
        connectionId: trusted.connectionId,
      };
      return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) ?? null;
    }
    // The internal direct consumer of the base service does not have a facade carrier; it is only unique within the method topic domain
    // It is compatible when hitting, but rejects guessing when it collides, and it cannot be deleted by multiple publisher broadcasts.
    const matches = [...v4SubscriptionRoutes.values()].filter(
      (route) =>
        route.workspaceKey === expectedWorkspaceKey &&
        route.subscriptionId === params.subscriptionId &&
        route.topic.startsWith(topicPrefix),
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  async function unsubscribeV4Route(
    params: ZCodeAgentConversationUnsubscribeParams,
    topicPrefix: string,
  ): Promise<void> {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) return;
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    // getReadOnlyClient may pull up a new runtime in await; restart listener has cleared the old route, and the new
    // The runtime may reuse the same key/subId. It must be reviewed as an object, and partial old routes cannot be sent to the new CLI.
    if (!isCurrentV4SubscriptionRoute(route)) return;
    await client.request(
      V4_METHODS.conversationUnsubscribe,
      {
        topic: route.topic,
        subscriptionId: route.subscriptionId,
        connectionId: route.connectionId,
      },
      zcodeProtocolEmptyResultSchema,
    );
    // When the request is in transit, runtime restart/resubscription can use the same route key to create a new object;
    // The late old response can only clean up its own generation and cannot delete the new route according to the composite key.
    if (isCurrentV4SubscriptionRoute(route)) forgetV4SubscriptionRoute(route);
  }

  async function resyncV4Route(params: ZCodeAgentConversationResyncParams, topicPrefix: string) {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) throw new Error("fault.subscription.notOwned");
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = await client.request(
      V4_METHODS.conversationResync,
      {
        topic: route.topic,
        connectionId: route.connectionId,
        subscriptionId: route.subscriptionId,
        base: params.base,
        ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
      },
      v4ConversationResyncResultSchema,
    );
    // Resync ACK is only valid for the route generation when initiated. If the wait period has been restarted/resubscribed,
    // Returning stale success will cause the consumer to treat the old recovery as the recovery result of the new subscription.
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    return result;
  }

  function emitSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
    event: ZCodeAgentServiceEvent,
  ): void {
    sessionEmitters.get(sessionEventKey({ ...workspace, sessionId }))?.fire(event);
  }

  function emitWorkspaceEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeAgentServiceEvent,
  ): void {
    const workspaceKey = resolveWorkspaceKey(workspace);
    for (const [key, emitter] of sessionEmitters) {
      if (key.startsWith(`${workspaceKey}\u0000`)) {
        emitter.fire(event);
      }
    }
  }

  function getSessionEventSequenceState(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): SessionEventSequenceState {
    const key = sessionEventKey({ ...workspace, sessionId });
    const existing = sessionEventSequenceStates.get(key);
    if (existing) {
      return existing;
    }
    const created: SessionEventSequenceState = {
      assignedSeqByEventId: new Map<string, number>(),
      assignedSeqEventIds: [],
      liveEventIds: new Set<string>(),
      liveEventIdOrder: [],
      lastAssignedSeq: 0,
    };
    sessionEventSequenceStates.set(key, created);
    return created;
  }

  function normalizeSessionEventSeq(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): ZCodeSessionEvent {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    if (event.seq > 0) {
      state.lastAssignedSeq = Math.max(state.lastAssignedSeq, event.seq);
      return event;
    }

    const assignedSeq = state.assignedSeqByEventId.get(event.eventId);
    if (assignedSeq !== undefined) {
      return { ...event, seq: assignedSeq };
    }

    const nextSeq = state.lastAssignedSeq + 1;
    state.lastAssignedSeq = nextSeq;
    state.assignedSeqByEventId.set(event.eventId, nextSeq);
    state.assignedSeqEventIds.push(event.eventId);
    while (state.assignedSeqEventIds.length > MAX_TRACKED_SESSION_EVENT_IDS) {
      const removed = state.assignedSeqEventIds.shift();
      if (removed) {
        state.assignedSeqByEventId.delete(removed);
      }
    }
    // The old agent live sink will send the createSessionEvent default seq=0 directly to the app.
    // And replay/read goes through the event store before replenishing the number. Only the old version is compatible here; the sequence source of the new runtime is still the event store.
    return { ...event, seq: nextSeq };
  }

  function shouldDeliverLiveSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): boolean {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    return rememberBoundedEventId(state.liveEventIds, state.liveEventIdOrder, event.eventId);
  }

  function handleSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): void {
    const normalizedEvent = normalizeSessionEventSeq(workspace, event);
    if (!shouldDeliverLiveSessionEvent(workspace, normalizedEvent)) {
      return;
    }
    emitSessionEvent(workspace, normalizedEvent.sessionId, {
      type: "session.event",
      event: normalizedEvent,
    });
  }

  function handleStateUpdated(
    workspace: ZCodeAgentWorkspaceTarget,
    notification: ZCodeStateUpdatedNotification,
  ): void {
    if (notification.sessionId) {
      emitSessionEvent(workspace, notification.sessionId, {
        type: "state.updated",
        notification,
      });
      return;
    }
    emitWorkspaceEvent(workspace, { type: "state.updated", notification });
  }

  function wireClient(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    /**
     * The process lane to which this client belongs. The CLI process does not know which process manager it was pulled up by.
     * Therefore, the lane of the resource sample can only be filled here by the caller.
     */
    lane: ProcessResourceCliLane,
  ): void {
    if (wiredClients.has(client)) {
      return;
    }
    wiredClients.add(client);
    const disposables = [
      client.onNotification((message) => {
        if (message.method === zcodeProtocolNotifications.providerRuntimeHeadersCancelled) {
          const parsed = zcodeProviderRuntimeHeadersCancelledSchema.safeParse(message.params);
          if (
            !parsed.success ||
            resolveWorkspaceKey(parsed.data.workspace) !== resolveWorkspaceKey(workspace)
          )
            return;
          const key = providerRuntimeHeadersRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const pending = pendingProviderRuntimeHeaders.get(key);
          // Cancellation of the old client or the same path with a different identity cannot delete requests for new runtime/other workspaces.
          if (pending?.client === client) cancelProviderRuntimeHeaders(key, pending);
          return;
        }
        if (message.method === zcodeProtocolNotifications.processResourceSample) {
          const parsed = zcodeProcessResourceSampleSchema.safeParse(message.params);
          if (parsed.success) {
            processResourceSampleEmitter.fire({ ...parsed.data, lane });
          } else {
            logger.debug(undefined, "dropping invalid ZCode CLI resource sample", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolNotifications.toolExecResource) {
          const parsed = zcodeToolExecResourceSchema.safeParse(message.params);
          if (parsed.success) toolExecResourceEmitter.fire(parsed.data);
          return;
        }
        if (message.method === zcodeProtocolNotifications.mcpResourceSamples) {
          const parsed = zcodeMcpResourceSamplesSchema.safeParse(message.params);
          if (parsed.success) mcpResourceSamplesEmitter.fire(parsed.data);
          else logger.debug(undefined, "dropping invalid MCP resource sample");
          return;
        }

        if (message.method === zcodeProtocolNotifications.mcpTelemetry) {
          const parsed = zcodeMcpTelemetryEventSchema.safeParse(message.params);
          if (parsed.success) {
            mcpTelemetryEmitter.fire(parsed.data);
          } else {
            logger.debug(undefined, "dropping invalid ZCode CLI MCP telemetry event", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolNotifications.pluginOperationProgress) {
          const parsed = zcodePluginOperationProgressNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            pluginOperationProgressEmitters.get(parsed.data.operationId)?.fire(parsed.data);
          } else {
            logger.warn(undefined, "dropping invalid ZCode Protocol plugin operation progress", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolMethods.computerUseOperationEvent) {
          const parsed = zcodeComputerUseOperationEventSchema.safeParse(message.params);
          if (parsed.success) {
            // v4 sessions will not project legacy sessions/events, and CUA prompts that the runtime sideband must be consumed directly.
            // Avoid confusing the sequenceNumber/seq of two independent event streams into the same sequence field.
            cuaOperationTurnTracker?.accept(workspace, parsed.data);
          } else {
            logger.warn(undefined, "dropping invalid ZCode Protocol Computer Use operation event", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === "session/event") {
          const parsed = zcodeSessionEventSchema.safeParse(message.params);
          if (parsed.success) {
            handleSessionEvent(workspace, parsed.data);
          } else {
            const rawParams =
              typeof message.params === "object" && message.params !== null
                ? (message.params as Record<string, unknown>)
                : {};
            logger.warn(
              typeof rawParams.traceId === "string" ? rawParams.traceId : undefined,
              "dropping invalid ZCode Protocol session event",
              {
                eventId: rawParams.eventId,
                issues: parsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                sessionId: rawParams.sessionId,
                type: rawParams.type,
              },
            );
          }
          return;
        }

        if (message.method === "state.updated") {
          const parsed = zcodeStateUpdatedNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            handleStateUpdated(workspace, parsed.data);
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.localTtftFacts) {
          const parsed = localTtftFactsSchema.safeParse(message.params);
          if (parsed.success && !workspace.remoteSessionId && !workspace.workspaceIdentity?.trim())
            localTtftFactsEmitter.fire({
              workspaceKey: resolveWorkspaceKey(workspace),
              facts: parsed.data,
            });
          return;
        }
        if (message.method === V4_NOTIFICATIONS.conversationTelemetryFact) {
          const parsed = conversationTelemetryFactSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationTelemetryFactEmitter(workspace).fire(parsed.data);
          } else {
            // Strictly discard unknown fields to prevent new fields from the CLI runtime from penetrating into the renderer reporter without auditing.
            logger.warn(undefined, "dropping invalid v4 conversation telemetry fact", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.cuaPermissionObservation) {
          const parsed = cuaPermissionObservationSchema.safeParse(message.params);
          if (
            parsed.success &&
            !workspace.remoteSessionId &&
            !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
          ) {
            cuaPermissionObservationEmitter.fire({
              ...parsed.data,
              workspacePath: workspace.workspacePath,
              ...(workspace.workspaceIdentity
                ? { workspaceIdentity: workspace.workspaceIdentity }
                : {}),
            });
          } else if (!parsed.success) {
            // Reason: Permission observation will trigger renderer side effects. Unknown fields must fail closed and cannot be passed through loosely.
            logger.warn(undefined, "dropping invalid v4 CUA permission observation", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.conversationFrame) {
          // The same notification also carries the sessions-index frame and is shunted to the list emitter by topic prefix.
          // (Otherwise it will be discarded by conversation schema verification).
          const topic = (message.params as { topic?: unknown } | null)?.topic;
          if (typeof topic === "string" && topic.startsWith("sessions-index/")) {
            const indexParsed = sessionsIndexTopicWireCandidateSchema.safeParse(message.params);
            if (indexParsed.success) {
              getSessionsIndexFrameEmitter(workspace).fire(indexParsed.data);
            } else {
              logger.warn(undefined, "dropping invalid v4 sessions-index frame", {
                issues: indexParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          if (typeof topic === "string" && topic.startsWith("workspace-config/")) {
            const configParsed = workspaceConfigTopicWireCandidateSchema.safeParse(message.params);
            if (configParsed.success) {
              getWorkspaceConfigFrameEmitter(workspace).fire(configParsed.data);
            } else {
              logger.warn(undefined, "dropping invalid v4 workspace-config frame", {
                issues: configParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          const parsed = conversationTopicWireCandidateSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationFrameEmitter(workspace).fire(parsed.data);
          } else {
            logger.warn(undefined, "dropping invalid v4 conversation frame", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }
      }),
      client.onRequest((request) => {
        if (request.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
          const reportResponseFailure = (error: unknown): void => {
            logger.debug(undefined, "failed to send the runtime preferences response", {
              error: error instanceof Error ? error.message : String(error),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          };
          const parsed = zcodeSessionRequestRuntimePreferencesParamsSchema.safeParse(
            request.params,
          );
          if (!parsed.success) {
            void client
              .respondError(request.id, {
                code: -32602,
                message: "Invalid session runtime preferences request params",
                data: parsed.error.flatten(),
              })
              .catch(reportResponseFailure);
            return;
          }
          if (sessionRuntimePreferencesAuthority === "local") {
            void (async () => {
              let preferences: ZCodeSessionRuntimePreferencesResult;
              try {
                preferences = zcodeSessionRuntimePreferencesResultSchema.parse(
                  // The same RPC carries two opportunities: runtime creation and first execution; must continue to be passed
                  // The verified scope avoids waiting for the remote client config again for the shell during the first execution.
                  (await resolveSessionRuntimePreferences?.(parsed.data.scope)) ?? {
                    askUserQuestionAutoResolutionEnabled: true,
                    nativeSearchEnhancementsEnabled: true,
                  },
                );
              } catch (error) {
                await client.respondError(request.id, {
                  code: -32603,
                  message: error instanceof Error ? error.message : String(error),
                });
                return;
              }
              // Failure to send the response indicates that the transport is closed and can no longer be treated as a failure to read the settings.
              // and try to send a second error response.
              await client.respond(request.id, preferences);
            })().catch(reportResponseFailure);
            return;
          }

          const requestId = randomUUID();
          const dynamicRequest: ZCodeAgentSessionRuntimePreferencesRequest = {
            ...parsed.data,
            requestId,
          };
          pendingSessionRuntimePreferences.set(requestId, {
            client,
            protocolRequestId: request.id,
            request: dynamicRequest,
            timeout: setTimeout(
              () => expireSessionRuntimePreferencesRequest(requestId),
              ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
            ),
            workspaceKey: resolveWorkspaceKey(workspace),
          });
          logger.info(undefined, "runtime preferences request forwarded to the Host", {
            event: "zcode_agent.runtime_preferences.host_request_dispatched",
            module: "services.zcode_agent",
            requestId,
            scope: dynamicRequest.scope,
            sessionId: dynamicRequest.sessionId,
            workspaceKey: resolveWorkspaceKey(workspace),
          });
          sessionRuntimePreferencesRequestEmitter.fire(dynamicRequest);
          return;
        }

        if (request.method === zcodeProtocolMethods.interactionRequestPermission) {
          const parsed = zcodePermissionRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid permission request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const key = permissionRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const wasPending = pendingPermissions.has(key);
          pendingPermissions.set(key, {
            client,
            protocolRequestId: request.id,
          });
          if (!wasPending) {
            emitSessionEvent(workspace, parsed.data.sessionId, {
              type: "permission.request",
              request: parsed.data,
            });
          }
          return;
        }

        if (request.method === zcodeProtocolMethods.interactionRequestUserInput) {
          const parsed = zcodeUserInputRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid user input request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const key = userInputRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const wasPending = pendingUserInputs.has(key);
          pendingUserInputs.set(key, { client, protocolRequestId: request.id });
          if (!wasPending) {
            // In order to recover the lost protocol ID, the agent will resend the same service requestId.
            // The host needs to refresh the protocolRequestId that can respond, but cannot broadcast it to the UI repeatedly.
            // Otherwise the multi-question AskUserQuestion will be reset back to the first page when the user flips to subsequent questions.
            emitSessionEvent(workspace, parsed.data.sessionId, {
              type: "userInput.request",
              request: parsed.data,
            });
          }
          return;
        }

        if (request.method === zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders) {
          const parsed = zcodeProviderRuntimeHeadersRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid provider runtime headers request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const pendingKey = providerRuntimeHeadersRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const pending = {
            client,
            protocolRequestId: request.id,
            request: parsed.data,
          };
          pendingProviderRuntimeHeaders.set(pendingKey, pending);
          logger.info(request.trace?.traceId, "received ZCode provider runtime headers request", {
            modelId: parsed.data.modelSelection.modelId,
            providerId: parsed.data.providerId,
            requestId: parsed.data.requestId,
            sessionId: parsed.data.sessionId,
            turnId: parsed.data.turnId ?? null,
            workspaceKey: resolveWorkspaceKey(workspace),
            workspacePath: workspace.workspacePath,
          });
          const accountAccess = parsed.data.accountAccess;
          if (accountRequestAuthService && accountAccess) {
            // Account API Key / Team Runtime Key / Start Plan JWT do not require Renderer interaction.
            // Host automatically responds to Account Access fixed by Model to avoid background tasks and pane-less sessions relying on UI subscribers.
            void respondAccountRequestAuthWithoutInteraction({
              key: pendingKey,
              pending,
            });
            return;
          }
          // Requests without an account credential parser that go unanswered will only stay until the CLI side times out in 180s, causing a quick failure.
          pendingProviderRuntimeHeaders.delete(pendingKey);
          void pending.client.respond(pending.protocolRequestId, {
            headersApplied: false,
            errorMessage: "Provider request auth is unavailable",
          });
          return;
        }

        // Official Server MCP identity header: pure RPC relay, host automatically resolves and responds.
        // Do not emitSessionEvent, do not enter the pending map - this request has no UI semantics, and the renderer does not participate.
        if (request.method === zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders) {
          const parsed = zcodeOfficialMcpAuthHeadersRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/requestOfficialMcpAuthHeaders params",
              data: parsed.error.flatten(),
            });
            return;
          }
          // The secondary verification on the host side must occur **before reading the credentials**: it will be returned if it is not hit, and resolveHeaders will not be called.
          // So no credentials are read into memory.
          void (async () => {
            const trustedOrigins = options?.officialMcpTrustedOrigins;
            const trust = trustedOrigins
              ? await trustedOrigins
                  .isTrusted({
                    mcpKey: parsed.data.mcpKey,
                    origin: parsed.data.targetOrigin,
                    pluginId: parsed.data.pluginId,
                  })
                  // Even if it is judged that it is abnormal, it will be treated as untrustworthy, and it will never be released just because the verification fails.
                  .catch(() => ({ detail: "validator_error", trusted: false }))
              : { detail: "validator_missing", trusted: false };
            if (!trust.trusted) {
              // Only non-sensitive request context is recorded; the credentials are not read and cannot be leaked.
              logger.warn(
                request.trace?.traceId,
                "official MCP identity header request failed host-side trust validation",
                {
                  detail: trust.detail ?? "unknown",
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  requestId: parsed.data.requestId,
                  targetOrigin: parsed.data.targetOrigin,
                  workspaceKey: parsed.data.workspace.workspaceKey,
                },
              );
              void client.respond(request.id, {
                ok: false,
                reason: "official_mcp_origin_untrusted",
              });
              return;
            }
            const resolver = options?.officialMcpAuthHeadersResolver;
            if (!resolver) {
              void client.respond(request.id, {
                ok: false,
                reason: "official_auth_unavailable",
              });
              return;
            }
            try {
              const resolveStartedAt = Date.now();
              const result = await resolver.resolveHeaders({
                mcpKey: parsed.data.mcpKey,
                pluginId: parsed.data.pluginId,
                targetOrigin: parsed.data.targetOrigin,
                workspace: parsed.data.workspace,
              });
              // The host side cannot only keep logs when it fails. If the success path is completely silent, it will not be able to answer "which headers were sent."
              // Only the header name and package dimensions are recorded: the credential value will never be entered into the log (the log retention period is not controlled).
              if (result.ok) {
                const firstIssuance = officialMcpIssuanceAudit.markFirst(
                  parsed.data.pluginId,
                  parsed.data.mcpKey,
                  parsed.data.workspace.workspaceKey,
                );
                const logIssuance = firstIssuance ? logger.info : logger.debug;
                logIssuance(request.trace?.traceId, "official MCP identity headers resolved", {
                  firstIssuance,
                  ...summarizeOfficialMcpIdentityHeaders(result.headers),
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  requestId: parsed.data.requestId,
                  resolveDurationMs: Date.now() - resolveStartedAt,
                  targetOrigin: parsed.data.targetOrigin,
                });
              } else {
                logger.info(request.trace?.traceId, "official MCP identity headers unavailable", {
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  reason: result.reason,
                  requestId: parsed.data.requestId,
                  resolveDurationMs: Date.now() - resolveStartedAt,
                  targetOrigin: parsed.data.targetOrigin,
                });
              }
              void client.respond(request.id, result);
            } catch (error: unknown) {
              // Parse exceptions are returned as unavailable instead of respondError: adapter only shunts by enumerable reason.
              // And MCP must not be allowed to degenerate into anonymous requests here. The original text of the certificate is not entered in the log.
              logger.warn(
                request.trace?.traceId,
                "failed to resolve official MCP identity headers",
                {
                  error: error instanceof Error ? error.message : String(error),
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  requestId: parsed.data.requestId,
                  targetOrigin: parsed.data.targetOrigin,
                },
              );
              void client.respond(request.id, {
                ok: false,
                reason: "official_auth_unavailable",
              });
            }
          })();
          return;
        }

        // browser-use discovery: backend online status and whether plugin/skill is exposed are two-tiered status.
        // By default, executor returns an empty list and facade is prohibited from forging IAB available.
        if (request.method === zcodeProtocolMethods.interactionBrowserList) {
          const parsed = zcodeBrowserListParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserList params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const executor = options?.browserControlExecutor;
          if (!executor) {
            void client.respond(request.id, { browsers: [] });
            return;
          }
          void executor
            .list(parsed.data)
            .then((browsers) => client.respond(request.id, { browsers }))
            .catch((error: unknown) => {
              void client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          return;
        }

        // browser-use: agent's agent.browsers.* is reached here via interaction/browserExecute.
        // Pure RPC relay - forward to main (WebContentsView+CDP) and respondResult after execution, without emitSessionEvent,
        // Do not enter the pending map (different from the UI blocking semantics of permission). The default executor is backend_unavailable.
        if (request.method === zcodeProtocolMethods.interactionBrowserExecute) {
          const parsed = zcodeBrowserExecuteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserExecute params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const executor = options?.browserControlExecutor;
          if (!executor) {
            void client.respond(request.id, {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: "browser control not available",
              },
              elapsedMs: 0,
            });
            return;
          }
          void executor
            .execute({
              requestId: parsed.data.requestId,
              ...(parsed.data.browserId ? { browserId: parsed.data.browserId } : {}),
              ...(parsed.data.browserGeneration !== undefined
                ? { browserGeneration: parsed.data.browserGeneration }
                : {}),
              sessionId: parsed.data.sessionId,
              ...(parsed.data.turnId ? { turnId: parsed.data.turnId } : {}),
              workspaceKey: parsed.data.workspaceKey ?? resolveWorkspaceKey(workspace),
              workspacePath: parsed.data.workspacePath ?? workspace.workspacePath,
              ...((parsed.data.workspaceIdentity ?? workspace.workspaceIdentity)
                ? {
                    workspaceIdentity: parsed.data.workspaceIdentity ?? workspace.workspaceIdentity,
                  }
                : {}),
              ...(parsed.data.remoteSessionId
                ? { remoteSessionId: parsed.data.remoteSessionId }
                : {}),
              clientMode: parsed.data.clientMode ?? "desktop-continuous",
              sessionContext: parsed.data.sessionContext ?? "live",
              command: parsed.data.command,
            })
            .then((result) => client.respond(request.id, result))
            .catch((error: unknown) => {
              void client.respond(request.id, {
                ok: false,
                error: {
                  code: "execution_error",
                  message: error instanceof Error ? error.message : String(error),
                },
                elapsedMs: 0,
              });
            });
          return;
        }

        if (request.method === zcodeProtocolMethods.automationCreate) {
          const parsed = zcodeAutomationCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const automation = await automationService.create({
                title: parsed.data.title ?? "",
                cronExpr: parsed.data.cronExpr,
                relativeDelayMinutes: parsed.data.relativeDelayMinutes,
                // The long interval carrier (intervalUnit+interval) on the session side is transparently transmitted to the service and normalized to the authoritative scheduleRule.
                intervalUnit: parsed.data.intervalUnit,
                interval: parsed.data.interval,
                prompt: parsed.data.prompt,
                modelSelection: parsed.data.modelSelection,
                mode: parsed.data.mode,
                targetTaskId: parsed.data.targetTaskId,
                botDeliveryTarget: parsed.data.botDeliveryTarget,
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
                recurring: parsed.data.recurring ?? true,
                maxRuns: parsed.data.maxRuns,
              });
              if (automation.targetTaskId) {
                const taskMeta = await automationTaskIndexRepo
                  .getTaskMeta({
                    workspacePath: automation.workspacePath,
                    workspaceIdentity: automation.workspaceIdentity,
                    taskId: automation.targetTaskId,
                  })
                  .catch(() => null);
                if (taskMeta) {
                  await automationTaskIndexRepo.syncTaskMeta({
                    meta: {
                      ...taskMeta,
                      // Automations created within a session reuse the current session; explicitly write tags for display in the V4 sidebar.
                      cronAutomationId: automation.automationId,
                      updatedAt: Math.max(taskMeta.updatedAt, Date.now()),
                    },
                  });
                }
              }
              await client.respond(request.id, {
                automation: toProtocolAutomation(automation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.offPeakCreate) {
          const parsed = zcodeOffPeakCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const offPeakTaskService = options?.resolveOffPeakTaskService?.();
              if (!offPeakTaskService) {
                await client.respondError(request.id, {
                  code: -32601,
                  message: "Off-peak task service is unavailable on this host",
                });
                return;
              }
              const grayConfig = await options
                ?.resolveOffPeakClientConfig?.()
                .catch(() => undefined);
              // When grayscale is turned off after tool registration/configuration parsing fails, the derivation of "whitelist is empty" cannot be continued.
              // (Explicit model will falsely report model_not_allowed, omitting model will result in an empty model being dropped into the library); directly return to the stable classification.
              // A model view can contain two fields at the same time; ownership must be confirmed with an existing support snapshot, not guessed from the first Provider.
              const support =
                resolveOffPeakAllowedModels(grayConfig).length > 0
                  ? await offPeakTaskService.getCodingPlanSupport()
                  : undefined;
              const providerId = support?.supported
                ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
                : undefined;
              const allowedModels = providerId
                ? resolveOffPeakAllowedModels(grayConfig, providerId)
                : [];
              if (allowedModels.length === 0) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "offpeak_disabled",
                });
                return;
              }
              // Model whitelist pre-calibration: explicit input parameters are not in the whitelist and return to stable classification.
              // Reuse the client_validation category + dedicated errorCode without expanding the category enumeration.
              // Matching has the same semantics as thoughtLevel/UI (trim + case-insensitive), and the whitelist original writing method is written back after a hit.
              const model = resolveOffPeakCreateModel(allowedModels, parsed.data.model);
              if (model === null) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "model_not_allowed",
                });
                return;
              }
              const modelSelection =
                grayConfig && providerId
                  ? resolveOffPeakToolSelection(
                      grayConfig.modelSelectionView,
                      providerId,
                      model,
                      parsed.data.thoughtLevel,
                    )
                  : undefined;
              if (!modelSelection) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "model_not_allowed",
                });
                return;
              }
              const result = await offPeakTaskService.createTask({
                title: parsed.data.title,
                prompt: parsed.data.prompt,
                permissionMode: parsed.data.permissionMode ?? "yolo",
                modelSelection,
                // Create and bind the current session within the session, and resume execution of the session when dispatched.
                ...(parsed.data.boundSessionId
                  ? { boundSessionId: parsed.data.boundSessionId }
                  : {}),
                // The workspace is injected from the current session by host (symmetric automation/create) without entering protocol parameters.
                workspacePath: workspace.workspacePath,
                ...(workspace.workspaceIdentity
                  ? { workspaceIdentity: workspace.workspaceIdentity }
                  : {}),
              });
              if (!result.ok) {
                // Failure classification is passed through the protocol unchanged (without respondError) for the CLI handler to translate into a stable error.
                await client.respond(request.id, {
                  ok: false,
                  failureStage: result.failureStage,
                  errorCategory: result.errorCategory,
                  errorCode: result.errorCode,
                });
                return;
              }
              await client.respond(request.id, {
                ok: true,
                task: toProtocolOffPeakTaskSnapshot(result.task),
              });
            } catch (error) {
              await respondOffPeakInternalError(client, request, workspace, error);
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.offPeakList) {
          const parsed = zcodeOffPeakListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const offPeakTaskService = options?.resolveOffPeakTaskService?.();
              if (!offPeakTaskService) {
                await client.respondError(request.id, {
                  code: -32601,
                  message: "Off-peak task service is unavailable on this host",
                });
                return;
              }
              const workspaceKey = resolveWorkspaceKey(workspace);
              const tasks = (await offPeakTaskService.list())
                .filter((task) => task.workspaceKey === workspaceKey)
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 20);
              await client.respond(request.id, {
                tasks: tasks.map(toProtocolOffPeakTaskSnapshot),
              });
            } catch (error) {
              await respondOffPeakInternalError(client, request, workspace, error);
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationList) {
          const parsed = zcodeAutomationListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const automations = await automationService.list(workspace);
              await client.respond(request.id, {
                automations: automations.map(toProtocolAutomation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationCheckTaskBinding) {
          const parsed = zcodeAutomationCheckTaskBindingParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation task binding params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const bound = await automationService.hasTaskBinding({
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
                targetTaskId: parsed.data.targetTaskId,
              });
              await client.respond(request.id, { bound });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationUpdate) {
          const parsed = zcodeAutomationUpdateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation update params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const automation = await automationService.update(
                parsed.data.automationId,
                {
                  title: parsed.data.title,
                  cronExpr: parsed.data.cronExpr,
                  prompt: parsed.data.prompt,
                  recurring: parsed.data.recurring,
                  maxRuns: parsed.data.maxRuns,
                  // The long interval carrier (intervalUnit+interval) on the session side is transparently transmitted to the service and normalized to the authoritative scheduleRule.
                  intervalUnit: parsed.data.intervalUnit,
                  interval: parsed.data.interval,
                },
                workspace,
              );
              if (!automation) {
                throw new Error("Scheduled task not found in the current workspace.");
              }
              await client.respond(request.id, {
                automation: toProtocolAutomation(automation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationDelete) {
          const parsed = zcodeAutomationDeleteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation delete params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const deleted = await automationService.delete(parsed.data.automationId, workspace);
              await client.respond(request.id, { deleted });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        void client.respondError(request.id, {
          code: -32601,
          message: `Unsupported ZCode Protocol request: ${request.method}`,
        });
      }),
      client.onClose(() => {
        invalidateWorkspaceClient(resolveWorkspaceKey(workspace), client);
      }),
    ];
    clientDisposables.set(client, disposables);
  }

  function rememberSessionTrace(
    target: ZCodeAgentSessionTarget,
    snapshot: ZCodeSessionStateSnapshot,
  ): TraceId | undefined {
    const traceId = snapshot.session.traceId as TraceId | undefined;
    if (traceId) {
      sessionTraceIdBySessionKey.set(sessionEventKey(target), traceId);
    }
    return traceId;
  }

  function getSessionTraceId(target: ZCodeAgentSessionTarget): TraceId | undefined {
    return sessionTraceIdBySessionKey.get(sessionEventKey(target));
  }

  function createProviderNotReadyError(params: {
    snapshot?: ZCodeAgentProviderReadinessSnapshot;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Error & {
    code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
    data: {
      providerCount: number;
      reason: typeof ZCODE_AGENT_PROVIDER_NOT_READY_REASON;
      revision: string | null;
      workspaceKey: string;
      workspacePath: string;
    };
  } {
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const error = new Error(
      "No model provider or model is available. Please sign in or configure an API Key first.",
    ) as Error & {
      code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
      data: {
        providerCount: number;
        reason: typeof ZCODE_AGENT_PROVIDER_NOT_READY_REASON;
        revision: string | null;
        workspaceKey: string;
        workspacePath: string;
      };
    };
    error.code = ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
    error.data = {
      providerCount: params.snapshot?.providerCount ?? 0,
      reason: ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
      revision: params.snapshot?.revision ?? null,
      workspaceKey,
      workspacePath: params.workspace.workspacePath,
    };
    return error;
  }

  function isProviderNotReadyError(
    error: unknown,
  ): error is Error & { code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE } {
    return (
      error instanceof Error &&
      (error as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE
    );
  }

  async function resolveStartupReadiness(): Promise<
    ZCodeAgentProviderReadinessSnapshot | undefined
  > {
    if (modelSelectionReadinessSource) {
      return createProviderReadinessSnapshotFromSelectionView(
        await modelSelectionReadinessSource.getView(),
      );
    }
    return undefined;
  }

  /**
   * stop/cancel RPC timeout or watchdog will recycle the client/process, but the process exits asynchronously,
   * When client.onClose has not yet been triggered, activeClientsByWorkspaceKey still points to the disposed client.
   * All paths that reuse active entries must first pass this check; when disposed, the stale entries are cleared and false is returned.
   * Let the caller restart the process (start-if-needed) or handle it as "no runtime" (existing-only).
   */
  function isReusableActiveClientEntry(
    params: ZCodeAgentWorkspaceTarget,
    active: ActiveWorkspaceClient | undefined,
  ): boolean {
    if (!active) {
      return false;
    }
    if (!active.client.isDisposed) {
      return true;
    }
    const workspaceKey = resolveWorkspaceKey(params);
    activeClientsByWorkspaceKey.delete(workspaceKey);
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
    logger.warn(undefined, "reused ZCode Protocol client is disposed, dropping the stale entry", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return false;
  }

  async function getOrStartReadOnlyClient(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ActiveWorkspaceClient> {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active && isReusableActiveClientEntry(params, active)) {
      active.workspace = params;
      await active.interactionPreferencesReady;
      return active;
    }

    const client = await processManager.getClient(params);
    wireClient(client, params, "chat");

    // processManager will launch single-flight concurrently by workspaceKey. During the await period, if another
    // The read/write path has registered the same client, and the existing entry must be reused, and the improved write capability cannot be reduced back to false.
    const concurrent = activeClientsByWorkspaceKey.get(workspaceKey);
    if (concurrent && isReusableActiveClientEntry(params, concurrent)) {
      concurrent.workspace = params;
      await concurrent.interactionPreferencesReady;
      return concurrent;
    }

    const entry: ActiveWorkspaceClient = {
      client,
      modelExecutionEnabled: false,
      workspace: params,
    };
    activeClientsByWorkspaceKey.set(workspaceKey, entry);
    const interactionPreferencesReady = (async () => {
      let appliedSnapshot: ZCodeAgentAppRuntimePreferences | undefined;
      while (latestAppRuntimePreferences && latestAppRuntimePreferences !== appliedSnapshot) {
        const snapshot = latestAppRuntimePreferences;
        await enqueueInteractionPreferenceSync({
          client,
          preferences: { ...snapshot },
          workspace: params,
        });
        appliedSnapshot = snapshot;
      }
    })();
    // Off-Peak native support capabilities are workspace-level facts that are synchronized to the CLI before any session is allowed to work.
    // Let v4 cold recovery (without per-request flag channel) also get the tool surface. Old CLI method-not-found downgrade ignored.
    // The CLI default is false, and each agent process only serves one workspace. No request is sent when the access control is closed (for cases where this is not implemented)
    // Method's old CLI/test fake client (zero bother).
    const offPeakToolPolicyReady = (async () => {
      if (!isOffPeakToolSupported(params)) return;
      try {
        await client.request(
          zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy,
          { workspace: buildWorkspaceRef(params), enabled: true },
          zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
        );
      } catch (error) {
        // Policy synchronization is a best-effort capability distribution, and the failure direction is fail-closed (CLI does not register tools by default).
        // Timeouts/transient IPC errors must not block client readiness; -32601 is a graceful downgrade from the old CLI.
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "Off-Peak tool policy sync failed, CLI stays off by default", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    // Dynamic Workflow Grayscale Access Control: Same as Off-Peak
    // The workspace-level facts of the mode are synchronized to the CLI before any session work is allowed, and v4 cold recovery only has access to the tool surface.
    // No requests are sent when closed (CLI default is false, zero interruption to old CLI/test fake clients).
    const dynamicWorkflowPolicyReady = (async () => {
      if (!(await resolveDynamicWorkflowGate())) return;
      try {
        await client.request(
          zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy,
          { workspace: buildWorkspaceRef(params), enabled: true },
          zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
        );
      } catch (error) {
        // The same criterion as Off-Peak: -32601 is a normal downgrade of the old CLI (its z.object will also lose the session flag,
        // The overall return is disabled); other errors are only recorded as warn, and the client is not blocked from being ready.
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "dynamic workflow policy sync failed, CLI stays off by default", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    entry.interactionPreferencesReady = Promise.all([
      interactionPreferencesReady,
      offPeakToolPolicyReady,
      dynamicWorkflowPolicyReady,
    ]).then(() => undefined);
    try {
      // New or restarted runtime flushes cache before allowing any session to work; new switch during synchronization
      // Because the entry has been registered, it will enter the same workspace serial queue and the submission order will not be lost.
      await entry.interactionPreferencesReady;
    } catch (error) {
      if (activeClientsByWorkspaceKey.get(workspaceKey) === entry) {
        activeClientsByWorkspaceKey.delete(workspaceKey);
      }
      throw error;
    } finally {
      delete entry.interactionPreferencesReady;
    }
    logger.info(undefined, "starting the ZCode agent for the read-only session control plane", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry;
  }

  async function getClient(params: ZCodeAgentWorkspaceTarget) {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.modelExecutionEnabled && isReusableActiveClientEntry(params, active)) {
      active.workspace = params;
      return active.client;
    }

    const waiting = waitingWorkspaceStartups.get(workspaceKey) ?? {
      cancelled: false,
      workspace: params,
    };
    waiting.workspace = params;
    waitingWorkspaceStartups.set(workspaceKey, waiting);

    const readinessSnapshot = await resolveStartupReadiness();
    // Readiness reading may be interleaved with workspace release; after release deletes waiting identity,
    // Old continuations cannot create new processes. If you reopen the same path in the future, you will get a new identity without causing any harm to each other.
    if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
      throw createRuntimeUnavailableError(params);
    }
    const readiness = readinessSnapshot?.readiness;
    if (!readinessSnapshot || !readiness?.ready) {
      const revision = readinessSnapshot?.revision ?? "missing";
      if (waiting.lastLoggedRevision !== revision) {
        waiting.lastLoggedRevision = revision;
        logger.info(
          undefined,
          active
            ? "provider/model is not ready yet, ZCode agent stays read-only"
            : "provider/model is not ready yet, ZCode agent stays unstarted",
          {
            providerCount: readinessSnapshot?.providerCount ?? 0,
            revision: readinessSnapshot?.revision ?? null,
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
      }
      throw createProviderNotReadyError({ snapshot: readinessSnapshot, workspace: params });
    }

    const entry = await getOrStartReadOnlyClient(params);
    if (waiting.cancelled) {
      throw createRuntimeUnavailableError(params);
    }
    entry.modelExecutionEnabled = true;
    processManager.markReady(params, entry.client);
    entry.workspace = params;
    waitingWorkspaceStartups.delete(workspaceKey);
    logger.info(undefined, "provider/model is ready, ZCode agent model execution is allowed", {
      modelId: readiness.modelId,
      providerId: readiness.providerId,
      revision: readinessSnapshot.revision,
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry.client;
  }

  async function getReadOnlyClient(
    params: ZCodeAgentWorkspaceTarget,
    runtimePolicy: "start-if-needed" | "existing-only" = "start-if-needed",
  ) {
    if (runtimePolicy === "existing-only") {
      const workspaceKey = resolveWorkspaceKey(params);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      // The observer path must also reject the disposed stale entry; after cleaning, it will be processed as "no runtime".
      // Never spin up a new process for observers (preserving existing-only semantics).
      if (active && isReusableActiveClientEntry(params, active)) {
        active.workspace = params;
        return active.client;
      }
      // The runtime available may arrive before the await continuation of the original startup call. It is allowed here
      // A client registered by the process manager is promoted to a service active entry, but a new process is never created.
      const existingClient = processManager.getExistingClient(params);
      if (!existingClient) {
        throw createRuntimeUnavailableError(params);
      }
      wireClient(existingClient, params, "chat");
      activeClientsByWorkspaceKey.set(workspaceKey, {
        client: existingClient,
        modelExecutionEnabled: false,
        workspace: params,
      });
      return existingClient;
    }
    return (await getOrStartReadOnlyClient(params)).client;
  }

  async function getPluginManagementClient(): Promise<ZCodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await pluginProcessManager.getClient(workspace);
    wireClient(client, workspace, "plugin");
    return client;
  }

  // Vector runtime selection for global workflows:
  // When the caller only provides `{ scope: "global" }` without workspace, any active **local** runtime will be reused first.
  // (existing-only semantics: only look at activeClientsByWorkspaceKey, never start a new process for this), otherwise fall back to
  // Management surface workspace - follow the getPluginManagementClient precedent and use a dedicated pluginProcessManager to pull a control surface
  // runtime. Reasons to choose it instead of getOrStartReadOnlyClient: workflows/* are sessionless and do not rely on provider/model
  // A ready workspace level method, the management plane process is prepared for this kind of control plane capability that "does not host the real project", and will not be affected by the
  // The real workspace life cycle is recycled by watchdog; getOrStartReadOnlyClient will instead synthesize this into workspace
  // Stuff activeClientsByWorkspaceKey and run interaction preference synchronization again, polluting the session client map. Both paths are on this machine,
  // homedir() is the user's home directory, and the global root `~/.zcode/workflows/` therefore resolves to the real directory.
  // The home of the remote runtime (SSH/WSL identity or with remoteSessionId) is not the local machine and should never be selected as the carrier.
  function isLocalActiveWorkspaceClient(workspace: ZCodeAgentWorkspaceTarget): boolean {
    return (
      !workspace.remoteSessionId &&
      !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
    );
  }

  async function resolveGlobalSavedWorkflowCarrier(): Promise<{
    client: ZCodeProtocolClient;
    workspace: ZCodeWorkspaceRef;
  }> {
    for (const active of activeClientsByWorkspaceKey.values()) {
      if (!isLocalActiveWorkspaceClient(active.workspace)) {
        continue;
      }
      // The cleanup semantics of disposed / stale entries are consistent with getReadOnlyClient(existing-only):
      // isReusableActiveClientEntry will clear the recycled entry, and then we will skip it and continue looking.
      if (!isReusableActiveClientEntry(active.workspace, active)) {
        continue;
      }
      return { client: active.client, workspace: buildWorkspaceRef(active.workspace) };
    }
    const managementWorkspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await getPluginManagementClient();
    return { client, workspace: buildWorkspaceRef(managementWorkspace) };
  }

  // The carriers of the five workflows/* methods: direct access with workspace (project file, or action explicitly stated scope in the GUI project group),
  // Only given `scope:"global"` when passed to services optional native carrier.
  async function resolveSavedWorkflowCarrier(
    params: ZCodeAgentSavedWorkflowTarget,
  ): Promise<{ client: ZCodeProtocolClient; workspace: ZCodeWorkspaceRef }> {
    if (savedWorkflowTargetHasWorkspace(params)) {
      return { client: await getReadOnlyClient(params), workspace: buildWorkspaceRef(params) };
    }
    return resolveGlobalSavedWorkflowCarrier();
  }

  // mcp/list exclusive: isolate the process from the plug-in management command, see the instructions at mcpStatusProcessManager.
  async function getMcpStatusClient(): Promise<ZCodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await mcpStatusProcessManager.getClient(workspace);
    wireClient(client, workspace, "mcp-status");
    return client;
  }

  function disposeLocalState(): void {
    accountProviderConfigUnsubscribe?.();
    accountProviderConfigUnsubscribe = undefined;
    modelSelectionSubscription?.dispose();
    modelSelectionSubscription = undefined;
    memoryDiagnostics.dispose();
    for (const emitter of sessionEmitters.values()) {
      emitter.dispose();
    }
    sessionEmitters.clear();
    sessionRuntimePreferencesRequestEmitter.dispose();
    processResourceSampleEmitter.dispose();
    mcpTelemetryEmitter.dispose();
    toolExecResourceEmitter.dispose();
    mcpResourceSamplesEmitter.dispose();
    for (const emitter of pluginOperationProgressEmitters.values()) {
      emitter.dispose();
    }
    pluginOperationProgressEmitters.clear();
    for (const emitter of conversationFrameEmitters.values()) {
      emitter.dispose();
    }
    conversationFrameEmitters.clear();
    for (const emitter of conversationTelemetryFactEmitters.values()) {
      emitter.dispose();
    }
    conversationTelemetryFactEmitters.clear();
    localTtftFactsEmitter.dispose();
    cuaPermissionObservationEmitter.dispose();
    for (const emitter of workspaceConfigFrameEmitters.values()) {
      emitter.dispose();
    }
    workspaceConfigFrameEmitters.clear();
    for (const emitter of sessionsIndexFrameEmitters.values()) {
      emitter.dispose();
    }
    sessionsIndexFrameEmitters.clear();
    sessionEventSequenceStates.clear();
    pendingPermissions.clear();
    pendingUserInputs.clear();
    pendingProviderRuntimeHeaders.clear();
    for (const pending of pendingSessionRuntimePreferences.values()) {
      clearTimeout(pending.timeout);
    }
    pendingSessionRuntimePreferences.clear();
    activeClientsByWorkspaceKey.clear();
    cancelAllWaitingWorkspaceStartups();
    interactionPreferenceSyncByWorkspaceKey.clear();
    cuaOperationTurnTracker?.clearAll();
    clearV4SubscriptionRoutes();
    v4RouteRuntimeRestartDisposable.dispose();
    runtimeLifecycleDisposable.dispose();
  }

  // 3.12.2: Remote grayscale reads cannot be put into client ready and create commands: serial retries will block normal chats on failure.
  // Registration only determines local support capabilities; grayscale, package and model access are still verified by the offPeak/create handler before taking an account.
  function isOffPeakToolSupported(params: {
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): boolean {
    if (!options?.resolveOffPeakClientConfig || !options.resolveOffPeakTaskService) return false;
    if (params.remoteSessionId) return false;
    return !params.workspaceIdentity || !isRemoteWorkspaceIdentity(params.workspaceIdentity);
  }

  /**
   * Dynamic workflow grayscale gate: Host is determined once and then
   * In-process fixed. Three reasons:
   *   1. The same judgment is fed to workspace/updateDynamicWorkflowPolicy and session flag at the same time, and the two will not
   *      There is a gap between "strategy is on, create is off";
   *   2. The judgment falls on the client ready path, and you cannot wait for the remote end every time you establish a session - 3.12.2 has already returned once because of this;
   *   3. If the read fails, it will be fail-closed and will not be retried to avoid a request timeout for each create when offline;
   *      The grayscale flipping on the server side is designed to take effect in the next Host process (there is also a 1h snapshot and forceRefresh on the provider side).
   * Different from Off-Peak: remote workspace is also available, so workspaceIdentity / remoteSessionId is not looked at here.
   */
  function resolveDynamicWorkflowGate(): Promise<boolean> {
    const resolve = options?.resolveDynamicWorkflowClientConfig;
    if (!resolve) return Promise.resolve(false);
    dynamicWorkflowGate ??= (async () => {
      try {
        return (await resolve())?.enabled === true;
      } catch (error) {
        logger.warn(undefined, "failed to read the dynamic workflow rollout, treating it as off", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })();
    return dynamicWorkflowGate;
  }

  async function buildConversationCommandEnvelope(
    params: ZCodeAgentConversationCommandParams,
  ): Promise<CommandEnvelope> {
    const envelope = params.envelope;
    if (envelope.type === "createSession") {
      // V4 createSession bypasses the parameter construction of legacy session/create, and the tool surface flag must be in
      // Same-origin injection at the envelope; no field is written when the access control is false (the default is fail-closed, consistent with legacy).
      const dynamicWorkflowEnabled = await resolveDynamicWorkflowGate();
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      if (!offPeakToolEnabled && !dynamicWorkflowEnabled) return envelope;
      const payload = commandPayloadSchemas.createSession.parse(envelope.payload);
      return {
        ...envelope,
        payload: {
          ...payload,
          ...(offPeakToolEnabled ? { offPeakToolEnabled: true } : {}),
          // Dynamic workflow grayscale: V4 createSession is the actual creation path of a new desktop session. If there is no transparent transmission, there are nine tools.
          // Never register.
          ...(dynamicWorkflowEnabled ? { dynamicWorkflowEnabled: true } : {}),
        },
      };
    }
    if (envelope.type !== "sendText") return envelope;

    const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
    // After reading the persistent cronAutomationId, the entire binding session cannot be permanently regarded as automation
    // Execution context. The user's subsequent active input will therefore be lost in CronUpdate/CronDelete. Only the payload of this round is recognized here;
    // The compatibility identification of the missed payload by automation runId is handled by the CLI's resolveTurnAutomationId.
    if (payload.automationId) {
      // The automation dispatch of desktop continuous does not necessarily go through the task adapter; the current round is merged at the protocol envelope
      // denylist, and does not overwrite the caller's existing policies.
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeAutomationMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    if (payload.offPeakTaskId) {
      // Dispatch rounds of the same type in idle time - only deny OffPeakCreate (OffPeakList read-only reserved).
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeOffPeakMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    return envelope;
  }

  return {
    async prepareStorage(params) {
      const client = await processManager.getClient(params);
      wireClient(client, params, "chat");
      await client.storageStartup.wait();
    },
    async getStorageStartupState(params) {
      return processManager.getStorageStartupState(params);
    },
    onDynamicStorageStartupState(params) {
      const workspaceKey = resolveWorkspaceKey(params);
      return (listener) =>
        processManager.onStorageStartupChanged((event) => {
          if (event.workspaceKey === workspaceKey) listener(event.snapshot);
        });
    },
    hasActiveCuaOperationTurn(): boolean {
      return cuaOperationTurnTracker?.hasActiveTurn() ?? false;
    },
    async initialize(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAgentInitializeResult> {
      const workspaceKey = resolveWorkspaceKey(params);
      const startedAt = Date.now();
      logger.info(undefined, "initializing ZCode agent", {
        workspaceKey,
        workspacePath: params.workspacePath,
      });
      try {
        const client = await getClient(params);
        logger.info(undefined, "ZCode agent initialization completed", {
          durationMs: Date.now() - startedAt,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        return {
          available: true,
          workspaceKey,
          protocolName: ZCODE_PROTOCOL_NAME,
          protocolVersion: ZCODE_PROTOCOL_VERSION,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
        };
      } catch (error) {
        const providerNotReady = isProviderNotReadyError(error);
        logger[providerNotReady ? "info" : "warn"](
          undefined,
          providerNotReady
            ? "ZCode agent is waiting for provider/model readiness"
            : "ZCode agent initialization failed",
          {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
        // initialize now assumes the responsibility of host startup warm-up, but the first screen cannot crash directly due to the lack of agent.
        // Leave the available=false result to let the UI/caller follow the existing recoverable error path.
        return {
          available: false,
          workspaceKey,
          protocolName: ZCODE_PROTOCOL_NAME,
          protocolVersion: ZCODE_PROTOCOL_VERSION,
          reason: error instanceof Error ? error.message : String(error),
          ...(providerNotReady ? { reasonCode: ZCODE_AGENT_PROVIDER_NOT_READY_REASON } : {}),
        };
      }
    },

    async syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void> {
      const normalizedPreferences: ZCodeAgentAppRuntimePreferences = {
        ...preferences,
        modelIoFullRetentionEnabled: preferences.modelIoFullRetentionEnabled === true,
      };
      latestAppRuntimePreferences = normalizedPreferences;
      const activeClients = [...activeClientsByWorkspaceKey.values()];
      await Promise.all(
        activeClients.map((entry) =>
          enqueueInteractionPreferenceSync({
            client: entry.client,
            preferences: { ...normalizedPreferences },
            workspace: entry.workspace,
          }),
        ),
      );
    },

    async getWorkspaceRuntimeIdentity(params: ZCodeAgentWorkspaceTarget) {
      // Querying runtime identity can only observe existing processes and cannot turn dormant workspace into active processes.
      await getReadOnlyClient(params, "existing-only");
      return await processManager.getRuntimeIdentity(params);
    },

    async createSession(params: ZCodeAgentCreateSessionParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_create",
        workspace: params,
      });
      const sessionTraceId = params.sessionTraceId;
      logger.info(sessionTraceId, "requesting ZCode Protocol session/create", {
        hasInitialModel: params.model !== undefined,
        hasInitialThoughtLevel: params.thoughtLevel !== undefined,
        initialModel: formatModelSelectionForLog(params.model),
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        persistence: params.persistence,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // Grayscale has been determined when the client is ready. Here is the await again of the resolved promise in the process (without hitting the remote end).
      const dynamicWorkflowEnabled = await resolveDynamicWorkflowGate();
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionCreate,
          buildSessionCreateParams({ ...params, offPeakToolEnabled, dynamicWorkflowEnabled }),
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace({ ...params, sessionId: snapshot.session.sessionId }, snapshot);
        logger.info(sessionTraceId, "ZCode Protocol session/create completed", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          persistence: params.persistence,
          sessionId: snapshot.session.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        const compatFields = getSessionCreateCompatFields(error);
        if (compatFields.length === 0) {
          logger.warn(sessionTraceId, "ZCode Protocol session/create failed", {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            persistence: params.persistence,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw error;
        }
        logger.warn(
          sessionTraceId,
          "ZCode Protocol session/create hit the old/new protocol compat retry",
          {
            compatFields,
            durationMs: Date.now() - startedAt,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          },
        );
        // host/UI may have sent a new version of session/create optional fields, but local packaging,
        // Remote deployments or old app-servers that are still alive are still using the old strict schema. only known
        // Optional field downgrade and retry to avoid thoughtLevel/persistence version differences blocking initial creation.
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionCreate,
          buildSessionCreateParams(
            { ...params, offPeakToolEnabled, dynamicWorkflowEnabled },
            new Set(compatFields),
          ),
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace({ ...params, sessionId: snapshot.session.sessionId }, snapshot);
        if (!compatFields.includes("thoughtLevel") || !params.thoughtLevel) {
          logger.info(sessionTraceId, "ZCode Protocol session/create compat retry completed", {
            durationMs: Date.now() - startedAt,
            sessionId: snapshot.session.sessionId,
            snapshotTraceId: snapshot.session.traceId ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return snapshot;
        }
        // When the old create schema does not recognize thoughtLevel, use the old protocol after creation.
        // session/setThoughtLevel ensures that the first round of prompts still uses the reasoning strength selected by the user on the toolbar.
        const snapshotWithThoughtLevel = await client.request(
          zcodeProtocolMethods.sessionSetThoughtLevel,
          {
            sessionId: snapshot.session.sessionId,
            thoughtLevel: params.thoughtLevel,
            persistAsWorkspaceLastUsed: true,
          },
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace(
          { ...params, sessionId: snapshotWithThoughtLevel.session.sessionId },
          snapshotWithThoughtLevel,
        );
        logger.info(
          sessionTraceId,
          "ZCode Protocol session/create set thoughtLevel after the compat retry",
          {
            durationMs: Date.now() - startedAt,
            sessionId: snapshot.session.sessionId,
            snapshotTraceId: snapshotWithThoughtLevel.session.traceId ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          },
        );
        return snapshotWithThoughtLevel;
      }
    },

    async resumeSession(params: ZCodeAgentResumeSessionParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_resume",
        workspace: params,
      });
      const cachedTraceId = getSessionTraceId(params);
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // Cold recovery is also issued based on the host's grayscale determination, otherwise the restored session will lose the workflow tool cluster.
      const dynamicWorkflowEnabled = await resolveDynamicWorkflowGate();
      logger.info(cachedTraceId, "requesting ZCode Protocol session/resume", {
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        modelHint: params.model ?? null,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionResume,
          buildSessionResumeParams({ ...params, offPeakToolEnabled, dynamicWorkflowEnabled }),
          zcodeSessionStateSnapshotSchema,
        );
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "ZCode Protocol session/resume completed", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        const compatFields = getSessionResumeCompatFields(error);
        if (compatFields.length === 0) {
          logger.warn(cachedTraceId, "ZCode Protocol session/resume failed", {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw error;
        }
        logger.warn(
          cachedTraceId,
          "ZCode Protocol session/resume hit the old/new protocol compat retry",
          {
            compatFields,
            durationMs: Date.now() - startedAt,
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          },
        );
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionResume,
          buildSessionResumeParams(
            { ...params, offPeakToolEnabled, dynamicWorkflowEnabled },
            new Set(compatFields),
          ),
          zcodeSessionStateSnapshotSchema,
        );
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "ZCode Protocol session/resume compat retry completed", {
          durationMs: Date.now() - startedAt,
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      }
    },

    async listSessions(params: ZCodeAgentListSessionsParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const result = await client.request(
        zcodeProtocolMethods.sessionList,
        {
          workspace: buildWorkspaceRef(params),
          includeArchived: params.includeArchived ?? false,
          limit: params.limit,
          ...(params.sessionIds ? { sessionIds: params.sessionIds } : {}),
        },
        zcodeSessionListResultSchema,
      );
      for (const session of result.sessions) {
        if (session.traceId) {
          sessionTraceIdBySessionKey.set(
            sessionEventKey({ ...params, sessionId: session.sessionId }),
            session.traceId as TraceId,
          );
        }
      }
      return result.sessions;
    },

    async listSessionSubagents(params: ZCodeAgentListSessionSubagentsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.sessionSubagents,
        {
          sessionId: params.sessionId,
          endedCursor: params.endedCursor,
          endedLimit: params.endedLimit ?? 20,
        },
        zcodeSessionSubagentsResultSchema,
      );
    },

    async getAppUsageStats(params: ZCodeAgentAppUsageParams) {
      // The usage table is located in the global session library; reuse any connected workspace client to obtain application-wide data.
      const active = activeClientsByWorkspaceKey.values().next().value;
      if (!active) {
        throw new Error("no_active_workspace");
      }
      // usage/stats → v4/usage/stats (additive query, source of truth in CLI usage store,
      // The payloads are of the same shape; the consumption of old words is cleared, and the CLI old cases are retained until the old words are deleted).
      return active.client.request(
        V4_METHODS.usageStats,
        { range: params.range, timeZone: params.timeZone },
        v4UsageStatsResultSchema,
      );
    },

    async getTaskTokenUsage(params: ZCodeAgentTaskTokenUsageParams) {
      const client = await getReadOnlyClient(params);
      // session/usage → v4/conversation/usage (same as above; task is the UI projection concept,
      // v4 namespace placement conversation).
      return client.request(
        V4_METHODS.conversationUsage,
        { sessionId: params.sessionId },
        v4ConversationUsageResultSchema,
      );
    },

    async readSession(params: ZCodeAgentReadSessionParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      // task-index When calling readSession for the supplementary text index, the default strategy will be in the runtime
      // Restart the Agent after it has been recycled; this observation path should not change the session life cycle. only explicit
      // Ordinary reads are synchronized with the provider registry, and existing-only reads must maintain pure observation semantics.
      if (params.runtimePolicy !== "existing-only") {
        await ensureAccountProviderConfigSynced({
          client,
          reason: "session_read",
          workspace: params,
        });
      }
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionRead,
        {
          sessionId: params.sessionId,
          deliveryKind: params.deliveryKind,
          messageLimit: params.messageLimit,
          afterSeq: params.afterSeq,
        },
        zcodeSessionStateSnapshotSchema,
      );
      rememberSessionTrace(params, snapshot);
      return snapshot;
    },

    async readSessionMessages(params: ZCodeAgentReadSessionMessagesParams) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionMessages,
        {
          sessionId: params.sessionId,
          afterMessageId: params.afterMessageId,
          limit: params.limit,
        },
        zcodeSessionMessagesResultSchema,
      );
      return result.messages;
    },

    async readSessionDebug(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      return client.request(
        zcodeProtocolMethods.sessionDebug,
        { sessionId: params.sessionId },
        sessionDebugSnapshotSchema,
      );
    },

    async readSessionEvents(params: ZCodeAgentReadSessionEventsParams) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionEvents,
        {
          sessionId: params.sessionId,
          afterSeq: params.afterSeq,
          limit: params.limit,
        },
        zcodeSessionEventsResultSchema,
      );
      return result.events;
    },

    async readWorkspacePresentation(params: ZCodeAgentReadWorkspacePresentationParams) {
      const startedAt = Date.now();
      logger.info(undefined, "requesting ZCode Protocol workspace/readPresentation", {
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        let presentation: ZCodeWorkspacePresentation | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const client = await getReadOnlyClient(params);
          try {
            await ensureAccountProviderConfigSynced({
              client,
              reason: "workspace_read_presentation",
              workspace: params,
            });
            presentation = await client.request(
              zcodeProtocolMethods.workspaceReadPresentation,
              { workspace: buildWorkspaceRef(params) },
              zcodeWorkspacePresentationSchema,
            );
            break;
          } catch (error) {
            if (attempt > 0 || !isClosedStdioTransportError(error)) {
              throw error;
            }
            // When reading the workspace status, a configuration update may happen to restart the workspace agent.
            // The old client has been obtained but the request has not yet been sent. The stdio transport is closed; read-only requests are reacquired.
            // current client and try again to avoid directly exposing life cycle race conditions to users.
            logger.warn(
              undefined,
              "workspace/readPresentation hit a closed transport, re-acquiring the Agent",
              {
                workspaceKey: resolveWorkspaceKey(params),
                workspacePath: params.workspacePath,
              },
            );
            const workspaceKey = resolveWorkspaceKey(params);
            if (activeClientsByWorkspaceKey.get(workspaceKey)?.client === client) {
              // transport.send may observe the shutdown first, but the onClose cleanup has not yet been executed; uniformly use identity-
              // guarded invalidation to avoid deleting the active entry but leaving the preference/model sync state.
              invalidateWorkspaceClient(workspaceKey, client);
            }
          }
        }
        if (!presentation) {
          throw new Error("ZCode Protocol workspace/readPresentation did not return a result");
        }
        logger.info(undefined, "ZCode Protocol workspace/readPresentation completed", {
          durationMs: Date.now() - startedAt,
          slashCommandCount: presentation.slashCommands.length,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return presentation;
      } catch (error) {
        logger.warn(undefined, "ZCode Protocol workspace/readPresentation failed", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async grantWorkspaceHookTrust(params: ZCodeAgentGrantWorkspaceHookTrustParams) {
      // Explicit pretrust is still allowed when there is no task, but only the read-only Agent control plane is started; it cannot be used for
      // The Settings operation fakes a session and cannot require the provider/model to be ready.
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workspaceHookTrustGrant,
        {
          workspace: buildWorkspaceRef(params),
          bundleDigest: params.bundleDigest,
          hookDeclarationDigest: params.hookDeclarationDigest,
        },
        zcodeWorkspaceHookTrustGrantResultSchema,
      );
    },

    async listMcpServerStatuses(params: ZCodeAgentListMcpServerStatusesParams) {
      const requestMcpList = async (options?: { omitMcpServers?: boolean; omitMode?: boolean }) => {
        const client = await getMcpStatusClient();
        return client.request(
          zcodeProtocolMethods.mcpList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.mcpServers !== undefined && !options?.omitMcpServers
              ? { mcpServers: params.mcpServers }
              : {}),
            ...(params.mode !== undefined && !options?.omitMode ? { mode: params.mode } : {}),
          },
          zcodeMcpListResultSchema,
        );
      };
      try {
        return await requestMcpList();
      } catch (error) {
        const unrecognizedKeys = getUnrecognizedTopLevelKeys(error);
        if (params.mode === "status" && unrecognizedKeys.includes("mode")) {
          // When the old Agent does not recognize status-only, omitting mode and retrying will return to the default connect.
          // Re-execute replace convergence and possibly disconnect MCPs that were explicitly delivered by the UI but do not exist in the old Agent configuration;
          // Stable error codes are retained across host RPCs and are used by the UI to stop polling that is unlikely to succeed.
          logger.warn(
            undefined,
            "old Agent does not support MCP status-only, skipping the compat retry that would change the connection set",
            {
              workspaceKey: resolveWorkspaceKey(params),
              workspacePath: params.workspacePath,
            },
          );
          throw new ZCodeAgentMcpStatusModeUnsupportedError();
        }
        if (
          (params.mode !== undefined && unrecognizedKeys.includes("mode")) ||
          (params.mcpServers !== undefined && unrecognizedKeys.includes("mcpServers"))
        ) {
          const omitMode = unrecognizedKeys.includes("mode");
          const omitMcpServers = unrecognizedKeys.includes("mcpServers");
          logger.warn(undefined, "MCP status list hit the old/new protocol compat retry", {
            omittedKeys: [...(omitMode ? ["mode"] : []), ...(omitMcpServers ? ["mcpServers"] : [])],
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return await requestMcpList({
            omitMcpServers,
            omitMode,
          });
        }
        if (!isProtocolRequestTimeout(error, zcodeProtocolMethods.mcpList)) {
          throw error;
        }
        logger.warn(
          undefined,
          "MCP status list request timed out, restarting the unresponsive agent and retrying once",
          {
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
            message: error instanceof Error ? error.message : String(error),
          },
        );
        return await requestMcpList();
      }
    },

    async listPlugins(params: ZCodeAgentPluginViewParams) {
      const requestPluginsList = async () => {
        const client = await getPluginManagementClient();
        // plugins/list only reads local plugin metadata, and uses the default protocol timeout like mcp/list.
        // This allows the stale client to trigger recycling and retry within a reasonable amount of time, rather than being held back by a 5-minute market I/O timeout.
        return client.request(
          zcodeProtocolMethods.pluginsList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.configScope ? { configScope: params.configScope } : {}),
          },
          zcodePluginsListResultSchema,
        );
      };
      try {
        return await requestPluginsList();
      } catch (error) {
        if (!isProtocolRequestTimeout(error, zcodeProtocolMethods.pluginsList)) {
          throw error;
        }
        logger.warn(
          undefined,
          "plugin list request timed out, restarting the unresponsive agent and retrying once",
          {
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
            message: error instanceof Error ? error.message : String(error),
          },
        );
        // The plugin list only reads CLI plugin metadata. If the old agent process is still alive but the protocol does not return packets,
        // After the first plugins/list times out, the stale client cannot be reused. The process manager will recycle the client when it times out.
        // Here, the idempotent list request is retried so that the settings page can be automatically restored from the restarted app-server.
        return await requestPluginsList();
      }
    },

    async getPluginReferenceCatalog(params: ZCodeAgentPluginReferenceCatalogParams) {
      // The Plugin reference catalog must go to the workspace agent client that holds the session record.
      // (getReadOnlyClient reuses active client first), and cannot use independent plugin management process——
      // That process does not have any sessions, and the session-owned catalog will never be found.
      const client = await getReadOnlyClient(params);
      return requestPluginReferenceCatalog(client, {
        workspace: buildWorkspaceRef(params),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      });
    },

    async getSkillReferenceCatalog(params: ZCodeAgentSkillReferenceCatalogParams) {
      // Like Plugin references, Session snapshots only exist in the workspace agent process; independent management processes
      // Without a resident Session, it cannot be used as a conversation authority.
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.skillsReferenceCatalog,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        },
        zcodeSkillsReferenceCatalogResultSchema,
      );
    },

    // GUI hub for saved workflows: same as Skill catalog
    // Workspace agent client path; the file is in the workspace, and the remote workspace is scanned in the remote process.
    // Global file: The carrier is selected by resolveSavedWorkflowCarrier,
    // `scope` is only pushed down if defined.
    async listSavedWorkflows(params: ZCodeAgentListSavedWorkflowsParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsList,
        { workspace, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsListResultSchema,
      );
    },

    async getSavedWorkflow(params: ZCodeAgentGetSavedWorkflowParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsGet,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsGetResultSchema,
      );
    },

    async updateSavedWorkflowMeta(params: ZCodeAgentUpdateSavedWorkflowMetaParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsUpdateMeta,
        { workspace, name: params.name, meta: params.meta, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsUpdateMetaResultSchema,
      );
    },

    async deleteSavedWorkflow(params: ZCodeAgentDeleteSavedWorkflowParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsDelete,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsDeleteResultSchema,
      );
    },

    async listSavedWorkflowRuns(params: ZCodeAgentListSavedWorkflowRunsParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsRuns,
        {
          workspace,
          ...(params.name === undefined ? {} : { name: params.name }),
          limit: params.limit,
          ...savedWorkflowScopeParam(params),
        },
        zcodeWorkflowsRunsResultSchema,
      );
    },

    // Move the global file back to the project file (only this time):
    // `workspace` is required, it is both the carrier and the target project (the protocol processor counts it as the project root), so go
    // getReadOnlyClient(params) Pass-through, without global carrier selection.
    async moveSavedWorkflow(params: ZCodeAgentMoveSavedWorkflowParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsMove,
        { workspace: buildWorkspaceRef(params), name: params.name },
        zcodeWorkflowsMoveResultSchema,
      );
    },

    async resolveSuggestedPluginReference(params: ZCodeAgentResolveSuggestedPluginReferenceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsResolveSuggestedReference,
        {
          workspace: buildWorkspaceRef(params),
          stableId: params.stableId,
          operationId: params.operationId,
          clientMode: params.clientMode,
          deliveryKind: params.deliveryKind,
        },
        zcodePluginsResolveSuggestedReferenceResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    onDynamicPluginOperationProgress(operationId: string) {
      return getPluginOperationProgressEmitter(operationId).event;
    },

    async collectLocalRuntimeChildProcesses(signal?: AbortSignal) {
      const managed = [processManager, pluginProcessManager, mcpStatusProcessManager]
        .flatMap((manager) => manager.listManagedProcesses())
        .filter(
          (runtime) => !runtime.client.isDisposed && !runtime.client.storageStartup.isWaiting,
        );
      return Promise.all(
        managed.map(async (runtime) => {
          let children: ZCodeProcessChildProcess[] = [];
          try {
            const result = await runtime.client.request(
              zcodeProtocolMethods.processChildProcesses,
              {},
              zcodeProcessChildProcessesResultSchema,
              { timeoutMs: CHILD_PROCESSES_REQUEST_TIMEOUT_MS, lifecycle: "observation", signal },
            );
            children = result.processes;
          } catch {
            // The old CLI does not recognize this method or the runtime is busy: all the descendants of the Agent in this round belong to the CLI and do not affect other runtimes.
          }
          return {
            pid: runtime.pid,
            provider: ZCODE_AGENT_PROVIDER,
            workspacePath: runtime.workspacePath,
            ...(runtime.lane ? { lane: runtime.lane } : {}),
            children,
          };
        }),
      );
    },

    async getPluginsOverview(params: ZCodeAgentPluginViewParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsOverview,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.configScope ? { configScope: params.configScope } : {}),
        },
        zcodePluginsOverviewResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async addPluginMarketplace(params: ZCodeAgentAddPluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceAdd,
        {
          workspace: buildWorkspaceRef(params),
          source: params.source,
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async removePluginMarketplace(params: ZCodeAgentRemovePluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceRemove,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async updatePluginMarketplace(params: ZCodeAgentUpdatePluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async installPlugin(params: ZCodeAgentInstallPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsInstall,
        {
          workspace: buildWorkspaceRef(params),
          pluginName: params.pluginName,
          marketplace: params.marketplace,
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async cancelPluginOperation(params: ZCodeAgentCancelPluginOperationParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsCancelOperation,
        { operationId: params.operationId },
        zcodePluginsCancelOperationResultSchema,
        { timeoutMs: PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS },
      );
    },

    async uninstallPlugin(params: ZCodeAgentUninstallPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsUninstall,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.removeCache !== undefined ? { removeCache: params.removeCache } : {}),
        },
        zcodePluginsUninstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async updatePlugin(params: ZCodeAgentUpdatePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
        },
        zcodePluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async restoreBuiltinPlugin(params: ZCodeAgentRestoreBuiltinPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsRestoreBuiltin,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
        },
        zcodePluginsRestoreBuiltinResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async configurePlugin(params: ZCodeAgentConfigurePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsConfigure,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          options: params.options,
          ...(params.clearOptionKeys?.length ? { clearOptionKeys: params.clearOptionKeys } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
        },
        zcodePluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async resetPluginConfig(params: ZCodeAgentResetPluginConfigParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsResetConfig,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          ...(params.scope ? { scope: params.scope } : {}),
        },
        zcodePluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async validatePlugin(params: ZCodeAgentValidatePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsValidate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.source ? { source: params.source } : {}),
        },
        zcodePluginsValidateResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async describePlugin(params: ZCodeAgentDescribePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsDescribe,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
          pluginName: params.pluginName,
        },
        zcodePluginsDescribeResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsSetEnabled,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          enabled: params.enabled,
          ...(params.operationId ? { operationId: params.operationId } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
        },
        zcodePluginsSetEnabledResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async listAutomations(params: ZCodeAgentWorkspaceTarget) {
      return automationService.list(params);
    },

    async listAllAutomations() {
      return automationService.list();
    },

    async createAutomation(params: ZCodeAgentCreateAutomationParams) {
      return automationService.create({
        title: params.title,
        cronExpr: params.cronExpr,
        relativeDelayMinutes: params.relativeDelayMinutes,
        prompt: params.prompt,
        modelSelection: params.modelSelection,
        mode: params.mode as ZCodeTaskMode | undefined,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        recurring: params.recurring ?? true,
        maxRuns: params.maxRuns,
        endAt: params.endAt,
        scheduleRule: params.scheduleRule,
      });
    },

    async updateAutomation(params: ZCodeAgentUpdateAutomationParams) {
      return automationService.update(
        params.automationId,
        {
          title: params.title,
          cronExpr: params.cronExpr,
          prompt: params.prompt,
          modelSelection: params.modelSelection,
          mode: params.mode === null ? null : (params.mode as ZCodeTaskMode | undefined),
          recurring: params.recurring,
          maxRuns: params.maxRuns,
          endAt: params.endAt,
          scheduleRule: params.scheduleRule,
          scheduleEditedByUser: params.scheduleEditedByUser,
        },
        // Ownership verification: The write operation must be limited to the current workspace of the caller, and unauthorized access across workspaces is prohibited.
        {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      );
    },

    async deleteAutomation(params: ZCodeAgentAutomationIdParams) {
      await automationService.delete(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async setAutomationEnabled(params: ZCodeAgentSetAutomationEnabledParams) {
      return automationService.setEnabled(params.automationId, params.enabled, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async restartAutomation(params: ZCodeAgentAutomationIdParams) {
      return automationService.restart(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async runAutomationNow(params: ZCodeAgentAutomationIdParams) {
      const dispatch = options?.onAutomationManualRunRequested;
      if (!dispatch) {
        // runNow will write manual run first and occupy single-flight claim; dispatcher
        // Missing is a synchronously determinable configuration error, must fail before claiming, and cannot rely on stale crash recovery.
        throw new Error("Automation immediate dispatcher is unavailable.");
      }
      const claimed = await automationService.runNow(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      if (!claimed) {
        // When single-flight has refused to run repeatedly, the old empty success return will be misjudged by the UI as
        // A new run is enqueued, causing "Fired" to be displayed once for each repeated click.
        return { status: "duplicate" as const };
      }
      await dispatch(claimed);
      return { status: "queued" as const };
    },

    async listAutomationRuns(params: ZCodeAgentAutomationIdParams) {
      return automationService.listRuns(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async deleteAutomationRun(params: ZCodeAgentDeleteAutomationRunParams) {
      return automationService.deleteRun(params.runId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async generateWorkspaceText(params: ZCodeAgentGenerateWorkspaceTextParams) {
      const client = await getClient(params);
      // Worker reads ZCode Built-in / Personal Config by itself; Host only ensures that the account status is formed before execution.
      // Account Config Overlay has been synchronized to prevent new processes from creating Models based on the old package status first.
      await ensureAccountProviderConfigSynced({
        client,
        reason: "workspace_generate_text",
        workspace: params,
      });
      const operationId = params.signal ? randomUUID() : undefined;
      const cancel = () => {
        if (!operationId) return;
        void client
          .request(
            zcodeProtocolMethods.workspaceCancelGenerateText,
            { operationId },
            zcodeWorkspaceCancelGenerateTextResultSchema,
            { timeoutMs: 5_000 },
          )
          .catch((error: unknown) => {
            // Cancellation is a best-effort control plane operation, and failure cannot overwrite the caller's original AbortError;
            // The debug trace is retained to differentiate between "local stop waiting" and "CLI received cancellation".
            logger.debug(
              undefined,
              "failed to notify cancellation of the workspace model request",
              {
                operationId,
                workspaceKey: resolveWorkspaceKey(params),
                error: error instanceof Error ? error.message : String(error),
              },
            );
          });
      };
      params.signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await client.request(
          zcodeProtocolMethods.workspaceGenerateText,
          {
            workspace: buildWorkspaceRef(params),
            selection: params.selection,
            ...(params.prompt ? { prompt: params.prompt } : {}),
            ...(params.messages ? { messages: params.messages } : {}),
            ...(params.tools ? { tools: params.tools } : {}),
            querySource: params.querySource,
            ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
            ...(operationId ? { operationId } : {}),
          },
          zcodeWorkspaceGenerateTextResultSchema,
          // When timeoutMs is not passed, the protocol client defaults to a timeout of 3 minutes, which will cause long requests to the thinking model.
          // It is triggered before the caller's own deadline, and is misjudged to be stale by onRequestTimeout and kills the process.
          // When the caller explicitly passes in requestTimeoutMs (self deadline + cancel buffering), it shall prevail.
          {
            signal: params.signal,
            ...(params.requestTimeoutMs ? { timeoutMs: params.requestTimeoutMs } : {}),
          },
        );
      } finally {
        params.signal?.removeEventListener("abort", cancel);
      }
    },

    async testModelConnectivity(params: ZCodeAgentTestModelConnectivityParams) {
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "provider_test_model_connectivity",
        workspace: params,
      });
      return client.request(
        zcodeProtocolMethods.providerTestModelConnectivity,
        {
          workspace: buildWorkspaceRef(params),
          selection: params.selection,
        },
        zcodeProviderTestModelConnectivityResultSchema,
        { signal: params.signal },
      );
    },

    async sendPrompt(params: ZCodeAgentSendPromptParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      const sessionTraceId = params.sessionTraceId?.trim() || getSessionTraceId(params);
      const logTraceId = sessionTraceId ?? params.inputId;
      const browserAmbientContext =
        params.browserAmbientContext ??
        (await collectBrowserAmbientContext(options?.browserControlExecutor, {
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
        }));
      const protocolParams: ZCodeAgentSendPromptParams = {
        ...params,
        ...(browserAmbientContext ? { browserAmbientContext } : {}),
      };
      logger.info(logTraceId, "ZCode Agent session/send started", {
        attachmentCount: params.attachments?.length ?? 0,
        hasBrowserAmbientContext: browserAmbientContext !== undefined,
        inputId: params.inputId,
        queryId: params.queryId ?? null,
        sessionId: params.sessionId,
        sessionTraceId: sessionTraceId ?? null,
        textLength: params.content.length,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionSend,
          buildSessionSendParams(protocolParams),
          zcodeSessionSendResultSchema,
        );
        logger.info(logTraceId, "ZCode Agent session/send ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        const compatFields = getSessionSendCompatFields(error);
        if (compatFields.length > 0) {
          logger.warn(
            logTraceId,
            "ZCode Agent session/send hit the old/new protocol compat retry",
            {
              compatFields,
              durationMs: Date.now() - startedAt,
              sessionId: params.sessionId,
              workspaceKey: resolveWorkspaceKey(params),
              workspacePath: params.workspacePath,
            },
          );
          const result = await client.request(
            zcodeProtocolMethods.sessionSend,
            buildSessionSendParams(protocolParams, new Set(compatFields)),
            zcodeSessionSendResultSchema,
          );
          return result;
        }
        logger.warn(logTraceId, "ZCode Agent session/send failed", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async compactSession(params: ZCodeAgentCompactParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      const sessionTraceId = getSessionTraceId(params);
      logger.info(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact started", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionCompact,
          buildSessionCompactParams(params),
          zcodeSessionCompactResultSchema,
          {
            // The compact model maintenance state may enter a minute-level window; what is relaxed here is the ACK boundary.
            // The final state is still pushed by the session timeline/snapshot and cannot be regarded as a synchronous compact result.
            timeoutMs: SESSION_COMPACT_REQUEST_TIMEOUT_MS,
          },
        );
        logger.info(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact failed", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async goalSession(params: ZCodeAgentGoalParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      logger.info(params.inputId, "requesting ZCode Protocol session/goal", {
        action: params.action,
        hasObjective: Boolean(params.objective?.trim()),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionGoal,
          {
            sessionId: params.sessionId,
            inputId: params.inputId,
            action: params.action,
            objective: params.objective,
            expectedRevision: params.expectedRevision,
          },
          zcodeSessionGoalResultSchema,
        );
        logger.info(params.inputId, "ZCode Protocol session/goal completed", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          messageCount: result.snapshot.messages.length,
          responseLength: result.response?.length ?? 0,
          sessionId: params.sessionId,
          startedTurn: result.startedTurn,
          status: result.snapshot.session.status,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(params.inputId, "ZCode Protocol session/goal failed", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async closeSession(
      params: ZCodeAgentSessionTarget & {
        expectedPersistence?: "deferred" | "immediate";
      },
    ): Promise<boolean> {
      const client = await getClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionClose,
        {
          sessionId: params.sessionId,
          ...(params.expectedPersistence
            ? { expectedPersistence: params.expectedPersistence }
            : {}),
        },
        zcodeSessionCloseResultSchema,
      );
      // Compatible with Agents that have not yet returned a closed field, but have successfully performed a normal close.
      return result.closed ?? true;
    },

    async setModel(params: ZCodeAgentSetModelParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      logger.info(undefined, "requesting ZCode Protocol session/setModel", {
        expectedRevision: params.expectedRevision ?? null,
        persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed ?? null,
        requestedModel: formatModelSelectionForLog(params.model),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionSetModel,
          {
            sessionId: params.sessionId,
            model: params.model,
            expectedRevision: params.expectedRevision,
            persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed,
          },
          zcodeSessionStateSnapshotSchema,
        );
        logger.info(undefined, "ZCode Protocol session/setModel completed", {
          durationMs: Date.now() - startedAt,
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          snapshotModel: formatModelSelectionForLog(snapshot.settings.model.current),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        logger.warn(undefined, "ZCode Protocol session/setModel failed", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async setThoughtLevel(params: ZCodeAgentSetThoughtLevelParams) {
      const client = await getClient(params);
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionSetThoughtLevel,
        {
          sessionId: params.sessionId,
          thoughtLevel: params.thoughtLevel,
          expectedRevision: params.expectedRevision,
          persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed,
        },
        zcodeSessionStateSnapshotSchema,
      );
      return snapshot;
    },

    async setMode(params: ZCodeAgentSetModeParams) {
      const client = await getClient(params);
      return client.request(
        zcodeProtocolMethods.sessionSetMode,
        {
          sessionId: params.sessionId,
          mode: params.mode,
          expectedRevision: params.expectedRevision,
        },
        zcodeSessionStateSnapshotSchema,
      );
    },

    async respondSessionRuntimePreferences(
      params: ZCodeAgentRespondSessionRuntimePreferencesParams,
    ): Promise<void> {
      const pending = takePendingSessionRuntimePreferences(params.requestId);
      if (!pending) {
        logger.warn(undefined, "no pending request for the runtime preferences response", {
          event: "zcode_agent.runtime_preferences.response_without_pending",
          module: "services.zcode_agent",
          requestId: params.requestId,
        });
        throw new Error(`ZCode session runtime preferences request not found: ${params.requestId}`);
      }
      const responseContext = {
        event: "zcode_agent.runtime_preferences.host_response_received",
        module: "services.zcode_agent",
        requestId: params.requestId,
        scope: pending.request.scope,
        sessionId: pending.request.sessionId,
        workspaceKey: pending.workspaceKey,
      };
      if (params.resolution.status === "failed") {
        logger.warn(undefined, "Host returned a failed runtime preferences result", {
          ...responseContext,
          error: params.resolution.message,
        });
        await pending.client.respondError(pending.protocolRequestId, {
          code: -32603,
          message: params.resolution.message,
        });
        return;
      }
      let preferences: ZCodeSessionRuntimePreferencesResult;
      try {
        preferences = zcodeSessionRuntimePreferencesResultSchema.parse(
          params.resolution.preferences,
        );
      } catch (error) {
        logger.warn(undefined, "Host returned an invalid runtime preferences payload", {
          ...responseContext,
          error: error instanceof Error ? error.message : String(error),
        });
        await pending.client.respondError(pending.protocolRequestId, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // Failure to send indicates that the transport is closed and cannot be misjudged as preference verification failure and sending a second response.
      await pending.client.respond(pending.protocolRequestId, preferences);
      logger.info(
        undefined,
        "runtime preferences response sent back to the Agent",
        responseContext,
      );
    },

    onDynamicSessionRuntimePreferencesRequest() {
      return (listener) => {
        const disposable = sessionRuntimePreferencesRequestEmitter.event(listener);
        for (const pending of pendingSessionRuntimePreferences.values()) {
          listener(pending.request);
        }
        return disposable;
      };
    },

    onDynamicSessionEvent(params: ZCodeAgentSessionSubscribeParams) {
      const emitter = getSessionEmitter(params);
      return (listener) => {
        // The scope of canceled / retryTimer is a single subscriber: the caller cancels its own retry when dispose,
        // Does not affect other subscribers on the shared emitter.
        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let subscriptionReady = false;
        const pendingLiveEvents: ZCodeAgentServiceEvent[] = [];
        const deliveredEventIds = new Set<string>();
        const deliveredEventIdOrder: string[] = [];
        const eventCoalescer =
          params.eventCoalescing?.mode === "background-summary"
            ? createBackgroundSessionEventCoalescer({
                emit: listener,
                flushDelayMs: params.eventCoalescing.intervalMs,
              })
            : null;

        const deliverToListener = (event: ZCodeAgentServiceEvent): void => {
          if (cancelled) {
            return;
          }
          if (event.type === "session.event") {
            const firstDelivery = rememberBoundedEventId(
              deliveredEventIds,
              deliveredEventIdOrder,
              event.event.eventId,
            );
            if (!firstDelivery) {
              return;
            }
          }
          // Performance optimization: background tasks only need low-frequency summaries, and token/progress of invisible tasks cannot be allowed
          // Wake up the renderer at the same frequency; active subscription does not have eventCoalescing and still maintains real-time continuous.
          if (eventCoalescer) {
            eventCoalescer.accept(event);
            return;
          }
          listener(event);
        };

        const releaseBufferedLiveEvents = (): void => {
          if (subscriptionReady) {
            return;
          }
          subscriptionReady = true;
          const bufferedEvents = pendingLiveEvents.splice(0);
          for (const event of bufferedEvents) {
            deliverToListener(event);
          }
        };

        const subscription = emitter.event((event) => {
          if (cancelled) {
            return;
          }
          if (!subscriptionReady) {
            pendingLiveEvents.push(event);
            return;
          }
          deliverToListener(event);
        });

        const establishSubscription = async (attempt: number): Promise<void> => {
          if (cancelled) {
            return;
          }
          try {
            const client = await getReadOnlyClient(params);
            if (cancelled) {
              return;
            }
            const result = await client.request(
              zcodeProtocolMethods.sessionSubscribe,
              {
                sessionId: params.sessionId,
                deliveryKind: params.deliveryKind,
                afterSeq: params.afterSeq,
                includeSnapshot: params.includeSnapshot ?? false,
              },
              zcodeSessionSubscribeResultSchema,
            );
            if (cancelled) {
              return;
            }
            const replayEvents = result.events
              .map((event) => normalizeSessionEventSeq(params, event))
              .sort((left, right) => left.seq - right.seq || left.timestamp - right.timestamp);
            // session/subscribe returns the current subscriber's own replay gap.
            // replay cannot fire to the shared emitter: historical events will be re-broadcast to other live subscribers.
            // Causes the completed tools in the UI timeline to be inserted back after the current model output.
            for (const event of replayEvents) {
              deliverToListener({ type: "session.event", event });
            }
            if (result.snapshot) {
              deliverToListener({
                type: "snapshot",
                snapshot: result.snapshot,
              });
            }
            releaseBufferedLiveEvents();
          } catch (error) {
            if (cancelled) {
              return;
            }
            if (attempt >= SESSION_SUBSCRIBE_MAX_ATTEMPTS - 1) {
              // When there is a complete failure, use warn to make the problem observable instead of silently failing.
              console.warn(
                formatLogPrefix("zcode-agent", process.pid),
                "session subscription failed after the maximum number of attempts, giving up",
                {
                  sessionId: params.sessionId,
                  workspaceKey: resolveWorkspaceKey(params),
                  attempts: attempt + 1,
                  message: error instanceof Error ? error.message : String(error),
                },
              );
              // After the subscription fails, the live event will no longer be suppressed indefinitely; at this time, there is no replay authority to fill the hole, and the continuous stream can only be restored.
              releaseBufferedLiveEvents();
              return;
            }
            const delay = Math.min(
              SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS * 2 ** attempt,
              SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS,
            );
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void establishSubscription(attempt + 1);
            }, delay);
          }
        };

        void establishSubscription(0);

        return {
          dispose() {
            cancelled = true;
            if (retryTimer) {
              clearTimeout(retryTimer);
              retryTimer = undefined;
            }
            pendingLiveEvents.length = 0;
            eventCoalescer?.dispose();
            subscription.dispose();
          },
        };
      };
    },

    // ── v4 conversation channel (vertical cut): host only does transparent transmission and does not leave any business status ──

    async helloConversationV4() {
      return {
        kind: "hello" as const,
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: v4ConnectionId,
        clientMode: "desktop-continuous" as const,
        deliveryProfile: "continuous" as const,
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none" as const,
          workspaceHookReview: true,
          independentPlanState: true,
          // The same capability set as hello in connection scope: directly connected to the host internal consumer of base service
          // It can also receive `workflowRun.*` increments (whether it is received or not is determined by its own clientHello).
          workflowRunDeltas: true,
        },
        auth: {},
      };
    },

    async initializeConversationV4(rawClientHello) {
      clientHelloSchema.parse(rawClientHello);
    },

    async setConnectionFlowStateV4(params: ZCodeAgentConnectionFlowParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.connection.flowControlUntrusted");
      const client = await getReadOnlyClient(params);
      await client.request(
        V4_METHODS.connectionFlow,
        { connectionId: trusted.connectionId, state: params.state },
        v4ConnectionFlowResultSchema,
      );
    },

    async subscribeConversationV4(params: ZCodeAgentConversationSubscribeParams) {
      const subscribeStartedAt = performance.now();
      const existingClient = processManager.getExistingClient(params);
      const cliProcessState: "reused" | "spawned" =
        existingClient && !existingClient.isDisposed ? "reused" : "spawned";
      const cliBootstrapStartedAt = performance.now();
      // The history topic is a read-only source of truth after clicking on the task list. If provider/model is not configured, reuse it
      // The model implements access control. Although the list can appear, it cannot be opened after clicking; subscription only starts the CLI and does not improve writing capabilities.
      const client = await getReadOnlyClient(params);
      const cliBootstrapMs =
        cliProcessState === "spawned"
          ? Math.max(0, Math.round(performance.now() - cliBootstrapStartedAt))
          : undefined;
      // A conversation cold subscription will restore the historical Session directly inside the CLI and publish the first frame immediately.
      // If Account Config has not yet arrived, the first frame will be parsed according to the Registry lacking Account Overlay; here only the
      // Account Config sequence barrier does not increase model execution permissions. ZCode Built-in / Personal is still maintained by Worker.
      const providerRegistryStartedAt = performance.now();
      await ensureAccountProviderConfigSynced({
        client,
        reason: "conversation_subscribe",
        workspace: params,
      });
      const providerRegistrySyncMs = Math.max(
        0,
        Math.round(performance.now() - providerRegistryStartedAt),
      );
      const connection = resolveV4Connection(params);
      const topic = conversationTopic(params.sessionId);
      const taskMetaStartedAt = performance.now();
      const resumeThoughtLevel = await automationTaskIndexRepo
        .getTaskMeta({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId: params.sessionId,
        })
        .then((meta) => meta?.thoughtLevel?.trim() || undefined)
        .catch((error) => {
          // Desktop-continuous V4 cold subscription bypasses task adapter, old session does not
          // Agent durable selection also loses the task-local thought. Index read failures still allow read-only recovery.
          logger.warn(
            undefined,
            "failed to read the V4 cold resume thought hint, subscribing without a hint",
            {
              error: error instanceof Error ? error.message : String(error),
              event: "v4.conversation.subscribe.resume_thought_hint_failed",
              sessionId: params.sessionId,
              workspaceIdentity: params.workspaceIdentity ?? null,
              workspaceKey: resolveWorkspaceKey(params),
              workspacePath: params.workspacePath,
            },
          );
          return undefined;
        });
      const taskMetaReadMs = Math.max(0, Math.round(performance.now() - taskMetaStartedAt));
      const cliRequestStartedAt = performance.now();
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          // Trust bits of the same family as clientMode (10 §3.1): only injected here from the connection's clientHello.
          // Absent is the CLI. Press the old consumer to send the whole key patch, and cut it to the old world first - resubscription, recovery, mobile phone
          // Relay attachment all uses this subscribe, so just write it all here.
          ...(connection.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
          // Root cause of the bug: cold subscription only passed sessionId in the past, and CLI could only infer from historical session.path
          // workspace identity; the path may have been overwritten by path.resolve. The current attachment is the authoritative source.
          workspace: buildWorkspaceRef(params),
          ...(resumeThoughtLevel ? { resumeThoughtLevel } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4ConversationSubscribeResultSchema,
      );
      const cliRequestMs = Math.max(0, Math.round(performance.now() - cliRequestStartedAt));
      const hostPrepareMs = Math.max(0, Math.round(cliRequestStartedAt - subscribeStartedAt));
      const openTiming = {
        ...(result.ack.openTiming ? result.ack.openTiming : {}),
        version: 1 as const,
        hostPrepareMs,
        ...(cliBootstrapMs !== undefined ? { cliBootstrapMs } : {}),
        cliProcessState,
        providerRegistrySyncMs,
        taskMetaReadMs,
        cliRequestMs,
      };
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return {
        ...result,
        ack: {
          ...result.ack,
          openTiming,
        },
      };
    },

    async unsubscribeConversationV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "conversation/");
    },

    async resyncConversationV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "conversation/");
    },

    async sendConversationCommandV4(params: ZCodeAgentConversationCommandParams) {
      const client = await getClient(params);
      const planPayload = params.envelope.payload as {
        planEnabled?: boolean;
        config?: { planEnabled?: boolean };
        firstInput?: { planEnabled?: boolean };
      };
      if (
        planPayload.planEnabled ||
        planPayload.config?.planEnabled ||
        planPayload.firstInput?.planEnabled
      ) {
        await ensureIndependentPlanSupport(client);
      }
      // The RPC facade will clear the top-level clientMode that the caller can forge, and then use the trusted carrier to inject the host
      // True; host internal adapter direct calls are still compatible with explicit clientMode.
      const commandClientMode =
        readTrustedZCodeAgentV4Connection(params)?.clientMode ??
        params.clientMode ??
        "desktop-continuous";
      if (params.envelope.type === "createSession") {
        // The V4 draft is preheated directly through command forwarding; you only need to wait for Account Config before creating a new session.
        // ZCode Built-in/Personal has been assembled by the Worker process Registry itself.
        await ensureAccountProviderConfigSynced({
          client,
          reason: "v4_command_create_session",
          workspace: params,
        });
      }
      let envelope = await buildConversationCommandEnvelope(params);
      // The first version of TTFT only allows local continuous on the trusted desktop, and mobile phone/remote transparent transmission cannot enable local observation.
      if (
        commandClientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      ) {
        const { ttft: _ttft, ...withoutTtft } = envelope;
        envelope = withoutTtft;
      }
      if (envelope.type === "sendText" && envelope.sessionId) {
        const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
        const browserAmbientContext = await collectBrowserAmbientContext(
          options?.browserControlExecutor,
          {
            sessionId: envelope.sessionId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
            clientMode: commandClientMode,
          },
        );
        if (browserAmbientContext) {
          envelope = {
            ...envelope,
            payload: { ...payload, browserAmbientContext },
          };
        }
      }
      const ack: CommandAck = await client.request(V4_METHODS.command, envelope, commandAckSchema);
      // Prompt command in committed TurnStarted or committed WorkspaceHookReviewRequested
      // Any authority will return as soon as it arrives; manual review cannot occupy Host RPC, so continue to use the unified default
      // timeout/watchdog. Relaxing the deadline into the audit realm only masks the serial protocol queue deadlock.
      // Duplicate only proves that commandId has been processed before, but does not prove that its target is still the current session configuration.
      // When the old B command is replayed after the user has switched to C, the derived cache cannot be changed back to B through duplicate.
      return ack;
    },

    async queryConversationCommandsV4(params: ZCodeAgentCommandsQueryParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new Error("fault.command.queryConnectionUntrusted");
      }
      const query = commandsQueryParamsSchema.parse({
        commands: params.commands,
        ...(params.clock ? { clock: true } : {}),
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.commandsQuery, query, commandsQueryResultSchema);
    },

    async attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        fileName: params.fileName,
        mime: params.mime,
        totalBytes: params.totalBytes,
        totalChunks: params.totalChunks,
        checksum: params.checksum,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentBegin, wireParams);
      return client.request(V4_METHODS.attachmentBegin, wireParams, v4AttachmentBeginResultSchema);
    },

    async attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        chunkIndex: params.chunkIndex,
        dataBase64: params.dataBase64,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentChunk, wireParams);
      return client.request(V4_METHODS.attachmentChunk, wireParams, v4AttachmentChunkResultSchema);
    },

    async attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentCommit, wireParams);
      return client.request(
        V4_METHODS.attachmentCommit,
        wireParams,
        v4AttachmentCommitResultSchema,
      );
    },

    async attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentAbort, wireParams);
      await client.request(V4_METHODS.attachmentAbort, wireParams, v4AttachmentAbortResultSchema);
    },

    async attachmentReadV4(params: ZCodeAgentAttachmentReadParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new Error("fault.attachment.readConnectionUntrusted");
      }
      const wireParams = v4AttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        offset: params.offset,
        limit: params.limit,
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.attachmentRead, wireParams, v4AttachmentReadResultSchema);
    },

    async conversationAttachmentReadV4(params: ZCodeAgentConversationAttachmentReadParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new ZCodeAttachmentFaultError(
          ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted,
        );
      }
      const wireParams = v4ConversationAttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
        offset: params.offset,
        limit: params.limit,
      });
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentRead,
        wireParams,
        v4ConversationAttachmentReadResultSchema,
      );
    },

    async conversationAttachmentStatV4(params: ZCodeAgentConversationAttachmentStatParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new ZCodeAttachmentFaultError(
          ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted,
        );
      }
      const wireParams = v4ConversationAttachmentStatParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
      });
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentStat,
        wireParams,
        v4ConversationAttachmentStatResultSchema,
      );
    },

    async attachmentPreviewSourceV4(params: ZCodeAgentAttachmentPreviewSourceParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.previewSourceConnectionUntrusted");
      if (trusted.clientMode !== "desktop-continuous" || params.remoteSessionId) {
        return { kind: "chunked" } as const;
      }
      const wireParams = v4AttachmentPreviewSourceParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        clientMode: trusted.clientMode,
      });
      const client = await getReadOnlyClient(params);
      const source = await client.request(
        V4_METHODS.attachmentPreviewSource,
        wireParams,
        v4AttachmentPreviewSourceResultSchema,
      );
      if (source.kind !== "local_path") return source;
      if (!options?.authorizeLocalMediaPreviewPath) {
        throw new Error("fault.attachment.previewPathAuthorizationUnavailable");
      }
      return {
        ...source,
        path: await options.authorizeLocalMediaPreviewPath(source.path),
      };
    },

    // Row paging: read-only query transparent transmission (timeout retransmission is safe, no subscription status).
    async conversationRowsRangeV4(params: ZCodeAgentConversationRowsRangeParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.conversation.rowsRangeConnectionUntrusted");
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationRowsRange,
        {
          sessionId: params.sessionId,
          clientMode: trusted.clientMode,
          ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
          limit: params.limit,
        },
        v4ConversationRowsRangeResultSchema,
      );
    },

    // The read-only plan directory is transparently passed along the existing workspace attachment and no new runtime is created.
    async conversationPlansV4(params: ZCodeAgentConversationPlansParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationPlans,
        { sessionId: params.sessionId },
        v4ConversationPlansResultSchema,
      );
    },

    // workflow run event log: It is also a read-only query, transparently transmitted along the existing workspace attachment.
    // Paging occurs at the storage layer (JournalStorePort.listEvents with afterSequence/limit), there is no slicing here;
    // Cutting at the RPC layer is equivalent to reading the entire journal into memory every time a page is turned.
    async conversationWorkflowRunEventsV4(params: ZCodeAgentConversationWorkflowRunEventsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunEvents,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunEventsResultSchema,
      );
    },

    // workflow run enumeration: journal-backed post-restart discovery surface (workflowRuns projection does not survive across processes).
    async conversationWorkflowRunsV4(params: ZCodeAgentConversationWorkflowRunsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRuns,
        {
          sessionId: params.sessionId,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunsResultSchema,
      );
    },

    // Three readings of the dwf user interface product.
    // ⚠ Terminology: artifact = the output that a script publishes to the user, not the top-level return value of run.
    // The three items are of the same family as plans/workflowRunEvents: read-only, stateless, timeout retransmission security, and read-only client.
    async conversationWorkflowRunArtifactsV4(
      params: ZCodeAgentConversationWorkflowRunArtifactsParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifacts,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunArtifactsResultSchema,
      );
    },

    // Kanban fetching: The default and clamping of limit are on the CLI gateway side. Here, only transparent transmission is performed - clamping once in each place.
    // Sooner or later the same limit will get different page sizes on the two layers.
    async conversationWorkflowRunArtifactDataV4(
      params: ZCodeAgentConversationWorkflowRunArtifactDataParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactData,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunArtifactDataResultSchema,
      );
    },

    // Bytes: one piece at a time (≤ 512 KiB), splicing belongs to the renderer hook. Authorization is all on the CLI side -
    // The id passed here is only used to search for rows in the journal and will never become a path.
    async conversationWorkflowRunArtifactReadV4(
      params: ZCodeAgentConversationWorkflowRunArtifactReadParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactRead,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          version: params.version,
          offset: params.offset,
          limit: params.limit,
        },
        v4ConversationWorkflowRunArtifactReadResultSchema,
      );
    },

    // Two readings of the dwf workspace transcript. Same race:
    // Read-only, stateless, timeout retransmission security, use read-only client. The default and clamping of maxBytes is on the CLI gateway side.
    async conversationWorkflowRunWorkspaceV4(
      params: ZCodeAgentConversationWorkflowRunWorkspaceParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunWorkspace,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunWorkspaceResultSchema,
      );
    },

    async conversationWorkflowRunNodeResultV4(
      params: ZCodeAgentConversationWorkflowRunNodeResultParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunNodeResult,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          siteId: params.siteId,
          ordinal: params.ordinal,
          ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        },
        v4ConversationWorkflowRunNodeResultResultSchema,
      );
    },

    async backgroundBashOutputV4(params: ZCodeAgentBackgroundBashOutputParams) {
      if (!readTrustedZCodeAgentV4Connection(params))
        throw new Error("fault.bashOutput.connectionUntrusted");
      const wireParams = v4BackgroundBashOutputParamsSchema.parse({
        sessionId: params.sessionId,
        workId: params.workId,
      });
      try {
        const client = await getReadOnlyClient(params, "existing-only");
        return await client.request(
          V4_METHODS.backgroundBashOutput,
          wireParams,
          backgroundBashOutputResultSchema,
        );
      } catch (error) {
        if (isProtocolMethodNotFoundError(error))
          return { kind: "unsupported", workId: params.workId };
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
        ) {
          return { kind: "unavailable", workId: params.workId };
        }
        throw error;
      }
    },

    async conversationFileChangesV4(params: ZCodeAgentConversationFileChangesParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationFileChanges,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileChangesResultSchema,
      );
    },

    async conversationFileRewindPreviewV4(params: ZCodeAgentConversationFileRewindPreviewParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationFileRewindPreview,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileRewindPreviewResultSchema,
      );
    },

    onDynamicConversationFrame(params: ZCodeAgentWorkspaceTarget) {
      return getConversationFrameEmitter(params).event;
    },

    onDynamicLocalTtftFacts(params: ZCodeAgentWorkspaceTarget) {
      return (listener: (facts: LocalTtftFacts) => void) =>
        localTtftFactsEmitter.event((event) => {
          if (event.workspaceKey === resolveWorkspaceKey(params)) listener(event.facts);
        });
    },
    onDynamicConversationTelemetryFact(params: ZCodeAgentWorkspaceTarget) {
      return getConversationTelemetryFactEmitter(params).event;
    },

    onDynamicCuaPermissionObservation() {
      return cuaPermissionObservationEmitter.event;
    },

    // ── sessions-index channel (list active): reuse conversationSubscribe RPC,
    // Dispatched by CLI server by topic prefix──

    async subscribeSessionsIndexV4(params: ZCodeAgentSessionsIndexSubscribeParams) {
      // The sidebar will register all restored workspaces at the same time. If you use a startup client for passive subscription,
      // The number of workspaces will be directly enlarged to the number of CLIs; only dormant will be entered when the existing-only runtime is missing.
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      const topic = sessionsIndexTopic(resolveWorkspaceKey(params));
      // The CLI session of 3.3.6 does not write the remote workspace_id, but the host task index is the same version.
      // Quarantined by full identity. When upgrading, the taskId under the current workspaceKey must be used as proof of ownership;
      // It is forbidden to pass only the workspacePath to the CLI, otherwise SSH/WSL authorities with the same path and different authorities will claim each other's history.
      let legacyTaskIds: string[] = [];
      if (supportsLegacyRemoteTaskAllowlist(params.workspaceIdentity)) {
        try {
          legacyTaskIds = (
            await automationTaskIndexRepo.listTaskMetas({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              provider: "glm",
            })
          )
            .slice(0, MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE)
            .map((task) => task.taskId);
        } catch (error) {
          // The ownership certificate is only used for upgrade and migration; when the task index is unavailable, the existing one must still be complete.
          // Identity's 3.4 session uses strict querying and cannot allow compatible read failures to render the entire list unavailable.
          logger.warn(
            undefined,
            "failed to read remote legacy task ownership proof, subscribing with strict identity",
            {
              error: error instanceof Error ? error.message : String(error),
              event: "sessions_index.legacy_remote_allowlist_read_failed",
              workspaceIdentity: params.workspaceIdentity,
              workspacePath: params.workspacePath,
            },
          );
        }
      }
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(legacyTaskIds.length > 0 ? { legacyTaskIds } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4SessionsIndexSubscribeResultSchema,
      );
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    async unsubscribeSessionsIndexV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "sessions-index/");
    },

    async resyncSessionsIndexV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "sessions-index/");
    },

    onDynamicSessionsIndexFrame(params: ZCodeAgentWorkspaceTarget) {
      return getSessionsIndexFrameEmitter(params).event;
    },

    // ── workspace-config channel (configuration directory activity): reuse conversationSubscribe RPC,
    // Dispatched by CLI server by topic prefix──

    async subscribeWorkspaceConfigV4(params: ZCodeAgentWorkspaceConfigSubscribeParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      const topic = workspaceConfigTopic(resolveWorkspaceKey(params));
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4WorkspaceConfigSubscribeResultSchema,
      );
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    async unsubscribeWorkspaceConfigV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "workspace-config/");
    },

    async resyncWorkspaceConfigV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "workspace-config/");
    },

    onDynamicWorkspaceConfigFrame(params: ZCodeAgentWorkspaceTarget) {
      return getWorkspaceConfigFrameEmitter(params).event;
    },

    onDynamicProcessResourceSample() {
      return processResourceSampleEmitter.event;
    },

    onDynamicToolExecResource() {
      return toolExecResourceEmitter.event;
    },
    onDynamicMcpResourceSamples() {
      return mcpResourceSamplesEmitter.event;
    },

    onDynamicMcpTelemetry() {
      return mcpTelemetryEmitter.event;
    },

    // (CLI reconnection and resubscription): process replacement goes directly to process manager; v4 subscriber (task-index
    // syncer, etc.) and resend the subscribe accordingly - the subscription lives in the CLI process memory and is silently deactivated when it is replaced.
    onAgentRuntimeRestarted(listener) {
      return processManager.onRuntimeRestarted(listener);
    },

    onAgentRuntimeLifecycle(listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void) {
      return processManager.onRuntimeLifecycle(listener);
    },

    async disposeWorkspace(params): Promise<void> {
      const workspaceKey = resolveWorkspaceKey(params);
      // Release not only terminates the current process, but also invalidates the queued provider-ready continuation;
      // Otherwise it will start the Agent of the same workspace again after dispose is completed.
      cancelWaitingWorkspaceStartup(workspaceKey);
      clearV4SubscriptionRoutes(workspaceKey);
      cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      if (active) {
        invalidateWorkspaceClient(workspaceKey, active.client);
      } else {
        interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
      }
      // This entry is used as runtime invalidation by restartWorkspaceProcess, not
      // workspace/service is a real teardown. Destroying the workspace emitter will leave the existing UI/task-index
      // The listener is permanently tied to the dead object; emitters are only released by disposeLocalState/disposeAll.
      await processManager.disposeWorkspace(params);
    },

    disposeAll(): void {
      processManager.disposeAll();
      pluginProcessManager.disposeAll();
      mcpStatusProcessManager.disposeAll();
      // Automation-specific AutomationRepo / TaskIndexRepo each supports tasks-index.sqlite
      // The connection handle must be closed after disposing, otherwise the handle will be hanging on Windows (temporary directory cleanup will hit EBUSY)
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },

    async disposeAllAndWait(): Promise<void> {
      await Promise.all([
        processManager.disposeAllAndWait(),
        pluginProcessManager.disposeAllAndWait(),
        mcpStatusProcessManager.disposeAllAndWait(),
      ]);
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },
  };
}
