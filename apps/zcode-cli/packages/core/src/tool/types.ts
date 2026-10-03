// ============================================================
// Tool Types - Core tool types for registry and executor
// ============================================================

import type {
  ExecutionShellSelection,
  AutomationPort,
  OffPeakPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  BrowserControlPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  ModelMessageContent,
  ModelContentProtection,
  Model,
  CoordinatorResponsePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  ModelCatalogPort,
  RiskLevel,
  SessionId,
  SessionEvent,
  SessionModePort,
  SessionStorePort,
  SkillPort,
  SkillTelemetryMetadata,
  SubagentRunOptions,
  SubagentPort,
  ToolArtifactStorePort,
  TraceContext,
  TraceId,
  TurnId,
  WorkflowPort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type {
  JsonSchema,
  ModelToolSideEffectScope,
  PermissionBrokerReasonSource,
  PermissionCapabilityGroup,
  PermissionRuleBehavior,
  PermissionRuleValue,
  PermissionUpdate,
  ProviderNativeToolSpec,
  ToolExecutionMode,
  ToolCancellationPolicy,
  ToolContractDeclaration,
  ToolResultBudgetStrategy,
  ToolResultDisplayPayload,
  ToolTimeoutPolicy,
  ToolExecutionSpanWriter,
  ToolExecutionTelemetry,
} from "@zcode/contracts";
import type {
  PersistedReadFileStateMetadata,
  PersistedReadFileStateTool,
} from "./read-file-state-metadata.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";

// -----------------------------------------------
// Tool Metadata
// -----------------------------------------------

export interface ToolMetadata {
  name: string;
  description?: string;
  modelInstructions?: readonly string[];
  allowedInPlanMode?: boolean;
  readOnly: boolean;
  destructive: boolean;
  concurrentSafe: boolean;
  requiresUserInteraction?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sideEffectScope: ModelToolSideEffectScope;
  riskLevel: RiskLevel;
  needsApproval: boolean;
  providerVisible?: boolean;
  /**
   * Declares the tool to be a terminal tool that ends the turn the moment it returns a successful result: the executor
   * attaches turnControl to that result and terminates the current turn. This is an intrinsic capability
   * declaration of the tool (like concurrentSafe/destructive), read by the executor rather than guessed
   * from the tool name at each call site. submit_result uses it to implement an actor's terminal submission.
   */
  stopTurnOnSuccess?: boolean;
  /** The trusted display source of MCP discovery; it feeds the UI projection only, never the permission decision. */
  mcpPresentation?: {
    serverName: string;
    toolName: string;
    description?: string;
    /** An MCP server that declared zcode_official auth; used only to trust the structured identifiers inside its results. */
    official?: boolean;
  };
}

// -----------------------------------------------
// Tool Execution Context
// -----------------------------------------------

export type ToolRuntimeScope = "main" | "subagent";

export interface BackgroundTaskControlStopOptions {
  /** Who is stopping: TaskStop fills in "model", and the terminal notification words itself accordingly. */
  initiator?: "user" | "model";
  strict: true;
  traceContext?: TraceContext;
}

export interface BackgroundTaskControlStopResult {
  command?: string;
  ok: boolean;
  reason?:
    | "background_task_cancel_not_supported"
    | "background_task_not_found"
    | "background_task_not_running";
  status?: string;
  taskId: string;
  type?: string;
}

export interface BackgroundTaskControlPort {
  stopBackgroundTask(
    taskId: string,
    options: BackgroundTaskControlStopOptions,
  ): Promise<BackgroundTaskControlStopResult>;
}

export interface ToolExecutionContext {
  toolCallId: string;
  /**
   * The live-observation writer of the current Tool. A Handler may only write facts through this narrow
   * interface; it cannot touch the raw OTel Span.
   */
  telemetry?: ToolExecutionSpanWriter;
  /** Whether the current tool call belongs to an automation dispatch turn; the write-tool handler uses it for the final permission check. */
  automationTurn?: boolean;
  /** Whether the current tool call belongs to an off-peak task dispatch turn; the OffPeakCreate handler uses it for the final rejection. */
  offPeakTurn?: boolean;
  traceContext?: TraceContext;
  traceId: TraceId;
  spanId?: string;
  parentSpanId?: string;
  abortSignal: AbortSignal;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  executionPort?: ExecutionPort;
  /** The browser-use control port; node_repl's agent.browsers.* execute through it. When absent, browser is unavailable. */
  browserControlPort?: BrowserControlPort;
  /** The asset directory of the official browser-use plugin docs; used only for agent.browsers.documentation() when browser-use is enabled. */
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  /** Core Server's Selection override for a foreground child. */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  /** The port by which a workflow actor submits a terminal result and waits for the engine's ruling; injected only into workflow actor sessions. */
  workflowSubmitPort?: WorkflowSubmitPort;
  /** The port by which a workflow actor escalates a blocking question and waits for the main agent's answer; injected only into workflow actor sessions. */
  workflowEscalatePort?: WorkflowEscalatePort;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** The workflow run submission port; when absent, CreateWorkflow returns a placeholder diagnostic instead of launching. */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /** The port for synchronous execution of dwf snippets; when absent, EvalWorkflowSnippet reports the business failure "capability absent". */
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** The model catalog port; when absent, ListModels reports the capability as absent and CreateWorkflow's subagent_model is rejected. */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState?: ReadFileStateMap;
  recordReadFileStateMetadata?: (metadata: PersistedReadFileStateMetadata) => void;
  /** Records resolved Skill metadata; used for telemetry only and does not change what the model sees. */
  recordSkillTelemetryMetadata?: (metadata: SkillTelemetryMetadata) => void;
  bashShellSelection?: ExecutionShellSelection;
  embeddedSearch?: ToolEmbeddedSearchContext;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  workingDirectory: string;
  workspaceRoot: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  runtimeScope?: ToolRuntimeScope;
  providerVisibleToolNames?: readonly string[];
  sessionId: SessionId;
  turnId?: TurnId;
}

export interface ToolEmbeddedSearchContext {
  backend?: EmbeddedSearchBackend;
  enabled: boolean;
  findAndGrepEnabled?: boolean;
}

export interface ReadFileStateEntry {
  path: string;
  content: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAt: Date;
  sourceTool?: PersistedReadFileStateTool;
  revisionId?: string;
  mtimeMs?: number;
  sizeBytes?: number;
}

export type ReadFileStateMap = Map<string, ReadFileStateEntry>;

// -----------------------------------------------
// Tool Handler
// -----------------------------------------------

// The tool handler uses this return value to express expected business failure; the successful output does not use this reserved shape.
export interface ToolHandlerFailure {
  result: false;
  errorCode: number;
  message: string;
}

export interface ToolInputValidationContext {
  runtimeTaskRegistry?: RuntimeTaskRegistry;
}

export type ToolInputValidationResult = { result: true } | ToolHandlerFailure;

/**
 * The context of {@link ToolEntry.resolveInput}. Narrowed down to what resolution genuinely needs — the working
 * directory is the only entry point to "where in-project things live", and giving anything more would turn a
 * normalization hook into a second execution entry point.
 */
export interface ToolInputResolutionContext {
  workingDirectory?: string;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  /**
   * The workflow run port plus this session's id: AmendWorkflow uses them to resolve `run_id` into the fact block
   * "is the predecessor from this session, and is it still running". Still read-only — the
   * normalization hook does not thereby become a second execution entry point.
   */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /**
   * The model catalog port: CreateWorkflow / AmendWorkflow use it to resolve `subagent_model` into canonical form, and an
   * unresolvable value falls back as a business failure **before** the confirmation
   * window. Synchronous and read-only, sitting here for the same reason as `dynamicWorkflowRunPort`. When it is
   * absent, supplying the field is rejected outright — no silently accepted string the
   * host cannot resolve.
   */
  modelCatalogPort?: ModelCatalogPort;
  sessionId?: string;
  /**
   * The probe for "does this session have some skill loaded right now" (handlers/workflow-skill-gate.ts). The runtime
   * answers it with the provider-visible history (agent/loaded-skills.ts), so after compaction the answer
   * flips back to no along with the history. Absent = this session has no Skill tool, or the caller does
   * not take part, and the gate does not apply.
   */
  hasLoadedSkill?: (skillName: string) => boolean;
}

export type ToolInputResolutionResult = { result: true; input: unknown } | ToolHandlerFailure;

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolExecutionContext,
) => Promise<TOutput>;

