import { useMemo, useState } from "react";
import { ArchiveX, Cloud, CloudDownload, Folder, Smartphone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import { TaskListRemoteSyncHint } from "@/TaskListRemoteSyncHint.js";
import { TaskListLoadingHint } from "@/TaskListLoadingHint.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { DeleteAllArchivedTasksButton } from "@/DeleteAllArchivedTasksButton.js";

export function WorkspaceArchivedTasksFlatSection({
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  sortBy,
  actionsContainer,
  onSelectTask,
}: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  sortBy: "created" | "updated";
  actionsContainer?: HTMLElement | null;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [deletingTaskKeys, setDeletingTaskKeys] = useState<Set<string>>(() => new Set());
  const collapsedLimit = 20;
  const workspaceLabelByKey = useMemo(
    () =>
      new Map(
        workspaceTabs.map(
          (tab) =>
            [
              buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
              tab.label || getPathLeaf(tab.workspacePath),
            ] as const,
        ),
      ),
    [workspaceTabs],
  );

  const workspaceServiceLookup = useMemo(
    () => buildWorkspaceServiceLookup(workspaceTabs, baseServices, serviceResolverState),
    [baseServices, serviceResolverState, workspaceTabs],
  );
  const activeWorkspaceKey = buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity);
  const { items, total, loading, syncingRemoteWorkspaces, refresh } = useGlobalTaskList({
    kind: "archived",
    workspaceTabs,
    sortBy,
    searchQuery: "",
    expanded: showAllTasks,
    collapsedLimit,
  });
  const canToggleExpanded = total > collapsedLimit;

  return (
    <div>
      <DeleteAllArchivedTasksButton
        actionsContainer={actionsContainer}
        count={total}
        disabled={loading || total === 0}
        workspaces={workspaceTabs.map((tab) => ({
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
          label: tab.label || getPathLeaf(tab.workspacePath),
          service: workspaceServiceLookup.get(
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
          )?.services.zcodeTaskService,
        }))}
        onDeleted={removeTaskFromTaskCaches}
        onRefresh={refresh}
      />
      {items.length === 0 ? (
        loading ? (
          <TaskListLoadingHint />
        ) : (
          <div className="px-3 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "taskList.noArchivedTasks" })}
          </div>
        )
      ) : null}
      <ul className="space-y-1 pb-4">
        {items.map((task) => {
          const workspaceServices = workspaceServiceLookup.get(
            buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
          );
          if (!workspaceServices) {
            return null;
          }
          const { services } = workspaceServices;
          const taskTitle = task.title || intl.formatMessage({ id: "taskList.untitled" });
          const taskTimeLabel = formatTaskRelativeTime(
            sortBy === "created" ? task.createdAt : task.updatedAt,
            intl,
          );
          const taskChangeSummary = getTaskChangeSummary(task);
          const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
          const workspaceLabel =
            workspaceLabelByKey.get(workspaceKey) ?? getPathLeaf(task.workspacePath);
          const isRemoteTask = Boolean(task.workspaceIdentity?.trim());
          const unarchiveLabel = intl.formatMessage({ id: "taskList.unarchive" });
          const deleteLabel = intl.formatMessage({ id: "taskList.delete" });
          // The archived tiled list is also a cross-workspace view, and the selected state must be isolated by workspaceKey.
          const isActive = workspaceKey === activeWorkspaceKey && task.taskId === activeTaskId;
          const isMobileActive = false;
          const taskKey = `${workspaceKey}:${task.taskId}`;
          const isDeleting = deletingTaskKeys.has(taskKey);

          return (
            <li
              key={taskKey}
              data-mobile-active-task={isMobileActive ? "true" : undefined}
              onClick={() => {
                onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
              }}
              className={cn(
                "cursor-pointer rounded-lg px-2.5 py-2 transition-[background-color,border-color,box-shadow]",
                isActive ? "bg-selected" : "hover:bg-surface-hover",
              )}
            >
              <div className="relative flex items-center gap-2">
                {isMobileActive ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({ id: "taskList.mobileActive" })}
                    side="right"
                    align="center"
                    triggerClassName="absolute -left-5 top-1/2 z-10 -translate-y-1/2"
                  >
                    <span
                      data-mobile-active-task="true"
                      className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                      aria-label={intl.formatMessage({
                        id: "taskList.mobileActive",
                      })}
                    >
                      {/* The archive view may also retain the old status of the current task on the mobile phone, displaying the same mark to avoid status inconsistency between lists.
                        In the previous version, putting the mark into the title line flex flow will move the task title with only the mobile mark to the right;
                        Here, absolute positioning is used to place it on the left side of the title, so that the title text continues to be aligned according to its original position. */}
                      <Smartphone className="size-3.5" />
                    </span>
                  </ControlHintTooltip>
                ) : null}
                <p
                  className="min-w-0 flex-1 truncate text-ui-base text-foreground"
                  title={taskTitle}
                >
                  {taskTitle}
                </p>
                <span className="shrink-0 text-ui-base text-foreground-subtle">
                  {taskTimeLabel}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-ui-base text-foreground-subtle">
                <span
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                  title={task.workspacePath}
                >
                  {/* The archived list previously displayed Folder for both local and remote tasks.
                    The user cannot tell which side unarchiving will affect. Cloud is used here to distinguish remote sources. */}
                  {isRemoteTask ? (
                    <Cloud className="size-3 shrink-0" />
                  ) : (
                    <Folder className="size-3 shrink-0" />
                  )}
                  <span className="min-w-0 truncate">{workspaceLabel}</span>
                </span>
                {taskChangeSummary ? (
                  <span className="shrink-0">
                    {intl.formatMessage(
                      { id: "taskList.changeStats" },
                      {
                        added: String(taskChangeSummary.added),
                        removed: String(taskChangeSummary.removed),
                      },
                    )}
                  </span>
                ) : null}
                <ControlHintTooltip title={unarchiveLabel} side="top">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-foreground-subtle hover:text-foreground"
                    aria-label={unarchiveLabel}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void services.zcodeTaskService
                        .unarchiveTask({
                          taskId: task.taskId,
                          workspacePath: task.workspacePath,
                          ...(task.workspaceIdentity
                            ? { workspaceIdentity: task.workspaceIdentity }
                            : {}),
                        })
                        .then((meta) => {
                          applyTaskQueryCacheMutation({
                            previousTask: task,
                            nextTask: meta,
                            previousState: { pinned: false, archived: true },
                            nextState: { pinned: false, archived: false },
                          });
                        })
                        .catch((error) => {
                          logger.error(
                            "[WorkspaceArchivedTasksFlatSection] failed to unarchive task:",
                            error,
                          );
                        });
                    }}
                  >
                    {/* The cancel archive button used to use ArchiveX locally/remotely.
                      The operation target is not visible in the mixed archive list. Using CloudDownload remotely will clearly affect the remote task. */}
                    {isRemoteTask ? (
                      <CloudDownload className="size-3.5" />
                    ) : (
                      <ArchiveX className="size-3.5" />
                    )}
                  </Button>
                </ControlHintTooltip>
                <ControlHintTooltip title={deleteLabel} side="top">
                  {/* During the deletion request, the button will be disabled, and the disabled element will not generate a hover event;
                    Use a real span to inherit the tooltip trigger, and the action can still be interpreted during processing. */}
                  <span className="inline-flex shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={isDeleting}
                      className="shrink-0 text-destructive hover:text-destructive"
                      aria-label={deleteLabel}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void (async () => {
                          const confirmed = await confirmDialog({
                            title: intl.formatMessage({
                              id: "confirmDialog.archivedTaskDeleteTitle",
                            }),
                            description: intl.formatMessage({
                              id: "confirmDialog.archivedTaskDeleteDescription",
                            }),
                            confirmLabel: deleteLabel,
                          });
                          if (!confirmed) {
                            return;
                          }

                          setDeletingTaskKeys((current) => new Set(current).add(taskKey));
                          try {
                            await services.zcodeTaskService.deleteTask({
                              taskId: task.taskId,
                              workspacePath: task.workspacePath,
                              ...(task.workspaceIdentity
                                ? { workspaceIdentity: task.workspaceIdentity }
                                : {}),
                            });
                            // Deletion only occurs in the archive list and cannot be treated as "unarchiving" and written back to the ordinary list.
                            // Here, the target item is directly removed from the task caches to avoid invalidating the query cache of the entire table and causing the list to flash empty.
                            removeTaskFromTaskCaches({
                              workspacePath: task.workspacePath,
                              workspaceIdentity: task.workspaceIdentity,
                              taskId: task.taskId,
                            });
                          } catch (error) {
                            logger.error(
                              "[WorkspaceArchivedTasksFlatSection] failed to delete archived task:",
                              error,
                            );
                          } finally {
                            setDeletingTaskKeys((current) => {
                              const next = new Set(current);
                              next.delete(taskKey);
                              return next;
                            });
                          }
                        })();
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </span>
                </ControlHintTooltip>
              </div>
            </li>
          );
        })}
      </ul>
      {syncingRemoteWorkspaces ? <TaskListRemoteSyncHint /> : null}
      {canToggleExpanded ? (
        <div className="cursor-pointer pl-8.5 pb-4">
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
