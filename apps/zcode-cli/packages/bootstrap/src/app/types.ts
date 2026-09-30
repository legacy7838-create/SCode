import type { ZCodeToolExecResource, BackgroundBashOutputResult } from "@zcode/shared";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  ExecuteTurnOptions,
  ExpertWorkflowCommandResult,
  ProviderRuntimeHeadersPort,
  PresentationSurface,
  ResumeSessionResult,
  StartSavedWorkflowRunResult,
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
  TurnAttachment,
  ModelExecutionContext,
  TurnResult,
  WorkflowAgentRunner,
  WorkspaceCheckpointSummary,
  WorkspaceForkResult,
  WorkspaceGenerateTextInput,
  WorkspaceHookReviewTarget,
  WorkspaceHookPolicyProvider,
} from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeModelOption } from "@zcode/shared";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
export type { ZCodeModelOption } from "@zcode/shared";
import type { ModelProviderSourceTitle } from "../model-config.js";
import type { ZCodeInstalledPluginData } from "../plugins.js";
import type {
  AutomationPort,
  OffPeakPort,
  BackgroundTaskCancelResult,
  CollaborationMode,
  ContextSourcePort,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunSessionSummary,
  ExecutionPort,
  BrowserControlPort,
  FileSystemPort,
  GoalStatus,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  InputDelivery,
  InputHistoryEntry,
  InputHistoryKind,
  InputHistoryStorePort,
  LoggerFactory,
  McpPort,
  McpServerStatus,
  ModelSelection,
  PermissionBrokerPort,
  PluginLoadOutcome,
  PluginMetadata,
  PluginReferenceCatalog,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionGoal,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  SkillLoadOutcome,
  SkillPort,
  ToolArtifactReadResult,
  ToolArtifactStorePort,
  TodoItem,
  QueryId,
  TraceContext,
  TurnId,
  TurnSteerResult,
  TurnInputIntentMetadata,
  MessageWithParts,
  ModelUsage,
  ModelToolCall,
  SupportedLocale,
  UiLocale,
  UiThemePreference,
  WorkflowEvent,
  WorkflowRunListItem,
  ExecutionShellSelection,
} from "@zcode/contracts";
import type { NodeReplBrowserBroker } from "./node-repl-browser-broker.js";
import type { SessionTranscriptMessage } from "../session-transcript.js";
import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-controller.js";
import type { AgentTelemetryRuntimeOwner, WorkspaceHookPolicy } from "@zcode/contracts";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

export interface WorkspaceHookReviewHostContext {
  taskId: string;
  runId: string;
  workspaceLabel: string;
  remoteSessionId?: string;
}

export type RespondWorkspaceHookReviewInput = WorkspaceHookReviewTarget & {
  decision: WorkspaceHookReviewDecision;
};

export type ToggleWorkspaceHookReviewItemInput = WorkspaceHookReviewTarget & {
  reviewItemId: string;
  enabled: boolean;
};

export type RevokeWorkspaceHookTrustInput =
  | (WorkspaceHookReviewTarget & { reviewItemIds: string[] })
  | WorkspaceHookTrustRevokeTarget;

/** A new Session may use the Environment default selection; a resumed Session is allowed to stay unbound, with no default model filled in. */
export type ZCodeAppRuntimeConfigInput = AgentRuntimeConfig;

