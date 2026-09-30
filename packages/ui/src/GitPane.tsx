/* eslint-disable max-lines -- GitPane currently centralizes source switching, lazy diff loading,
 * expansion state, and the file-change lookup linkage; any later split has to be driven separately
 * along the Git panel's functional boundaries.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GitChangeSourceId, GitDiffResult } from "@zcode/shared";
import { TID_GIT_PANE } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { FileTextIcon, RefreshCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { type GitPaneFileChange, type GitPaneRepositoryState } from "@/hooks/useGitRepository.js";
import { useServices } from "@/hooks/useServices.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { joinFilePath, isAbsoluteFilePath } from "@/lib/path.js";
import {
  getDiffCacheKey,
  getErrorMessage,
  getGitPaneDiffFindContent,
  getSourceMessageId,
} from "@/GitPane/helpers.js";
import { GitPaneChangeCard } from "@/GitPaneChangeCard.js";
import { getFileChangeFindState } from "@/GitPane/fileChangeFindSearch.js";
import { logger } from "@/logger.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";

interface GitDiffLoadState {
  loading: boolean;
  diff: GitDiffResult | null;
}

const GIT_PANE_CHANGE_ROW_ESTIMATE_PX = 32;
const GIT_PANE_CHANGE_ROW_OVERSCAN = 14;

export function GitPane({
  workspacePath,
  gitState,
  isDesktop,
  selectedSourceId,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  onSelectSource,
  onClose: _onClose,
  onRefresh,
  onRevealFileInTree,
  workspaceIdentity,
  workspaceRemoteSessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  gitState: GitPaneRepositoryState;
  isDesktop?: boolean;
  selectedSourceId: GitChangeSourceId;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  onSelectSource: (sourceId: GitChangeSourceId) => void;
  onClose: () => void;
  onRefresh: () => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { gitService } = useServices();
  const { intl } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  const fileActions = useFileContextActions({
    canOpenLocalFileManager: Boolean(isDesktop),
    isRemoteWorkspace:
      Boolean(workspaceRemoteSessionId || workspaceIdentity?.trim()) ||
      workspaceOpenTarget.isRemoteWorkspace,
    remoteTarget: workspaceOpenTarget.remoteTarget,
    workspaceIdentity,
  });
  const resolvedTheme = resolveTheme(theme);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diffStateByKey, setDiffStateByKey] = useState<Record<string, GitDiffLoadState>>({});
  const diffGenerationRef = useRef(0);
  const pendingDiffKeysRef = useRef(new Set<string>());
  const changeListScrollRef = useRef<HTMLDivElement | null>(null);

  const defaultSourceOption = gitState.sourceOptions[0]!;
  const currentSourceOption =
    gitState.sourceOptions.find((option) => option.id === selectedSourceId) ?? defaultSourceOption;
  const currentDataset = gitState.datasets[currentSourceOption.id] ?? gitState.datasets.unstaged;
  const currentChanges = useMemo(
    () => currentDataset.sections.flatMap((section) => section.changes),
    [currentDataset],
  );
  const normalizedFileChangeFindQuery = fileChangeFindQuery.trim();

  const emptyStateCopy = useMemo(() => {
    if (currentSourceOption.id === "last-turn") {
      return {
        title: intl.formatMessage({ id: "git.empty.lastTurnTitle" }),
        description: intl.formatMessage({
          id: "git.empty.lastTurnDescription",
        }),
      };
    }

    if (gitState.loading) {
      return {
        title: intl.formatMessage({ id: "common.loading" }),
        description: intl.formatMessage({ id: "git.loading.description" }),
      };
    }

    if (gitState.error) {
      return {
        title: intl.formatMessage({ id: "git.error.title" }),
        description: intl.formatMessage(
          { id: "git.error.description" },
          { message: gitState.error },
        ),
      };
    }

    if (!gitState.summary.isGitAvailable) {
      return {
        title: intl.formatMessage({ id: "git.empty.gitUnavailableTitle" }),
        description: intl.formatMessage({
          id: "git.empty.gitUnavailableDescription",
        }),
      };
    }

    if (!gitState.summary.isRepository) {
      return {
        title: intl.formatMessage({ id: "git.empty.notRepositoryTitle" }),
        description: intl.formatMessage({
          id: "git.empty.notRepositoryDescription",
        }),
      };
    }

    return {
      title: intl.formatMessage({ id: "git.empty.title" }),
      description: intl.formatMessage({ id: "git.empty.description" }),
    };
  }, [
    currentSourceOption.id,
    gitState.error,
    gitState.loading,
    gitState.summary.isGitAvailable,
    gitState.summary.isRepository,
    intl,
  ]);

  useEffect(() => {
    diffGenerationRef.current += 1;
    pendingDiffKeysRef.current.clear();
    setDiffStateByKey({});
  }, [gitState.revision, workspacePath]);

  useEffect(() => {
    if (!expandedPath) {
      return;
    }

    if (!currentChanges.some((change) => change.path === expandedPath)) {
      setExpandedPath(null);
    }
  }, [currentChanges, expandedPath]);

  const loadDiffForChange = useCallback(
    (change: GitPaneFileChange, sourceId: GitChangeSourceId) => {
      if (sourceId === "last-turn" || change.diff) {
        return;
      }

      const cacheKey = getDiffCacheKey(sourceId, change.path);
      if (pendingDiffKeysRef.current.has(cacheKey) || diffStateByKey[cacheKey]?.diff) {
        return;
      }

      pendingDiffKeysRef.current.add(cacheKey);
      setDiffStateByKey((current) => ({
        ...current,
        [cacheKey]: {
          loading: true,
          diff: current[cacheKey]?.diff ?? null,
        },
      }));

      const generation = diffGenerationRef.current;
      void gitService
        .getDiff({
          workspacePath,
          path: change.path,
          sourceId,
        })
        .then((diff) => {
          if (diffGenerationRef.current !== generation) {
            return;
          }

          // For large file diff stuck issues, you need to first confirm whether "it's stuck in pulling or rendering."
          // The diff size obtained for each expansion is recorded here, making it easy to quickly determine whether the fallback condition is hit from the log.
          // File change search will preload diffs in batches; this type of file-by-file scale log is only suitable for development troubleshooting.
          // Using debug can prevent the production desktop log from being enlarged by search behavior, while retaining clues for locating large diff lags.
          logger.debug("[GitPane] diff loaded", {
            workspacePath,
            sourceId,
            path: change.path,
            availability: diff.availability,
            beforeChars: diff.beforeContent?.length ?? 0,
            afterChars: diff.afterContent?.length ?? 0,
          });

          setDiffStateByKey((current) => ({
            ...current,
            [cacheKey]: {
              loading: false,
              diff,
            },
          }));
        })
        .catch((error: unknown) => {
          if (diffGenerationRef.current !== generation) {
            return;
          }

          const message = getErrorMessage(error);
          logger.warn("[GitPane] failed to read file diff", {
            workspacePath,
            sourceId,
            path: change.path,
            error: message,
          });
          setDiffStateByKey((current) => ({
            ...current,
            [cacheKey]: {
              loading: false,
              diff: {
                path: change.path,
                availability: "unavailable",
                patch: null,
                beforeContent: null,
                afterContent: null,
                summary: message,
              },
            },
          }));
        })
        .finally(() => {
          pendingDiffKeysRef.current.delete(cacheKey);
        });
    },
    [diffStateByKey, gitService, workspacePath],
  );

  useEffect(() => {
    if (!expandedPath) {
      return;
    }

    const expandedChange = currentChanges.find((change) => change.path === expandedPath);
    if (!expandedChange) {
      return;
    }

    loadDiffForChange(expandedChange, currentDataset.id);
  }, [currentChanges, currentDataset.id, expandedPath, loadDiffForChange]);

  const fileChangeFindTargets = useMemo(
    () =>
      currentChanges.map((change) => {
        const diffState =
          change.diff ??
          diffStateByKey[getDiffCacheKey(currentDataset.id, change.path)]?.diff ??
          null;
        return {
          path: change.path,
          content: getGitPaneDiffFindContent(diffState),
        };
      }),
    [currentChanges, currentDataset.id, diffStateByKey],
  );
  const fileChangeFindState = useMemo(
    () =>
      getFileChangeFindState(fileChangeFindTargets, fileChangeFindQuery, fileChangeFindActiveIndex),
    [fileChangeFindActiveIndex, fileChangeFindQuery, fileChangeFindTargets],
  );
  const activeFileChangeFindMatch = fileChangeFindState.activeMatch;
  const changeRowVirtualizer = useVirtualizer({
    count: currentChanges.length,
    getItemKey: (index) => {
      const change = currentChanges[index];
      return change ? `${currentDataset.id}:${change.path}` : `${currentDataset.id}:${index}`;
    },
    getScrollElement: () => changeListScrollRef.current,
    estimateSize: () => GIT_PANE_CHANGE_ROW_ESTIMATE_PX,
    overscan: GIT_PANE_CHANGE_ROW_OVERSCAN,
  });
  const virtualChangeRows = changeRowVirtualizer.getVirtualItems();

  useEffect(() => {
    onFileChangeFindMatchCountChange(fileChangeFindState.total);
  }, [fileChangeFindState.total, onFileChangeFindMatchCountChange]);

  useEffect(() => {
    // When the Review panel is opened, hundreds of untracked files will be mounted simultaneously. Click in CDP trace
    // Events thus appear 600ms+ long task. Only visible rows are mounted here; retest when the height changes after expanding diff.
    // Prevent subsequent virtual rows from continuing to use the collapsed height.
    changeRowVirtualizer.measure();
  }, [changeRowVirtualizer, currentDataset.id, expandedPath]);

  useEffect(() => {
    if (!normalizedFileChangeFindQuery) {
      return;
    }

    // File change search needs to hit the content in the folded file.
    // By default, diff is loaded lazily when expanded, so when searching, first complete the diff of the current source, and then use the same set of patch data to calculate global hits.
    for (const change of currentChanges) {
      loadDiffForChange(change, currentDataset.id);
    }
  }, [currentChanges, currentDataset.id, loadDiffForChange, normalizedFileChangeFindQuery]);

  useEffect(() => {
    if (!activeFileChangeFindMatch) {
      return;
    }

    const activeChange = currentChanges.find(
      (change) => change.path === activeFileChangeFindMatch.path,
    );
    if (!activeChange) {
      return;
    }

    if (expandedPath !== activeFileChangeFindMatch.path) {
      // The current hit may be inside a folded file.
      // The target file is expanded first, and then the text highlight hook scrolls to the hit line after the real DOM is rendered.
      setExpandedPath(activeFileChangeFindMatch.path);
    }
    loadDiffForChange(activeChange, currentDataset.id);
  }, [
    activeFileChangeFindMatch,
    currentChanges,
    currentDataset.id,
    expandedPath,
    fileChangeFindNavigationRequestId,
    loadDiffForChange,
  ]);

  useEffect(() => {
    if (!activeFileChangeFindMatch) {
      return;
    }

    const activeMatchIndex = currentChanges.findIndex(
      (change) => change.path === activeFileChangeFindMatch.path,
    );
    if (activeMatchIndex < 0) {
      return;
    }

    changeRowVirtualizer.scrollToIndex(activeMatchIndex, { align: "center" });
  }, [
    activeFileChangeFindMatch,
    changeRowVirtualizer,
    currentChanges,
    fileChangeFindNavigationRequestId,
  ]);

  const handleSelectSource = (nextSourceId: string) => {
    logger.info(`[GitPane] switching source workspace=${workspacePath} source=${nextSourceId}`);
    onSelectSource(nextSourceId as GitChangeSourceId);
    setExpandedPath(null);
  };

  const handleExpandChange = (change: GitPaneFileChange, nextOpen: boolean) => {
    logger.info(
      `[GitPane] toggling file expansion workspace=${workspacePath} source=${currentSourceOption.id} path=${change.path} expanded=${nextOpen}`,
    );
    setExpandedPath(nextOpen ? change.path : null);
    if (nextOpen) {
      loadDiffForChange(change, currentDataset.id);
    }
  };

  const resolveChangePath = useCallback(
    (change: GitPaneFileChange) =>
      isAbsoluteFilePath(change.path) ? change.path : joinFilePath(workspacePath, change.path),
    [workspacePath],
  );

  const handleCopyAbsolutePath = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.copyAbsolutePath({ path: resolveChangePath(change) });
    },
    [fileActions, resolveChangePath],
  );
  const handleCopyRelativePath = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.copyRelativePath({
        path: resolveChangePath(change),
        relativePath: getWorkspaceFileRelativePath(workspacePath, resolveChangePath(change)),
      });
    },
    [fileActions, resolveChangePath, workspacePath],
  );

  const handleRevealChangeInFileManager = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.revealInFileManager({
        path: resolveChangePath(change),
        deleted: change.kind === "deleted",
        kind: "file",
      });
    },
    [fileActions, resolveChangePath],
  );

  const handleRevealChangeInFileTree = useCallback(
    (change: GitPaneFileChange) => {
      onRevealFileInTree?.(resolveChangePath(change));
    },
    [onRevealFileInTree, resolveChangePath],
  );

  const contextMenuLabels = useMemo(
    () => ({
      copyAbsolutePath: intl.formatMessage({ id: "fileActions.copyAbsolutePath" }),
      copyRelativePath: intl.formatMessage({ id: "fileActions.copyRelativePath" }),
      revealInFileManager: intl.formatMessage({ id: "git.changeContext.revealInFileManager" }),
      revealInFileTree: intl.formatMessage({ id: "git.changeContext.revealInFileTree" }),
    }),
    [intl],
  );

  return (
    <section data-testid={TID_GIT_PANE} className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 p-3">
        <Select value={currentSourceOption.id} onValueChange={handleSelectSource}>
          <SelectTrigger className="max-w-full" size="lg">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {gitState.sourceOptions.map((option) => (
              <SelectItem key={option.id} value={option.id} disabled={option.disabled}>
                {intl.formatMessage({ id: getSourceMessageId(option.id) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            disabled={gitState.loading}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-3.5", gitState.loading && "animate-spin")} />
            {intl.formatMessage({ id: "git.action.refresh" })}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {currentChanges.length > 0 ? (
          <div ref={changeListScrollRef} className="h-full min-h-0 w-full overflow-auto">
            <div
              className="relative w-full min-w-0"
              style={{ height: `${changeRowVirtualizer.getTotalSize()}px` }}
            >
              {virtualChangeRows.map((virtualRow) => {
                const change = currentChanges[virtualRow.index];
                if (!change) {
                  return null;
                }

                const isExpanded = expandedPath === change.path;
                const diffCacheKey = getDiffCacheKey(currentDataset.id, change.path);
                const cachedDiffState = diffStateByKey[diffCacheKey];
                const diffState = change.diff ?? cachedDiffState?.diff ?? null;
                const isDiffLoading =
                  isExpanded && !change.diff && (!cachedDiffState || cachedDiffState.loading);

                return (
                  <div
                    key={virtualRow.key}
                    ref={changeRowVirtualizer.measureElement}
                    className="absolute left-0 w-full min-w-0"
                    data-git-pane-change-virtual-row
                    data-index={virtualRow.index}
                    // Transform positioning will invalidate the sticky file name in the line, and the title will no longer be on top after expanding the large diff.
                    // Use a top offset instead to preserve the virtual scroll layout while letting sticky continue to reference the scroll container.
                    style={{ top: `${virtualRow.start}px` }}
                  >
                    <GitPaneChangeCard
                      change={change}
                      contextMenuLabels={contextMenuLabels}
                      diffState={diffState}
                      isDiffLoading={isDiffLoading}
                      isExpanded={isExpanded}
                      canRevealInFileManager={fileActions.canRevealInFileManager({
                        path: resolveChangePath(change),
                        deleted: change.kind === "deleted",
                      })}
                      codePreviewSettings={codePreviewSettings}
                      resolvedTheme={resolvedTheme}
                      onCopyAbsolutePath={handleCopyAbsolutePath}
                      onCopyRelativePath={handleCopyRelativePath}
                      onOpenChange={handleExpandChange}
                      onRevealInFileManager={handleRevealChangeInFileManager}
                      onRevealInFileTree={
                        onRevealFileInTree ? handleRevealChangeInFileTree : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <FileTextIcon className="size-8 text-foreground-subtlest" />
            <p className="mt-3 text-ui-base font-medium text-foreground">{emptyStateCopy.title}</p>
            <p className="mt-1 text-ui-base text-foreground-subtle">{emptyStateCopy.description}</p>
          </div>
        )}
      </div>
    </section>
  );
}
