/* eslint-disable max-lines -- The ZCode task wrapper service interfaces centrally carry the app/runtime API; scattering them makes the replacement phase harder to track. */
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "#src/descriptors.js";
import type {
  ZCodeImportSessionsResult,
  ZCodeImportableSessionCandidate,
  ZCodeSessionCompactResult,
  ZCodeSessionGoalAction,
  ZCodeSessionGoalResult,
  ZCodeTaskCreateResult,
  ZCodeTaskMeta,
  ZCodeStreamEvent,
  ZCodeTaskMode,
  ZCodeConfigOption,
  ZCodeError,
  ZCodeAssistantMessageFeedback,
  ZCodePromptAttachment,
  ZCodeProvider,
  ZCodeWorkspaceEvent,
  TraceId,
  ZCodeSessionFile,
  ZCodeAgentMcpServer,
  ZCodeTaskSnapshot,
  ZCodeTaskSnapshotBody,
  ZCodeTaskSnapshotToolCallsSlice,
  ZCodeTaskSnapshotRefContent,
  ZCodeEnqueueTaskCommandResult,
  ZCodeCancelTaskCommandResult,
  ZCodeTaskClientMode,
  ZCodeTaskTokenUsageResult,
  ZCodePermissionResponse,
  ModelSelection,
  ZCodeBackgroundTurnAttribution,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "#src/session/sessionMailbox.js";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
  ZCodeWorkspaceEventSubscriptionParams,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "#src/session/zcodeTaskListTypes.js";

export interface ZCodeTaskSnapshotWithEtagResult {
  snapshot: ZCodeTaskSnapshot | null;
  etag?: string;
  notModified?: boolean;
}

/** Fixed set of archived-task deletions for one workspace; every deduplicated target falls into exactly one outcome. */
export interface ZCodeArchivedTaskDeletionResult {
  deletedTaskIds: string[];
  skippedTaskIds: string[];
  failedTaskIds: string[];
}

/** A content fragment of a message inside one model request (text / tool call / tool result / other raw structure). */
export type ZCodeModelTrajectoryContentPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; toolCallId?: string; toolName: string; input?: unknown }
  | { kind: "tool-result"; toolCallId?: string; toolName?: string; output?: unknown }
  | { kind: "image"; mediaType?: string }
  | { kind: "unknown"; raw: unknown };

/** A single conversation message (system / user / assistant / tool). */
export interface ZCodeModelTrajectoryMessage {
  role: string;
  parts: ZCodeModelTrajectoryContentPart[];
}

/** Token usage normalized out of a model_io record. */
export interface ZCodeModelTrajectoryUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

export type ZCodeModelTrajectoryCallSourceKind =
  | "main"
  | "sidecar"
  | "subagent"
  | "compact"
  | "unknown";

export interface ZCodeModelTrajectoryCallSource {
  kind: ZCodeModelTrajectoryCallSourceKind;
  querySource?: string;
}

/**
 * One model call (one model_io record). A trajectory is made of many calls in chronological order.
 * request.messages is the full context sent to the model for that request (growing with each turn),
 * while response is the new content the model produced in that call.
 */
