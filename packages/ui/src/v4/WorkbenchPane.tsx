/* oxlint-disable eslint(max-lines) -- WorkbenchLeafPane centrally carries pane focus, the per-pane
 * provider, the restore guard and the session drop target; scattering them would make the
 * DnD/focus/session binding chain jump across files, so extraction by responsibility waits until
 * things stabilize.
 */
// Split-screen leaf pane: Focus layer enclosure + per-pane data plane wiring + recovery guard. Host = V4WorkspaceChatArea.
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { TID_V4_PANE_SHELL, testId } from "@zcode/shared";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
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
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import {
  paneWorkspaceKey,
  V4_PRIMARY_PANE_ID,
  type PaneBinding,
  type PaneSplitSide,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutStore.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  parseWorkbenchSessionDragPayload,
  resolveWorkbenchDropSide,
  type WorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";
import { registerWorkbenchPointerDropTarget } from "@/v4/workbenchPointerDragDrop.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import { createRestoredPaneGuardController } from "@/v4/restoredPaneGuardController.js";
import { rectStyle, type RectExpr } from "@/v4/workbenchLayout.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

interface ChatPaneShellProps {
  containerRef?: (element: HTMLDivElement | null) => void;
  paneId: string;
  focused: boolean;
  /** No focus ring in a single-pane layout (unambiguous, avoids visual noise). */
  showFocusIndicator: boolean;
  onFocusRequest: (paneId: string) => void;
  /** Absolutely positioned rect (the calc expression computed by the layout layer). */
  style: CSSProperties;
  dropSide?: PaneSplitSide | null;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  children: ReactNode;
  restoredUnvalidated?: boolean;
}

const DROP_PREVIEW_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--color-brand) 14%, transparent)",
  boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-brand) 34%, transparent)",
};

const INACTIVE_PANE_OVERLAY_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--color-background) 34%, transparent)",
  backdropFilter: "brightness(0.94) saturate(0.94)",
};

function dropPreviewClassName(side: PaneSplitSide): string {
  switch (side) {
    case "left":
      return "left-1 top-1 bottom-1 w-1/2";
    case "right":
      return "right-1 top-1 bottom-1 w-1/2";
    case "up":
      return "left-1 right-1 top-1 h-1/2";
    case "down":
      return "left-1 right-1 bottom-1 h-1/2";
  }
}

/**
 * Shell of the focus layer: clicking or focusing anywhere inside a pane → focus that pane (capture,
 * so subtree interaction is not disturbed). memo + stable callback: a focus switch only flips
 * data-focused / the border class name and does not disturb the pane content subtree.
 */
const ChatPaneShell = memo(function ChatPaneShell({
  containerRef,
  paneId,
  focused,
  showFocusIndicator,
  onFocusRequest,
  style,
  dropSide,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
  restoredUnvalidated = false,
}: ChatPaneShellProps) {
  const handleFocusRequest = useCallback(() => {
    onFocusRequest(paneId);
  }, [onFocusRequest, paneId]);

  return (
    <div
      ref={containerRef}
      data-testid={testId(TID_V4_PANE_SHELL, paneId)}
      data-pane-id={paneId}
      data-focused={focused ? "true" : "false"}
      data-restored-unvalidated={restoredUnvalidated ? "true" : "false"}
      onPointerDownCapture={handleFocusRequest}
      onFocusCapture={handleFocusRequest}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={style}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col",
        showFocusIndicator && focused && "ring-1 ring-inset ring-[var(--color-brand)]",
      )}
    >
      {showFocusIndicator && !focused ? (
        <div
          aria-hidden="true"
          data-v4-pane-inactive-overlay="true"
          style={INACTIVE_PANE_OVERLAY_STYLE}
          className="pointer-events-none absolute inset-0 z-30 rounded-md transition-[background-color,backdrop-filter]"
        />
      ) : null}
      {dropSide ? (
        <div className="pointer-events-none absolute inset-0 z-50">
          <div
            aria-hidden="true"
            style={DROP_PREVIEW_STYLE}
            className={cn(
              "absolute rounded-md transition-[background-color,box-shadow]",
              dropPreviewClassName(dropSide),
            )}
          />
        </div>
      ) : null}
      {children}
    </div>
  );
});

