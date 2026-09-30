import { useEffect, useMemo, useRef, useState } from "react";
import type { IDisposable } from "@zcode/rpc";
import type { GitRepositorySummary } from "@zcode/shared";
import {
  buildGitAutoRefreshWatchPaths,
  parseGitAutoRefreshWatchPaths,
  shouldEnableGitAutoRefreshForWorkspace,
  stringifyGitAutoRefreshWatchPaths,
} from "@/lib/gitAutoRefresh.js";
import { logger } from "@/logger.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

// When an agent writes files in bulk, the 150ms watcher debounce + 350ms Git debounce still splits long batches into multiple rounds of
// `git status`. Here Git auto-refresh is deferred to 1 minute to reduce repeated Git I/O in large workspaces.
const GIT_AUTO_REFRESH_DEBOUNCE_MS = 60_000;

interface GitWatcherRegistration {
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

export function useGitAutoRefresh({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  gitSummary,
  gitSummaryWorkspaceKey,
  enabled,
  onRefreshGit,
}: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  gitSummary: GitRepositorySummary;
  gitSummaryWorkspaceKey: string;
  enabled: boolean;
  onRefreshGit: () => void;
}) {
  const workspaceServices = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const { fileWatcherService, systemService } = workspaceServices;
  const refreshRef = useRef(onRefreshGit);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  const canWatchCurrentWorkspace = shouldEnableGitAutoRefreshForWorkspace({
    enabled,
    currentWorkspaceKey,
    summaryWorkspaceKey: gitSummaryWorkspaceKey,
  });
  const [workspacePlatformState, setWorkspacePlatformState] = useState<{
    service: typeof systemService;
    platform: string;
  } | null>(null);
  // workspaceScopedServices points to the remote host under a remote workspace, so what we get here is
  // the real runtime platform of the WSL/SSH machine, not the desktop app's own platform. The service identity
  // participates in state matching so a stale platform from a Windows workspace cannot leak into a freshly switched Linux workspace.
  const workspacePlatform =
    workspacePlatformState?.service === systemService ? workspacePlatformState.platform : null;
  useEffect(() => {
    if (!canWatchCurrentWorkspace || !gitSummary.isGitAvailable || !gitSummary.isRepository) {
      return;
    }

    let cancelled = false;
    void systemService
      .info()
      .then((info) => {
        if (!cancelled) {
          setWorkspacePlatformState({ service: systemService, platform: info.platform });
        }
      })
      .catch(() => {
        // When platform info is unavailable the path builder falls back to a conservative metadata-only strategy; the manual refresh path is unaffected.
      });

    return () => {
      cancelled = true;
    };
  }, [canWatchCurrentWorkspace, gitSummary.isGitAvailable, gitSummary.isRepository, systemService]);
  const watchPathSignature = useMemo(
    () =>
      stringifyGitAutoRefreshWatchPaths(
        canWatchCurrentWorkspace
          ? buildGitAutoRefreshWatchPaths(
              gitSummary,
              workspacePlatform ? { platform: workspacePlatform } : null,
            )
          : [],
      ),
    [
      canWatchCurrentWorkspace,
      gitSummary.isGitAvailable,
      gitSummary.isRepository,
      gitSummary.repoRoot,
      gitSummary.workspacePath,
      gitSummary.autoRefreshWatchPaths,
      workspacePlatform,
    ],
  );
  const watchPaths = useMemo(
    () => parseGitAutoRefreshWatchPaths(watchPathSignature),
    [watchPathSignature],
  );

  refreshRef.current = onRefreshGit;

  useEffect(() => {
    let cancelled = false;
    const registrations: GitWatcherRegistration[] = [];

    const scheduleRefresh = (path: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        logger.debug("[GitAutoRefresh] git status changed, refreshing repository state", {
          workspacePath,
          path,
        });
        refreshRef.current();
      }, GIT_AUTO_REFRESH_DEBOUNCE_MS);
    };

    // Every Git summary refresh brings back a new autoRefreshWatchPaths array reference.
    // Never rebuild the watchers while the watched path contents are unchanged, or bulk agent file writes would cause an unwatch/watch storm.
    for (const watchPath of watchPaths) {
      void fileWatcherService
        .watch({
          path: watchPath.path,
          recursive: watchPath.recursive,
        })
        .then(({ id }) => {
          if (cancelled) {
            void fileWatcherService.unwatch({ id });
            return;
          }

          const subscription = fileWatcherService.onDynamicChange(id)((event) => {
            scheduleRefresh(event.dirPath);
          });
          registrations.push({
            subscription,
            unwatch: () => fileWatcherService.unwatch({ id }),
          });
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          // Git live refresh only accelerates UI state sync; when watching fails, the existing manual refresh and post-action refresh paths remain in place.
          logger.warn("[GitAutoRefresh] failed to watch git workspace", {
            workspacePath,
            path: watchPath.path,
            recursive: watchPath.recursive,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return () => {
      cancelled = true;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      for (const registration of registrations) {
        registration.subscription.dispose();
        void registration.unwatch().catch((error) => {
          logger.warn("[GitAutoRefresh] failed to stop watching git workspace", {
            workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
  }, [fileWatcherService, watchPaths, workspacePath]);
}
