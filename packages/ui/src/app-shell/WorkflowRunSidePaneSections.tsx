// ============================================================
// Partition subcomponent of WorkflowRunSidePane (state header/final state result area)
// ============================================================
// Unpacked from WorkflowRunSidePane.tsx (eslint max-lines 400 lines): panel file hosting
// Data assembly and interactive wiring, this file hosts a pure display partition. props are all cooked view values - no contact
// Projection, lease or command channel.

import { workflowRunStopReasonMessageId } from "@/components/workflow-graph/run-status-presentation.js";
import { memo, type ReactNode } from "react";
import {
  ArrowUpRightIcon,
  ListIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import type { WorkflowRunState, WorkflowRunUsage } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { workflowRunResultView } from "@/app-shell/workflowRunPanel.js";
import { workflowRunConcurrencyView } from "@/app-shell/workflowRunThrottle.js";
import { WorkflowRunStatus } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowTruncatedNotice } from "@/components/workflow-timeline/WorkflowTruncatedNotice.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";

function formatCount(value: number): string {
  return value.toLocaleString();
}

/**
 * The model segment of the summary line: when the run is configurable it is also a button
 * (underlined on hover) that opens the same "Configure" popover, anchored to itself; otherwise it
 * is a stretch of text with a tooltip.
 */
