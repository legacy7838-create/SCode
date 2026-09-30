// Workflow run row under the sidebar task row heading:
// Workflow icon + mini track light + current phase name. Understand at a glance "this session is running the workflow and which station it is running to".
// Nothing else is drawn: no halo, no dashed line of travel, no question chip (the upgrade Q&A is answered by the main agent, not the user),
// No subagents, no arrows - those go into the hover tooltip. The run ends with only one neutral word, and the color is left only for the lights.
import { useEffect, useMemo, type MouseEvent } from "react";
import { Workflow } from "lucide-react";
import type {
  SessionWorkflowActivity,
  SessionWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { isSessionWorkflowRunLive } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  STATUS_DOT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { getWorkflowRunAckStore, useWorkflowRunAcknowledged } from "@/lib/workflowRunAckStore.js";
import {
  foldWorkflowRunRail,
  selectWorkflowRunLines,
  settledWorkflowRunIds,
  workflowRunParallelPhaseLabel,
  type WorkflowRunRail,
} from "@/lib/workflowRunLine.js";
import { useWorkflowRunOpen } from "@/v4/workflowRunOpenContext.js";

export interface TaskWorkflowRunLinesIntl {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}

interface TaskWorkflowRunLinesProps {
  activity: SessionWorkflowActivity | undefined;
  /** Whether the session is being opened: when true acknowledges all its completed runs (ending lines are collapsed). */
  isActive: boolean;
  intl: TaskWorkflowRunLinesIntl;
  /** Click on the session address required to open the run pane; the run line is not a button when absent (mobile homepage). */
  session?: { workspacePath: string; workspaceIdentity?: string; sessionId: string };
  /** compact = mobile phone remote control line (24px, smaller font size). */
  density?: "default" | "compact";
  className?: string;
}

const TRACE_FAINT = "var(--color-workflow-trace)";
const TRACE_STRONG = "var(--color-workflow-trace-strong)";
const SEPARATOR = " · ";

function RunRail({ rail, intl }: { rail: WorkflowRunRail; intl: TaskWorkflowRunLinesIntl }) {
  if (rail.implicit) {
    return (
      <span
        data-workflow-run-rail="true"
        data-implicit="true"
        className="flex shrink-0 items-center"
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT.running)} />
      </span>
    );
  }
  return (
    <span data-workflow-run-rail="true" className="flex shrink-0 items-center">
      {rail.stations.map((station, index) => (
        <span key={`${station.name}:${index}`} className="flex items-center">
          {index > 0 ? (
            station.twin === true ? (
              // Double line segment: This station is parallel to the previous station, and the control flow does not go from that station to this station. Two 1px lines 2px apart
              // (Container 4px, one above and below), the width and ink color rules are exactly the same as ordinary paragraphs.
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                data-rail-twin="true"
                className="flex h-1 w-1.5 flex-col justify-between"
              >
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
              </span>
            ) : (
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                className="h-px w-1.5"
                style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
              />
            )
          ) : null}
          <span
            aria-hidden="true"
            data-rail-station={station.status}
            title={station.name}
            className={cn("size-1.5 rounded-full", STATUS_DOT[station.status])}
          />
        </span>
      ))}
      {rail.hidden > 0 ? (
        <span className="ml-1 text-ui-xs leading-none text-foreground-subtlest">
          {intl.formatMessage(
            { id: "taskList.workflowRun.moreStations" },
            { count: String(rail.hidden) },
          )}
        </span>
      ) : null}
    </span>
  );
}

