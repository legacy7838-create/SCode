import type { ZCodeTaskMeta } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

interface TaskFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

function resolveTaskFileTreeTarget(
  task: ZCodeTaskMeta,
  tab: WorkspaceTabState | undefined,
): TaskFileTreeTarget | null {
  // The old local task does not have workspaceIdentity, and the key will fall back to workspacePath; if the path is the same
  // The remote tab also lacks identity, and just pressing the key will mistakenly bring up the remote session. The local/remote types must be consistent before matching.
  const taskIsRemote = Boolean(task.workspaceIdentity?.trim());
  const tabIsRemote = Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteTarget || tab?.remoteSessionId,
  );
  const matchingTab =
    tab &&
    buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
      buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) &&
    taskIsRemote === tabIsRemote
      ? tab
      : undefined;
  if (tab && !matchingTab) {
    return null;
  }
  const isRemoteWorkspace = Boolean(
    task.workspaceIdentity?.trim() || matchingTab?.remoteTarget || matchingTab?.remoteSessionId,
  );
  // The workspacePath of the remote task may be the same as the local workspace. Missing corresponding remoteSessionId
  // It is forbidden to open the file tree when the file tree is opened, otherwise file reading will be downgraded to the local service by mistake.
  if (isRemoteWorkspace && !matchingTab?.remoteSessionId) {
    return null;
  }

  return {
    workspacePath: task.workspacePath,
    workspaceName: matchingTab?.label || getPathLeaf(task.workspacePath) || task.workspacePath,
    ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(matchingTab?.remoteSessionId
      ? { workspaceRemoteSessionId: matchingTab.remoteSessionId }
      : {}),
  };
}

export function resolveTaskFileTreeTargetFromTabs(
  task: ZCodeTaskMeta,
  tabs: readonly WorkspaceTabState[],
): TaskFileTreeTarget | null {
  // The local and old remote tabs with the same path may generate the same key and cannot be compressed into a single-value Map first;
  // All candidates must be retained, and then the single-tab parser verifies the workspace type and remote session.
  for (const tab of tabs) {
    const target = resolveTaskFileTreeTarget(task, tab);
    if (target) {
      return target;
    }
  }
  // Local tasks do not depend on open tabs; the file tree should still be opened according to the path when the workspace it belongs to is closed.
  // For remote tasks, you must hit the tab to obtain the identity-isolated remoteSessionId, and the same rollback is prohibited.
  if (!task.workspaceIdentity?.trim()) {
    return resolveTaskFileTreeTarget(task, undefined);
  }
  return null;
}