function SubagentModelSegment({
  children,
  className,
  configureOpen,
  onConfigureFrom,
  title,
}: {
  children: ReactNode;
  className?: string;
  configureOpen: boolean;
  onConfigureFrom?: (element: HTMLElement) => void;
  title: string;
}) {
  if (onConfigureFrom === undefined) {
    return (
      <span className={className} data-testid="workflow-run-subagent-model" title={title}>
        {children}
      </span>
    );
  }
  return (
    <button
      aria-expanded={configureOpen}
      aria-haspopup="dialog"
      className={`${className ?? ""} cursor-pointer rounded-sm text-left underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40`}
      data-testid="workflow-run-subagent-model"
      onClick={(event) => onConfigureFrom(event.currentTarget)}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * Status header: the first row is the name and its controls (Configure, Resume, Stop), the second
 * is the lamp and status word plus the concurrency chip — three buttons crowded next to the status
 * is too much, so the status gets a row of its own. Below it are the lineage row and a summary line
 * carrying the **same copy** as the chat card footer — the same run has to say the same thing on
 * both surfaces. When the summary line's material is absent (the graph is unavailable, so no
 * timeline can be built) it falls back to the existing usage line.
 */
export const WorkflowRunStatusHeader = memo(function WorkflowRunStatusHeader({
  cancellable,
  configureOpen = false,
  onCancel,
  onConfigureFrom,
  onOpenSuccessor,
  onResume,
  rejection,
  resumable,
  run,
  subagentModel,
  summaryParts,
  title,
  usage,
}: {
  cancellable: boolean;
  /**
   * Whether the "Configure" popover is open at this moment (the Configure button and the model
   * segment's aria-expanded).
   */
  configureOpen?: boolean;
  onCancel: () => void;
  /**
   * Opens the "Configure" popover, anchored to the clicked element. Absent means this run cannot be
   * configured: with no Configure button, the model segment is just text.
   */
  onConfigureFrom?: (element: HTMLElement) => void;
  /** Why the most recent Stop / Resume was rejected; `detail` is the diagnostic the ACK carries. */
  rejection?: { text: string; detail?: string };
  /**
   * Opens the successor that replaced this run (`run.supersededBy`); absent when the host cannot
   * resolve the successor, in which case that row is static text.
   */
  onOpenSuccessor?: () => void;
  onResume: () => void;
  resumable: boolean;
  run: WorkflowRunState | undefined;
  /**
   * The subagent model for this run: `name` is the word on screen, `title` holds the effort and the
   * canonical string. The first row of the status header no longer carries a model chip — the model
   * is the first word of the second row, and both the summary line and the degraded usage line
   * start with it. Absent means there is nothing to say.
   */
  subagentModel?: { name: string; title: string };
  /**
   * The segments of the summary line (`workflowSummaryParts`); when absent, falls back to the usage
   * line.
   */
  summaryParts: readonly string[] | undefined;
  title: string;
  usage: WorkflowRunUsage | undefined;
}) {
  const { intl } = useZCodeIntl();
  const cancelLabel = intl.formatMessage({ id: "chat.toolCall.workflow.run.cancel" });
  const resumeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.run.resume" });
  // Concurrent readings: only in actual concurrency
  // (The shared cap is the smaller of this run’s own limit) Be present when pressed below the ceiling; cooling is a deadline,
  // So when there is a cooldown, move the second hand and let it expire on its own.
  const cooldownActive = run?.concurrency?.cooldownMs !== undefined;
  const now = useNowTicker(cooldownActive);
  const concurrency = workflowRunConcurrencyView(run?.concurrency, now);
  // lineage line (status header): the revised run says who it was modified from,
  // The replaced run points to the successor. The two are not mutually exclusive (a revision run may also be replaced), so each has its own line.
  const resumedFrom = run?.resumedFrom;
  const supersededBy = run?.supersededBy;

  return (
    <div className="shrink-0 border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        {/* The run name is an identifier: monospace typography (DESIGN.md reserves font-mono for technical values). */}
        <span className="min-w-0 flex-1 truncate font-mono text-ui-base font-medium text-foreground">
          {title}
        </span>
        {/* Configure comes before Resume / Stop: it opens the "Configure" popover, anchored below this button. */}
        {onConfigureFrom === undefined ? null : (
          <Button
            aria-expanded={configureOpen}
            aria-haspopup="dialog"
            data-testid="workflow-run-configure"
            onClick={(event) => onConfigureFrom(event.currentTarget)}
            size="sm"
            type="button"
            variant="outline"
          >
            <SlidersHorizontalIcon className="size-3.5" />
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.configure" })}
          </Button>
        )}
        {/* Resume renders only when the run is resumable (see the isWorkflowRunResumable predicate): the button's existence is itself the capability gate. */}
        {resumable ? (
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.toolCall.workflow.run.resumeHint" })}
            side="bottom"
          >
            <Button
              aria-label={resumeLabel}
              data-testid="workflow-run-resume"
              onClick={onResume}
              size="sm"
              type="button"
              variant="outline"
            >
              <RotateCcwIcon className="size-3.5" />
              {resumeLabel}
            </Button>
          </ControlHintTooltip>
        ) : null}
        {/* Stop uses the same icon as that button on the card (a solid square): the same action must not
            look different on two surfaces. When it is available the tooltip carries a second line,
            "a stopped run can be resumed" — now that the verb has moved away from "cancel", it has
            to be made clear before the press that this is not a discard; when it is unavailable
            only the reason it is unavailable remains, with no second line to say.
            */}
        <ControlHintTooltip
          title={
            cancellable
              ? cancelLabel
              : intl.formatMessage({ id: "chat.toolCall.workflow.run.cancelDisabled" })
          }
          side="bottom"
          {...(cancellable
            ? { description: intl.formatMessage({ id: "chat.toolCall.workflow.run.stopHint" }) }
            : {})}
        >
          <Button
            aria-label={cancelLabel}
            data-testid="workflow-run-cancel"
            disabled={!cancellable}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            <SquareIcon className="size-3.5 fill-current" />
            {cancelLabel}
          </Button>
        </ControlHintTooltip>
      </div>
      {/* Second row: lamp and status word plus the concurrency chip. When the run is not in the projection neither is present, and the whole row is absent. */}
      {run === undefined && concurrency === undefined ? null : (
        <div
          className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2"
          data-testid="workflow-run-status-row"
        >
          {run ? <WorkflowRunStatus run={run} testId="workflow-run-status" /> : null}
          {/* "Concurrency 4": how many subagents this run can really have in flight right now — the
            governor has pushed the shared bucket below the ceiling, or the user set a smaller limit
            for this run. This is where the reason a run slows down sits, visible at a glance. The
            whole block is absent when running at the ceiling (there is nothing to say). Same shape
            as the status badge (border+text) with the activity color: this is the runtime
            throttling, not a failure.
            */}
          {concurrency === undefined ? null : (
            <span
              className="shrink-0 rounded-xs border border-warning/60 px-1.5 py-0.5 font-mono text-ui-xs leading-none text-warning"
              data-testid="workflow-run-concurrency"
            >
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.run.concurrency.label" },
                { cap: String(concurrency.cap) },
              )}
              {concurrency.cooldownUntil === undefined
                ? null
                : ` · ${intl.formatMessage(
                    { id: "chat.toolCall.workflow.run.concurrency.cooldown" },
                    { time: new Date(concurrency.cooldownUntil).toLocaleTimeString() },
                  )}`}
            </span>
          )}
        </div>
      )}

      {/* Rejected Stop / Resume: one sentence plus an optional diagnostic. warning rather than destructive — nothing happened, nothing is broken. */}
      {rejection === undefined ? null : (
        <div
          className="mt-1.5 text-ui-xs text-warning"
          data-testid="workflow-run-rejection"
          role="status"
        >
          <span>{rejection.text}</span>
          {rejection.detail === undefined ? null : (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
              {rejection.detail}
            </pre>
          )}
        </div>
      )}

      {resumedFrom === undefined ? null : (
        <div
          className="mt-1.5 flex min-w-0 items-baseline gap-2 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-amends"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.amends" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={resumedFrom}>
            {resumedFrom}
          </span>
        </div>
      )}
      {supersededBy === undefined ? null : onOpenSuccessor === undefined ? (
        <div
          className="mt-1.5 flex min-w-0 items-baseline gap-2 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-superseded-by"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.supersededBy" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={supersededBy}>
            {supersededBy}
          </span>
        </div>
      ) : (
        <button
          className="mt-1.5 flex min-w-0 cursor-pointer items-baseline gap-2 rounded-md text-left text-ui-xs text-foreground-subtle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="workflow-run-superseded-by"
          onClick={onOpenSuccessor}
          type="button"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.supersededBy" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={supersededBy}>
            {supersededBy}
          </span>
          <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 self-center" />
        </button>
      )}

      {summaryParts !== undefined ? (
        <div
          className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
          data-testid="workflow-run-usage"
        >
          <ListIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
          {summaryParts.map((part, i) => (
            <span className="flex items-center gap-x-2 tabular-nums" key={i}>
              {i > 0 ? (
                <span aria-hidden className="text-foreground-subtlest">
                  ·
                </span>
              ) : null}
              {i === 0 && subagentModel !== undefined ? (
                <SubagentModelSegment
                  configureOpen={configureOpen}
                  title={subagentModel.title}
                  {...(onConfigureFrom === undefined ? {} : { onConfigureFrom })}
                >
                  {part}
                </SubagentModelSegment>
              ) : (
                <span>{part}</span>
              )}
            </span>
          ))}
        </div>
      ) : usage ? (
        // Usage is an observation surface, there is no upper limit to use as the denominator: one line "Usage: N tokens · M steps", no progress track is drawn
        <div
          className="mt-2 flex items-baseline justify-between gap-2"
          data-testid="workflow-run-usage"
        >
          {/* When the graph is unavailable the whole summary line is absent, but the model must not
              disappear along with it — it is a condition the user set for this run, independent of
              whether a graph exists. So it leads here too, with the same word and the same tooltip
              as the summary line.
              */}
          <span className="flex min-w-0 items-baseline gap-2">
            {subagentModel === undefined ? null : (
              <SubagentModelSegment
                className="min-w-0 truncate text-ui-xs text-foreground-subtle"
                configureOpen={configureOpen}
                title={subagentModel.title}
                {...(onConfigureFrom === undefined ? {} : { onConfigureFrom })}
              >
                {intl.formatMessage(
                  { id: "chat.toolCall.workflow.run.subagentModel.label" },
                  { model: subagentModel.name },
                )}
              </SubagentModelSegment>
            )}
            <span className="shrink-0 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.workflow.run.usage.label" })}
            </span>
          </span>
          <span className="font-mono text-ui-xs tabular-nums text-foreground">
            {intl.formatMessage(
              { id: "chat.toolCall.workflow.run.usage.value" },
              { tokens: formatCount(usage.spentTokens), steps: usage.nodesUsed },
            )}
          </span>
        </div>
      ) : null}
      {/* The "showing details for n/m steps" line under the summary line shares its implementation
          with the card: the spine lists the instances the instance table kept, while the numbers in
          the row already count the ones outside the table — this line says exactly that difference.
          */}
      <WorkflowTruncatedNotice className="mt-1.5" run={run} testId="workflow-run-truncated" />
    </div>
  );
});

