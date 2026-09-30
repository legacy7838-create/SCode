/* oxlint-disable eslint(max-lines) -- the types and default state of the ZCode Agent store are
 * exported in one place, to avoid defining shared structures repeatedly across slices.
 */
/**
 * ZCode Session Store type definitions, interfaces, constants, and default-value factories
 *
 * Split out of zcodeSessionStore.ts so that the store itself and submodules such as selectors /
 * navigation can share them.
 */
import {
  buildNativeSupplierKey,
  ZCODE_AGENT_PROVIDER,
  type ZCodeApiRetryStatus,
  type ModelSelectionGhostReason,
  type ModelSelectionResolution,
  type ZCodeWorkspaceInitStatus,
  type ZCodeTaskRuntimeStatus,
  type ZCodeProvider,
  type ZCodeTaskMeta,
  type ZCodeContextCacheUsage,
  type ZCodeConfigOption,
  type ZCodeSlashCommand,
  type ZCodePermissionRequest,
  type ZCodeElicitationRequest,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeSessionActiveTurnKind,
  type ZCodeContextUsageBreakdownItem,
  type InputId,
  type SessionCreateSource,
} from "@zcode/shared";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import type {
  AutomationsNavigationTab,
  TaskNavigationHistory,
  WorkspaceNavEntry,
} from "@/lib/taskNavigationHistory.js";
import type { MentionCategory, MentionItemData } from "@/mentions/mentionTypes.js";

// ────────────────────────────────────────────
// Interfaces
// ────────────────────────────────────────────

export interface WorkspaceInitState {
  status: ZCodeWorkspaceInitStatus;
  error: string | null;
  attempts: number;
}

export type GroupedDraftTaskPlacement = { type: "top" } | { type: "group"; groupId: string };

export interface GroupedDraftTaskState {
  draftId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  placement: GroupedDraftTaskPlacement;
  createdAt: number;
}

export interface TaskRuntimeState {
  status: ZCodeTaskRuntimeStatus;
  error: string | null;
  /**
   * The ZCode Agent process provider bound to this task's current runtime state, used for the
   * workspace-level busy lock on process rebuilds.
   */
  provider?: ZCodeProvider;
  /**
   * The current model context window capacity; model status events only update this and never
   * overwrite the real usage.used.
   */
  contextWindow: number | null;
  usage: TaskUsageState | null;
  apiRetry: ZCodeApiRetryStatus | null;
  /**
   * Background task control entries explicitly reported by the Agent; host runtime state that is
   * not persisted to disk.
   */
  backgroundTaskControls: ZCodeBackgroundTaskControlItem[];
  /**
   * The type of the current session's active turn; used to distinguish ordinary generation from the
   * compact maintenance state.
   */
  activeTurnKind?: ZCodeSessionActiveTurnKind;
  activeInputId?: InputId;
  activeInputOwnerClientId?: string;
}

export interface DraftRuntimeState {
  status: ZCodeTaskRuntimeStatus;
  error: string | null;
}

export interface TaskUsageState {
  /** The number of tokens already used in the current context window */
  used: number;
  /** The total token capacity of the current context window */
  size: number;
  /** The cumulative cost reported by the Agent */
  cost?: { amount: number; currency: string } | null;
  /** The cache-hit information for the current main turn, as returned by the Agent/app protocol. */
  cache?: ZCodeContextCacheUsage;
  /**
   * The context character count estimated by the Agent per source, used only for the proportional
   * display in the context usage dialog.
   */
  breakdown?: ZCodeContextUsageBreakdownItem[];
}

export interface ElicitationAnswerDraft {
  selectedValues: string[];
  customAnswer: string;
}

export interface ElicitationFormDraft {
  questionIndex: number;
  drafts: Record<string, ElicitationAnswerDraft>;
}

