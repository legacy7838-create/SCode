/* eslint-disable max-lines -- The archive-view toggle follows the existing sidebar structure, so
 * keep it consolidated in the same file for now.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Archive,
  Blocks,
  CalendarClock,
  Clock3,
  Cloud,
  Folder,
  FolderOpen,
  Hash,
  ListFilter,
  Maximize2,
  MessageCircleCheck,
  MessageCirclePlus,
  Minimize2,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { RemoteTarget, UserInfo, ZCodeTaskMeta } from "@zcode/shared";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  TID_CONVERSATION_NEW_TASK,
  TID_CONVERSATION_SECTION,
  TID_AUTOMATIONS_OPEN,
  TID_PROJECT_ADD,
  TID_PROJECT_SECTION,
  TID_SIDEBAR,
  TID_WORKSPACE_LIST,
} from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly, isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { useWorkspaceTaskLists } from "@/hooks/useWorkspaceTaskLists.js";
import {
  persistSidebarTaskPreferences,
  readSidebarTaskPreferences,
  type SidebarTaskOrganizeBy,
  type SidebarTaskSortBy,
} from "@/lib/sidebarTaskPreferences.js";
import {
  persistSidebarPurposeSectionPreferences,
  readSidebarPurposeSectionPreferences,
  reorderSidebarPurposeSections,
} from "@/lib/sidebarPurposeSectionPreferences.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  increaseWorkspaceTaskVisibleLimit,
  resolveVisibleWorkspaceTaskKeys,
  retainWorkspaceTaskVisibleLimits,
  WORKSPACE_TASK_PAGE_SIZE,
  type WorkspaceTaskVisibleLimitByKey,
} from "@/lib/workspaceTaskPagination.js";
import { partitionWorkspaceTabsByPurpose } from "@/lib/workspacePurpose.js";
import {
  areAllGroupedTaskGroupsExpanded,
  pruneCollapsedGroupedTaskGroupIds,
} from "@/workspace-grouped-tasks/shared.js";
import {
  persistGroupedTaskCollapsedGroupIds,
  readGroupedTaskCollapsedGroupIds,
} from "@/lib/groupedTaskExpansionPreference.js";
import type { Theme } from "@/useTheme.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { WorkspaceFileTree } from "@/WorkspaceFileTree.js";
import { WorkspaceArchivedTasksFlatSection } from "@/WorkspaceArchivedTasksFlatSection.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { WorkspacePinnedTasksSection } from "@/WorkspacePinnedTasksSection.js";
import { WorkspaceTimelineTasksSection } from "@/WorkspaceTimelineTasksSection.js";
import { WorkspaceGroupedTasksSection } from "@/WorkspaceGroupedTasksSection.js";
import { StickyGroupHeaderSlot } from "@/workspace-grouped-tasks/sticky-group-header-slot.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import {
  SortableWorkspaceSidebarItem,
  restrictVerticalDragWithinContainer,
} from "./SortableWorkspaceSidebar.js";
import {
  resolveSidebarTaskGroupTogglePresentation,
  type SidebarTaskGroupTogglePresentation,
} from "@/WorkspaceSidebar/taskGroupTogglePresentation.js";
import { WorkspacePurposeSection } from "@/WorkspaceSidebar/WorkspacePurposeSection.js";
import { cn } from "@/components/lib/utils.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import {
  resolveWorkspaceDragGlobalIndices,
  resolveWorkspaceDragExpanded,
  workspaceVerticalListSortingStrategy,
} from "@/lib/workspaceSidebarDrag.js";
import { createPortal } from "react-dom";

function WorkspaceNewTaskTooltip({
  children,
  disabledReason,
}: {
  children: ReactNode;
  disabledReason?: string;
}) {
  // In the normal state, the button already has the "New Task" text and shortcut key. If you hang the tooltip again, it will just be repeated; the reason will only be explained when it is disabled.
  if (!disabledReason) return children;
  return (
    <ControlHintTooltip title={disabledReason}>
      <div>{children}</div>
    </ControlHintTooltip>
  );
}
export { applyWorkspaceTriggerSelection } from "@/WorkspaceSidebar/workspaceSidebarSelection.js";
export { WorkspaceSidebarCollapsedRail } from "@/WorkspaceSidebar/WorkspaceSidebarCollapsedRail.js";

type TaskOrganizeBy = SidebarTaskOrganizeBy;
type TaskSortBy = SidebarTaskSortBy;
type PrimaryTaskMode = "workspace" | "grouped";
type SidebarTaskViewMode = "grouped" | "workspace" | "timeline" | "archived";

interface SidebarFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
}

// Streaming task events will cause the sidebar parent to refresh frequently; if there is a lack of task grouping, if a new [] is passed
// This will cause memo's workspace line to misjudge taskItems changes and penetrate into TaskList/TaskListItem to re-render.
const EMPTY_WORKSPACE_TASK_ITEMS: ZCodeTaskMeta[] = [];
// WorkspaceSidebar is a memo component, and {} in the default parameters will create a new reference every time it is called;
// By default, the same object must be reused when reconnecting logs remotely to prevent shallow comparisons from being penetrated by default values.
const EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY: Record<
  string,
  RemoteConnectionLogEntry[]
> = {};

function WorkspaceDragOverlay({ tab, width }: { tab: WorkspaceTabState; width: number | null }) {
  const isRemote = Boolean(tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity);
  return (
    <div
      data-testid="workspace-drag-overlay"
      className="pointer-events-none flex cursor-grabbing items-center rounded-lg border border-border bg-background text-ui-base text-foreground shadow-lg h-8 px-2.5 gap-2 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0"
      style={width ? { width } : undefined}
    >
      {/* The project list icon lives inside the Button, where the button's SVG rule collapses the
          running state to 14px; once the overlay leaves the Button it no longer inherits that rule,
          so it sets the same size explicitly to keep the preview icon from scaling up.
          */}
      {isRemote ? (
        <Cloud className="size-3.5 shrink-0 text-foreground-subtle" />
      ) : (
        <Folder className="size-3.5 shrink-0 text-foreground-subtle" />
      )}
      <span className="min-w-0 flex-1 truncate px-1">{tab.label}</span>
    </div>
  );
}

export interface SidebarFileTreeOpenRequest {
  id: number;
  target: SidebarFileTreeTarget;
}

function resolveSidebarTaskViewMode(params: {
  showArchivedTasks: boolean;
  taskOrganizeBy: TaskOrganizeBy;
}): SidebarTaskViewMode {
  if (params.showArchivedTasks) {
    return "archived";
  }
  if (params.taskOrganizeBy === "chronological") {
    return "timeline";
  }
  if (params.taskOrganizeBy === "grouped") {
    return "grouped";
  }
  return "workspace";
}

