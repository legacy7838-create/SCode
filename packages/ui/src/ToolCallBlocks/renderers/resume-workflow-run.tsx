import { RotateCcw, Workflow } from "lucide-react";
import { useCallback, useMemo } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import { WorkflowRunCompactCard } from "./workflow-run-compact-card.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

/**
 * The compact run-state card uses the same icon as CreateWorkflow (consistent within the family);
 * the collapsed state keeps RotateCcw to say "resume".
 */
const RESUME_WORKFLOW_RUN_TOOL_ICON = (
  <Workflow className="size-4 shrink-0 text-foreground-subtle" />
);
const RESUME_WORKFLOW_RUN_FALLBACK_ICON = (
  <RotateCcw className="size-4 shrink-0 text-foreground-subtle" />
);

/**
 * Height of the plain-text panel when there is no display (matched to the scale of the
 * get-workflow-run output panel).
 */
const FALLBACK_OUTPUT_MAX_HEIGHT_CLASS = "max-h-60";

/**
 * The chat card for ResumeWorkflowRun.
 *
 * Two states:
 * - **run joined** (the host joins the workflowRuns projection by display.runId, the byRunId table
 *   of `workflowRunCardJoin`) → reuse CreateWorkflow's compact clickable card
 *   (`WorkflowRunCompactCard`), with the label switched to "Workflow instance resumed"; the status
 *   dot word and step count are driven live, and clicking anywhere on the card opens the run view
 *   in the sidebar — the tab identity is keyed on runId, so it opens the same tab as the original
 *   create card.
 * - **not joined** (old sessions with no display / failure paths / projection not ready yet) → a
 *   ToolLayout collapsed card: runId (mono) + the "Running in background" status dot word (the
 *   `running` tier of the run status vocabulary) + an expanded localized resume description; with
 *   no display at all, a bounded plain-text panel — never a raw JSON dump.
 */
export function ResumeWorkflowRunToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;

  const display = readToolResultDisplay(toolCall.raw);
  const runDisplay = display?.kind === "resume_workflow_run" ? display : undefined;

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.resumeRun.resuming"
      : "chat.toolCall.workflow.resumeRun.label",
  });
  const backgroundLabel = intl.formatMessage({
    id: "chat.toolCall.workflow.resumeRun.inBackground",
  });
  const hintLabel = intl.formatMessage({ id: "chat.toolCall.workflow.resumeRun.hint" });

  const snapshotNotice = (
    <ToolSnapshotFieldNotice
      refs={toolCall.snapshotRefs ?? []}
      onLoadFullToolCallFields={
        context.onLoadFullToolCallFields
          ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
          : undefined
      }
    />
  );

  const onOpenWorkflowRun = context.onOpenWorkflowRun;

  // —— run state: compact and clickable (shared components with CreateWorkflow, see component header comments for semantics) ——
  if (context.workflowRun !== undefined) {
    const runStatusLabel = intl.formatMessage({
      id: `chat.toolCall.workflow.run.status.${context.workflowRun.status}`,
    });
    const runStepsLabel = intl.formatMessage(
      { id: "chat.toolCall.workflow.card.steps" },
      { done: context.workflowRun.nodesSettled, total: context.workflowRun.nodesTotal },
    );
    return (
      <WorkflowRunCompactCard
        ariaLabel={kindLabel}
        icon={RESUME_WORKFLOW_RUN_TOOL_ICON}
        labelText={kindLabel}
        primaryText={runDisplay?.runId ?? context.workflowRun.runId}
        workflowRun={context.workflowRun}
        statusLabel={runStatusLabel}
        stepsLabel={runStepsLabel}
        onOpen={onOpenWorkflowRun !== undefined ? () => onOpenWorkflowRun({}) : undefined}
        showIcon={context.showIcon !== false}
      >
        {snapshotNotice}
      </WorkflowRunCompactCard>
    );
  }

  // —— Folded state: ToolLayout + status keyword + expansion description ——
  const runId = runDisplay?.runId;

  const primaryText = useMemo(
    () =>
      runId === undefined ? undefined : (
        <span className="min-w-0 truncate font-mono text-foreground-subtlest" title={runId}>
          {runId}
        </span>
      ),
    [runId],
  );

  // Status words are always next to dots: status is never expressed solely by color or animation (DESIGN.md accessibility rules).
  // display is only constructed on successful output, and the failure path is showFailureStatus + text panel.
  const statusLabel = useMemo(
    () =>
      runDisplay === undefined ? undefined : (
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", RUN_STATUS_DOT.running)}
          />
          <span className={cn("text-ui-sm", RUN_STATUS_TEXT.running)}>{backgroundLabel}</span>
        </span>
      ),
    [backgroundLabel, runDisplay],
  );

  const renderContent = useCallback(() => {
    if (runDisplay === undefined) {
      // Old session/failure path without display: The text projection of formatModelContent is also bounded information, directly given
      // Panel, does not do JSON dump.
      const fallbackText =
        typeof toolCall.output === "string" && toolCall.output.trim().length > 0
          ? toolCall.output
          : undefined;
      if (fallbackText === undefined) return null;
      return (
        <pre
          className={`${FALLBACK_OUTPUT_MAX_HEIGHT_CLASS} mb-2 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 font-mono text-ui-base text-foreground-subtle`}
        >
          {fallbackText}
        </pre>
      );
    }
    return (
      <p className="mb-2 rounded-lg border border-border bg-panel px-4 py-3 text-ui-sm leading-5 text-foreground-subtle">
        {hintLabel}
      </p>
    );
  }, [hintLabel, runDisplay, toolCall.output]);

  const hasDetails =
    runDisplay !== undefined ||
    (typeof toolCall.output === "string" && toolCall.output.trim().length > 0);

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={RESUME_WORKFLOW_RUN_FALLBACK_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        secondaryText={undefined}
        statusLabel={statusLabel}
        showStatusLabel={statusLabel !== undefined}
        statusTooltip={context.errorText}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
      />
      {snapshotNotice}
    </>
  );
}