export interface ZCodeModelTrajectoryRecord {
  requestId: string;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  turnId?: string;
  traceId?: string;
  callSource?: ZCodeModelTrajectoryCallSource;
  model: {
    modelId?: string;
    providerId?: string;
    role?: string;
    source?: string;
  };
  request: {
    messages: ZCodeModelTrajectoryMessage[];
    toolNames: string[];
  };
  response?: {
    finishReason?: string;
    text?: string;
    reasoningText?: string;
    toolCalls: ZCodeModelTrajectoryContentPart[];
    usage?: ZCodeModelTrajectoryUsage;
    responseId?: string;
    modelId?: string;
  };
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/** The complete model-call trajectory of a task/session. */
export interface ZCodeModelTrajectory {
  taskId: string;
  /** Whether the runtime supports reading model-io trajectories (only the ZCode Agent persists model-io). */
  available: boolean;
  records: ZCodeModelTrajectoryRecord[];
  /** Absolute paths of the matched source files, for troubleshooting. */
  sourceFiles: string[];
  /** Whether it was truncated because it exceeded the cap (only the most recent N entries are kept). */
  truncated: boolean;
}

export type {
  ZCodeTaskListKind,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
  ZCodeWorkspaceEventSubscriptionParams,
  ZCodeGroupedTaskRef,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeGroupedTaskViewStructureTopOrder,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "#src/session/zcodeTaskListTypes.js";

/** Terminal outcome of one input turn of a task, used by background dispatch (scheduled tasks) to write back the run result. */
export interface ZCodeTaskTerminalOutcome {
  taskId: string;
  /** The corresponding input turn id (= sendPrompt's traceId/inputId), used to match a specific dispatch exactly. */
  inputId?: string;
  outcome: "succeeded" | "failed" | "stopped";
  /** Error information when it failed. */
  error?: string;
}

/** An input turn has truly finished, so the session can safely accept the next input. */
export interface ZCodeTaskReadyOutcome {
  taskId: string;
  reason: "prompt_completed" | "prompt_failed";
}

/**
 * IZCodeTaskService — service interface for the ZCode task wrapper API
 *
 * The UI and remote controller reach task wrapper state through this layer; core session state is maintained by the
 * ZCode Agent server, so new features should prefer going through IZCodeSessionService.
 */
export interface IZCodeTaskService {
  // ---- Life cycle ----

  /** Check whether the agent runtime is available */
  initialize(params: { workspacePath: string }): Promise<{ available: boolean; version?: string }>;

  /** Release idle workspace sessions that exist only for warm-up, so they keep spinning after you switch tabs no more */
  releaseWorkspacePreparation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<void>;

  // ---- Task/Session Management ----

  /** Create a ZCode session and sync the task index. */
  createTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    mode?: ZCodeTaskMode;
    /** The definitive model selection; it is no longer split into model/thoughtLevel now that the product submission boundary is fixed. */
    modelSelection?: ModelSelection;
    /** @deprecated Read only by legacy call boundaries that have not migrated yet. */
    model?: string;
    /** @deprecated Read only by legacy call boundaries that have not migrated yet. */
    thoughtLevel?: string;
    draftSessionId?: string;
    forkedFromTaskId?: string;
    mcpServers?: ZCodeAgentMcpServer[];
    /** Marks the owning automation when a scheduled task dispatches; stored in tasks-index as cron_automation_id and grouped under cron. */
    automationId?: string;
    /** Marks the owning off-peak task when an idle task dispatches; stored in tasks-index as off_peak_task_id. */
    offPeakTaskId?: string;
    /**
     * Headless dispatch first creates an empty session and then immediately sends the first V4 input. This uses deferred
     * so that input admission persists the session master record in one go before writing the session_input foreign-key ledger.
     */
    deferPersistenceUntilFirstPrompt?: boolean;
    /** Bots/host use the native v4 createSession to establish a draft, then configure and send. */
    v4Create?: boolean;
  }): Promise<ZCodeTaskCreateResult>;

  /** Send a prompt to the given task */
  sendPrompt(
    params: {
      taskId: string;
      remoteSessionId?: string;
      traceId: TraceId;
      queryId?: string;
      messageId?: string;
      content: string;
      attachments?: ZCodePromptAttachment[];
      clientId?: string;
      clientLabel?: string;
      clientMode?: ZCodeTaskClientMode;
      /** Tools additionally hidden for the current turn; merged with the tool isolation rules session/automation already carries. */
      toolDenylist?: string[];
      /** Stable callback address for Bot-sourced turns; injected by BotsService and not controllable by the model. */
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
      /** Standard model selection; idle tasks also create their Model through Registry / ModelFactory. */
      modelSelection?: CommandPayloadMap["sendText"]["modelSelection"];
      /** Single-execution constraints and dynamic auth; only idle start-now accepts it, and it never enters the normal queue. */
      modelExecution?: CommandPayloadMap["sendText"]["modelExecution"];
    } & ZCodeBackgroundTurnAttribution,
  ): Promise<void>;

  deliverSessionMessage(
    request: SessionMessageSendRequested,
  ): Promise<SessionMessageDeliveryResult>;

  sendSessionMessageDeliveryResult(result: SessionMessageDeliveryResult): Promise<void>;