interface PaneRestoredGuardProps {
  paneId: string;
  scope: PaneWorkspaceScope;
  sessionId: string;
  onConfirmed: (paneId: string) => void;
  onMissing: (paneId: string) => void;
}

/**
 * Persisted restore guard (generalized to per-pane): a binding restored from localStorage may point
 * at a session that has since been deleted (the deletion happened in a previous run or in another
 * window). Using the sessions index scoped to the pane itself (isolated by endpoint +
 * workspaceKey), once the first real snapshot arrives (workspaceId is ready) an existence check is
 * performed: present → clear restoredUnvalidated; deleted → closePane collapses gracefully.
 * useWorkspaceSessionsIndexItems is not used — its aggregate memo is computed from the empty store
 * set before the subscription effect and would misjudge "loaded and absent"; the registry store is
 * connected directly instead, and when the subscription errors or the remote endpoint is absent (a
 * disconnected proxy rejects) no verdict is reached, the pane stays in the error / awaiting
 * connection state and falls back to its own retry, so it is never closed by mistake. It must be
 * mounted inside V4PaneConversationProvider: useServices reads the pane's own accessor (a remote
 * pane goes through the sessions index of the corresponding remote connection, so it never queries
 * the local host by mistake).
 */
function PaneRestoredGuard({
  paneId,
  scope,
  sessionId,
  onConfirmed,
  onMissing,
}: PaneRestoredGuardProps) {
  const services = useServices();
  const agentService = services.zcodeAgentService;
  const { workspacePath, workspaceIdentity, remoteSessionId } = scope;

  useEffect(() => {
    if (!agentService) {
      return;
    }
    const indexScope: SessionsIndexScope = {
      workspaceKey: paneWorkspaceKey({ workspacePath, workspaceIdentity }),
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { endpointKey: remoteSessionId } : {}),
    };
    const store = acquireSessionsIndex(indexScope, agentService);
    // Settlement (including the dormant/error grace window for runtime-less workspaces) lives in a
    // pure controller so the rule is unit-testable without React; see
    // docs/specs/sessions-index-restore-guard.md.
    const controller = createRestoredPaneGuardController({
      store,
      sessionId,
      onConfirmed: () => onConfirmed(paneId),
      onMissing: () => onMissing(paneId),
    });
    const unsubscribe = store.subscribe(() => controller.evaluate());
    controller.evaluate();
    return () => {
      controller.dispose();
      unsubscribe();
      releaseSessionsIndex(indexScope, store);
    };
  }, [
    agentService,
    paneId,
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onConfirmed,
    onMissing,
  ]);

  return null;
}

/**
 * Shell-side binding of the primary pane (activeTaskId selection state + callbacks, not in
 * paneLayoutStore).
 */
