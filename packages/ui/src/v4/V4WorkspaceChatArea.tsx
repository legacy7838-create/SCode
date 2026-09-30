/* oxlint-disable eslint(max-lines) -- V4WorkspaceChatArea is the split-pane workbench host and
 * centrally manages pane layout/focus/session binding; splitting it would make the store-action and
 * shell-binding chains hop across files.
 */
import { useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
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
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  effectiveFocusedPaneId,
  MAX_WORKBENCH_PANES,
  paneWorkspaceKey,
  PRIMARY_LEAF,
  usePaneLayoutStore,
  V4_PRIMARY_PANE_ID,
  type PaneSplitSide,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";
import { collectWorkbenchLayout, dividerStyle, SPLIT_VAR_PREFIX } from "@/v4/workbenchLayout.js";
import { WorkbenchLeafPane, type WorkbenchShellBinding } from "@/v4/WorkbenchPane.js";
import { WorkbenchSplitDivider } from "@/v4/WorkbenchSplitDivider.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  closeWorkbenchGroupPane,
  selectWorkbenchGroupActiveBinding,
  selectWorkbenchGroupPaneBinding,
  useWorkbenchGroupStore,
  type WorkbenchSessionBinding,
} from "@/v4/workbenchGroupStore.js";
import type { WorkbenchSessionDragPayload } from "@/v4/workbenchDragDrop.js";
import {
  canPlaceWorkbenchSessionInSplit,
  placeWorkbenchSessionInSplit,
  type WorkbenchSessionTarget,
} from "@/v4/workbenchSessionPlacement.js";

function dragPayloadSessionTarget(payload: WorkbenchSessionDragPayload): WorkbenchSessionTarget {
  return {
    workspacePath: payload.workspacePath,
    ...(payload.workspaceIdentity?.trim() ? { workspaceIdentity: payload.workspaceIdentity } : {}),
    ...(payload.remoteSessionId ? { remoteSessionId: payload.remoteSessionId } : {}),
    sessionId: payload.sessionId,
  };
}

interface V4WorkspaceChatAreaProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /**
   * Prompt-template telemetry currently covers Desktop only; Web / phone remote control keep the UI
   * behavior but do not fire the event.
   */
  isDesktop?: boolean;
  readOnly?: boolean;
  /**
   * False while an overlay such as Settings is open; a hidden Pane must not consume the one-shot
   * Composer request.
   */
  foregroundEnabled?: boolean;
  remoteSessionId?: string;
  /**
   * The CLI session bound to the primary pane (the existing selection state activeTaskId); null =
   * draft.
   */
  sessionId: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  /**
   * After createSession/fork in the primary pane, join the existing selection path
   * (handleSelectTask).
   */
  onSessionCreated?: (sessionId: string) => void;
  /** After the primary pane's session is deleted, go back to draft (the shell starts a new draft). */
  onSessionDeleted?: () => void;
  /**
   * The draft-state composer contextHeader (m5: workspace menu + Git branch), passed down to the
   * primary pane only — a draft in any other pane does not carry the shell-level workspace switch.
   */
  draftComposerHeader?: ReactNode;
  /** The desktop lightweight draft title bar reuses the main draft composer's drop controller. */
  onPrimaryDraftDropTargetControllerChange?: (
    controller: ConversationDropTargetController | null,
  ) => void;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onPaneActiveSessionChange?: (scope: PaneWorkspaceScope, sessionId: string) => void;
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
 * The split-pane workspace main chat area: a multi-pane cross-workspace workbench
 *
 * - Layout: the paneLayoutStore binary split tree → absolutely positioned rects (CSS variables
 *   drive the proportions); leaves render flat (key = paneId), and splitting or closing never
 *   remounts any surviving pane.
 * - Data plane: one V4PaneConversationProvider per pane — connections are reused through
 *   workspaceConnectionRegistry with reference counting by endpoint+workspaceKey (panes in the same
 *   workspace share one transport + SessionDataLayer).
 * - The primary pane binding keeps using activeTaskId (shell props, following the workspace tab
 *   switch); the other pane bindings belong to paneLayoutStore, which carries its own
 *   workspaceScope and persists across tabs.
 * - Focus layer: shortcuts (Esc stop) / add-to-chat are routed only to the focused pane.
 * - Restore guard: each restoredUnvalidated pane is validated through the sessions-index of its own
 *   scope.
 */