export const WorkspaceSidebar = memo(function WorkspaceSidebarComponent({
  workspacePath,
  workspaceRemoteSessionId,
  activePreviewPath,
  onSelectTask,
  onStartDraftInWorkspace,
  onOpenCodeViewer,
  onOpenBrowserUrl,
  fileTreeOpenRequest,
  onCreateTask,
  onCreateConversationTask,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  theme,
  onConnectRemote: _onConnectRemote,
  onSelectRemoteProject: _onSelectRemoteProject,
  onCancelRemoteProject: _onCancelRemoteProject,
  onReconnectRemoteWorkspace,
  onLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey = EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY,
  isDesktop = false,
  isMacDesktop: _isMacDesktop = false,
  isWindowsDesktop = false,
  isSidebarVisible: _isSidebarVisible = true,
  onToggleSidebar: _onToggleSidebar,
  toggleSidebarShortcutLabel: _toggleSidebarShortcutLabel,
  canGoBack: _canGoBack = false,
  canGoForward: _canGoForward = false,
  onGoBack: _onGoBack,
  onGoForward: _onGoForward,
  goBackShortcutLabel: _goBackShortcutLabel,
  goForwardShortcutLabel: _goForwardShortcutLabel,
  onOpenCommandCenter,
  onOpenAutomations,
  onOpenPluginStore,
  automationsActive = false,
  pluginStoreActive = false,
  onFileTreeOpenChange,
}: {
  workspacePath: string;
  workspaceRemoteSessionId?: string;
  activePreviewPath?: string | null;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    targetRemoteSessionId?: string,
    expectedUnreadAt?: number,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenBrowserUrl?: (url: string) => void;
  fileTreeOpenRequest?: SidebarFileTreeOpenRequest | null;
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask: () => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onOpenRemoteWorkspace?: () => void;
  theme: Theme;
  onConnectRemote: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onLogout?: () => void;
  onLogin?: () => void;
  user?: UserInfo | null;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey?: Record<string, RemoteConnectionLogEntry[]>;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isSidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  toggleSidebarShortcutLabel?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  goBackShortcutLabel?: string;
  goForwardShortcutLabel?: string;
  onOpenCommandCenter: () => void;
  onOpenAutomations?: () => void;
  onOpenPluginStore?: () => void;
  automationsActive?: boolean;
  pluginStoreActive?: boolean;
  onFileTreeOpenChange?: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const handleTaskRowSelect = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentity?: string,
      expectedUnreadAt?: number,
    ) => {
      // The fourth parameter of Shell is the remote session route. The unreadAt of the task line cannot reuse this location.
      // Sidebar row selection explicitly leaves remoteSessionId blank, and then passes the unread version seen by the user to the read transaction.
      onSelectTask(
        targetWorkspacePath,
        taskId,
        targetWorkspaceIdentity,
        undefined,
        expectedUnreadAt,
      );
    },
    [onSelectTask],
  );
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const bumpTaskListVersion = useZCodeSessionStore((state) => state.bumpTaskListVersion);
  const workspaceIdentity = useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspacePath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
  const workspaceReadOnly = useTabStore((state) =>
    isWorkspaceReadOnly(state, workspacePath, workspaceIdentity),
  );
  const workspaceReadOnlyReason = workspaceReadOnly
    ? intl.formatMessage({
        id: "workspaceSidebar.unavailableLocalDirectory",
      })
    : undefined;
  const setTheme = useZCodeStore((state) => state.setTheme);
  const commandCenterShortcutLabel = useShortcutCommandLabel("openCommandCenter");
  const tabs = useTabStore((state) => state.tabs);
  const activateTab = useTabStore((state) => state.activateTab);
  const closeTab = useTabStore((state) => state.closeTab);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const expandedWorkspacePaths = useTabStore((state) => state.expandedWorkspacePaths);
  const toggleWorkspaceExpanded = useTabStore((state) => state.toggleWorkspaceExpanded);
  const reorderWorkspaceTabs = useTabStore((state) => state.reorderWorkspaceTabs);
  const expandAllWorkspaceTabs = useTabStore((state) => state.expandAllWorkspaceTabs);
  const collapseAllWorkspaceTabs = useTabStore((state) => state.collapseAllWorkspaceTabs);

  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const { conversationWorkspaceTabs, projectWorkspaceTabs } = useMemo(
    () => partitionWorkspaceTabsByPurpose(workspaceTabs),
    [workspaceTabs],
  );
  const workspacePaths = useMemo(
    () => projectWorkspaceTabs.map((tab) => tab.workspacePath),
    [projectWorkspaceTabs],
  );
  const areAllWorkspaceGroupsExpanded = useMemo(
    () =>
      workspacePaths.length > 0 && workspacePaths.every((path) => expandedWorkspacePaths.has(path)),
    [expandedWorkspacePaths, workspacePaths],
  );
  const [showArchivedTasks, setShowArchivedTasks] = useState(false);
  const [archivedActionsContainer, setArchivedActionsContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(false);
  const [fileTreeTarget, setFileTreeTarget] = useState<SidebarFileTreeTarget | null>(null);
  const [groupedStickyHeader, setGroupedStickyHeader] = useState<ReactNode | null>(null);
  const [taskOrganizeBy, setTaskOrganizeBy] = useState<TaskOrganizeBy>(
    () => readSidebarTaskPreferences().organizeBy,
  );
  const [taskSortBy, setTaskSortBy] = useState<TaskSortBy>(
    () => readSidebarTaskPreferences().sortBy,
  );
  const [purposeSectionPreferences, setPurposeSectionPreferences] = useState(
    readSidebarPurposeSectionPreferences,
  );
  const [workspaceTaskOrganizeBy, setWorkspaceTaskOrganizeBy] = useState<
    Extract<TaskOrganizeBy, "project" | "chronological">
  >(() => {
    const initialOrganizeBy = readSidebarTaskPreferences().organizeBy;
    return initialOrganizeBy === "chronological" ? "chronological" : "project";
  });
  const [workspaceTaskVisibleLimitByKey, setWorkspaceTaskVisibleLimitByKey] =
    useState<WorkspaceTaskVisibleLimitByKey>({});
  const [activeWorkspaceDragId, setActiveWorkspaceDragId] = useState<string | null>(null);
  const [activeWorkspaceDragWidth, setActiveWorkspaceDragWidth] = useState<number | null>(null);
  const [groupedTaskGroupIds, setGroupedTaskGroupIds] = useState<string[]>([]);
  const [groupedTaskGroupIdsHydrated, setGroupedTaskGroupIdsHydrated] = useState(false);
  const [lastNonEmptyGroupedTaskGroupIds, setLastNonEmptyGroupedTaskGroupIds] = useState<string[]>(
    [],
  );
  const [groupedTaskGroupSnapshotHasGroups, setGroupedTaskGroupSnapshotHasGroups] = useState<
    boolean | null
  >(null);
  const [collapsedGroupedTaskGroupIds, setCollapsedGroupedTaskGroupIds] = useState<Set<string>>(
    () => readGroupedTaskCollapsedGroupIds(),
  );
  const handleProjectSectionOpenChange = useCallback((projectsExpanded: boolean) => {
    setPurposeSectionPreferences((current) => {
      if (current.projectsExpanded === projectsExpanded) {
        return current;
      }
      const next = { ...current, projectsExpanded };
      persistSidebarPurposeSectionPreferences(next);
      return next;
    });
  }, []);
  const handleConversationSectionOpenChange = useCallback((conversationsExpanded: boolean) => {
    setPurposeSectionPreferences((current) => {
      if (current.conversationsExpanded === conversationsExpanded) {
        return current;
      }
      const next = { ...current, conversationsExpanded };
      persistSidebarPurposeSectionPreferences(next);
      return next;
    });
  }, []);
  const handlePurposeSectionDragEnd = useCallback((event: DragEndEvent) => {
    if (!event.over) {
      return;
    }

    setPurposeSectionPreferences((current) => {
      const sectionOrder = reorderSidebarPurposeSections(
        current.sectionOrder,
        String(event.active.id),
        String(event.over?.id),
      );
      if (sectionOrder.every((sectionId, index) => sectionId === current.sectionOrder[index])) {
        return current;
      }

      const next = { ...current, sectionOrder };
      persistSidebarPurposeSectionPreferences(next);
      return next;
    });
  }, []);
  const primaryTaskTabsListRef = useRef<HTMLDivElement | null>(null);
  const primaryTaskTabTriggerRefs = useRef<Record<PrimaryTaskMode, HTMLButtonElement | null>>({
    workspace: null,
    grouped: null,
  });
  const [primaryTaskIndicatorStyle, setPrimaryTaskIndicatorStyle] = useState<CSSProperties>({
    opacity: 0,
    transform: "translateX(0px)",
    width: 0,
  });
  const lastStableTaskGroupTogglePresentationRef =
    useRef<SidebarTaskGroupTogglePresentation | null>(null);
  const handleCollapsedGroupedTaskGroupIdsChange = useCallback(
    (updater: SetStateAction<Set<string>>) => {
      setCollapsedGroupedTaskGroupIds((currentGroupIds) => {
        const nextGroupIds = typeof updater === "function" ? updater(currentGroupIds) : updater;
        if (nextGroupIds === currentGroupIds) {
          return currentGroupIds;
        }
        // The grouped expanded state is a local user preference and cannot be stored only in React memory.
        // Single group clicks, batch buttons, and recovery after dragging and temporarily collapsing must be synchronized to localStorage.
        persistGroupedTaskCollapsedGroupIds(nextGroupIds);
        return nextGroupIds;
      });
    },
    [],
  );
  const handleGroupedTaskGroupIdsChange = useCallback(
    (nextGroupIds: string[]) => {
      if (
        nextGroupIds.length === 0 &&
        !groupedTaskGroupIdsHydrated &&
        groupedTaskGroupSnapshotHasGroups !== false &&
        (lastNonEmptyGroupedTaskGroupIds.length > 0 || collapsedGroupedTaskGroupIds.size > 0)
      ) {
        // When switching back to Group from Project or entering Group for the first time after restarting,
        // If the sqlite view has not been loaded in the first frame of the sublist, empty groupIds will be returned first.
        // This instantaneous empty snapshot cannot be regarded as "all groups have been deleted", otherwise the user will close their preferences
        // prune is empty and written back to localStorage.
        return;
      }

      setGroupedTaskGroupIdsHydrated(true);
      setGroupedTaskGroupSnapshotHasGroups(nextGroupIds.length > 0);
      if (nextGroupIds.length > 0) {
        setLastNonEmptyGroupedTaskGroupIds(nextGroupIds);
      }
      setGroupedTaskGroupIds((currentGroupIds) =>
        currentGroupIds.length === nextGroupIds.length &&
        currentGroupIds.every((groupId, index) => groupId === nextGroupIds[index])
          ? currentGroupIds
          : nextGroupIds,
      );
      setCollapsedGroupedTaskGroupIds((currentGroupIds) => {
        const nextCollapsedGroupIds = pruneCollapsedGroupedTaskGroupIds(
          currentGroupIds,
          nextGroupIds,
        );
        if (
          nextCollapsedGroupIds.size === currentGroupIds.size &&
          [...nextCollapsedGroupIds].every((groupId) => currentGroupIds.has(groupId))
        ) {
          return currentGroupIds;
        }
        // After refreshing or restarting, the grouped expanded state needs to be restored from localStorage;
        // When the view is refreshed, the old collapsing records of the deleted group must also be cleared to prevent the new group from being accidentally hit by the old state.
        persistGroupedTaskCollapsedGroupIds(nextCollapsedGroupIds);
        return nextCollapsedGroupIds;
      });
    },
    [
      groupedTaskGroupIdsHydrated,
      groupedTaskGroupSnapshotHasGroups,
      collapsedGroupedTaskGroupIds.size,
      lastNonEmptyGroupedTaskGroupIds.length,
    ],
  );

  useEffect(() => {
    if (!fileTreeOpenRequest) {
      return;
    }
    setFileTreeTarget(fileTreeOpenRequest.target);
    setIsFileTreeOpen(true);
  }, [fileTreeOpenRequest]);
  useEffect(() => {
    onFileTreeOpenChange?.(isFileTreeOpen);
  }, [isFileTreeOpen, onFileTreeOpenChange]);
  useEffect(() => {
    return () => onFileTreeOpenChange?.(false);
  }, [onFileTreeOpenChange]);
  useEffect(() => {
    persistSidebarTaskPreferences({
      organizeBy: taskOrganizeBy,
      sortBy: taskSortBy,
    });
  }, [taskOrganizeBy, taskSortBy]);
  useEffect(() => {
    if (taskOrganizeBy === "project" || taskOrganizeBy === "chronological") {
      setWorkspaceTaskOrganizeBy(taskOrganizeBy);
    }
  }, [taskOrganizeBy]);
  const taskViewMode = resolveSidebarTaskViewMode({
    showArchivedTasks,
    taskOrganizeBy,
  });
  const effectiveTaskViewMode = taskViewMode;
  const visibleWorkspaceTaskKeys = useMemo(
    () =>
      resolveVisibleWorkspaceTaskKeys({
        enabled:
          effectiveTaskViewMode === "workspace" && purposeSectionPreferences.projectsExpanded,
        expandedWorkspacePaths,
        workspaces: projectWorkspaceTabs,
      }),
    [
      effectiveTaskViewMode,
      expandedWorkspacePaths,
      projectWorkspaceTabs,
      purposeSectionPreferences.projectsExpanded,
    ],
  );
  useEffect(() => {
    // Interaction rules: Pagination progress only belongs to the currently visible and expanded workspace.
    // Single group/project area/collapse all, switch views or remove workspace are all cleaned up through the same visible collection.
    // Avoid omissions due to separate maintenance of reset logic for different folding entrances.
    setWorkspaceTaskVisibleLimitByKey((current) =>
      retainWorkspaceTaskVisibleLimits(current, visibleWorkspaceTaskKeys),
    );
  }, [visibleWorkspaceTaskKeys]);
  useEffect(() => {
    if (taskViewMode !== "grouped") {
      setGroupedStickyHeader(null);
    }
  }, [taskViewMode]);
  const [createGroupedTaskGroupAction, setCreateGroupedTaskGroupAction] = useState<
    (() => void) | null
  >(null);
  const [createGroupedTaskDraftAction, setCreateGroupedTaskDraftAction] = useState<
    (() => void) | null
  >(null);
  const handleCreateGroupActionChange = useCallback((action: (() => void) | null) => {
    setCreateGroupedTaskGroupAction(() => action);
  }, []);
  const handleCreateDraftTaskActionChange = useCallback((action: (() => void) | null) => {
    setCreateGroupedTaskDraftAction(() => action);
  }, []);
  const shouldShowPinnedTasks =
    // The grouped subject will actively filter pinned tasks; if the global pinned area is not rendered on the same page,
    // After pinning the current task from the Header, the entire row will be displayed nowhere, and it looks like the session has been deleted.
    taskViewMode === "workspace" ||
    taskViewMode === "timeline" ||
    taskViewMode === "archived" ||
    taskViewMode === "grouped";
  const workspaceScrollRef = useRef<HTMLDivElement | null>(null);
  const [showWorkspaceTopMask, setShowWorkspaceTopMask] = useState(false);
  const [showWorkspaceBottomMask, setShowWorkspaceBottomMask] = useState(false);
  const workspaceSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const purposeSectionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const workspaceTaskLists = useWorkspaceTaskLists({
    workspaceTabs: projectWorkspaceTabs,
    activeWorkspacePath: workspacePath,
    activeWorkspaceIdentity: workspaceIdentity,
    sortBy: taskSortBy,
    visibleLimitByWorkspaceKey: workspaceTaskVisibleLimitByKey,
    defaultVisibleLimit: WORKSPACE_TASK_PAGE_SIZE,
  });
  const workspaceTaskGroupByKey = useMemo(
    () =>
      new Map(
        workspaceTaskLists.groups.map((group) => [
          buildTaskWorkspaceKey(group.workspacePath, group.workspaceIdentity),
          group,
        ]),
      ),
    [workspaceTaskLists.groups],
  );
  const handleShowMoreWorkspaceTasks = useCallback((workspaceKey: string) => {
    setWorkspaceTaskVisibleLimitByKey((current) =>
      increaseWorkspaceTaskVisibleLimit(current, workspaceKey),
    );
  }, []);
  const handleOpenWorkspaceFileTree = useCallback((target: SidebarFileTreeTarget) => {
    setFileTreeTarget(target);
    setIsFileTreeOpen(true);
  }, []);
  const workspaceScrollMaskStyle = useMemo<CSSProperties>(() => {
    const baseStyle: CSSProperties = { overflowAnchor: "none" };
    if (!showWorkspaceTopMask && !showWorkspaceBottomMask) {
      return baseStyle;
    }
    const topStop = showWorkspaceTopMask ? "transparent 0px, black 32px" : "black 0px, black 32px";
    const bottomStop = showWorkspaceBottomMask
      ? "black calc(100% - 32px), transparent 100%"
      : "black calc(100% - 32px), black 100%";

    return {
      ...baseStyle,
      // Here we apply CSS mask directly to the scroll container instead of covering it with an overlay.
      // In this way, the top and bottom fades will act on the real content and disappear immediately when scrolling to the border.
      WebkitMaskImage: `linear-gradient(to bottom, ${topStop}, ${bottomStop})`,
      maskImage: `linear-gradient(to bottom, ${topStop}, ${bottomStop})`,
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
      WebkitMaskSize: "100% 100%",
      maskSize: "100% 100%",
    };
  }, [showWorkspaceBottomMask, showWorkspaceTopMask]);

  const resetWorkspaceDrag = useCallback(() => {
    setActiveWorkspaceDragId(null);
    setActiveWorkspaceDragWidth(null);
  }, []);
  const handleWorkspaceDragStart = useCallback((event: DragStartEvent) => {
    setActiveWorkspaceDragId(String(event.active.id));
    setActiveWorkspaceDragWidth(event.active.rect.current.initial?.width ?? null);
  }, []);
  const handleWorkspaceDragCancel = useCallback(
    (_event: DragCancelEvent) => {
      resetWorkspaceDrag();
    },
    [resetWorkspaceDrag],
  );
  const handleWorkspaceDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      resetWorkspaceDrag();
      if (!over || active.id === over.id) {
        return;
      }

      // Project drag only displays the project subsequence, but tabStore saves the entire workspace sequence.
      // Directly mixing the two indexes will drop items in the wrong location when the conversation workspace exists.
      const indices = resolveWorkspaceDragGlobalIndices({
        activeId: String(active.id),
        overId: String(over.id),
        projectTabs: projectWorkspaceTabs,
        workspaceTabs,
      });
      if (indices) {
        reorderWorkspaceTabs(indices.fromIndex, indices.toIndex);
      }
    },
    [projectWorkspaceTabs, reorderWorkspaceTabs, resetWorkspaceDrag, workspaceTabs],
  );
  const activeWorkspaceDragTab = useMemo(
    () =>
      activeWorkspaceDragId
        ? (projectWorkspaceTabs.find((tab) => tab.id === activeWorkspaceDragId) ?? null)
        : null,
    [activeWorkspaceDragId, projectWorkspaceTabs],
  );

  const handleThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        setTheme(value);
      }
    },
    [setTheme],
  );

  const handleOpenPluginStoreMain = useCallback(() => {
    onOpenPluginStore?.();
  }, [onOpenPluginStore]);
  const handleOpenAutomationsMain = useCallback(() => {
    onOpenAutomations?.();
  }, [onOpenAutomations]);
  const handleOpenCodingPlanUpgrade = useCallback(
    (
      providerId: string,
      funnelContext?: import("@/lib/codingPlanFunnelTelemetry.js").CodingPlanFunnelContext,
    ) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext,
      });
    },
    [openCodingPlanUpgrade],
  );
  const activeTaskId = useZCodeSessionStore(
    (state) =>
      // When Web remote control enters the remote workspace from the global task entrance, you will first press
      // workspaceIdentity is written to activeTaskId; if the sidebar is still read-only in the path-only bucket,
      // The current task highlighting will be lost, and subsequent selections will be misjudged as inactive.
      selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).activeTaskId,
  );

  useEffect(() => {
    const scrollNode = workspaceScrollRef.current;
    if (!scrollNode) {
      return;
    }

    const contentNode = scrollNode.firstElementChild;

    const updateWorkspaceScrollMask = () => {
      const hasOverflow = scrollNode.scrollHeight > scrollNode.clientHeight + 1;
      const isAtTop = scrollNode.scrollTop <= 1;
      const isAtBottom =
        scrollNode.scrollTop + scrollNode.clientHeight >= scrollNode.scrollHeight - 1;

      setShowWorkspaceTopMask(hasOverflow && !isAtTop);
      setShowWorkspaceBottomMask(hasOverflow && !isAtBottom);
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateWorkspaceScrollMask;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    // The workspace list's scrollbar only appears after the content overflows.
    // If you only listen to scroll, scenarios such as "Scroll bars are generated for the first time after expanding the workspace" will not immediately cause the top/bottom to fade out;
    // Here, the container and content size changes are monitored at the same time, so that the mask can be updated along with the content increase or decrease and the scroll position.
    updateWorkspaceScrollMask();

    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateWorkspaceScrollMask;
      debouncedUpdate();
    });
    resizeObserver.observe(scrollNode);
    if (contentNode instanceof HTMLElement) {
      resizeObserver.observe(contentNode);
    }

    scrollNode.addEventListener("scroll", updateWorkspaceScrollMask, {
      passive: true,
    });
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      resizeObserver.disconnect();
      scrollNode.removeEventListener("scroll", updateWorkspaceScrollMask);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [expandedWorkspacePaths, workspaceTabs.length]);

  const isGroupedTaskGroupView = !showArchivedTasks && taskOrganizeBy === "grouped";
  const toggleableGroupedTaskGroupIds =
    groupedTaskGroupIds.length > 0
      ? groupedTaskGroupIds
      : groupedTaskGroupSnapshotHasGroups === false
        ? []
        : lastNonEmptyGroupedTaskGroupIds;
  const showOptimisticGroupedTaskGroupToggle =
    isGroupedTaskGroupView &&
    !groupedTaskGroupIdsHydrated &&
    groupedTaskGroupSnapshotHasGroups !== false;
  const showToggleAllGroupedTaskGroups =
    isGroupedTaskGroupView &&
    (groupedTaskGroupIds.length > 0 || showOptimisticGroupedTaskGroupToggle);
  const canToggleAllGroupedTaskGroups =
    isGroupedTaskGroupView && toggleableGroupedTaskGroupIds.length > 0;
  const areAllToggleableGroupedTaskGroupsOpen = areAllGroupedTaskGroupsExpanded(
    toggleableGroupedTaskGroupIds,
    collapsedGroupedTaskGroupIds,
  );
  const canToggleAllProjectTaskGroups =
    !showArchivedTasks && taskOrganizeBy === "project" && projectWorkspaceTabs.length > 0;
  const showToggleAllTaskGroups = canToggleAllProjectTaskGroups || showToggleAllGroupedTaskGroups;
  const canToggleAllTaskGroups = canToggleAllProjectTaskGroups || canToggleAllGroupedTaskGroups;
  const areAllTaskGroupsExpanded =
    taskOrganizeBy === "grouped"
      ? areAllToggleableGroupedTaskGroupsOpen
      : purposeSectionPreferences.projectsExpanded && areAllWorkspaceGroupsExpanded;
  const toggleAllTaskGroupsTransitionPending = showOptimisticGroupedTaskGroupToggle;
  const toggleAllTaskGroupsPresentation = resolveSidebarTaskGroupTogglePresentation({
    current: {
      visible: showToggleAllTaskGroups,
      canToggle: canToggleAllTaskGroups,
      areAllExpanded: areAllTaskGroupsExpanded,
      transitionPending: toggleAllTaskGroupsTransitionPending,
    },
    previous: lastStableTaskGroupTogglePresentationRef.current,
  });
  const activePrimaryTaskMode: PrimaryTaskMode =
    taskOrganizeBy === "grouped" ? "grouped" : "workspace";
  const workspaceTaskViewValue = taskOrganizeBy === "chronological" ? "chronological" : "project";
  const showTaskViewFilter = activePrimaryTaskMode === "workspace" || showArchivedTasks;
  const showWorkspaceViewOptions = activePrimaryTaskMode === "workspace" && !showArchivedTasks;
  const showTaskSortOptions = activePrimaryTaskMode === "workspace" || showArchivedTasks;
  const handlePrimaryTaskModeChange = useCallback(
    (value: string) => {
      logger.debug("[WorkspaceSidebar] switching task top-level view", {
        from: taskOrganizeBy,
        to: value,
        groupedHydrated: groupedTaskGroupIdsHydrated,
        groupedCount: groupedTaskGroupIds.length,
        lastGroupedCount: lastNonEmptyGroupedTaskGroupIds.length,
      });
      if (value === "grouped") {
        setGroupedTaskGroupIdsHydrated(false);
        setTaskOrganizeBy("grouped");
        return;
      }
      if (value === "workspace") {
        setTaskOrganizeBy(workspaceTaskOrganizeBy);
      }
    },
    [
      groupedTaskGroupIds.length,
      groupedTaskGroupIdsHydrated,
      lastNonEmptyGroupedTaskGroupIds.length,
      taskOrganizeBy,
      workspaceTaskOrganizeBy,
    ],
  );
  const handleWorkspaceTaskViewChange = useCallback((value: string) => {
    if (value !== "project" && value !== "chronological") {
      return;
    }
    setWorkspaceTaskOrganizeBy(value);
    setTaskOrganizeBy(value);
  }, []);
  const handleToggleAllTaskGroups = useCallback(() => {
    if (!canToggleAllTaskGroups) {
      return;
    }
    if (taskOrganizeBy === "grouped") {
      if (toggleableGroupedTaskGroupIds.length === 0) {
        return;
      }
      handleCollapsedGroupedTaskGroupIdsChange(
        areAllToggleableGroupedTaskGroupsOpen ? new Set(toggleableGroupedTaskGroupIds) : new Set(),
      );
      return;
    }
    if (purposeSectionPreferences.projectsExpanded && areAllWorkspaceGroupsExpanded) {
      handleProjectSectionOpenChange(false);
      collapseAllWorkspaceTabs(workspacePaths);
      return;
    }

    handleProjectSectionOpenChange(true);
    expandAllWorkspaceTabs(workspacePaths);
  }, [
    areAllWorkspaceGroupsExpanded,
    areAllToggleableGroupedTaskGroupsOpen,
    canToggleAllTaskGroups,
    collapseAllWorkspaceTabs,
    expandAllWorkspaceTabs,
    handleCollapsedGroupedTaskGroupIdsChange,
    handleProjectSectionOpenChange,
    purposeSectionPreferences.projectsExpanded,
    taskOrganizeBy,
    toggleableGroupedTaskGroupIds,
    workspacePaths,
  ]);
  useEffect(() => {
    // The Group view will return the group ids in the next round of component rendering after switching.
    // If you switch frames and directly use an unhydrated model, the button will briefly change to the disabled/expand icon, causing flickering.
    // Therefore, the display model of the previous frame is reused while waiting for hydrate; the actual click ability is still guarded by the current state of handleToggleAllTaskGroups.
    if (!toggleAllTaskGroupsTransitionPending) {
      lastStableTaskGroupTogglePresentationRef.current = toggleAllTaskGroupsPresentation;
    }
  }, [toggleAllTaskGroupsPresentation, toggleAllTaskGroupsTransitionPending]);

  useLayoutEffect(() => {
    const listNode = primaryTaskTabsListRef.current;
    if (!listNode) {
      return;
    }

    const updateIndicator = () => {
      const activeTrigger = primaryTaskTabTriggerRefs.current[activePrimaryTaskMode];
      if (!activeTrigger) {
        return;
      }

      const nextTransform = `translateX(${activeTrigger.offsetLeft}px)`;
      const nextWidth = activeTrigger.offsetWidth;
      setPrimaryTaskIndicatorStyle((current) =>
        current.opacity === 1 && current.transform === nextTransform && current.width === nextWidth
          ? current
          : {
              opacity: 1,
              transform: nextTransform,
              width: nextWidth,
            },
      );
    };

    let animationFrameId: number | null = null;
    const scheduleUpdate = () => {
      if (animationFrameId !== null) {
        return;
      }
      animationFrameId = requestAnimationFrame(() => {
        animationFrameId = null;
        updateIndicator();
      });
    };

    updateIndicator();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(listNode);
    for (const triggerNode of Object.values(primaryTaskTabTriggerRefs.current)) {
      if (triggerNode) {
        resizeObserver?.observe(triggerNode);
      }
    }
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [activePrimaryTaskMode]);

  const archivedTasksActionLabel = intl.formatMessage({
    // After the archive view is opened, the button icon will switch to X. Before, the tooltip still fixedly displayed "Archive".
    // The semantics of the icon are inconsistent with the copy. Change the open status to Close and synchronize aria-label at the same time.
    id: showArchivedTasks ? "common.close" : "workspaceSidebar.toggleArchivedTasks",
  });
  // Performance fix: workspaceTaskToolbar will be repeatedly created with chat streaming and passed to the remote control task index.
  // Here, the render prop is stabilized in a state that actually affects the toolbar display, so as to avoid message flow updates from polluting the sidebar task area.
  const workspaceTaskToolbar = useCallback(
    () => (
      <div className="pl-2.5 pr-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 shrink-0 items-center gap-1">
            <Tabs
              value={activePrimaryTaskMode}
              onValueChange={handlePrimaryTaskModeChange}
              className="w-fit shrink-0"
              aria-label={intl.formatMessage({
                id: "workspaceSidebar.organize",
              })}
            >
              {/* TabsList's default horizontal state is h-8; the variant is overridden in step here, so the real Radix horizontal state does not stretch the shell taller. */}
              <TabsList
                ref={primaryTaskTabsListRef}
                className="relative h-7 w-fit overflow-hidden rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-7"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0.5 left-0 rounded-full bg-background transition-[opacity,transform,width] duration-200 ease-out"
                  style={primaryTaskIndicatorStyle}
                />
                <TabsTrigger
                  ref={(node) => {
                    primaryTaskTabTriggerRefs.current.grouped = node;
                  }}
                  value="grouped"
                  className="relative z-10 h-6 flex-none gap-1 rounded-full border-transparent bg-transparent py-0 pl-1.5 pr-2 text-ui-sm font-medium text-foreground-subtle transition-colors data-active:border-transparent data-active:bg-transparent data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
                >
                  <Hash aria-hidden="true" className="size-3 shrink-0" />
                  <span>
                    {intl.formatMessage({
                      id: "workspaceSidebar.organizeGrouped",
                    })}
                  </span>
                </TabsTrigger>
                <TabsTrigger
                  ref={(node) => {
                    primaryTaskTabTriggerRefs.current.workspace = node;
                  }}
                  value="workspace"
                  className="relative z-10 h-6 flex-none gap-1 rounded-full border-transparent bg-transparent py-0 pl-1.5 pr-2 text-ui-sm font-medium text-foreground-subtle transition-colors data-active:border-transparent data-active:bg-transparent data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
                >
                  <Folder aria-hidden="true" className="size-3 shrink-0" />
                  <span>
                    {intl.formatMessage({
                      id: "workspaceSidebar.organizeByProject",
                    })}
                  </span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {toggleAllTaskGroupsPresentation ? (
              <ControlHintTooltip
                title={intl.formatMessage({
                  id: toggleAllTaskGroupsPresentation.messageId,
                })}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-foreground-subtle hover:text-foreground"
                  aria-label={intl.formatMessage({
                    id: toggleAllTaskGroupsPresentation.messageId,
                  })}
                  disabled={!toggleAllTaskGroupsPresentation.canToggle}
                  onClick={handleToggleAllTaskGroups}
                >
                  {toggleAllTaskGroupsPresentation.areAllExpanded ? (
                    <Minimize2 className="size-3.5" />
                  ) : (
                    <Maximize2 className="size-3.5" />
                  )}
                </Button>
              </ControlHintTooltip>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {taskViewMode === "grouped" ? (
              <ControlHintTooltip
                title={workspaceReadOnlyReason ?? intl.formatMessage({ id: "taskGroup.newGroup" })}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-foreground-subtle hover:text-foreground"
                  aria-label={intl.formatMessage({
                    id: "taskGroup.newGroup",
                  })}
                  disabled={workspaceReadOnly || !createGroupedTaskGroupAction}
                  onClick={() => {
                    if (!workspaceReadOnly) {
                      createGroupedTaskGroupAction?.();
                    }
                  }}
                >
                  <Hash className="size-3.5" />
                </Button>
              </ControlHintTooltip>
            ) : null}
            {showTaskViewFilter ? (
              <DropdownMenu>
                <ControlHintTooltip
                  title={intl.formatMessage({
                    id: "workspaceSidebar.taskViewOptions",
                  })}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-foreground-subtle hover:text-foreground"
                      aria-label={intl.formatMessage({
                        id: "workspaceSidebar.taskViewOptions",
                      })}
                    >
                      <ListFilter className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </ControlHintTooltip>
                <DropdownMenuContent align="end" className="w-48 min-w-48">
                  {showWorkspaceViewOptions ? (
                    <>
                      <DropdownMenuLabel>
                        {intl.formatMessage({
                          id: "workspaceSidebar.organize",
                        })}
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={workspaceTaskViewValue}
                        onValueChange={handleWorkspaceTaskViewChange}
                      >
                        <DropdownMenuRadioItem value="project">
                          <Folder className="size-4" />
                          {intl.formatMessage({
                            id: "workspaceSidebar.viewByWorkspace",
                          })}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="chronological">
                          <Clock3 className="size-4" />
                          {intl.formatMessage({
                            id: "workspaceSidebar.organizeChronologicalList",
                          })}
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </>
                  ) : null}
                  {showWorkspaceViewOptions && showTaskSortOptions ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {showTaskSortOptions ? (
                    <>
                      <DropdownMenuLabel>
                        {intl.formatMessage({
                          id: "workspaceSidebar.sortBy",
                        })}
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={taskSortBy}
                        onValueChange={(value) => {
                          if (value === "created" || value === "updated") {
                            setTaskSortBy(value);
                          }
                        }}
                      >
                        <DropdownMenuRadioItem value="updated">
                          <MessageCircleCheck className="size-4" />
                          {intl.formatMessage({
                            id: "workspaceSidebar.sortByUpdated",
                          })}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="created">
                          <MessageCirclePlus className="size-4" />
                          {intl.formatMessage({
                            id: "workspaceSidebar.sortByCreated",
                          })}
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {showArchivedTasks ? (
              <div
                ref={setArchivedActionsContainer}
                data-testid="archived-tasks-toolbar-actions"
                className="flex shrink-0 items-center"
              />
            ) : null}
            <ControlHintTooltip title={archivedTasksActionLabel}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground data-[state=on]:bg-hover data-[state=on]:text-foreground"
                data-state={showArchivedTasks ? "on" : "off"}
                aria-label={archivedTasksActionLabel}
                onClick={() => {
                  setShowArchivedTasks((current) => !current);
                }}
              >
                {showArchivedTasks ? <X className="size-3.5" /> : <Archive className="size-3.5" />}
              </Button>
            </ControlHintTooltip>
          </div>
        </div>
      </div>
    ),
    [
      activePrimaryTaskMode,
      archivedTasksActionLabel,
      createGroupedTaskGroupAction,
      handlePrimaryTaskModeChange,
      handleToggleAllTaskGroups,
      handleWorkspaceTaskViewChange,
      intl,
      primaryTaskIndicatorStyle,
      showArchivedTasks,
      showTaskSortOptions,
      showTaskViewFilter,
      showWorkspaceViewOptions,
      taskSortBy,
      taskViewMode,
      toggleAllTaskGroupsPresentation,
      workspaceTaskViewValue,
    ],
  );

  return (
    <aside
      data-testid={TID_SIDEBAR}
      // Here, the structural surface token of the design system is used to fix the sidebar level to prevent different synthesizers from mixing the left container into an abnormal gray block.
      className="flex h-full flex-col overflow-hidden"
    >
      <div className="h-12 [app-region:drag]"></div>
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          className={cn(
            "absolute inset-0 flex min-h-0 flex-col transition-transform duration-200 ease-out",
            isFileTreeOpen && "-translate-x-full pointer-events-none",
          )}
          aria-hidden={isFileTreeOpen}
        >
          <div className={cn("flex flex-col gap-1 px-2", isWindowsDesktop ? "py-2" : "py-3")}>
            <WorkspaceNewTaskTooltip disabledReason={workspaceReadOnlyReason}>
              <NewTaskButtonGroup
                disabled={workspaceReadOnly}
                onCreateTask={() => {
                  if (workspaceReadOnly) {
                    return;
                  }
                  if (taskViewMode === "grouped") {
                    if (createGroupedTaskDraftAction) {
                      createGroupedTaskDraftAction();
                      return;
                    }
                    onCreateTask({ groupedDraftPlacement: { type: "top" } });
                    return;
                  }
                  onCreateTask({ createSource: "project" });
                }}
              />
            </WorkspaceNewTaskTooltip>
            <Button
              variant="ghost"
              onClick={onOpenCommandCenter}
              data-icon="inline-start"
              size="lg"
              className="w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground"
            >
              <Search className="size-4" />
              <span className="min-w-0 flex-1 truncate text-left">
                {intl.formatMessage({ id: "commandCenter.open" })}
              </span>
              <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">
                {commandCenterShortcutLabel}
              </span>
            </Button>
            {/* The remote-entry visibility policy goes through useRemoteConnectionEntryVisibility uniformly, so it cannot diverge from the other entry points.*/}
            {/* {showRemoteConnectionEntry ? (
              <SSHDialog
                onConnect={onConnectRemote}
                onSelectProject={onSelectRemoteProject}
                onCancelSession={onCancelRemoteProject}
                isWindowsDesktop={isWindowsDesktop}
                triggerVariant="ghost"
                triggerSize="lg"
                triggerClassName="w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground"
                trigger={
                  <>
                    <Cloud className="size-4" />
                    <span>{intl.formatMessage({ id: "remote.trigger" })}</span>
                  </>
                }
              />
            ) : null} */}
            <Button
              variant="ghost"
              onClick={handleOpenAutomationsMain}
              data-icon="inline-start"
              data-testid={TID_AUTOMATIONS_OPEN}
              size="lg"
              aria-pressed={automationsActive}
              className={cn(
                "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
                automationsActive && "bg-selected text-foreground",
              )}
            >
              <CalendarClock className="size-4" />
              {intl.formatMessage({ id: "workspace.openScheduledSettings" })}
            </Button>
            <Button
              variant="ghost"
              onClick={handleOpenPluginStoreMain}
              data-icon="inline-start"
              data-testid="plugin-store-sidebar-open"
              size="lg"
              aria-pressed={pluginStoreActive}
              className={cn(
                "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
                pluginStoreActive && "bg-selected text-foreground",
              )}
            >
              <Blocks className="size-4" />
              {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
            </Button>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col">
            <StickyGroupHeaderSlot header={groupedStickyHeader} />
            <div
              ref={workspaceScrollRef}
              className={
                // Grouped task Dragging the preview will change the list height. Disabling scroll anchoring prevents the browser from automatically anchoring and amplifying the dnd-kit measurement into jitter.
                "flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto"
              }
              style={workspaceScrollMaskStyle}
            >
              {workspaceTaskToolbar()}
              {shouldShowPinnedTasks ? (
                // Archive pinned should not be hidden when switching main task area.
                // pinned is the global pinned area, and the archived state keeps the pinned area visible.
                <WorkspacePinnedTasksSection
                  workspaceTabs={workspaceTabs}
                  activeWorkspacePath={workspacePath}
                  activeWorkspaceIdentity={workspaceIdentity}
                  activeTaskId={activeTaskId}
                  taskSortBy={taskSortBy}
                  onSelectTask={handleTaskRowSelect}
                  onOpenFileTree={(target) => {
                    setFileTreeTarget(target);
                    setIsFileTreeOpen(true);
                  }}
                />
              ) : null}
              <div className="flex min-h-0 flex-col gap-3 px-2">
                {taskViewMode === "archived" ? (
                  <WorkspaceArchivedTasksFlatSection
                    actionsContainer={archivedActionsContainer}
                    workspaceTabs={workspaceTabs}
                    activeWorkspacePath={workspacePath}
                    activeWorkspaceIdentity={workspaceIdentity}
                    activeTaskId={activeTaskId}
                    sortBy={taskSortBy}
                    onSelectTask={onSelectTask}
                  />
                ) : taskViewMode === "grouped" ? (
                  <WorkspaceGroupedTasksSection
                    workspaceTabs={workspaceTabs}
                    activeWorkspacePath={workspacePath}
                    activeWorkspaceIdentity={workspaceIdentity}
                    activeTaskId={activeTaskId}
                    onSelectTask={onSelectTask}
                    onCreateTask={onCreateTask}
                    onOpenFileTree={(target) => {
                      setFileTreeTarget(target);
                      setIsFileTreeOpen(true);
                    }}
                    onCreateGroupActionChange={handleCreateGroupActionChange}
                    onCreateDraftTaskActionChange={handleCreateDraftTaskActionChange}
                    collapsedGroupIds={collapsedGroupedTaskGroupIds}
                    onGroupedTaskGroupIdsChange={handleGroupedTaskGroupIdsChange}
                    onCollapsedGroupIdsChange={handleCollapsedGroupedTaskGroupIdsChange}
                    onStickyGroupHeaderChange={setGroupedStickyHeader}
                    onOpenAutomations={handleOpenAutomationsMain}
                  />
                ) : taskViewMode === "timeline" ? (
                  <WorkspaceTimelineTasksSection
                    workspaceTabs={workspaceTabs}
                    activeWorkspacePath={workspacePath}
                    activeWorkspaceIdentity={workspaceIdentity}
                    activeTaskId={activeTaskId}
                    taskSortBy={taskSortBy}
                    onSelectTask={handleTaskRowSelect}
                  />
                ) : (
                  <DndContext
                    sensors={purposeSectionSensors}
                    collisionDetection={closestCenter}
                    modifiers={[restrictVerticalDragWithinContainer]}
                    onDragEnd={handlePurposeSectionDragEnd}
                  >
                    <SortableContext
                      items={purposeSectionPreferences.sectionOrder}
                      strategy={verticalListSortingStrategy}
                    >
                      <div data-purpose-section-list="true">
                        {purposeSectionPreferences.sectionOrder.map((sectionId) =>
                          sectionId === "projects" ? (
                            <WorkspacePurposeSection
                              key={sectionId}
                              sortableId={sectionId}
                              dragHandleLabel={intl.formatMessage(
                                { id: "workspaceSidebar.reorderSection" },
                                {
                                  section: intl.formatMessage({
                                    id: "workspaceSidebar.projectsSection",
                                  }),
                                },
                              )}
                              title={intl.formatMessage({
                                id: "workspaceSidebar.projectsSection",
                              })}
                              open={purposeSectionPreferences.projectsExpanded}
                              onOpenChange={handleProjectSectionOpenChange}
                              testId={TID_PROJECT_SECTION}
                              action={
                                <DropdownMenu>
                                  <ControlHintTooltip
                                    title={intl.formatMessage({
                                      id: "workspaceSidebar.addProject",
                                    })}
                                  >
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        className="text-foreground-subtle hover:text-foreground data-[state=open]:text-foreground"
                                        aria-label={intl.formatMessage({
                                          id: "workspaceSidebar.addProject",
                                        })}
                                        data-testid={TID_PROJECT_ADD}
                                      >
                                        <Plus className="size-3.5" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                  </ControlHintTooltip>
                                  <DropdownMenuContent align="end" className="min-w-44">
                                    <DropdownMenuItem onSelect={onOpenFolderFromWorkspaceMenu}>
                                      <FolderOpen className="size-4" />
                                      {intl.formatMessage({
                                        id: "workspace.openFolder",
                                      })}
                                    </DropdownMenuItem>
                                    {onOpenRemoteWorkspace ? (
                                      <DropdownMenuItem onSelect={onOpenRemoteWorkspace}>
                                        <Cloud className="size-4" />
                                        {intl.formatMessage({
                                          id: "remote.trigger",
                                        })}
                                      </DropdownMenuItem>
                                    ) : null}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              }
                            >
                              {projectWorkspaceTabs.length === 0 ? (
                                <div className="px-3 py-2 text-ui-base text-foreground-subtle">
                                  {intl.formatMessage({
                                    id: "workspaceSidebar.noProjects",
                                  })}
                                </div>
                              ) : (
                                <DndContext
                                  sensors={workspaceSensors}
                                  collisionDetection={closestCenter}
                                  modifiers={[restrictVerticalDragWithinContainer]}
                                  onDragStart={handleWorkspaceDragStart}
                                  onDragEnd={handleWorkspaceDragEnd}
                                  onDragCancel={handleWorkspaceDragCancel}
                                >
                                  <SortableContext
                                    items={projectWorkspaceTabs.map((tab) => tab.id)}
                                    strategy={workspaceVerticalListSortingStrategy}
                                  >
                                    <ul data-testid={TID_WORKSPACE_LIST} className="space-y-2 pb-4">
                                      {projectWorkspaceTabs.map((tab) => {
                                        const workspaceKey = buildTaskWorkspaceKey(
                                          tab.workspacePath,
                                          tab.workspaceIdentity,
                                        );
                                        const taskGroup = workspaceTaskGroupByKey.get(workspaceKey);
                                        const taskLoading =
                                          workspaceTaskLists.loadingByWorkspaceKey[workspaceKey] ??
                                          false;

                                        return (
                                          <SortableWorkspaceSidebarItem
                                            key={tab.id}
                                            tab={tab}
                                            isActiveWorkspace={tab.workspacePath === workspacePath}
                                            isExpanded={resolveWorkspaceDragExpanded({
                                              activeDragId: activeWorkspaceDragId,
                                              expanded: expandedWorkspacePaths.has(
                                                tab.workspacePath,
                                              ),
                                              tabId: tab.id,
                                            })}
                                            activateTab={activateTab}
                                            closeTab={closeTab}
                                            toggleWorkspaceExpanded={toggleWorkspaceExpanded}
                                            onSelectTask={onSelectTask}
                                            onStartDraftInWorkspace={onStartDraftInWorkspace}
                                            taskItems={
                                              taskGroup?.items ?? EMPTY_WORKSPACE_TASK_ITEMS
                                            }
                                            taskListLoading={taskLoading}
                                            taskListHasMore={taskGroup?.hasMore ?? false}
                                            taskListHasUnread={taskGroup?.hasUnread ?? false}
                                            taskListLiveWorkflowCount={
                                              taskGroup?.liveWorkflowCount ?? 0
                                            }
                                            workspaceKey={workspaceKey}
                                            onShowMoreWorkspaceTasks={handleShowMoreWorkspaceTasks}
                                            reconnectingRemoteWorkspaceKeys={
                                              reconnectingRemoteWorkspaceKeys
                                            }
                                            remoteWorkspaceErrorByWorkspaceKey={
                                              remoteWorkspaceErrorByWorkspaceKey
                                            }
                                            reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                                              reconnectingRemoteWorkspaceLogsByWorkspaceKey
                                            }
                                            onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
                                            onOpenFileTree={handleOpenWorkspaceFileTree}
                                          />
                                        );
                                      })}
                                    </ul>
                                  </SortableContext>
                                  {typeof document === "undefined"
                                    ? null
                                    : createPortal(
                                        <DragOverlay>
                                          {activeWorkspaceDragTab ? (
                                            <WorkspaceDragOverlay
                                              tab={activeWorkspaceDragTab}
                                              width={activeWorkspaceDragWidth}
                                            />
                                          ) : null}
                                        </DragOverlay>,
                                        document.body,
                                      )}
                                </DndContext>
                              )}
                            </WorkspacePurposeSection>
                          ) : (
                            <WorkspacePurposeSection
                              key={sectionId}
                              sortableId={sectionId}
                              dragHandleLabel={intl.formatMessage(
                                { id: "workspaceSidebar.reorderSection" },
                                {
                                  section: intl.formatMessage({
                                    id: "workspaceSidebar.conversationsSection",
                                  }),
                                },
                              )}
                              title={intl.formatMessage({
                                id: "workspaceSidebar.conversationsSection",
                              })}
                              open={purposeSectionPreferences.conversationsExpanded}
                              onOpenChange={handleConversationSectionOpenChange}
                              testId={TID_CONVERSATION_SECTION}
                              action={
                                <ControlHintTooltip
                                  title={intl.formatMessage({
                                    id: "workspaceSidebar.newConversation",
                                  })}
                                >
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="text-foreground-subtle hover:text-foreground"
                                    aria-label={intl.formatMessage({
                                      id: "workspaceSidebar.newConversation",
                                    })}
                                    data-testid={TID_CONVERSATION_NEW_TASK}
                                    onClick={onCreateConversationTask}
                                  >
                                    <MessageCirclePlus className="size-3.5" />
                                  </Button>
                                </ControlHintTooltip>
                              }
                            >
                              <WorkspaceTimelineTasksSection
                                workspaceTabs={conversationWorkspaceTabs}
                                activeWorkspacePath={workspacePath}
                                activeWorkspaceIdentity={workspaceIdentity}
                                activeTaskId={activeTaskId}
                                taskSortBy={taskSortBy}
                                groupByDate={false}
                                // The conversation backing workspace is just the internal execution path; changing the user copy to "task" does not change the purpose semantics.
                                taskRowVariant="default"
                                emptyMessage={intl.formatMessage({
                                  id: "workspaceSidebar.noConversations",
                                })}
                                onSelectTask={handleTaskRowSelect}
                              />
                            </WorkspacePurposeSection>
                          ),
                        )}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}
              </div>
            </div>
          </div>

          <WorkspaceSidebarFooter
            className="pr-3"
            theme={theme}
            onThemeChange={handleThemeChange}
            onSettingsButtonClick={openSettingsTab}
            onUsageClick={openSettingsTab}
            onUpgradeClick={handleOpenCodingPlanUpgrade}
            onLogin={onLogin}
            onLogout={onLogout}
            user={user}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            workspaceRemoteSessionId={workspaceRemoteSessionId}
            activeTaskId={activeTaskId}
            isDesktop={isDesktop}
          />
        </div>
        <div
          className={cn(
            "absolute inset-0 transition-transform duration-200 ease-out",
            isFileTreeOpen ? "translate-x-0" : "translate-x-full pointer-events-none",
          )}
          aria-hidden={!isFileTreeOpen}
        >
          {fileTreeTarget ? (
            <WorkspaceFileTree
              workspacePath={fileTreeTarget.workspacePath}
              workspaceName={fileTreeTarget.workspaceName}
              workspaceIdentity={fileTreeTarget.workspaceIdentity}
              workspaceRemoteSessionId={fileTreeTarget.workspaceRemoteSessionId}
              revealPath={fileTreeTarget.revealPath}
              temporaryExternalDirectory={fileTreeTarget.temporaryExternalDirectory}
              canOpenLocalFileManager={isDesktop}
              activePreviewPath={activePreviewPath}
              onClose={() => setIsFileTreeOpen(false)}
              onOpenBrowserUrl={isDesktop ? onOpenBrowserUrl : undefined}
              onOpenPreview={(source) => {
                // The file tree can view files that are not in the current workspace.
                // Only when the preview source carries the workspace scope, the PreviewPane can use the correct host to read the remote file;
                // At the same time, the current workspace is not switched to avoid "Add to chat" being thrown to the wrong composer.
                onOpenCodeViewer?.({
                  ...source,
                  workspacePath: fileTreeTarget.workspacePath,
                  workspaceIdentity: fileTreeTarget.workspaceIdentity,
                  workspaceRemoteSessionId: fileTreeTarget.workspaceRemoteSessionId,
                });
              }}
            />
          ) : null}
        </div>
      </div>
    </aside>
  );
});
