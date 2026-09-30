import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelection, ZCodeModelOption } from "@zcode/shared";
import type {
  CollaborationMode,
  InputDelivery,
  ModelUsageSummary,
  McpServerStatus,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
  SessionEvent,
  SessionProjection,
  SupportedLocale,
  ToolResultDisplayPayload,
  UiThemeMode,
  UiThemePreference,
  TurnId,
  TurnSteerResult,
} from "@zcode/contracts";

export type TuiContextUsage = Pick<SessionProjection, "contextUsed" | "contextWindow">;

export type TuiSessionMetadata = Pick<
  TuiSubmitPromptResult,
  "locale" | "model" | "theme" | "thoughtLevel" | "modelOptions" | "effortOptions" | "loginRequired"
>;

export type TuiSwitchableMode = Extract<CollaborationMode, "plan" | "build" | "edit" | "yolo">;

export type TuiSetModeResult = {
  mode: CollaborationMode;
  response?: string;
};

export type TuiSetMode = (mode: TuiSwitchableMode) => Promise<TuiSetModeResult> | TuiSetModeResult;

export type TuiPromptAttachment = {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
};

export type TuiPromptInput =
  | string
  | {
      text: string;
      attachments?: TuiPromptAttachment[];
      /** Model picker commands retain the reference separately from their display text. */
      modelSelection?: ModelSelection;
    };

export type TuiImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type TuiClipboardImage = {
  dataUrl: string;
  mediaType: TuiImageMediaType;
  sizeBytes?: number;
};

export type TuiReadClipboardImage = (options?: {
  abortSignal?: AbortSignal;
}) => Promise<TuiClipboardImage | null>;

export type TuiWriteClipboardText = (text: string) => Promise<void> | void;

export type TuiWorkspacePathKind = "directory" | "file";

export type TuiWorkspacePathSuggestion = {
  kind: TuiWorkspacePathKind;
  path: string;
};

export type TuiWorkspacePathSuggestionResult = {
  items: readonly TuiWorkspacePathSuggestion[];
  truncated: boolean;
};

export type TuiListWorkspacePathSuggestions = (request: {
  abortSignal?: AbortSignal;
  limit?: number;
  token: string;
}) => Promise<TuiWorkspacePathSuggestionResult>;

export type TuiSelectionItem = {
  command: string;
  disabledReason?: string;
  id: string;
  input?: TuiSelectionInput;
  keywords?: readonly string[];
  meta?: string;
  pending?: TuiSelectionPending;
  primary: string;
  secondary?: string;
};

export type TuiSelectionInput = {
  cancelStatus?: string;
  clearStatus?: string;
  emptyStatus?: string;
  help?: string;
  mask?: boolean;
  placeholder?: string;
  primary: string;
  secondary?: string;
  status?: string;
  submitStatus?: string;
};

export type TuiSelectionPending = {
  cancelStatus?: string;
  help?: string;
  primary: string;
  secondary?: string;
  status?: string;
};

export type TuiSelection = {
  emptyMessage: string;
  filterable?: boolean;
  help?: string;
  items: TuiSelectionItem[];
  placement?: "action" | "composer";
  prompt: string;
  selectedIndex?: number;
  title: string;
};

export type TuiRestoredTranscriptPart =
  | {
      text: string;
      type: "text";
    }
  | {
      text: string;
      type: "thought";
    }
  | {
      error?: string;
      input: Record<string, unknown>;
      output?: string;
      resultDisplay?: ToolResultDisplayPayload;
      status: "pending" | "running" | "completed" | "failed";
      title?: string;
      toolCallId: string;
      toolName: string;
      type: "tool";
    };

export type TuiSubmitPromptResult = {
  effortOptions?: readonly TuiEffortOption[];
  modelOptions?: readonly TuiModelOption[];
  locale?: SupportedLocale;
  loginRequired?: boolean;
  mode?: CollaborationMode;
  model?: string;
  theme?: UiThemePreference;
  projection?: Partial<TuiContextUsage>;
  response: string;
  resetSessionProjection?: boolean;
  restoredMessages?: Array<{
    id?: string;
    content: string;
    parts?: TuiRestoredTranscriptPart[];
    role: "agent" | "system" | "user";
  }>;
  selection?: TuiSelection;
  sessionId?: string;
  thoughtLevel?: string;
  traceId?: string;
  turnId?: string;
  usage?: ModelUsageSummary;
};

export type TuiRequestPermission = (
  request: PermissionBrokerRequest,
  options?: PermissionBrokerRequestOptions,
) => Promise<PermissionBrokerResult>;

export type TuiSubmitPrompt = (
  prompt: TuiPromptInput,
  options: {
    abortSignal: AbortSignal;
    onEvent?: (event: SessionEvent) => void | Promise<void>;
    requestPermission?: TuiRequestPermission;
  },
) => Promise<TuiSubmitPromptResult>;

export type TuiSendInputResult =
  | {
      kind: "started_turn";
      result: TuiSubmitPromptResult;
    }
  | {
      kind: "command_result";
      result: TuiSubmitPromptResult;
    }
  | TurnSteerResult;

export type TuiSendInput = (
  input: TuiPromptInput,
  options: {
    abortSignal?: AbortSignal;
    delivery?: InputDelivery;
    expectedTurnId?: TurnId;
    onEvent?: (event: SessionEvent) => void | Promise<void>;
    requestPermission?: TuiRequestPermission;
  },
) => Promise<TuiSendInputResult>;

