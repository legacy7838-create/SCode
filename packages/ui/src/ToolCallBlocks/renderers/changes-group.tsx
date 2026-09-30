import { PencilIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getFileDisplayPath } from "@/lib/fileDisplay.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { buildEditCodeViewerSource } from "@/ToolCallBlocks/renderers/edit.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import {
  getEditKindLabelMessageId,
  renderDiffCount,
  renderFileChip,
  renderFilePath,
} from "@/ToolCallBlocks/renderers.js";

const CHANGES_GROUP_ICON = <PencilIcon className="size-4 shrink-0 text-foreground-subtle" />;
const FILE_CHIP_GAP_PX = 8;
const FILE_CHIP_TRAILING_SPACE_PX = 24;

function resolveFileChipAvailableWidth({
  boundaryRight,
  listLeft,
  trailingWidth,
}: {
  boundaryRight: number;
  listLeft: number;
  trailingWidth: number;
}) {
  return Math.max(0, boundaryRight - listLeft - trailingWidth);
}

function resolveResponsiveFileChipCount({
  availableWidth,
  chipWidths,
  overflowWidth,
  gap,
}: {
  availableWidth: number;
  chipWidths: readonly number[];
  overflowWidth: number;
  gap: number;
}) {
  if (chipWidths.length === 0) return 0;
  // Zero available width means that the current chip cannot be accommodated, and cannot be misunderstood to mean that no cropping is required.
  // Returning 0 will retain the complete +N prompt to prevent narrow screens from showing only the truncated file name.
  if (availableWidth <= 0) return 0;
  const allChipsWidth =
    chipWidths.reduce((total, width) => total + width, 0) +
    gap * Math.max(0, chipWidths.length - 1);
  if (allChipsWidth <= availableWidth) return chipWidths.length;

  let visibleWidth = 0;
  let visibleCount = 0;
  for (const chipWidth of chipWidths) {
    const nextCount = visibleCount + 1;
    const nextVisibleWidth = visibleWidth + chipWidth;
    // While there are still hidden items, the layout includes visible chips, +N, and all gaps in between.
    const requiredWidth = nextVisibleWidth + gap * nextCount + overflowWidth;
    if (requiredWidth > availableWidth) break;
    visibleWidth = nextVisibleWidth;
    visibleCount = nextCount;
  }
  return visibleCount;
}

type ChangeFileSummary = ReturnType<typeof readRawToolCallFileSummaries>[number];

function ResponsiveFileChipList({
  files,
  workspacePath,
  onOpenCodeViewer,
}: {
  files: readonly ChangeFileSummary[];
  workspacePath: string;
  onOpenCodeViewer: ToolCallBlockRenderContext["onOpenCodeViewer"];
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const chipRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const overflowMeasureRef = useRef<HTMLSpanElement>(null);
  const [visibleCount, setVisibleCount] = useState(files.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const boundary = container.closest<HTMLElement>("[data-tool-call-id]");
    const updateVisibleCount = () => {
      // summary is shrink-to-content, measured by its own width, it will continue to shrink after hiding the chip.
      // Only by calculating the right boundary of the entire row of ToolCall can the currently truly available space be stably obtained.
      const containerRect = container.getBoundingClientRect();
      const boundaryRight = boundary?.getBoundingClientRect().right ?? containerRect.right;
      const nextVisibleCount = resolveResponsiveFileChipCount({
        availableWidth: resolveFileChipAvailableWidth({
          boundaryRight,
          listLeft: containerRect.left,
          trailingWidth: FILE_CHIP_TRAILING_SPACE_PX,
        }),
        chipWidths: files.map((_, index) => chipRefs.current[index]?.offsetWidth ?? 0),
        overflowWidth: overflowMeasureRef.current?.offsetWidth ?? 0,
        gap: FILE_CHIP_GAP_PX,
      });
      setVisibleCount((current) => (current === nextVisibleCount ? current : nextVisibleCount));
    };
    updateVisibleCount();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateVisibleCount);
    observer.observe(boundary ?? container);
    window.addEventListener("resize", updateVisibleCount);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateVisibleCount);
    };
  }, [files]);

  const resolvedVisibleCount = Math.min(visibleCount, files.length);
  const hiddenCount = files.length - resolvedVisibleCount;
  return (
    <span
      ref={containerRef}
      className="relative inline-flex min-w-0 max-w-full flex-1 items-center gap-2 overflow-hidden"
    >
      {files.map((summary, index) => {
        const isVisible = index < resolvedVisibleCount;
        return (
          <span
            key={summary.path}
            ref={(element) => {
              chipRefs.current[index] = element;
            }}
            aria-hidden={isVisible ? undefined : true}
            className={
              isVisible
                ? "inline-flex min-w-0 shrink-0"
                : "pointer-events-none invisible absolute inline-flex shrink-0"
            }
          >
            {renderFileChip({
              summary,
              clickable: isVisible && Boolean(onOpenCodeViewer),
              basePath: workspacePath,
              onClick: () => onOpenCodeViewer?.(buildEditCodeViewerSource(summary)),
            })}
          </span>
        );
      })}
      {hiddenCount > 0 ? <span className="shrink-0">+{hiddenCount}</span> : null}
      <span
        ref={overflowMeasureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute shrink-0"
      >
        +{files.length}
      </span>
    </span>
  );
}

