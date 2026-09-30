import { memo, useMemo } from "react";
import { ActivityIcon, BotIcon, SquareTerminalIcon, Workflow } from "lucide-react";
import { TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER } from "@zcode/shared";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface ComposerBackgroundWorkCounts {
  bashCount: number;
  workflowCount: number;
  subagentCount: number;
  totalCount: number;
}

function getComposerBackgroundWorkCounts(
  backgroundWorks: readonly BackgroundWorkSummary[],
  runningSubagentCount = 0,
): ComposerBackgroundWorkCounts {
  let bashCount = 0;
  let workflowCount = 0;
  for (const work of backgroundWorks) {
    if (work.status !== "running") continue;
    if (work.kind === "bash") {
      bashCount += 1;
    } else if (work.kind === "workflow") {
      // workflow run is counted separately and is not merged into bashCount. totalCount summarizes three types of background work,
      // Ensure that the badge is only displayed when the workflow is running, and the user can still open the panel and use the stop button.
      workflowCount += 1;
    }
  }
  const subagentCount = Math.max(0, runningSubagentCount);
  return {
    bashCount,
    workflowCount,
    subagentCount,
    totalCount: bashCount + workflowCount + subagentCount,
  };
}

interface ConversationBackgroundWorkTriggerProps {
  backgroundWorks: readonly BackgroundWorkSummary[];
  runningSubagentCount?: number;
  onOpen?: () => void;
  /**
   * The placement point of onOpen:
   * When `"workflow-run"` is used, the tooltip says "Open workflow details", otherwise it uses "Open running..." by type.
   * The judgment belongs to the host (toolCallId and host callback are required, and the logo cannot be seen). I will only describe it truthfully here.
   */
  openTarget?: "panel" | "workflow-run";
}

function ConversationBackgroundWorkTriggerImpl({
  backgroundWorks,
  runningSubagentCount = 0,
  onOpen,
  openTarget = "panel",
}: ConversationBackgroundWorkTriggerProps) {
  const { intl } = useZCodeIntl();
  const counts = useMemo(
    () => getComposerBackgroundWorkCounts(backgroundWorks, runningSubagentCount),
    [backgroundWorks, runningSubagentCount],
  );

  if (!onOpen || counts.totalCount === 0) return null;

  // If there is exactly one category, use that type of copywriting, otherwise it will be mixed: writing one sentence for each of the three categories in two-two combinations will pile up six synonymous tooltips.
  // The role of the badge is only to "click to see if there are real-time activities" and is not responsible for accurate enumeration.
  const activeKindCount = [counts.bashCount, counts.workflowCount, counts.subagentCount].filter(
    (count) => count > 0,
  ).length;
  const tooltip = intl.formatMessage({
    id:
      openTarget === "workflow-run"
        ? "chat.composer.backgroundWorks.tooltipWorkflowDetails"
        : activeKindCount > 1
          ? "chat.composer.backgroundWorks.tooltipMixed"
          : counts.bashCount > 0
            ? "chat.composer.backgroundWorks.tooltipTerminal"
            : counts.workflowCount > 0
              ? "chat.composer.backgroundWorks.tooltipWorkflow"
              : "chat.composer.backgroundWorks.tooltipAgent",
  });
  const ariaLabel = intl.formatMessage(
    { id: "chat.composer.backgroundWorks.ariaLabel" },
    {
      bashCount: String(counts.bashCount),
      workflowCount: String(counts.workflowCount),
      subagentCount: String(counts.subagentCount),
      count: String(counts.totalCount),
    },
  );

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER}
        data-background-bash-count={counts.bashCount}
        data-background-workflow-count={counts.workflowCount}
        data-background-subagent-count={counts.subagentCount}
        data-background-total-count={counts.totalCount}
        data-background-open-target={openTarget}
        aria-label={ariaLabel}
        onClick={onOpen}
        className="rounded-lg px-1.5 text-ui-base text-[var(--color-foreground-subtle)] tabular-nums"
      >
        <span
          data-composer-background-layout="typed"
          className="inline-flex items-center gap-1 @max-[480px]/composer:hidden"
          aria-hidden
        >
          {/* The terminal is in front, keeping the visual order before the workflow is removed; the workflow is inserted between the terminal and the agent. */}
          {counts.bashCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <SquareTerminalIcon className="size-3.5" />
              <span>{counts.bashCount}</span>
            </span>
          ) : null}
          {counts.workflowCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <Workflow className="size-3.5" />
              <span>{counts.workflowCount}</span>
            </span>
          ) : null}
          {counts.subagentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <BotIcon className="size-3.5" />
              <span>{counts.subagentCount}</span>
            </span>
          ) : null}
        </span>
        <span
          data-composer-background-layout="compact"
          className="hidden items-center gap-0.5 @max-[480px]/composer:inline-flex"
          aria-hidden
        >
          <ActivityIcon className="size-3.5" />
          <span>{counts.totalCount}</span>
        </span>
      </Button>
    </ControlHintTooltip>
  );
}

export const ConversationBackgroundWorkTrigger = memo(ConversationBackgroundWorkTriggerImpl);