export interface ZCodeAppOptions {
  sessionId?: SessionId;
  resume?: boolean;
  version?: string;
  traceContext?: TraceContext;
  runtimeConfig?: ZCodeAppRuntimeConfigInput;
  /**
   * The agent process in stdio protocol mode is spawned by the Electron host, and the model service needs to see an electron origin.
   * A regular CLI does not pass it and keeps using the cli default.
   */
  sourceTitle?: ModelProviderSourceTitle;
  eventStore?: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  inputHistoryStore?: InputHistoryStorePort;
  modelAdapter?: AiSdkModelAdapter;
  /** A Registry owned by the Worker process; the App only borrows it and is not responsible for releasing it. */
  providerRegistry: ProviderRegistryModelSource;
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  /** The Environment default selection used by a new Session; it only participates in initialization when there is no explicit runtime modelSelection. */
  configuredDefaultModelSelection?: ModelSelection;
  modelIoFullRetentionEnabled?: boolean;
  /** An in-process embedding host can inject a full borrowed process-level Owner; Endpoint configuration must not override it. */
  telemetryOwner?: AgentTelemetryRuntimeOwner;
  /**
   * Provider runtime headers port: the main runtime reports its own session on every call; a child runtime always asks the parent
   * runtime for a derived instance.
   */
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  loggerFactory?: LoggerFactory;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  executionPort?: ExecutionPort;
  /** Resource telemetry bypass; injected by the protocol host and shared by the execution adapters of the main task and of workflows. */
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  /** browser-use control port; once injected, agent.browsers.* in node_repl becomes available. When absent, it is not available. */
  browserControlPort?: BrowserControlPort;
  /** A process-level node_repl Browser broker that the protocol host may inject; when absent, the app creates and owns its own. */
  nodeReplBrowserBroker?: NodeReplBrowserBroker;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  artifactStore?: ToolArtifactStorePort;
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  /** A per-app lease provided by the host; the ports it produces belong to the app. */
  mcpPortFactory?: (input: { workingDirectory?: string }) => McpPort;
  permissionBroker?: PermissionBrokerPort;
  eventSink?: SessionEventSink;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  uiDetectedLocale?: string | null;
  uiLocale?: UiLocale;
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  /** Resolved once at the first real user execution or at the cold-resume fallback, then cached by the app lifecycle. */
  resolveInitialBashShellSelection?: () => Promise<ExecutionShellSelection | undefined>;
  /** Trusted embedder policy; workspace/project files cannot populate this field. */
  workspaceHookPolicy?: WorkspaceHookPolicy;
  /** Protocol Host-owned provider shared by session Runtime and no-session Settings pretrust. */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** Rollout gate; false keeps project Hooks hard-blocked and does not read Trust records. */
  workspaceHookTrustEnabled?: boolean;
  /** Presence means this owner Host supports the dedicated Workspace Hook review route. */
  workspaceHookReviewHost?: WorkspaceHookReviewHostContext;
}

export interface SubmitPromptOptionsBase {
  traceContext?: TraceContext;
  abortSignal?: AbortSignal;
  inputId?: string;
  queryId?: QueryId;
  intent?: TurnInputIntentMetadata;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** Internal admission observation point: it only means the runtime sink saw TurnStarted, not that the projection has been applied. */
  onTurnStartedObserved?: (event: SessionEvent) => void;
  /** Removes it from the provider tool list for the current turn only; it does not permanently change the session runtime. */
  toolDisallowlist?: readonly string[];
  /** Provider-only IAB environment state provided read-only by the App; it does not enter the UI transcript. */
  browserAmbientContext?: ExecuteTurnOptions["browserAmbientContext"];
  /** A one-shot execution constraint for a standard Selection; it does not enter Session Selection or persistence. */
  modelExecution?: ModelExecutionContext;
}

export type SubmitPromptOptions = SubmitPromptOptionsBase &
  import("@zcode/contracts").TurnBackgroundAttribution;

export type PrepareUserExecutionBoundary = (
  options?: Pick<SubmitPromptOptions, "abortSignal" | "traceContext">,
) => Promise<void>;

export interface SteerTurnOptions {
  inputId?: string;
  queryId?: QueryId;
  expectedTurnId?: TurnId;
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
  /** Delivery semantics: queue = start a new turn when consumed; guide = inline into the current turn. Defaults to queue. */
  delivery?: "guide" | "queue";
  intent?: TurnInputIntentMetadata;
  attachments?: TurnAttachment[];
  /** Names of the tools that are not exposed to the provider while the current queued/guide input is consumed. */
  toolDisallowlist?: readonly string[];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  traceContext?: TraceContext;
}

export type SendInputOptions = SubmitPromptOptions & {
  inputId?: string;
  /** A presentation marker determined by the trusted consumption entry point; it does not change the original user content or the scheduling semantics. */
  inputPresentation?: ExecuteTurnOptions["inputPresentation"];
  delivery?: InputDelivery;
  /** The product-level guide/queue intent of sendText; whether it is busy is still decided by Core admission. */
  queueDelivery?: "guide" | "queue";
  requireIdle?: boolean;
  expectedTurnId?: TurnId;
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
};

export interface UserPromptInput {
  text: string;
  attachments?: TurnAttachment[];
}

export type PromptInput = string | UserPromptInput;