export function V4WorkspaceChatArea({
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
  readOnly = false,
  foregroundEnabled = true,
  remoteSessionId,
  sessionId,
  activeSelectionSideChatSessionId = null,
  provider,
  onSessionCreated,
  onSessionDeleted,
  draftComposerHeader,
  onPrimaryDraftDropTargetControllerChange,
  gitSummary,
  gitDirtyFileCount,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  onRefreshGit,
  onOpenGitReview,
  onPaneActiveSessionChange,
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
}: V4WorkspaceChatAreaProps) {
  const shellWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  // The selector returns the existing reference/derivative primitive in the store. If it is unchanged, it will not trigger re-rendering.
  const paneRoot = usePaneLayoutStore((state) => state.root);
  const paneBindings = usePaneLayoutStore((state) => state.panes);
  const paneFocusedPaneId = usePaneLayoutStore((state) => effectiveFocusedPaneId(state));
  // zustand action reference is stable.
  const splitPaneAction = usePaneLayoutStore((state) => state.splitPane);
  const closePaneAction = usePaneLayoutStore((state) => state.closePane);
  const confirmRestoredPaneSessionAction = usePaneLayoutStore(
    (state) => state.confirmRestoredPaneSession,
  );
  const focusPaneAction = usePaneLayoutStore((state) => state.focusPane);
  const bindPaneSessionAction = usePaneLayoutStore((state) => state.bindPaneSession);
  const setSplitRatioAction = usePaneLayoutStore((state) => state.setSplitRatio);
  const resetPaneLayoutAction = usePaneLayoutStore((state) => state.resetToPrimaryPane);
  const activeGroup = useWorkbenchGroupStore((state) =>
    state.activeGroupId ? (state.groups[state.activeGroupId] ?? null) : null,
  );
  const focusGroupPaneAction = useWorkbenchGroupStore((state) => state.focusPane);
  const closeGroupPaneAction = useWorkbenchGroupStore((state) => state.closePane);
  const confirmRestoredGroupPaneSessionAction = useWorkbenchGroupStore(
    (state) => state.confirmRestoredPaneSession,
  );
  const bindGroupPaneSessionAction = useWorkbenchGroupStore((state) => state.bindPaneSession);
  const setGroupSplitRatioAction = useWorkbenchGroupStore((state) => state.setSplitRatio);
  const promotePaneLayoutToGroupAction = useWorkbenchGroupStore(
    (state) => state.promotePaneLayoutToGroup,
  );

  const containerRef = useRef<HTMLDivElement | null>(null);

  const root = activeGroup?.root ?? paneRoot;
  const panes = activeGroup?.panes ?? paneBindings;
  const focusedPaneId = activeGroup?.focusedPaneId ?? paneFocusedPaneId;
  const layout = useMemo(() => collectWorkbenchLayout(root), [root]);
  const shellSessionOwnedBySplitPane = useMemo(() => {
    if (activeGroup || !sessionId) {
      return false;
    }
    return Object.values(paneBindings).some(
      (binding) =>
        binding.sessionId === sessionId &&
        paneWorkspaceKey(binding.workspaceScope) === shellWorkspaceKey,
    );
  }, [activeGroup, paneBindings, sessionId, shellWorkspaceKey]);
  // primary draft does not have its own sessionId; shell active when dragging into session
  // The session in the right pane may have been cut, and this sessionId can no longer be sent to the primary.
  const primaryPaneSessionId = shellSessionOwnedBySplitPane ? null : sessionId;

  // Proportional wiring: The store value only changes when submitting (pointerup/restore); the CSS variable is written directly by the separator bar during dragging.
  const containerStyle = useMemo<CSSProperties>(() => {
    const style: Record<string, string> = {};
    for (const divider of layout.dividers) {
      style[`${SPLIT_VAR_PREFIX}${divider.splitId}`] = String(divider.ratio);
    }
    return style as CSSProperties;
  }, [layout]);

  const paneCount = layout.leaves.length;
  const showFocusIndicator = paneCount > 1;
  const canSplit = paneCount < MAX_WORKBENCH_PANES;

  const shellScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, workspacePath, workspaceIdentity],
  );
  const placementShellBinding = useMemo<WorkbenchSessionBinding | null>(
    () =>
      primaryPaneSessionId ? { workspaceScope: shellScope, sessionId: primaryPaneSessionId } : null,
    [primaryPaneSessionId, shellScope],
  );

  const shell = useMemo<WorkbenchShellBinding>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      isDesktop,
      readOnly,
      sessionId: primaryPaneSessionId,
      // primaryPaneSessionId is deliberately left blank when the active task is taken over by split pane.
      // Auxiliary conversation routing still needs to retain the real active task id of the shell.
      activeSessionId: sessionId,
      activeSelectionSideChatSessionId,
      provider,
      onSessionCreated,
      onSessionDeleted,
      draftComposerHeader,
      onPrimaryDraftDropTargetControllerChange,
      gitSummary,
      gitDirtyFileCount,
      gitWorktreeReviewSourceId,
      gitWorktreeChangeSummary,
      activeTaskChangeSummary: primaryPaneSessionId ? activeTaskChangeSummary : null,
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
      conversationFindQuery,
      conversationFindActiveIndex,
      conversationFindNavigationRequestId,
      onConversationFindMatchStateChange,
      searchResultHighlightRequest,
      onSearchResultHighlightDone,
    }),
    [
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      isDesktop,
      readOnly,
      primaryPaneSessionId,
      activeSelectionSideChatSessionId,
      provider,
      onSessionCreated,
      onSessionDeleted,
      draftComposerHeader,
      onPrimaryDraftDropTargetControllerChange,
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
      conversationFindQuery,
      conversationFindActiveIndex,
      conversationFindNavigationRequestId,
      onConversationFindMatchStateChange,
      searchResultHighlightRequest,
      onSearchResultHighlightDone,
    ],
  );

  const resolvePaneSessionBinding = useMemo(
    () =>
      (paneId: string): WorkbenchSessionBinding | null => {
        if (activeGroup) {
          return selectWorkbenchGroupPaneBinding(activeGroup, paneId);
        }
        if (paneId === V4_PRIMARY_PANE_ID) {
          return primaryPaneSessionId
            ? { workspaceScope: shellScope, sessionId: primaryPaneSessionId }
            : null;
        }
        const binding = paneBindings[paneId];
        return binding?.sessionId
          ? {
              workspaceScope: binding.workspaceScope,
              sessionId: binding.sessionId,
              ...(binding.readOnly ? { readOnly: true } : {}),
            }
          : null;
      },
    [activeGroup, paneBindings, primaryPaneSessionId, shellScope],
  );

  const syncShellActiveSession = useCallback(
    (binding: WorkbenchSessionBinding | null) => {
      if (!binding || binding.readOnly) {
        return;
      }
      // readOnly subagent pane is only the observation view within the workbench, not the left side
      // task navigation target; writing shell activeTaskId backward will cause the highlighted/optimistic task on the left to switch to the child by mistake.
      onPaneActiveSessionChange?.(binding.workspaceScope, binding.sessionId);
    },
    [onPaneActiveSessionChange],
  );

  const handleFocusRequest = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        focusGroupPaneAction(activeGroup.id, paneId);
      } else {
        focusPaneAction(paneId);
      }
      syncShellActiveSession(resolvePaneSessionBinding(paneId));
    },
    [
      activeGroup,
      focusGroupPaneAction,
      focusPaneAction,
      resolvePaneSessionBinding,
      syncShellActiveSession,
    ],
  );

  const handleClosePane = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        const nextGroup = closeWorkbenchGroupPane(activeGroup, paneId);
        const nextActiveBinding =
          activeGroup.focusedPaneId === paneId
            ? nextGroup
              ? selectWorkbenchGroupActiveBinding(nextGroup)
              : paneId === V4_PRIMARY_PANE_ID
                ? null
                : activeGroup.primaryBinding
            : null;
        closeGroupPaneAction(activeGroup.id, paneId);
        // close store is only responsible for layout collapse; if the closed pane is a focused pane,
        // The shell activeTaskId must return to the navigable session after closing and cannot continue to stay in the closed session.
        syncShellActiveSession(nextActiveBinding);
      } else {
        const nextActiveBinding =
          focusedPaneId === paneId && primaryPaneSessionId
            ? { workspaceScope: shellScope, sessionId: primaryPaneSessionId }
            : null;
        closePaneAction(paneId);
        syncShellActiveSession(nextActiveBinding);
      }
    },
    [
      activeGroup,
      closeGroupPaneAction,
      closePaneAction,
      focusedPaneId,
      primaryPaneSessionId,
      shellScope,
      syncShellActiveSession,
    ],
  );

  const handleConfirmRestoredSession = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        confirmRestoredGroupPaneSessionAction(activeGroup.id, paneId);
      } else {
        confirmRestoredPaneSessionAction(paneId);
      }
    },
    [activeGroup, confirmRestoredGroupPaneSessionAction, confirmRestoredPaneSessionAction],
  );

  const handleCommitSplitRatio = useMemo(
    () => (splitId: string, ratio: number) => {
      if (activeGroup) {
        setGroupSplitRatioAction(activeGroup.id, splitId, ratio);
      } else {
        setSplitRatioAction(splitId, ratio);
      }
    },
    [activeGroup, setGroupSplitRatioAction, setSplitRatioAction],
  );

  const handleBindSession = useMemo(
    () => (paneId: string, createdSessionId: string) => {
      if (activeGroup) {
        bindGroupPaneSessionAction(activeGroup.id, paneId, createdSessionId);
        return true;
      }
      if (paneId === V4_PRIMARY_PANE_ID) {
        const sourceLayout = usePaneLayoutStore.getState();
        if (Object.keys(sourceLayout.panes).length > 0) {
          // The draft primary itself is not in paneLayout.panes. After first accepted, if only let
          // The shell remembers the new session, and the focused secondary will overwrite the shell activeTaskId.
          // The primary then loses its identity and returns to draft. Here first use the new session as the primaryBinding
          // The visible layout is atomically promoted, and the shell active is synchronized by the upper layer. Both panes have stable owners.
          const promoted = promotePaneLayoutToGroupAction(
            { workspaceScope: shellScope, sessionId: createdSessionId },
            sourceLayout,
          );
          if (promoted) {
            resetPaneLayoutAction();
            logger.info("[v4-workbench] primary draft promoted to session group", {
              createdSessionId,
              workspaceKey: paneWorkspaceKey(shellScope),
            });
          }
        }
        return true;
      }
      bindPaneSessionAction(paneId, createdSessionId);
      if (!sessionId) {
        return false;
      }
      // If a non-primary draft is launched, a new session will be generated first; if it is directly
      // Reverse shell activeTaskId, primary pane is still driven by shell.sessionId,
      // A new session will be displayed on the right. First promote the current paneLayout to group,
      // Use primaryBinding to fix the original session, and then allow shell active to follow the new pane.
      const promoted = promotePaneLayoutToGroupAction(
        { workspaceScope: shellScope, sessionId },
        usePaneLayoutStore.getState(),
      );
      if (promoted) {
        // Promotion is a transfer of layout owner, not double writing after copying. group already holds the complete
        // Consume the source immediately after workspace scope/binding to avoid resurrecting the old split during refresh or group GC.
        resetPaneLayoutAction();
      }
      return promoted;
    },
    [
      activeGroup,
      bindGroupPaneSessionAction,
      bindPaneSessionAction,
      promotePaneLayoutToGroupAction,
      resetPaneLayoutAction,
      sessionId,
      shellScope,
    ],
  );

  const canDropSession = useCallback(
    (payload: WorkbenchSessionDragPayload) => {
      return canPlaceWorkbenchSessionInSplit(
        placementShellBinding,
        dragPayloadSessionTarget(payload),
        { mode: "drag", side: "right" },
      );
    },
    [placementShellBinding],
  );

  const handleDropSession = useCallback(
    (paneId: string, side: PaneSplitSide, payload: WorkbenchSessionDragPayload) => {
      placeWorkbenchSessionInSplit(placementShellBinding, dragPayloadSessionTarget(payload), {
        anchorPaneId: paneId,
        mode: "drag",
        side,
      });
    },
    [placementShellBinding],
  );

  return (
    <div ref={containerRef} style={containerStyle} className="relative h-full min-h-0 w-full">
      {layout.leaves.map((leaf) => (
        <WorkbenchLeafPane
          key={leaf.paneId}
          paneId={leaf.paneId}
          rect={leaf.rect}
          // Settings only sets workspace to inert, and Pane still retains focused=true before.
          // A one-time pre-fill of the Plugin trial will be consumed in a hidden state in advance. After visibility is merged into focus,
          // Requests will only be consumed by Composers that are truly interactive after returning to the workspace.
          focused={foregroundEnabled && focusedPaneId === leaf.paneId}
          showFocusIndicator={showFocusIndicator}
          canSplit={canSplit}
          shellWorkspaceKey={shellWorkspaceKey}
          binding={leaf.paneId === V4_PRIMARY_PANE_ID ? null : (panes[leaf.paneId] ?? null)}
          primaryBinding={
            leaf.paneId === V4_PRIMARY_PANE_ID ? (activeGroup?.primaryBinding ?? null) : null
          }
          shell={shell}
          onFocusRequest={handleFocusRequest}
          onSplit={activeGroup ? undefined : splitPaneAction}
          onClosePane={handleClosePane}
          onConfirmRestoredSession={handleConfirmRestoredSession}
          onBindSession={handleBindSession}
          onPaneActiveSessionChange={onPaneActiveSessionChange}
          canDropSession={canDropSession}
          onDropSession={handleDropSession}
        />
      ))}
      {layout.dividers.map((divider) => (
        <WorkbenchSplitDivider
          key={divider.splitId}
          containerRef={containerRef}
          splitId={divider.splitId}
          direction={divider.direction}
          ratio={divider.ratio}
          regionFraction={divider.regionFraction}
          style={dividerStyle(divider)}
          onCommitRatio={handleCommitSplitRatio}
        />
      ))}
    </div>
  );
}