// -----------------------------------------------
// Tool Entry
// -----------------------------------------------

export interface ToolEntry extends ToolContractDeclaration {
  aliases?: readonly string[];
  /**
   * Host-issued atomicity policy for model content. Only an authority-verified
   * registration path may set this; executor code must never infer it from a
   * tool name or from model-visible content.
   */
  modelContentProtection?: ModelContentProtection["kind"];
  /**
   * Optional provider-visible character threshold for tools whose upstream contract
   * budgets UTF-16 characters rather than UTF-8 bytes.
   */
  maxModelChars?: number;
  /**
   * MIME type for provider-visible model content persisted by the result budget.
   * Defaults to the handler result shape when omitted.
   */
  resultArtifactContentType?: string;
  metadata: ToolMetadata;
  /**
   * Written only from a trusted source after the host has verified it; it cannot be derived from a
   * model-visible MCP name or descriptor.
   */
  permissionCapabilityGroup?: PermissionCapabilityGroup;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  handler: ToolHandler;
  /** The current turn's model capabilities as a same-source projection onto the provider descriptor and the executor schema. */
  resolveModelContract?: (context: ToolExecutionModelContext) => {
    description?: string;
    inputSchema?: JsonSchema;
  };
  validateInput?: (
    input: unknown,
    context: ToolInputValidationContext,
  ) => ToolInputValidationResult;
  /**
   * **Normalizes the inputs coming from the model into the execution facts that are about to happen.** The executor calls it after
   * `validateInput` and before the PreToolUse hook, and the return value replaces `executionInput` outright.
   *
   * The position is the whole of the meaning. From there on the hook, the project permission rules, the permission event payload, `prepareApproval` and the
   * handler all read one and the same normalized input, so three things land in one go:
   *   1. Policy is not bypassed — a PreToolUse hook that scans the script sees the real script on a saved run too;
   *   2. It is visible across versions — the input channel is a schema-less passthrough for every client version, while the display channel is not;
   *   3. Confirmation and execution share the same bytes — it is parsed once and those bytes travel all the way to the handler, so there is never "approve A, run B".
   *
   * The return value must therefore still satisfy `inputSchema` / `runtimeInputSchema` (after a hook rewrite the executor
   * validates once more). A resolution failure returns {@link ToolHandlerFailure}, and the executor closes it off ahead of
   * the hook — that is a business failure, not an infrastructure fault, and it should not interrupt the
   * user with a confirmation first.
   */
  resolveInput?: (
    input: unknown,
    context: ToolInputResolutionContext,
  ) => Promise<ToolInputResolutionResult> | ToolInputResolutionResult;
  formatModelContent?: (output: unknown) => ModelMessageContent;
  formatPersistedModelContent?: (
    input: ToolPersistedModelContentInput,
  ) => ModelMessageContent | undefined;
  resolveTimeoutBudgetMs?: (
    input: unknown,
    context?: ToolExecutionModelContext,
  ) => number | undefined;
  resolvePermissionCapability?: (
    input: unknown,
    context?: ToolRuntimePermissionCapabilityContext,
  ) => ToolRuntimePermissionCapability | undefined;
  resolvePermissionRulePolicy?: (
    input: unknown,
    context?: ToolRuntimePermissionCapabilityContext,
  ) => ToolPermissionRulePolicy | undefined;
  /**
   * Last word on an `ask` decision, owned by the tool. Runs after the permission service
   * has already decided to ask, so it can only narrow the ask to a pass (`proceed`) or
   * enrich it with a preview — it can never turn an allow into an ask.
   *
   * Synchronous like the other permission hooks: it inspects the input the executor
   * already holds and must not perform I/O on the approval path. A tool that needs to
   * read the world before it can build a preview belongs in {@link resolveInput}, which
   * runs earlier, is async, and whose result the whole downstream chain shares.
   */
  prepareApproval?: (input: unknown) => ToolApprovalGate;
  inputSchema: JsonSchema;
  runtimeInputSchema?: unknown;
  runtimeOutputSchema?: unknown;
  timeout: ToolTimeoutPolicy;
  cancellation: ToolCancellationPolicy;
}

