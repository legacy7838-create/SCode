/* eslint-disable max-lines -- The root workspace action hook centrally orchestrates the project,
 * remote and conversation entry points; during the merge it keeps the action boundaries intact,
 * with a later split by domain.
 */
import { useCallback, useEffect, useState } from "react";
import {
  DesktopCommandIds,
  type AppSettings,
  type IPlatformService,
  type RemoteTarget,
  type UserInfo,
  type ZCodeTaskClientMode,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { logger } from "@/logger.js";
import { openFolderFromWorkspaceEntry } from "@/root/openWorkspaceFolderEntry.js";
import { useConversationWorkspaceActions } from "@/root/useConversationWorkspaceActions.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { isWorkspaceReadOnly, type TabStore, type TabStoreState } from "@/store/tabStore.js";
import type { RootProps } from "@/root/types.js";
import {
  hadPersistedPaneLayoutAtModuleLoad,
  INITIAL_PANE_LAYOUT,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { resolveWorkbenchNewTaskTarget } from "@/v4/workbenchNewTaskTarget.js";
import type { WorkbenchNewTaskTarget } from "@/v4/workbenchNewTaskTarget.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { persistV4ComposerDraft, V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";

interface OpenRemoteConnectionPreference {
  preferredKind?: RemoteTarget["kind"];
}

/**
 * Where a new task lands: a missing identity is always normalized to null, so that read-only
 * validation and focus/addTab consume it uniformly.
 */
interface NewTaskTargetResolution {
  workspacePath: string;
  workspaceIdentity: string | null;
}

/**
 * Resolves where a new task lands: when the request explicitly carries a targetWorkspace (starting
 * a saved workflow from another project) that value is taken directly, without asking about the
 * workbench focus; otherwise it falls back lazily to resolveWorkbenchNewTaskTarget. A missing
 * identity is normalized to null.
 */
function resolveNewTaskTargetFromRequest(
  request: CreateTaskRequest | undefined,
  resolveFallback: () => WorkbenchNewTaskTarget | null,
): NewTaskTargetResolution | null {
  const targetWorkspace =
    typeof request === "string" || !request ? undefined : request.targetWorkspace;
  if (targetWorkspace) {
    return {
      workspacePath: targetWorkspace.workspacePath,
      workspaceIdentity: targetWorkspace.workspaceIdentity ?? null,
    };
  }
  const fallback = resolveFallback();
  if (!fallback) {
    return null;
  }
  return {
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity ?? null,
  };
}

export function useRootWorkspaceActions({
  intl,
  platform,
  services,
  tabStoreApi,
  addTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  supportsSettings,
  allowOpenWorkspace,
  preferDirectoryBrowser,
  openDirectoryBrowser,
  refreshProviderState,
  updateAppSettings,
  setOAuthError,
  setUser,
  onProviderFamilyDomainClearedAfterLogout,
  userId,
  onOpenRemoteConnection,
  workbenchGroupClientMode = "desktop-continuous",
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  platform: IPlatformService;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  addTab: TabStoreState["addTab"];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  supportsSettings: boolean;
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  preferDirectoryBrowser: boolean;
  openDirectoryBrowser?: () => void;
  refreshProviderState: () => Promise<void>;
  updateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setOAuthError: (error: string | null) => void;
  setUser: (user: UserInfo | null) => void;
  onProviderFamilyDomainClearedAfterLogout?: () => void;
  userId?: string;
  onOpenRemoteConnection?: (preference?: OpenRemoteConnectionPreference) => void;
  workbenchGroupClientMode?: ZCodeTaskClientMode;
}) {
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const requestConfirmation = useConfirmDialog();
  const {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  } = useConversationWorkspaceActions({
    services,
    addTab,
    setWorkspaceActionError,
  });

  useEffect(() => {
    useWorkbenchGroupStore.getState().configureClientMode(workbenchGroupClientMode);
    if (workbenchGroupClientMode === "desktop-continuous" && !isRendererReloadNavigation()) {
      // group/pane is renderer-local persistent UI state. If the app is cold started directly
      // Activating them, even activeTaskId=null will display the historical session, violating the startup draft semantics.
      // Renderer reload retains the qualification for recovery and is used to refresh and continue the flow in the output.
      const workbenchState = useWorkbenchGroupStore.getState();
      const activeGroup = workbenchState.activeGroupId
        ? workbenchState.groups[workbenchState.activeGroupId]
        : null;
      const activeGroupWasRestored = Boolean(
        activeGroup &&
        [activeGroup.primaryBinding, ...Object.values(activeGroup.panes)].some(
          (binding) => binding.restoredUnvalidated,
        ),
      );
      if (activeGroupWasRestored) {
        workbenchState.deactivateActiveGroup();
      }
      if (hadPersistedPaneLayoutAtModuleLoad()) {
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
    }
  }, [workbenchGroupClientMode]);

  const startDraftInWorkspace = useCallback(
    (workspacePath: string, workspaceIdentity?: string) => {
      if (workbenchGroupClientMode === "desktop-continuous") {
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
      useZCodeSessionStore.getState().startDraft(workspacePath, undefined, workspaceIdentity);
    },
    [workbenchGroupClientMode],
  );

  const startNewTaskFromActiveWorkspace = useCallback(
    (source: string, request?: CreateTaskRequest) => {
      const state = tabStoreApi.getState();
      const {
        activeWorkspacePath: currentActiveWorkspacePath,
        activeWorkspaceIdentity: currentActiveWorkspaceIdentity,
        activateTabByPath: focusWorkspace,
      } = state;
      const workbenchGroupState = useWorkbenchGroupStore.getState();
      const activeGroup =
        workbenchGroupClientMode === "desktop-continuous" && workbenchGroupState.activeGroupId
          ? (workbenchGroupState.groups[workbenchGroupState.activeGroupId] ?? null)
          : null;
      // When initiating a saved workflow across projects, the new task must fall into the workflow's owning project, not the active project
      // It is used when request explicitly contains targetWorkspace.
      // Otherwise, it will lazily fall back to workbench focus analysis, and the behavior without target will be consistent with the old version byte by byte.
      const newTaskTarget = resolveNewTaskTargetFromRequest(request, () =>
        resolveWorkbenchNewTaskTarget({
          activeWorkspacePath: currentActiveWorkspacePath,
          activeWorkspaceIdentity: currentActiveWorkspaceIdentity,
          activeGroup,
          // Although remote does not display paneLayout, there may still be desktop in renderer
          // Focused secondary; new tasks must be positioned according to the visible shell workspace and cannot consume hidden panes.
          paneLayout:
            workbenchGroupClientMode === "desktop-continuous"
              ? usePaneLayoutStore.getState()
              : INITIAL_PANE_LAYOUT,
        }),
      );

      if (
        typeof request === "object" &&
        request.expectedWorkspaceKey &&
        request.expectedWorkspaceKey !==
          (newTaskTarget?.workspaceIdentity?.trim() || newTaskTarget?.workspacePath)
      ) {
        return;
      }
      if (!newTaskTarget) {
        logger.error(`[Root] ${source} failed: no active workspace`);
        setWorkspaceActionError(intl.formatMessage({ id: "workspace.noActiveForNewTask" }));
        return;
      }

      // Merely disabling the button cannot cover the desktop menu and shortcut keys; invalid workspace during startup
      // It must be verified again at the action boundary to prevent the historical read-only page from being implicitly switched back to the draft-ready state.
      if (
        isWorkspaceReadOnly(
          state,
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity ?? undefined,
        )
      ) {
        return;
      }

      if (
        !focusWorkspace(
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity
            ? { workspaceIdentity: newTaskTarget.workspaceIdentity }
            : undefined,
        )
      ) {
        addTab(
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity
            ? { workspaceIdentity: newTaskTarget.workspaceIdentity }
            : undefined,
        );
      }

      setWorkspaceActionError(null);
      const provider = typeof request === "string" ? request : request?.provider;
      const groupedDraftPlacement =
        typeof request === "string" ? undefined : request?.groupedDraftPlacement;
      const rawInitialPrompt = typeof request === "string" ? undefined : request?.initialPrompt;
      // The trailing space after Skill mention determines that the cursor falls after chip; trim directly and then save.
      // Will eat up the editable intervals of structured mentions. Here only trim is used to detect empty, and non-empty drafts retain the original text of the caller.
      const initialPrompt = rawInitialPrompt?.trim() ? rawInitialPrompt : undefined;
      const initialPromptMention =
        typeof request === "string" ? undefined : request?.initialPromptMention;
      logger.info(`[Root] ${source}:`, newTaskTarget.workspacePath, provider ?? "default-provider");
      // Cmd/Ctrl+N is to create a new single panel draft, not in the current workbench
      // Continue to split a draft in group/paneLayout; the target workspace is focused pane.
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      useZCodeSessionStore
        .getState()
        .startDraft(
          newTaskTarget.workspacePath,
          provider,
          newTaskTarget.workspaceIdentity ?? undefined,
          {
            groupedDraftPlacement,
            createSource: typeof request === "string" ? undefined : request?.createSource,
          },
        );
      if (initialPrompt) {
        // The insert request will be cleared after being consumed by the first composer; if it is subsequently consumed by pane/config
        // Toggle remount and the new composer will restore from an empty __draft__ and overwrite the prefill. Write a draft of the sources first,
        // Send an instant insertion request again: the current composer will see it immediately, and subsequent remounts will also restore the same text.
        persistV4ComposerDraft(
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity ?? undefined,
          V4_DRAFT_SCOPE_ROOT,
          {
            text: initialPrompt,
            ...(initialPromptMention ? { mention: initialPromptMention } : {}),
          },
        );
        useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(
            newTaskTarget.workspacePath,
            initialPrompt,
            newTaskTarget.workspaceIdentity ?? undefined,
            initialPromptMention,
          );
      }
    },
    [addTab, intl, tabStoreApi, workbenchGroupClientMode],
  );

  const handleLogout = useCallback(async () => {
    let runningAgentSessionCount: number | null = null;
    try {
      const sessionActivity = await platform.getDesktopSessionActivity?.();
      runningAgentSessionCount =
        typeof sessionActivity?.runningAgentSessionCount === "number"
          ? sessionActivity.runningAgentSessionCount
          : null;
    } catch (error) {
      logger.warn(
        "[Root] failed to query the number of running desktop sessions, using the conservative sign-out copy",
        { error },
      );
    }

    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "logout.confirm.title" }),
      description:
        runningAgentSessionCount !== null && runningAgentSessionCount > 0
          ? intl.formatMessage(
              { id: "logout.confirm.descriptionWithRunningSessions" },
              { count: String(runningAgentSessionCount) },
            )
          : intl.formatMessage({ id: "logout.confirm.descriptionDefault" }),
      confirmLabel: intl.formatMessage({ id: "logout.confirm.ok" }),
      cancelLabel: intl.formatMessage({ id: "logout.confirm.cancel" }),
    });
    if (!confirmed) {
      return;
    }

    // Bug reason: telemetry is a secondary link; waiting for network retries delays logging out, even in older no-timeout implementations
    // Block the main process indefinitely. Only events are scheduled here, and the Main side is responsible for bounded retry and drain exit.
    void reportAppTelemetryEvent(
      platform,
      {
        elementName: "app_user_logout",
        eventRegion: "app_profile",
        eventType: "ck",
        eventExtraDetail: {},
        userId,
      },
      "Root",
    );
    const settingsBeforeLogout = await services.settingService.get();
    const nextProviderFamilyDomain = resolveLogoutProviderFamilyDomain({
      currentDomain: settingsBeforeLogout.providerFamilyDomain,
    });
    await services.oauthService.logout();
    await updateAppSettings({
      providerFamilyDomain: (nextProviderFamilyDomain ?? "") as AppSettings["providerFamilyDomain"],
      providerFamilyDomainUpdatedAt: Date.now(),
      providerFamilyDomainMigrated: true,
    });
    if (!nextProviderFamilyDomain) {
      onProviderFamilyDomainClearedAfterLogout?.();
    }
    // ZAI/BigModel provider has been reverted to the App login image.
    // The derived Coding/Start key is uniformly cleaned up by the host hook of OAuth logout, and Root is only responsible for refreshing the display state.
    setOAuthError(null);
    setUser(null);
    // Refresh the Account Source and Registry after logging out to avoid continuing to display the Provider status before logging out.
    await refreshProviderState();
    // Coding Plan official website webview uses independent persistent partition, App logout must be cleared synchronously.
    await platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);
    await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
  }, [
    intl,
    requestConfirmation,
    refreshProviderState,
    onProviderFamilyDomainClearedAfterLogout,
    platform,
    services.oauthService,
    services.modelSelectionService,
    services.settingService,
    setOAuthError,
    setUser,
    updateAppSettings,
    userId,
  ]);

  const handleSelectProject = useCallback(
    async (path: string) => {
      logger.info("[Root] handleSelectProject called with path:", path);
      try {
        // Desktop: Check if there is another window opening the directory, and if so, activate the tab corresponding to the window
        const result = await platform.activateOrSetWorkspace(path);
        if (result.activated) {
          logger.info(
            "[Root] the folder is already open in another window, activated that tab and skipped reopening",
          );
          return;
        }

        // Add a new tab (activate it if it is already open in this window)
        addTab(path);
        // Opening a workspace is a workspace-only intent, not "continue last session".
        // Even if an existing tab is hit, the activeTaskId of the workspace must be cleared and returned to the single-pane draft.
        startDraftInWorkspace(path);
        setWorkspaceActionError(null);

        // Update recent projects list
        if (supportsSettings) {
          // The host of the remote window does not provide settingService. Previously, recentProjects would still be updated here.
          // This causes the SSH scenario to hit the non-existent setting channel again after opening the project.
          // Only the local window maintains recent projects, and the remote window is only responsible for opening the current workspace.
          logger.info("[Root] calling settingService.get()...");
          const settings = await services.settingService.get();
          const updated = [
            path,
            ...settings.recentProjects.filter((projectPath) => projectPath !== path),
          ].slice(0, 10);
          await services.settingService.update({ recentProjects: updated });
          // The recent document entry of the Dock/Jump List system has been offline. Only the recentProjects in the application are retained here.
          // Avoid repeated maintenance of the system's recent items and project selection page lists, causing the content of the two entrances to drift.
          logger.info("[Root] settingService.update() done");
        }
      } catch (err) {
        logger.error("[Root] handleSelectProject error:", err);
      }
    },
    [
      addTab,
      intl,
      onOpenRemoteConnection,
      platform,
      requestConfirmation,
      services.settingService,
      startDraftInWorkspace,
      supportsSettings,
    ],
  );

  const handleOpenWorkspace = useCallback(() => {
    if (!allowOpenWorkspace) {
      // Web remote control currently only guarantees "entering the desktop workspace that has been opened".
      // If you continue to release "Open Workspace" here, the user will be taken to the middle page of Open Workspace.
      // However, subsequent new workspace/new session links were not completed in the Web remote control mode, and it looked like the page was stuck all the time.
      // The entrance is directly blocked here to avoid bringing the user into a semi-supported state.
      logger.info(
        "[Root] opening another workspace is not supported in this mode, ignoring the request",
      );
      return;
    }
    setWorkspaceActionError(null);

    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    // Opening the middle page of the workspace as a "new tab" will start in an empty state, Cmd/Ctrl+O
    // and menus seize the full page when opening a workspace. Opening the workspace is now only reserved as an action: local priority and direct selection of the system directory.
    // You no longer enter the intermediate page; for shells that do not support system directory selection, the startup package is responsible for creating the default workspace.
    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] failed to create the conversation workspace", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleOpenFolderFromWorkspaceMenu = useCallback(() => {
    if (!allowOpenWorkspace) {
      logger.info(
        "[Root] opening a folder from the empty-state menu is not supported in this mode, ignoring the request",
      );
      return;
    }

    // The Open folder of the empty workspace menu needs to reuse the root-level open workspace action.
    // Therefore, the same entry function is called here, and only the selectDirectory and project selection callbacks in Root are injected into it.
    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error(
          "[Root] failed to create the conversation workspace from the empty-state menu",
          { error },
        );
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleCreateScratchWorkspace = useCallback(
    async (name: string) => {
      if (!allowOpenWorkspace) {
        logger.info(
          "[Root] creating a workspace from the empty-state menu is not supported in this mode, ignoring the request",
        );
        return null;
      }

      const result = await services.fileService.createScratchWorkspace({ name });
      await handleSelectProject(result.path);
      return result.path;
    },
    [allowOpenWorkspace, handleSelectProject, services.fileService],
  );

  const handleCreateTask = useCallback(
    (request?: CreateTaskRequest) => {
      startNewTaskFromActiveWorkspace("sidebar new task", request);
    },
    [startNewTaskFromActiveWorkspace],
  );

  const handleBackFromSettings = useCallback(() => {
    if (!activeWorkspacePath) {
      return;
    }

    // When the settings page returns to the latest workspace, it cannot be activated by just pressing path.
    // Different remote identities may exist on the same path. Losing activeWorkspaceIdentity will cut the remote workspace to the path-only bucket.
    tabStoreApi
      .getState()
      .activateTabByPath(
        activeWorkspacePath,
        activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : undefined,
      );
  }, [activeWorkspaceIdentity, activeWorkspacePath, tabStoreApi]);

  return {
    workspaceActionError,
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleLogout,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateScratchWorkspace,
    handleCreateTask,
    handleBackFromSettings,
  };
}
