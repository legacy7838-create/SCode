import { SquareTerminalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { getExecuteSecondaryText } from "@/ToolCallBlocks/renderers/execute.js";

const EXECUTE_GROUP_ICON = (
  <SquareTerminalIcon className="size-4 shrink-0 text-foreground-subtle" />
);

// V4 row will uniformly adapt inputStreaming/pendingApproval to pending before entering the shared renderer.
const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);

function formatCompletedSummary(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  childStatuses: string[],
) {
  const parts = [
    intl.formatMessage(
      {
        id:
          childStatuses.length === 1
            ? "chat.toolCall.executeGroup.command.one"
            : "chat.toolCall.executeGroup.command.other",
      },
      { count: childStatuses.length },
    ),
  ];
  const failedCount = childStatuses.filter((status) => status === "failed").length;
  const stoppedCount = childStatuses.filter((status) => status === "stopped").length;
  if (failedCount > 0) {
    parts.push(
      intl.formatMessage({ id: "chat.toolCall.executeGroup.failed" }, { count: failedCount }),
    );
  }
  if (stoppedCount > 0) {
    parts.push(
      intl.formatMessage({ id: "chat.toolCall.executeGroup.stopped" }, { count: stoppedCount }),
    );
  }
  return parts.join(", ");
}

export function ExecuteGroupToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, isOfficeMode = false } = context;
  const { toolCall, childToolCalls } = toolCallNode;
  const latestActiveChild = childToolCalls.findLast((child) =>
    ACTIVE_STATUSES.has(child.toolCall.status),
  );
  const latestChild = latestActiveChild ?? childToolCalls.at(-1);
  const latestCommand =
    !isOfficeMode && latestChild ? getExecuteSecondaryText(latestChild.toolCall.input) : undefined;
  const runningActionLabel = latestCommand
    ? intl.formatMessage({ id: "chat.toolCall.execute.running" })
    : undefined;
  const runningPrimaryText = useMemo(
    () =>
      runningActionLabel ? (
        <span className="shrink-0 text-foreground-subtle">{runningActionLabel}</span>
      ) : null,
    [runningActionLabel],
  );
  const runningSecondaryText = useMemo(
    () =>
      latestCommand ? (
        // Tailwind v4 preflight will give the code a default mono font.
        // If not specified explicitly, the running state command will be inconsistent with the sans convention of the execute/explore closed state.
        <code className="min-w-0 truncate font-sans">{latestCommand}</code>
      ) : undefined,
    [latestCommand],
  );
  const completedSummary = formatCompletedSummary(
    intl,
    childToolCalls.map((child) => child.toolCall.status),
  );
  const renderContent = useCallback(
    () => (
      <div className="ml-2 space-y-2 border-border border-l pl-3.5">
        {childToolCalls.map((child) => (
          <ToolCallBlock
            key={child.toolCall.toolId}
            toolCallNode={child}
            workspacePath={context.workspacePath}
            showIcon={false}
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
      context.onLoadFullToolCallFields,
      context.onOpenAutomationsMain,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.workspacePath,
    ],
  );

  // New commands are only added on a rolling basis when the Execute phase is running; the old queue must be cleared immediately after the phase ends and the final statistics are displayed.
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={EXECUTE_GROUP_ICON}
      canToggle={!isOfficeMode && (context.canToggle ?? true)}
      forceOpen={!isOfficeMode && (context.forceOpen ?? false)}
      kindLabel={intl.formatMessage({ id: "chat.toolCall.executeGroup.label" })}
      expandedKindLabel={intl.formatMessage({
        id: "chat.toolCall.executeGroup.label",
      })}
      primaryText={isRunning && runningActionLabel ? runningPrimaryText : completedSummary}
      secondaryText={isRunning ? runningSecondaryText : undefined}
      summaryContentSeparator="·"
      expandedPrimaryText={completedSummary}
      // By default, ToolLayout will inherit secondaryText in the expanded state, resulting in the current command remaining after the number of commands.
      // After the parent group is expanded, the child tool summary expresses the current command, so it must be cleared explicitly here.
      expandedSecondaryText={null}
      animateSummaryContent={isRunning}
      disableSummaryContentAnimation={context.disableSummaryContentAnimation}
      summaryContentKey={
        isRunning && latestChild
          ? `execute:${toolCall.toolId}:${latestChild.toolCall.toolId}:${runningActionLabel ?? "running"}:${latestCommand ?? "command"}`
          : `execute:${toolCall.toolId}:done:${completedSummary}`
      }
      statusLabel={statusLabel}
      isRunning={isRunning}
      title={isOfficeMode ? undefined : isRunning && latestCommand ? latestCommand : toolCall.title}
      expandedTitle={toolCall.title}
      renderContent={renderContent}
    />
  );
}