export type SendInputResult =
  | {
      /** Core admission has completed; completion is only for lifecycle cleanup, not an ACK wait boundary. */
      completion: Promise<TurnResult>;
      kind: "started_turn";
      turnId: TurnId;
    }
  | TurnSteerResult;

export interface ResumeOptions {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** The call-level materialized result of one cold resume; it does not enter the app lifecycle cache. After a compact repair it must be refreshed from the return value. */
  persistedMessages?: MessageWithParts[];
}

export interface ZCodePluginSetResult {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
}

export interface ZCodePluginUninstallResult {
  // null means that the plugin id is currently not installed (idempotent no-op), and the caller will prompt "not installed" accordingly.
  removed: ZCodeInstalledPluginData | null;
}

export interface SetLocaleResult {
  configPath: string;
  locale: SupportedLocale;
  previousLocale: SupportedLocale;
  requestedLocale: UiLocale;
  traceId: TraceContext["traceId"];
}

export interface ZCodeApp {
  readonly sessionId: SessionId;
  readonly traceId: string;
  readonly runtime: AgentRuntime;
  respondWorkspaceHookReview(
    input: RespondWorkspaceHookReviewInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  toggleWorkspaceHookReviewItem(
    input: ToggleWorkspaceHookReviewItemInput,
  ): Promise<WorkspaceHookReviewCommandResult & { request?: unknown }>;
  revokeWorkspaceHookTrust(
    input: RevokeWorkspaceHookTrustInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  /** Soft gate: opens the review flow on demand; a safe no-op when there are no pending items */
  requestWorkspaceHookReview(input: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  /**
   * After the Trust store is written to disk, this session's coordinator
   * in-memory mirror does not update on its own (per-session, loaded once at creation). After Settings'
   * pretrust grant succeeds with no task, the server calls this method once per workspace to reload the file
   * into the coordinator and re-emit the admission state; otherwise already-trusted Hooks stay rejected and the banner never refreshes.
   */
  reloadWorkspaceHookTrust(): Promise<void>;
  close?(): Promise<void>;
  getMode(): CollaborationMode;
  getModel(): string;
  /** A current-only protocol snapshot reads exactly the current Registry model, avoiding an enumeration of the whole catalog. */
  getCurrentModelOption?(): ZCodeModelOption | undefined;
  /** Read-only Registry metadata; it does not require complete options, nor is it bound to an execution model. */
  getModelOption?(selection: ModelSelection): ZCodeModelOption | undefined;
  getLocale(): SupportedLocale;
  getTheme(): UiThemePreference;
  getDefaultThoughtLevel(): string | undefined;
  getThoughtLevel(): string | undefined;
  loadSessionTranscript(): Promise<SessionTranscriptMessage[]>;
  readSubagents(input?: {
    endedCursor?: string;
    endedLimit?: number;
  }): Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;
  readSubagentTranscript(
    childSessionId: string,
  ): Promise<import("./subagent-observation.js").SubagentTranscriptSnapshot>;
  readTodos(): Promise<TodoItem[]>;
  readTarget(): Promise<SessionGoal | null>;
  setCustomSessionTitle(input: { title: string; traceContext?: TraceContext }): Promise<void>;
  readToolResultArtifact(uri: string): Promise<ToolArtifactReadResult>;
  /** After a chunk transaction commits, atomically lodge the complete binary in the session artifact store. */
  writePromptAttachment(input: {
    fileName: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
  /** An already-sent image/video preview: read the artifact or the real path inside the runtime that owns the session. */
  readPromptAttachment(input: {
    ref: string;
    mime: string;
    maxBytes: number;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** The Share selection stage only reads userInput attachment metadata; it does not read the full content. */
  statPromptAttachment?(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** An already-sent video on Desktop local: resolve the artifact-first local playback source; otherwise keep reading it in segments. */
  resolvePromptAttachmentPreviewSource(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ kind: "local_path"; path: string; mediaType: string } | { kind: "chunked" }>;
  setTarget(input: {
    objective: string;
    /** The raw goal command submitted by the user; target still only stores the objective, while the chat row displays that text. */
    displayText?: string;
    status?: GoalStatus;
    tokenBudget?: number | null;
    intent?: TurnInputIntentMetadata;
  }): Promise<SessionGoal>;
  updateTargetStatus(status: GoalStatus): Promise<SessionGoal | null>;
  clearTarget(): Promise<boolean>;
  continueActiveTarget(options?: SubmitPromptOptions): Promise<TurnResult | null>;
  recordInputHistory(
    input: PromptInput,
    kind?: InputHistoryKind,
  ): Promise<InputHistoryEntry | null>;
  recallPreviousInputHistory(skip?: number): Promise<InputHistoryEntry | null>;
  listModels(): ZCodeModelOption[];
  listThoughtLevels(): string[];
  listPlugins(): Promise<PluginLoadOutcome>;
  setPluginEnabled(plugin: string, enabled: boolean): Promise<ZCodePluginSetResult>;
  uninstallPlugin(plugin: string): Promise<ZCodePluginUninstallResult>;
  /**
   * The Plugin identity catalog frozen for a Session.
   * Built once from the resolveStartupPlugins result when the App is created, and read-only thereafter;
   * `plugins/referenceCatalog` with a sessionId uses this as the session authority.
   */
  getPluginReferenceCatalog(): PluginReferenceCatalog;
  /** The Skill discovery snapshot of the current Session's AgentRuntime; rediscovered after a cold resume rebuilds the runtime. */
  getSkillCatalog(): Promise<SkillLoadOutcome>;
  listMcpServers(): Promise<Record<string, McpServerStatus>>;
  connectMcpServer(name: string): Promise<McpServerStatus>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask?(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  /**
   * Paginated event log of a workflow run (the detail page's audit surface). An optional capability: when the dwf journal is unavailable the run service
   * is not constructed at all, this method is absent along with it, and the gateway answers with a structured capability-unsupported error rather than an empty page —
   * "there are no events" and "this session has no such capability" are two different things.
   *
   * cursor = journal sequence (assigned monotonically by `appendEvent`), the same ruler as workflowRuns[].lastEventSequence;
   * an out-of-range cursor returns an empty page instead of an error.
   */
  listDynamicWorkflowRunEvents?(input: {
    runId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * Resumes a dwf run. An optional capability, absent under the same conditions as
   * {@link listDynamicWorkflowRunEvents}. Besides port.resume, the success path is also responsible for **re-arming the tracking**
   * (runtime.trackResumedDynamicWorkflowRun): miss that and the resumed run cannot be cancelled, its completion notification is lost,
   * and the session reaping guard treats it as idle. Failures are returned as a structured reason (not thrown) — all five reasons are business
   * branches the caller can anticipate.
   */
  resumeWorkflowRun?(input: {
    workId: string;
    name?: string;
  }): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * Starts a saved workflow directly from the hub. After the GUI creates an empty session in the target project
   * and sends it `startSavedWorkflow`: the agent resolves the saved source + validates the arguments + compiles it, and if it comes out clean, lands the user's
   * real action into the session as one controlOnly "launch turn" and starts the run with `port.submit` (no model turn, no
   * `CreateWorkflow` confirmation dialog — the user's click in the hub is the consent). An optional capability, absent under the same conditions as
   * {@link resumeWorkflowRun} (not registered when there is no dwf port; the gateway answers with a capability-unsupported error). Failures are returned as a structured `reason`
   * (not thrown) — all six reasons are business branches the caller can anticipate, and `message` carries a human-readable diagnostic for inline display in the argument dialog;
   * stage ①② failures happen **before any persistence** (no run, no message, no event, no task), so the GUI calls `deleteSession`
   * to reclaim the empty session, and only runs that truly started show up in the transcript.
   */
  startSavedWorkflow?(input: {
    name: string;
    scope?: "project" | "global";
    args?: Record<string, unknown>;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * The GUI "configure" action changes a run's subagent model and concurrency upper bound: it revises a new run from the same script, with no model turn and no confirmation dialog. An optional capability: it is not
   * registered when the port is absent, or when the port has no `amend` / `getScript` (the gateway answers with a capability-unsupported error). Failures are returned as a structured `reason`
   * — each one happens before anything is stopped or newly created.
   */
  amendWorkflowRunSettings?(
    input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
  ): Promise<AmendWorkflowRunSettingsResult>;
  /**
   * The enumeration surface of workflow runs (the discovery query after a restart). An optional capability, absent under the same conditions as
   * {@link listDynamicWorkflowRunEvents}; when the journal has no narrow enumeration query, an empty list comes back (the honest answer —
   * runs in an in-memory journal would not survive the process anyway). `resumable` is computed with the very same predicate as the resume gate.
   */
  listDynamicWorkflowRuns?(input: { limit?: number }): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * Cold replay of workflow runs: runs under this session's name and outside `excludeRunIds`
   * are replayed from the journal into progress event payloads, and cold materialization feeds them to the same reducer as in-memory events —
   * so the `workflowRuns` projection stays consistent across a restart. An optional capability, absent under the same conditions as {@link listDynamicWorkflowRuns}.
   */
  replayDynamicWorkflowRuns?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * The read surface for a workflow run's **user-facing artifacts**. The three capabilities
   * are registered together and absent together: they are three slices of the same journal read surface, and having only some of them present
   * would just hand the UI a side panel whose cards will not open. The absence conditions are the same as {@link listDynamicWorkflowRunEvents}, plus all three
   * optional members of the port must be present.
   *
   * ⚠ Terminology: the artifact here is an output the script publishes for **users** through `artifact.*`, not the same-named engine-internal
   * notion of "a script's top-level return value".
   *
   * An unknown runId returns `undefined` (the gateway normalizes it to not found); a run with no parts returns an empty array.
   */
  listDynamicWorkflowRunArtifacts?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * Paginated `report` entries fed to a given preset board (cursor = journal sequence, strictly greater).
   * `limit` is clamped by the gateway before being passed down, and is honored here **exactly** — callers pass "cap + 1" to probe hasMore.
   * Absence conditions are the same as {@link listDynamicWorkflowRunArtifacts}.
   */
  listDynamicWorkflowRunArtifactItems?(input: {
    runId: string;
    artifactId: string;
    afterSequence?: number;
    limit: number;
  }): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  /**
   * Reads the **entire** byte content of one artifact version; chunking belongs to the gateway (≤ 512 KiB per chunk). The authorization chain lives on the port implementation side:
   * the run must belong to this session ∧ the journal must have a completed row for `(artifactId, version)`, and only then is the uri
   * **on that row** used to read from the store — an id passed in by a caller never becomes a path directly.
   * No such version / a preset board (no bytes) / an absent store all return `undefined`.
   * Absence conditions are the same as {@link listDynamicWorkflowRunArtifacts}.
   */
  readDynamicWorkflowRunArtifact?(input: {
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * The workspace transcript of a workflow run: the journal rows of `files.*` /
   * `git.*` / `world.run`; the two are registered together and absent together (a manifest + the bounded body of one node).
   * Authorization is on the port implementation side (the run must belong to this session); a run that is not yours / an unknown run both return `undefined`.
   * Absence conditions are the same as {@link listDynamicWorkflowRunArtifacts}.
   */
  listDynamicWorkflowRunWorkspaceNodes?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  readDynamicWorkflowRunNodeResult?(input: {
    runId: string;
    siteId: string;
    ordinal: number;
    maxBytes: number;
  }): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
  disconnectMcpServer(name: string): Promise<McpServerStatus | undefined>;
  listCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkFromCheckpoint(options?: {
    targetCheckpointId?: string;
    targetMessageId?: string;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<{
    text: string;
    selection: WorkspaceGenerateTextInput["selection"];
    finishReason: string;
    usage?: ModelUsage;
    toolCalls?: ModelToolCall[];
  }>;
  testModelConnectivity(
    input: { selection: ModelSelection },
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
  expertWorkflowStatus(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  workflowStatus?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  validateWorkflowScript?(input: { scriptPath: string }): Promise<ExpertWorkflowCommandResult>;
  runWorkflowScript?(
    input: { args?: unknown; resumeFromRunId?: string; scriptPath: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  resumeWorkflowScript?(
    input: { runId: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  scriptWorkflowStatus?(options?: { runId?: string }): Promise<ExpertWorkflowCommandResult>;
  listScriptWorkflows?(options?: { limit?: number }): Promise<ExpertWorkflowCommandResult>;
  retryWorkflow?(options?: {
    abortSignal?: AbortSignal;
    activityId?: string;
    definitionId?: string;
    nodeId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    phase?: string;
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  listExpertWorkflows?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    limit?: number;
    workflowKind?: string;
  }): Promise<WorkflowRunListItem[]>;
  listWorkflows?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    limit?: number;
    workflowKind?: string;
  }): Promise<WorkflowRunListItem[]>;
  readExpertWorkflowEvents?(options: {
    abortSignal?: AbortSignal;
    limit?: number;
    runId: string;
  }): Promise<WorkflowEvent[]>;
  readWorkflowEvents?(options: {
    abortSignal?: AbortSignal;
    limit?: number;
    runId: string;
  }): Promise<WorkflowEvent[]>;
  resume(options?: ResumeOptions): Promise<ResumeSessionResult>;
  resumeExpertWorkflow(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  resumeWorkflow?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  sendInput(input: PromptInput, options?: SendInputOptions): Promise<SendInputResult>;
  setMode(mode: CollaborationMode): Promise<{
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceId: TraceContext["traceId"];
  }>;
  setModelIoFullRetentionEnabled?(enabled: boolean): void;
  setModel(
    modelId: string | ModelSelection,
    options?: {
      /**
       * per-turn (off-peak idle plan): true = switch only the runtime state — do not write the model selection to disk,
       * and do not emit a modelChange chat notification. Used for turn-level temporary switches (apply/restore always come in pairs).
       */
      transient?: boolean;
    },
  ): Promise<{
    model: string;
    previousModel: string;
    thoughtLevel?: string;
    traceId: TraceContext["traceId"];
  }>;
  setThoughtLevel(level: string): Promise<{
    previousThoughtLevel?: string;
    thoughtLevel: string;
    traceId: TraceContext["traceId"];
  }>;
  setLocale(locale: UiLocale): Promise<SetLocaleResult>;
  stopExpertWorkflow(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  stopWorkflow?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  runExpertWorkflowBackground?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  runWorkflowBackground?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  /**
   * v4 deferred queue: when busy but with no steerable active turn (the compact / goal verifier /
   * goal continuation boundaries), ordinary input must first land as TurnSteerQueued, and must not disappear
   * from the composer because of runtime.steerTurn(no_active_turn/turn_not_steerable).
   */
  enqueueDeferredInput?(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  steerTurn(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  /** v4 queue single-item delete: removes one queued input by pendingInputId. Returns whether it matched. */
  removeQueueItem(
    pendingInputId: string,
    options?: {
      reason?: "user_removed" | "promoted";
      reservationId?: string;
      traceContext?: TraceContext;
    },
  ): Promise<boolean>;
  /** Atomic promotion by sendQueuedNow: after the reservation, an ordinary drain/delete must not consume that item. */
  reserveQueueItem(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  markQueueItemPromoting(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  releaseQueueItemReservation(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue single-item edit: replaces the queued input text by pendingInputId (keeping its position). Returns whether it matched. */
  editQueueItem(
    pendingInputId: string,
    newText: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue reorder: moves pendingInputId to before beforePendingInputId (null = end of queue). */
  reorderQueueItem(
    pendingInputId: string,
    beforePendingInputId: string | null,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 heldQueueDisposition=clearQueueAndSend: drops every queued input and returns how many were discarded. */
  clearQueueItems(options?: { traceContext?: TraceContext }): Promise<number>;
  /** v4 setAutoDrain: flips the queue autoDrain authorization bit (a session-level setting). */
  setQueueAutoDrain(autoDrain: boolean, options?: { traceContext?: TraceContext }): Promise<void>;
  /** The paused queue has already been drained to empty by the CLI outer layer: restore core's inline drain for the running queue that follows. */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode: flips the followup routing mode (queue/guide, a session-level setting). */
  setFollowupMode(
    mode: "queue" | "guide",
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  runExpertWorkflow(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  runWorkflow?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  submitPrompt(prompt: PromptInput, options?: SubmitPromptOptions): Promise<TurnResult>;
}

export interface ResolveLatestSessionOptions {
  directory: string;
  env?: NodeJS.ProcessEnv;
  sessionStore?: SessionStorePort;
}

export interface RunZCodeProtocolAgentOptions {
  /** The entry point owns the exit deadline; bootstrap only orchestrates cancellation and resource cleanup, it does not exit the process directly. */
  lifecycle?: {
    readonly signal: AbortSignal;
    readonly deadlineAt: number | undefined;
    requestShutdown(error?: Error): void;
  };
  /** Desktop internal command: only runs the original storage preparation and exits. */
  prepareStorageOnly?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  presentationSurface?: PresentationSurface;
  version?: string;
}

export interface ListZCodeSessionsOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  sessionStore?: SessionStorePort;
}

export type { WorkflowAgentRunner };