/**
 * Store wrap-up: TaskUiState has converged on "the human-intervention surface that remote
 * broadcasts still need to replay" — the pending queues of the permission/question dialogs and the
 * renderer-local question draft + error banner. The writers of the old ChatView presentation state
 * (plan/goal/token debug, etc.) were removed along with the old protocol path, and the read side is
 * now carried by the v4 conversation projection.
 */
export interface TaskUiState {
  permissionRequest: ZCodePermissionRequest | null;
  pendingPermissionRequests: ZCodePermissionRequest[];
  elicitationRequest: ZCodeElicitationRequest | null;
  pendingElicitationRequests: ZCodeElicitationRequest[];
  elicitationFormDraftsByRequestId: Record<string, ElicitationFormDraft>;
  error: ZCodeUiError | null;
}

export type ModelSwitchStage =
  | "idle"
  | "settingModel"
  | "fallbackConfigOption"
  | "applyingCustomProvider"
  | "restartingRuntime"
  | "syncingSession"
  | "persistingWorkspace";

export type ConfigOptionsStatus = "idle" | "loading" | "ready" | "error";

export interface ComposerMentionPrefill {
  id: string;
  category: MentionCategory;
  label: string;
  value: string;
  markdown: string;
  description?: string;
  data?: MentionItemData;
}

export interface ComposerTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

export interface TimelineBottomRequest {
  requestId: number;
  taskId: string;
}

export interface WorkspaceZCodeUIState {
  /** The task currently active in this workspace */
  activeTaskId: string | null;
  /**
   * The workspace initialization state of the ZCode Agent.
   *
   * After the migration to a single ZCode Agent, continuing to bucket by provider would retain
   * several copies of old state that the real runtime will never update again, so the UI can easily
   * read a historical provider's ready/failed when switching between task / draft / remote
   * identity. Here the state is collapsed into a single source of truth per workspace, and the
   * provider argument is kept only as a compatibility input for older calls.
   */
  workspaceInit: WorkspaceInitState;
  /**
   * Short-lived runtime state for the draft state before a taskId exists; the state of an existing
   * task is derived from taskRuntimeByTaskId.
   */
  draftRuntime: DraftRuntimeState;
  /**
   * The agent draft session backing an unsent draft; it does not enter the task list and is
   * promoted to a real task on first send.
   */
  draftSessionId: string | null;
  /**
   * The draft runtime capability invalidation version; incremented when capabilities such as
   * plugins or Skills change. Legacy drafts are closed via draftSessionId, while protocol-v4 drafts
   * use this version to rebuild the pre-warmed session inside the pane.
   */
  draftRuntimeInvalidationVersion: number;
  composerTextInsertVersion: number;
  composerTextInsertRequest: ComposerTextInsertRequest | null;
  timelineBottomRequestVersion: number;
  timelineBottomRequest: TimelineBottomRequest | null;
  /**
   * Draft-state errors must be kept across page changes, otherwise the notice would be unmounted
   * together with the local state after navigating away and back
   */
  draftError: ZCodeUiError | null;
  /**
   * The requestId guarding model switching against concurrency; only the newest request may be
   * persisted
   */
  modelSwitchRequestId: string | null;
  /**
   * Whether a model switch is in progress (used to disable sending and for the toolbar loading
   * state)
   */
  modelSwitchPending: boolean;
  /** The stage of the model switch (used to differentiate the loading copy) */
  modelSwitchStage: ModelSwitchStage;
  /**
   * The runtime state of each task, so the task list and the status bar can read the real task
   * state
   */
  taskRuntimeByTaskId: Record<string, TaskRuntimeState>;
  /**
   * Each task's own ephemeral UI state, so the plan panel and the permission dialogs are not lost
   * after switching tasks
   */
  taskUiByTaskId: Record<string, TaskUiState>;
  taskConfigOptionsByTaskId: Record<string, ZCodeConfigOption[]>;
  taskConfigOptionsStatusByTaskId: Record<string, ConfigOptionsStatus>;
  /** A compatibility cache of task unread state; the real unread state is task meta.unreadAt */
  taskUnreadByTaskId: Record<string, boolean>;
  /**
   * Optimistic metadata for the task list, fixing the half-step-behind delay of the left list
   * before a new task is persisted
   */
  optimisticTaskListByTaskId: Record<string, ZCodeTaskMeta>;
  /**
   * The UI-only draft anchor after clicking New task in grouped mode; it does not enter the real
   * task index.
   */
  groupedDraftTask: GroupedDraftTaskState | null;
  /**
   * The entry point through which the user started the current draft; pre-warming does not change
   * the origin.
   */
  draftCreateSource: SessionCreateSource;
  /**
   * After first-send creation and before the grouped sqlite order lands, the real task inherits the
   * draft anchor's local position.
   */
  promotedGroupedDraftTaskByTaskId: Record<string, GroupedDraftTaskState>;
  /** The ZCode Agent provider selected in the current workspace */
  selectedProvider: ZCodeProvider;
  /** The selected key of the current model provider (native/custom/ghost) */
  selectedSupplierKey: string;
  /** Whether the current provider is in the ghost state */
  isGhostSupplier: boolean;
  /** The origin of the current ghost state */
  supplierMismatchReason: ModelSelectionGhostReason | null;
  /** The ZCode Agent configOptions (model, mode, thinking level, etc.) */
  configOptions: ZCodeConfigOption[] | null;
  /** The configOptions loading state */
  configOptionsStatus: ConfigOptionsStatus;
  /** The available slash commands */
  slashCommands: ZCodeSlashCommand[];
  /**
   * The task list version number, incremented on every task creation/deletion, driving the TaskList
   * refresh
   */
  taskListVersion: number;
  /** Caches the already-fetched task list, avoiding a flicker when a component remounts */
  taskListCache: ZCodeTaskMeta[] | null;
  /**
   * Incremented when a new draft is created, driving the input to focus itself after switching to
   * the draft state
   */
  draftFocusVersion: number;
}

