import { resolveSelectionSideInheritedModel } from "@/lib/selectionSideInheritedModel.js";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import type { SessionCreateSource } from "@zcode/shared";
import { reportSessionCreate } from "@/lib/sessionCreateTelemetry.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
/* oxlint-disable eslint(max-lines) -- SessionPane is the command-orchestration sink for the
 * single-pane vertical slice (the full set of subscribe/send/stop/fork/edit/retry/queue/slash), at
 * the same granularity as the legacy ChatView; HEAD is already over the limit (693 lines counted),
 * and splitting the command groups apart would break the closure discipline of
 * dispatchCommand/snapshotRef.
 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Hand } from "lucide-react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildCustomSupplierKey,
  TID_CHAT_EMPTY,
  TID_V4_SESSION_PANE,
  testId,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import type {
  ConversationShareAccessMode,
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  CommandType,
  ConversationSnapshot,
  ConversationRowTarget,
  SessionErrorInfo,
  SessionModelTransition,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import {
  getConversationShareErrorDetails,
  resolveConversationShareFallbackIssueCode,
  resolveConversationSharePublishErrorMessageId,
  sanitizeConversationShareWarnings,
} from "@/lib/conversationShareError.js";
import { localizeConversationShareUrl } from "@zcode/shared";
import type {
  ConversationShareAllowedArtifact,
  ConversationShareTurnPreflightResult,
  ImportedConversationShare,
} from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";
import { buildChatSessionScrollMemoryKey } from "@/lib/chatSessionScrollMemory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type { SessionOpenTrigger } from "@/lib/sessionOpenArmsTelemetry.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { resolveWorkflowResumeHandler } from "@/v4/workflowResumeGate.js";
import {
  workflowSessionModelOf,
  type WorkflowRunSettingsChange,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import { usePlanIdentitySnapshot } from "@/hooks/usePlanIdentitySnapshot.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useWorkspaceHomePath } from "@/hooks/useWorkspaceHomePath.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { captureComposerRecentSubmission } from "@/lib/composerRecent.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import {
  buildDraftCreateConfigPayload,
  useDraftConfigControl,
} from "@/v4/composer/useDraftConfigControl.js";
import type { ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import {
  createComposerSubmissionConfig,
  type ComposerSubmissionConfig,
} from "@/v4/composer/composerSubmissionConfig.js";
import { useDraftSessionPrewarm } from "@/v4/composer/useDraftSessionPrewarm.js";
import { projectSessionConfigToTaskConfigOptions } from "@/v4/composer/sessionConfigTaskCache.js";
import { useDraftRuntimeRebuildGate } from "@/v4/composer/useDraftRuntimeRebuildGate.js";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
  getConversationShareDockState,
  getConversationShareSelectedProductTurnIds,
  getConversationShareSelectedRowIds,
  useConversationShareSelectionStore,
  type ConversationShareDisplayWarnings,
} from "@/store/conversationShareSelectionStore.js";
import type { GroupedDraftTaskState } from "@/store/zcodeSessionStoreTypes.js";
import {
  ConversationComposer,
  type ComposerRestoreRequest,
  type ConversationComposerSendOptions,
  type ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { shouldIgnoreEscapeForStopGeneration } from "@/v4/composer/escapeStop.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { ConversationDraftSuggestedPromptsContainer } from "@/v4/ConversationDraftSuggestedPromptsContainer.js";
import { ConversationHeader, type PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { projectPendingGuideQueue } from "@/v4/pendingGuideProjection.js";
import { ConversationQuotaBanner } from "@/v4/ConversationQuotaBanner.js";
import { PendingCommandRecoveryBanner } from "@/v4/PendingCommandRecoveryBanner.js";
import { WorkspaceHookPendingBanner } from "@/v4/WorkspaceHookPendingBanner.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { SessionSubscriptionErrorPanel } from "@/v4/SessionSubscriptionErrorPanel.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { ConversationShareImportNotice } from "@/v4/ConversationShareImportNotice.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import { ConversationShareSuccessDock } from "@/v4/ConversationShareSuccessDock.js";
import {
  ConversationShareSelectionDock,
  type ConversationShareSelectionPreflightState,
} from "@/v4/ConversationShareSelectionDock.js";
import { ConversationShareSelectionPanel } from "@/v4/ConversationShareSelectionPanel.js";
import { ConversationShareSelectionReopenTab } from "@/v4/ConversationShareSelectionReopenTab.js";
import { ConversationShareSelectionScrim } from "@/v4/ConversationShareSelectionScrim.js";
import {
  buildConversationSharePreflightCacheEntries,
  conversationSharePreflightCacheKey,
  conversationShareTurnFingerprint,
  dedupeConversationShareIssues,
  getMissingConversationSharePreflightTurnIds,
} from "@/v4/conversationSharePreflightCache.js";
import { ConversationBottomDockTransition } from "@/v4/ConversationBottomDockTransition.js";
import { ensureConversationShareAttempt } from "@/v4/conversationShareAttempt.js";
import { useConversationShareSelectionOutsideDismiss } from "@/v4/useConversationShareSelectionOutsideDismiss.js";
import {
  resolveConversationSelectionTooltipEnabled,
  resolveConversationShareBackgroundScrollLocked,
  resolveConversationShareSelectionPanelVisible,
} from "@/v4/conversationShareModePolicy.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { buildConversationTurnNavigatorItems } from "@/v4/conversationTurnNavigatorHelpers.js";
import { SessionPluginReferenceIconBoundary } from "@/v4/SessionPluginReferenceIconProvider.js";
import {
  resolveConversationStatusPanelVariant,
  shouldUseConversationStatusPanelInlineLayout,
} from "@/v4/conversationLayout.js";
import {
  buildConversationStatusPanelModel,
  resolveSoleRunningWorkflowRunTarget,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import {
  buildWorkflowRunByRunId,
  buildWorkflowRunByToolCallId,
  buildWorkflowRunPendingQuestionsByRunId,
  buildWorkflowGraphByToolCallId,
} from "@/v4/workflowRunCardJoin.js";
import { buildWorkflowDraftByToolCallId } from "@/v4/workflowDraftJoin.js";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  countEndedWorkflowRuns,
  workflowRunDirectoryRefreshKey,
} from "@/v4/workflowRunDirectoryModel.js";
import {
  hasOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
} from "@/v4/conversationProjectionStore.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import {
  advanceAssistantPreviewPptxAutoOpenGate,
  createAssistantPreviewPptxAutoOpenGateState,
  resolveLatestCompletedAssistantPreviewTurn,
  type AssistantPreviewPptxAutoOpenTarget,
} from "@/v4/assistantPreviewPptxAutoOpen.js";
import {
  hasPluginReferenceUserRows,
  isSessionPluginCatalogReady,
} from "@/v4/pluginReferenceIconProjection.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { createConfigCommandBarrier } from "@/v4/configCommandBarrier.js";
import { recordV4CommandAck } from "@/v4/commandAckObservability.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import {
  useScopedConversationTelemetryForegroundEnabled,
  useScopedConversationTelemetrySupervisor,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { resolveSendAckSettlement } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { useSessionSubscriptionErrorTelemetry } from "@/v4/telemetry/useSessionSubscriptionErrorTelemetry.js";
import { useSessionOpenArmsTelemetry } from "@/v4/telemetry/useSessionOpenArmsTelemetry.js";
import {
  parseV4VisibleSlashCommand,
  parseSelectionSideSlashCommand,
  v4QueuedCommandText,
  type V4VisibleSlashCommand,
} from "@/v4/slashCommands.js";
import { useSlashCommands } from "@/hooks/useSlashCommands.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { usePendingCommandRecovery } from "@/v4/usePendingCommandRecovery.js";
import { useV4SessionQuotaBanner } from "@/v4/useV4SessionQuotaBanner.js";
import { resolveMcpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import { shouldFocusTimelineAfterComposerSend } from "@/v4/promptScrollFocusPolicy.js";
import {
  hasChatLoadingBlockingActiveWork,
  hasChatLoadingBlockingInteraction,
} from "@/v4/chatLoadingVisibility.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { isProviderNotReadyError } from "@/lib/chatPrepareError.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  SyncSubagentSessionTabsRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import {
  buildSelectionSideChatKey,
  clearSelectionSideChat,
  createSelectionSideChat,
  isSelectionSideChatBlocked,
  registerSelectionSideChatOpener,
  setSelectionSideChatBlocked,
  subscribeSelectionSideChatRuntime,
} from "@/lib/selectionSideChatRuntime.js";
import {
  normalizeSlashCommandValue,
  shouldOfferSideSlashCommand,
  type AppSlashCommand,
} from "@/slashCommandHelpers.js";
import {
  clearConversationSelectionReferenceScope,
  dispatchConversationSelectionAdd,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

export interface SessionPaneProps {
  paneId: string;
  sessionId: string | null;
  /**
   * Low-cardinality open entry point, provided by the pane host; the default exists only for legacy
   * calls.
   */
  openTrigger?: SessionOpenTrigger;
  rootSessionId?: string;
  /**
   * Observation views such as the subagent detail on the right: no composer/input is shown, and no
   * inline editing commands are sent.
   */
  readOnly?: boolean;
  /**
   * The explicit exception for observation views: restoring the workspace from a file summary is
   * allowed, but conversation editing capabilities stay closed.
   */
  allowWorkspaceFileRewind?: boolean;
  /**
   * A framed secondary screen: keeps the regular composer/tools, but hides and forbids
   * edit/retry/fork/goal.
   */
  selectionSideChat?: boolean;
  /**
   * Selection actions in the main conversation are delivered only to the auxiliary child currently
   * active in the Side Pane.
   */
  activeSelectionSideChatSessionId?: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /**
   * Prompt template telemetry currently covers Desktop only; Web / phone remote control keep the UI
   * behavior but do not fire that event.
   */
  isDesktop?: boolean;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  /**
   * deleteSession: after deleting the current conversation, go back to draft (the shell starts a
   * new draft).
   */
  onSessionDeleted?: () => void;
  /**
   * When the child of a hidden secondary screen no longer exists, the host removes the
   * corresponding tab.
   */
  onSelectionSideChatUnavailable?: () => void;
  /**
   * Focus layer: global shortcuts (Esc to stop) and add-to-chat events route only to the focused
   * pane. Single-pane consumers (V4ChatPane) default to true.
   */
  focused?: boolean;
  /**
   * Whether the pane is actually visible. A non-focused pane in a split still passes true; a hidden
   * sidebar tab mounted with forceMount passes false. It only affects foreground UI telemetry, not
   * live subscriptions or background /event/report.
   */
  telemetryVisible?: boolean;
  /**
   * Split a new draft pane to the right (the host does not dispatch this once the leaf count hits
   * the cap).
   */
  onSplitRight?: () => void;
  /** Split a new draft pane downward. */
  onSplitDown?: () => void;
  /**
   * Close this pane (dispatched only for non-primary panes; closing a pane ≠ stopping the session).
   */
  onClosePane?: () => void;
  /**
   * The ownership badge of a cross-workspace pane (dispatched when the pane's workspace ≠ the
   * shell's current workspace).
   */
  workspaceBadge?: PaneWorkspaceBadge;
  /**
   * The contextHeader above the composer in draft state (m5: workspace switcher menu + Git branch).
   * Constructed and dispatched by app-shell (it depends on shell-level capabilities such as
   * workspaceTabs and remote-connection callbacks); it is not dispatched for non-primary panes
   * (switching workspace is a shell-level action).
   */
  draftComposerHeader?: ReactNode;
  /**
   * The main draft hands its drop controller up to the app shell's title bar; other panes only
   * consume it on their own surface.
   */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
  onOpenSelectionSideChat?: (request: OpenSelectionSideChatRequest) => void;
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** Artifact chip on a notification row → the full-size view tab. */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  /**
   * Subagent pill on a tool card → the transcript tab; the same host handler as the subagent row on
   * the detail page.
   */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /**
   * Script pill on a tool card → the script transcript tab; the same host handler as the script row
   * on the detail page.
   */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}
function createSessionErrorKey(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): string {
  return [
    sessionId?.trim() || "draft",
    error.code,
    error.at,
    error.message,
    error.traceId ?? "",
    error.detail ?? "",
  ].join(":");
}

const EMPTY_SUBAGENT_PROJECTION: NonNullable<ConversationSnapshot["subagents"]> = {
  revision: 0,
  childSessionIds: [],
  running: [],
  endedTotal: 0,
};

const MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES = 20;

function toComposerUiError(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): ZCodeUiError {
  return {
    code: error.code,
    message: error.message,
    ...(error.traceId ? { traceId: error.traceId } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.underlyingErrorMessage
      ? { underlyingErrorMessage: error.underlyingErrorMessage }
      : {}),
    ...(error.underlyingErrorDetail ? { underlyingErrorDetail: error.underlyingErrorDetail } : {}),
    // V4 snapshot already carries security attribution; the attribution field is transparently transmitted here to ensure errors are clustered according to security attribution.
    ...(error.attribution ? { attribution: error.attribution } : {}),
    ...(sessionId ? { taskId: sessionId } : {}),
  };
}

function submissionConfigFromCommand(
  type: CommandType,
  payload: Record<string, unknown>,
): ComposerSubmissionConfig | null {
  const candidate =
    type === "createSession"
      ? (payload.firstInput as Record<string, unknown> | undefined)
      : type === "sendText" || type === "sendGoalCommand"
        ? payload
        : undefined;
  if (!candidate?.modelSelection || !candidate.mode) return null;
  return {
    modelSelection: candidate.modelSelection as ComposerSubmissionConfig["modelSelection"],
    mode: candidate.mode as ComposerSubmissionConfig["mode"],
    planEnabled:
      typeof candidate.planEnabled === "boolean"
        ? candidate.planEnabled
        : candidate.mode === "plan",
  };
}

function isConversationFileDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes(WORKSPACE_FILE_DRAG_MIME) ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}

interface QueuedComposerRestoreTarget {
  baseRevision: number;
  queueItemId: string;
  sourceCommandId: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: ComposerRestoreRequest["config"];
}

