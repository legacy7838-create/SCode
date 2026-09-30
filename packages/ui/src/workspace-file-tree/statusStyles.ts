import type { WorkspaceFileGitStatus } from "@/workspace-file-tree/model.js";

export function getWorkspaceFileGitStatusIndicator(status: WorkspaceFileGitStatus): string | null {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "ignored":
      return null;
  }
}

export function getWorkspaceFileGitStatusTextClassName(
  status?: WorkspaceFileGitStatus,
): string | null {
  switch (status) {
    case "added":
      return "text-git-added";
    case "untracked":
      return "text-git-untracked";
    case "deleted":
      return "text-git-deleted";
    case "ignored":
      return "text-git-ignored";
    case "renamed":
      return "text-git-renamed";
    case "modified":
      return "text-git-modified";
    default:
      return null;
  }
}

export function getWorkspaceFileTreeRowDisplayGitStatus({
  gitStatus,
  directoryGitStatuses,
}: {
  gitStatus: WorkspaceFileGitStatus | null;
  directoryGitStatuses: WorkspaceFileGitStatus[];
}): WorkspaceFileGitStatus | undefined {
  // Fix: Directory text color was previously hard-coded to use untracked, and descendant dots.
  // The priorities of the aggregation status are inconsistent, resulting in conflicts between text and dot color expressions in the same directory.
  return gitStatus ?? directoryGitStatuses[0];
}

export function getWorkspaceFileGitStatusIndicatorClassName(
  status: WorkspaceFileGitStatus,
): string | null {
  switch (status) {
    case "added":
      return "text-git-added/70";
    case "untracked":
      return "text-git-untracked/70";
    case "deleted":
      return "text-git-deleted/70";
    case "renamed":
      return "text-git-renamed/70";
    case "modified":
      return "text-git-modified/70";
    case "ignored":
      return "text-git-ignored";
  }
}

export function getWorkspaceFileGitStatusDotClassName(status?: WorkspaceFileGitStatus): string {
  switch (status) {
    case "added":
      return "bg-git-added/60";
    case "untracked":
      return "bg-git-untracked/60";
    case "deleted":
      return "bg-git-deleted/60";
    case "ignored":
      return "bg-git-ignored/60";
    case "renamed":
      return "bg-git-renamed/60";
    case "modified":
      return "bg-git-modified/60";
    default:
      return "bg-git-descendant/60";
  }
}
