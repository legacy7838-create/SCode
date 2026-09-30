import { memo, useCallback, useMemo, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { WorkspaceSidebarItem, type SortableBindings } from "./WorkspaceSidebarItem.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

export type { SortableBindings };

// Vertical drag container constraints have been mentioned in lib (drag and drop within the idle-time sidebar group needs to be reused and cannot carry the dependency chain of this module).
export { restrictVerticalDragWithinContainer } from "@/lib/restrictVerticalDragWithinContainer.js";

export const SortableWorkspaceSidebarItem = memo(function SortableWorkspaceSidebarItem({
  tab,
  isActiveWorkspace,
  isExpanded,
  activateTab,
  closeTab,
  toggleWorkspaceExpanded,
  onSelectTask,
  onStartDraftInWorkspace,
  taskItems,
  taskListLoading,
  taskListHasMore,
  taskListHasUnread = false,
  taskListLiveWorkflowCount = 0,
  workspaceKey,
  onShowMoreWorkspaceTasks,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  onReconnectRemoteWorkspace,
  onOpenFileTree,
}: {
  tab: WorkspaceTabState;
  isActiveWorkspace: boolean;
  isExpanded: boolean;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  toggleWorkspaceExpanded: (workspacePath: string) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  taskItems: ZCodeTaskMeta[];
  taskListLoading: boolean;
  taskListHasMore: boolean;
  taskListHasUnread?: boolean;
  taskListLiveWorkflowCount?: number;
  workspaceKey: string;
  onShowMoreWorkspaceTasks: (workspaceKey: string) => void;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: Record<string, RemoteConnectionLogEntry[]>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onOpenFileTree: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  // Streaming task events will cause the parent sidebar to refresh frequently; dnd-kit even if the displacement value remains unchanged,
  // New transform objects may also be given. Here, stable props are derived based on primitive values ​​to avoid breaking through row-level memo.
  const transformString = useMemo(() => {
    if (!transform) {
      return undefined;
    }

    return CSS.Transform.toString({
      ...transform,
      // When dnd-kit is not using DragOverlay, it will press the rect of the current over node.
      // Give the active node scaleX/scaleY. The workspace row is a variable height container,
      // Once dragged over items with different expanded/collapsed heights, the active item will be temporarily squashed or stretched.
      // Looks like "drag content height variant". Here, the dragging zoom of the sidebar is clamped back to 1.
      // Only displacements are retained and real nodes are not allowed to scale with the target height.
      scaleX: 1,
      scaleY: 1,
    });
  }, [transform?.x, transform?.y]);

  const style = useMemo<CSSProperties>(
    () => ({
      transform: transformString,
      transition,
      zIndex: isDragging ? 10 : undefined,
      // The real workspace node will be temporarily closed after drag start, and the visual content will be
      // DragOverlay takes over; continuing to display real nodes will produce two item headers and interfere with drop point determination.
      opacity: isDragging ? 0 : 1,
    }),
    [isDragging, transition, transformString],
  );
  const sortableBindings = useMemo<SortableBindings>(
    () => ({ attributes, listeners }),
    [attributes, listeners],
  );
  const handleShowMoreTasks = useCallback(() => {
    onShowMoreWorkspaceTasks(workspaceKey);
  }, [onShowMoreWorkspaceTasks, workspaceKey]);

  return (
    <WorkspaceSidebarItem
      tab={tab}
      isActiveWorkspace={isActiveWorkspace}
      isExpanded={isExpanded}
      activateTab={activateTab}
      closeTab={closeTab}
      toggleWorkspaceExpanded={toggleWorkspaceExpanded}
      onSelectTask={onSelectTask}
      onStartDraftInWorkspace={onStartDraftInWorkspace}
      taskItems={taskItems}
      taskListLoading={taskListLoading}
      taskListHasMore={taskListHasMore}
      taskListHasUnread={taskListHasUnread}
      taskListLiveWorkflowCount={taskListLiveWorkflowCount}
      onShowMoreTasks={handleShowMoreTasks}
      reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
      remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
      reconnectingRemoteWorkspaceLogsByWorkspaceKey={reconnectingRemoteWorkspaceLogsByWorkspaceKey}
      onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
      onOpenFileTree={onOpenFileTree}
      itemRef={setNodeRef}
      itemStyle={style}
      sortableBindings={sortableBindings}
      isDragging={isDragging}
    />
  );
});
SortableWorkspaceSidebarItem.displayName = "SortableWorkspaceSidebarItem";