export function ChangesGroupToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const childSummaries = useMemo(
    () =>
      childToolCalls.map((child) => ({
        child,
        summaries: readRawToolCallFileSummaries(child.toolCall.raw, child.toolCall),
      })),
    [childToolCalls],
  );
  const files = useMemo(() => {
    const unique = new Map<string, ReturnType<typeof readRawToolCallFileSummaries>[number]>();
    for (const entry of childSummaries) {
      for (const summary of entry.summaries) {
        const fileKey = getFileDisplayPath(summary.path, context.workspacePath).replaceAll(
          "\\",
          "/",
        );
        if (!unique.has(fileKey)) unique.set(fileKey, summary);
      }
    }
    return [...unique.values()];
  }, [childSummaries, context.workspacePath]);
  const latest = childSummaries.findLast((entry) => entry.summaries.length > 0);
  const latestFile = latest?.summaries.at(-1);
  const hasResolvedFiles = files.length > 0;
  const count = hasResolvedFiles ? files.length : childToolCalls.length;
  // The streaming JSON of Write/Edit may go to content first and then to file_path.
  // Count by tools that have been grouped when the path is not yet resolvable, to avoid dangling delimiters and misleading 0 files.
  const countText = intl.formatMessage(
    {
      id: hasResolvedFiles
        ? files.length === 1
          ? "chat.toolCall.changesGroup.file.one"
          : "chat.toolCall.changesGroup.file.other"
        : count === 1
          ? "chat.toolCall.changesGroup.tool.one"
          : "chat.toolCall.changesGroup.tool.other",
    },
    { count: String(count) },
  );
  const actionText = latest
    ? intl.formatMessage({
        id: getEditKindLabelMessageId(
          latest.summaries.map((summary) => summary.operationKind),
          latest.summaries.map((summary) => summary.actionLabel),
          true,
          latest.child.toolCall,
        ),
      })
    : null;
  const fileList = useMemo(
    () => (
      <ResponsiveFileChipList
        files={files}
        workspacePath={context.workspacePath}
        onOpenCodeViewer={context.onOpenCodeViewer}
      />
    ),
    [context.onOpenCodeViewer, context.workspacePath, files],
  );
  const completedSummary = useMemo(
    () =>
      files.length === 1 ? (
        fileList
      ) : (
        <span className="inline-flex min-w-0 max-w-full flex-1 items-center gap-2">
          <span className="shrink-0">{countText}</span>
          {files.length > 0 ? (
            <>
              <span>·</span>
              {fileList}
            </>
          ) : null}
        </span>
      ),
    [countText, fileList, files.length],
  );
  const runningPrimaryText = useMemo(
    () => <span className="shrink-0">{countText}</span>,
    [countText],
  );
  const runningSecondaryText = useMemo(
    () =>
      latestFile ? (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-foreground-subtlest">·</span>
          {actionText ? (
            <span className="shrink-0 text-foreground-subtle">{actionText}</span>
          ) : null}
          {renderFileChip({
            summary: latestFile,
            basePath: context.workspacePath,
          })}
          {renderFilePath(latestFile.filePath, context.workspacePath)}
        </span>
      ) : undefined,
    [actionText, context.workspacePath, latestFile],
  );
  const runningDiffCount = useMemo(
    () => renderDiffCount(latestFile?.changeStat, { animateInitial: true }),
    [latestFile?.changeStat],
  );
  const renderContent = useCallback(
    () => (
      <div className="ml-2 space-y-2 border-border border-l pl-3.5">
        {childToolCalls.map((child) => (
          <ToolCallBlock
            key={child.toolCall.toolId}
            toolCallNode={child}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            showIcon={false}
            animateDiffCountOnMount
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenAutomationsMain={context.onOpenAutomationsMain}
            onLoadFullToolCallFields={context.onLoadFullToolCallFields}
          />
        ))}
      </div>
    ),
    [
      childToolCalls,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.onOpenAutomationsMain,
      context.onLoadFullToolCallFields,
      context.theme,
      context.codePreviewSettings,
      context.workspacePath,
    ],
  );
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={CHANGES_GROUP_ICON}
      canToggle={!context.isOfficeMode && (context.canToggle ?? true)}
      forceOpen={!context.isOfficeMode && (context.forceOpen ?? false)}
      kindLabel={intl.formatMessage({ id: "chat.toolCall.changesGroup.label" })}
      primaryText={context.isRunning ? runningPrimaryText : completedSummary}
      secondaryText={context.isRunning ? runningSecondaryText : undefined}
      summaryContentSeparator="·"
      expandedPrimaryText={countText}
      expandedSecondaryText={null}
      diffCount={!context.isOfficeMode && context.isRunning ? runningDiffCount : undefined}
      hideDiffCountWhenOpen
      animateSummaryContent={context.isRunning}
      disableSummaryContentAnimation={context.disableSummaryContentAnimation}
      summaryContentKey={`changes:${toolCall.toolId}:${context.isRunning ? `${latest?.child.toolCall.toolId ?? "running"}:${actionText ?? "changing"}:${latestFile?.path ?? "file"}` : files.map((file) => file.path).join("|")}`}
      isRunning={context.isRunning}
      title={toolCall.title}
      renderContent={renderContent}
    />
  );
}
