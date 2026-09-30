/* eslint-disable max-lines -- the pinned list now carries local queries, remotely pushed injection
 * results, and task action dispatch alike; keep it in one place for now so the interactions stay
 * consistent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { resolveTaskFileTreeTargetFromTabs } from "@/lib/taskFileTreeTarget.js";
import { MemoTaskItem, TaskListItemContextMenuContent } from "@/TaskListItem.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { TaskListRemoteSyncHint } from "@/TaskListRemoteSyncHint.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import {
  getRemoteWorkspaceServicesForIdentity,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";

function buildPinnedItemKey(workspacePath: string, taskId: string, workspaceIdentity?: string) {
  return `${buildTaskWorkspaceKey(workspacePath, workspaceIdentity)}:${taskId}`;
}

interface PinnedTaskItemHandlers {
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (event: ReactMouseEvent, taskId: string) => void;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu: (taskId: string) => void;
  onOpenFileTree: (task: ZCodeTaskMeta) => void;
}

function PinnedTasksSectionTitle({ title }: { title: string }) {
  return <h3 className="px-2.5 py-1 text-ui-base font-medium text-foreground-subtlest">{title}</h3>;
}

export function WorkspacePinnedTasksSection({
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  taskSortBy,
  onSelectTask,
  onOpenFileTree,
}: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  taskSortBy: "created" | "updated";
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
  onOpenFileTree?: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
}) {
  const { intl } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const scopedWorkspaceTabs = useLocalWorkspaceScopes({
    workspaceTabs,
  });
  const remoteSessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const removeOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const [pendingArchiveItemKey, setPendingArchiveItemKey] = useState<string | null>(null);
  const [renamingItemKey, setRenamingItemKey] = useState<string | null>(null);
  const [contextMenuItemKey, setContextMenuItemKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [showAllTasks, setShowAllTasks] = useState(false);
  const collapsedLimit = 20;
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingArchiveItemKeyRef = useRef<string | null>(pendingArchiveItemKey);
  const taskSortByRef = useRef(taskSortBy);
  const intlRef = useRef(intl);
  const onSelectTaskRef = useRef(onSelectTask);
  const removeTaskStateRef = useRef(removeTaskState);
  const upsertOptimisticTaskListItemRef = useRef(upsertOptimisticTaskListItem);
  const removeOptimisticTaskListItemRef = useRef(removeOptimisticTaskListItem);
  const setTaskUnreadIndicatorRef = useRef(setTaskUnreadIndicator);
  const taskItemHandlersByKeyRef = useRef(new Map<string, PinnedTaskItemHandlers>());
  pendingArchiveItemKeyRef.current = pendingArchiveItemKey;
  taskSortByRef.current = taskSortBy;
  intlRef.current = intl;
  onSelectTaskRef.current = onSelectTask;
  removeTaskStateRef.current = removeTaskState;
  upsertOptimisticTaskListItemRef.current = upsertOptimisticTaskListItem;
  removeOptimisticTaskListItemRef.current = removeOptimisticTaskListItem;
  setTaskUnreadIndicatorRef.current = setTaskUnreadIndicator;
  const { items: localItems } = useGlobalTaskList({
    kind: "pinned",
    workspaceTabs: scopedWorkspaceTabs,
    sortBy: taskSortBy,
    searchQuery: "",
    expanded: true,
    collapsedLimit,
  });
  const remotePinnedItemsByWorkspaceKey = useRemotePinnedTaskStore(
    (state) => state.itemsByWorkspaceKey,
  );
  const remotePinnedLoadingByWorkspaceKey = useRemotePinnedTaskStore(
    (state) => state.loadingByWorkspaceKey,
  );
  const remoteItems = useMemo(() => {
    const remoteWorkspaceKeys = new Set(
      workspaceTabs
        .filter((tab) => tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId)
        .map((tab) => buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)),
    );
    return [...remoteWorkspaceKeys].flatMap(
      (workspaceKey) => remotePinnedItemsByWorkspaceKey[workspaceKey] ?? [],
    );
  }, [remotePinnedItemsByWorkspaceKey, workspaceTabs]);
  const sortedItems = useMemo(() => {
    return [...localItems, ...remoteItems].sort((left, right) =>
      compareZCodeTaskListItems(left, right, taskSortBy),
    );
  }, [localItems, remoteItems, taskSortBy]);
  const items = showAllTasks ? sortedItems : sortedItems.slice(0, collapsedLimit);
  const total = sortedItems.length;
  const syncingRemoteWorkspaces = workspaceTabs.some((tab) => {
    if (!tab.workspaceIdentity && !tab.remoteTarget && !tab.remoteSessionId) {
      return false;
    }
    return Boolean(
      remotePinnedLoadingByWorkspaceKey[
        buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)
      ],
    );
  });
  const canToggleExpanded = total > collapsedLimit;
  const sectionTitle = intl.formatMessage({ id: "taskList.pinnedSection" });
  const activeWorkspaceKey = buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity);
  const itemByKey = useMemo(() => {
    const nextItemByKey = new Map<string, ZCodeTaskMeta>();
    for (const item of items) {
      nextItemByKey.set(
        buildPinnedItemKey(item.workspacePath, item.taskId, item.workspaceIdentity),
        item,
      );
    }
    return nextItemByKey;
  }, [items]);
  const itemByKeyRef = useRef(itemByKey);
  itemByKeyRef.current = itemByKey;
  const workspaceTabsRef = useRef(workspaceTabs);
  workspaceTabsRef.current = workspaceTabs;
  const onOpenFileTreeRef = useRef(onOpenFileTree);
  onOpenFileTreeRef.current = onOpenFileTree;

  const resolveTaskServices = useCallback(
    (workspaceIdentity?: string) => {
      if (!workspaceIdentity) {
        return baseServices;
      }
      return getRemoteWorkspaceServicesForIdentity(workspaceIdentity);
    },
    [baseServices],
  );
  const resolveTaskServicesRef = useRef(resolveTaskServices);
  resolveTaskServicesRef.current = resolveTaskServices;

  const handleCancelArchiveConfirm = useCallback(() => {
    setPendingArchiveItemKey(null);
  }, []);

  const handleCancelRenameTask = useCallback(() => {
    setRenamingItemKey(null);
    setRenameDraft("");
  }, []);

  const findItemByKey = useCallback(
    (itemKey: string) => itemByKey.get(itemKey) ?? null,
    [itemByKey],
  );
  const getCurrentPinnedItemContext = useCallback((itemKey: string) => {
    const item = itemByKeyRef.current.get(itemKey);
    if (!item) {
      return null;
    }

    const services = resolveTaskServicesRef.current(item.workspaceIdentity);
    if (!services) {
      return null;
    }

    return { item, services };
  }, []);
  const archivePinnedItem = useCallback(
    (itemKey: string) => {
      const current = getCurrentPinnedItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, services } = current;
      void services.zcodeTaskService
        .archiveTask({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
        })
        .then((meta) => {
          removeTaskStateRef.current(item.workspacePath, item.taskId, item.workspaceIdentity);
          if (item.workspaceIdentity) {
            useRemotePinnedTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: { pinned: true, archived: false },
            nextState: { pinned: false, archived: true },
          });
        });
    },
    [getCurrentPinnedItemContext],
  );
  const selectPinnedItem = useCallback((itemKey: string) => {
    const item = itemByKeyRef.current.get(itemKey);
    if (!item) {
      return;
    }
    onSelectTaskRef.current(item.workspacePath, item.taskId, item.workspaceIdentity, item.unreadAt);
  }, []);
  const archivePinnedItemInline = useCallback(
    (event: ReactMouseEvent, itemKey: string) => {
      event.stopPropagation();
      if (pendingArchiveItemKeyRef.current !== itemKey) {
        setPendingArchiveItemKey(itemKey);
        return;
      }
      setPendingArchiveItemKey(null);
      archivePinnedItem(itemKey);
    },
    [archivePinnedItem],
  );
  const togglePinnedItemPin = useCallback(
    (itemKey: string, pinned: boolean) => {
      const current = getCurrentPinnedItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, services } = current;
      // Unpin used to wait for the RPC to return before moving the task out of the pinned area, and the list would flash during the recheck.
      // Here we first move optimistically, and then restore the task to pinned if RPC fails.
      if (item.workspaceIdentity) {
        useRemotePinnedTaskStore
          .getState()
          .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
        if (!pinned) {
          useRemoteTimelineTaskStore.getState().upsertTask(item, taskSortByRef.current);
        }
      }
      applyTaskQueryCacheMutation({
        previousTask: item,
        nextTask: item,
        previousState: { pinned: true, archived: false },
        nextState: { pinned, archived: false },
      });
      void services.zcodeTaskService
        .setTaskPinned({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
          pinned,
        })
        .then((meta) => {
          removeOptimisticTaskListItemRef.current(
            item.workspacePath,
            item.taskId,
            item.workspaceIdentity,
          );
          if (item.workspaceIdentity && pinned) {
            useRemotePinnedTaskStore.getState().upsertTask(meta);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
          }
          if (item.workspaceIdentity && !pinned) {
            useRemoteTimelineTaskStore.getState().upsertTask(meta, taskSortByRef.current);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: { pinned, archived: false },
            nextState: { pinned, archived: false },
          });
        })
        .catch(() => {
          if (item.workspaceIdentity) {
            useRemotePinnedTaskStore.getState().upsertTask(item);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: item,
            previousState: { pinned, archived: false },
            nextState: { pinned: true, archived: false },
          });
          toast(intlRef.current.formatMessage({ id: "taskList.pinFailed" }));
        });
    },
    [getCurrentPinnedItemContext],
  );
  const startPinnedItemRename = useCallback((itemKey: string, currentTitle: string) => {
    setPendingArchiveItemKey(null);
    setRenamingItemKey(itemKey);
    setRenameDraft(currentTitle);
  }, []);
  const markPinnedItemAsUnread = useCallback(
    (itemKey: string) => {
      const current = getCurrentPinnedItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, services } = current;
      void services.zcodeTaskService
        .setTaskUnread({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
          unread: true,
        })
        .then((meta) => {
          setTaskUnreadIndicatorRef.current(
            item.workspacePath,
            item.taskId,
            true,
            item.workspaceIdentity,
          );
          upsertOptimisticTaskListItemRef.current(item.workspacePath, meta, item.workspaceIdentity);
          if (item.workspaceIdentity) {
            useRemotePinnedTaskStore.getState().upsertTask(meta);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: { pinned: true, archived: false },
            nextState: { pinned: true, archived: false },
          });
        });
    },
    [getCurrentPinnedItemContext],
  );
  const openPinnedItemContextMenu = useCallback((itemKey: string) => {
    // pinned row handler caches by itemKey; reads the latest confirmation status from ref when opening the menu,
    // Avoid rebuilding all TaskListItem callbacks when pendingArchiveItemKey changes.
    if (pendingArchiveItemKeyRef.current === itemKey) {
      setPendingArchiveItemKey(null);
    }
    setContextMenuItemKey(itemKey);
  }, []);
  const getPinnedTaskItemHandlers = useCallback(
    (itemKey: string) => {
      let handlers = taskItemHandlersByKeyRef.current.get(itemKey);
      if (!handlers) {
        // The trace shows that the action props of the pinned row are still changed due to the map inline closure.
        // Each itemKey only creates a handler once, and reads the latest item/services/state through ref during actual execution.
        handlers = {
          onSelectTask: () => {
            selectPinnedItem(itemKey);
          },
          onArchiveTaskInline: (event) => {
            archivePinnedItemInline(event, itemKey);
          },
          onTogglePinTask: (_taskId, pinned) => {
            togglePinnedItemPin(itemKey, pinned);
          },
          onStartRenameTask: (_taskId, currentTitle) => {
            startPinnedItemRename(itemKey, currentTitle);
          },
          onArchiveTask: () => {
            archivePinnedItem(itemKey);
          },
          onMarkTaskAsUnread: () => {
            markPinnedItemAsUnread(itemKey);
          },
          onOpenTaskContextMenu: () => {
            openPinnedItemContextMenu(itemKey);
          },
          onOpenFileTree: (task) => {
            const target = resolveTaskFileTreeTargetFromTabs(task, workspaceTabsRef.current);
            if (target) {
              onOpenFileTreeRef.current?.(target);
            }
          },
        };
        taskItemHandlersByKeyRef.current.set(itemKey, handlers);
      }
      return handlers;
    },
    [
      archivePinnedItem,
      archivePinnedItemInline,
      markPinnedItemAsUnread,
      openPinnedItemContextMenu,
      selectPinnedItem,
      startPinnedItemRename,
      togglePinnedItemPin,
    ],
  );

  useEffect(() => {
    if (!renamingItemKey) {
      return;
    }

    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingItemKey]);

  useEffect(() => {
    if (!contextMenuItemKey) {
      return;
    }

    if (!findItemByKey(contextMenuItemKey)) {
      setContextMenuItemKey(null);
    }
  }, [contextMenuItemKey, findItemByKey]);

  useEffect(() => {
    for (const itemKey of taskItemHandlersByKeyRef.current.keys()) {
      if (!itemByKey.has(itemKey)) {
        taskItemHandlersByKeyRef.current.delete(itemKey);
      }
    }
  }, [itemByKey]);

  const contextMenuItem = contextMenuItemKey ? findItemByKey(contextMenuItemKey) : null;
  const contextMenuServices = contextMenuItem
    ? resolveTaskServices(contextMenuItem.workspaceIdentity)
    : null;

  if (items.length === 0) {
    // When switching/joining the workspace, the pinned query will enter loading first, but there is no data to display at this time.
    // "Pinned + Getting tasks" cannot still be rendered, otherwise a non-helpful loading will appear every time the sidebar is switched.
    // When there is cached data, continue to follow the normal rendering path below to maintain the stale-while-revalidate display experience.
    return null;
  }

  return (
    <div className="flex flex-col gap-1 px-2 empty:hidden">
      {renamingItemKey !== null ? (
        <TaskRenameDialog
          open
          value={renameDraft}
          inputRef={renameInputRef}
          intl={intl}
          onOpenChange={(open) => {
            if (!open) {
              handleCancelRenameTask();
            }
          }}
          onChange={setRenameDraft}
          onCancel={handleCancelRenameTask}
          onConfirm={() => {
            if (!renamingItemKey) {
              return;
            }
            const item = findItemByKey(renamingItemKey);
            if (!item) {
              handleCancelRenameTask();
              return;
            }
            const services = resolveTaskServices(item.workspaceIdentity);
            if (!services) {
              handleCancelRenameTask();
              return;
            }
            void services.zcodeTaskService
              .renameTask({
                taskId: item.taskId,
                workspacePath: item.workspacePath,
                ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
                title: renameDraft.trim(),
              })
              .then((meta) => {
                upsertOptimisticTaskListItem(item.workspacePath, meta, item.workspaceIdentity);
                if (item.workspaceIdentity) {
                  useRemotePinnedTaskStore.getState().upsertTask(meta);
                }
                applyTaskQueryCacheMutation({
                  previousTask: item,
                  nextTask: meta,
                  previousState: { pinned: true, archived: false },
                  nextState: { pinned: true, archived: false },
                });
                handleCancelRenameTask();
              })
              .catch(() => {
                toast(intl.formatMessage({ id: "taskList.renameFailed" }));
              });
          }}
        />
      ) : null}
      <PinnedTasksSectionTitle title={sectionTitle} />
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) {
            setContextMenuItemKey(null);
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <ul className="space-y-0.5">
            {items.map((item) => {
              const itemKey = buildPinnedItemKey(
                item.workspacePath,
                item.taskId,
                item.workspaceIdentity,
              );
              const services = resolveTaskServices(item.workspaceIdentity);
              if (!services) {
                return null;
              }
              const handlers = getPinnedTaskItemHandlers(itemKey);
              return (
                <MemoTaskItem
                  key={itemKey}
                  workspacePath={item.workspacePath}
                  remoteSessionId={
                    item.workspaceIdentity
                      ? remoteSessionIdByWorkspaceIdentity[item.workspaceIdentity]
                      : undefined
                  }
                  task={item}
                  isPinned
                  isActive={
                    // Remote workspaces with the same path may contain the same taskId, and the selected state must be isolated by workspaceIdentity.
                    buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity) ===
                      activeWorkspaceKey && item.taskId === activeTaskId
                  }
                  onSelectTask={handlers.onSelectTask}
                  onArchiveTaskInline={handlers.onArchiveTaskInline}
                  onCancelArchiveConfirm={handleCancelArchiveConfirm}
                  isArchiveConfirming={pendingArchiveItemKey === itemKey}
                  onTogglePinTask={handlers.onTogglePinTask}
                  onStartRenameTask={handlers.onStartRenameTask}
                  onArchiveTask={handlers.onArchiveTask}
                  onMarkTaskAsUnread={handlers.onMarkTaskAsUnread}
                  onOpenTaskContextMenu={handlers.onOpenTaskContextMenu}
                  onOpenFileTree={onOpenFileTree ? handlers.onOpenFileTree : undefined}
                  intl={intl}
                />
              );
            })}
          </ul>
        </ContextMenuTrigger>
        {contextMenuItem && contextMenuServices ? (
          <TaskListItemContextMenuContent
            workspacePath={contextMenuItem.workspacePath}
            remoteSessionId={
              contextMenuItem.workspaceIdentity
                ? remoteSessionIdByWorkspaceIdentity[contextMenuItem.workspaceIdentity]
                : undefined
            }
            task={contextMenuItem}
            isPinned
            intl={intl}
            onTogglePinTask={(_taskId, pinned) => {
              if (contextMenuItem.workspaceIdentity) {
                useRemotePinnedTaskStore
                  .getState()
                  .removeTask(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                if (!pinned) {
                  useRemoteTimelineTaskStore.getState().upsertTask(contextMenuItem, taskSortBy);
                }
              }
              applyTaskQueryCacheMutation({
                previousTask: contextMenuItem,
                nextTask: contextMenuItem,
                previousState: { pinned: true, archived: false },
                nextState: { pinned, archived: false },
              });
              void contextMenuServices.zcodeTaskService
                .setTaskPinned({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                  pinned,
                })
                .then((meta) => {
                  removeOptimisticTaskListItem(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity && pinned) {
                    useRemotePinnedTaskStore.getState().upsertTask(meta);
                    useRemoteTimelineTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                  }
                  if (contextMenuItem.workspaceIdentity && !pinned) {
                    useRemoteTimelineTaskStore.getState().upsertTask(meta, taskSortBy);
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned, archived: false },
                    nextState: { pinned, archived: false },
                  });
                })
                .catch(() => {
                  if (contextMenuItem.workspaceIdentity) {
                    useRemotePinnedTaskStore.getState().upsertTask(contextMenuItem);
                    useRemoteTimelineTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: contextMenuItem,
                    previousState: { pinned, archived: false },
                    nextState: { pinned: true, archived: false },
                  });
                  toast(intl.formatMessage({ id: "taskList.pinFailed" }));
                });
            }}
            onStartRenameTask={(_taskId, currentTitle) => {
              setPendingArchiveItemKey(null);
              setRenamingItemKey(contextMenuItemKey);
              setRenameDraft(currentTitle);
            }}
            onArchiveTask={() => {
              void contextMenuServices.zcodeTaskService
                .archiveTask({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                })
                .then((meta) => {
                  removeTaskState(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity) {
                    useRemotePinnedTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                    useRemoteTimelineTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned: true, archived: false },
                    nextState: { pinned: false, archived: true },
                  });
                });
            }}
            onMarkTaskAsUnread={() => {
              void contextMenuServices.zcodeTaskService
                .setTaskUnread({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                  unread: true,
                })
                .then((meta) => {
                  setTaskUnreadIndicator(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    true,
                    contextMenuItem.workspaceIdentity,
                  );
                  upsertOptimisticTaskListItem(
                    contextMenuItem.workspacePath,
                    meta,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity) {
                    useRemotePinnedTaskStore.getState().upsertTask(meta);
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned: true, archived: false },
                    nextState: { pinned: true, archived: false },
                  });
                });
            }}
          />
        ) : null}
      </ContextMenu>
      {syncingRemoteWorkspaces ? <TaskListRemoteSyncHint /> : null}
      {canToggleExpanded ? (
        <div className="cursor-pointer pl-8.5">
          <span
            className="text-ui-base text-foreground-subtlest hover:text-foreground-subtle"
            onClick={() => {
              setShowAllTasks((current) => !current);
            }}
          >
            {intl.formatMessage({
              id: showAllTasks ? "taskList.showLess" : "taskList.showMore",
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
