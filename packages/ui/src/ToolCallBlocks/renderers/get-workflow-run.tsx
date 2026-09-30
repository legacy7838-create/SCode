import { Gauge } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import {
  RUN_STATUS_TEXT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatWorkflowAge, formatWorkflowTokenCount } from "@/lib/workflowObservationFormat.js";
import { WorkflowRunSubagentRoster } from "@/ToolCallBlocks/renderers/get-workflow-run-roster.js";
import {
  WorkflowRunHealthLine,
  WorkflowRunPhaseTrack,
} from "@/ToolCallBlocks/renderers/get-workflow-run-situation.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const ICON = <Gauge className="size-4 shrink-0 text-foreground-subtle" />;

export function GetWorkflowRunToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const running = context.isRunning;
  // Query errors and run execution failures are two status levels; error queries cannot continue to display the old display.
  const failed = !running && toolCall.status === "failed";
  const run = !running && !failed && display?.kind === "get_workflow_run" ? display : undefined;
  const fallback = typeof toolCall.output === "string" ? toolCall.output.trim() : undefined;
  const failureLabel = intl.formatMessage({ id: "chat.toolCall.status.failed" });
  const error = context.errorText || fallback || failureLabel;
  const primaryText = useMemo(
    () =>
      run ? (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">
            {run.label ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" })}
          </span>
          <span aria-hidden>·</span>
          {/*
            If there is a summary sentence, let it occupy the collapsed line: "In the 2 / 4 stage, 5 steps have been resolved, 2 are running" than
            "Step 5/7" answers more questions. Leave the truncation to CSS (truncate), do not cut characters here - cut them out
            Half a sentence is the wrong length in both narrowscreen and widescreen. The old load before the situation went online has no summary and is still drawn according to the number of steps.
          */}
          {run.summary === undefined || run.summary.length === 0 ? (
            <span className="shrink-0 tabular-nums">
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.card.steps" },
                {
                  done: run.usage.nodesCompleted + run.usage.nodesFailed,
                  total: run.usage.nodesObserved,
                },
              )}
            </span>
          ) : (
            <span className="min-w-0 truncate" data-testid="workflow-run-summary-line">
              {run.summary}
            </span>
          )}
        </span>
      ) : undefined,
    [intl, run],
  );
  const hasDetails = !running && (failed || run !== undefined || Boolean(fallback));
  const renderContent = useCallback(() => {
    if (failed || !run)
      return (
        <p
          data-testid="workflow-status-body"
          className="mb-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground-subtle"
        >
          {failed ? error : fallback}
        </p>
      );
    return <GetWorkflowRunBody display={run} theme={context.theme} />;
  }, [failed, run, error, fallback, context.theme]);
  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ICON}
        showIcon={context.showIcon !== false}
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: running
              ? "chat.toolCall.workflow.getRun.fetching"
              : "chat.toolCall.workflow.getRun.fetched",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        isRunning={running}
        showFailureStatus={failed}
        statusLabel={failed ? failureLabel : undefined}
        statusTooltip={failed ? error : undefined}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        renderContent={hasDetails ? renderContent : undefined}
        title={toolCall.title}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}

