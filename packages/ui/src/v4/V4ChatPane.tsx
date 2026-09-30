import type { ReactNode } from "react";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type {
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { V4ConversationProvider } from "@/v4/V4ConversationContext.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { SessionOpenTrigger } from "@/lib/sessionOpenArmsTelemetry.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

interface V4ChatPaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Prompt template telemetry currently covers Desktop only. */
  isDesktop?: boolean;
  readOnly?: boolean;
  /** CLI session id; null = the first send from a draft. */
  sessionId: string | null;
  /**
   * The open entry point of the main pane in the current workspace; when not provided, the sidebar
   * count is used.
   */
  openTrigger?: SessionOpenTrigger;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  /** deleteSession: after deleting the current conversation, go back to draft. */
  onSessionDeleted?: () => void;
  /** The draft-state composer contextHeader (m5, constructed and dispatched by the shell). */
  draftComposerHeader?: ReactNode;
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
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

/**
 * Vertical-slice chat area: the minimal entry point replacing ChatView. The outer layer wraps
 * V4ConversationProvider per workspace; for a single pane the paneId is fixed to workspace-main.
 */
export function V4ChatPane({
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
  readOnly = false,
  sessionId,
  openTrigger = "sidebar",
  provider,
  onSessionCreated,
  onSessionDeleted,
  draftComposerHeader,
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
}: V4ChatPaneProps) {
  return (
    <V4ConversationProvider workspacePath={workspacePath} workspaceIdentity={workspaceIdentity}>
      <SessionPane
        paneId="workspace-main"
        readOnly={readOnly}
        sessionId={sessionId}
        openTrigger={openTrigger}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        isDesktop={isDesktop}
        provider={provider}
        onSessionCreated={onSessionCreated}
        onSessionDeleted={onSessionDeleted}
        draftComposerHeader={draftComposerHeader}
        gitSummary={gitSummary}
        gitDirtyFileCount={gitDirtyFileCount}
        gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
        gitWorktreeChangeSummary={gitWorktreeChangeSummary}
        activeTaskChangeSummary={activeTaskChangeSummary}
        summaryPanelVariantOverride={summaryPanelVariantOverride}
        onSummaryPanelVariantOverrideChange={onSummaryPanelVariantOverrideChange}
        onRefreshGit={onRefreshGit}
        onOpenGitReview={onOpenGitReview}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenAutomationsMain={onOpenAutomationsMain}
        onOpenCodeViewer={onOpenCodeViewer}
        onAutoOpenAssistantPptx={onAutoOpenAssistantPptx}
        onOpenFileLink={onOpenFileLink}
        onOpenSubagentSession={onOpenSubagentSession}
        onOpenBackgroundBash={onOpenBackgroundBash}
        onOpenSubagentDirectory={onOpenSubagentDirectory}
        onSyncSubagentSessionTabs={onSyncSubagentSessionTabs}
        onOpenPlanDetail={onOpenPlanDetail}
        onOpenWorkflowRun={onOpenWorkflowRun}
        onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        onOpenWorkflowRunDirectory={onOpenWorkflowRunDirectory}
        onOpenWorkflowActorSession={onOpenWorkflowActorSession}
        onOpenWorkflowWorkspace={onOpenWorkflowWorkspace}
        conversationFindQuery={conversationFindQuery}
        conversationFindActiveIndex={conversationFindActiveIndex}
        conversationFindNavigationRequestId={conversationFindNavigationRequestId}
        onConversationFindMatchStateChange={onConversationFindMatchStateChange}
        searchResultHighlightRequest={searchResultHighlightRequest}
        onSearchResultHighlightDone={onSearchResultHighlightDone}
      />
    </V4ConversationProvider>
  );
}
