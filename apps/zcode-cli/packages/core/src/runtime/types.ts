import type { RuntimeInputPresentation } from "@zcode/contracts";
/* eslint-disable max-lines -- The Runtime types carry the outward structure of core/runtime in one place; splitting them needs a separate migration. */
import { PermissionService, ToolScheduler } from "./deps.js";
import type {
  JsonSchema,
  AgentExecutionTelemetryPort,
  AgentTelemetryCausation,
  BackgroundResultOriginMeta,
  ContextUsageBreakdownItem,
  CoordinatorResponsePort,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  ModelRequestAuth,
  ModelRequestDependencies,
  ModelSelection,
  PluginReferenceCatalog,
  ResolvedUserInstructions,
  StableForkGoalBoundaryMetadata,
  StableForkTargetMetadata,
  WorkspaceHookBundleSnapshot,
  WorkspaceId,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CollaborationMode,
  EmbeddedSearchBackend,
  Logger,
  AttachmentStorageMetadata,
  MessageId,
  MessageVisibility,
  FilePartSource,
  ModelRequestAdmission,
  Model,
  ModelNetworkStatusEvent,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  ModelStreamRecoveryStatus,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  ModelUsageSummary,
  ModelInputMessage,
  MessageWithParts,
  PendingTurnInput,
  TurnInputIntentMetadata,
  TurnSteerResult,
  PartId,
  PermissionBrokerPort,
  PermissionUpdate,
  QueryId,
  RewindScope,
  RewindStrategy,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionTaskType,
  SessionMailboxPort,
  SessionProjection,
  SessionStorePort,
  ContextSourcePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  ModelCatalogPort,
  ExecutionPort,
  BrowserControlPort,
  ExecutionShellSelection,
  AutomationPort,
  OffPeakPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  HooksRuntimeConfig,
  SkillPort,
  McpPort,
  McpServerConfig,
  SubagentPort,
  ToolArtifactStorePort,
  ToolCallId,
  WorkflowPort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
  TraceContext,
  TraceId,
  TurnId,
  CheckpointCreatedPayload,
  RewindTargetEvaluation,
  SessionHistoryHydrationResult,
  SyntheticUserMessageSource,
  HookRunner,
  ToolExecutionResult,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  EnvInfo,
  ProjectContext,
  UserInstructionsOptions,
  AutoCompactPolicyConfig,
  ModelAnomalyGuardConfig,
  OutputStylePromptConfig,
} from "./deps.js";
import type { AgentProfile } from "../subagent/profile.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { BashTimeoutPolicy } from "../tool/bash-timeout-policy.js";
import type { PresentationSurface } from "../context/types.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

// -----------------------------------------------
// Agent Runtime
// -----------------------------------------------