export type ToolApprovalGate =
  | { gate: "proceed" }
  | { gate: "ask"; display?: ToolResultDisplayPayload };

export interface ToolPermissionRulePolicy {
  evaluateRules: (
    behavior: PermissionRuleBehavior,
    rules: readonly PermissionRuleValue[],
  ) => boolean;
  suggestedPermissionUpdates: PermissionUpdate[];
}

export interface ToolPersistedModelContentInput {
  output: unknown;
  content: string;
  persistedPath: string;
  originalBytes: number;
}

export interface ToolRuntimePermissionCapability {
  allowedInPlanMode?: boolean;
  destructive?: boolean;
  needsApproval?: boolean;
  readOnly?: boolean;
  requiresUserInteraction?: boolean;
  riskLevel?: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  permission?: Partial<ToolContractDeclaration["permission"]>;
}

export interface ToolRuntimePermissionCapabilityContext {
  runtimeScope?: ToolRuntimeScope;
  workingDirectory?: string;
  workspaceRoot?: string;
}

export interface ToolExecutionModelContext {
  model?: Model;
}

// -----------------------------------------------
// Execution Results
// -----------------------------------------------

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  output: unknown;
  turnControl?: ToolExecutionTurnControl;
  followUpUserInput?: ToolExecutionFollowUpUserInput;
  display?: ToolResultDisplayPayload;
  modelContent?: ModelMessageContent;
  readFileStateMetadata?: PersistedReadFileStateMetadata;
  serialization?: ToolResultSerialization;
  /** The internal performance facts aggregated by the Executor; they never enter the model-visible Tool Output. */
  performance?: ToolExecutionTelemetry;
  error?: {
    code?: string;
    detail?: string;
    type: string;
    message: string;
    reasonSource?: PermissionBrokerReasonSource;
    stack?: string;
  };
  durationMs: number;
  startedAt: Date;
  completedAt: Date;
}