/**
 * Terminal-state area: untraceable notice / completion artifact preview / error panel for failures
 * and cancellations. Each is absent when the run is not in the corresponding terminal state.
 */
export const WorkflowRunResultSections = memo(function WorkflowRunResultSections({
  result,
}: {
  result: ReturnType<typeof workflowRunResultView>;
}) {
  const { intl } = useZCodeIntl();

  return (
    <>
      {/* Run not in the projection: a CLI from before eviction or cold start. The wording only says "live state is gone" and never implies the run disappeared. */}
      {result.kind === "absent" ? (
        <div
          className="shrink-0 border-b border-border px-4 py-3"
          data-testid="workflow-run-untracked"
        >
          <div className="text-ui-base text-foreground">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.untracked.title" })}
          </div>
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.untracked.body" })}
          </p>
        </div>
      ) : null}

      {/* Result / failure panel */}
      {result.kind === "completed" ? (
        <div
          className="shrink-0 border-b border-border px-4 py-3"
          data-testid="workflow-run-result"
        >
          <div className="text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.result.title" })}
          </div>
          {result.preview === undefined ? (
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.workflow.run.result.completedHint" })}
            </p>
          ) : (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs text-foreground">
              {result.preview}
            </pre>
          )}
        </div>
      ) : null}

      {result.kind === "error" ? (
        <div
          className="shrink-0 border-b border-destructive/40 px-4 py-3"
          data-testid="workflow-run-error"
        >
          <div className="text-ui-xs font-medium text-destructive">
            {intl.formatMessage({
              id:
                result.status === "stopped"
                  ? "chat.toolCall.workflow.run.result.stoppedTitle"
                  : "chat.toolCall.workflow.run.result.erroredTitle",
            })}
            {result.status === "stopped" && result.stopReason ? (
              <span
                className="font-normal text-foreground-subtle"
                data-testid="workflow-run-stop-reason"
              >
                {" · "}
                {intl.formatMessage({ id: workflowRunStopReasonMessageId(result.stopReason) })}
              </span>
            ) : null}
          </div>
          {/*
            What the projection writes into `error` is `WorkflowErrorJson.message` — the run-settled
            branch of product-projection.ts takes only `.message` (`code` is dropped), and those
            engine messages are short human phrases:
            "Run stopped.", "The typed ask ended without a submit_result call, so there is no
            result.", "This run already reported 256 items, the maximum." So this is typeset as body
            copy rather than as a monospace code block (DESIGN.md reserves font-mono for
            paths/commands/code/identifiers/terminal data). pre-wrap is kept so that a message that
            does carry newlines is not collapsed away.
            There is no `code` to give here, and the panel no longer has a second landing spot for
            one: the event-log area has been removed, and the structured payload lives only in the
            journal — its readers are the model and the CLI, not the person sitting in front of this
            panel.
          */}
          <p
            className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground"
            data-testid="workflow-run-error-message"
          >
            {result.message ??
              intl.formatMessage({ id: "chat.toolCall.workflow.run.result.noError" })}
          </p>
        </div>
      ) : null}
    </>
  );
});