function runStatusWord(run: SessionWorkflowRunSummary, intl: TaskWorkflowRunLinesIntl): string {
  return intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${run.status}` });
}

/** Words on the line: running → current phase name (phaseless vocabulary → "Workflow"); end → neutral word (+ phase / reason). */
function runLineText(
  run: SessionWorkflowRunSummary,
  rail: WorkflowRunRail,
  intl: TaskWorkflowRunLinesIntl,
): string {
  if (isSessionWorkflowRunLive(run.status)) {
    if (rail.implicit) {
      return intl.formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
    }
    return run.currentPhase ?? runStatusWord(run, intl);
  }
  const word = runStatusWord(run, intl);
  if (run.status === "errored" && run.currentPhase !== undefined) {
    return `${word}${SEPARATOR}${run.currentPhase}`;
  }
  const reason = readWorkflowRunStopReason(run);
  if (reason !== undefined) {
    return `${word}${SEPARATOR}${intl.formatMessage({ id: workflowRunStopReasonMessageId(reason) })}`;
  }
  return word;
}

function runName(run: SessionWorkflowRunSummary, intl: TaskWorkflowRunLinesIntl): string {
  return run.name ?? intl.formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
}

/** The second line of tooltip: `{phase} · {n agents working} · {elapsed}`, the missing paragraphs are omitted. */
function runTooltipDescription(
  run: SessionWorkflowRunSummary,
  intl: TaskWorkflowRunLinesIntl,
): string | undefined {
  const parts: string[] = [];
  // When running in parallel, the "current stage" is no longer one station: several stations running at the same time are listed side by side, and no one is more current than the other.
  const parallel = workflowRunParallelPhaseLabel(run.phases);
  if (parallel !== undefined) parts.push(parallel);
  else if (run.currentPhase !== undefined) parts.push(run.currentPhase);
  if (isSessionWorkflowRunLive(run.status) && run.agentsWorking > 0) {
    parts.push(
      intl.formatMessage(
        { id: "chat.toolCall.workflow.card.agentsWorking" },
        { count: String(run.agentsWorking) },
      ),
    );
  }
  if (run.startedAt !== undefined) parts.push(formatTaskRelativeTime(run.startedAt, intl));
  return parts.length === 0 ? undefined : parts.join(SEPARATOR);
}

export function TaskWorkflowRunLines({
  activity,
  isActive,
  intl,
  session,
  density = "default",
  className,
}: TaskWorkflowRunLinesProps) {
  const isAcknowledged = useWorkflowRunAcknowledged();
  const openRun = useWorkflowRunOpen();
  const settledKey = settledWorkflowRunIds(activity).join(" ");
  // Opening a session = acknowledging all completed runs in it at the moment; the completion of a run while the session remains open is also immediately acknowledged (collapsed before the reader's eyes).
  useEffect(() => {
    if (!isActive || settledKey.length === 0) return;
    getWorkflowRunAckStore().acknowledge(settledKey.split(" "));
  }, [isActive, settledKey]);
  const selection = useMemo(
    () => selectWorkflowRunLines(activity, isAcknowledged),
    [activity, isAcknowledged],
  );
  if (selection.lines.length === 0) return null;
  const interactive = openRun !== null && session !== undefined;
  const compact = density === "compact";

  return (
    <div
      data-workflow-run-lines="true"
      className={cn("flex min-w-0 max-w-full flex-col items-start", className)}
    >
      {selection.lines.map((run) => {
        const rail = foldWorkflowRunRail(run.phases);
        const text = runLineText(run, rail, intl);
        const name = runName(run, intl);
        const statusWord = runStatusWord(run, intl);
        const ariaLabel = intl.formatMessage(
          { id: "taskList.workflowRun.ariaLabel" },
          { name, status: statusWord },
        );
        const content = (
          <>
            <Workflow aria-hidden="true" className="size-3 shrink-0 text-foreground-subtle" />
            <RunRail rail={rail} intl={intl} />
            <span className="min-w-0 truncate">{text}</span>
          </>
        );
        const lineClassName = cn(
          "flex min-w-0 max-w-full items-center gap-1.5 rounded-md text-foreground-subtle",
          compact ? "h-6 text-ui-sm" : "h-5 text-ui-sm",
          interactive && "-ml-1 px-1 hover:bg-surface-hover hover:text-foreground",
        );
        const lineProps = {
          "data-workflow-run-line": "true",
          "data-run-id": run.runId,
          "data-run-status": run.status,
          className: lineClassName,
        };
        const line =
          interactive && session !== undefined && openRun !== null ? (
            <button
              type="button"
              {...lineProps}
              aria-label={ariaLabel}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                // The row itself can also be clicked (selecting the session); the running row is a more specific landing point, preventing the click from bubbling up into a normal selection.
                event.preventDefault();
                event.stopPropagation();
                openRun({
                  workspacePath: session.workspacePath,
                  ...(session.workspaceIdentity
                    ? { workspaceIdentity: session.workspaceIdentity }
                    : {}),
                  sessionId: session.sessionId,
                  run,
                });
              }}
            >
              {content}
            </button>
          ) : (
            <span {...lineProps} aria-label={ariaLabel}>
              {content}
            </span>
          );
        const description = runTooltipDescription(run, intl);
        return (
          <ControlHintTooltip
            key={run.runId}
            title={`${name}${SEPARATOR}${statusWord}`}
            {...(description === undefined ? {} : { description })}
            side="right"
            align="center"
          >
            {line}
          </ControlHintTooltip>
        );
      })}
      {selection.overflow > 0 ? (
        <span
          data-workflow-run-overflow={String(selection.overflow)}
          className={cn("text-foreground-subtlest", compact ? "h-6 text-ui-sm" : "h-5 text-ui-xs")}
        >
          {intl.formatMessage(
            { id: "taskList.workflowRun.moreRuns" },
            { count: String(selection.overflow) },
          )}
        </span>
      ) : null}
    </div>
  );
}