export interface AgentRuntimeConfig {
  /** shared-host CUA request routing metadata; desktop is the safe default. */
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  remoteSessionId?: string;
  bashTimeoutPolicy?: BashTimeoutPolicy;
  presentationSurface?: PresentationSurface;
  mode?: CollaborationMode;
  planEnabled?: boolean;
  modelStreaming?: "off" | "on";
  streamingToolExecution?: "off" | "readOnly";
  /** Fixed at session creation; by default the shared model-context budget default policy is used. */
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  maxTurns?: number;
  permissionTimeoutMs?: number;
  compact?: AutoCompactPolicyConfig;
  targetCompletionVerification?: { enabled?: boolean };
  midConversationSystem?: {
    mode?: "auto" | "force";
  };
  subagents?: {
    enabled?: boolean;
    // The foreground subagent does not have a maximum silent time for any child events; the default alignment model stream idle timeout.
    inactivityTimeoutMs?: number;
    autoBackgroundMs?: number;
    backgroundBashMaxMs?: number;
    maxTurns?: number;
    outputRootDir?: string;
    profiles?: readonly AgentProfile[];
    builtInModelSelectionOverrides?: Partial<Record<"general-purpose" | "Explore", ModelSelection>>;
  };
  toolAllowlist?: readonly string[];
  toolDisallowlist?: readonly string[];
  /**
   * Defaults to main. Explore child runtimes use the explore toolset to opt into
   * the read-only exploration tool allowlist; whether direct Glob/Grep is included is decided by the embedded search branch.
   * In main mode the allowlist is only a direct intersection filter, and explore child runtimes additionally fill in the default read-only allowlist.
   */
  toolset?: "main" | "explore";
  toolConcurrency?: { maxConcurrency?: number };
  runtimeFeatures?: {
    /**
     * Whether the node_repl tool (js) is registered.
     * Derived by bootstrap from whether the official ZCode plugin is on or off, not self-declared by an ordinary plugin manifest.
     */
    nodeRepl?: boolean;
    /**
     * Whether node_repl may inject agent.browsers. The host must also provide browserControlPort.
     */
    browserUse?: boolean;
    /** Whether the CUA broker credential is injected into the shared node_repl; it does not mean registering a standalone CUA MCP. */
    computerUse?: boolean;
    /**
     * The docs asset directory of the official browser-use plugin. Derived by bootstrap from plugin metadata.rootPath,
     * it is not part of the plugin manifest schema.
     */
    browserDocumentationRoot?: string;
  };
  modelAnomalyGuard?: Partial<ModelAnomalyGuardConfig>;
  mcp?: {
    enabled?: boolean;
    servers?: Record<string, McpServerConfig>;
    /**
     * Process-local provenance supplied by bootstrap after resolving bundled
     * official plugins. Never derive this list from serialized MCP config.
     */
    trustedOfficialCuaServerNames?: readonly string[];
  };
  /**
   * The Plugin identity catalog frozen by the Session.
   * Built by bootstrap when the App is created from the plugin loader result; read-only to the runtime,
   * used to resolve `plugin://` references at turn start and to intersect them with the live inventory.
   */
  pluginReferenceCatalog?: PluginReferenceCatalog;
  hooks?: HooksRuntimeConfig;
  bashShellSelection?: ExecutionShellSelection | undefined;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  /** Fixed when the root Session runtime is created; false only turns off the bfs/ugrep prelude of Bash. */
  nativeSearchEnhancementsEnabled?: boolean;
  memory?: MemoryRuntimeConfig;
  /** History restore allows an unbound selection; only a complete selection can create this turn's executing Model. */
  modelSelection?: ModelSelection;
  titleGeneration?: {
    enabled?: boolean;
    modelSelection?: ModelSelection;
    timeoutMs?: number;
  };
  parentSessionId?: SessionId;
  taskType?: SessionTaskType;
  /**
   * Dynamic workflow switch: after the Host decides, it is delivered via
   * ZCode Protocol and the runtime only consumes it. **Absent means enabled**, which preserves the TUI default;
   * headless passes true/false explicitly through --enable-workflow (default false), and workflow_child inherits the parent config.
   * false turns off the ten workflow tools and does not change the registration policy of any other tool.
   */
  dynamicWorkflowEnabled?: boolean;

  // Context Builder config
  systemPrompt?: string;
  /**
   * The identity input of a dynamic workflow subagent: when present it makes the
   * context builder take the "base + workflow subagent contract + persona overlay" path instead of replacing the persona
   * wholesale as a `systemPrompt`. Mutually exclusive with `systemPrompt` (the builder throws).
   */
  workflowActor?: { name?: string; persona?: string };
  /**
   * Selects the subagent-specific context builder for child runtimes. The
   * builder still receives env/date/model data through the normal runtime
   * context snapshot, but assembles provider-visible system sections with the
   * subagent prompt shape instead of the main ContextBuilder stack.
   */
  subagentContext?: {
    agentPrompt: string;
    userInstructions?: ResolvedUserInstructions;
  };
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  agentName?: string; // Default: "zcode-agent"
  workingDirectory?: string; // Required for context builder
  /**
   * The representation of the actual workspace path passed in by the caller, used for session persistence and local identity restore.
   * File and command execution still use only the normalized workingDirectory.
   */
  workspacePath?: string;
  /** Used only for persistence isolation; file and command execution still use the workingDirectory. */
  workspaceIdentity?: WorkspaceId;
  envInfo?: EnvInfo; // Optional, will be auto-detected if not provided
  currentDate?: string; // YYYY-MM-DD, resolved by adapter when omitted
  userInstructions?: UserInstructionsOptions; // AGENTS.md
  projectContext?: ProjectContext; // auto-detected if not provided
  skillMetadataBudget?: number;
}

