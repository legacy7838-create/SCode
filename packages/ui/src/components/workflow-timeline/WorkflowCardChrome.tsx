import type { ReactNode } from "react";
import { ChevronRightIcon, ListIcon, Maximize2Icon, Workflow } from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
  STATUS_DOT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
  isWorkflowRunSuperseded,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * The header and footer of a workflow card.
 *
 * It does not go through `ToolLayout`: that one's summary row is `inline-flex self-start`, which
 * cannot hold a right-aligned status cluster. The header is one row: icon + kind word + name, with
 * lamp + status word + monospace detail + [⤢] + chevron on the right. When the station count
 * exceeds one column there is no longer a rank band: the stations that cannot be seen sit on the
 * timeline's own eaves.
 */
export const WORKFLOW_CARD_ICON = <Workflow className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * The kind word once a run is joined: the same run must be called the same thing on the card, in
 * the turn-tail summary, in notifications, and on the details page.
 */
export const WORKFLOW_RUN_KIND_ID: Record<WorkflowRunState["status"], string> = {
  pending: "chat.toolCall.workflow.card.started",
  running: "chat.toolCall.workflow.card.running",
  completed: "chat.toolCall.workflow.card.completed",
  errored: "chat.toolCall.workflow.card.errored",
  stopped: "chat.toolCall.workflow.card.stopped",
};
/**
 * The neutral kind word for a run that is not in the live projection (evicted by the eight-entry
 * cap / no journal hit on a cold restore): the card only says "a run was here once", it does not
 * impersonate some terminal state.
 */
export const WORKFLOW_RUN_ENDED_KIND_ID = "chat.toolCall.workflow.card.ended";

/** The kind word for a run that was superseded by a revision. */
export const WORKFLOW_RUN_SUPERSEDED_KIND_ID = "chat.toolCall.workflow.card.superseded";

/**
 * The single entry point for the kind word: stopped ∧ superseded says "Workflow superseded",
 * everything else looks up a table by status. All three consumers (the card, the turn-tail summary,
 * the legacy host run card) go through here, otherwise the same superseded run would be called
 * "Workflow stopped" in one place and "Workflow superseded" in another.
 */
export function workflowRunKindMessageId(run: {
  status: WorkflowRunState["status"];
  stopReason?: unknown;
}): string {
  return isWorkflowRunSuperseded(run)
    ? WORKFLOW_RUN_SUPERSEDED_KIND_ID
    : WORKFLOW_RUN_KIND_ID[run.status];
}