  /** Submit a task runtime command to the host; once this returns, the owner host has accepted it. */
  enqueueTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    traceId: TraceId;
    queryId?: string;
    type: "send_prompt";
    content: string;
    attachments?: ZCodePromptAttachment[];
    clientId?: string;
    clientLabel?: string;
    /** The automation context must also be preserved when scheduled-task dispatch is deferred through the host command queue. */
    automationId?: string;
    ownerRunId?: TraceId;
  }): Promise<ZCodeEnqueueTaskCommandResult>;

  promoteTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    ownerRunId: TraceId;
    clientMode: ZCodeTaskClientMode;
  }): Promise<ZCodeEnqueueTaskCommandResult>;

  cancelTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    ownerRunId?: TraceId;
    clientMode: ZCodeTaskClientMode;
  }): Promise<ZCodeCancelTaskCommandResult>;

  /** Stop the generation currently in progress */
  stopGeneration(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
  }): Promise<void>;

  /** Run the agent built-in /compact command; phone replayable still routes through the shared host. */
  compactSession(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    inputId?: string;
    instructions?: string;
    expectedRevision?: number;
  }): Promise<ZCodeSessionCompactResult>;

  /** Run the agent built-in /goal command; do not send /goal as an ordinary body prompt. */
  goalSession(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    inputId?: string;
    action: ZCodeSessionGoalAction;
    objective?: string;
    expectedRevision?: number;
  }): Promise<ZCodeSessionGoalResult>;

  /** Respond to a permission request */
  respondPermission(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    requestId: string;
    optionId: string;
    response: ZCodePermissionResponse;
  }): Promise<boolean>;

  /** Respond to a user question request (Elicitation) */
  respondElicitation(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    requestId: string;
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
    clientMode?: ZCodeTaskClientMode;
  }): Promise<boolean>;

  /** Close a task (prefer session/close; the shared process is only reclaimed once the last task under the workspace ends) */
  closeTask(params: { taskId: string }): Promise<void>;

  /** Resume an existing task (reuse the workspace-level agent process, creating one if absent, then run session/load) */
  resumeTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    mode?: ZCodeTaskMode;
    model?: string;
    thoughtLevel?: string;
    /** Resumes an existing targetTaskId on scheduled-task dispatch, reusing the automation tool-surface isolation. */
    automationId?: string;
    /** Fills in the off-peak marker when an idle continuation resumes a pre-session (a new session is already stamped in createTask). */
    offPeakTaskId?: string;
    mcpServers?: ZCodeAgentMcpServer[];
  }): Promise<ZCodeTaskMeta>;

  /** List every persisted task under the workspace */
  listTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Read the global pinned task id list; the source of truth is tasks-index.sqlite */
  listPinnedTaskIds(): Promise<string[]>;

  /** List every pinned task under the current workspace, by the pinned state in tasks-index.sqlite */
  listPinnedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Read the deleted task ids under the workspace; used for the persistent negative membership join of the sessions-index list */
  listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<string[]>;

  /**
   * Aggregated task-list query over the currently open workspace scopes; the source of truth is tasks-index.sqlite.
   * Consumers: full-text search (searchable_text/snippets) and the remoteTimelineTaskStore enrichment path;
   * search-free list flows go through listTasks/listPinnedTasks/listArchivedTasks, and the workspace rows are
   * built by the client from each endpoint's task rows + session detail (multi-client convergence).
   */
  listTaskList(params: ZCodeTaskListQuery): Promise<ZCodeTaskListResult>;

  /** Create a minimal task group; full delete is filled in later by the group management feature */
  createTaskGroup(params?: {
    title?: string;
    color?: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup>;

  /** Rename a task group; workspaceScopes is only used to notify the currently visible grouped view to refresh */
  renameTaskGroup(params: {
    groupId: string;
    title: string;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeTaskGroup>;

  /** Update a task group's color; workspaceScopes is only used to notify the currently visible grouped view to refresh */
  updateTaskGroupColor(params: {
    groupId: string;
    color: ZCodeTaskGroupColor;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeTaskGroup>;

  /** Delete a task group; callers should first move the tasks in the group back to the top-level root */
  deleteTaskGroup(params: {
    groupId: string;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<void>;

  // The server-side grouped query only returns the original structure (no join tasks table),
  // The renderer uses task row partition + session detail to unify the projection.

  /**
   * Query the raw structure of the Grouped view (group/member/top-level ordering, without joining the tasks table).
   * The client uses its task-row partitions as the left table to join this structure; sessions-index only supplements live detail.
   */
  listGroupedTaskViewStructure(params: {
    workspaceScopes: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeGroupedTaskViewStructure>;

  /** Submit the grouped view's final ordering and membership in one shot; the service layer persists it in a sqlite transaction */
  applyGroupedTaskViewOrder(params: ZCodeGroupedTaskViewOrderInput): Promise<ZCodeGroupedTaskView>;

  /** List every archived task under the workspace */
  listArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Bulk-archive stale old tasks; only tasks that are finished, have no unread, are not pinned, and are not currently open are archived */
  archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
  }): Promise<ZCodeTaskMeta[]>;

  /** Bulk-archive every unarchived task under the workspace when it is removed, including pinned tasks */
  archiveWorkspaceTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Read the locally persisted snapshot of a single task, for the first-screen display of a historical task */
  getTaskSnapshot(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageLimit?: number;
    byteBudget?: number;
    toolLimit?: number;
    clientMode?: ZCodeTaskClientMode;
    resumeModelPolicy?: "task-index" | "ui-resolved-only";
    model?: string;
    thoughtLevel?: string;
  }): Promise<ZCodeTaskSnapshot | null>;

  /** Read the task snapshot with an ETag, supporting if-none-match semantics to cut repeated large transfers. */
  getTaskSnapshotWithEtag(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageLimit?: number;
    ifNoneMatch?: string;
    byteBudget?: number;
    toolLimit?: number;
    clientMode?: ZCodeTaskClientMode;
    resumeModelPolicy?: "task-index" | "ui-resolved-only";
    model?: string;
    thoughtLevel?: string;
  }): Promise<ZCodeTaskSnapshotWithEtagResult>;

  /** Read the full body of a large message that was trimmed by the first-screen budget, by bodyRef. */
  getTaskSnapshotBody(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    refId: string;
  }): Promise<ZCodeTaskSnapshotBody | null>;

  /** Read the full fields of a tool call or file change that was trimmed by the first-screen budget, by ref. */
  getTaskSnapshotRef(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    refId: string;
  }): Promise<ZCodeTaskSnapshotRefContent | null>;

  /** Fetch an extra tools slice by message + index range, for incremental loading of a remote-control first screen trimmed by entry count. */
  getTaskSnapshotToolCallsSlice(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageIndex: number;
    startToolIndex: number;
    limit: number;
  }): Promise<ZCodeTaskSnapshotToolCallsSlice | null>;

  /** Read the lightweight meta of a single task (without messages/fileChanges), as a fallback for title/provider display */
  getTaskMeta(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta | null>;

  /** Read the config options held in memory for the current active task, with no workspace warm-up fallback */
  getTaskConfigOptions(params: { taskId: string }): Promise<ZCodeConfigOption[]>;

  /** Read the original model selection bound to the Session; never inferred backwards from the candidate menu, and never validity-resolved or written. */
  getTaskModelSelection(params: { taskId: string }): Promise<ModelSelection | null>;

  /** Persist the user's local feedback on an assistant reply; it is never injected into provider context. */
  setAssistantMessageFeedback(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    turnIndex: number;
    feedback: ZCodeAssistantMessageFeedback | null;
  }): Promise<ZCodeSessionFile>;

  /** Scan importable native Claude sessions; optionally filtered by workspace. */
  scanImportableClaudeSessions(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    modifiedSince?: number;
    limit?: number;
  }): Promise<ZCodeImportableSessionCandidate[]>;

  /** Import the selected native Claude sessions and reverse-generate a minimal task snapshot; without workspacePath the original workspace is used. */
  importClaudeSessions(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    sessionIds: string[];
  }): Promise<ZCodeImportSessionsResult>;

  /** Switch the task mode */
  setMode(params: { taskId: string; mode: ZCodeTaskMode }): Promise<void>;

  /** Switch a configOption (model, thinking level, etc.) and return the full updated configOptions list */
  setConfigOption(params: {
    taskId: string;
    traceId: TraceId;
    configId: string;
    value: string;
  }): Promise<ZCodeConfigOption[]>;

  /** Switch the model and return the server's authoritative configOptions */
  setModel(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
  }): Promise<ZCodeConfigOption[]>;

  /** Scheduled-task dispatch only: converges the model, Think, and permission mode, and keeps the V4 conversation projection in sync. */
  setAutomationSessionConfig(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
    thoughtLevel?: string;
    mode?: ZCodeTaskMode;
  }): Promise<ZCodeConfigOption[]>;

  /** Get the current structured log file path of the ZCode Agent. */
  getTaskNativeSessionLogFile(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    provider: ZCodeProvider | null;
    path: string | null;
    exists: boolean;
  }>;

  /**
   * Read the model-call trajectory of a task (from the model-io JSONL under ~/.zcode/cli/{debug,rollout}).
   * taskId is the ZCode Agent's sessionId, and model-io records are matched by sessionId.
   */
  getModelTrajectory(params: {
    taskId: string;
    /** Maximum number of calls returned (most recent N kept in reverse chronological order), default 200. */
    limit?: number;
  }): Promise<ZCodeModelTrajectory>;

  /** Read a task/session's cumulative model token usage from the agent usage database. */
  getTaskTokenUsage(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskTokenUsageResult>;

  /** Get the path of a task's persisted snapshot file (always {taskId}.json, except soft-deleted ones as .deleted.json) */
  getTaskSessionFilePath(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    path: string;
    exists: boolean;
  }>;

  /**
   * Restart the ZCode Agent shared process of the given workspace.
   * Use it when a configuration change requires re-reading the process environment.
   * Optionally pass resumeTaskId to continue the current chat session right after the restart.
   */
  restartWorkspaceProcess(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    resumeTaskId?: string;
    bumpRuntimeEpoch?: boolean;
  }): Promise<void>;

  /** Mark a persisted task as invisible in lists; the CLI session content is kept */
  deleteTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;

  /** Only deletes tasks that are still archived at write time; returns false when already restored, already deleted, or absent, and does not clean up the CLI session. */
  deleteArchivedTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean>;

  /** Delete archived tasks entry by entry against the archive conditions, notifying the list once the batch ends; does not clean up CLI sessions. */
  deleteArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskIds: string[];
  }): Promise<ZCodeArchivedTaskDeletionResult>;

  /** Rename a persisted task */
  renameTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
  }): Promise<ZCodeTaskMeta>;

  /** Update a task's pinned state */
  setTaskPinned(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    pinned: boolean;
  }): Promise<ZCodeTaskMeta>;

  /** Update a task's unread state */
  setTaskUnread(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    unread: boolean;
    /** Only used for the read compare-and-clear; when absent, the existing unconditional write semantics are kept. */
    expectedUnreadAt?: number;
  }): Promise<ZCodeTaskMeta>;

  /** Archive a task so it is hidden from the default task list */
  archiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta>;

  /** Unarchive a task so it returns to the default task list */
  unarchiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta>;

  /** Create an empty branch based on the source task's session configuration, used to edit a user input again. */
  branchTaskFromPrompt(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourceTaskId: string;
  }): Promise<ZCodeTaskCreateResult>;

  // ---- Streaming events ----

  /** Subscribe to stream updates for the given task (a ProxyChannel dynamic event) */
  onDynamicStreamEvent(taskId: string): Event<ZCodeStreamEvent>;

  /**
   * Subscribe to the terminal outcome of the given task (succeeded / failed / stopped).
   * A permanent session subscription based on the task index that does not depend on whether the renderer is watching
   * that task, so background dispatch (such as a scheduled task) also reliably gets the terminal outcome. Used to write back automation_runs.outcome.
   */
  onDynamicTaskTerminalOutcome(taskId: string): Event<ZCodeTaskTerminalOutcome>;

  /**
   * Subscribe to the input-ready boundary of the given task. sendPrompt only returns a remote ACK and must not be used
   * to decide the Agent is idle; Host runtime reclamation has to wait for this event, so closing a workspace never
   * interrupts a still-running Agent.
   */
  onDynamicTaskReady(taskId: string): Event<ZCodeTaskReadyOutcome>;

  /** Subscribe to stream updates for the given workspace + task, avoiding cross-workspace stream mixing for the same taskId. */
  onDynamicTaskEvent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    clientId?: string;
    deliveryKind?: "continuous" | "bot-channel-continuous" | "replayable" | "mixed";
  }): Event<ZCodeStreamEvent>;

  /**
   * Subscribe to workspace-level async notifications (such as the slash commands and configOptions the Agent pushes during warm-up).
   * It covers the gap before a task is created, so the UI can update its draft-state toolbar and command list in real time.
   * The naming follows ProxyChannel's onDynamic prefix convention so the RPC proxy automatically recognizes it as a dynamic event.
   */
  onDynamicWorkspaceEvent(
    workspace: string | ZCodeWorkspaceEventSubscriptionParams,
  ): Event<ZCodeWorkspaceEvent>;

  /** Global error event */
  onError: Event<ZCodeError>;
}

export const IZCodeTaskService = createServiceDescriptor<IZCodeTaskService>(
  ServiceChannels.ZCodeTask,
);