export interface ResumeSessionOptions {
  /** Aborts the cold-resume admission wait; it does not fake a Workspace Hook review decision. */
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  /** The call-level materialized result supplied by the cold-resume caller; it does not enter the lifecycle cache, and after a repair it is read again by return value. */
  persistedMessages?: MessageWithParts[];
  /**
   * The mode resolved for this invocation. Both an explicit --mode and the headless default yolo are call-level overrides
   * and must outrank the historical session mode; an interactive resume that specifies nothing stays undefined so the historical mode takes effect.
   */
  modeOverride?: CollaborationMode;
}

export interface MainTurnCacheHitAggregate {
  requestCount: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

export type BackgroundTaskNotificationSealReason = "subagent_terminal" | "subagent_cancelled";

export interface SealBackgroundTaskNotificationsInput {
  reason: BackgroundTaskNotificationSealReason;
  traceContext?: TraceContext;
}

export interface PendingModelChangeTimeline {
  createdAt: number;
  fromModel?: ModelSelection;
  fromModelLabel?: string;
  requestId: string;
  toModel: ModelSelection;
  toModelLabel: string;
}

export interface EnqueueSubagentMessageInput {
  responseId: string;
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  childToolCallId: string;
  parentToolCallId?: string;
  summary: string;
  message: string;
  traceContext: TraceContext;
}

export interface MemoryRuntimeConfig {
  cliStorageRoot?: string;
  enabled?: boolean;
  /** Whether to schedule the automatic Extraction after a successful Main turn; absent is treated as true. */
  extractionEnabled?: boolean;
  storageRoot?: string;
  use?: boolean;
  workspaceIdentity?: string;
}

export interface AgentRuntimeDeps {
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryCausation?: AgentTelemetryCausation;
  agentTelemetryCausationMode?: "child" | "linked_root";
  appVersion?: string;
  eventStore: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  modelFactory: RuntimeModelFactory;
  /** Optional host capability: resolve the explicit intent of a future execution; not used to modify an already frozen Model. */
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  modelIoDir?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  permissionService?: PermissionService;
  permissionBroker?: PermissionBrokerPort;
  toolScheduler?: ToolScheduler;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
  executionPort?: ExecutionPort;
  /** The browser-use control port; passed through to ToolExecutionContext.browserControlPort for node_repl to use. */
  browserControlPort?: BrowserControlPort;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  /** The port through which a workflow actor submits its terminal result; its presence is the registration gate for the submit_result tool. */
  workflowSubmitPort?: WorkflowSubmitPort;
  /**
   * The typed `submit_result` of a mono subagent: when present, the registered tool declaration is `{ result: <this schema> }` and not
   * arbitrary JSON. Only the provider-visible declaration and the strict qualification change;
   * the handler, the permissions and the termination semantics are the same as when workflowSubmitPort is present on its own.
   * It is ignored when the port is absent (the port is the registration gate).
   */
  workflowSubmitSchema?: JsonSchema;
  /**
   * The port through which a workflow actor escalates a blocking question; its presence is the registration gate for the escalate tool. Injected the same way as workflowSubmitPort and gated by the same gate.
   */
  workflowEscalatePort?: WorkflowEscalatePort;
  /**
   * The process-level admission gate for model requests: when present,
   * every model request attempt first obtains a ticket through it; it follows the call context down to the adapter. The dwf actor runtime takes the driver's per-actor
   * wrapper (bound by the gate), the main runtime takes the governor's observer (signal feed only); absent means no gate at all.
   */
  modelRequestAdmission?: ModelRequestAdmission;
  workflowPort?: WorkflowPort;
  /** The submit/observe/cancel ports of a workflow run; presence means CreateWorkflow really starts, absence answers with a placeholder diagnostic. */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** The model catalog port; absent makes ListModels report the capability as missing and makes the subagent_model of CreateWorkflow rejected. */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  contextSourcePort?: ContextSourcePort;
  eventSink?: SessionEventSink;
  logger?: Logger;
  traceContext?: TraceContext;
  contextBuilder?: ContextBuilder; // Optional, will be created from config
  now?: () => Date;
  isRemoteWorkspace?: () => boolean;
  memoryRoot?: string;
}

export interface RuntimeModelFactoryInput {
  selection: ModelSelection;
  /** Bound only to the Model created this time; it does not enter the public ModelRequest or the Session persistence. */
  requestDependencies?: ModelRequestDependencies;
}

export type RuntimeModelFactory = (input: RuntimeModelFactoryInput) => Model;

/**
 * The provider runtime headers port for protocol clients.
 *
 * The sessionId passed in must be routable to a session the client holds. A child runtime's ledger identity cannot
 * be used for a client request directly, otherwise the client cannot find the session and answer, and the first model request waits forever.
 * A child runtime derives ports through deriveChildClientPorts, routing the request to the client session bound to the parent port.
 */
export interface ProviderRuntimeHeadersPort {
  shouldRefreshBeforeModelRequest?(input: { providerId: string; modelId: string }): boolean;
  refreshBeforeModelRequest(input: {
    accountAccess?: ZCodeProviderAccountAccess;
    abortSignal?: AbortSignal;
    modelId: string;
    providerId: string;
    reason: "model-request";
    sessionId: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  }): Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
}

export interface TurnResult {
  response: string;
  turnId: TurnId;
  traceId: TraceId;
  usage?: ModelUsageSummary;
  events: SessionEvent[];
  projection: SessionProjection;
}

/**
 * The execution-time constraint of a standard Submission Selection. It carries no static Provider/Model facts,
 * and it never becomes a second source for the Session Selection.
 */
export interface ModelExecutionContext {
  /** Skips the automatic Project Memory Extraction for the current Turn only; it does not modify the Session Memory configuration. */
  memoryExtraction?: "skip";
  selectionScope: "execution";
  requestDependencies?: ModelRequestDependencies;
  subagents?: {
    foregroundModel: "submission";
    background: "deny";
  };
}

export interface ExecuteTurnOptionsBase {
  abortSignal?: AbortSignal;
  browserAmbientContext?: {
    tabCount: number;
    currentUrl?: string;
  };
  continueActiveTargetAfterTurn?: boolean;
  displayInput?: string;
  /**
   * From this index on, `input` is engine text appended by the caller (a dwf ask footnote / a nudge). It only enters TurnStarted and the
   * message metadata so the GUI can collapse it; the model history and the persisted text part stay full text (the transcript copy of amend-resume needs the full text).
   */
  epilogueStart?: number;
  inputId?: string;
  intent?: TurnInputIntentMetadata;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputPresentation?: RuntimeInputPresentation;
  inputVisibility?: MessageVisibility;
  originMeta?: BackgroundResultOriginMeta;
  /** Only freezes the whole-batch causal source of a background notification batch; not used for display. */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  /** Computed by the runtime command drain; means this turn has consumed a subagent background result. */
  backgroundSubagentResultConsumed?: boolean;
  /** Computed by the runtime command drain; means this turn has consumed a dynamic-workflow run notification (completion / question). */
  workflowResultConsumed?: boolean;
  recordedInputMessageId?: MessageId;
  skipInputRecord?: boolean;
  skipUserPromptSubmitHooks?: boolean;
  targetId?: string;
  /** Tools hidden from the provider for the current turn only; it does not modify the persistent tool surface of the session runtime. */
  toolDisallowlist?: readonly string[];
  traceContext?: TraceContext;
  /** The Selection of the current Submission applies to this execution only, and per-request dependencies can be bound to it. */
  modelExecution?: ModelExecutionContext;
}

export type ExecuteTurnOptions = ExecuteTurnOptionsBase &
  import("@zcode/contracts").TurnBackgroundAttribution;

/**
 * The call arguments of the Core prompt admission. Bootstrap only provides the input facts and the expected delivery semantics;
 * the start/queue choice is made atomically by the AgentRuntime that holds the state of this session.
 */
export type PromptAdmissionOptions = ExecuteTurnOptions & {
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
  delivery?: "auto" | "start_turn" | "steer_active_turn";
  expectedTurnId?: TurnId;
  /** Product queue semantics while busy; Core falls back to queue when there are attachments or steering is impossible. */
  queueDelivery?: "guide" | "queue";
  /** Internal calls such as queue promotion require admission to be idle, otherwise they are rejected outright. */
  requireIdle?: boolean;
};

export type PromptAdmissionReceipt =
  | {
      kind: "started";
      completion: Promise<TurnResult>;
      turnId: TurnId;
    }
  | TurnSteerResult;

export type ActiveTargetLoopTrigger = "manual" | "user-prompt" | "task-notification";

export interface ContinueActiveTargetLoopOptions {
  abortSignal?: AbortSignal;
  inputId?: string;
  intent?: TurnInputIntentMetadata;
  traceContext?: TraceContext;
  trigger: ActiveTargetLoopTrigger;
  verifyBeforeFirstContinue?: boolean;
}

export interface ActiveForegroundExecutionState {
  controller: AbortController;
  disposeParentAbort: () => void;
  foregroundExecutionId: string;
  preserveQueueAutoDrainOnCancel: boolean;
}

export interface StopActiveForegroundExecutionOptions {
  expectedForegroundExecutionId?: string;
  preserveQueueAutoDrainOnCancel?: boolean;
  reason?: string;
}

export type StopActiveForegroundExecutionResult =
  | { kind: "stopped"; foregroundExecutionId: string }
  | { kind: "idle" }
  | { kind: "mismatch"; activeForegroundExecutionId: string };

export type ForegroundPromotionLeaseMode = "after-current" | "idle-only";

export interface ForegroundPromotionLeaseState {
  leaseId: string;
  promotedInputId: string;
}

export type AcquireForegroundPromotionLeaseResult =
  | { kind: "acquired"; leaseId: string }
  | { kind: "busy" }
  | { kind: "conflict"; leaseId: string };

export interface ActiveTurnInfo {
  kind: ActiveTurnKind;
  /** The inputId of this turn (the same value as TurnStarted.inputId); the launch anchor of a workflow run is taken from here. */
  inputId?: string;
  queueLength: number;
  steerable: boolean;
  turnId: TurnId;
}

export interface WorkspaceRewindRestoredFile {
  action: "delete" | "restore";
  bytesWritten?: number;
  path: string;
}

export interface WorkspaceRewindResult {
  checkpoint?: CheckpointCreatedPayload;
  evaluation?: RewindTargetEvaluation;
  restoredFiles: WorkspaceRewindRestoredFile[];
  response: string;
  rewindId: string;
  strategy: RewindStrategy;
}

export type WorkspaceFileRewindAction = "restore" | "delete";

export type WorkspaceFileRewindUnsafeReason =
  | "checkpoint_missing"
  | "checkpoint_unreadable"
  | "external_modified"
  | "file_read_failed"
  | "unsupported_checkpoint";

export interface WorkspaceFileRewindSafeFile {
  action: WorkspaceFileRewindAction;
  operationCount: number;
  path: string;
  toolNames: string[];
}

export interface WorkspaceFileRewindUnsafeFile {
  currentHash?: string;
  expectedHash?: string;
  message?: string;
  operationCount: number;
  path: string;
  reason: WorkspaceFileRewindUnsafeReason;
  toolNames: string[];
}

export interface WorkspaceFileRewindIgnoredFile {
  operationCount: number;
  path: string;
  reason: "bash_ignored";
  toolNames: string[];
}

export interface WorkspaceFileRewindPreview {
  canApply: boolean;
  ignoredFiles: WorkspaceFileRewindIgnoredFile[];
  safeFiles: WorkspaceFileRewindSafeFile[];
  unsafeFiles: WorkspaceFileRewindUnsafeFile[];
}

export interface WorkspaceFileRewindApplyResult {
  applied: boolean;
  preview: WorkspaceFileRewindPreview;
  response: string;
}

export interface ConversationRewindResult {
  branchGeneration?: number;
  evaluation?: RewindTargetEvaluation;
  keptMessageCount: number;
  response: string;
  rewindId: string;
  strategy: RewindStrategy;
  targetMessageId: MessageId;
}

export interface WorkspaceForkResult {
  checkpoint?: CheckpointCreatedPayload;
  copiedMessageCount: number;
  forkedSessionId: SessionId;
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFiles: WorkspaceRewindRestoredFile[];
  response: string;
}

/** The target product turn raw transcript segment already fixed by the V4 resolver. */
export type StableConversationForkTarget = StableForkTargetMetadata;

/** Either an explicit none or a complete fork-point goal/verifier snapshot; undefined is not new data. */
export type StableConversationForkGoalBoundary = StableForkGoalBoundaryMetadata;

export type StableConversationForkChildMetadata = ForkChildSessionMetadata;

export interface StableConversationForkOptions {
  forkedSessionId?: SessionId;
  modelSelection?: ModelSelection;
  goalBoundary: StableConversationForkGoalBoundary;
  sourceCommandId: string;
  revisionAtDecision?: number;
  target: StableConversationForkTarget;
  traceContext?: TraceContext;
}

/** Creates a hidden companion child from a stable on-disk boundary of the parent session; it does not copy goal/queue/blocking run state. */
export interface SelectionSideChatCreateOptions {
  modelSelection?: ModelSelection;
  sourceCommandId: string;
  revisionAtDecision?: number;
  traceContext?: TraceContext;
}

export interface ConversationBeforeInputForkOptions {
  modelSelection?: ModelSelection;
  forkedSessionId?: SessionId;
  goalBoundary: StableConversationForkGoalBoundary;
  sourceCommandId: string;
  targetMessageId: MessageId;
  targetProductTurnId: string;
  targetTranscriptTurnId: string;
  initialInput: ForkCommitBundle["initialInput"];
  commandFact: ForkCommitBundle["commandFact"];
  traceContext?: TraceContext;
}

export interface WorkspaceCheckpointSummary {
  checkpointId: string;
  compactBoundaryId?: string;
  coveredByCompact?: boolean;
  createdAt: Date;
  diffRef?: string;
  fileCount?: number;
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
  preview?: string;
  scope: RewindScope;
  snapshotRef: string;
}

export interface RuntimeTurnFileChangeEntry {
  afterContent?: string;
  beforeContent: string | null;
  fallbackAdditions: number;
  fallbackDeletions: number;
  path: string;
  toolNames: Set<string>;
  writeCount: number;
}

export type RuntimeTurnFileChangeMap = Map<string, RuntimeTurnFileChangeEntry>;

export interface CompactTimelineContext {
  operationId: string;
  messageId: MessageId;
  partId: PartId;
  trigger: CompactTrigger;
  phase: CompactPhase;
  compactReason: CompactReason;
  sourceCommandId?: string;
  startedAt: number;
  preCompactTokenCount?: number;
}

export interface ResumeSessionResult extends SessionHistoryHydrationResult {
  directory: string;
  /** The current resume candidate: allowing only a valid model identity so the UI can fill in the tier does not mean the Runtime is bound. */
  modelSelection?: ModelSelection;
  /** Whether the resume wrote back a compact repair fact that the current materialization cannot fully reflect. */
  persistedMessagesReloadRequired: boolean;
  readFileStateRestoredCount: number;
  readFileStateSkippedRangeReadCount: number;
  readFileStateSkippedUnreadableEditCount: number;
  traceId: TraceId;
}

export interface PermissionDecisionResult {
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  permissionUpdates?: PermissionUpdate[];
}

export interface ExecuteToolsOptions {
  automationTurn?: boolean;
  offPeakTurn?: boolean;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  /** Passed through only to the Agent child that this turn waits for synchronously. */
  subagentModelOverride?: import("@zcode/contracts").SubagentRunOptions["modelOverride"];
  model?: Model;
  onBatchStart?: (toolCallIds: string[]) => Promise<void>;
}

export interface ExecuteToolsResult {
  results: ToolExecutionResult[];
  events: SessionEvent[];
}

export type ActiveTurnKind = "regular" | "compact" | "rewind";

export const INLINE_TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;

export const INLINE_MEDIA_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export const MAX_IMAGE_ATTACHMENT_DIMENSION = 2000;

export interface ResolvedTurnAttachment {
  contentBlock: ModelMessageContentBlock;
  filename?: string;
  metadata: AttachmentStorageMetadata;
  mime: string;
  source?: FilePartSource;
  url: string;
}

export interface PreparedImageData {
  dataUrl: string;
  mediaType: string;
  metadata?: AttachmentStorageMetadata["image"];
}

export interface ActiveTurnSteeringState {
  kind: ActiveTurnKind;
  // When active turn is Stopped, goal reminder cannot be inserted into tool results that have not yet been closed.
  // deferral is only opened within the regular model/tool ​​loop, and is closed before materializing the pending when exiting the loop.
  goalStateChangeReminderDeferralOpen: boolean;
  pendingGoalStateChangeReminder?: {
    text: string;
  };
  pendingInputs: PendingTurnInput[];
  steerable: boolean;
  traceContext: TraceContext;
  turnId: TurnId;
  /** The inputId of this turn (same origin as TurnStarted.inputId); a regular turn records it in beginActiveTurn. */
  inputId?: string;
}

export interface ActiveTurnStartReservation {
  kind: ActiveTurnKind;
  traceContext: TraceContext;
  turnId: TurnId;
}

export interface DrainedPendingInputDiagnostics {
  injectedMessageIds: MessageId[];
  /** The atomic Submission configuration carried by the inline Guide itself; consumed at the next model-step boundary. */
  intent?: TurnInputIntentMetadata;
  latestMessageId: MessageId | undefined;
  pendingInputIds: string[];
  queryIds?: QueryId[];
  /** The immutable entries this drain committed to the canonical history, for the turn-local query to advance in step. */
  runtimeEntries: readonly RuntimeMessageEntry[];
  /** The tool hide-list carried by the input injected in this drain; the next provider request must keep honoring it. */
  toolDisallowlist?: readonly string[];
}

export interface ProviderContextUsageSnapshot {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokens?: number;
  inputTokens: number;
  messageCount: number;
  model: { providerId: Model["providerId"]; modelId: Model["modelId"] };
  outputTokens?: number;
  recordedAt: number;
  traceId: TraceId;
  turnId?: TurnId;
}

export interface RunModelTextRequestOptions {
  abortSignal?: AbortSignal;
  assistantMessageId: MessageId;
  events: SessionEvent[];
  maxOutputTokens?: number;
  latestRealUserMessageIndex?: number;
  messages: ModelInputMessage[];
  /** The canonical source corresponding to messages by index; used only for local usage statistics. */
  sourceEntries?: readonly (RuntimeMessageEntry | undefined)[];
  model: Model;
  onStreamSnapshot?: (snapshot: RuntimeModelStreamSnapshot) => void;
  onStreamReasoningDelta?: (text: string) => void;
  onStreamTextDelta?: (text: string) => void;
  onStreamToolCall?: (toolCall: ModelToolCall) => void;
  onModelNetworkStatus?: (event: ModelNetworkStatusEvent) => void;
  streamRecovery?: ModelStreamRecoveryStatus;
  tools: ModelToolContract[];
  traceContext: TraceContext;
}

export interface RuntimeModelStreamSnapshot {
  reasoning: ModelReasoningContentBlock[];
  text: string;
}

export interface StreamedToolExecutionResult {
  input: Record<string, unknown>;
  ledgerRecorded?: boolean;
  partID: PartId;
  result: ToolExecutionResult;
  toolCallId: ToolCallId;
}

export interface RuntimeModelTextResult {
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  finishReason: string;
  providerMetadata?: Record<string, unknown>;
  reasoning?: ModelReasoningContentBlock[];
  text: string;
  toolCalls?: ModelToolCall[];
  usage: ModelUsage;
}

export type ParsedRewindCommand =
  | {
      action: "apply";
      targetCheckpointId?: string;
    }
  | {
      action: "fork";
      targetCheckpointId?: string;
    }
  | {
      action: "cascade-message";
      scope: RewindScope;
      targetMessageId: MessageId;
    }
  | {
      action: "message";
      scope: RewindScope;
      targetMessageId: MessageId;
    }
  | {
      action: "status";
    };

export type ContextUsageTokenMethod = "estimated" | "provider_count" | "proportional_estimate";

export type ContextUsageConfidence = "high" | "medium" | "low";

export interface ContextUsageMetric {
  chars: number;
  confidence: ContextUsageConfidence;
  tokenMethod: ContextUsageTokenMethod;
  tokenizer: string;
  tokens: number;
}

export interface ContextUsageCategory extends ContextUsageMetric {
  name: string;
  percentTokens: number;
  source:
    | "system_prompt"
    | "meta_user_context"
    | "skills"
    | "tool_prompt"
    | "system_tool_schemas"
    | "mcp_tool_schemas"
    | "messages";
}

export interface ContextUsageToolDetail extends ContextUsageMetric {
  name: string;
  readOnly?: boolean;
  serverName?: string;
  sideEffectScope?: string;
  source: "system_tool" | "mcp_tool";
}

export interface ContextUsageSkillDetail extends ContextUsageMetric {
  name: string;
  path: string;
  scope: string;
  source: string;
}

export interface ContextUsageMessageRoleBreakdown extends ContextUsageMetric {
  count: number;
  role: string;
}