export interface ToolExecutionFollowUpUserInput {
  input: string;
  reasonSource: PermissionBrokerReasonSource;
}

export interface ToolExecutionTurnControl {
  reason: "automation_create_limit" | "plan_exit_denied" | "subagent_terminal";
  stopTurnAfterResult: boolean;
}

export interface ToolResultSerialization {
  content: string;
  modelContent?: ModelMessageContent;
  originalBytes: number;
  /**
   * The bytes that actually enter the model request. For a protected CUA structured frame, an image block is rendered
   * only as a short placeholder in the serialized text, while the real base64 raster is sent as-is — so here it =
   * serialized text bytes + the real media payload, and the cost/usage observations
   * (setOutputBytes, turn-tool-usage, usage-observability) must not undercount images. This aggregate is the
   * only publicly metered state.
   */
  returnedBytes: number;
  truncated: boolean;
  budgetStrategy: ToolResultBudgetStrategy;
  artifactPath?: string;
}

export interface ToolBatchResult {
  toolCallId: string;
  results: ToolExecutionResult[];
  allSucceeded: boolean;
}

// -----------------------------------------------
// Executable Tool Call
// -----------------------------------------------

export interface ExecutableToolCall {
  id: string;
  name: string;
  input: unknown;
}

// -----------------------------------------------
// Batch Events
// -----------------------------------------------

export type ToolBatchEvent =
  | { type: "batch_start"; parallelGroupIndex: number; toolCallIds: string[] }
  | {
      type: "batch_complete";
      parallelGroupIndex: number;
      results: ToolExecutionResult[];
    }
  | { type: "tool_start"; toolCallId: string }
  | { type: "tool_complete"; result: ToolExecutionResult }
  | { type: "error"; error: Error; toolCallId?: string };
