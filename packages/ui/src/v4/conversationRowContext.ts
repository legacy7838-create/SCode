// v4 line rendering context (host injection surface required for ai-elements / ToolCallBlocks fallback).
// Injection mode alignment PermissionDialog (store coupling stripping): the display component does not take its own store,
// theme/codePreviewSettings is taken from the host (SessionPane) and goes down to stabilize the props.
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunSettingsChange } from "@/components/workflow-timeline/workflowRunSettings.js";
import type { WorkflowDraftPosition, WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import type { Theme } from "@/useTheme.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type {
  CommandAck,
  ConversationRowTarget,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";

export type ConversationFileChangesState = Exclude<
  NonNullable<TurnHeaderRow["fileChanges"]>["state"],
  undefined
>;

export interface ConversationRowRenderContext {
  logEpoch?: string;
  workspacePath: string;
  /** The user Home of the current workspace Host, used to resolve ~/ paths in Assistant output. */
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  /** The SessionPane selects the View from the same model read from the target Host. */
  modelSelectionView?: ModelSelectionView | null;
  theme: Theme;
  /** The reference needs to be kept stable (memo dependency of MessageResponse/ToolCallBlock). */
  codePreviewSettings: CodePreviewSettings;
  /** The parent session bound to the current pane; the tab on the right side of the subagent uses it to group parent tasks. */
  sessionId?: string | null;
  /** The top-level session of the current drill-down tree; details tabs are grouped by this id across nesting levels. */
  rootSessionId?: string | null;
  /** @deprecated Old inline drill-down mark; new sub-session uniformly opens sidebar details. */
  inSubagentDrilldown?: boolean;
  /** Mobile /remote compact mode: Hide external apps and open the drop-down, leaving only in-app previews. */
  /** The current session is compacting or goal verifying; dedicated status UI exclusive progress feedback. */
  chatLoadingBlockedByActiveWork?: boolean;
  /** The current session is waiting for permission confirmation or AskUserQuestion answer, hide bottom ChatLoading. */
  chatLoadingBlockedByInteraction?: boolean;
  /** General setting: whether to render reasoning / thought lines in the conversation message flow. */
  messageStreamShowReasoning?: boolean;
  /** The first reasoning row of the current assistant's turn; still required when full thinking is turned off. */
  messageStreamFirstReasoningRowId?: number;
  /** General settings: Whether to render Todo tool cards in the conversation message flow. */
  messageStreamShowTodos?: boolean;
  /** General settings: Whether to aggregate consecutive Explore-compatible tools. */
  toolGroupingExploreEnabled?: boolean;
  /** General settings: Whether to aggregate consecutive non-read-only shell tools. */
  toolGroupingTerminalEnabled?: boolean;
  /** General settings: Whether to aggregate sequential file writing facilities. */
  toolGroupingChangesEnabled?: boolean;
  /**
   * Tier 1 fork jump: switch the current pane to the target session (forkNotice → parent session, reuse onSessionCreated
   * switch in place). rowId is reserved for Tier 2 precision scrolling - the current forkNotice.parentRowId is always 0 and is temporarily ignored.
   * Need to keep the reference stable (memo dependency of rowContext).
   */
  onNavigateToRow?: (sessionId: string, rowId: number) => void;
  /** Assistant Preview Cards: Website card preview entrance, side pane behavior injected by app shell. */
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  /** Assistant Preview Cards: Markdown/file card preview entry, which is injected into the code viewer behavior by the app shell. */
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /** Desktop completion state PPTX: multiple right-side Preview Tabs are created by shell atoms. */
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  /** After the current renderer observes running → completedSuccess, it locks to the specific turn. */
  assistantPreviewPptxAutoOpenTarget?: { turnId: string; key: string } | null;
  /** Assistant markdown local file link entry: the shell unifies the stat and then branches it to the preview or file tree. */
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenWorkflowRunSideTabRequest) => void;
  /**
   * Full size view tab entry for product.
   *
   * ⚠ Terminology: The artifact here is the output of the script published to the user through `artifact.*`, not the one inside the engine
   * Synonyms for "script top-level return value".
   *
   * Isomorphic to `onOpenWorkflowRun`: rows only send intents (which product of which run), session and workspace identity
   * Completed by the host. **Without version number** - The semantics of chip is "Let me see this product", and the target is always the latest version.
   */
  onOpenWorkflowArtifact?: (request: OpenWorkflowArtifactSideTabRequest) => void;
  /**
   * Cancel a background work (`cancelBackgroundWork{workId}`), bound by the host dispatchCommand + sessionId.
   *
   * The tail run card uses it to do "Stop run": run
   * `runId ≡ workId`, the same cancellation path as the details side panel/task list. The notification bank is in final state and is not needed.
   * Cancel the entry, so the ability is absent in the context; the run card is the first to render the stop button in the running state
   * Translate the row, so add this optional field. If the host (SessionPane) is not injected in a read-only session, the whole card will not be canceled.
   */
  onCancelBackgroundWork?: (workId: string) => void;
  /**
   * Resume of the tool card footer: the same as the details page
   * v4 `resumeWorkflowRun {workId ≡ runId}`. The host does not inject in a read-only session.
   */
  onResumeWorkflowRun?: (workId: string, name?: string) => void;
  /**
   * Run card "configuration": v4
   * `amendWorkflowRunSettings {workId ≡ runId, ...changed settings}`, return ACK to the pop-up layer to display the rejection reason. With Resume
   * Same two doors (read-only, grayscale): Absent means there is no Configure on the card.
   */
  onAmendWorkflowRunSettings?: (
    workId: string,
    change: WorkflowRunSettingsChange,
  ) => Promise<CommandAck>;
  /** The current model of the session (the name of the first item "Session Model" in the "Configuration" pop-up layer); if it cannot be read, it is absent. The first item only writes "Session Model". */
  workflowSessionModel?: { providerId: string; modelId: string };
  /**
   * The subagent pill on the tool card → the transcript tab of the subagent: the same opening path as the subagent row on the details page, and the host completes the workspace identity.
   */
  onOpenWorkflowActor?: (request: OpenWorkflowActorSessionSideTabRequest) => void;
  /**
   * Script pill on tools tab → script for this run transcript tab:
   * Open the same path as the script line on the spine of the details page, and the host completes the workspace identity.
   */
  onOpenWorkflowWorkspace?: (request: OpenWorkflowWorkspaceSideTabRequest) => void;
  /**
   * CreateWorkflow tool call → workflow run summary parsing table, built by the host from `workflowRuns` projection.
   *
   * The run identity must be projected rather than tool output: `workflowRunSchema.toolCallId` exists for this association
   * ("Tool card → associated key of details page"), and the output of the v4 tool line only has one sentence of prose,
   * `status` / `backgroundTaskId` These structured fields are discarded by formatModelContent.
   *
   * The value contains status and step number instead of just runId: when hit, the card enters the run state (a compact clickable card), and that card needs to be rendered.
   * Real-time status words and progress, join them once and calculate them (`workflowRunCardJoin.ts`).
   */
  workflowRunByToolCallId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  /**
   * Same-origin join table for runId key (`workflowRunCardJoin.buildWorkflowRunByRunId`). give
   * The tool usage of ResumeWorkflowRun: in the projection, run.toolCallId is used across resume**original
   * The CreateWorkflow line** (join is a deliberate semantic of continuous chaining), the resume line can never be found by toolCallId.
   * But its display load carries runId - connect to the same projection according to runId.
   */
  workflowRunByRunId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  /**
   * runId → The set of qid where the run is currently parked, established by the host from **live projection** (not mixed with the journal)
   * (`workflowRunCardJoin.buildWorkflowRunPendingQuestionsByRunId`). Workflow notification manifest
   * The upgrade entry is accordingly done Waiting→Answered flip: key is present ⟺ run in the live projection, the value contains qid = Waiting,
   * Does not contain = Answered, integer absent = run is not present (neutral Question).
   */
  workflowRunPendingQuestionsByRunId?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Initiate toolCallId → the static graph of the run (`workflowRunCardJoin.buildWorkflowGraphByToolCallId`), by the host
   * Create from the line window. The picture shows the properties of run: The run card at the end of the wheel is hung in the CreateWorkflow line, ResumeWorkflowRun line or
   * To start the wheel directly, press the toolCallId of run to get the image from this table.
   */
  workflowGraphByToolCallId?: ReadonlyMap<string, WorkflowCausalityGraphData>;
  /**
   * CreateWorkflow / AmendWorkflow row → draft position (draft number, whether it has been replaced), created by the host from the row window
   * (`workflowDraftJoin.buildWorkflowDraftByToolCallId`). Compile the feedback line to write the "nth draft" accordingly and decide on the empty ring light.
   * Color; cards not numbered in absence.
   */
  workflowDraftByToolCallId?: ReadonlyMap<string, WorkflowDraftPosition>;
  fetchFileChanges?: (
    target: ConversationRowTarget,
    options: ConversationFileChangesRequestOptions,
  ) => Promise<V4ConversationFileChangesResult>;
  previewFileRewind?: (
    target: ConversationRowTarget,
  ) => Promise<V4ConversationFileRewindPreviewResult>;
  applyFileRewind?: (target: ConversationRowTarget) => Promise<CommandAck>;
  /** Image/video preview sent; injected by workspace transport bound by pane. */
  readAttachment?: (
    params: ConversationAttachmentReadParams,
  ) => ReturnType<ConversationTransport["attachmentRead"]>;
  readAttachmentRange?: (
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ) => ReturnType<ConversationTransport["attachmentReadRange"]>;
}

export interface ConversationFileChangesRequestOptions {
  /**
   * The results of the running turn will still grow with the projection revision, and only ongoing requests can be reused;
   * The final state turn allows continued reuse of successful results after the virtual row is mounted again.
   */
  cachePolicy: "in-flight" | "terminal";
  /** rewind will switch active/reverted within the same logEpoch, and the final cache must be isolated according to this semantic state. */
  fileChangesState?: ConversationFileChangesState;
}

export type ConversationReasoningVisibility = Pick<
  ConversationRowRenderContext,
  "messageStreamShowReasoning" | "messageStreamFirstReasoningRowId"
>;

export function isConversationReasoningRowVisible(
  rowId: number,
  visibility: ConversationReasoningVisibility,
): boolean {
  return (
    visibility.messageStreamShowReasoning === true ||
    visibility.messageStreamFirstReasoningRowId === rowId
  );
}
