import { useMemo } from "react";
import type { GitDiffResult } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, FolderOpenIcon, ListTreeIcon } from "lucide-react";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { getDiffFallbackMessageId, getGitPaneDiffPreviewPlan } from "@/GitPane/helpers.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import type { ResolvedTheme } from "@/useTheme.js";
import { LightweightDiffPreview } from "@/components/ui/lightweight-diff-preview.js";

export function GitPaneChangeCard({
  change,
  contextMenuLabels,
  diffState,
  isDiffLoading,
  isExpanded,
  canRevealInFileManager,
  codePreviewSettings,
  resolvedTheme,
  onCopyAbsolutePath,
  onCopyRelativePath,
  onOpenChange,
  onRevealInFileManager,
  onRevealInFileTree,
}: {
  change: GitPaneFileChange;
  contextMenuLabels: {
    copyAbsolutePath: string;
    copyRelativePath: string;
    revealInFileManager: string;
    revealInFileTree: string;
  };
  diffState: GitDiffResult | null;
  isDiffLoading: boolean;
  isExpanded: boolean;
  canRevealInFileManager: boolean;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: ResolvedTheme;
  onCopyAbsolutePath: (change: GitPaneFileChange) => void;
  onCopyRelativePath: (change: GitPaneFileChange) => void;
  onOpenChange: (change: GitPaneFileChange, nextOpen: boolean) => void;
  onRevealInFileManager: (change: GitPaneFileChange) => void;
  onRevealInFileTree?: (change: GitPaneFileChange) => void;
}) {
  const { intl } = useZCodeIntl();
  const diffPreviewPlan = useMemo(() => getGitPaneDiffPreviewPlan(diffState), [diffState]);
  const multiFileDiffFiles = useMemo(() => {
    if (diffState?.availability !== "patch" || diffState.afterContent === null) {
      return null;
    }

    // DiffViewer is a memo component. If oldFile/newFile is created inline in JSX,
    // Any refresh of the parent will invalidate the shallow comparison of the large diff view.
    return {
      oldFile: {
        name: change.workspaceRelativePath,
        contents: diffState.beforeContent ?? "",
        cacheKey: `old:${diffState.path}:${diffState.beforeContent?.length ?? 0}:${diffState.beforeContent?.slice(0, 100) ?? ""}:${diffState.beforeContent?.slice(-100) ?? ""}`,
      },
      newFile: {
        name: change.workspaceRelativePath,
        contents: diffState.afterContent,
        cacheKey: `new:${diffState.path}:${diffState.afterContent.length}:${diffState.afterContent.slice(0, 100)}:${diffState.afterContent.slice(-100)}`,
      },
    };
  }, [
    change.workspaceRelativePath,
    diffState?.afterContent,
    diffState?.availability,
    diffState?.beforeContent,
    diffState?.path,
  ]);

  return (
    <div className="w-full min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-expanded={isExpanded}
            className={cn(
              "sticky top-0 z-10 flex h-8 w-full items-center gap-3 bg-background px-3 text-left transition-colors hover:bg-surface-hover supports-[backdrop-filter]:backdrop-blur-sm",
              isExpanded && "bg-surface-hover",
            )}
            onClick={() => onOpenChange(change, !isExpanded)}
          >
            {/* Review opens and mounts dozens of visual/overscan lines at once; each line uses Radix Collapsible
                Provider/presence and measurement links will be additionally created. After clicking in the CDP CPU profile, the main thread is concentrated on
                React commit phase. Here it is changed to a normal button + only expands the row to render the content, retaining the interaction while reducing the opening cost. */}
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <FileDisplayInline
                  path={change.workspaceRelativePath}
                  options={{
                    showFilePath: true,
                    className: "inline-flex min-w-0 max-w-full items-center gap-2",
                    fileNameClassName: "truncate text-ui-base text-foreground",
                    filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                  }}
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-3 pl-3">
              <div className="shrink-0 whitespace-nowrap text-ui-base">
                <span className="text-diff-added">+{change.added}</span>
                <span className="ml-2 text-diff-removed">-{change.removed}</span>
              </div>
              <ChevronDownIcon
                className={cn(
                  "size-4 shrink-0 text-foreground-subtle transition-transform",
                  isExpanded && "rotate-180",
                )}
              />
            </div>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem
            disabled={!canRevealInFileManager}
            onSelect={() => onRevealInFileManager(change)}
          >
            <FolderOpenIcon className="size-4" />
            {contextMenuLabels.revealInFileManager}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopyAbsolutePath(change)}>
            <CopyIcon className="size-4" />
            {contextMenuLabels.copyAbsolutePath}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopyRelativePath(change)}>
            <CopyIcon className="size-4" />
            {contextMenuLabels.copyRelativePath}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!onRevealInFileTree}
            onSelect={() => onRevealInFileTree?.(change)}
          >
            <ListTreeIcon className="size-4" />
            {contextMenuLabels.revealInFileTree}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isExpanded ? (
        <div className="w-full min-w-0 overflow-x-auto overflow-y-hidden bg-background">
          {isDiffLoading ? (
            <div className="flex items-center justify-center py-4 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          ) : diffState?.availability === "patch" && diffPreviewPlan.kind === "plain-text" ? (
            <div className="w-full min-w-0">
              <GitPanePlainTextDiffPreview
                lines={diffPreviewPlan.lines}
                codePreviewSettings={codePreviewSettings}
              />
            </div>
          ) : diffState?.availability === "patch" &&
            diffPreviewPlan.kind === "patch" &&
            diffState.patch ? (
            <div className="w-full min-w-0">
              {/* Large file expansion only requires the change hunk to be seen first. Keep going before/after the MultiFileDiff
                The entire file will be compared synchronously and click feedback will be slowed down; the patch input is changed here so that the highlighting can continue to be completed asynchronously by the worker. */}
              <DiffViewer
                patch={diffState.patch}
                diffClassName="block"
                fontSizePx={codePreviewSettings.fontSizePx}
                lightTheme={codePreviewSettings.lightTheme}
                darkTheme={codePreviewSettings.darkTheme}
                themeType={resolvedTheme}
              />
            </div>
          ) : diffState?.availability === "patch" &&
            diffState.afterContent !== null &&
            multiFileDiffFiles ? (
            <div className="w-full min-w-0">
              {/* The width of the right column of the mobile phone remote control is narrow, and the expanded file diff cannot rely on the parent to hide overflow.
                The outer layer allows horizontal scrolling so that long lines of diff will not be cropped on narrow screens. */}
              <DiffViewer
                oldFile={multiFileDiffFiles.oldFile}
                newFile={multiFileDiffFiles.newFile}
                diffClassName="block"
                fontSizePx={codePreviewSettings.fontSizePx}
                lightTheme={codePreviewSettings.lightTheme}
                darkTheme={codePreviewSettings.darkTheme}
                themeType={resolvedTheme}
              />
            </div>
          ) : (
            <div className="px-4 py-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: getDiffFallbackMessageId(diffState?.availability ?? "unavailable"),
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GitPanePlainTextDiffPreview({
  lines,
  codePreviewSettings,
}: {
  lines: readonly string[];
  codePreviewSettings: CodePreviewSettings;
}) {
  // Very large patches or deep hunks entering rich diff rendering will consume the main thread in simultaneous parsing/DOM construction.
  // The lightweight hunk preview reuses the shared diff line number/gutter style to avoid visual divergence from the DiffViewer on the right.
  return (
    <LightweightDiffPreview
      codePreviewSettings={codePreviewSettings}
      data-git-plain-text-diff-preview
      lines={lines}
    />
  );
}
