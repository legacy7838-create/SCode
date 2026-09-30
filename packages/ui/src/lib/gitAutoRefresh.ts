import type { GitRepositorySummary, SystemInfo } from "@zcode/shared";

interface GitAutoRefreshWatchPath {
  path: string;
  recursive: boolean;
}

export function shouldEnableGitAutoRefreshForWorkspace(params: {
  enabled: boolean;
  currentWorkspaceKey: string;
  summaryWorkspaceKey: string;
}): boolean {
  return params.enabled && params.currentWorkspaceKey === params.summaryWorkspaceKey;
}

function normalizeWatchPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.replace(/[\\/]+$/, "");
}

export function buildGitAutoRefreshWatchPaths(
  summary: Pick<
    GitRepositorySummary,
    "workspacePath" | "repoRoot" | "isGitAvailable" | "isRepository"
  > &
    Partial<Pick<GitRepositorySummary, "autoRefreshWatchPaths">>,
  systemInfo?: Pick<SystemInfo, "platform"> | null,
): GitAutoRefreshWatchPath[] {
  if (!summary.isGitAvailable || !summary.isRepository) {
    return [];
  }

  const workspacePath = normalizeWatchPath(summary.workspacePath || summary.repoRoot);
  const platform = systemInfo?.platform?.trim();
  const canWatchWorkspaceRecursively = Boolean(platform && platform !== "linux");
  const watchPaths: GitAutoRefreshWatchPath[] = [];
  if (workspacePath.length > 0 && canWatchWorkspaceRecursively) {
    watchPaths.push({
      path: workspacePath,
      recursive: true,
    });
  }

  for (const watchPath of summary.autoRefreshWatchPaths ?? []) {
    const path = normalizeWatchPath(watchPath.path);
    if (
      !path ||
      // Compatible with old remote servers: old summary may still carry workspacePath, but cannot be used under Linux
      // This history field re-circulates platform boundaries, triggering slow recursive watchers.
      (path === workspacePath && !canWatchWorkspaceRecursively) ||
      watchPaths.some((entry) => entry.path === path)
    ) {
      continue;
    }

    watchPaths.push({
      path,
      recursive: watchPath.recursive,
    });
  }

  return watchPaths;
}

export function stringifyGitAutoRefreshWatchPaths(
  watchPaths: readonly GitAutoRefreshWatchPath[],
): string {
  return JSON.stringify(watchPaths);
}

export function parseGitAutoRefreshWatchPaths(signature: string): GitAutoRefreshWatchPath[] {
  const parsed = JSON.parse(signature) as GitAutoRefreshWatchPath[];
  return parsed.map((watchPath) => ({
    path: watchPath.path,
    recursive: Boolean(watchPath.recursive),
  }));
}
