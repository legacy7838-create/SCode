import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";

export function TaskListItemContextMenu({
  intl,
  isPinned,
  fileManagerLabel,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onOpenInSplitPane,
  openInSplitPaneDisabled,
  onOpenTaskFeedback,
  onOpenTaskPathInFileManager,
  onCopyWorkspacePath,
  onCopyTaskPath,
  onCopyTaskLogPath,
  onCopySessionId,
  onViewModelTrajectory,
  disableTaskActions = false,
  disabledReason,
}: {
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  isPinned: boolean;
  fileManagerLabel: string;
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean };
  activeSessionId?: string | null;
  taskNativeSessionLogFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  onArchiveTask: () => void;
  onMarkTaskAsUnread: () => void;
  /** "Open in split screen" (only passed in from desktop shell). */
  onOpenInSplitPane?: () => void;
  /** The number of leaves reaches the upper limit and the session is not disabled in any pane. */
  openInSplitPaneDisabled?: boolean;
  onOpenTaskFeedback: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onViewModelTrajectory?: () => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
}) {
  return (
    <ContextMenuContent className="w-52">
      <TaskActionMenuContent
        intl={intl}
        isPinned={isPinned}
        fileManagerLabel={fileManagerLabel}
        taskSessionFile={taskSessionFile}
        activeSessionId={activeSessionId}
        taskNativeSessionLogFile={taskNativeSessionLogFile}
        Item={ContextMenuItem}
        Separator={ContextMenuSeparator}
        onTogglePinTask={onTogglePinTask}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        onOpenInSplitPane={onOpenInSplitPane}
        openInSplitPaneDisabled={openInSplitPaneDisabled}
        onOpenTaskFeedback={onOpenTaskFeedback}
        onOpenTaskPathInFileManager={onOpenTaskPathInFileManager}
        onCopyWorkspacePath={onCopyWorkspacePath}
        onCopyTaskPath={onCopyTaskPath}
        onCopyTaskLogPath={onCopyTaskLogPath}
        onCopySessionId={onCopySessionId}
        onViewModelTrajectory={onViewModelTrajectory}
        disableTaskActions={disableTaskActions}
        disabledReason={disabledReason}
      />
    </ContextMenuContent>
  );
}