export interface WorkbenchShellBinding {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** Prompt template telemetry currently covers Desktop only. */
  isDesktop?: boolean;
  readOnly?: boolean;
  sessionId: string | null;
  /**
   * The task the shell currently has truly active; when a split pane takes over the active task it
   * is not the same as the primary sessionId.
   */
  activeSessionId?: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  onSessionDeleted?: () => void;
  draftComposerHeader?: ReactNode;
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

interface WorkbenchLeafPaneProps {
  paneId: string;
  rect: RectExpr;
  focused: boolean;
  showFocusIndicator: boolean;
  canSplit: boolean;
  shellWorkspaceKey: string;
  /** Binding of a non-primary pane; null is passed for primary (use the shell binding). */
  binding: PaneBinding | null;
  /**
   * The explicit binding of the primary pane in a session workbench group; null when there is no
   * group.
   */
  primaryBinding?: WorkbenchSessionBinding | null;
  shell: WorkbenchShellBinding;
  onFocusRequest: (paneId: string) => void;
  onSplit?: (paneId: string, direction: SplitDirection, scope: PaneWorkspaceScope) => void;
  onClosePane: (paneId: string) => void;
  onConfirmRestoredSession: (paneId: string) => void;
  onBindSession: (paneId: string, sessionId: string) => boolean | void;
  onPaneActiveSessionChange?: (scope: PaneWorkspaceScope, sessionId: string) => void;
  canDropSession?: (payload: WorkbenchSessionDragPayload) => boolean;
  onDropSession?: (
    paneId: string,
    side: PaneSplitSide,
    payload: WorkbenchSessionDragPayload,
  ) => void;
}

function workspaceBadgeFor(scope: PaneWorkspaceScope): PaneWorkspaceBadge {
  const label = scope.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? scope.workspacePath;
  return {
    label,
    workspacePath: scope.workspacePath,
    remote: Boolean(scope.workspaceIdentity || scope.remoteSessionId),
  };
}

export function WorkbenchLeafPane({
  paneId,
  rect,
  focused,
  showFocusIndicator,
  canSplit,
  shellWorkspaceKey,
  binding,
  primaryBinding,
  shell,
  onFocusRequest,
  onSplit,
  onClosePane,
  onConfirmRestoredSession,
  onBindSession,
  onPaneActiveSessionChange,
  canDropSession,
  onDropSession,
}: WorkbenchLeafPaneProps) {
  const [dropSide, setDropSide] = useState<PaneSplitSide | null>(null);
  const isPrimary = paneId === V4_PRIMARY_PANE_ID;
  const isGroupPrimary = isPrimary && Boolean(primaryBinding);
  const scope = useMemo<PaneWorkspaceScope>(() => {
    if (!isPrimary && binding) {
      return binding.workspaceScope;
    }
    if (isPrimary && primaryBinding) {
      return primaryBinding.workspaceScope;
    }
    return {
      workspacePath: shell.workspacePath,
      ...(shell.workspaceIdentity ? { workspaceIdentity: shell.workspaceIdentity } : {}),
      ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
    };
  }, [
    isPrimary,
    binding,
    primaryBinding,
    shell.workspacePath,
    shell.workspaceIdentity,
    shell.remoteSessionId,
  ]);

  const style = useMemo(() => rectStyle(rect), [rect]);

  const handleSplitRight = useCallback(() => {
    onSplit?.(paneId, "row", scope);
  }, [onSplit, paneId, scope]);
  const handleSplitDown = useCallback(() => {
    onSplit?.(paneId, "column", scope);
  }, [onSplit, paneId, scope]);
  const handleClosePane = useCallback(() => {
    onClosePane(paneId);
  }, [onClosePane, paneId]);
  const handleSessionDeleted = useCallback(() => {
    if (isGroupPrimary) {
      // Group primary deletion only closes the layout in the past, and the shell still points to the deleted session.
      // After accepted, you must first dissolve the group and then let the shell return to the current workspace draft; secondary
      // Only restores normal session identity, which cannot be implicitly promoted here.
      handleClosePane();
      shell.onSessionDeleted?.();
      return;
    }
    if (isPrimary) {
      shell.onSessionDeleted?.();
      return;
    }
    handleClosePane();
  }, [handleClosePane, isGroupPrimary, isPrimary, shell.onSessionDeleted]);
  const handleBindSession = useCallback(
    (createdSessionId: string) => {
      const shouldSyncShellActive = onBindSession(paneId, createdSessionId) !== false;
      if (shouldSyncShellActive) {
        onPaneActiveSessionChange?.(scope, createdSessionId);
      }
    },
    [onBindSession, onPaneActiveSessionChange, paneId, scope],
  );
  const handleSessionCreated = useCallback(
    (createdSessionId: string) => {
      if (isPrimary && !primaryBinding) {
        // When there is already a dragged session next to the primary draft, the first draft cannot only update the shell.
        // You must first let the workbench host bind the draft pane in place and take over the entire layout; otherwise, later
        // Focus secondary will rewrite shell activeTaskId, and primary will return to draft because there is no independent binding.
        onBindSession(paneId, createdSessionId);
        shell.onSessionCreated?.(createdSessionId);
        return;
      }
      handleBindSession(createdSessionId);
    },
    [handleBindSession, isPrimary, onBindSession, paneId, primaryBinding, shell.onSessionCreated],
  );
  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!onDropSession || !canSplit) {
        return;
      }
      const payload = parseWorkbenchSessionDragPayload(event.dataTransfer);
      if (!payload || (canDropSession && !canDropSession(payload))) {
        setDropSide(null);
        return;
      }
      const side = resolveWorkbenchDropSide(
        event.currentTarget.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
      if (!side) {
        setDropSide(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDropSide(side);
    },
    [canDropSession, canSplit, onDropSession],
  );
  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setDropSide(null);
  }, []);
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!onDropSession || !canSplit) {
        setDropSide(null);
        return;
      }
      const payload = parseWorkbenchSessionDragPayload(event.dataTransfer);
      const side =
        dropSide ??
        resolveWorkbenchDropSide(
          event.currentTarget.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        );
      setDropSide(null);
      if (!payload || !side || (canDropSession && !canDropSession(payload))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onDropSession(paneId, side, payload);
    },
    [canDropSession, canSplit, dropSide, onDropSession, paneId],
  );
  const pointerDropTargetRef = useRef<HTMLDivElement | null>(null);
  const setPointerDropTargetRef = useCallback((element: HTMLDivElement | null) => {
    pointerDropTargetRef.current = element;
  }, []);
  useEffect(() => {
    const element = pointerDropTargetRef.current;
    if (!element || !onDropSession || !canSplit) {
      return undefined;
    }
    return registerWorkbenchPointerDropTarget(element, {
      canDrop: (payload) => !canDropSession || canDropSession(payload),
      onPreview: setDropSide,
      onDrop: (side, payload) => onDropSession(paneId, side, payload),
    });
  }, [canDropSession, canSplit, onDropSession, paneId]);

  if (!isPrimary && !binding) {
    // sanitize/migrate ensures that non-primary leaves must be bound; here is the defensive rendering at the moment of transfer.
    return null;
  }

  const isShellWorkspace = paneWorkspaceKey(scope) === shellWorkspaceKey;
  const sessionId = isPrimary
    ? (primaryBinding?.sessionId ?? shell.sessionId)
    : (binding?.sessionId ?? null);
  const readOnly = Boolean(
    (isPrimary ? primaryBinding?.readOnly : binding?.readOnly) ||
    (isShellWorkspace && shell.readOnly),
  );
  const shouldUseShellStatusPanel = isShellWorkspace;
  const paneSearchResultHighlightRequest =
    sessionId === shell.searchResultHighlightRequest?.taskId
      ? shell.searchResultHighlightRequest
      : null;

  return (
    <ChatPaneShell
      containerRef={setPointerDropTargetRef}
      paneId={paneId}
      focused={focused}
      showFocusIndicator={showFocusIndicator}
      onFocusRequest={onFocusRequest}
      style={style}
      dropSide={dropSide}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      restoredUnvalidated={Boolean((isPrimary ? primaryBinding : binding)?.restoredUnvalidated)}
    >
      <V4PaneConversationProvider scope={scope}>
        {(isPrimary ? primaryBinding : binding)?.restoredUnvalidated && sessionId ? (
          <PaneRestoredGuard
            paneId={paneId}
            scope={scope}
            sessionId={sessionId}
            onConfirmed={onConfirmRestoredSession}
            onMissing={onClosePane}
          />
        ) : null}
        <SessionPane
          paneId={paneId}
          readOnly={readOnly}
          sessionId={sessionId}
          openTrigger={isPrimary ? "sidebar" : "split"}
          activeSelectionSideChatSessionId={resolvePaneActiveSelectionSideChatSessionId(
            sessionId,
            shell.activeSessionId ?? shell.sessionId,
            shell.activeSelectionSideChatSessionId,
          )}
          workspacePath={scope.workspacePath}
          workspaceIdentity={scope.workspaceIdentity}
          remoteSessionId={scope.remoteSessionId}
          isDesktop={shell.isDesktop}
          provider={isPrimary && isShellWorkspace ? shell.provider : undefined}
          onSessionCreated={handleSessionCreated}
          onSessionDeleted={handleSessionDeleted}
          focused={focused}
          onSplitRight={canSplit && onSplit ? handleSplitRight : undefined}
          onSplitDown={canSplit && onSplit ? handleSplitDown : undefined}
          onClosePane={isPrimary ? undefined : handleClosePane}
          workspaceBadge={!isPrimary && !isShellWorkspace ? workspaceBadgeFor(scope) : undefined}
          draftComposerHeader={isPrimary && !primaryBinding ? shell.draftComposerHeader : undefined}
          onDropTargetControllerChange={
            isPrimary && !primaryBinding
              ? shell.onPrimaryDraftDropTargetControllerChange
              : undefined
          }
          gitSummary={shouldUseShellStatusPanel ? shell.gitSummary : undefined}
          gitDirtyFileCount={shouldUseShellStatusPanel ? shell.gitDirtyFileCount : undefined}
          gitWorktreeReviewSourceId={
            shouldUseShellStatusPanel ? shell.gitWorktreeReviewSourceId : undefined
          }
          gitWorktreeChangeSummary={
            shouldUseShellStatusPanel ? shell.gitWorktreeChangeSummary : undefined
          }
          activeTaskChangeSummary={isPrimary ? shell.activeTaskChangeSummary : undefined}
          summaryPanelVariantOverride={
            shouldUseShellStatusPanel ? shell.summaryPanelVariantOverride : undefined
          }
          onSummaryPanelVariantOverrideChange={
            shouldUseShellStatusPanel ? shell.onSummaryPanelVariantOverrideChange : undefined
          }
          onRefreshGit={shouldUseShellStatusPanel ? shell.onRefreshGit : undefined}
          onOpenGitReview={shouldUseShellStatusPanel ? shell.onOpenGitReview : undefined}
          onOpenBrowserUrl={shell.onOpenBrowserUrl}
          onOpenAutomationsMain={shell.onOpenAutomationsMain}
          onOpenCodeViewer={shell.onOpenCodeViewer}
          onAutoOpenAssistantPptx={shell.onAutoOpenAssistantPptx}
          onOpenFileLink={shell.onOpenFileLink}
          onOpenSubagentSession={shell.onOpenSubagentSession}
          onOpenBackgroundBash={shell.onOpenBackgroundBash}
          onOpenSubagentDirectory={shell.onOpenSubagentDirectory}
          onSyncSubagentSessionTabs={shell.onSyncSubagentSessionTabs}
          onOpenSelectionSideChat={shell.onOpenSelectionSideChat}
          onOpenPlanDetail={shell.onOpenPlanDetail}
          onOpenWorkflowRun={shell.onOpenWorkflowRun}
          onOpenWorkflowArtifact={shell.onOpenWorkflowArtifact}
          onOpenWorkflowRunDirectory={shell.onOpenWorkflowRunDirectory}
          onOpenWorkflowActorSession={shell.onOpenWorkflowActorSession}
          onOpenWorkflowWorkspace={shell.onOpenWorkflowWorkspace}
          conversationFindQuery={focused ? shell.conversationFindQuery : ""}
          conversationFindActiveIndex={focused ? (shell.conversationFindActiveIndex ?? -1) : -1}
          conversationFindNavigationRequestId={
            focused ? (shell.conversationFindNavigationRequestId ?? 0) : 0
          }
          onConversationFindMatchStateChange={
            focused ? shell.onConversationFindMatchStateChange : undefined
          }
          searchResultHighlightRequest={paneSearchResultHighlightRequest}
          onSearchResultHighlightDone={shell.onSearchResultHighlightDone}
        />
      </V4PaneConversationProvider>
    </ChatPaneShell>
  );
}

function resolvePaneActiveSelectionSideChatSessionId(
  paneSessionId: string | null,
  shellActiveSessionId: string | null,
  activeSelectionSideChatSessionId: string | null | undefined,
): string | null {
  return paneSessionId && paneSessionId === shellActiveSessionId
    ? (activeSelectionSideChatSessionId ?? null)
    : null;
}