function resolveQueuedComposerRestore(
  snapshot: ConversationSnapshot,
  queueItemId: string,
): QueuedComposerRestoreTarget | null {
  const item = snapshot.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  if (!item || item.kind === "compact") return null;
  const config = {
    ...(item.mode ? { mode: item.mode } : {}),
    ...(typeof item.planEnabled === "boolean" ? { planEnabled: item.planEnabled } : {}),
    ...(item.modelSelection ? { modelSelection: item.modelSelection } : {}),
  };
  return {
    baseRevision: snapshot.revision,
    queueItemId,
    sourceCommandId: item.sourceCommandId,
    inputKind: item.kind,
    text: v4QueuedCommandText(item.kind, item.text),
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

function shouldRestoreQueuedComposerFromAck(status: CommandAck["status"]): boolean {
  return status === "accepted" || status === "duplicate";
}

/**
 * Single-pane vertical slice: subscribe → render rows → composer send / stop.
 *
 * React performance (vercel-react-best-practices):
 * - leaf components (Header/Timeline/QueuePanel/InputControls/Composer/GoalBanner) are all
 *   memoized;
 * - every callback uses useCallback and **does not depend on the fast-changing snapshot** — the
 *   snapshot and composer text are read through refs, so callbacks keep a stable identity during
 *   streaming deltas instead of pushing new functions into memoized children for no reason;
 * - the model forms' local input state is pushed down into the matching child components, so typing
 *   never disturbs the whole pane.
 */
export function SessionPane({
  paneId,
  sessionId,
  openTrigger,
  rootSessionId,
  readOnly = false,
  allowWorkspaceFileRewind = false,
  selectionSideChat = false,
  activeSelectionSideChatSessionId = null,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  isDesktop = false,
  provider,
  onSessionCreated,
  onSelectionSideChatUnavailable,
  focused = true,
  telemetryVisible = true,
  onSplitRight,
  onSplitDown,
  onClosePane,
  workspaceBadge,
  draftComposerHeader,
  onDropTargetControllerChange,
  gitSummary,
  gitDirtyFileCount,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  onRefreshGit,
  onOpenGitReview,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenCodeViewer,
  onAutoOpenAssistantPptx,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
  onOpenSubagentDirectory,
  onSyncSubagentSessionTabs,
  onOpenSelectionSideChat,
  onOpenPlanDetail,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  onOpenWorkflowRunDirectory,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
}: SessionPaneProps) {
  const {
    layer,
    sendCommand,
    attachmentPut,
    attachmentRead,
    attachmentReadRange,
    onRuntimeRestart,
    onRuntimeLifecycle,
    fileChanges,
    fileRewindPreview,
  } = useV4Conversation();
  const platform = useOptionalPlatform();
  const { conversationShareService, modelSelectionService, zcodeSessionService, zcodeTaskService } =
    useServices();
  const { intl } = useZCodeIntl();
  const slashCommands = useSlashCommands(workspacePath, workspaceIdentity);
  const baseWorkspaceServices = useBaseWorkspaceServices();
  const workspaceHomePath = useWorkspaceHomePath({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
  });
  // SessionPane is already located in the ServiceProvider of the target Workspace and directly subscribes to the Host Service;
  // No longer parse the workspace/remote route twice from the presentation component.
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundEnabled = useScopedConversationTelemetryForegroundEnabled({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundOwnerRef = useRef<object>({});
  useEffect(() => {
    if (
      !conversationTelemetry ||
      !conversationTelemetryForegroundEnabled ||
      !telemetryVisible ||
      !sessionId
    ) {
      return undefined;
    }
    return conversationTelemetry.attachForeground(
      conversationTelemetryForegroundOwnerRef.current,
      sessionId,
    );
  }, [conversationTelemetry, conversationTelemetryForegroundEnabled, sessionId, telemetryVisible]);
  const [lease, setLease] = useState<SessionLease | null>(null);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  const newlyCreatedSessionIdRef = useRef<string | null>(null);
  const shareDraft = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.drafts[sessionId] : undefined,
  );
  const shareDockState = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.dockStates[sessionId] : undefined,
  );
  const shareDock = shareDockState ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
  const shareTitle = shareDock.title ?? snapshot?.meta.title?.trim() ?? sessionId ?? "";
  const shareDisclosureAccepted = shareDock.disclosureAccepted;
  const sharePublishing = shareDock.publishing;
  const shareProgress = shareDock.progress;
  const shareCompletedArtifacts = shareDock.completedArtifacts;
  const shareTotalArtifacts = shareDock.totalArtifacts;
  const publishedShareUrl = shareDock.publishedShareUrl;
  const shareError = shareDock.error;
  const shareWarnings = shareDock.warnings;
  const shareActive = shareDraft?.scope === "partial";
  const shareInSelectionStage = shareActive && (shareDraft?.stage ?? "selection") === "selection";
  // The mask, selection panel, and background scroll lock must share the same ruling, otherwise the mask will remain after the panel is collapsed.
  const shareSelectionPanelVisible = resolveConversationShareSelectionPanelVisible({
    partialShareActive: shareActive,
    stage: shareDraft?.stage ?? "selection",
    view: shareDraft?.view,
  });
  const finishShare = useConversationShareSelectionStore((value) => value.finishSelection);
  const updateShareDockState = useConversationShareSelectionStore((value) => value.updateDockState);
  const goToShareConfiguration = useConversationShareSelectionStore(
    (value) => value.goToConfiguration,
  );
  const goToShareSelection = useConversationShareSelectionStore((value) => value.goToSelection);
  const syncAvailableTurns = useConversationShareSelectionStore(
    (value) => value.syncAvailableTurns,
  );
  const toggleShareRow = useConversationShareSelectionStore((value) => value.toggleRow);
  const deselectShareProductTurn = useConversationShareSelectionStore(
    (value) => value.deselectProductTurn,
  );
  const setAllShareRowsSelected = useConversationShareSelectionStore(
    (value) => value.setAllRowsSelected,
  );
  const setShareAccessMode = useConversationShareSelectionStore((value) => value.setAccessMode);
  const showShareTimeline = useConversationShareSelectionStore((value) => value.showTimeline);
  const showShareSelectionPanel = useConversationShareSelectionStore(
    (value) => value.showSelectionPanel,
  );
  const dismissShareSelectionPanel = useCallback(() => {
    if (sessionId) showShareTimeline(sessionId);
  }, [sessionId, showShareTimeline]);
  useConversationShareSelectionOutsideDismiss({
    enabled: shareSelectionPanelVisible,
    onDismiss: dismissShareSelectionPanel,
  });
  const shareRenderUnits = useMemo(
    () => buildConversationTurnRenderUnits(snapshot?.rows.window ?? []),
    [snapshot?.rows.window],
  );
  const shareItems = useMemo(
    () =>
      buildConversationTurnNavigatorItems(shareRenderUnits, {
        assistantEmptyPreview: intl.formatMessage({
          id: "chat.turnNavigator.emptyAssistant",
        }),
        assistantRunningPreview: intl.formatMessage({
          id: "chat.turnNavigator.runningAssistant",
        }),
        userFallbackPreview: intl.formatMessage({
          id: "chat.turnNavigator.userFallback",
        }),
      }),
    [intl, shareRenderUnits],
  );
  const eligibleShareItems = useMemo(
    () => shareItems.filter((item) => !item.isRunning),
    [shareItems],
  );
  const eligibleShareRowIds = useMemo(
    () => new Set(eligibleShareItems.map((item) => item.rowId)),
    [eligibleShareItems],
  );
  useEffect(() => {
    if (!sessionId || !shareActive) return;
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    syncAvailableTurns(
      sessionId,
      eligibleShareItems.flatMap((item) => {
        const productTurnId = rowsById.get(item.rowId)?.productTurnId;
        return productTurnId ? [{ rowId: item.rowId, productTurnId }] : [];
      }),
    );
  }, [eligibleShareItems, sessionId, shareActive, snapshot?.rows.window, syncAvailableTurns]);
  const selectedShareRowIds = useMemo(
    () =>
      new Set(
        sessionId
          ? getConversationShareSelectedRowIds(
              useConversationShareSelectionStore.getState(),
              sessionId,
            )
          : [],
      ),
    [sessionId, shareDraft],
  );
  const selectedShareProductTurnIds = useMemo(
    () =>
      sessionId
        ? getConversationShareSelectedProductTurnIds(
            useConversationShareSelectionStore.getState(),
            sessionId,
          )
        : [],
    [sessionId, shareDraft],
  );
  const sharePreflightMetaRef = useRef<{
    revision: number;
    logEpoch: string;
    capabilitiesFingerprint: string;
    supportedArtifactTypes: readonly ConversationShareAllowedArtifact[];
  }>({
    revision: 0,
    logEpoch: "",
    capabilitiesFingerprint: "",
    supportedArtifactTypes: [],
  });
  const [sharePreflightVersion, setSharePreflightVersion] = useState(0);
  const selectedShareTurnFingerprints = useMemo(
    () =>
      new Map(
        selectedShareProductTurnIds.map((productTurnId) => [
          productTurnId,
          conversationShareTurnFingerprint(
            snapshot?.rows.window ?? [],
            productTurnId,
            workspacePath,
            {
              workspaceKey: workspaceIdentity?.trim() || workspacePath,
              remoteSessionId: remoteSessionId ?? "",
              sessionId: sessionId ?? "",
              revision: snapshot?.revision,
              logEpoch: snapshot?.logEpoch,
              capabilitiesFingerprint: sharePreflightMetaRef.current.capabilitiesFingerprint,
            },
          ),
        ]),
      ),
    [
      remoteSessionId,
      selectedShareProductTurnIds,
      sessionId,
      sharePreflightVersion,
      snapshot?.logEpoch,
      snapshot?.revision,
      snapshot?.rows.window,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const eligibleShareProductTurnIds = useMemo(() => {
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    const seen = new Set<string>();
    return eligibleShareItems.flatMap((item) => {
      const productTurnId = rowsById.get(item.rowId)?.productTurnId;
      if (!productTurnId || seen.has(productTurnId)) return [];
      seen.add(productTurnId);
      return [productTurnId];
    });
  }, [eligibleShareItems, snapshot?.rows.window]);
  const sharePreflightCacheRef = useRef(new Map<string, ConversationShareTurnPreflightResult>());
  // If the transmission class fails, it will be cached as a blocking item by pressing turn. RPC cannot be triggered again just by changing the selection;
  // When retrying the token change, clear the cache and reinitiate to avoid a network jitter that may freeze the user in the selection phase.
  const [sharePreflightRetryToken, setSharePreflightRetryToken] = useState(0);
  const sharePreflightScopeKey = `${workspaceIdentity?.trim() || workspacePath}\u0000${remoteSessionId ?? ""}\u0000${sessionId ?? ""}`;
  const sharePreflightScopeKeyRef = useRef<string | null>(null);
  const sharePreflightCacheKey = useCallback(
    (productTurnId: string) =>
      conversationSharePreflightCacheKey(sharePreflightScopeKey, productTurnId),
    [sharePreflightScopeKey],
  );
  const retrySharePreflight = useCallback(() => {
    for (const productTurnId of selectedShareProductTurnIds) {
      sharePreflightCacheRef.current.delete(sharePreflightCacheKey(productTurnId));
    }
    setSharePreflightRetryToken((token) => token + 1);
    setSharePreflightVersion((version) => version + 1);
  }, [selectedShareProductTurnIds, sharePreflightCacheKey]);
  const shareHydratedSessionRef = useRef<string | null>(null);
  const sharePreflight = useMemo<ConversationShareSelectionPreflightState>(() => {
    if (!shareInSelectionStage || !sessionId) {
      return { status: "idle" };
    }
    if (selectedShareProductTurnIds.length === 0) {
      return { status: "idle" };
    }
    const entries = selectedShareProductTurnIds.map((productTurnId) => {
      const entry = sharePreflightCacheRef.current.get(sharePreflightCacheKey(productTurnId));
      return entry?.turnFingerprint === selectedShareTurnFingerprints.get(productTurnId)
        ? entry
        : undefined;
    });
    if (entries.some((entry) => entry === undefined)) {
      return { status: "checking" };
    }
    const resolvedEntries = entries.filter(
      (entry): entry is ConversationShareTurnPreflightResult => entry !== undefined,
    );
    return {
      status: "ready",
      ...sharePreflightMetaRef.current,
      blockingIssues: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.blockingIssues),
      ),
      skippableWarnings: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.skippableWarnings),
      ),
      deferredIssues: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.deferredIssues),
      ),
      turnResults: resolvedEntries,
    };
  }, [
    sessionId,
    selectedShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    shareInSelectionStage,
    sharePreflightVersion,
  ]);

  useEffect(() => {
    if (sharePreflightScopeKeyRef.current === sharePreflightScopeKey) return;
    sharePreflightScopeKeyRef.current = sharePreflightScopeKey;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sharePreflightScopeKey]);

  useEffect(() => {
    if (shareActive && sessionId) return;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sessionId, shareActive]);

  useEffect(() => {
    // Preflight results are cached by turn: select/cancel only reaggregates currently selected items, only first time join or turn fingerprint
    // Only changes trigger RPC; the release phase still uses independent authoritative stat/read/SHA verification, and the cache here cannot be regarded as the final fact.
    const requestScopeKey = sharePreflightScopeKey;
    if (!shareInSelectionStage || !sessionId || selectedShareProductTurnIds.length === 0) {
      return undefined;
    }
    const missingProductTurnIds = getMissingConversationSharePreflightTurnIds(
      sharePreflightScopeKey,
      selectedShareProductTurnIds,
      sharePreflightCacheRef.current,
      selectedShareTurnFingerprints,
    );
    if (missingProductTurnIds.length === 0) return undefined;
    const requestRows = snapshot?.rows.window ?? [];
    const timer = setTimeout(() => {
      void conversationShareService
        .preflight({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          selection: {
            kind: "productTurns",
            productTurnIds: missingProductTurnIds,
          },
        })
        .then(
          (result) => {
            if (!shareActive || requestScopeKey !== sharePreflightScopeKeyRef.current) return;
            sharePreflightMetaRef.current = {
              revision: result.revision,
              logEpoch: result.logEpoch,
              capabilitiesFingerprint: result.capabilitiesFingerprint,
              supportedArtifactTypes: result.supportedArtifactTypes,
            };
            // The host process under dev does not restart with services reconstruction, and the old host returns no results.
            // turnResults, direct .map will throw an exception and be reported as "server-side preflight failure" by the downstream catch.
            // The demolition logic for splitting entries is contained in the helper, see conversationSharePreflightCache.
            const resultTurnFingerprints = new Map(
              missingProductTurnIds.map((productTurnId) => [
                productTurnId,
                conversationShareTurnFingerprint(requestRows, productTurnId, workspacePath, {
                  workspaceKey: workspaceIdentity?.trim() || workspacePath,
                  remoteSessionId: remoteSessionId ?? "",
                  sessionId,
                  revision: result.revision,
                  logEpoch: result.logEpoch,
                  capabilitiesFingerprint: result.capabilitiesFingerprint,
                }),
              ]),
            );
            const entries = buildConversationSharePreflightCacheEntries(
              result,
              missingProductTurnIds,
              resultTurnFingerprints,
            );
            for (const entry of entries) {
              sharePreflightCacheRef.current.set(
                sharePreflightCacheKey(entry.productTurnId),
                entry,
              );
            }
            setSharePreflightVersion((version) => version + 1);
          },
          (error: unknown) => {
            // This is only used if the RPC/server actually fails; the rendering layer exception in the success callback is caught by the catch at the end.
            // No more pretending to be a pre-check conclusion. When issues are missing, they become unknown, and logs are the only location entry.
            const details = getConversationShareErrorDetails(error);
            logger.warn("[v4-share] conversation share preflight failed", {
              sessionId,
              turnCount: missingProductTurnIds.length,
              name: details.name,
              kind: details.kind,
              reasonCode: details.reasonCode,
              issueCount: details.issueCount ?? 0,
              message: error instanceof Error ? error.message : String(error),
            });
            if (!shareActive || requestScopeKey !== sharePreflightScopeKeyRef.current) return;
            const issues =
              details.issues && details.issues.length > 0
                ? details.issues
                : [
                    {
                      code: resolveConversationShareFallbackIssueCode(details),
                      scope: "transport" as const,
                    },
                  ];
            for (const productTurnId of missingProductTurnIds) {
              sharePreflightCacheRef.current.set(sharePreflightCacheKey(productTurnId), {
                productTurnId,
                turnFingerprint: selectedShareTurnFingerprints.get(productTurnId),
                blockingIssues: issues,
                skippableWarnings: [],
                deferredIssues: [],
              });
            }
            setSharePreflightVersion((version) => version + 1);
          },
        )
        .catch((error: unknown) => {
          // Exceptions in the rendering layer itself: only logs are recorded, not written into the preflight cache, to avoid showing front-end bugs as sharing failures again.
          logger.error(
            "[v4-share] unexpected error while handling the conversation share preflight result",
            {
              sessionId,
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
          );
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [
    conversationShareService,
    remoteSessionId,
    selectedShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    sharePreflightRetryToken,
    sharePreflightScopeKey,
    sessionId,
    shareActive,
    shareInSelectionStage,
    snapshot?.rows.window,
    workspaceIdentity,
    workspacePath,
  ]);
  const sessionLeaseReady = lease?.sessionId === sessionId;
  const shouldMeasureExistingSessionOpen =
    sessionLeaseReady && newlyCreatedSessionIdRef.current !== sessionId;
  useSessionOpenArmsTelemetry({
    sessionId,
    snapshot,
    openTiming: sessionLeaseReady ? state.openTiming : undefined,
    rendererTiming: sessionLeaseReady ? state.rendererTiming : undefined,
    openKind: sessionLeaseReady ? lease?.openKind : undefined,
    openTrigger,
    startedAt: sessionLeaseReady ? lease?.startedAt : undefined,
    status: state.status,
    lastError: state.lastError,
    enabled: shouldMeasureExistingSessionOpen,
    readOnly,
    reporter: platform,
  });
  useEffect(() => {
    const newlyCreatedSessionId = newlyCreatedSessionIdRef.current;
    if (newlyCreatedSessionId !== null && newlyCreatedSessionId !== sessionId) {
      newlyCreatedSessionIdRef.current = null;
    }
  }, [sessionId]);
  const mobilePlanInteractionReconcileTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  useEffect(() => {
    const timers = mobilePlanInteractionReconcileTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [lease, sessionId]);
  const pluginReferenceIconsEnabled =
    isSessionPluginCatalogReady(state.status, sessionId, snapshot?.sessionId) &&
    hasPluginReferenceUserRows(snapshot?.rows.window ?? []);
  // The final signal of send_result: user messages are truly drawn into the conversation history. z-code does not have optimistic rendering,
  // The bubble must wait for the projection to flow back out of the userInput row before it appears, so ACK accepted cannot be considered as sending.
  // Use useEffect instead of store to subscribe to the callback - the effect runs after the DOM commit, when the bubble is already on the screen.
  useEffect(() => {
    const rows = snapshot?.rows.window;
    if (!rows || rows.length === 0) return;
    // You cannot just take the last userInput: the background result line may be inserted to the end immediately after.
    // If you only look at the tail, the user's own entry will be missed and misjudged as render_timeout. supervisor side press
    // The table to be rendered is O(1) filtered, and the old rows pushed by historical backfill/cut session reload will not be accidentally triggered.
    for (const row of rows) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        conversationTelemetry?.notifyUserInputRendered(row.sourceCommandId);
      }
    }
  }, [conversationTelemetry, snapshot]);
  const fileChangesRequestCache = useMemo(
    () => new Map<string, Promise<V4ConversationFileChangesResult>>(),
    [fileChanges, sessionId, snapshot?.logEpoch],
  );
  const [dismissedErrorKeys, setDismissedErrorKeys] = useState<readonly string[]>([]);
  const [sendSubmissionError, setSendSubmissionError] = useState<ZCodeUiError | null>(null);
  const [paneLocalSummaryPanelVariantOverride, setPaneLocalSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  const [terminalSectionOpen, setTerminalSectionOpen] = useState(false);
  const [agentSectionOpen, setAgentSectionOpen] = useState(false);
  const [workflowSectionOpen, setWorkflowSectionOpen] = useState(false);
  const [dropTargetController, setDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const handleDropTargetControllerChange = useCallback(
    (controller: ConversationDropTargetController | null) => {
      setDropTargetController(controller);
      onDropTargetControllerChange?.(controller);
    },
    [onDropTargetControllerChange],
  );
  const readOnlyDropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: false,
      kind: null,
      onDragLeave: () => {},
      onDragOver: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      },
      onDrop: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [],
  );
  const effectiveDropTargetController = readOnly
    ? readOnlyDropTargetController
    : dropTargetController;

  // The latest value read by the stable callback is transparently transmitted through ref to prevent the callback from relying on snapshots/texts that change frequently.
  const snapshotRef = useRef<ConversationSnapshot | null>(snapshot);
  const autoOpenedAssistantPptxKeysRef = useRef<Set<string>>(new Set());
  const assistantPreviewPptxGateRef = useRef(createAssistantPreviewPptxAutoOpenGateState());
  const [assistantPreviewPptxAutoOpenTarget, setAssistantPreviewPptxAutoOpenTarget] =
    useState<AssistantPreviewPptxAutoOpenTarget | null>(null);
  const autoLoadIncompleteTurnCursorRef = useRef<string | null>(null);
  snapshotRef.current = snapshot;
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!onAutoOpenAssistantPptx || request.sources.length === 0) return;
      if (autoOpenedAssistantPptxKeysRef.current.has(request.key)) return;
      autoOpenedAssistantPptxKeysRef.current.add(request.key);
      onAutoOpenAssistantPptx(request);
    },
    [onAutoOpenAssistantPptx],
  );
  const composerDraftStateRef = useRef({ hasContent: false, busy: false });
  const [queueEditOperation, setQueueEditOperation] = useState<{
    queueItemId: string;
    sessionId: string;
    workspaceKey: string;
  } | null>(null);
  const queueEditOperationRef = useRef(queueEditOperation);
  queueEditOperationRef.current = queueEditOperation;
  const [composerRestoreRequest, setComposerRestoreRequest] =
    useState<ComposerRestoreRequest | null>(null);
  const nextComposerRestoreRequestIdRef = useRef(1);
  const timelineScrollToBottomRef = useRef<(() => void) | null>(null);
  const timelineScrollToQueryRef = useRef<
    ((target: { unitIndex: number; rowId: number }) => void) | null
  >(null);
  const conversationLayoutContainerRef = useRef<HTMLDivElement>(null);
  const hasExternalSummaryPanelVariantControl = Boolean(onSummaryPanelVariantOverrideChange);
  const effectiveSummaryPanelVariantOverride = hasExternalSummaryPanelVariantControl
    ? (summaryPanelVariantOverride ?? null)
    : paneLocalSummaryPanelVariantOverride;
  const handleSummaryPanelVariantChange = useCallback(
    (variant: ChatViewSummaryPanelVariant | null) => {
      if (onSummaryPanelVariantOverrideChange) {
        onSummaryPanelVariantOverrideChange(variant);
        return;
      }
      setPaneLocalSummaryPanelVariantOverride(variant);
    },
    [onSummaryPanelVariantOverrideChange],
  );

  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const workspaceConfigOptions = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).configOptions,
  );
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.sessionId !== sessionId ||
      !snapshot.config.provider.trim() ||
      !snapshot.config.model.trim() ||
      !workspaceConfigOptions?.length
    ) {
      return;
    }
    // Reason for the bug: V4 session configuration only exists ConversationSnapshot, and the legacy task configuration bucket is always empty;
    // When a user creates a new task from a custom model session, startDraft can only inherit the workspace default model.
    // Here only the authoritative configuration is stacked into the complete directory and cached by task, without changing the session or workspace fact source.
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(
        workspacePath,
        sessionId,
        projectSessionConfigToTaskConfigOptions(workspaceConfigOptions, snapshot.config),
        workspaceIdentity,
      );
  }, [
    sessionId,
    snapshot?.config.mode,
    snapshot?.config.model,
    snapshot?.config.provider,
    snapshot?.config.thought,
    snapshot?.sessionId,
    workspaceConfigOptions,
    workspaceIdentity,
    workspacePath,
  ]);
  useEffect(() => {
    const scopeKey = `${workspaceKey}\u0000${sessionId ?? "draft"}`;
    const enabled = Boolean(onAutoOpenAssistantPptx && focused && sessionId);
    const result = advanceAssistantPreviewPptxAutoOpenGate(assistantPreviewPptxGateRef.current, {
      enabled,
      scopeKey,
      logEpoch: snapshot?.logEpoch,
      phase: snapshot?.control.phase,
      completedTurn: resolveLatestCompletedAssistantPreviewTurn(snapshot?.rows.window ?? []),
    });
    assistantPreviewPptxGateRef.current = result.state;
    if (result.target !== undefined) {
      setAssistantPreviewPptxAutoOpenTarget(result.target);
    }
  }, [
    focused,
    onAutoOpenAssistantPptx,
    sessionId,
    snapshot?.control.phase,
    snapshot?.logEpoch,
    snapshot?.rows.window,
    workspaceKey,
  ]);
  useEffect(() => {
    // Prevent the old key from being used after switching workspace/session/logEpoch; the key itself has been isolated, and cleaning is only
    // Life cycle boundary to avoid Set growth with the number of sessions in long-term workbench.
    autoOpenedAssistantPptxKeysRef.current.clear();
  }, [sessionId, snapshot?.logEpoch, workspaceKey]);
  const composerTextInsertRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).composerTextInsertRequest,
  );
  const timelineBottomRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).timelineBottomRequest,
  );
  const draftRuntimeInvalidationVersion = useZCodeSessionStore(
    (store) =>
      store.getWorkspaceState(workspacePath, workspaceIdentity).draftRuntimeInvalidationVersion,
  );
  const handleExternalTextInsertApplied = useCallback(
    (requestId: number) => {
      useZCodeSessionStore
        .getState()
        .clearComposerTextInsertRequest(workspacePath, requestId, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );
  const composerBindingRef = useRef({ sessionId, workspaceKey });
  composerBindingRef.current = { sessionId, workspaceKey };
  const configCommandBarrier = useMemo(() => createConfigCommandBarrier(), []);
  // Soft auditing is not blocking interaction and cannot hide Composer or disable selection references.
  const blockingInteractionId =
    snapshot?.pendingInteractions.find(
      (interaction) => interaction.payload.kind !== "workspaceHookReview",
    )?.interactionId ?? null;
  const selectionSideChatKey = sessionId
    ? buildSelectionSideChatKey(workspaceKey, sessionId)
    : null;
  const selectionSideActionBlocked = useSyncExternalStore(
    subscribeSelectionSideChatRuntime,
    () =>
      activeSelectionSideChatSessionId
        ? isSelectionSideChatBlocked(activeSelectionSideChatSessionId)
        : false,
    () => false,
  );
  const timelineScrollMemoryKey = buildChatSessionScrollMemoryKey({
    workspacePath,
    workspaceIdentity,
    paneId,
    sessionId,
    taskId: null,
  });

  const {
    agentStartupAllowed: draftAgentStartupAllowed,
    error: draftModelReadinessError,
    dismissError: dismissDraftModelReadinessError,
    ensureReadyForSend: ensureDraftModelReadyForSend,
    markProviderNotReady: markDraftProviderNotReady,
  } = useDraftModelReadinessGate({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    modelSelectionService,
  });

  // Composer saves the renderer intent of the next Submission; the prewarm session only carries draft preheating.
  const {
    composerDraft,
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    replaceComposerDraft,
    updateComposerContent,
  } = useDraftConfigControl({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig: snapshot?.sessionId === sessionId ? snapshot.config : null,
    agentStartupAllowed: draftAgentStartupAllowed,
    modelSelectionService,
  });
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const draftModelSelectionRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (sessionId !== null) {
      draftModelSelectionRevisionRef.current = null;
      return;
    }
    const revision = modelSelectionView?.revision ?? null;
    const previousRevision = draftModelSelectionRevisionRef.current;
    draftModelSelectionRevisionRef.current = revision;
    if (
      revision === null ||
      previousRevision === null ||
      revision === previousRevision ||
      (draftConfigRef.current.provider && draftConfigRef.current.model)
    ) {
      return;
    }
    // Reason for the bug: During cold start, the normal Provider will let the draft warm up first, and then the Account Overlay will enter.
    // Selection View. The old warm-up session freezes the early fallback, even though the latest View already contains the current account connection,
    // The Renderer will also be permanently stuck on the old model. A draft that is not sent and has no explicit selection is not an execution fact; when the View updates
    // Recycled and rebuilt with the latest selection fact, explicit selections and formal sessions remain frozen.
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [draftConfigRef, modelSelectionView?.revision, sessionId, workspaceIdentity, workspacePath]);
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  const createSubmissionFromComposer = useCallback(
    () => createComposerSubmissionConfig(draftConfigRef.current, modelSelectionView),
    [draftConfigRef, modelSelectionView],
  );
  const composerSubmissionReady = useMemo(
    () => createComposerSubmissionConfig(draftConfig, modelSelectionView) !== null,
    [draftConfig, modelSelectionView],
  );
  const codingPlanUpgradeDialog = useOptionalCodingPlanUpgradeDialog();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const promoteGroupedDraftTask = useZCodeSessionStore((state) => state.promoteGroupedDraftTask);
  // The first commandId already exists when accepted, and is also the message_id of completion; there is no need to wait for the reply to be completed.
  const reportDraftCreated = useCallback(
    (createdSessionId: string, source: SessionCreateSource, messageId: string) => {
      void reportSessionCreate(platform, {
        sessionId: createdSessionId,
        messageId,
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        source,
        clientKind: isDesktop ? "desktop" : "web",
      });
    },
    [platform, workspacePath, workspaceIdentity, remoteSessionId, isDesktop],
  );
  const handleDraftSessionCreated = useCallback(
    (
      createdSessionId: string,
      groupedDraftTask: GroupedDraftTaskState | null | undefined,
      createSource?: SessionCreateSource,
      messageId?: string,
    ) => {
      if (messageId) {
        reportDraftCreated(
          createdSessionId,
          createSource ?? (groupedDraftTask ? "group" : "session"),
          messageId,
        );
      }
      // Root cause of the bug: When Session is opened, only existing Sessions are measured, but in the past when the draft was released, new/warm-up was improved.
      // sessionId is given directly to the same hook. The warm-up lease also retains the startedAt and empty snapshot timing of the draft period.
      // Thus, hours of idle time are mistakenly recorded as total/react. To create a boundary, first mark the first binding of this pane; after leaving
      // When the same Session is explicitly opened again, the mark will be cleared and normal measurement of existing Session openings will resume.
      newlyCreatedSessionIdRef.current = createdSessionId;
      promoteComposerDraft(createdSessionId);
      // Only the accepted boundary of draft create/promote can inherit grouped placement.
      // Fork and normal task navigation still reuse onSessionCreated, but it will not pollute the grouping order of existing tasks.
      if (groupedDraftTask) {
        promoteGroupedDraftTask(
          workspacePath,
          createdSessionId,
          groupedDraftTask,
          workspaceIdentity,
        );
        logger.debug("[v4-pane] grouped draft explicitly promoted", {
          createdSessionId,
          draftId: groupedDraftTask.draftId,
        });
      }
      onSessionCreated?.(createdSessionId);
    },
    [
      reportDraftCreated,
      onSessionCreated,
      promoteComposerDraft,
      promoteGroupedDraftTask,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const { settings: sharedSettings } = useSettings();
  const readPlanIdentitySnapshot = usePlanIdentitySnapshot(
    sharedSettings?.providerFamilyDomain,
    sharedSettings?.providerFamilyDomain
      ? sharedSettings.providerFamilyConnectionSelections?.[sharedSettings.providerFamilyDomain]
      : undefined,
    baseWorkspaceServices.usageStatsService,
  );
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const messageStreamShowReasoning = sharedSettings?.messageStreamShowReasoning ?? true;
  const messageStreamShowTodos = sharedSettings?.messageStreamShowTodos ?? false;
  const toolGroupingExploreEnabled = sharedSettings?.toolGroupingExploreEnabled ?? true;
  const toolGroupingTerminalEnabled = sharedSettings?.toolGroupingTerminalEnabled ?? true;
  const toolGroupingChangesEnabled = sharedSettings?.toolGroupingChangesEnabled ?? false;
  const snapshotSessionId = snapshot?.sessionId ?? null;
  const snapshotFollowupMode = snapshot?.config.followupMode ?? null;
  const snapshotRevision = snapshot?.revision ?? null;

  // Injection mode alignment PermissionDialog: theme/codePreviewSettings gets the store in the host,
  // The stable referenced rowContext is sent to the memo row component (MessageResponse/ToolCallBlocks).
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // Tier 1 fork jump: click the forkNotice of the child session → cut the current pane to the parent session in place and reuse the fork
  // The same model is implemented onSessionCreated (primary→setActiveTaskId, split screen→bindPaneSession). rowId reserved
  // Tier 2 precise scrolling - the current forkNotice.parentRowId is always a 0 placeholder and is ignored here.
  const handleNavigateToRow = useCallback(
    (targetSessionId: string, _rowId: number) => {
      if (!targetSessionId || targetSessionId === sessionId) {
        return;
      }
      onSessionCreated?.(targetSessionId);
    },
    [onSessionCreated, sessionId],
  );
  const dispatchCommand = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      targetSessionId: string | null,
      baseRevision?: number,
      baseLogEpoch?: string,
      telemetrySeed?: ConversationPromptTelemetrySeed,
      onEnvelopeCreated?: (envelope: CommandEnvelope) => void,
      sessionCreateSource?: SessionCreateSource,
    ): Promise<CommandAck> => {
      const submission = submissionConfigFromCommand(type, payload);
      const acceptRecent = submission
        ? captureComposerRecentSubmission(workspacePath, submission, workspaceIdentity)
        : undefined;
      const acceptSelection =
        submission && (sessionId === null || targetSessionId === sessionId)
          ? captureAcceptedModelSelection(submission.modelSelection)
          : undefined;
      const envelope = createCommandEnvelope({
        type,
        sessionId: targetSessionId,
        payload: payload as never,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        ...(baseLogEpoch ? { baseLogEpoch } : {}),
      });
      onEnvelopeCreated?.(envelope);
      // It must be earlier than the first upstream: there are still clues that can be queried after transport error/renderer refresh.
      const groupedDraftTask =
        type === "createSession"
          ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .groupedDraftTask
          : null;
      pendingCommandRegistry.record(
        envelope,
        type === "createSession"
          ? {
              workspace: {
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
              },
              ...(groupedDraftTask ? { groupedDraftTask } : {}),
              sessionCreateSource:
                sessionCreateSource ??
                useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                  .draftCreateSource,
            }
          : undefined,
      );
      if (lease?.store && type !== "createSession") {
        lease.store.markCommandPending({
          commandId: envelope.commandId,
          type: envelope.type,
          issuedAt: envelope.issuedAt,
        });
      }
      let ack: CommandAck;
      try {
        if (telemetrySeed?.localTtft && !workspaceIdentity?.trim()) {
          envelope.ttft = getLocalTtftObserver()?.dispatch(
            telemetrySeed.localTtft,
            workspacePath,
            envelope.commandId,
            targetSessionId,
          );
        }
        ack = await sendCommand(envelope);
        if (telemetrySeed?.localTtft && ack.reasonCode === "guard.heldQueueConfirmationStale")
          getLocalTtftObserver()?.confirmationRetry(telemetrySeed.localTtft);
        else if (telemetrySeed?.localTtft)
          getLocalTtftObserver()?.ack(telemetrySeed.localTtft, ack.status, ack.ttftExcluded);
      } catch (error) {
        if (telemetrySeed?.localTtft)
          getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
        if (lease?.store) {
          lease.store.settleCommand(envelope.commandId);
        }
        if (isProviderNotReadyError(error)) {
          // provider_not_ready deterministically rejects before Host getClient, CLI may not have
          // admission. If you continue to retain the renderer to restore the ledger, the reconnect query will inevitably get unknown; even if
          // unknown is now silently cleared and should not leave invalid recovery records for deterministic rejections.
          pendingCommandRegistry.settle(envelope.sessionId, envelope.commandId);
        }
        recordV4CommandAck({
          type,
          status: "transport-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        // The sending funnel is settled: telemetrySeed is carried only when sent by real users, two-step createSession
        // There is no seed with background tasks, so send_result will not be forged naturally.
        if (telemetrySeed) {
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: targetSessionId,
            commandId: envelope.commandId,
            status: "fail",
            reasonCode: isProviderNotReadyError(error) ? "provider_not_ready" : "transport_error",
          });
        }
        throw error;
      }
      pendingCommandRegistry.applyAck(envelope, ack);
      if (ack.status === "accepted") {
        acceptSelection?.();
        acceptRecent?.();
      }
      if (
        lease?.store &&
        type === "sendText" &&
        (ack.status === "accepted" || ack.status === "duplicate")
      ) {
        // ACK only represents CLI admission; if your conversation topic is subsequently silenced, store watchdog
        // The same owned subscription will be reused to restore the authoritative row/queue after the grace period, and the command will not be replayed.
        lease.store.expectAcceptedInputProjection(envelope.commandId);
      }
      if (ack.status === "accepted" && telemetrySeed) {
        const acceptedSessionId =
          ack.result?.type === "createSelectionSideSession"
            ? ack.result.sessionId
            : (targetSessionId ??
              (ack.result?.type === "createSession" ? ack.result.sessionId : null));
        if (acceptedSessionId) {
          conversationTelemetry?.acceptPromptSeed({
            ...telemetrySeed,
            sessionId: acceptedSessionId,
            sourceCommandId: envelope.commandId,
          });
        }
      }
      if (telemetrySeed) {
        // The ACK of the second confirmation of the queue returns null (non-final state), and the settlement will allow first-wins to eat the real result.
        const outcome = resolveSendAckSettlement(ack);
        if (outcome) {
          const settledSessionId =
            ack.result?.type === "createSelectionSideSession"
              ? ack.result.sessionId
              : (targetSessionId ??
                (ack.result?.type === "createSession" ? ack.result.sessionId : null));
          if (outcome.kind === "awaitRender") {
            // ACK only means that the Host has accepted the command, and the user bubble has not been drawn yet;
            // It takes time to wait for the projection to flow back out of the userInput row (or 30s timeout) before settling on the end-to-end result.
            conversationTelemetry?.awaitSendRender({
              seed: telemetrySeed,
              sessionId: settledSessionId,
              commandId: envelope.commandId,
              ackStatus: outcome.ackStatus,
            });
          } else {
            conversationTelemetry?.settleSendResult({
              seed: telemetrySeed,
              sessionId: settledSessionId,
              commandId: envelope.commandId,
              status: outcome.status,
              ackStatus: outcome.ackStatus,
              reasonCode: outcome.reasonCode,
            });
          }
        }
      }
      // Production build renderer logs are turned off and ack summaries are written to the bounded debug buffer for e2e/live probes.
      recordV4CommandAck({
        type,
        status: ack.status,
        ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
        revisionAtDecision: ack.revisionAtDecision,
        at: Date.now(),
      });
      if (shouldResyncForStaleAuthority(ack)) {
        // When the epoch/entity authority has changed, only optimistic overlay will be cleared and the old one will still be used.
        // target sends the command; after unifying same-sub recovery, the decision can be made based on the rowId/entityId of the same generation.
        lease?.store?.recoverFromStaleAuthority();
      }
      // If it is not settled when rejected/stale/failed, optimistic overlay will remain permanently.
      if (
        lease?.store &&
        type !== "createSession" &&
        ack.status !== "accepted" &&
        ack.status !== "duplicate"
      ) {
        lease.store.settleCommand(envelope.commandId);
      }
      return ack;
    },
    [
      captureAcceptedModelSelection,
      conversationTelemetry,
      lease,
      provider,
      sendCommand,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleFetchFileChanges = useCallback(
    (target: ConversationRowTarget, options: ConversationFileChangesRequestOptions) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          files: 0,
          additions: 0,
          deletions: 0,
          items: [],
        });
      }
      const cacheKey = JSON.stringify([
        options.cachePolicy,
        sessionId,
        current.logEpoch,
        // rewind will switch active to reverted under the same logEpoch, row/entity;
        // The final state cache must carry this semantic version and cannot continue to reuse the complete diff before undoing it.
        options.cachePolicy === "in-flight"
          ? current.revision
          : (options.fileChangesState ?? "unknown"),
        target.rowId,
        target.entityId,
      ]);
      const cachedRequest = fileChangesRequestCache.get(cacheKey);
      if (cachedRequest) {
        fileChangesRequestCache.delete(cacheKey);
        fileChangesRequestCache.set(cacheKey, cachedRequest);
        return cachedRequest;
      }

      // Uninstalling the virtual row will lose the in-row state. After remounting, the preview card will be repeatedly pulled including the complete
      // patch's fileChanges; the cache must be placed in the SessionPane to share the same request with the file changes panel.
      let request: Promise<V4ConversationFileChangesResult>;
      request = fileChanges({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).then(
        (result) => {
          // The result of a successful run may still be only a local diff of the current revision; only shared
          // In-flight Promise, delete it after settled to avoid reusing early results in the final card.
          if (
            options.cachePolicy === "in-flight" &&
            fileChangesRequestCache.get(cacheKey) === request
          ) {
            fileChangesRequestCache.delete(cacheKey);
          }
          return result;
        },
        (error: unknown) => {
          // Failure cannot contaminate subsequent retries; only the current Promise is deleted to avoid old requests accidentally deleting new requests with the same key.
          if (fileChangesRequestCache.get(cacheKey) === request) {
            fileChangesRequestCache.delete(cacheKey);
          }
          if (shouldResyncForStaleAuthority(error)) {
            lease?.store?.recoverFromStaleAuthority();
          }
          throw error;
        },
      );
      fileChangesRequestCache.set(cacheKey, request);
      while (fileChangesRequestCache.size > MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES) {
        const oldestKey = fileChangesRequestCache.keys().next().value;
        if (oldestKey === undefined) break;
        fileChangesRequestCache.delete(oldestKey);
      }
      return request;
    },
    [fileChanges, fileChangesRequestCache, lease, sessionId],
  );

  const handlePreviewFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          canApply: false,
          safeFiles: [],
          unsafeFiles: [],
          ignoredFiles: [],
        });
      }
      return fileRewindPreview({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).catch((error: unknown) => {
        if (shouldResyncForStaleAuthority(error)) {
          lease?.store?.recoverFromStaleAuthority();
        }
        throw error;
      });
    },
    [fileRewindPreview, lease, sessionId],
  );

  const handleApplyFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        throw new Error("Cannot apply file rewind without an active session revision");
      }
      return dispatchCommand(
        "applyFileRewind",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleOpenSubagentSession = useCallback(
    (request: OpenSubagentSideTabRequest) => {
      onOpenSubagentSession?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenSubagentSession, remoteSessionId, rootSessionId, workspaceIdentity, workspacePath],
  );
  const handleOpenSubagentDirectory = useCallback(
    (request: import("@/lib/workspaceSidePane.js").OpenSubagentDirectorySideTabRequest) => {
      onOpenSubagentDirectory?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenSubagentDirectory, remoteSessionId, rootSessionId, workspaceIdentity, workspacePath],
  );
  const handleOpenPlanDetail = useCallback(
    (request: OpenPlanDetailSideTabRequest) => {
      onOpenPlanDetail?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenPlanDetail, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Completely isomorphic with plan-detail: the card only sends the intention (runId + toolCallId + display name),
  // The session and workspace identities are all completed by the host (here), and the card is not scope-aware.
  const handleOpenWorkflowRun = useCallback(
    (request: OpenWorkflowRunSideTabRequest) => {
      onOpenWorkflowRun?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRun, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Pill → subagent transcript: Isomorphic to plan-detail / workflow-run, the card only hands over the instance identity, and the scope is filled in here.
  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenWorkflowActorSessionSideTabRequest) => {
      onOpenWorkflowActorSession?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowActorSession, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Script pill isomorphism: card handover run + initiating line + phase, scope is made up here.
  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenWorkflowWorkspaceSideTabRequest) => {
      onOpenWorkflowWorkspace?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowWorkspace, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // The product chip and run details are isomorphic: the card/notification row only sends the intention, and the scope is completed from here.
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenWorkflowArtifactSideTabRequest) => {
      onOpenWorkflowArtifact?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowArtifact, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Tool card → association table of workflow run. The authoritative source is the toolCallId of each run in the workflowRuns projection.
  // (The schema comment says that it is the "association key of the tool card → details page"); the tool line's own output is under v4
  // Only the prose picked out by formatCreateWorkflowModelContent is left, and the structured fields cannot be obtained.
  //
  // The value is not just runId: the run state card itself needs to render the status word and step number, so the summary is completed once the connection is made.
  // (See buildWorkflowRunByToolCallId for counting rules and its single-test exhaustive settled / observed semantics).
  // The projection is no longer empty after restarting: CLI cold materialization replays the journal into the same reducer,
  // Card join read-only projection, no longer merges discovery queries. Discovery query has only one purpose left here——
  //
  // `limit` and `refreshKey` serve the "Ended Workflow·N" footer line of the task list:
  // - The depth takes the same constant as the run directory page, otherwise the count of footer rows and the rows on the page will be two sets of calibers;
  // - The trigger takes the same derived function (run number + settled number), so the footer row has the same freshness as the directory page it opens;
  //   `revision` followed by projection will turn a paged read into a stream that follows node events.
  const workflowRunJournalSummaries = useWorkflowRunJournalSummaries({
    sessionId,
    // Bug root cause (tested on 2026-08-24): Nested read-only transcript (dwf actor/subagent) is also a SessionPane,
    // Sending this query without distinction is equivalent to using the child session id to ask a journal that is keyed by **parent session**; CLI's cold session prefix
    // Then materialize a second runtime (ghost) for the running detached actor session, double-write the event log,
    // The live broadcast freezes at "Worked for xx seconds". The read-only pane does not consume the join fallback and task list footer, and is turned off directly.
    enabled: !readOnly,
    live: state.status === "live",
    limit: WORKFLOW_RUN_DIRECTORY_LIMIT,
    refreshKey: workflowRunDirectoryRefreshKey(snapshot?.workflowRuns?.runs),
  });
  const endedWorkflowRunCount = useMemo(
    () => countEndedWorkflowRuns(workflowRunJournalSummaries),
    [workflowRunJournalSummaries],
  );
  const workflowRunByToolCallId = useMemo(
    () => buildWorkflowRunByToolCallId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // The same source table of the runId key: the connection entry of the ResumeWorkflowRun tool line (display with runId, projected
  // toolCallId follows the original CreateWorkflow line across resume, and the resume line cannot be found by toolCallId).
  const workflowRunByRunId = useMemo(
    () => buildWorkflowRunByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // Initiate toolCallId → static diagram: the diagram is an attribute of run,
  // The tail run cards from the three sources are all drawn from this table. The row window is built in one pass and rebuilt along with the window.
  const workflowGraphByToolCallId = useMemo(
    () => buildWorkflowGraphByToolCallId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // Workflow toolbar → Draft location: draft number and
  // "There will be an updated draft later" can only be read in line order. The line window is built in one pass and reconstructed along with the window.
  const workflowDraftByToolCallId = useMemo(
    () => buildWorkflowDraftByToolCallId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // Workflow notifies the upgrade entry of the manifest Waiting→Answered query table (runId → parked qid collection).
  const workflowRunPendingQuestionsByRunId = useMemo(
    () => buildWorkflowRunPendingQuestionsByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // Details page entry (row in the Workflows section of the panel). OK, just hand over "which run to open" (runId + toolCallId),
  // The identity of the session and workspace is still completed here - it uses the same handler as the tool card, and there is no second opening path.
  const handleOpenWorkflowRunFromPanel = useCallback(
    (target: ConversationStatusPanelWorkflowRunTarget) => {
      if (!sessionId) return;
      handleOpenWorkflowRun({ ...target, parentSessionId: sessionId });
    },
    [handleOpenWorkflowRun, sessionId],
  );
  // Run entry to the directory page (same footer line). Also only add scope, don't create an extra open path here.
  const handleOpenWorkflowRunDirectoryFromPanel = useCallback(
    (request: OpenWorkflowRunDirectorySideTabRequest) => {
      onOpenWorkflowRunDirectory?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRunDirectory, remoteSessionId, workspaceIdentity, workspacePath],
  );
  const handleAddSelectionToCurrentTask = useCallback(
    (reference: ConversationSelectionReference) => {
      if (!sessionId) return;
      dispatchConversationSelectionAdd({
        targetSessionId: sessionId,
        workspaceKey,
        reference,
      });
    },
    [sessionId, workspaceKey],
  );
  const handleOpenSelectionSideConversation = useCallback(
    async (reference?: ConversationSelectionReference, forceNew = false) => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) return;
      try {
        let targetChildSessionId = reference && !forceNew ? activeSelectionSideChatSessionId : null;
        let replacesChildSessionId: string | undefined;
        if (targetChildSessionId) {
          try {
            await zcodeSessionService.readSession({
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              sessionId: targetChildSessionId,
              messageLimit: 1,
            });
          } catch (error) {
            if (!String(error).includes("sessionNotFound")) throw error;
            // After multiple openings, the tab id contains child. The old singleton implementation relies on the new child to cover the same parent tab.
            // to remove invalid items is no longer valid. ReplacesChildSessionId is explicitly carried here, allowing the host to atomically delete the old one and create a new one.
            replacesChildSessionId = targetChildSessionId;
            clearSelectionSideChat(targetChildSessionId);
            clearConversationSelectionReferenceScope(targetChildSessionId, workspaceKey);
            targetChildSessionId = null;
          }
        }

        if (targetChildSessionId) {
          onOpenSelectionSideChat({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(remoteSessionId ? { remoteSessionId } : {}),
            parentSessionId: sessionId,
            childSessionId: targetChildSessionId,
          });
          if (reference) {
            dispatchConversationSelectionAdd({
              targetSessionId: targetChildSessionId,
              workspaceKey,
              reference,
            });
          }
          return;
        }

        const childSessionId = await createSelectionSideChat(selectionSideChatKey, async () => {
          const ack = await dispatchCommand("createSelectionSideSession", {}, sessionId);
          if (
            (ack.status !== "accepted" && ack.status !== "duplicate") ||
            ack.result?.type !== "createSelectionSideSession"
          ) {
            throw new Error(ack.reasonCode ?? "createSelectionSideSession was rejected");
          }
          return ack.result.sessionId;
        });
        onOpenSelectionSideChat({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          parentSessionId: sessionId,
          childSessionId,
          ...(replacesChildSessionId ? { replacesChildSessionId } : {}),
        });
        if (reference) {
          dispatchConversationSelectionAdd({
            targetSessionId: childSessionId,
            workspaceKey,
            reference,
          });
        }
      } catch (error) {
        logger.warn("[v4-pane] failed to create the selection side session", {
          error: error instanceof Error ? error.message : String(error),
          parentSessionId: sessionId,
          workspaceKey,
        });
      }
    },
    [
      activeSelectionSideChatSessionId,
      dispatchCommand,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
      zcodeSessionService,
    ],
  );

  const handleOpenSelectionSideConversationWithPrompt = useCallback(
    async (text: string, telemetrySeed?: ConversationPromptTelemetrySeed): Promise<boolean> => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) {
        throw new Error("selection side chat is unavailable");
      }
      const inherited = resolveSelectionSideInheritedModel(
        snapshotRef.current?.config,
        modelSelectionView,
      );
      const chosen = inherited ? await recommendStartPlan(inherited) : undefined;
      if (chosen === null) return false;
      const modelSelection = chosen && chosen !== inherited ? chosen : undefined;
      // The parameter command is a new child every time; the same text will still be reused pending when the ACK is not returned.
      // Different text cannot be combined with bare `/side` or another prompt.
      const pendingKey = `${selectionSideChatKey}\u0000prompt\u0000${text}`;
      const childSessionId = await createSelectionSideChat(pendingKey, async () => {
        const ack = await dispatchCommand(
          "createSelectionSideSession",
          { firstInput: { text, ...(modelSelection ? { modelSelection } : {}) } },
          sessionId,
          undefined,
          undefined,
          telemetrySeed,
        );
        if (
          (ack.status !== "accepted" && ack.status !== "duplicate") ||
          ack.result?.type !== "createSelectionSideSession"
        ) {
          throw new Error(ack.reasonCode ?? "createSelectionSideSession was rejected");
        }
        return ack.result.sessionId;
      });
      onOpenSelectionSideChat({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        parentSessionId: sessionId,
        childSessionId,
      });
      return true;
    },
    [
      dispatchCommand,
      modelSelectionView,
      recommendStartPlan,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  useEffect(() => {
    if (
      !selectionSideChatKey ||
      !sessionId ||
      readOnly ||
      selectionSideChat ||
      !onOpenSelectionSideChat
    ) {
      return;
    }

    // The Side Pane fixed entrance does not have a session provider; only the existing command orchestration capabilities of the main pane are registered here.
    // The parent session remains registered even if it is in a blocking state such as Permission/AskUser, and the direct entry can still create/activate the secondary screen.
    return registerSelectionSideChatOpener(
      selectionSideChatKey,
      // References were discarded during merging, resulting in only a blank secondary screen for the Markdown entry; existing reference routes were reused.
      (reference) => handleOpenSelectionSideConversation(reference, !reference),
      focused,
      Boolean(blockingInteractionId) || selectionSideActionBlocked,
    );
  }, [
    blockingInteractionId,
    selectionSideActionBlocked,
    focused,
    handleOpenSelectionSideConversation,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    selectionSideChatKey,
    sessionId,
  ]);

  const cliSlashCommandNames = useMemo(
    () =>
      new Set(
        (slashCommands ?? []).map((command) =>
          normalizeSlashCommandValue(command.name).toLowerCase(),
        ),
      ),
    [slashCommands],
  );
  const availableSelectionSideSlashCommandNames = useMemo(
    () => ["side", "btw"].filter((name) => !cliSlashCommandNames.has(name)),
    [cliSlashCommandNames],
  );

  // `/side` App layer slash command. The command catalog is still authoritative with the CLI catalog, here only in the rendering layer
  // Inject the local command "Open auxiliary dialogue when selected" according to the access control; draft state (no parent session can hang child),
  // Assisted dialogue itself, read-only and mobile viewports are not provided.
  const appSlashCommands = useMemo<AppSlashCommand[] | undefined>(() => {
    if (
      !sessionId ||
      !onOpenSelectionSideChat ||
      !shouldOfferSideSlashCommand({
        isDraft: sessionId === null,
        selectionSideChat,
        readOnly,
        isMobileViewport: false,
      })
    ) {
      return undefined;
    }
    const openNewSelectionSideChat = () => {
      void handleOpenSelectionSideConversation(undefined, true);
    };
    // Keywords always include both Chinese and English aliases, and they can be searched by typing side / btw / auxiliary in any locale.
    // `/btw` is the equivalent alias of `/side`. It adapts to different user input habits and is displayed independently in the panel.
    const sharedKeywords = ["side", "btw", "side chat", "auxiliary", "辅助对话", "辅助", "侧边"];
    const description = intl.formatMessage({ id: "chat.slash.app.side.description" });
    return [
      { value: "side", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
      { value: "btw", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
    ].filter((command) => !cliSlashCommandNames.has(command.value));
  }, [
    cliSlashCommandNames,
    handleOpenSelectionSideConversation,
    intl,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    sessionId,
  ]);

  const chatLoadingBlockedByInteraction = hasChatLoadingBlockingInteraction(
    snapshot?.pendingInteractions ?? [],
  );
  const chatLoadingBlockedByActiveWork = hasChatLoadingBlockingActiveWork(
    snapshot?.control.activeWorks ?? [],
  );
  // The session content of the sub-agent details is still read-only; the file undo restores the workspace, which must be judged as an independent capability.
  const workspaceFileRewindEnabled = !readOnly || allowWorkspaceFileRewind;
  // cancelBackgroundWork: The "cancel" entry of the startup card/background task card. Defined before rowContext memo,
  // For binding (onOpenWorkflowRun is also defined before memo); it is not issued in read-only mode (consistent with 4213).
  const handleCancelBackgroundWork = useCallback(
    (workId: string) => {
      if (!sessionId) return;
      void dispatchCommand("cancelBackgroundWork", { workId }, sessionId).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[v4-pane] cancelBackgroundWork rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // Dynamic workflow grayscale snapshot: read-only store,
  // Fetching the number is done once in Root. When not ready, enabled is false and is treated as a miss.
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();

  // resumeWorkflowRun: Resume of the tool card footer. and details page
  // The same v4 command, without baseRevision; `name` is the topic of completion notification after recovery.
  const handleResumeWorkflowRun = useCallback(
    (workId: string, name?: string) => {
      if (!sessionId) return;
      void dispatchCommand(
        "resumeWorkflowRun",
        { workId, ...(name ? { name } : {}) },
        sessionId,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[v4-pane] resumeWorkflowRun rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // amendWorkflowRunSettings: "Configuration" of the run card. Return ACK to the pop-up layer - the rejection reason is drawn in the pop-up layer, not a line of warn in the console. The gate is the same as Resume.
  const handleAmendWorkflowRunSettings = useCallback(
    (workId: string, change: WorkflowRunSettingsChange): Promise<CommandAck> =>
      dispatchCommand("amendWorkflowRunSettings", { workId, ...change }, sessionId),
    [dispatchCommand, sessionId],
  );
  const workflowSessionModel = useMemo(
    () => workflowSessionModelOf(snapshot?.sessionId === sessionId ? snapshot?.config : undefined),
    [sessionId, snapshot?.config, snapshot?.sessionId],
  );

  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      workspaceRemoteSessionId: remoteSessionId ?? undefined,
      modelSelectionView,
      logEpoch: snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId: rootSessionId ?? sessionId,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      onNavigateToRow: handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx: handleAutoOpenAssistantPptx,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession: onOpenSubagentSession ? handleOpenSubagentSession : undefined,
      onOpenPlanDetail: onOpenPlanDetail ? handleOpenPlanDetail : undefined,
      onOpenWorkflowRun: onOpenWorkflowRun ? handleOpenWorkflowRun : undefined,
      onOpenWorkflowActor: onOpenWorkflowActorSession ? handleOpenWorkflowActorSession : undefined,
      onOpenWorkflowWorkspace: onOpenWorkflowWorkspace ? handleOpenWorkflowWorkspace : undefined,
      onOpenWorkflowArtifact: onOpenWorkflowArtifact ? handleOpenWorkflowArtifact : undefined,
      onCancelBackgroundWork: readOnly ? undefined : handleCancelBackgroundWork,
      // Resume is the only supply point to enter the session context; both grayscale and read-only gates are in resolveWorkflowResumeHandler.
      // Breaking here means that the tool card footer disappears together with the summary card button.
      onResumeWorkflowRun: resolveWorkflowResumeHandler({
        readOnly,
        dynamicWorkflowEnabled,
        handler: handleResumeWorkflowRun,
      }),
      onAmendWorkflowRunSettings: sessionId
        ? resolveWorkflowResumeHandler({
            readOnly,
            dynamicWorkflowEnabled,
            handler: handleAmendWorkflowRunSettings,
          })
        : undefined,
      ...(workflowSessionModel === undefined ? {} : { workflowSessionModel }),
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowDraftByToolCallId,
      fetchFileChanges: handleFetchFileChanges,
      previewFileRewind: workspaceFileRewindEnabled ? handlePreviewFileRewind : undefined,
      applyFileRewind: workspaceFileRewindEnabled ? handleApplyFileRewind : undefined,
      readAttachment: attachmentRead,
      readAttachmentRange: attachmentReadRange,
    }),
    [
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      remoteSessionId,
      modelSelectionView,
      snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      handleAutoOpenAssistantPptx,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession,
      handleOpenSubagentSession,
      onOpenPlanDetail,
      handleOpenPlanDetail,
      onOpenWorkflowRun,
      handleOpenWorkflowRun,
      onOpenWorkflowActorSession,
      handleOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      handleOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      handleOpenWorkflowArtifact,
      readOnly,
      handleCancelBackgroundWork,
      dynamicWorkflowEnabled,
      handleResumeWorkflowRun,
      handleAmendWorkflowRunSettings,
      workflowSessionModel,
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowDraftByToolCallId,
      workspaceFileRewindEnabled,
      handleFetchFileChanges,
      handlePreviewFileRewind,
      handleApplyFileRewind,
      attachmentRead,
      attachmentReadRange,
    ],
  );

  // ── Draft v4 draft session warm-up (m5)──
  // When pane is not bound to a session, a phase=draft session is created in the background as a preheating carrier: configure write CAS direct access and initial reuse.
  // The external binding semantics remain unchanged (shell activeTaskId is still null), and the warm-up session is just the effective subscription target within pane.
  const { binding: prewarmBinding } = useDraftSessionPrewarm({
    enabled: sessionId === null && draftAgentStartupAllowed,
    workspaceKey,
    paneId,
    invalidationVersion: draftRuntimeInvalidationVersion,
    // SessionDataLayer comes from workspace connection registry: same as pane/remount of transport generation
    // Shared identity; the new sendCommand function generated by provider wrapper reconstruction cannot be misjudged as transport replacement.
    transportIdentity: layer,
    dispatchCommand,
    // The warm-up session only consumes the one-time initialization result of the current Root Composer Draft.
    resolveInitialConfig: resolveInitialDraftConfig,
  });
  const prewarmBindingRef = useRef(prewarmBinding);
  prewarmBindingRef.current = prewarmBinding;
  const prewarmSessionId = prewarmBinding?.sessionId ?? null;
  // Runtime replacement (CUA Helper readiness, liveness recovery, etc. triggering workspace-dispose) will flush out the draft state.
  // Persistent warm-up session. It is forbidden to send during reconstruction, otherwise the attachment will hang on the disappeared session (sessionNotFound).
  const { rebuilding: draftRuntimeRebuilding } = useDraftRuntimeRebuildGate({
    enabled: sessionId === null,
    onRuntimeRestart,
    onRuntimeLifecycle,
    prewarmSessionId,
    workspaceIdentity,
    workspacePath,
  });
  const ensureDraftPrewarmConfigBeforeSendRef = useRef<(targetSessionId: string) => Promise<void>>(
    async () => undefined,
  );
  const effectiveSessionId = sessionId ?? prewarmSessionId;
  const showModelChangeNotice = useCallback(
    (sourceModel: ModelSelectionSource | null, targetModel: ModelSelectionSource) => {
      // Bug reason: The draft has not yet formed an actual session, and the model selection itself is already visible in composer;
      // If the switching result pops up repeatedly at this time, the initialization or prewarm fallback will be mistakenly reported as an intra-session switching.
      if (sessionId === null) {
        return;
      }

      const fromProviderId = sourceModel?.provider ?? "";
      const fromModelId = sourceModel?.model ?? "";
      const providerChanged = Boolean(
        fromProviderId && targetModel.provider && fromProviderId !== targetModel.provider,
      );
      if (
        !fromModelId ||
        !targetModel.model ||
        (fromModelId === targetModel.model && !providerChanged)
      ) {
        return;
      }

      const fromProvider = resolveProviderLabel(fromProviderId, modelSelectionView);
      const toProvider = resolveProviderLabel(targetModel.provider, modelSelectionView);
      const fromModel = formatModelChangeLabel(fromProviderId, fromProvider, fromModelId, intl);
      const toModel = formatModelChangeLabel(
        targetModel.provider,
        toProvider,
        targetModel.model,
        intl,
      );
      toast(intl.formatMessage({ id: "chat.modelChangeNotice.changed" }, { fromModel, toModel }));
    },
    [intl, modelSelectionView, sessionId],
  );

  const handleOnlineModelTransition = useCallback(
    (
      subscribedSessionId: string,
      _store: SessionLease["store"],
      transition: SessionModelTransition,
    ) => {
      if (!focused || subscribedSessionId !== effectiveSessionId) return;
      // Bug reason: Automatic fallback prompts and preferences were promoted by online events and arbitrary events respectively.
      // Snapshot diff-driven, recovery/history projection may silently overwrite the next draft. Now both are only
      // Consume the same realtime online event after the store has pressed deliveryKind to remove duplicates.
      showModelChangeNotice(transition.from, transition.to);
    },
    [
      effectiveSessionId,
      focused,
      provider,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );
  const onlineModelTransitionHandlerRef = useRef(handleOnlineModelTransition);
  useLayoutEffect(() => {
    onlineModelTransitionHandlerRef.current = handleOnlineModelTransition;
  }, [handleOnlineModelTransition]);

  const recoverableCommands = usePendingCommandRecovery({
    layer,
    sessionId: effectiveSessionId,
    snapshot,
    status: state.status,
    subscriptionId: state.subscriptionId,
    workspacePath,
    workspaceIdentity,
  });

  useEffect(() => {
    if (!effectiveSessionId) {
      setLease(null);
      return;
    }
    const nextLease = layer.acquire(effectiveSessionId);
    // Bug reason: acquire will start connect immediately, and activation may be released before the next round of effect
    // One-time online frame; must be monitored synchronously after acquire returns, and cannot be compensated by snapshot replay.
    const offOnlineModelTransition = nextLease.store.onOnlineModelTransition((transition) => {
      onlineModelTransitionHandlerRef.current(effectiveSessionId, nextLease.store, transition);
    });
    setLease(nextLease);
    return () => {
      offOnlineModelTransition();
      nextLease.release();
    };
  }, [layer, effectiveSessionId]);

  useEffect(() => {
    if (!sessionId || !lease || snapshot?.sessionId !== sessionId) return;
    void lease.store.refreshPlans();
  }, [lease, sessionId, snapshot?.sessionId, state.planDirectoryRevision]);

  // Preheating session subscription fails (CLI restarts, the memory session disappears, etc.) → discard the fallback without preheating path, and do not enter the error UI.
  useEffect(() => {
    if (sessionId === null && prewarmBinding && state.status === "error") {
      logger.warn("[v4-draft-prewarm] prewarmed session subscribe failed, discarding the binding", {
        prewarmSessionId: prewarmBinding.sessionId,
        lastError: state.lastError ?? null,
      });
      prewarmBinding.discard();
    }
  }, [prewarmBinding, sessionId, state.lastError, state.status]);

  useEffect(() => {
    if (
      !selectionSideChat ||
      state.status !== "error" ||
      !state.lastError?.includes("sessionNotFound")
    ) {
      return;
    }
    // The secondary screen is a temporary UI binding; clear the tab after the persistent child is lost, and rebuild it according to the parent session the next time the box is selected.
    onSelectionSideChatUnavailable?.();
  }, [onSelectionSideChatUnavailable, selectionSideChat, state.lastError, state.status]);

  const settleCurrentQueueInputs = useCallback((targetSessionId: string) => {
    const current = snapshotRef.current;
    if (!current || current.sessionId !== targetSessionId) return;
    for (const item of current.queue.items) {
      pendingCommandRegistry.settle(targetSessionId, item.sourceCommandId);
    }
  }, []);

  const dispatchSlashCommand = useCallback(
    async (
      command: V4VisibleSlashCommand,
      targetSessionId: string,
      baseRevision: number | undefined,
      heldQueueDisposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
      expectedHeldQueueItemIds?: readonly string[],
      submission?: ComposerSubmissionConfig,
      onAccepted?: (messageId: string) => void,
    ): Promise<boolean | "confirmationRequired"> => {
      let type: CommandType | null = null;
      let payload: Record<string, unknown> = {};
      // Compact can queue input commands without going through CAS; resumeGoal is still CAS.
      let withBaseRevision = false;
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      const compactExpectedToQueue =
        command.kind === "compact" &&
        currentRoutingMode !== undefined &&
        currentRoutingMode !== "startNow";
      switch (command.kind) {
        case "compact":
          type = "compact";
          break;
        case "sendGoalCommand":
          type = "sendGoalCommand";
          // Manual merging used to cause /goal to re-read Composer after preparation, overwriting stalls that were frozen when clicked.
          // This Submission will be used the same as sendText; subsequent menu modifications will only affect the next send.
          if (!submission) return false;
          payload = {
            text: command.objective,
            displayText: command.displayText,
            ...submission,
            ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
            ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          };
          break;
        case "resumeGoal":
          type = "resumeGoal";
          withBaseRevision = true;
          break;
        case "emptyGoal":
          logger.warn("[v4-pane] /goal requires goal text");
          return true;
        case "unsupportedGoal":
          logger.warn(`[v4-pane] /goal ${command.action} is not supported yet`);
          return true;
        default:
          return false;
      }
      if (withBaseRevision && baseRevision === undefined) {
        logger.warn(`[v4-pane] slash ${command.kind} is missing baseRevision`);
        return true;
      }
      const ack = await dispatchCommand(
        type,
        payload,
        targetSessionId,
        withBaseRevision ? baseRevision : undefined,
      );
      if (ack.status === "accepted") onAccepted?.(ack.commandId);
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired";
      }
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(
          `[v4-pane] slash ${command.kind} rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
        );
        if (command.kind === "compact" && ack.reasonCode === "compactOperationLock") {
          toast(intl.formatMessage({ id: "chat.compact.duplicateBlocked" }));
        } else if (command.kind === "compact" && ack.reasonCode === "activeTurn") {
          // Compatible with CLIs that have not yet been upgraded: the old end will still return activeTurn and cannot silently clear the command again.
          toast(intl.formatMessage({ id: "chat.compact.runningBlocked" }));
        }
      } else if (command.kind === "compact" && compactExpectedToQueue) {
        toast(intl.formatMessage({ id: "chat.compact.queued" }));
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
      return true;
    },
    [dispatchCommand, intl, settleCurrentQueueInputs],
  );

  const dispatchSendTextAfterConfig = useCallback(
    async (
      text: string,
      options: ConversationComposerSendOptions | undefined,
      createSourceAtSend: SessionCreateSource,
    ) => {
      let onAcceptedSelection: (() => void) | undefined;
      const dispatchSubmissionCommand = async (...args: Parameters<typeof dispatchCommand>) => {
        const ack = await dispatchCommand(...args);
        // Write back the recommended selection at the original accepted boundary, before the draft transfer of the new Session; failure does not change the user intent.
        if (ack.status === "accepted" && submissionConfigFromCommand(args[0], args[1]))
          onAcceptedSelection?.();
        return ack;
      };
      // It has been frozen before entering the barrier; Composer or Session will no longer be read back while waiting for configuration/attachment.
      let submission = options?.submission ?? null;
      const heldQueueDisposition = options?.heldQueueDisposition;
      const expectedHeldQueueItemIds = options?.expectedHeldQueueItemIds;
      const readyAttachments = options?.attachments ?? [];
      const sharedContextRefs = options?.sharedContextRefs;
      const contextAttachmentCount = options?.contextAttachmentCount ?? 0;
      let slashCommand = parseV4VisibleSlashCommand(text, readyAttachments, {
        contextAttachmentCount,
      });

      // The first version of `/plan` only consumes plain text. Must precede provider readiness and any command admission
      // Reject attachments/context, otherwise the original `/plan ...` will degenerate into a normal prompt, both bypassing product boundaries and clearing the draft.
      if (slashCommand?.kind === "unsupportedPlanShortcut") {
        toast(intl.formatMessage({ id: "chat.plan.attachmentsBlocked" }));
        return "blocked" as const;
      }

      // Empty /plan is the same as the mode menu. It only edits the current Composer and does not overwrite the Agent execution status in advance.
      if (slashCommand?.kind === "planShortcut") {
        handleDraftSwitchMode("plan");
        if (submission) submission = { ...submission, planEnabled: true };
        if (!slashCommand.task) return "sent" as const;
      }

      if (!(await ensureDraftModelReadyForSend())) {
        return "blocked" as const;
      }

      let effectiveText = text;
      if (slashCommand?.kind === "planShortcut") {
        // The command explicitly specifies the mode of this Submission and cannot be guaranteed by the order of another CAS.
        effectiveText = slashCommand.task;
        // The command is only responsible for configuring shortcut; you must use ordinary sendText later and cannot enter the goal/compact command branch.
        slashCommand = null;
      }
      // During create/send ACK the user may switch tasks or create another draft.
      // Placement must be bound to the stable identity at the beginning of sending, and the current workspace draft cannot be read in the completion callback.
      const groupedDraftTaskAtSend =
        sessionId === null
          ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .groupedDraftTask
          : null;
      const selectionSideSlashCommand =
        sessionId && (appSlashCommands?.length ?? 0) > 0
          ? parseSelectionSideSlashCommand(text, readyAttachments, {
              contextAttachmentCount,
              enabledCommandNames: availableSelectionSideSlashCommandNames,
            })
          : null;
      if (sessionId && selectionSideSlashCommand) {
        const created = await handleOpenSelectionSideConversationWithPrompt(
          selectionSideSlashCommand.text,
          options?.telemetrySeed,
        );
        return created ? ("sent" as const) : ("blocked" as const);
      }
      if (
        submission?.planEnabled &&
        slashCommand !== null &&
        (slashCommand.kind === "sendGoalCommand" ||
          slashCommand.kind === "resumeGoal" ||
          slashCommand.kind === "emptyGoal" ||
          slashCommand.kind === "unsupportedGoal")
      ) {
        // Plan mode cannot create, update or restore goals. Must be used in draft promotion / command dispatch
        // Reject before, otherwise even if the CLI subsequently rejects, composer will mistakenly think that the send is successful and clear the user input.
        toast(intl.formatMessage({ id: "chat.goal.planModeBlocked" }));
        return "blocked" as const;
      }
      if (!submission) {
        logger.warn("[v4-pane] submission is missing a complete model or mode configuration");
        return "blocked" as const;
      }
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      if (
        currentRoutingMode === "choice" &&
        !heldQueueDisposition &&
        (slashCommand === null || slashCommand.kind === "sendGoalCommand")
      ) {
        // UI choice only takes effect for normal input and /goal <new goal>; /compact directly adds to the pause queue.
        // Control commands such as resumeGoal should not be intercepted by the send message confirmation box.
        return "confirmationRequired" as const;
      }
      if (slashCommand === null || slashCommand.kind === "sendGoalCommand") {
        const original = submission.modelSelection;
        const chosen = await recommendStartPlan(original);
        if (!chosen) return "blocked" as const;
        if (chosen !== original) {
          onAcceptedSelection = captureAcceptedModelSelection(chosen, original);
          submission = { ...submission, modelSelection: chosen };
        }
      }
      const prewarmTargetBeforeSend =
        sessionId === null ? prewarmBindingRef.current?.sessionId : null;
      if (prewarmTargetBeforeSend) {
        // The barrier only ensures that the queued commands are completed; if the session/snapshot has not been warmed up when you click configure,
        // Ready, the command may not have a target at the time. Synchronize again before the warm-up session determined by initial binding
        // Draft authoritative configuration prohibits forking of new UI values and old runtime values.
        await ensureDraftPrewarmConfigBeforeSendRef.current(prewarmTargetBeforeSend);
      }
      // The slash command has priority: there is an existing session and is consumed directly; the draft command /goal first creates an empty session and then sends the command.
      // When carrying attachments or web page element context, they are not consumed as v4 native commands (no attachment semantics such as compact/goal) and are sent directly with sendText.
      if (sessionId && slashCommand) {
        const consumed = await dispatchSlashCommand(
          slashCommand,
          sessionId,
          snapshotRef.current?.revision,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          onAcceptedSelection?.();
          return;
        }
      }
      const draftSlashCommand =
        slashCommand?.kind === "sendGoalCommand" ||
        slashCommand?.kind === "resumeGoal" ||
        slashCommand?.kind === "emptyGoal" ||
        slashCommand?.kind === "unsupportedGoal"
          ? slashCommand
          : null;
      if (!sessionId && draftSlashCommand) {
        if (
          draftSlashCommand.kind === "emptyGoal" ||
          draftSlashCommand.kind === "unsupportedGoal"
        ) {
          await dispatchSlashCommand(
            draftSlashCommand,
            prewarmBindingRef.current?.sessionId ?? "__draft__",
            undefined,
            heldQueueDisposition,
            expectedHeldQueueItemIds,
            submission,
          );
          return;
        }
        const prewarm = prewarmBindingRef.current;
        if (prewarm?.beginPromotion()) {
          try {
            const consumed = await dispatchSlashCommand(
              draftSlashCommand,
              prewarm.sessionId,
              0,
              heldQueueDisposition,
              expectedHeldQueueItemIds,
              submission,
              (messageId) => reportDraftCreated(prewarm.sessionId, createSourceAtSend, messageId),
            );
            if (consumed === "confirmationRequired") return consumed;
            if (consumed) {
              onAcceptedSelection?.();
              prewarm.promote();
              handleDraftSessionCreated(
                prewarm.sessionId,
                groupedDraftTaskAtSend,
                createSourceAtSend,
              );
              return;
            }
          } catch (error) {
            if (isProviderNotReadyError(error)) throw error;
            // The same as the ordinary first release: the transport error after the slash command is written is also the admission
            // The result is unknown and cannot be discarded and then replaced with session/command and executed again.
            logger.warn(
              `[v4-draft-prewarm] prewarmed session slash result is unknown, keeping the original command and forbidding an automatic resend: ${String(error)}`,
            );
            throw error;
          }
        }
        const draftConfigPayload = buildDraftCreateConfigPayload(
          { ...draftConfigRef.current, modelSelection: submission.modelSelection },
          appFollowupMode,
        );
        const createAck = await dispatchSubmissionCommand(
          "createSession",
          { workspaceId: workspaceKey, ...draftConfigPayload },
          null,
        );
        if (createAck.status !== "accepted") {
          throw new Error(createAck.reasonCode ?? "createSession was rejected");
        }
        const createResult = createAck.result;
        if (!createResult || createResult.type !== "createSession") {
          throw new Error("createSession is missing sessionId");
        }
        const newSessionId = createResult.sessionId;
        handleDraftSessionCreated(newSessionId, groupedDraftTaskAtSend, createSourceAtSend);
        await dispatchSlashCommand(
          draftSlashCommand,
          newSessionId,
          0,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
          (messageId) => reportDraftCreated(newSessionId, createSourceAtSend, messageId),
        );
        return;
      }
      if (!sessionId) {
        // The draft attachment has been bound to the preheating session in composer to complete the pre-upload.
        // Only ready ref is submitted here, and uploading is prohibited within send click.
        const prewarm = prewarmBindingRef.current;
        if (prewarm?.beginPromotion()) {
          try {
            const ack = await dispatchSubmissionCommand(
              "sendText",
              {
                text: effectiveText,
                ...submission,
                ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
                ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
              },
              prewarm.sessionId,
              undefined,
              undefined,
              options?.telemetrySeed,
            );
            if (ack.status === "accepted") {
              prewarm.promote();
              handleDraftSessionCreated(
                prewarm.sessionId,
                groupedDraftTaskAtSend,
                createSourceAtSend,
                ack.commandId,
              );
              return;
            }
            // failed ACK may also occur when the runtime is started but TurnStarted projection commit
            // After the timeout; the model tool side effects cannot be rolled back by failed ACK, and the command cannot be automatically changed and re-run.
            logger.warn(
              `[v4-draft-prewarm] prewarmed session first send was not accepted (${ack.reasonCode ?? ack.status}), automatic resend is forbidden`,
            );
            throw new Error(ack.reasonCode ?? "prewarmed session first send was not accepted");
          } catch (error) {
            if (isProviderNotReadyError(error)) throw error;
            if (readyAttachments.length > 0) throw error;
            // Bug reason: transport error cannot prove that Agent has no admission; failed ACK is also possible
            // Later than runtime startup and tool side effects. Old logic unifies discard to warm up the session and automatically
            // createSession(firstInput) will run the same submission twice. retain pending lifecycle and
            // Command reconciliation clues, exceptions are handed over to composer to keep the draft, and automatic replacement of command and resend are prohibited.
            logger.warn(
              `[v4-draft-prewarm] prewarmed session first send was not confirmed successful, keeping the original command and forbidding an automatic resend: ${String(error)}`,
            );
            throw error;
          }
        }
        // fallback: Create a session on-site when there is no preheating (creation failed/discarded). Draft selected config comes with
        // createSession carries (CLI merge request with runtime default, out-of-the-box draft selection).
        // When fallback has prewarm projection, it must use the current configuration of the Agent as the base; only if the projection has never been obtained
        // Only use frozen initialization tuples. Otherwise, the old model of localStorage will be written back after provider fallback.
        const draftConfigPayload = buildDraftCreateConfigPayload(
          { ...draftConfigRef.current, modelSelection: submission.modelSelection },
          appFollowupMode,
        );
        if (readyAttachments.length === 0 && !sharedContextRefs?.length) {
          const ack = await dispatchSubmissionCommand(
            "createSession",
            {
              workspaceId: workspaceKey,
              firstInput: { text: effectiveText, ...submission },
              ...draftConfigPayload,
            },
            null,
            undefined,
            undefined,
            options?.telemetrySeed,
            undefined,
            createSourceAtSend,
          );
          if (ack.status !== "accepted") {
            throw new Error(ack.reasonCode ?? "createSession was rejected");
          }
          const result = ack.result;
          if (!result || result.type !== "createSession") {
            throw new Error("createSession is missing sessionId");
          }
          handleDraftSessionCreated(
            result.sessionId,
            groupedDraftTaskAtSend,
            createSourceAtSend,
            ack.commandId,
          );
          return;
        }
        // The local desktop localPath is zero-copy ready and does not rely on attachment transaction; within a very short window
        // The warm-up session may not have returned yet. At this time, you can still create an empty session first, then submit the ready-made ref and send the click content
        // No attachments will be uploaded, and non-ready attachments will not be allowed to bypass the composer access control.
        const createAck = await dispatchSubmissionCommand(
          "createSession",
          { workspaceId: workspaceKey, ...draftConfigPayload },
          null,
        );
        if (createAck.status !== "accepted") {
          throw new Error(createAck.reasonCode ?? "createSession was rejected");
        }
        const createResult = createAck.result;
        if (!createResult || createResult.type !== "createSession") {
          throw new Error("createSession is missing sessionId");
        }
        const newSessionId = createResult.sessionId;
        const sendAck = await dispatchSubmissionCommand(
          "sendText",
          {
            text: effectiveText,
            attachments: readyAttachments,
            ...submission,
            ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
          },
          newSessionId,
          undefined,
          undefined,
          options?.telemetrySeed,
        );
        if (sendAck.status !== "accepted") {
          throw new Error(sendAck.reasonCode ?? "sendText was rejected");
        }
        handleDraftSessionCreated(
          newSessionId,
          groupedDraftTaskAtSend,
          createSourceAtSend,
          sendAck.commandId,
        );
        return;
      }
      // The attachment ref has been closed in the composer pre-upload state machine.
      const ack = await dispatchSubmissionCommand(
        "sendText",
        {
          text: effectiveText,
          ...submission,
          ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
          ...(options?.requestedDelivery
            ? {
                // Send immediately once projecting the QueueItem first and then wait a second time
                // sendQueuedNow, causing the queue intermediate state to be leaked and the input box to be cleared delayed. now by
                // CLI atomic stop + start, accepted ACK means Composer clears the boundary.
                requestedDelivery: options.requestedDelivery,
              }
            : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
        },
        sessionId,
        undefined,
        undefined,
        options?.telemetrySeed,
      );
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired" as const;
      }
      if (ack.status !== "accepted") {
        throw new Error(ack.reasonCode ?? "sendText was rejected");
      }
      if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(sessionId);
      }
    },
    [
      dispatchCommand,
      recommendStartPlan,
      captureAcceptedModelSelection,
      dispatchSlashCommand,
      ensureDraftModelReadyForSend,
      availableSelectionSideSlashCommandNames,
      appSlashCommands,
      appFollowupMode,
      handleDraftSessionCreated,
      reportDraftCreated,
      handleDraftSwitchMode,
      handleOpenSelectionSideConversationWithPrompt,
      intl,
      lease,
      resolveInitialDraftConfig,
      createSubmissionFromComposer,
      sessionId,
      settleCurrentQueueInputs,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );

  const dispatchSendText = useCallback(
    (text: string, options?: ConversationComposerSendOptions) => {
      const createSource = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity).draftCreateSource;
      const submissionOptions = {
        ...options,
        submission:
          options?.submission === undefined ? createSubmissionFromComposer() : options.submission,
      };
      // followupMode is still synchronized through Session CAS; the model and schema have been encapsulated into Submission and are no longer
      // Rely on the cross-command timing of "configuration command comes first, sendText comes last".
      return configCommandBarrier.enqueue(async () => {
        try {
          return await dispatchSendTextAfterConfig(text, submissionOptions, createSource);
        } catch (error) {
          if (sessionId === null && isProviderNotReadyError(error)) {
            // The registry may still fail between UI precheck and Host getClient. When the race condition hits, it converges to
            // The same normal waiting state does not take the exception sending path and does not clear the composer.
            markDraftProviderNotReady();
            return "blocked" as const;
          }
          throw error;
        }
      });
    },
    [
      configCommandBarrier,
      createSubmissionFromComposer,
      dispatchSendTextAfterConfig,
      markDraftProviderNotReady,
      sessionId,
      workspacePath,
      workspaceIdentity,
    ],
  );

  const focusTimelineToLatest = useCallback(() => {
    timelineScrollToBottomRef.current?.();
  }, []);

  const handleSendText = useCallback(
    async (
      text: string,
      options?: ConversationComposerSendOptions,
    ): Promise<ConversationComposerSendResult> => {
      // Freeze this admission before sending. Expectation: When the command ACK comes back, the projection may have been switched to running.
      // The updated enqueue mode cannot be used to determine whether the prompt submitted just now was originally sent immediately.
      const shouldFocusLatest = shouldFocusTimelineAfterComposerSend({
        draftMode: sessionId === null,
        inputRoutingMode: snapshotRef.current?.inputRouting.mode ?? null,
        heldQueueDisposition: options?.heldQueueDisposition,
      });
      try {
        const sendResult = await dispatchSendText(text, options);
        if (sendResult === "blocked" || sendResult === "confirmationRequired") {
          return sendResult;
        }
        setSendSubmissionError(null);
        if (shouldFocusLatest) {
          focusTimelineToLatest();
        }
        return "sent";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const runtimeModelUnavailable = detail.includes("provider.notInRegistry");
        // Failure of switchModelConfig before the launch will only throw it back to Composer; Composer in order to retain the draft
        // Only writing logs will not generate snapshot.control.lastError, and the result the user sees is "No response when clicking."
        // Here, the pre-admission failure is closed as a pane-local error banner, without changing the desktop continuous or
        // Send/restore semantics of Web remote replayable, drafts are still retained by Composer original path.
        setSendSubmissionError({
          code: runtimeModelUnavailable ? "ZCODE_RUNTIME_MODEL_UNAVAILABLE" : "SEND_FAILED",
          message: runtimeModelUnavailable
            ? detail
            : intl.formatMessage({ id: "chat.error.sendFailed" }),
          detail,
          ...(sessionId ? { taskId: sessionId } : {}),
        });
        throw error;
      }
    },
    [dispatchSendText, focusTimelineToLatest, intl, sessionId],
  );

  const handleComposerDraftStateChange = useCallback(
    (state: { hasContent: boolean; busy: boolean }) => {
      composerDraftStateRef.current = state;
    },
    [],
  );
  const clearQueueEditOperation = useCallback(() => {
    queueEditOperationRef.current = null;
    setQueueEditOperation(null);
  }, []);
  const handleComposerRestoreApplied = useCallback(
    (requestId: number) => {
      setComposerRestoreRequest((current) => (current?.requestId === requestId ? null : current));
      clearQueueEditOperation();
    },
    [clearQueueEditOperation],
  );

  const handleFork = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // forkAssistant is a CAS command: baseRevision takes the current projection revision.
      void dispatchCommand(
        "forkAssistant",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "duplicate") {
          logger.warn(`[v4-pane] fork rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
          return;
        }
        if (ack.result?.type === "forkAssistant") {
          // Cut to the child session in place (same selection path as creating a new session).
          onSessionCreated?.(ack.result.sessionId);
        }
      });
    },
    [dispatchCommand, onSessionCreated, sessionId],
  );

  const handleEdit = useCallback(
    async (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
      workspaceMode: "preserve" | "rewind" = "preserve",
    ) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      if (!newText.trim() && (!attachments || attachments.length === 0)) {
        logger.warn(
          "[v4-pane] edit skipped: inline edit content is empty and there are no attachments",
        );
        return false;
      }
      const ack = await dispatchCommand(
        "editUserQuery",
        {
          target,
          newText,
          workspaceMode,
          // The default attachments of editUserQuery means to retain the canonical original attachments;
          // Only with explicit passthrough [] can the CLI distinguish between "user deleted all" and "caller did not modify the attachment".
          ...(attachments ? { attachments: [...attachments] } : {}),
        },
        sessionId,
        current.revision,
        current.logEpoch,
      );
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        logger.warn(`[v4-pane] edit rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
        return false;
      }
      // Fork ACK only makes decoding compatible with old protocols; new edit never navigates children. blocked is handled by an inline conflict popup.
      return ack;
    },
    [dispatchCommand, sessionId],
  );

  const dispatchRetryTurn = useCallback(
    async (target: ConversationRowTarget): Promise<CommandAck> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) {
        throw new Error("retryTurn is missing the current session projection");
      }
      // retryTurn is a CAS command: baseRevision takes the current projection revision.
      return dispatchCommand(
        "retryTurn",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleRetry = useCallback(
    (target: ConversationRowTarget) => {
      void dispatchRetryTurn(target)
        .then((ack) => {
          if (ack.status !== "accepted") {
            logger.warn(`[v4-pane] retry rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
        })
        .catch((error: unknown) => {
          logger.warn("[v4-pane] retry submission failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [dispatchRetryTurn],
  );

  const handleAssistantFeedback = useCallback(
    async (
      target: ConversationRowTarget,
      feedback: "like" | "dislike" | null,
    ): Promise<boolean> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      const ack = await dispatchCommand(
        "setAssistantFeedback",
        { target, feedback },
        sessionId,
        current.revision,
        current.logEpoch,
      );
      const accepted = ack.status === "accepted" || ack.status === "duplicate";
      if (!accepted) {
        logger.warn(`[v4-pane] assistant feedback rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
      return accepted;
    },
    [dispatchCommand, sessionId],
  );

  const handleDeleteQueueItem = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      const sourceCommandId = current.queue.items.find(
        (item) => item.queueItemId === queueItemId,
      )?.sourceCommandId;
      void dispatchCommand("deleteQueueItem", { queueItemId }, sessionId, current.revision).then(
        (ack) => {
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(
              `[v4-pane] deleteQueueItem rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
            );
            return;
          }
          if (sourceCommandId) pendingCommandRegistry.settle(sessionId, sourceCommandId);
        },
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleEditQueueItem = useCallback(
    async (queueItemId: string): Promise<void> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null || queueEditOperationRef.current) return;
      if (composerDraftStateRef.current.hasContent || composerDraftStateRef.current.busy) {
        toast(intl.formatMessage({ id: "chat.queue.editDraftConflict" }));
        return;
      }
      const restoreTarget = resolveQueuedComposerRestore(current, queueItemId);
      if (!restoreTarget) {
        logger.warn(
          `[v4-pane] queue recall edit skipped: queue item does not exist or is not editable ${queueItemId}`,
        );
        return;
      }
      const operation = { queueItemId, sessionId, workspaceKey };
      queueEditOperationRef.current = operation;
      setQueueEditOperation(operation);
      try {
        const ack = await dispatchCommand(
          "deleteQueueItem",
          { queueItemId },
          sessionId,
          restoreTarget.baseRevision,
        );
        if (!shouldRestoreQueuedComposerFromAck(ack.status)) {
          logger.warn(
            `[v4-pane] queue recall edit rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
          toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
          clearQueueEditOperation();
          return;
        }
        pendingCommandRegistry.settle(sessionId, restoreTarget.sourceCommandId);
        const currentBinding = composerBindingRef.current;
        if (
          currentBinding.sessionId !== sessionId ||
          currentBinding.workspaceKey !== workspaceKey
        ) {
          // When delete ACK returns asynchronously, pane may have cut off the task; if the old implementation directly setsText,
          // The queue payload of the original session will be written into the new task. Authoritative deletion remains, but local recovery must be discarded.
          logger.warn(
            "[v4-pane] queue recall edit not restored: composer switched before the ACK returned",
            {
              queueItemId,
              sessionId,
              workspaceKey,
            },
          );
          clearQueueEditOperation();
          return;
        }
        setComposerRestoreRequest({
          requestId: nextComposerRestoreRequestIdRef.current++,
          sessionId,
          workspaceKey,
          inputKind: restoreTarget.inputKind,
          text: restoreTarget.text,
          attachments: restoreTarget.attachments,
          config: restoreTarget.config,
        });
      } catch (error) {
        logger.warn("[v4-pane] queue recall edit command failed", error);
        toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
        clearQueueEditOperation();
      }
    },
    [clearQueueEditOperation, dispatchCommand, intl, sessionId, workspaceKey],
  );

  const handleSendQueuedNow = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // When the user explicitly clicks "Send Now", the visual intent is equivalent to clicking "Scroll to bottom"; the command's
      // The reserve/stop/promote lifecycle is still arbitrated by the CLI, and rolling state is not mixed into the protocol.
      focusTimelineToLatest();
      void dispatchCommand("sendQueuedNow", { queueItemId }, sessionId, current.revision).then(
        (ack) => {
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] sendQueuedNow rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
        },
      );
    },
    [dispatchCommand, focusTimelineToLatest, sessionId],
  );

  const handleReorderQueueItem = useCallback(
    (queueItemId: string, beforeQueueItemId: string | null) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      void dispatchCommand(
        "reorderQueueItem",
        { queueItemId, beforeQueueItemId },
        sessionId,
        current.revision,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] reorderQueueItem rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  const handleResumeQueue = useCallback(async () => {
    const current = snapshotRef.current;
    if (!sessionId || !current || current.queue.autoDrain || current.queue.items.length === 0) {
      return;
    }
    const ack = await dispatchCommand(
      "setAutoDrain",
      { autoDrain: true },
      sessionId,
      current.revision,
    );
    if (ack.status !== "accepted" && ack.status !== "noop") {
      logger.warn(
        `[v4-pane] resuming the paused queue was rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
      );
    }
  }, [dispatchCommand, sessionId]);

  // Configure stale retries of CAS commands. Model→Thinking Depth→Mode When operating continuously, the value of the previous command
  // The revision bump may not have been reflowed to the local projection, and using the local revision directly will be judged as stale by CAS.
  // stale ack takes revisionAtDecision (CLI current revision), which can be used to converge on retries (bounded 3 times).
  // m5: target = effective session (bound session or draft warm-up session); projection must match target
  // Same source (snapshot.sessionId verification) to prevent the wrong revision from being used during warm-up switching.
  const dispatchConfigCas = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      options?: { initialBaseRevision?: number; targetSessionId?: string },
    ): Promise<CommandAck | null> => {
      const targetSessionId =
        options?.targetSessionId ?? sessionId ?? prewarmBindingRef.current?.sessionId ?? null;
      const current = snapshotRef.current;
      if (!targetSessionId) {
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "skipped",
          reasonCode: "no-session",
          at: Date.now(),
        });
        return null;
      }
      // When the draft warm-up session has been created and the snapshot has not yet been projected, the old logic is skipped directly.
      // Configure CAS; the first build then inherits the runtime's build defaults. CAS natively supports stale revision
      // The packet is returned and retried, so even if there is no snapshot, starting from 0 can also determine convergence, and "not projected" cannot be regarded as success.
      let baseRevision =
        options?.initialBaseRevision ??
        (current?.sessionId === targetSessionId ? current.revision : 0);
      let lastAck: CommandAck | null = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const ack = await dispatchCommand(type, payload, targetSessionId, baseRevision);
          lastAck = ack;
          if (ack.status === "stale") {
            baseRevision = ack.revisionAtDecision;
            continue;
          }
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] ${type} rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
          return ack;
        }
        logger.warn(`[v4-pane] ${type} kept returning stale, giving up on retrying`);
        return lastAck;
      } catch (error) {
        if (isProviderNotReadyError(error)) {
          // After the provider readiness race condition is swallowed as null by the configured CAS, the first release will be rewritten as
          // missing-ack, the draft page cannot be restored to the model configuration boot. Deterministically activated access control must be thrown up as is.
          throw error;
        }
        // The production renderer log is closed, and exceptions are also put into the ack debugging buffer to avoid silent loss.
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "dispatch-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        logger.warn(`[v4-pane] ${type} failed: ${String(error)}`);
        return null;
      }
    },
    [dispatchCommand, sessionId],
  );
  const telemetryDraftConfig = draftConfig;
  const ensureDraftPrewarmConfigBeforeSend = useCallback(
    async (targetSessionId: string) => {
      // followupMode is still the Session behavior setting; the model and mode belong to this Submission, and will be sent with sendText
      // Atomic commit, shared Session cannot be rewritten through CAS before sending.
      const desiredConfig = buildDraftCreateConfigPayload(
        draftConfigRef.current,
        appFollowupMode,
      ).config;
      if (!desiredConfig) return;
      const projectedConfig =
        snapshotRef.current?.sessionId === targetSessionId ? snapshotRef.current.config : null;

      const requireAcceptedConfigAck = (type: CommandType, ack: CommandAck | null) => {
        if (
          ack &&
          (ack.status === "accepted" || ack.status === "noop" || ack.status === "duplicate")
        ) {
          return;
        }
        throw new Error(
          `${type} did not converge before the first send: ${ack?.status ?? "missing-ack"} ${ack?.reasonCode ?? ""}`,
        );
      };

      if (
        desiredConfig.followupMode &&
        desiredConfig.followupMode !== projectedConfig?.followupMode
      ) {
        const ack = await dispatchConfigCas(
          "setFollowupMode",
          { mode: desiredConfig.followupMode },
          { targetSessionId },
        );
        requireAcceptedConfigAck("setFollowupMode", ack);
      }
    },
    [appFollowupMode, dispatchConfigCas, draftConfigRef],
  );
  ensureDraftPrewarmConfigBeforeSendRef.current = ensureDraftPrewarmConfigBeforeSend;

  const followupModeSyncKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const targetSessionId = sessionId ?? prewarmSessionId;
    if (!targetSessionId || !appFollowupMode || snapshotRevision === null) return;
    if (snapshotSessionId !== targetSessionId) return;
    if (snapshotFollowupMode === appFollowupMode) {
      followupModeSyncKeyRef.current = `${targetSessionId}:${appFollowupMode}:synced`;
      return;
    }
    const syncKey = `${targetSessionId}:${appFollowupMode}:${snapshotRevision}`;
    if (followupModeSyncKeyRef.current === syncKey) return;
    followupModeSyncKeyRef.current = syncKey;
    // The user fact source for interactive behavior is the app settings page; v4 projection followupMode is just
    // CLI/runtime synchronization results. Here, the setting changes are reissued into the existing setFollowupMode command.
    // Avoid composer exposing a synonymous "append mode" entry to cause upstream and downstream bifurcation.
    void configCommandBarrier.enqueue(() =>
      dispatchConfigCas("setFollowupMode", { mode: appFollowupMode }),
    );
  }, [
    appFollowupMode,
    configCommandBarrier,
    dispatchConfigCas,
    prewarmSessionId,
    sessionId,
    snapshotFollowupMode,
    snapshotRevision,
    snapshotSessionId,
  ]);

  // Composer selects the expression "next commit". Click to update only renderer intent; Session Selection
  // Updated by CLI/Core when Submission actually starts (Guide is the next model-step).
  const handleSelectModel = useCallback(
    (modelProvider: string, model: string, sourceModel: ModelSelectionSource | null) => {
      const resolvedProvider =
        modelProvider || draftConfigRef.current.provider || sourceModel?.provider || "";
      logger.debug("[v4-pane] onSelectModel", {
        modelProvider: resolvedProvider,
        model,
        branch: "composer-submission-intent",
      });
      handleDraftSelectModel(resolvedProvider, model);
    },
    [draftConfigRef, handleDraftSelectModel],
  );

  const handleSelectThought = useCallback(
    (thought: string, _modelContext: { provider: string; model: string }) => {
      handleDraftSelectThought(thought);
    },
    [handleDraftSelectThought],
  );

  const handleRecoverCustomModelSelection = useCallback(
    async (value: string, sourceModel: ModelSelectionSource | null) => {
      const decoded = decodeCustomModelValue(value);
      if (!decoded?.providerId) {
        return;
      }
      const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
      let modelValue = value;
      if (!decoded.modelName) {
        const fallbackModel =
          modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )?.models[0]?.modelId ?? (modelSelectionView ? null : undefined);
        if (!fallbackModel) {
          logger.warn(
            "[v4-pane] custom provider restore skipped: provider has no available model",
            {
              customProviderId: decoded.providerId,
              workspacePath,
            },
          );
          return;
        }
        modelValue = encodeCustomModelValue(decoded.providerId, fallbackModel);
      }
      const modelSelection = parseModelPickerValue(modelValue);
      // Bug reason: configOptions error of custom provider selection bypasses ordinary onSelectModel;
      // Bound tasks still reuse the same prompt entrance, and the draft state is uniformly silenced by the entrance.
      showModelChangeNotice(sourceModel, {
        provider: modelSelection.providerId,
        model: modelSelection.modelId,
      });
      const store = useZCodeSessionStore.getState();
      store.setModelSelectionResolution(
        workspacePath,
        {
          selectedSupplierKey: buildCustomSupplierKey(decoded.providerId),
          isGhostSupplier: false,
          supplierMismatchReason: null,
        },
        workspaceIdentity,
      );
      store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
      logger.info("[v4-pane] configOptions error custom provider recovery start", {
        modelId: modelSelection.modelId,
        providerId: modelSelection.providerId,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });

      try {
        await zcodeTaskService.restartWorkspaceProcess({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          bumpRuntimeEpoch: true,
        });

        const prepareResult = await prepareWorkspaceWithZCodeSessionService({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          zcodeSessionService,
        });
        handleDraftSelectModel(modelSelection.providerId, modelSelection.modelId);
        store.setConfigOptions(workspacePath, prepareResult.configOptions ?? [], workspaceIdentity);
        store.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        store.setSlashCommands(workspacePath, prepareResult.slashCommands ?? [], workspaceIdentity);
        logger.info("[v4-pane] configOptions error custom provider recovery done", {
          configOptionsCount: prepareResult.configOptions?.length ?? 0,
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
      } catch (error) {
        store.setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn("[v4-pane] configOptions error custom provider recovery failed", {
          error: error instanceof Error ? error.message : String(error),
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
        throw error;
      }
    },
    [
      provider,
      handleDraftSelectModel,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspacePath,
      zcodeSessionService,
      zcodeTaskService,
    ],
  );

  // The pattern belongs to the next submission as does the model; only Composer is updated when selected.
  const handleSwitchMode = useCallback(
    (mode: string) => {
      handleDraftSwitchMode(mode);
    },
    [handleDraftSwitchMode],
  );

  // The compression entry of the context usage panel (command text = "/compact", reuse slash parsing path).
  const handleSendCompressionCommand = useCallback(
    (command: string) => {
      if (!sessionId) return;
      const parsed = parseV4VisibleSlashCommand(command);
      if (!parsed) return;
      void dispatchSlashCommand(parsed, sessionId, snapshotRef.current?.revision, undefined);
    },
    [dispatchSlashCommand, sessionId],
  );

  // To troubleshoot accidental stops, you need to distinguish between buttons and Esc; ordinary info is disabled in production, and the life cycle log must be logged.
  const handleStop = useCallback(
    (source: "button" | "escape") => {
      const current = snapshotRef.current;
      if (!sessionId || !current?.control.canStop) {
        logger.lifecycle.info("[v4-pane] stop command skipped (nothing to stop)", {
          source,
          sessionId: sessionId ?? "",
        });
        return;
      }
      const foregroundExecutionId = current.control.activeWorks.find(
        (work) => work.foregroundExecutionId,
      )?.foregroundExecutionId;
      logger.lifecycle.info("[v4-pane] stop command sent", {
        source,
        sessionId,
        foregroundExecutionId: foregroundExecutionId ?? "",
      });
      void dispatchCommand(
        "stop",
        foregroundExecutionId ? { expectedForegroundExecutionId: foregroundExecutionId } : {},
        sessionId,
      ).catch((error) => {
        logger.lifecycle.warn(`[v4-pane] stop failed: ${String(error)}`);
      });
    },
    [dispatchCommand, sessionId],
  );

  const handlePauseGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.pauseGoal.allowed) return;
    void dispatchCommand("pauseGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] pauseGoal rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  const handleResumeGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.resumeGoal.allowed) return;
    void dispatchCommand("resumeGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] resumeGoal rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  // composer parity: Esc → stop (old useChatViewEffects "Escape stops generation" semantic fidelity:
  // Skip when the event path contains dialog/defaultPrevented; when mention/slash panel is opened, Lexical has been
  // preventDefault, this handler will naturally give way). Only focused pane listens:
  // "Dangerous operations such as stop always operate on a specific pane, and shortcut keys use focused pane."
  useEffect(() => {
    if (!focused || readOnly) return;
    if (!sessionId || !snapshot?.control.canStop) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (shouldIgnoreEscapeForStopGeneration(event)) return;
      event.preventDefault();
      handleStop("escape");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focused, handleStop, readOnly, sessionId, snapshot?.control.canStop]);

  // handleStop takes source parameters (button / escape two call points), but ConversationComposer is memo:
  // Directly write onStop={() => handleStop("button")} and change the reference every time you render, memo is in vain, and composer
  // It happens to be a component that may be re-rendered every time it is input. The reference to the button version is fixed here, and the dual-entry design of handleStop is unchanged.
  const handleStopFromButton = useCallback(() => handleStop("button"), [handleStop]);

  const handleRetrySubscribe = useCallback(() => {
    void lease?.store.retry();
  }, [lease]);

  // loadOlder fires (automatic prefetching near top). Anti-reentrancy for single flight inside the store.
  const handleLoadOlder = useCallback(() => {
    return lease?.store.loadOlder();
  }, [lease]);

  const handleLoadAllOlder = useCallback(() => {
    return lease
      ? lease.store.loadAllOlder()
      : Promise.resolve({
          status: "stale" as const,
          logEpoch: snapshot?.logEpoch ?? "unknown",
        });
  }, [lease, snapshot?.logEpoch]);

  useEffect(() => {
    if (!shareActive || !sessionId || !hasOlderRows(snapshot)) return;
    const key = `${sessionId}:${snapshot?.logEpoch ?? "unknown"}`;
    if (shareHydratedSessionRef.current === key) return;
    shareHydratedSessionRef.current = key;
    void handleLoadAllOlder().catch((error) => {
      shareHydratedSessionRef.current = null;
      logger.warn("[conversation-share] failed to hydrate the share directory", { error });
    });
  }, [handleLoadAllOlder, sessionId, shareActive, snapshot]);

  useEffect(() => {
    if (
      !sessionId ||
      !lease?.store ||
      !shouldAutoLoadIncompleteLeadingTurn(snapshot, state.loadingOlder)
    ) {
      return;
    }
    const firstRowId = snapshot?.rows.window[0]?.rowId;
    if (firstRowId === undefined) return;
    const cursorKey = `${sessionId}:${state.subscriptionId ?? "connecting"}:${firstRowId}`;
    if (autoLoadIncompleteTurnCursorRef.current === cursorKey) return;
    autoLoadIncompleteTurnCursorRef.current = cursorKey;

    // snapshotTailWindowRows is truncated by row, maybe a long turn header/user
    // Stay outside the window. The old UI only loadsOlder when the scroll event reaches the top edge; the content is less than one screen or scrollTop
    // When it is already 0, no more events will be generated, so only the assistant will be rendered, and it must be scrolled down and then up. First turn detected
    // Missing headers are immediately filled window by window; cursor deduplication avoids empty range or effect spin when failure occurs.
    logger.debug("[v4-pane] cold snapshot's first turn is incomplete, auto-loading older rows", {
      firstRowId,
      sessionId,
      turnId: snapshot?.rows.window[0]?.turnId,
    });
    void lease.store.loadOlder();
  }, [lease, sessionId, snapshot, state.loadingOlder, state.subscriptionId]);

  // subscribe ACK will first set the store to live, and the initial snapshot will arrive later; only view
  // status will enable the editor in advance in a non-projected window. A formal session must wait for the first snapshot before it can be entered.
  const connecting = sessionId !== null && (state.status === "connecting" || snapshot === null);
  const queueEditActiveForCurrentComposer =
    queueEditOperation?.sessionId === sessionId && queueEditOperation.workspaceKey === workspaceKey;
  const errored = sessionId !== null && state.status === "error";
  useSessionSubscriptionErrorTelemetry({
    supervisor: conversationTelemetry,
    sessionId,
    lastError: state.lastError,
    visible: errored && telemetryVisible && conversationTelemetryForegroundEnabled,
  });
  // retry's product rulings are row-level authority projections. Only command capabilities are provided here, whether the entrance is displayed
  // Read row.actions.canRetry completely and prohibit using pane phase to form a second set of guard.
  const retryActionsEnabled = !readOnly && !selectionSideChat && Boolean(sessionId);
  // Fork availability is entirely arbitrated by row.actions.canFork (CLI stable resolver projection); pane only provides command callbacks.
  const forkActionsEnabled = !readOnly && !selectionSideChat && Boolean(sessionId);
  // editUserQuery has been defended by the command layer against latest real user query, and is running
  // When submitting, stop barrier first and then rewind/rerun; the UI should no longer use completed gate to hide the entrance for the entire round.
  const editActionsEnabled = !readOnly && !selectionSideChat && Boolean(sessionId);
  const isDraft = sessionId === null;
  // Rolling recovery must use a lease projection that matches sessionId. Switch session render with
  // The passive effect is not at the same time. If the rows of the old lease are handed over to the timeline in advance, the new memory will be based on the old
  // The content is highly clamped, and the temporary landing point cannot be distinguished when subsequent target rows arrive.
  const timelineSnapshot =
    !isDraft && (lease === null || sessionLeaseReady) && snapshot?.sessionId === sessionId
      ? snapshot
      : null;
  const shareHandoverContext =
    snapshot?.sharedContextImport && "contextId" in snapshot.sharedContextImport
      ? snapshot.sharedContextImport
      : null;
  // Imported Shared Conversations: Read the public rows of the disk for the read-only block at the top of the session.
  // The shared page may be expired or not online, so only the local copy can be read and the source will not be returned.
  const [importedShare, setImportedShare] = useState<ImportedConversationShare | null>(null);
  const importedShareContextId =
    shareHandoverContext && shareHandoverContext.status !== "discarded"
      ? shareHandoverContext.contextId
      : null;
  useEffect(() => {
    if (!importedShareContextId) {
      setImportedShare(null);
      return;
    }
    let disposed = false;
    void conversationShareService
      .getImportedConversation({
        workspacePath,
        contextId: importedShareContextId,
      })
      .then((imported) => {
        if (disposed) return;
        setImportedShare(imported);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // Read-only blocks are enhanced, they will not be rendered if they cannot be read, and the session will not be interrupted.
        logger.warn("[conversation-share] failed to read the imported shared conversation", {
          error,
        });
        setImportedShare(null);
      });
    return () => {
      disposed = true;
    };
  }, [conversationShareService, importedShareContextId, workspacePath]);
  // When normalizeConversationShareMarkdown cannot find a matching name in artifactNames, it will
  // File references are replaced with empty strings (deleted directly). Without this mapping, file references in read-only blocks will disappear silently.
  const importedShareArtifactNames = useMemo(
    () =>
      new Map(
        (importedShare?.artifacts ?? []).map((artifact) => [
          artifact.artifactId,
          artifact.displayName,
        ]),
      ),
    [importedShare],
  );
  const importedShareArtifactWorkspaceRelativePaths = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const artifact of importedShare?.artifacts ?? []) {
      if (artifact.workspaceRelativePath) {
        entries.push([artifact.artifactId, artifact.workspaceRelativePath]);
      }
    }
    return new Map(entries);
  }, [importedShare]);
  useLayoutEffect(() => {
    if (
      !timelineBottomRequest ||
      timelineBottomRequest.taskId !== sessionId ||
      !importedShare ||
      importedShare.contextId !== importedShareContextId
    ) {
      return;
    }
    // Shared blocks are mounted asynchronously; requests are held until the target task and the local copy are ready, and then consumed after the layout is stable.
    const scrollToBottom = () => {
      const action = timelineScrollToBottomRef.current;
      if (!action) return false;
      action();
      return true;
    };
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToBottom();
      secondFrame = window.requestAnimationFrame(() => {
        if (!scrollToBottom()) return;
        useZCodeSessionStore
          .getState()
          .clearTimelineBottomRequest(
            workspacePath,
            timelineBottomRequest.requestId,
            workspaceIdentity,
          );
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [
    importedShare,
    importedShareContextId,
    sessionId,
    timelineBottomRequest,
    workspaceIdentity,
    workspacePath,
  ]);
  const handleOpenImportedShareUrl = useCallback(() => {
    if (!shareHandoverContext || !onOpenBrowserUrl) return;
    // What is persisted is the standard /cn/share/ path; it is localized according to the interface language when displayed/opened.
    onOpenBrowserUrl(localizeConversationShareUrl(shareHandoverContext.shareUrl));
  }, [onOpenBrowserUrl, shareHandoverContext]);
  const initialDraftConfigForDiagnostics = isDraft ? resolveInitialDraftConfig() : undefined;
  // CLI V4 projection is the only authority on running/count/manifest; renderer is no longer in spawn
  // After the event, another query is sent to splice the second status to avoid losing updates during the concurrent child's in-flight refresh.
  const subagents = snapshot?.subagents ?? EMPTY_SUBAGENT_PROJECTION;
  useEffect(() => {
    if (!sessionId || subagents.revision === 0 || !onSyncSubagentSessionTabs) return;
    onSyncSubagentSessionTabs({
      rootSessionId: rootSessionId ?? sessionId,
      parentSessionId: sessionId,
      validChildSessionIds: subagents.childSessionIds,
    });
  }, [
    onSyncSubagentSessionTabs,
    rootSessionId,
    sessionId,
    subagents.childSessionIds,
    subagents.revision,
  ]);
  useEffect(() => {
    if (!selectionSideChat || !sessionId) return;
    setSelectionSideChatBlocked(sessionId, Boolean(blockingInteractionId));
    return () => setSelectionSideChatBlocked(sessionId, false);
  }, [blockingInteractionId, selectionSideChat, sessionId]);
  const isOfficeMode = useIsOfficeMode();
  const statusPanelModel = useMemo(
    () =>
      buildConversationStatusPanelModel({
        isOfficeMode,
        workspacePath,
        gitSummary,
        gitDirtyFileCount,
        gitWorktreeChangeSummary,
        goal: selectionSideChat ? null : (snapshot?.goal ?? null),
        sessionPlans: state.sessionPlans,
        plan: snapshot?.plan ?? null,
        backgroundWorks: snapshot?.backgroundWorks ?? [],
        runningSubagents: subagents.running,
        workflowRuns: snapshot?.workflowRuns?.runs ?? [],
      }),
    [
      isOfficeMode,
      gitDirtyFileCount,
      gitSummary,
      gitWorktreeChangeSummary,
      snapshot?.backgroundWorks,
      snapshot?.goal,
      snapshot?.plan,
      snapshot?.workflowRuns,
      state.sessionPlans,
      selectionSideChat,
      subagents.running,
      workspacePath,
    ],
  );
  const runningBackgroundWorkCount =
    statusPanelModel.runningBashWorks.length +
    statusPanelModel.runningSubagentWorks.length +
    statusPanelModel.runningWorkflowRuns.length;
  const runningTerminalCount = statusPanelModel.runningBashWorks.length;
  const runningAgentCount = statusPanelModel.runningSubagentWorks.length;
  const runningWorkflowCount = statusPanelModel.runningWorkflowRuns.length;
  useEffect(() => {
    setTerminalSectionOpen(false);
    setAgentSectionOpen(false);
    setWorkflowSectionOpen(false);
  }, [sessionId]);
  useEffect(() => {
    if (runningTerminalCount === 0) {
      setTerminalSectionOpen(false);
    }
  }, [runningTerminalCount]);
  useEffect(() => {
    if (runningWorkflowCount === 0) {
      setWorkflowSectionOpen(false);
    }
  }, [runningWorkflowCount]);
  useEffect(() => {
    if (runningAgentCount === 0) {
      setAgentSectionOpen(false);
    }
  }, [runningAgentCount]);
  // composer logo direct: the only thing running is an openable
  // When the workflow run of the details page is performed, clicking on the logo directly opens its side tab, and the capsule does not move. Determine the same model that eats the capsule;
  // There is no direct access when the host does not provide onOpenWorkflowRun (the panel row is also unclickable).
  const soleRunningWorkflowRunTarget = useMemo(
    () => (onOpenWorkflowRun ? resolveSoleRunningWorkflowRunTarget(statusPanelModel) : null),
    [onOpenWorkflowRun, statusPanelModel],
  );
  const handleOpenRunningBackgroundWorks = useCallback(() => {
    if (runningBackgroundWorkCount === 0) return;
    if (soleRunningWorkflowRunTarget) {
      // Same handler as panel row: no second open path exists.
      handleOpenWorkflowRunFromPanel(soleRunningWorkflowRunTarget);
      return;
    }
    // Product rules: Composer is the entrance to all real-time activities; after the partition is split, one click still needs to expand all non-empty types.
    // However, the three blocks will remain in an independent folded state and can no longer share an open Boolean value.
    setTerminalSectionOpen(runningTerminalCount > 0);
    setAgentSectionOpen(runningAgentCount > 0);
    setWorkflowSectionOpen(runningWorkflowCount > 0);
    handleSummaryPanelVariantChange("panel");
  }, [
    handleOpenWorkflowRunFromPanel,
    handleSummaryPanelVariantChange,
    runningAgentCount,
    runningBackgroundWorkCount,
    runningTerminalCount,
    runningWorkflowCount,
    soleRunningWorkflowRunTarget,
  ]);
  const statusPanelVariant = resolveConversationStatusPanelVariant({
    variantOverride: effectiveSummaryPanelVariantOverride,
  });
  // If only the status panel knows the automatic expansion state, and timeline/composer does not adjust the layout synchronously,
  // Panel overlay content will appear in widescreen. Therefore the outer layout must also use the same expanded state.
  const shouldUseStatusPanelInlineLayout =
    !isDraft &&
    shouldUseConversationStatusPanelInlineLayout({
      hasContent: statusPanelModel.hasContent,
      variant: statusPanelVariant,
    });
  const statusPanelLayout = !shouldUseStatusPanelInlineLayout
    ? "none"
    : statusPanelVariant === "auto"
      ? "auto"
      : "inline";
  const controlLastError = snapshot?.control.lastError ?? null;
  const controlLastErrorKey = controlLastError
    ? createSessionErrorKey(snapshot?.sessionId ?? sessionId, controlLastError)
    : null;
  const projectedComposerError =
    controlLastError && controlLastErrorKey && !dismissedErrorKeys.includes(controlLastErrorKey)
      ? toComposerUiError(snapshot?.sessionId ?? sessionId, controlLastError)
      : null;
  // Official Server MCP is not available (exhausted credit / no Coding Plan): the fact comes from the structured identifier on the tool row,
  // The model quota and the model quota are two independent information channels, and only projection is done here.
  const mcpUnavailableNotice = useMemo(
    () => resolveMcpUnavailableNotice(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  const quotaBanner = useV4SessionQuotaBanner({
    sessionId: snapshot?.sessionId ?? sessionId,
    error: controlLastError,
    errorKey: controlLastErrorKey,
    phase: snapshot?.control.phase ?? null,
    providerId: snapshot?.config.provider ?? null,
    modelId: snapshot?.config.model ?? null,
    usageStatsService: baseWorkspaceServices.usageStatsService,
    mcpUnavailableNotice,
  });
  const composerError =
    draftModelReadinessError ??
    sendSubmissionError ??
    (quotaBanner.takesOverError ? null : projectedComposerError);
  useEffect(() => {
    setSendSubmissionError(null);
  }, [sessionId]);
  const handleDismissComposerError = useCallback(() => {
    if (draftModelReadinessError) {
      dismissDraftModelReadinessError();
      return;
    }
    if (sendSubmissionError) {
      setSendSubmissionError(null);
      return;
    }
    if (!controlLastErrorKey) return;
    // v4 control.lastError is the projection fact, simply closing the banner will not change the projection.
    // Only the current error fingerprint is recorded here to prevent the same error from being pushed back immediately in the next render; new errors at/message changes will still be displayed.
    setDismissedErrorKeys((keys) =>
      keys.includes(controlLastErrorKey) ? keys : [...keys.slice(-19), controlLastErrorKey],
    );
  }, [
    controlLastErrorKey,
    dismissDraftModelReadinessError,
    draftModelReadinessError,
    sendSubmissionError,
  ]);
  const handleOpenModelSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const handleOpenModelUpgrade = useCallback(() => {
    if (!codingPlanUpgradeDialog) return;
    const providerId =
      sharedSettings?.providerFamilyDomain === "bigmodel"
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    codingPlanUpgradeDialog.openCodingPlanUpgrade({ providerId });
  }, [codingPlanUpgradeDialog, sharedSettings?.providerFamilyDomain]);
  const handleOpenQuotaUpgrade = useCallback(() => {
    const providerId = quotaBanner.upgradeProviderId;
    if (!providerId || !codingPlanUpgradeDialog) return;
    const eventText = intl.formatMessage({
      id: quotaBanner.upgradeActionLabelId,
    });
    // The banner only establishes the funnel context; coding_plan_upgrade_ck is still reported uniformly after the real purchase panel is opened.
    codingPlanUpgradeDialog.openCodingPlanUpgrade({
      providerId,
      funnelContext: createCodingPlanFunnelContext({
        providerId,
        upgradeSource: "session_quota_alert",
        eventRegion: "app.session",
        eventText,
        entryPlanState: resolveCodingPlanEntryPlanState({
          providerId,
          displayStatus: "purchased",
          planLevel: "start",
        }),
      }),
    });
  }, [
    codingPlanUpgradeDialog,
    intl,
    quotaBanner.upgradeActionLabelId,
    quotaBanner.upgradeProviderId,
  ]);

  const handleConfirmShareDisclosure = useCallback(async () => {
    if (!sessionId || !shareDraft || sharePublishing) return;
    const productTurnIds = getConversationShareSelectedProductTurnIds(
      useConversationShareSelectionStore.getState(),
      sessionId,
    );
    if (productTurnIds.length === 0 || !shareTitle.trim()) return;
    const attemptKey = JSON.stringify({
      title: shareTitle.trim(),
      accessMode: shareDraft.accessMode,
      productTurnIds,
      revision: snapshot?.revision ?? null,
      logEpoch: snapshot?.logEpoch ?? null,
    });
    const shareAttempt = ensureConversationShareAttempt(
      getConversationShareDockState(useConversationShareSelectionStore.getState(), sessionId)
        .attempt,
      attemptKey,
      sessionId,
      { randomUUID: () => globalThis.crypto?.randomUUID?.() },
    );
    const operationId = `share-operation-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    let activePhase = "collecting";
    let collectedWarnings: ConversationShareDisplayWarnings | null = null;
    const progressSubscription = conversationShareService.onDynamicPublishProgress(operationId)((
      progress,
    ) => {
      activePhase = progress.phase;
      updateShareDockState(sessionId, {
        progress: progress.phase === "complete" ? "checking" : progress.phase,
        completedArtifacts: progress.completedArtifacts,
        totalArtifacts: progress.totalArtifacts,
      });
      const warnings = sanitizeConversationShareWarnings(progress.warnings);
      if (warnings.length > 0) {
        collectedWarnings = {
          issues: warnings,
          issueCount: warnings.length,
          ...(progress.omittedWarningCount
            ? { omittedIssueCount: progress.omittedWarningCount }
            : {}),
        };
      }
    });
    updateShareDockState(sessionId, {
      attempt: shareAttempt,
      publishing: true,
      progress: "collecting",
      completedArtifacts: 0,
      totalArtifacts: 0,
      publishedShareUrl: null,
      error: null,
      warnings: null,
    });
    try {
      const share = await conversationShareService.publish(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          title: shareTitle.trim(),
          accessMode: shareDraft.accessMode,
          selection: { kind: "productTurns", productTurnIds },
          clientRequestId: shareAttempt.clientRequestId,
          disclosureAcceptedAt: shareAttempt.disclosureAcceptedAt,
        },
        operationId,
      );
      const warnings = collectedWarnings as ConversationShareDisplayWarnings | null;
      updateShareDockState(sessionId, {
        publishedShareUrl: share.share_url,
        warnings,
      });
      // collectedWarnings is only assigned in the progress callback, and TS's control flow analysis cannot see cross-closure writes.
      // will narrow it to null, where the true type is explicitly restored.
      if (warnings) {
        toast(
          intl.formatMessage(
            { id: "conversationShare.publishSucceededWithSkips" },
            { count: warnings.issueCount },
          ),
        );
      } else {
        toast(intl.formatMessage({ id: "conversationShare.publishSucceeded" }));
      }
    } catch (error) {
      const details = getConversationShareErrorDetails(error);
      // Transmission errors such as 401 usually do not have server-side issues and can no longer be downgraded to general copywriting in the collecting stage.
      const resolvedMessageId = resolveConversationSharePublishErrorMessageId(error);
      const messageId =
        resolvedMessageId === "conversationShare.publishFailed" ? undefined : resolvedMessageId;
      updateShareDockState(sessionId, {
        error:
          details.issues && details.issues.length > 0
            ? {
                issues: details.issues,
                issueCount: details.issueCount ?? details.issues.length,
                omittedIssueCount: details.omittedIssueCount,
                requestId: details.requestId,
              }
            : {
                issues: [
                  {
                    code: resolveConversationShareFallbackIssueCode(details),
                    scope: "transport",
                    phase: activePhase as "collecting" | "uploading" | "checking" | "complete",
                  },
                ],
                issueCount: 1,
                requestId: details.requestId,
                messageId,
              },
      });
      logger.warn("[conversation-share] failed to publish the conversation", {
        sessionId,
        operationId,
        phase: activePhase,
        accessMode: shareDraft.accessMode,
        selectedProductTurnCount: productTurnIds.length,
        remoteWorkspace: Boolean(workspaceIdentity || remoteSessionId),
        errorName: details.name,
        kind: details.kind,
        ...(details.reasonCode === undefined ? {} : { reasonCode: details.reasonCode }),
        ...(details.diagnostics === undefined ? {} : { diagnostics: details.diagnostics }),
        ...(details.status === undefined ? {} : { status: details.status }),
        ...(details.code === undefined ? {} : { code: details.code }),
        ...(details.requestId === undefined ? {} : { requestId: details.requestId }),
      });
    } finally {
      progressSubscription.dispose();
      updateShareDockState(sessionId, { publishing: false });
    }
  }, [
    conversationShareService,
    intl,
    remoteSessionId,
    sessionId,
    shareDraft,
    sharePublishing,
    shareTitle,
    snapshot?.logEpoch,
    snapshot?.revision,
    updateShareDockState,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleCopyPublishedShare = useCallback(() => {
    if (!publishedShareUrl || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(publishedShareUrl).then(
      () => toast(intl.formatMessage({ id: "conversationShare.copySucceeded" })),
      () => toast(intl.formatMessage({ id: "conversationShare.copyFailed" })),
    );
  }, [intl, publishedShareUrl]);

  const handleOpenPublishedShare = useCallback(() => {
    if (!publishedShareUrl || !onOpenBrowserUrl) return;
    // The server saves the standard /cn/share/ path; when opening, switch the landing page path according to the current interface language.
    onOpenBrowserUrl(localizeConversationShareUrl(publishedShareUrl));
  }, [onOpenBrowserUrl, publishedShareUrl]);

  const handleCopyShareRequestId = useCallback(() => {
    const requestId = shareError?.requestId;
    if (!requestId || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "conversationShare.copyFailed" }));
      return;
    }
    void navigator.clipboard.writeText(requestId).then(
      () => toast(intl.formatMessage({ id: "conversationShare.copySucceeded" })),
      () => toast(intl.formatMessage({ id: "conversationShare.copyFailed" })),
    );
  }, [intl, shareError?.requestId]);

  const handleShareCancel = useCallback(() => {
    if (sharePublishing || !sessionId) return;
    finishShare(sessionId);
  }, [finishShare, sessionId, sharePublishing]);

  const handleShareNext = useCallback(() => {
    if (sharePublishing || !sessionId) return;
    if (
      sharePreflight.status === "idle" ||
      sharePreflight.status === "checking" ||
      sharePreflight.status === "stale" ||
      ("blockingIssues" in sharePreflight && sharePreflight.blockingIssues.length > 0)
    ) {
      return;
    }
    // The preflight warning has been displayed by the status entry of the selected Dock; shareWarnings only receives the final result of the release,
    // Avoid taking “Sharing Completed” copy into the confirmation stage where it has not yet been released.
    updateShareDockState(sessionId, { error: null });
    goToShareConfiguration(sessionId);
  }, [goToShareConfiguration, sessionId, sharePreflight, sharePublishing, updateShareDockState]);

  const handleShareSelectAll = useCallback(() => {
    if (!sessionId) return;
    setAllShareRowsSelected(sessionId, true);
    updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
  }, [sessionId, setAllShareRowsSelected, updateShareDockState]);

  const handleShareDeselectAll = useCallback(() => {
    if (!sessionId) return;
    setAllShareRowsSelected(sessionId, false);
    updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
  }, [sessionId, setAllShareRowsSelected, updateShareDockState]);

  const handleDismissShareError = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { error: null });
  }, [sessionId, updateShareDockState]);
  const handleDismissShareWarnings = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { warnings: null });
  }, [sessionId, updateShareDockState]);

  const handleDeselectShareTurn = useCallback(
    (productTurnId: string) => {
      if (!sessionId || !productTurnId) return;
      // Remove the whole round according to the product turn identity: the issue of service has productTurnId,
      // No longer use turnOrdinal to index the per-query list of the UI (the two sets of numbers will be misaligned).
      deselectShareProductTurn(sessionId, productTurnId);
      updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
    },
    [deselectShareProductTurn, sessionId, updateShareDockState],
  );

  const handleShareTitleChange = useCallback(
    (value: string) => {
      if (!sessionId) return;
      updateShareDockState(sessionId, {
        title: value,
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, updateShareDockState],
  );

  const handleShareAccessModeChange = useCallback(
    (accessMode: ConversationShareAccessMode) => {
      if (!sessionId) return;
      setShareAccessMode(sessionId, accessMode);
      updateShareDockState(sessionId, {
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, setShareAccessMode, updateShareDockState],
  );

  // The inline callback will let memo confirm that the Dock is re-rendered every time; it relies on the current session to avoid writing back the old session after switching.
  const handleShareDisclosureAcceptedChange = useCallback(
    (accepted: boolean) => {
      if (sessionId) {
        updateShareDockState(sessionId, { disclosureAccepted: accepted });
      }
    },
    [sessionId, updateShareDockState],
  );

  const handleShareBack = useCallback(() => {
    if (sharePublishing || publishedShareUrl || !sessionId) return;
    updateShareDockState(sessionId, { error: null });
    goToShareSelection(sessionId);
  }, [goToShareSelection, publishedShareUrl, sessionId, sharePublishing, updateShareDockState]);

  const handleShareConfirm = useCallback(() => {
    if (!shareDisclosureAccepted) return;
    void handleConfirmShareDisclosure();
  }, [handleConfirmShareDisclosure, shareDisclosureAccepted]);

  const handleShareSelectionToggle = useCallback(
    (rowId: number) => {
      if (sessionId) toggleShareRow(sessionId, rowId);
      if (sessionId) {
        updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
      }
    },
    [sessionId, toggleShareRow, updateShareDockState],
  );

  const handleShareSelectionInspect = useCallback(
    (target: { unitIndex: number; rowId: number }) => {
      timelineScrollToQueryRef.current?.(target);
    },
    [],
  );

  const recoverableCommand = recoverableCommands[0] ?? null;
  const handleDismissPendingRecovery = useCallback(() => {
    if (!recoverableCommand) return;
    pendingCommandRegistry.dismissRecovery(
      recoverableCommand.sessionId,
      recoverableCommand.commandId,
    );
  }, [recoverableCommand]);
  const handleResendPendingCommand = useCallback(() => {
    if (!recoverableCommand) return;
    const replay = pendingCommandRegistry.consumeReplay({
      sessionId: recoverableCommand.sessionId,
      commandId: recoverableCommand.commandId,
    });
    if (!replay) return;
    void dispatchCommand(replay.type, replay.payload, replay.sessionId, replay.baseRevision)
      .then((ack) => {
        if (
          replay.type === "createSession" &&
          (ack.status === "accepted" || ack.status === "duplicate") &&
          ack.result?.type === "createSession"
        ) {
          const originWorkspace = replay.clientContext?.workspace;
          const originWorkspaceKey =
            originWorkspace?.workspaceIdentity?.trim() || originWorkspace?.workspacePath;
          if (originWorkspaceKey && originWorkspaceKey !== workspaceKey) {
            // Defend stale UI/old closures from directly triggering cross-workspace replay; normal entries have been filtered through hooks.
            logger.error(
              "[v4-pending-command] rejected submitting a createSession recovery result across workspaces",
              {
                originWorkspaceKey,
                workspaceKey,
              },
            );
            return;
          }
          handleDraftSessionCreated(
            ack.result.sessionId,
            replay.clientContext?.groupedDraftTask,
            replay.clientContext?.sessionCreateSource,
            replay.payload.firstInput ? ack.commandId : undefined,
          );
        }
      })
      .catch((error) => {
        // The new command has been written to the registry first; if the transport fails this time, the reconciliation can be continued on the next connection.
        logger.warn("[v4-pending-command] user-confirmed resend failed", error);
      });
  }, [dispatchCommand, handleDraftSessionCreated, recoverableCommand, workspaceKey]);

  // The child tab on the right side of the subagent is the observation view; when reusing the ordinary SessionPane
  // If the composer is still created, the user will mistakenly think that they can continue input directly to the child session.
  const composerNode = readOnly ? null : (
    <ConversationComposer
      key="conversation-composer"
      // Snapshot still serves usage, routing and running status; the mode/model in the toolbar is only readable under Composer Draft.
      snapshot={snapshot}
      sessionId={sessionId}
      // The draft taskId is still null, but prewarm already has a standalone AgentRuntime.
      // Only the effective id is issued to the Skill catalog to prevent the UI from scanning new Skills that have not been loaded in the prewarm runtime.
      skillCatalogSessionId={effectiveSessionId}
      draftMode={isDraft}
      draftConfig={draftConfig}
      composerDraft={composerDraft}
      replaceComposerDraft={replaceComposerDraft}
      submissionReady={composerSubmissionReady}
      updateComposerContent={updateComposerContent}
      createSubmissionFromComposer={createSubmissionFromComposer}
      contextHeader={isDraft ? draftComposerHeader : undefined}
      centered={isDraft}
      blockingRequestId={blockingInteractionId}
      listenAddToChatEvents={focused}
      externalTextInsertRequest={focused && sessionId === null ? composerTextInsertRequest : null}
      onExternalTextInsertApplied={handleExternalTextInsertApplied}
      autoFocusEnabled={focused}
      disabled={
        connecting ||
        draftRuntimeRebuilding ||
        queueEditActiveForCurrentComposer ||
        quotaBanner.state.blocksSubmit
      }
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId ?? undefined}
      modelSelectionView={modelSelectionView}
      modelSelectionState={modelSelectionRead.state}
      modelSelectionReload={modelSelectionRead.reload}
      attachmentSessionId={effectiveSessionId}
      attachmentPut={attachmentPut}
      onRuntimeRestart={onRuntimeRestart}
      onRuntimeLifecycle={onRuntimeLifecycle}
      provider={provider}
      telemetryDraftConfig={telemetryDraftConfig}
      telemetryVisible={telemetryVisible && conversationTelemetryForegroundEnabled}
      readPlanIdentitySnapshot={readPlanIdentitySnapshot}
      onSendText={handleSendText}
      onDraftStateChange={handleComposerDraftStateChange}
      composerRestoreRequest={composerRestoreRequest}
      onComposerRestoreApplied={handleComposerRestoreApplied}
      onStop={handleStopFromButton}
      onSelectModel={handleSelectModel}
      onSelectThought={handleSelectThought}
      onSwitchMode={handleSwitchMode}
      onOpenRunningBackgroundWorks={
        sessionId && runningBackgroundWorkCount > 0 ? handleOpenRunningBackgroundWorks : undefined
      }
      backgroundWorkOpenTarget={soleRunningWorkflowRunTarget ? "workflow-run" : "panel"}
      // After the parent round ends, the directory projection of subagents.running may briefly lag behind the one still running
      // backgroundWorks; if Composer reads the directory directly, the Agent entry will be hidden in advance. Here the multiplexed status panel press
      // childSessionId is the count after accurate rollback, allowing the two entries to share the same running state truth value.
      runningSubagentCount={runningAgentCount}
      onRecoverCustomModelSelection={handleRecoverCustomModelSelection}
      onSendCompressionCommand={handleSendCompressionCommand}
      error={composerError}
      onDismissError={handleDismissComposerError}
      onOpenModelSettings={handleOpenModelSettings}
      onOpenModelUpgrade={handleOpenModelUpgrade}
      onOpenCodeViewer={onOpenCodeViewer}
      suppressGoalCommands={selectionSideChat}
      appSlashCommands={appSlashCommands}
      onDropTargetControllerChange={handleDropTargetControllerChange}
    />
  );
  const pendingGuideProjection = snapshot ? projectPendingGuideQueue(snapshot.queue) : null;
  const conversationBottomDockContent = readOnly ? null : shareActive && sessionId ? (
    shareInSelectionStage ? (
      <ConversationShareSelectionDock
        selectedCount={selectedShareRowIds.size}
        totalCount={eligibleShareItems.length}
        pending={sharePublishing}
        preflight={sharePreflight}
        onCancel={handleShareCancel}
        onNext={handleShareNext}
        onSelectAll={handleShareSelectAll}
        onDeselectAll={handleShareDeselectAll}
        onDeselectTurn={handleDeselectShareTurn}
        onRetryPreflight={retrySharePreflight}
      />
    ) : publishedShareUrl ? (
      <ConversationShareSuccessDock
        title={shareTitle}
        warnings={shareWarnings}
        onOpen={handleOpenPublishedShare}
        onCopy={handleCopyPublishedShare}
        onDismiss={handleShareCancel}
      />
    ) : (
      <ConversationShareConfirmationDock
        selectedCount={selectedShareProductTurnIds.length}
        totalCount={eligibleShareProductTurnIds.length}
        title={shareTitle}
        accessMode={shareDraft?.accessMode ?? DEFAULT_CONVERSATION_SHARE_ACCESS_MODE}
        progressLabel={intl.formatMessage({
          id:
            shareProgress === "uploading"
              ? "conversationShare.progress.uploading"
              : shareProgress === "checking"
                ? "conversationShare.progress.checking"
                : "conversationShare.progress.collecting",
        })}
        progressPhase={shareProgress}
        completedArtifacts={shareCompletedArtifacts}
        totalArtifacts={shareTotalArtifacts}
        pending={sharePublishing}
        error={shareError}
        warnings={shareWarnings}
        onDismissError={handleDismissShareError}
        onDismissWarnings={handleDismissShareWarnings}
        onCopyRequestId={handleCopyShareRequestId}
        onDeselectTurn={handleDeselectShareTurn}
        onTitleChange={handleShareTitleChange}
        onAccessModeChange={handleShareAccessModeChange}
        disclosureAccepted={shareDisclosureAccepted}
        onDisclosureAcceptedChange={handleShareDisclosureAcceptedChange}
        onCancel={handleShareCancel}
        onBack={handleShareBack}
        onConfirm={handleShareConfirm}
      />
    )
  ) : (
    <>
      {quotaBanner.state.visible &&
      !quotaBanner.dismissed &&
      (!projectedComposerError || quotaBanner.takesOverError || quotaBanner.state.blocksSubmit) ? (
        <ConversationQuotaBanner
          state={quotaBanner.state}
          onShown={quotaBanner.markShown}
          upgradeActionLabelId={quotaBanner.upgradeActionLabelId}
          onUpgrade={
            quotaBanner.upgradeProviderId && codingPlanUpgradeDialog
              ? handleOpenQuotaUpgrade
              : undefined
          }
          onDismiss={quotaBanner.dismiss}
        />
      ) : null}
      {recoverableCommand ? (
        <PendingCommandRecoveryBanner
          entry={recoverableCommand}
          onResend={
            recoverableCommand.replay.kind === "input" ? handleResendPendingCommand : undefined
          }
          onDismiss={handleDismissPendingRecovery}
        />
      ) : null}
      {sessionId && snapshot?.workspaceHookAdmission ? (
        <WorkspaceHookPendingBanner
          sessionId={sessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          admission={snapshot.workspaceHookAdmission}
        />
      ) : null}
      {sessionId && snapshot ? (
        <ConversationQueuePanel
          key="conversation-queue"
          queue={pendingGuideProjection?.visibleQueue ?? snapshot.queue}
          onDeleteItem={handleDeleteQueueItem}
          onEditItem={handleEditQueueItem}
          pendingEditQueueItemId={
            queueEditActiveForCurrentComposer ? queueEditOperation.queueItemId : null
          }
          onSendNow={handleSendQueuedNow}
          onMoveItem={handleReorderQueueItem}
          onResume={handleResumeQueue}
        />
      ) : null}
      {/*
          The v4 permission/question waiting state is only a blocking interaction of the runtime, so
          it must share the timeline bottom dock with the composer; rendering it in the SessionPane
          outer layer would break out of the main column's width and crowd out the lower half of the
          screen.
          */}
      {sessionId && snapshot ? (
        <V4InteractionDialogs
          key="conversation-interactions"
          sessionId={sessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          provider={provider}
          snapshot={snapshot}
        />
      ) : null}
      {composerNode}
      {/* Office mode shows proactive task recommendations; coding mode keeps the original small scenario entry point. */}
      {isDraft && (!isOfficeMode || sharedSettings?.proactiveSuggestionsEnabled === true) ? (
        <ConversationDraftSuggestedPromptsContainer
          className={isOfficeMode ? "mt-4" : "mt-6"}
          proactive={isOfficeMode}
          onOpenAutomations={
            onOpenAutomationsMain
              ? (automationTab) => onOpenAutomationsMain(undefined, automationTab)
              : undefined
          }
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isDesktop={isDesktop}
        />
      ) : null}
    </>
  );
  // When entering/exiting sharing, the chat dock and the sharing dock have different heights; sharing the same grid unit allows for up and down displacement fade-in and fade-out.
  // Avoid hard jumps caused by parent height mutations. prefers-reduced-motion is internally downgraded to immediate switching by the transition component.
  const conversationBottomDock = conversationBottomDockContent ? (
    <ConversationBottomDockTransition mode={shareActive && sessionId ? "confirmation" : "chat"}>
      {conversationBottomDockContent}
    </ConversationBottomDockTransition>
  ) : null;

  return (
    <div
      data-testid={testId(TID_V4_SESSION_PANE, paneId)}
      data-session-id={sessionId ?? "draft"}
      data-initial-draft-provider={initialDraftConfigForDiagnostics?.provider ?? ""}
      data-initial-draft-model={initialDraftConfigForDiagnostics?.model ?? ""}
      data-projection-seq={snapshot?.seq ?? ""}
      data-running-subagent-ids={subagents.running.map((item) => item.childSessionId).join(",")}
      data-running-subagent-work-ids={(snapshot?.backgroundWorks ?? [])
        .filter((work) => work.kind === "subagent" && work.status === "running")
        .map((work) => work.childSessionId ?? work.workId)
        .join(",")}
      data-v4-conversation-drop-target="true"
      onDragOver={effectiveDropTargetController?.onDragOver}
      onDragLeave={effectiveDropTargetController?.onDragLeave}
      onDrop={effectiveDropTargetController?.onDrop}
      className="relative flex h-full min-h-0 flex-col"
    >
      {effectiveDropTargetController?.active ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-accent/55 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
            <Hand className="size-4 text-foreground" />
            <span>
              {intl.formatMessage({
                id:
                  effectiveDropTargetController.kind === "workspace"
                    ? "chat.composer.workspaceFileDragHint"
                    : "chat.attachments.dragHint",
              })}
            </span>
          </div>
        </div>
      ) : null}
      <ConversationHeader
        title={snapshot?.meta.title ?? ""}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onClosePane={onClosePane}
        workspaceBadge={workspaceBadge}
      />

      <div
        ref={conversationLayoutContainerRef}
        className="@container/conversation relative flex min-h-0 flex-1 flex-col"
      >
        <ConversationShareSelectionScrim
          visible={shareSelectionPanelVisible}
          interactive
          onBackdropClick={dismissShareSelectionPanel}
        />
        <ConversationShareSelectionPanel
          visible={shareSelectionPanelVisible}
          items={shareItems}
          selectedRowIds={selectedShareRowIds}
          onToggle={handleShareSelectionToggle}
          onInspect={handleShareSelectionInspect}
        />
        {shareActive && shareInSelectionStage && shareDraft?.view === "timeline" && sessionId ? (
          <ConversationShareSelectionReopenTab onOpen={() => showShareSelectionPanel(sessionId)} />
        ) : null}
        {!isDraft ? (
          <ConversationStatusPanel
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            gitSummary={gitSummary}
            gitDirtyFileCount={gitDirtyFileCount}
            gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
            gitWorktreeChangeSummary={gitWorktreeChangeSummary}
            activeTaskChangeSummary={activeTaskChangeSummary}
            goal={selectionSideChat ? null : (snapshot?.goal ?? null)}
            sessionPlans={state.sessionPlans}
            plan={snapshot?.plan ?? null}
            backgroundWorks={snapshot?.backgroundWorks ?? []}
            runningSubagents={subagents.running}
            workflowRuns={snapshot?.workflowRuns?.runs ?? []}
            endedSubagentCount={subagents.endedTotal}
            rootSessionId={rootSessionId ?? sessionId ?? undefined}
            parentSessionId={sessionId ?? undefined}
            layoutMode={statusPanelLayout}
            summaryPanelVariantOverride={effectiveSummaryPanelVariantOverride}
            onVariantChange={handleSummaryPanelVariantChange}
            terminalSectionOpen={terminalSectionOpen}
            onTerminalSectionOpenChange={setTerminalSectionOpen}
            agentSectionOpen={agentSectionOpen}
            onAgentSectionOpenChange={setAgentSectionOpen}
            workflowSectionOpen={workflowSectionOpen}
            onWorkflowSectionOpenChange={setWorkflowSectionOpen}
            onRefreshGit={onRefreshGit}
            onOpenGitReview={onOpenGitReview}
            onPauseGoal={
              !readOnly && !selectionSideChat && snapshot?.availability.pauseGoal.allowed
                ? handlePauseGoal
                : undefined
            }
            onResumeGoal={
              !readOnly && !selectionSideChat && snapshot?.availability.resumeGoal.allowed
                ? handleResumeGoal
                : undefined
            }
            onOpenPlanDetail={onOpenPlanDetail ? handleOpenPlanDetail : undefined}
            onOpenBackgroundBash={
              onOpenBackgroundBash && sessionId
                ? (work) =>
                    onOpenBackgroundBash({
                      workspacePath,
                      workspaceIdentity: workspaceIdentity ?? undefined,
                      remoteSessionId: remoteSessionId ?? undefined,
                      rootSessionId: rootSessionId ?? sessionId,
                      sessionId,
                      workId: work.workId,
                      title: work.title,
                    })
                : undefined
            }
            onCancelBackgroundWork={readOnly ? undefined : handleCancelBackgroundWork}
            onOpenSubagentSession={onOpenSubagentSession ? handleOpenSubagentSession : undefined}
            onOpenSubagentDirectory={
              onOpenSubagentDirectory ? handleOpenSubagentDirectory : undefined
            }
            onOpenWorkflowRun={
              onOpenWorkflowRun && sessionId ? handleOpenWorkflowRunFromPanel : undefined
            }
            endedWorkflowRunCount={endedWorkflowRunCount}
            onOpenWorkflowRunDirectory={
              onOpenWorkflowRunDirectory ? handleOpenWorkflowRunDirectoryFromPanel : undefined
            }
          />
        ) : null}

        {readOnly && controlLastError ? (
          <div
            role="alert"
            data-testid="v4-subagent-readonly-error"
            className="mx-4 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2 text-ui-base text-[var(--color-danger)]"
          >
            {controlLastError.message}
          </div>
        ) : null}

        {errored ? (
          <SessionSubscriptionErrorPanel
            error={state.lastError ?? intl.formatMessage({ id: "chat.error.connectionLost" })}
            sessionId={sessionId}
            workspacePath={workspacePath}
            onReconnect={handleRetrySubscribe}
          />
        ) : (
          <SessionPluginReferenceIconBoundary
            enabled={pluginReferenceIconsEnabled}
            remoteSessionId={remoteSessionId}
            sessionId={sessionId}
            workspaceIdentity={workspaceIdentity}
            workspacePath={workspacePath}
          >
            <ConversationTimeline
              scrollToBottomActionRef={timelineScrollToBottomRef}
              scrollToQueryActionRef={timelineScrollToQueryRef}
              selectionPanelLayoutContainerRef={conversationLayoutContainerRef}
              rows={timelineSnapshot?.rows.window ?? []}
              pendingGuides={timelineSnapshot ? pendingGuideProjection?.pendingGuides : []}
              apiRetry={timelineSnapshot?.control.apiRetry ?? null}
              totalCount={timelineSnapshot?.rows.totalCount ?? 0}
              sessionKey={sessionId ?? "draft"}
              scrollMemoryKey={timelineScrollMemoryKey}
              rowContext={rowContext}
              onFork={forkActionsEnabled ? handleFork : undefined}
              onRetry={retryActionsEnabled ? handleRetry : undefined}
              onFeedbackChange={
                !readOnly && !selectionSideChat && sessionId ? handleAssistantFeedback : undefined
              }
              onEdit={editActionsEnabled ? handleEdit : undefined}
              canLoadOlder={timelineSnapshot ? hasOlderRows(timelineSnapshot) : false}
              loadingOlder={timelineSnapshot ? state.loadingOlder : false}
              onLoadOlder={handleLoadOlder}
              onLoadAllOlder={handleLoadAllOlder}
              turnNavigatorDirectoryRevision={state.turnNavigatorDirectoryRevision}
              bottomDock={conversationBottomDock}
              hideTurnNavigator={shareActive && shareInSelectionStage}
              backgroundScrollLocked={resolveConversationShareBackgroundScrollLocked({
                partialShareActive: shareActive,
                stage: shareDraft?.stage ?? "selection",
                view: shareDraft?.view,
              })}
              headerSlot={
                // unsupportedRowCount also opens this door: when the rows of the entire copy are skipped by this build
                // rows is empty, but the read-only block must be left to display "ZCode needs to be updated", and the entire block cannot disappear.
                importedShare &&
                (importedShare.rows.length > 0 || importedShare.unsupportedRowCount > 0) ? (
                  <ConversationShareImportNotice
                    rows={importedShare.rows}
                    unsupportedRowCount={importedShare.unsupportedRowCount}
                    artifactNames={importedShareArtifactNames}
                    artifactWorkspaceRelativePaths={importedShareArtifactWorkspaceRelativePaths}
                    workspacePath={workspacePath}
                    {...(workspaceIdentity ? { workspaceIdentity } : {})}
                    {...(remoteSessionId ? { workspaceRemoteSessionId: remoteSessionId } : {})}
                    locale="en-US"
                    codePreviewSettings={codePreviewSettings}
                    onOpenShareUrl={onOpenBrowserUrl ? handleOpenImportedShareUrl : undefined}
                    onOpenFileLink={onOpenFileLink}
                    onOpenCodeViewer={onOpenCodeViewer}
                  />
                ) : null
              }
              emptyState={
                isDraft ? (
                  <div data-testid={TID_CHAT_EMPTY} className="w-full">
                    <ConversationDraftEmptyState />
                  </div>
                ) : null
              }
              centerEmptyStateWithDock={isDraft}
              summaryPanelLayout={statusPanelLayout}
              conversationFindQuery={!isDraft && focused ? conversationFindQuery : ""}
              conversationFindActiveIndex={!isDraft && focused ? conversationFindActiveIndex : -1}
              conversationFindNavigationRequestId={
                !isDraft && focused ? conversationFindNavigationRequestId : 0
              }
              onConversationFindMatchStateChange={
                !isDraft && focused ? onConversationFindMatchStateChange : undefined
              }
              searchResultHighlightRequest={isDraft ? null : searchResultHighlightRequest}
              onSearchResultHighlightDone={onSearchResultHighlightDone}
              sessionPhase={isDraft ? undefined : snapshot?.control.phase}
              shareSelection={
                shareActive && shareInSelectionStage && shareDraft?.view === "timeline" && sessionId
                  ? {
                      eligibleRowIds: eligibleShareRowIds,
                      selectedRowIds: selectedShareRowIds,
                      onToggle: handleShareSelectionToggle,
                    }
                  : undefined
              }
              selectionActions={
                !isDraft && sessionId && !readOnly && !selectionSideChat
                  ? {
                      enabled: resolveConversationSelectionTooltipEnabled({
                        selectionActionsEnabled: focused && !blockingInteractionId,
                        partialShareActive: shareActive,
                      }),
                      sideActionDisabled: selectionSideActionBlocked,
                      onAddToCurrentTask: handleAddSelectionToCurrentTask,
                      onAskInSideChat: handleOpenSelectionSideConversation,
                    }
                  : undefined
              }
            />
          </SessionPluginReferenceIconBoundary>
        )}
      </div>
    </div>
  );
}