export interface ZCodeSessionStoreState {
  /** Maintains chat-related UI state per workspace */
  workspaces: Record<string, WorkspaceZCodeUIState>;
  getWorkspaceState: (workspacePath: string, workspaceIdentity?: string) => WorkspaceZCodeUIState;

  setActiveTaskId: (workspacePath: string, id: string | null, workspaceIdentity?: string) => void;
  promoteGroupedDraftTask: (
    workspacePath: string,
    taskId: string,
    draft: GroupedDraftTaskState,
    workspaceIdentity?: string,
  ) => void;
  clearPromotedGroupedDraftTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => void;
  setDraftSessionId: (
    workspacePath: string,
    sessionId: string | null,
    workspaceIdentity?: string,
  ) => void;
  invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => void;
  requestComposerTextInsert: (
    workspacePath: string,
    text: string,
    workspaceIdentity?: string,
    mention?: ComposerMentionPrefill,
    mode?: "replace" | "prepend-if-missing",
  ) => number;
  clearComposerTextInsertRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  requestTimelineBottom: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => number;
  clearTimelineBottomRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  startDraft: (
    workspacePath: string,
    provider?: ZCodeProvider,
    workspaceIdentity?: string,
    options?: {
      groupedDraftPlacement?: GroupedDraftTaskPlacement;
      createSource?: SessionCreateSource;
    },
  ) => void;
  clearGroupedDraftTask: (workspacePath: string, workspaceIdentity?: string) => void;
  bindRuntimeProvider: (
    workspacePath: string,
    provider: ZCodeProvider,
    workspaceIdentity?: string,
  ) => void;
  setModelSelectionResolution: (
    workspacePath: string,
    resolution: Pick<
      ModelSelectionResolution,
      "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
    >,
    workspaceIdentity?: string,
  ) => void;
  setWorkspaceInitState: (
    workspacePath: string,
    status: ZCodeWorkspaceInitStatus,
    error?: string | null,
    workspaceIdentity?: string,
  ) => void;
  setWorkspaceInitAttempts: (
    workspacePath: string,
    attempts: number,
    workspaceIdentity?: string,
  ) => void;
  setTaskState: (
    workspacePath: string,
    status: ZCodeTaskRuntimeStatus,
    error?: string | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskRuntimeState: (
    workspacePath: string,
    taskId: string,
    status: ZCodeTaskRuntimeStatus,
    error?: string | null,
    workspaceIdentity?: string,
    provider?: ZCodeProvider,
  ) => void;
  setTaskUsage: (
    workspacePath: string,
    taskId: string,
    usage: TaskUsageState | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskContextWindow: (
    workspacePath: string,
    taskId: string,
    contextWindow: number | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskApiRetryStatus: (
    workspacePath: string,
    taskId: string,
    apiRetry: ZCodeApiRetryStatus | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskPermissionRequest: (
    workspacePath: string,
    taskId: string,
    request: ZCodePermissionRequest | null,
    workspaceIdentity?: string,
  ) => void;
  removeTaskPermissionRequest: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskElicitationRequest: (
    workspacePath: string,
    taskId: string,
    request: ZCodeElicitationRequest | null,
    workspaceIdentity?: string,
  ) => void;
  removeTaskElicitationRequest: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskElicitationFormDraft: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    draft: ElicitationFormDraft,
    workspaceIdentity?: string,
  ) => void;
  removeTaskElicitationFormDraft: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskError: (
    workspacePath: string,
    taskId: string,
    error: ZCodeUiError | null,
    workspaceIdentity?: string,
  ) => void;
  setDraftError: (
    workspacePath: string,
    error: ZCodeUiError | null,
    workspaceIdentity?: string,
  ) => void;
  startModelSwitch: (
    workspacePath: string,
    requestId: string,
    stage?: ModelSwitchStage,
    workspaceIdentity?: string,
    options?: { pending?: boolean },
  ) => void;
  updateModelSwitchStage: (
    workspacePath: string,
    requestId: string,
    stage: ModelSwitchStage,
    workspaceIdentity?: string,
  ) => void;
  finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => void;
  setTaskConfigOptions: (
    workspacePath: string,
    taskId: string,
    options: ZCodeConfigOption[],
    workspaceIdentity?: string,
    status?: ConfigOptionsStatus,
  ) => void;
  initializeBackgroundTaskRuntime: (
    workspacePath: string,
    params: {
      task: ZCodeTaskMeta;
      provider: ZCodeProvider;
      activeInputId: InputId;
      workspaceIdentity?: string;
    },
  ) => void;
  upsertOptimisticTaskListItem: (
    workspacePath: string,
    task: ZCodeTaskMeta,
    workspaceIdentity?: string,
  ) => void;
  removeOptimisticTaskListItem: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => void;
  /**
   * After a task is deleted, synchronously reclaim the selection and the optimistic state, so the
   * right side does not keep showing the deleted task
   */
  removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;

  setConfigOptions: (
    workspacePath: string,
    options: ZCodeConfigOption[],
    workspaceIdentity?: string,
  ) => void;
  setConfigOptionsStatus: (
    workspacePath: string,
    status: "idle" | "loading" | "ready" | "error",
    workspaceIdentity?: string,
  ) => void;
  setSlashCommands: (
    workspacePath: string,
    commands: ZCodeSlashCommand[],
    workspaceIdentity?: string,
  ) => void;
  setCurrentModeId: (
    workspacePath: string,
    modeId: string | null,
    workspaceIdentity?: string,
  ) => void;
  /**
   * Called when the task list changes (task creation/deletion), driving zcodeTaskMetaMerge to
   * re-fetch the list
   */
  bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => void;
  /** Updates the cache of the already-fetched task list */
  setTaskListCache: (
    workspacePath: string,
    tasks: ZCodeTaskMeta[],
    workspaceIdentity?: string,
  ) => void;
  /** Updates a task's unread indicator, controlling the blue dot on the left */
  setTaskUnreadIndicator: (
    workspacePath: string,
    taskId: string,
    hasUnread: boolean,
    workspaceIdentity?: string,
  ) => void;

  /** The workspace navigation history (global, across workspaces, including tasks and Automations) */
  taskNavHistory: TaskNavigationHistory;
  /** Records navigation to the Automations main view or a detail view. */
  taskNavPushAutomations: (
    workspacePath: string,
    workspaceIdentity?: string,
    automationId?: string,
    automationTab?: AutomationsNavigationTab,
  ) => void;
  /** Records navigation to the plugin market main view. */
  taskNavPushPluginStore: (workspacePath: string, workspaceIdentity?: string) => void;
  /** Go back, returning the target entry; null when already at the start */
  taskNavGoBack: () => WorkspaceNavEntry | null;
  /** Go forward, returning the target entry; null when already at the end */
  taskNavGoForward: () => WorkspaceNavEntry | null;
  /** Cleans up the corresponding task entry in the navigation history when a task is deleted */
  removeTaskFromNavHistory: (taskId: string) => void;
}

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

export const DEFAULT_WORKSPACE_INIT_STATE: WorkspaceInitState = {
  status: "idle",
  error: null,
  attempts: 0,
};

const FALLBACK_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;

export const DEFAULT_TASK_UI_STATE: TaskUiState = {
  permissionRequest: null,
  pendingPermissionRequests: [],
  elicitationRequest: null,
  pendingElicitationRequests: [],
  elicitationFormDraftsByRequestId: {},
  error: null,
};

export const DEFAULT_TASK_RUNTIME_STATE: TaskRuntimeState = {
  status: "notReady",
  error: null,
  provider: undefined,
  contextWindow: null,
  usage: null,
  apiRetry: null,
  backgroundTaskControls: [],
  activeTurnKind: undefined,
  activeInputId: undefined,
  activeInputOwnerClientId: undefined,
};

// ────────────────────────────────────────────
// Factory functions
// ────────────────────────────────────────────

export function createDefaultWorkspaceState(
  selectedProvider: ZCodeProvider,
): WorkspaceZCodeUIState {
  return {
    activeTaskId: null,
    workspaceInit: { ...DEFAULT_WORKSPACE_INIT_STATE },
    draftRuntime: { status: "idle", error: null },
    draftSessionId: null,
    draftRuntimeInvalidationVersion: 0,
    composerTextInsertVersion: 0,
    composerTextInsertRequest: null,
    timelineBottomRequestVersion: 0,
    timelineBottomRequest: null,
    draftError: null,
    modelSwitchRequestId: null,
    modelSwitchPending: false,
    modelSwitchStage: "idle",
    taskRuntimeByTaskId: {},
    taskUiByTaskId: {},
    taskConfigOptionsByTaskId: {},
    taskConfigOptionsStatusByTaskId: {},
    taskUnreadByTaskId: {},
    optimisticTaskListByTaskId: {},
    groupedDraftTask: null,
    draftCreateSource: "session",
    promotedGroupedDraftTaskByTaskId: {},
    selectedProvider,
    selectedSupplierKey: buildNativeSupplierKey(selectedProvider),
    isGhostSupplier: false,
    supplierMismatchReason: null,
    configOptions: null,
    configOptionsStatus: "idle",
    slashCommands: [],
    taskListVersion: 0,
    taskListCache: null,
    draftFocusVersion: 0,
  };
}

const DEFAULT_WORKSPACE_STATE = createDefaultWorkspaceState(FALLBACK_PROVIDER);

export function getDefaultWorkspaceState(): WorkspaceZCodeUIState {
  // After single ZCode Agent migration, the default provider must converge to glm.
  // Stable references are returned here to avoid continuous selector reads that are not written to the workspace bucket to produce different snapshots.
  return DEFAULT_WORKSPACE_STATE;
}