function GetWorkflowRunBody({
  display,
  theme,
}: {
  display: ToolCallGetWorkflowRunDisplay;
  theme: ToolCallBlockRenderContext["theme"];
}) {
  const { intl } = useZCodeIntl();
  const terminal =
    display.status === "completed" || display.status === "errored" || display.status === "stopped";
  const stopReason = readWorkflowRunStopReason(display);
  const tokens = intl.formatMessage(
    { id: "chat.toolCall.workflow.run.usage.tokens" },
    { tokens: formatWorkflowTokenCount(display.usage.spentTokens) },
  );
  let json: string | undefined;
  if (display.result !== undefined) {
    try {
      const value: unknown = JSON.parse(display.result);
      if (value !== null && typeof value === "object") json = JSON.stringify(value, null, 2);
    } catch {
      /* Ordinary text results follow the main text layout. */
    }
  }
  const logs = display.logTail
    .map((entry) => {
      // The time when the event is entered in the journal is prefixed with age. If not, only the text is left: the journal before the situation goes online does not have this column.
      // And a made-up "just" is worse than no age at all. Age is always calculated based on the snapshot time.
      const age = formatWorkflowAge(display.generatedAt, entry.at);
      const prefix =
        age === undefined
          ? ""
          : `${intl.formatMessage({ id: "chat.toolCall.workflow.getRun.age" }, { age })}  `;
      return `${prefix}${entry.message}`;
    })
    .filter((line) => line.trim())
    .join("\n");
  return (
    <div className="mb-2 min-w-0 space-y-2" data-testid="workflow-status-body">
      {/*
        That tool-assembled summary comes first: it's the introduction to the entire card, with stage tracks, rosters, and health lines underneath.
        It’s all its unfolding. Old payloads don't have it and the card starts with the first thing (result/error).
      */}
      {display.summary === undefined || display.summary.length === 0 ? null : (
        <p className="break-words text-ui-base text-foreground" data-testid="workflow-run-summary">
          {display.summary}
        </p>
      )}
      {/*
        One of the two ways to "say what you don't know": this session does not hold this run, and the parked question only lives in the memory of the questioning process.
        Invisibility does not mean absence. Silence will be read as "no one is waiting for an answer."
      */}
      {display.health?.pendingQuestionsKnown === false ? (
        <p
          className="break-words text-ui-sm text-warning"
          data-testid="workflow-run-questions-unknown"
        >
          {intl.formatMessage({ id: "chat.toolCall.workflow.getRun.questionsUnknown" })}
        </p>
      ) : null}
      {display.error ? (
        <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base text-destructive">
          {display.error.code}: {display.error.message}
        </p>
      ) : null}
      {display.status === "completed" && display.result ? (
        json ? (
          <CodeBlock
            code={json}
            language="json"
            appTheme={theme}
            className="border border-border bg-card"
            contentClassName="max-h-80 overflow-auto"
            wrapLongLines
          >
            <CodeBlockHeader language="json" className="pl-3 pr-2 pt-2" />
          </CodeBlock>
        ) : (
          <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground">
            {display.result}
          </p>
        )
      ) : null}
      {display.phases === undefined ? null : (
        <WorkflowRunPhaseTrack
          generatedAt={display.generatedAt}
          phases={display.phases}
          terminal={terminal}
        />
      )}
      {display.subagents === undefined ? null : (
        <WorkflowRunSubagentRoster
          generatedAt={display.generatedAt}
          subagents={display.subagents}
        />
      )}
      {display.health === undefined ? null : (
        <WorkflowRunHealthLine
          generatedAt={display.generatedAt}
          health={display.health}
          terminal={terminal}
        />
      )}
      <div className="flex flex-wrap items-center gap-x-2 text-ui-sm text-foreground-subtlest">
        <span className={RUN_STATUS_TEXT[display.status]}>
          {intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${display.status}` })}
        </span>
        {stopReason ? (
          <span data-testid="workflow-run-stop-reason">
            {intl.formatMessage({ id: workflowRunStopReasonMessageId(stopReason) })}
          </span>
        ) : null}
        <span aria-hidden>·</span>
        {!terminal ? (
          <>
            <span>
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.card.steps" },
                {
                  done: display.usage.nodesCompleted + display.usage.nodesFailed,
                  total: display.usage.nodesObserved,
                },
              )}
            </span>
            <span aria-hidden>·</span>
            <span>
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.getRun.runningNodes" },
                { count: display.usage.nodesRunning },
              )}
            </span>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <span>{tokens}</span>
      </div>
      {display.status !== "completed" && logs ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
          {logs}
        </pre>
      ) : null}
      {display.possiblyInterrupted ? (
        <p className="text-ui-sm text-warning">
          {intl.formatMessage({ id: "chat.toolCall.workflow.getRun.interruptedHint" })}
        </p>
      ) : null}
      {display.truncated ? (
        <p className="text-ui-xs text-foreground-subtle">
          {/* The lines that were cut out of this card were roster/stage/log lines, not diagnostics - shared with create_workflow
              "Part of the diagnosis is omitted" will tell you what is wrong. */}
          {intl.formatMessage({ id: "chat.toolCall.workflow.getRun.truncated" })}
        </p>
      ) : null}
    </div>
  );
}