/** Run-level status: lamp + word, always appearing as a pair (invariant 3). */
export function WorkflowRunStatus({
  className,
  status,
  run,
  testId,
}: {
  /** Falls back to `run.status` when absent (at least one of the two is supplied). */
  status?: WorkflowRunState["status"];
  /**
   * The source object that carries `stopReason` (projected run / joined summary): when `stopped`,
   * the reason word follows the status word. Read structurally, not bound to one protocol type.
   *
   * `resumable` is a **status bit**; it arrives with the run from the CLI, and when it is present
   * and true one more word is added after the reason word. The UI never infers it from status —
   * "Stopped" does not imply resumable.
   */
  run?:
    | { status: WorkflowRunState["status"]; stopReason?: unknown; resumable?: unknown }
    | undefined;
  className?: string;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const effectiveStatus = status ?? run?.status ?? "pending";
  const reason =
    run === undefined ? undefined : readWorkflowRunStopReason({ ...run, status: effectiveStatus });
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", className)}>
      <span
        aria-hidden
        className={cn("wf-lamp size-2 shrink-0 rounded-full", RUN_STATUS_DOT[effectiveStatus])}
      />
      {/* The status word swaps by value: the old word exits, the new word enters. */}
      <span
        className={cn("wf-swap text-ui-sm", RUN_STATUS_TEXT[effectiveStatus])}
        data-testid={testId}
        key={effectiveStatus}
      >
        {intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${effectiveStatus}` })}
      </span>
      {reason ? (
        <span
          className="text-ui-sm text-foreground-subtlest"
          data-testid={testId ? `${testId}-reason` : undefined}
        >
          · {intl.formatMessage({ id: workflowRunStopReasonMessageId(reason) })}
        </span>
      ) : null}
      {/*
          The third word: this run can still keep going. The verb "Stop" only states the action, it
          cannot state the consequence — putting the consequence back on the status row spares the
          user from having to open the details page first to find out that they have not lost
          anything.
          */}
      {run?.resumable === true ? (
        <span
          className="text-ui-sm text-foreground-subtlest"
          data-testid={testId ? `${testId}-resumable` : undefined}
        >
          · {intl.formatMessage({ id: "chat.toolCall.workflow.run.resumable" })}
        </span>
      ) : null}
    </span>
  );
}

/** The static (not yet joined to a run) status: an empty ring lamp + one word ("compiled"). */
export function WorkflowStaticStatus({ word }: { word: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT.pending)} />
      <span className="text-ui-sm text-foreground-subtle" data-testid="workflow-card-static-status">
        {word}
      </span>
    </span>
  );
}

export function WorkflowCardHeader({
  detail,
  detailTitle,
  expanded,
  kind,
  leading,
  live = false,
  name,
  onOpenDetails,
  onToggle,
  status,
  toggleLabel: toggleLabelOverride,
  trailing,
}: {
  /**
   * The kind word; when it is a string the word is swapped by its text (a change of text remounts,
   * playing wf-swap).
   */
  kind: ReactNode;
  name: string;
  /** The sweep light on the running kind word (the same expression as ToolLayout's isRunning). */
  live?: boolean;
  status?: ReactNode;
  detail?: string;
  /**
   * The detail string's tooltip; supplied only when the sub-agent model is present (the rules for
   * it are pinned here).
   */
  detailTitle?: string;
  /** The slot before the status (the turn-tail summary's pending-question chip). */
  leading?: ReactNode;
  /** The slot after the detail and before ⤢ (the turn-tail summary puts Resume into the header). */
  trailing?: ReactNode;
  onOpenDetails?: () => void;
  expanded: boolean;
  /** Absent means not collapsible (forceOpen / canToggle=false). */
  onToggle?: () => void;
  /**
   * The chevron's accessible name; when absent it is the tool card's "Expand tool details" /
   * "Collapse tool details".
   */
  toggleLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const openLabel = intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" });
  const toggleLabel =
    toggleLabelOverride ??
    intl.formatMessage({
      id: expanded ? "chat.toolCall.collapseDetails" : "chat.toolCall.expandDetails",
    });
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-ui-base"
      data-testid="workflow-card-header"
    >
      {WORKFLOW_CARD_ICON}
      {/*
          The kind word swaps by text (key=text; the old word exits, the new word enters). The
          word-swapping wf-swap must wrap the sweep light's animated-gradient-text from the
          **outside**: background-clip:text only clips the text of its own layer, and once a child
          element is promoted to its own layer by a transform/opacity animation the text becomes
          transparent — leaving a blank stretch in the header.
          */}
      <span className="shrink-0 whitespace-nowrap font-medium" data-testid="workflow-card-kind">
        <span className="wf-swap" key={typeof kind === "string" ? kind : undefined}>
          <span className={live ? "animated-gradient-text" : "text-foreground"}>{kind}</span>
        </span>
      </span>
      <span
        // The name is UI text; the tool summary and card headers shared by states such as Cancel are all modified in the same way.
        className="min-w-0 flex-1 truncate text-foreground-subtle"
        data-testid="workflow-card-name"
        title={name}
      >
        {name}
      </span>
      {/*
          The right cluster is compressible, and inside the cluster only the detail string yields:
          chips, the status, and the buttons are all shrink-0 (inherited from the Button base
          class), while the detail string is min-w-0 + truncate, so all the negative space lands on
          it and Configure / Stop / ⤢ stay inside the card. The cluster's min-w-0 is required — do
          not mistake it for redundancy and delete it: a flex item's automatic minimum size equals
          its min-content, and truncate's `white-space:nowrap` makes the detail string's min-content
          the full width of the string — neither `overflow:hidden` nor the child's min-w-0 computes
          it smaller. Without the cluster's min-w-0 the cluster's floor is "the whole detail string
          + the buttons"; it will not shrink by a single pixel and the buttons still get pushed out
          of the card (the cause of this fix). Measured in a real browser (narrowing the card width
          step by step): before the fix the buttons overflowed from 520px upward; after the fix
          there is zero overflow above 290px, and 380px with a pending-question chip — the chip is
          shrink-0 too, which raises the floor as a whole.
          */}
      <span className="flex min-w-0 items-center gap-2">
        {leading}
        {status}
        {detail === undefined || detail.length === 0 ? null : (
          <span
            className="min-w-0 truncate text-ui-base tabular-nums text-foreground-subtlest"
            data-testid="workflow-card-detail"
            {...(detailTitle === undefined ? {} : { title: detailTitle })}
          >
            {detail}
          </span>
        )}
        {trailing}
        {onOpenDetails === undefined ? null : (
          <ControlHintTooltip title={openLabel} side="top">
            <Button
              aria-label={openLabel}
              data-testid="workflow-card-open-details"
              onClick={onOpenDetails}
              size="icon-md"
              type="button"
              variant="ghost"
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        )}
        {onToggle === undefined ? null : (
          <Button
            aria-expanded={expanded}
            aria-label={toggleLabel}
            data-testid="workflow-card-toggle"
            onClick={onToggle}
            size="icon-md"
            type="button"
            variant="ghost"
          >
            <ChevronRightIcon
              className={cn("size-4 transition-transform", expanded && "rotate-90")}
            />
          </Button>
        )}
      </span>
    </div>
  );
}

/**
 * The footer summary row: lamp + status word + list icon + segments separated by `·` + a trailing
 * control (Resume in the failed state).
 */
export function WorkflowCardFooter({
  parts = [],
  status,
  trailing,
}: {
  status: WorkflowRunState["status"];
  /**
   * The summary's segments; when absent or empty only the lamp, the status word, and trailing are
   * drawn.
   */
  parts?: readonly string[];
  trailing?: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
      data-testid="workflow-card-footer"
    >
      <WorkflowRunStatus status={status} />
      {parts.length > 0 ? (
        <>
          <ListIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 tabular-nums">
            {parts.map((part, i) => (
              <span className="flex items-center gap-x-2" key={i}>
                {i > 0 ? (
                  <span aria-hidden className="text-foreground-subtlest">
                    ·
                  </span>
                ) : null}
                <span>{part}</span>
              </span>
            ))}
          </span>
        </>
      ) : null}
      {trailing}
    </div>
  );
}
