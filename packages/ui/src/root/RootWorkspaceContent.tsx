import { memo, useEffect } from "react";
import { App } from "@/App.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { WorkspaceSettingsLayer } from "@/root/WorkspaceSettingsLayer.js";
import type { AppProps } from "@/app-shell/types.js";
import type { RootProps } from "@/root/types.js";
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";
import { ConversationTelemetryWorkspaceAttachment } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

const StableWorkspaceApp = memo(App);

interface RootWorkspaceContentProps {
  workspaceScopedServices: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
  workspaceShellPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeWorkspacePath: string | null;
  isSettingsTabActive: boolean;
  handleConnectRemote: AppProps["onConnectRemote"];
  handleSelectRemoteProject: AppProps["onSelectRemoteProject"];
  handleCancelRemoteProject: AppProps["onCancelRemoteProject"];
  handleReconnectRemoteWorkspace: AppProps["onReconnectRemoteWorkspace"];
  handleCreateTask: AppProps["onCreateTask"];
  handleCreateConversationTask: NonNullable<AppProps["onCreateConversationTask"]>;
  handleResolveConversationWorkspace: NonNullable<AppProps["onResolveConversationWorkspace"]>;
  handleOpenWorkspace: AppProps["onOpenWorkspace"];
  handleOpenFolderFromWorkspaceMenu: AppProps["onOpenFolderFromWorkspaceMenu"];
  handleOpenRemoteWorkspace?: AppProps["onOpenRemoteWorkspace"];
  handleCreateScratchWorkspace: AppProps["onCreateScratchWorkspace"];
  remoteConnectionInProgress?: AppProps["remoteConnectionInProgress"];
  remoteWorkspaceSessions: NonNullable<AppProps["remoteWorkspaceSessions"]>;
  allowRemoteWorkspace: NonNullable<RootProps["allowRemoteWorkspace"]>;
  handleBackFromSettings: () => void;
  handleLogout?: () => void;
  onLogin?: () => void;
  user: AppProps["user"];
  reconnectingRemoteWorkspaceKeys: AppProps["reconnectingRemoteWorkspaceKeys"];
  remoteWorkspaceErrorByWorkspaceKey: AppProps["remoteWorkspaceErrorByWorkspaceKey"];
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: AppProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"];
  remoteConnectionLogs?: AppProps["remoteConnectionLogs"];
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  isDesktop?: RootProps["isDesktop"];
  isMacDesktop?: RootProps["isMacDesktop"];
  isWindowsDesktop?: RootProps["isWindowsDesktop"];
  supportsEmbeddedBrowser: NonNullable<RootProps["supportsEmbeddedBrowser"]>;
  windowsWindowControlsRightPaddingPx?: number;
}