export type TuiRecallPreviousInput = (
  skip?: number,
) => Promise<{ attachments?: TuiPromptAttachment[]; text: string } | null>;

export type TuiCancelBackgroundTask = (taskId: string) => Promise<unknown>;

export type TuiReadSubagents = (input?: {
  endedCursor?: string;
  endedLimit?: number;
}) => Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;
export type TuiSubagentTranscriptSnapshot = {
  sessionId: string;
  sequenceNumber: number;
  messages: NonNullable<TuiSubmitPromptResult["restoredMessages"]>;
  events: SessionEvent[];
  replayMessageIds: string[];
};
export type TuiReadSubagentTranscript = (
  childSessionId: string,
) => Promise<TuiSubagentTranscriptSnapshot>;

/**
 * A session event subscription that lives across turns.
 *
 * Why not reuse the per-turn `onEvent` of `submitPrompt` / `sendInput`: dwf progress is an **out-of-turn event**
 * (empty turnId), and the per-turn sink dies at the end of the turn — which is exactly the structural reason the TUI
 * loses dwf events today. The same holds for the model turn driven by a background-completion notification (it is self-driven by the runtime command queue, and no per-turn sink is listening to it).
 *
 * Returns an unsubscribe; the CLI side re-attaches it on `replaceApp` (`/new` `/resume` `/fork`).
 */
export type TuiSubscribeSessionEvents = (sink: (event: SessionEvent) => void) => () => void;

/**
 * A session-level workflow run summary (`app.listDynamicWorkflowRuns`), used to backfill the mirror on cold start / resume.
 *
 * `label` / `updatedAt` are additive optional: older servers do not send these two keys, and the read side falls back
 * to the runId and shows no time. `resumable` is adjudicated by the server and is **never** re-derived in the TUI.
 */
export type TuiWorkflowRunSummary = {
  runId: string;
  toolCallId?: string;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
  label?: string;
  updatedAt?: number;
  resumable?: boolean;
};

export type TuiListWorkflowRuns = () => Promise<readonly TuiWorkflowRunSummary[]>;

/**
 * Cold replay of a workflow run: runs under this session that the mirror does not have yet are replayed from the
 * journal into progress event envelopes and fed one by one into the mirror's shared reducer — so after a restart /
 * `/resume` the card shows the real step count, usage and subagents instead of an empty 0/0 shell.
 */
export type TuiReplayWorkflowRuns = (input: {
  excludeRunIds: ReadonlySet<string>;
}) => Promise<readonly WorkflowRunProgressEnvelope[]>;

/**
 * The current **main session** id. It is a getter and not a value: `/new` `/resume` `/fork` switch sessions, and a
 * snapshotted id goes stale immediately and then makes the whole transcript be misjudged as foreign events.
 */
export type TuiGetMainSessionId = () => string | undefined;

export type TuiListMcpServers = () => Promise<Record<string, McpServerStatus>>;

export type TuiSlashCommandSuggestion = {
  aliases?: readonly string[];
  name: string;
  summary: string;
  usage: string;
};

export type TuiModelOption = ZCodeModelOption;

export type TuiEffortOption = {
  description?: string;
  id: string;
  label: string;
};

export type TuiModeOption = {
  description: string;
  id: TuiSwitchableMode;
  label: string;
};

export type TuiOptions = {
  /** Called after the startup screen has painted; runtime ownership stays in CLI. */
  loadStartupOptions?: () => Promise<TuiStartupOptions>;
  initialMode?: CollaborationMode;
  initialModel?: string;
  initialResult?: TuiSubmitPromptResult;
  initialThoughtLevel?: string;
  loginRequired?: boolean;
  locale?: SupportedLocale;
  theme?: UiThemePreference;
  initialThemeMode?: UiThemeMode;
  developerMode?: boolean;
  version?: string;
  workspaceDirectory?: string;
  workspaceGitBranch?: string;
  noColor: boolean;
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  cancelBackgroundTask?: TuiCancelBackgroundTask;
  readSubagents?: TuiReadSubagents;
  readSubagentTranscript?: TuiReadSubagentTranscript;
  listWorkspacePathSuggestions?: TuiListWorkspacePathSuggestions;
  listMcpServers?: TuiListMcpServers;
  listWorkflowRuns?: TuiListWorkflowRuns;
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  getMainSessionId?: TuiGetMainSessionId;
  readClipboardImage?: TuiReadClipboardImage;
  recallPreviousInput?: TuiRecallPreviousInput;
  sendInput?: TuiSendInput;
  setMode?: TuiSetMode;
  effortOptions?: readonly TuiEffortOption[];
  modelOptions?: readonly TuiModelOption[];
  listModelOptions?: () => Promise<readonly TuiModelOption[]>;
  slashCommands?: readonly TuiSlashCommandSuggestion[];
  submitPrompt: TuiSubmitPrompt;
  subscribeSessionEvents?: TuiSubscribeSessionEvents;
  subscribeThemeMode?: (listener: (mode: UiThemeMode) => void) => () => void;
  setTerminalBackgroundColor?: (color: string) => void;
  writeClipboardText?: TuiWriteClipboardText;
};

export type TuiStartupOptions = Pick<
  TuiOptions,
  | "initialMode"
  | "initialModel"
  | "initialThoughtLevel"
  | "loginRequired"
  | "locale"
  | "theme"
  | "modelOptions"
  | "effortOptions"
  | "slashCommands"
  | "workspaceGitBranch"
>;
