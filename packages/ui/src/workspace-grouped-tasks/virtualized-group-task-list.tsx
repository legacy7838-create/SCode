import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { GroupedTaskItem } from "@/workspace-grouped-tasks/task-item.js";
import { taskKey } from "@/workspace-grouped-tasks/ids.js";
import {
  isPotentialVerticalScrollContainer,
  scrollGroupedTaskVirtualizerToOffset,
} from "@/workspace-grouped-tasks/virtualized-scroll.js";
import type { TaskGroupMenuItem } from "@/workspace-grouped-tasks/types.js";

const GROUPED_TASK_ROW_ESTIMATE_PX = 32;
const GROUPED_TASK_VIRTUALIZATION_THRESHOLD = 80;
const GROUPED_TASK_VIRTUALIZATION_OVERSCAN = 12;

function shouldVirtualizeGroupedTasks(taskCount: number): boolean {
  return taskCount > GROUPED_TASK_VIRTUALIZATION_THRESHOLD;
}

function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (isPotentialVerticalScrollContainer(style.overflowY)) {
      // When the group expansion animation just starts, the ancestor container may not be supported by the content until scrollHeight > clientHeight.
      // If null is returned, react-virtual will temporarily have no scrollElement, which means that the content area has height but the row is not rendered.
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function resolveScrollMargin(listElement: HTMLElement, scrollElement: HTMLElement): number {
  return (
    listElement.getBoundingClientRect().top -
    scrollElement.getBoundingClientRect().top +
    scrollElement.scrollTop
  );
}

export function VirtualizedGroupedTaskList({
  tasks,
  groupId,
  groups,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  getTaskRemoteSessionId,
  getTaskWorkspaceLabel,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  activeDragTaskKey,
  tooltipsDisabled,
}: {
  tasks: ZCodeTaskMeta[];
  groupId: string;
  groups: TaskGroupMenuItem[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  getTaskRemoteSessionId: (task: ZCodeTaskMeta) => string | undefined;
  getTaskWorkspaceLabel: (task: ZCodeTaskMeta) => string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  activeDragTaskKey?: string | null;
  tooltipsDisabled?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const shouldVirtualize = shouldVirtualizeGroupedTasks(tasks.length);
  const getItemKey = useCallback(
    (index: number) => taskKey(tasks[index] ?? { workspacePath: "", taskId: String(index) }),
    [tasks],
  );

  const updateScrollMargin = useCallback(() => {
    const listElement = listRef.current;
    if (!listElement) {
      return;
    }
    const nextScrollElement = findNearestScrollableAncestor(listElement);
    setScrollElement(nextScrollElement);
    if (!nextScrollElement) {
      setScrollMargin(0);
      return;
    }
    setScrollMargin(resolveScrollMargin(listElement, nextScrollElement));
  }, []);
  const resolveInitialScrollOffset = useCallback(() => {
    const listElement = listRef.current;
    const currentScrollElement =
      scrollElement ?? (listElement ? findNearestScrollableAncestor(listElement) : null);
    return currentScrollElement?.scrollTop ?? 0;
  }, [scrollElement]);

  useLayoutEffect(() => {
    if (!shouldVirtualize) {
      setScrollElement(null);
      setScrollMargin(0);
      return undefined;
    }
    updateScrollMargin();
    const listElement = listRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !listElement
        ? null
        : new ResizeObserver(updateScrollMargin);
    if (listElement) {
      resizeObserver?.observe(listElement);
    }
    const animationFrame = window.requestAnimationFrame(updateScrollMargin);
    window.addEventListener("resize", updateScrollMargin);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updateScrollMargin);
      resizeObserver?.disconnect();
    };
  }, [groupId, shouldVirtualize, tasks.length, updateScrollMargin]);

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? tasks.length : 0,
    getScrollElement: () => scrollElement,
    estimateSize: () => GROUPED_TASK_ROW_ESTIMATE_PX,
    getItemKey,
    overscan: GROUPED_TASK_VIRTUALIZATION_OVERSCAN,
    scrollMargin,
    scrollToFn: scrollGroupedTaskVirtualizerToOffset,
    // The virtual list in the group will share the left scroll container with the top-level list.
    // Remount when the group row is scrolled in the middle, react-virtual defaults to initialOffset=0
    // Will scrollTo(0) in _willUpdate. Here, check the real scrollTop from the DOM scene.
    // Avoid caching 0 in advance when the scrollElement state in the first layout effect has not yet been written back.
    initialOffset: resolveInitialScrollOffset,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const measureElement = rowVirtualizer.measureElement;

  const renderTask = useCallback(
    (task: ZCodeTaskMeta) => (
      <GroupedTaskItem
        key={taskKey(task)}
        task={task}
        groupId={groupId}
        groups={groups}
        remoteSessionId={getTaskRemoteSessionId(task)}
        workspaceLabel={getTaskWorkspaceLabel(task)}
        activeWorkspacePath={activeWorkspacePath}
        activeWorkspaceIdentity={activeWorkspaceIdentity}
        activeTaskId={activeTaskId}
        onSelectTask={onSelectTask}
        onCloseTask={onCloseTask}
        onOpenFileTree={onOpenFileTree}
        onMoveTaskToGroup={onMoveTaskToGroup}
        onMoveTaskToTop={onMoveTaskToTop}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        dragId={taskKey(task)}
        dragging={activeDragTaskKey === taskKey(task)}
        tooltipsDisabled={tooltipsDisabled}
      />
    ),
    [
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      getTaskRemoteSessionId,
      getTaskWorkspaceLabel,
      groupId,
      groups,
      onArchiveTask,
      onCloseTask,
      onMarkTaskAsUnread,
      onMoveTaskToGroup,
      onMoveTaskToTop,
      onOpenFileTree,
      onSelectTask,
      onStartRenameTask,
      activeDragTaskKey,
      tooltipsDisabled,
    ],
  );

  const renderedVirtualTasks = useMemo(
    () =>
      virtualRows.map((virtualRow) => {
        const task = tasks[virtualRow.index];
        if (!task) {
          return null;
        }
        return (
          <div
            key={virtualRow.key}
            // Row height is no longer constant: the session with the workflow running row is 48px instead of 28px. The estimated value is only an initial value.
            // The true height is measured back by measureElement, otherwise adjacent rows would overlap.
            ref={measureElement}
            data-index={virtualRow.index}
            className="absolute left-0 top-0 w-full"
            style={{
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {renderTask(task)}
          </div>
        );
      }),
    [measureElement, renderTask, scrollMargin, tasks, virtualRows],
  );

  if (!shouldVirtualize) {
    return <>{tasks.map((task) => renderTask(task))}</>;
  }

  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        overflowAnchor: "none",
      }}
    >
      {/* Large groups used to render all task lines at once. 2,000 lines would create tens of thousands of DOM nodes and drag them up.
          JS/Layout CPU. Only the rows within the scroll window are mounted here, keeping clicks and menu operations available. */}
      {/* The virtual rows in the group will be continuously mounted/unmounted during scrolling, and the browser scroll anchor may mistakenly
          These absolutely positioned lines act as stable anchor points, making it possible to pull scrollTop back to the top when measuring writeback.
          Disable the anchor point selection of the virtual list subtree to avoid fighting with react-virtual's positioning calculation. */}
      {renderedVirtualTasks}
    </div>
  );
}

export {
  GROUPED_TASK_ROW_ESTIMATE_PX,
  GROUPED_TASK_VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeGroupedTasks,
};