export function RootWorkspaceContent({
  workspaceScopedServices,
  baseFeedbackService,
  workspaceShellPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeWorkspacePath,
  isSettingsTabActive,
  handleConnectRemote,
  handleSelectRemoteProject,
  handleCancelRemoteProject,
  handleReconnectRemoteWorkspace,
  handleCreateTask,
  handleCreateConversationTask,
  handleResolveConversationWorkspace,
  handleOpenWorkspace,
  handleOpenFolderFromWorkspaceMenu,
  handleOpenRemoteWorkspace,
  handleCreateScratchWorkspace,
  remoteConnectionInProgress,
  remoteWorkspaceSessions,
  allowRemoteWorkspace,
  handleBackFromSettings,
  handleLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  remoteConnectionLogs,
  allowOpenWorkspace,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser,
  windowsWindowControlsRightPaddingPx,
}: RootWorkspaceContentProps) {
  const workspaceKey = workspaceIdentity?.trim() || workspaceShellPath;

  useEffect(() => {
    logger.info("[RootWorkspaceContent] settings layer visibility changed", {
      isSettingsTabActive,
      workspaceShellPath,
      workspaceHiddenByLayout: false,
    });
  }, [isSettingsTabActive, workspaceShellPath]);

  return (
    <>
      <div
        className={isSettingsTabActive ? "h-full opacity-0 pointer-events-none" : "h-full"}
        aria-hidden={isSettingsTabActive}
        data-root-workspace-surface={isSettingsTabActive ? "inert" : "interactive"}
        inert={isSettingsTabActive ? true : undefined}
      >
        {/* Before the settings page, the entire App was directly replaced through conditional branches. When the settings are closed, the entire main interface tree will be uninstalled and rebuilt.
            Local UI states such as the chat area and terminal will be treated as "re-entering the workspace".
            Here, the workspace shell is changed to be permanently mounted, and only the settings page is overlaid on it.
            Previously, if you press the workspacePath to change the key, the sidebar and task list will be uninstalled and rebuilt when switching tasks across workspaces.
            What users see is a flashing list and a large number of mount/unmounts in the log.
            Now the App instances are kept continuous and only the workspace-related local state is synchronized internally on demand. Closing settings and switching workspaces will no longer trigger a full tree remount.
            In addition, you cannot directly use hidden to set the underlying workspace shell to display:none when switching to the settings page.
            The sidebar setting entrance itself is hung with Radix DropdownMenu. If the anchor node suddenly exits the layout while the menu closing animation is still running,
            Floating UI will temporarily lose its positioning reference, causing the menu content to flash to the upper left corner and then disappear.
            Invisible was used here before. Although the geometric information can be retained, some platforms were cut into visibility: hidden in the entire workspace shell.
            In that frame, the sidebar will be regarded as an abrupt visibility switch, and it is easy to feel "flashing to the left" when switching to settings.
            Change here to opacity-0 + pointer-events-none: still retain the layout and menu anchor points to avoid DropdownMenu losing reference points.
            At the same time, change the cutting layer from "visible/invisible hard cutting" to stable transparent coverage to reduce sidebar flickering.
            If you misuse hidden here, although the workspace subtree is still mounted, the quickpick popup layer will also inherit display:none.
            When the user presses Cmd/Ctrl+K on the settings page, the status is turned on but completely invisible, so the layout occupancy must be maintained and only the interaction turned off.
            Just using opacity and pointer-events will still allow the underlying permissions/AskUserQuestion card to autofocus
            Steal the focus of the setting form; during the setting page coverage, the entire workspace must be marked as inert, and the interaction can be resumed after the user explicitly returns. */}
        <ConversationTelemetryWorkspaceAttachment
          enabled={isDesktop === true}
          foregroundEnabled={!isSettingsTabActive}
          services={workspaceScopedServices}
          workspacePath={workspaceShellPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={workspaceRemoteSessionId}
        >
          <ServiceProvider services={workspaceScopedServices}>
            <ScopedErrorBoundary
              scope="workspace-app"
              resetKeys={[workspaceKey]}
              variant="panel"
              className="h-full"
            >
              <StableWorkspaceApp
                services={workspaceScopedServices}
                baseFeedbackService={baseFeedbackService}
                onConnectRemote={handleConnectRemote}
                onSelectRemoteProject={handleSelectRemoteProject}
                onCancelRemoteProject={handleCancelRemoteProject}
                onReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
                onLogout={handleLogout}
                onLogin={onLogin}
                user={user}
                reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                  reconnectingRemoteWorkspaceLogsByWorkspaceKey
                }
                remoteConnectionLogs={remoteConnectionLogs}
                workspaceAbsPath={workspaceShellPath}
                workspaceRemoteSessionId={workspaceRemoteSessionId}
                workspaceIdentity={workspaceIdentity}
                onCreateTask={handleCreateTask}
                onCreateConversationTask={handleCreateConversationTask}
                onResolveConversationWorkspace={handleResolveConversationWorkspace}
                onOpenWorkspace={handleOpenWorkspace}
                onOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
                onOpenRemoteWorkspace={handleOpenRemoteWorkspace}
                onCreateScratchWorkspace={handleCreateScratchWorkspace}
                remoteConnectionInProgress={remoteConnectionInProgress}
                onReturnToWorkspace={handleBackFromSettings}
                allowOpenWorkspace={allowOpenWorkspace}
                allowRemoteWorkspace={allowRemoteWorkspace}
                remoteWorkspaceSessions={remoteWorkspaceSessions}
                isWorkspaceVisible={!isSettingsTabActive}
                isDesktop={isDesktop}
                isMacDesktop={isMacDesktop}
                isWindowsDesktop={isWindowsDesktop}
                supportsEmbeddedBrowser={supportsEmbeddedBrowser}
              />
            </ScopedErrorBoundary>
          </ServiceProvider>
        </ConversationTelemetryWorkspaceAttachment>
      </div>

      {isSettingsTabActive ? (
        <ScopedErrorBoundary
          scope="workspace-settings-layer"
          resetKeys={[workspaceKey, isSettingsTabActive]}
          variant="panel"
          className="absolute inset-0 z-10"
        >
          <WorkspaceSettingsLayer
            workspaceScopedServices={workspaceScopedServices}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={activeWorkspacePath}
            onBack={activeWorkspacePath ? handleBackFromSettings : undefined}
            onCreateTask={handleCreateTask}
            onOpenWorkspace={handleOpenWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
            onLogin={onLogin}
            onLogout={handleLogout}
            user={user}
          />
        </ScopedErrorBoundary>
      ) : null}
    </>
  );
}
