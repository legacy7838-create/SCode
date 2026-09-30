import type {
  ZCodeProvider,
  ZCodeTaskMeta,
  ZCodeTaskChangeSummary,
  EditorInfo,
  GitRepositorySummary,
  RemoteTarget,
  UserInfo,
} from "@zcode/shared";
import { useState } from "react";
import { TID_WORKSPACE_HEADER } from "@zcode/shared";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { cn } from "@/components/lib/utils.js";
import {
  WorkspaceHeaderActionSection,
  type WorkspaceHeaderState,
  WorkspaceHeaderTitleSection,
} from "@/WorkspaceHeaderSections.js";
import type { WorkspaceHeaderVariant } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeader({
  variant = "task",

  draftDropTargetController,
  readOnlyReason,
  workspaceAbsPath,
  remoteSessionId,
  workspaceIdentity,
  remoteTarget,
  localWorkspacePath,
  projectName,
  activeTaskTitle,
  activeTaskChangeSummary,
  hasUpdateReady,
  activeTaskId,
  user,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  sessionLogPath,
  nativeSessionLogProvider,
  nativeSessionLogPath,
  nativeSessionLogExists,
  nativeSessionLogLoading,
  workspaceHeaderState,
  gitSummary,
  gitDirtyFileCount,
  isMacDesktop,
  isMacFullscreen,
  isWindowsDesktop,

  isDesktop,
  simplifyForNarrowRemote = false,
  isSidebarVisible,
  isTerminalOpen,
  isSidePaneOpen,
  onRefreshGit,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onReloadSession,
  reloadSessionDisabled,
  reloadSessionPending,
}: {
  variant?: WorkspaceHeaderVariant;
  draftDropTargetController?: ConversationDropTargetController | null;
  readOnlyReason?: string;
  workspaceAbsPath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  remoteTarget?: RemoteTarget;
  localWorkspacePath?: string;
  projectName: string;
  activeTaskTitle: string;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  hasUpdateReady: boolean;
  activeTaskId: string | null;
  user?: UserInfo | null;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  sessionLogPath: string | null;
  nativeSessionLogProvider: ZCodeProvider | null;
  nativeSessionLogPath: string | null;
  nativeSessionLogExists: boolean;
  nativeSessionLogLoading: boolean;
  workspaceHeaderState: WorkspaceHeaderState;
  gitSummary: GitRepositorySummary;
  gitDirtyFileCount: number;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  isWindowsDesktop?: boolean;
  reserveWindowControls?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  isDesktop?: boolean;
  simplifyForNarrowRemote?: boolean;
  isSidebarVisible: boolean;
  isTerminalOpen: boolean;
  isSidePaneOpen: boolean;
  onRefreshGit: () => void;
  onToggleTerminal: () => void;
  onToggleBrowser: () => void;
  onToggleSidePane: () => void;
  toggleSidePaneShortcutLabel?: string;
  onReloadSession: (options?: {
    resumeTaskId?: string | null;
    provider?: ZCodeProvider | null;
  }) => void | Promise<void>;
  reloadSessionDisabled?: boolean;
  reloadSessionPending?: boolean;
  onCreateTask: () => void;
  onOpenWorkspace: () => void;
  allowOpenWorkspace?: boolean;
}) {
  const [selectedEditor, setSelectedEditor] = useState<EditorInfo | null>(null);
  const shouldOffsetHeaderForWindowControls = !isSidebarVisible;
  // Linux and Windows share inline window controls, and the title bar area of ​​the old floating window control is no longer reserved.
  const usesInlineWindowControls = Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop));

  let headerWindowControlsPaddingClass: string | false = false;
  if (shouldOffsetHeaderForWindowControls) {
    if (isMacDesktop) {
      if (hasUpdateReady) {
        headerWindowControlsPaddingClass = isMacFullscreen ? "pl-48" : "pl-66";
      } else {
        headerWindowControlsPaddingClass = isMacFullscreen ? "pl-38" : "pl-58";
      }
    } else {
      headerWindowControlsPaddingClass = hasUpdateReady ? "pl-44" : "pl-38";
    }
  }

  return (
    <header
      data-testid={TID_WORKSPACE_HEADER}
      data-workspace-header-variant={variant}
      className={cn(
        "@container/workspace-header relative flex w-full shrink-0 h-12 border-b",
        variant === "draft" ? "border-transparent" : "border-border/50",
      )}
    >
      {variant === "draft" && draftDropTargetController?.active ? (
        <div
          className="absolute inset-0 z-40 bg-accent/55 backdrop-blur-sm pointer-events-auto [app-region:no-drag]"
          data-testid="new-task-draft-drop-mask"
          onDragOver={draftDropTargetController.onDragOver}
          onDragLeave={draftDropTargetController.onDragLeave}
          onDrop={draftDropTargetController.onDrop}
        />
      ) : null}
      <div
        className={cn(
          // Large session resize trace shows that the titlebar padding animation layer will trigger the scrollbar-color non-synthetic animation;
          // Explicitly limit transition-property to padding to prevent duration-300 from returning to the default all.
          "flex h-12 flex-1 min-w-0 items-center justify-between gap-2 overflow-hidden p-2 [app-region:drag] transition-[padding] duration-300",
          // After the old caption menu is removed, you cannot continue to clear the right margin, otherwise the terminal buttons will stick to the panel border.
          headerWindowControlsPaddingClass,
        )}
      >
        {variant === "task" ? (
          <WorkspaceHeaderTitleSection
            variant={variant}
            readOnlyReason={readOnlyReason}
            workspaceAbsPath={workspaceAbsPath}
            remoteSessionId={remoteSessionId}
            workspaceIdentity={workspaceIdentity}
            remoteTarget={remoteTarget}
            localWorkspacePath={localWorkspacePath}
            projectName={projectName}
            activeTaskTitle={activeTaskTitle}
            activeTaskChangeSummary={activeTaskChangeSummary}
            activeTaskId={activeTaskId}
            activeTraceId={activeTraceId}
            activeSessionId={activeSessionId}
            activeTaskProvider={activeTaskProvider}
            resolvedActiveTaskMeta={resolvedActiveTaskMeta}
            gitSummary={gitSummary}
            gitDirtyFileCount={gitDirtyFileCount}
            sessionLogPath={sessionLogPath}
            nativeSessionLogProvider={nativeSessionLogProvider}
            nativeSessionLogPath={nativeSessionLogPath}
            nativeSessionLogExists={nativeSessionLogExists}
            nativeSessionLogLoading={nativeSessionLogLoading}
            workspaceHeaderState={workspaceHeaderState}
            isMacDesktop={isMacDesktop}
            isMacFullscreen={isMacFullscreen}
            isWindowsDesktop={isWindowsDesktop}
            simplifyForNarrowRemote={simplifyForNarrowRemote}
            selectedEditor={selectedEditor}
            onReloadSession={onReloadSession}
            reloadSessionDisabled={reloadSessionDisabled}
            reloadSessionPending={reloadSessionPending}
            onRefreshGit={onRefreshGit}
          />
        ) : (
          <div className="min-w-0 flex-1" aria-hidden="true" />
        )}
        <WorkspaceHeaderActionSection
          variant={variant}
          activeTaskId={activeTaskId}
          user={user}
          readOnlyReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          remoteTarget={remoteTarget}
          isDesktop={isDesktop}
          isTerminalOpen={isTerminalOpen}
          isSidePaneOpen={isSidePaneOpen}
          onToggleTerminal={onToggleTerminal}
          onToggleSidePane={onToggleSidePane}
          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
          simplifyForNarrowRemote={simplifyForNarrowRemote}
          hideHelpMenu={false}
          showWindowControls={usesInlineWindowControls}
          // The panel operation buttons follow the compact style of macOS, and the Windows/Linux window controls follow the rightmost header.
          onSelectedEditorChange={setSelectedEditor}
        />
      </div>
    </header>
  );
}
