import { ArrowUpRightIcon } from "lucide-react";
import { useMemo } from "react";
import { WORKFLOW_CARD_ICON } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

export function WorkflowToolSummary({
  toolCallId,
  summary,
  onOpen,
  amend = false,
}: {
  toolCallId: string;
  summary: WorkflowRunCardSummary;
  onOpen?: () => void;
  /** AmendWorkflow initiating line: Change the category word to "Workflow has been adjusted". */
  amend?: boolean;
}) {
  const { intl } = useZCodeIntl();
  // ToolLayout is a memo component: primaryText If JSX is inlined, memo will be broken every time it is rendered (reactStableReferences test will block it).
  // Counting only counts subagents; when the host does not count subagents, leave that section blank, leaving only ↗.
  const agents = summary.agents;
  const primaryText = useMemo(
    () => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span aria-hidden>·</span>
        <span
          data-testid="workflow-summary-agents"
          className={
            onOpen
              ? "inline-flex items-center gap-2 group-hover/tool-summary:text-foreground group-focus-visible/tool-summary:text-foreground"
              : "inline-flex items-center gap-2"
          }
        >
          {agents === undefined
            ? null
            : intl.formatMessage(
                {
                  id:
                    agents === 1
                      ? "chat.toolCall.workflow.card.agent"
                      : "chat.toolCall.workflow.card.agents",
                },
                { count: agents },
              )}
          {onOpen ? <ArrowUpRightIcon aria-hidden className="size-4 shrink-0" /> : null}
        </span>
      </span>
    ),
    [agents, intl, onOpen],
  );
  return (
    <div
      data-testid="workflow-tool-summary"
      data-tool-call-id={toolCallId}
      data-workflow-run-id={summary.runId}
    >
      <ToolLayout
        toolId={toolCallId}
        icon={WORKFLOW_CARD_ICON}
        kindLabel={intl.formatMessage({
          id: amend ? "chat.toolCall.workflow.amend.amended" : "chat.toolCall.workflow.ran",
        })}
        canToggle={false}
        primaryText={primaryText}
        summaryAction={
          onOpen
            ? {
                ariaLabel: intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" }),
                onActivate: onOpen,
              }
            : undefined
        }
      />
    </div>
  );
}
