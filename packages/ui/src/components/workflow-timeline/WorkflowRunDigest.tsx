import { useMemo, useState } from "react";
import {
  MessageCircleQuestionIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import { TID_CHAT_WORKFLOW_RUN_DIGEST, testId } from "@zcode/shared";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { buildWorkflowTimeline, type TimelinePill } from "./timeline-model.js";
import { workflowCardDetail } from "./timeline-summary.js";
import {
  WORKFLOW_RUN_ENDED_KIND_ID,
  WorkflowCardHeader,
  workflowRunKindMessageId,
} from "./WorkflowCardChrome.js";
import { WorkflowArtifactStrip } from "./WorkflowArtifactStrip.js";
import {
  useWorkflowRunSettingsPopoverState,
  WorkflowRunSettingsPopover,
  type WorkflowRunSettingsHost,
} from "./WorkflowRunSettingsPopover.js";
import { timelineHeight, WorkflowTimeline } from "./WorkflowTimeline.js";
import { WorkflowTruncatedNotice } from "./WorkflowTruncatedNotice.js";

/**
 * The run card below is expanded by default, with no arrow but still collapsible; the state is
 * conveyed by the title.
 */
export interface WorkflowRunDigestProps {
  name: string;
  runId: string;
  /**
   * The spawn graph of that run (looked up by the spawning toolCallId); when absent the phase line
   * cannot be drawn (the row window carries no spawn row).
   */
  graph: WorkflowCausalityGraphData | undefined;
  /**
   * The joint summary in the live projection. Absent = the run is not in the projection (evicted by
   * the eight-entry cap / no journal hit on cold restore): the card degrades to a neutral single
   * line — the kind word “Workflow ended”, no lamp, no rail, no Cancel / Resume, only ⤢ (the side
   * panel will say “No longer tracked live”).
   */
  summary: WorkflowRunCardSummary | undefined;
  /**
   * The number of pending questions parked on that run; when > 0 a warning-colored chip appears in
   * the header.
   */
  pendingQuestions?: number;
  /**
   * Open the run details; when absent there is no ⤢, the chip is not clickable and the "n more" row
   * is static. With `landing` the details page lands on that station: only that row carries it,
   * while ⤢ and the question chip open the whole run.
   */
  onOpenRun?: (landing?: { phaseId: string }) => void;
  /** Resume the run; Resume is rendered only when `summary.resumable` and the callback is present. */
  onResume?: () => void;
  /**
   * Stop the run; Stop is rendered only while running and when the callback is present, occupying
   * the same slot as Resume — two mutually exclusive states, so the user already sees the run's two
   * ways out from the card.
   */
  onCancel?: () => void;
  /** Click a pill to open that subagent's transcript; when absent the pill is not clickable. */
  onOpenPill?: (pill: TimelinePill) => void;
  /**
   * Click a script pill to open the script transcript and land on that station; when absent the
   * script pill is not clickable.
   */
  onOpenWorkspace?: (pill: TimelinePill) => void;
  /** Click an artifact pill to open the artifact tab; when absent the artifact pill is disabled. */
  onOpenArtifact?: (artifactId: string) => void;
  /**
   * providerId → provider name (supplied by the host from the session's model manifest, see
   * useWorkflowSubagentModelProviderName). When absent the composed name falls back to the bare
   * modelId — **providerId is never shown** (on a team plan it is a UUID).
   */
  subagentModelProviderName?: (providerId: string) => string | undefined;
  /**
   * The host of the “Configure” popover. When present the header has a Configure button — the host
   * gives it one only when the callback is present and the run is configurable.
   */
  settingsHost?: WorkflowRunSettingsHost;
  /** testid suffix (unit.key + toolCallId). */
  testIdKey: string;
}

export function WorkflowRunDigest({
  graph,
  name,
  onOpenArtifact,
  onOpenPill,
  onOpenRun,
  onOpenWorkspace,
  onResume,
  onCancel,
  pendingQuestions = 0,
  runId,
  settingsHost,
  subagentModelProviderName,
  summary,
  testIdKey,
}: WorkflowRunDigestProps) {
  const { intl } = useZCodeIntl();
  const run = summary?.run;
  const [expanded, setExpanded] = useState(true);

  // The stage line is only drawn when there is a live projection and a picture: pictures without projection are all pending lights, and a completed run will be drawn as if it has not been run.
  const model = useMemo(
    () =>
      graph !== undefined && graph.steps.length > 0 && run !== undefined
        ? buildWorkflowTimeline(graph, run)
        : undefined,
    [graph, run],
  );
  const hasRail = model !== undefined && model.stations.length > 0;
  const shown = useMemo(
    () =>
      expanded || !model
        ? model
        : {
            ...model,
            stations: model.stations.map((station) => ({ ...station, pills: [] })),
          },
    [expanded, model],
  );
  // Removing the arrow does not mean unfolding. Only the blank area switches and the child controls continue to perform their respective operations.
  const hitsControl = (target: EventTarget | null, root: HTMLElement) => {
    const control =
      target instanceof Element
        ? target.closest("button, a, input, textarea, select, [role='button']")
        : null;
    return control !== null && control !== root;
  };

  const format = intl.formatMessage.bind(intl);
  // Lineage is intentionally not drawn on the card:
  // The two sentences "Adjusted from/has been replaced" are only said on the details page and confirmation window; the card only changes the category words - the card is too noisy.
  // The last paragraph of the details string is the subagent model name (this paragraph will not exist if the model is not specified), and the strength and specifications are stringed into the tooltip.
  const cardDetail = workflowCardDetail(format, model, graph, run, subagentModelProviderName);
  const live = summary?.status === "running";
  const kind = format({
    id: summary === undefined ? WORKFLOW_RUN_ENDED_KIND_ID : workflowRunKindMessageId(summary),
  });
  const questionsLabel =
    pendingQuestions > 0
      ? format(
          {
            id:
              pendingQuestions === 1
                ? "chat.toolCall.workflow.digest.question"
                : "chat.toolCall.workflow.digest.questions",
          },
          { count: pendingQuestions },
        )
      : undefined;
  const questions =
    questionsLabel === undefined ? undefined : onOpenRun === undefined ? (
      <span
        className="wf-arrive flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning"
        data-testid="workflow-digest-questions"
      >
        <MessageCircleQuestionIcon aria-hidden className="size-3" />
        {questionsLabel}
      </span>
    ) : (
      <button
        className="wf-arrive flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning outline-none transition-colors hover:bg-[color-mix(in_oklab,var(--color-warning)_20%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/40"
        data-testid="workflow-digest-questions"
        onClick={() => onOpenRun()}
        type="button"
      >
        <MessageCircleQuestionIcon aria-hidden className="size-3" />
        {questionsLabel}
      </button>
    );
  const resume =
    summary?.resumable === true && onResume !== undefined ? (
      <Button
        data-testid="workflow-digest-resume"
        onClick={onResume}
        size="default"
        type="button"
        variant="outline"
      >
        <RotateCcwIcon className="size-3.5" />
        {format({ id: "chat.toolCall.workflow.run.resume" })}
      </Button>
    ) : undefined;
  // Stop and Resume are mutually exclusive (running vs stopped) and share the same position on the right side of the header. Run the same command on the details page.
  // After clicking Stop, the button enters the disabled "Stop..." state until the projection changes the state: press the status key to re-hang, and the state changes
  // The button is new (the same goes for canceled → resume and then running). Reset used to be run by pressing status
  // effect setState, each state change is updated after the synchronous submission of the projection frame - crashes with workflow card React #185
  // The throwing point is the same; there is no second submission for keyed rehang.
  const cancel =
    live && onCancel !== undefined ? (
      <CancelRunButton key={summary?.status} onCancel={onCancel} />
    ) : undefined;
  // Configure is ranked before Resume / Stop and is in the same position in each state, so it never moves ⤢ whether it appears or not.
  const configure =
    settingsHost !== undefined && run !== undefined ? (
      <ConfigureRunButton host={settingsHost} run={run} />
    ) : undefined;

  return (
    <section
      aria-label={kind}
      className={cn(
        "wf-motion wf-arrive flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-2 pt-1.5 outline-none",
        hasRail && "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-expanded={hasRail ? String(expanded) : undefined}
      data-testid={testId(TID_CHAT_WORKFLOW_RUN_DIGEST, testIdKey)}
      data-workflow-run-digest="true"
      data-workflow-run-id={runId}
      data-workflow-run-status={summary?.status ?? "absent"}
      role={hasRail ? "button" : undefined}
      tabIndex={hasRail ? 0 : undefined}
      aria-expanded={hasRail ? expanded : undefined}
      onClick={(event) => {
        if (hasRail && !hitsControl(event.target, event.currentTarget))
          setExpanded((value) => !value);
      }}
      onKeyDown={(event) => {
        if (
          !hasRail ||
          hitsControl(event.target, event.currentTarget) ||
          (event.key !== "Enter" && event.key !== " ")
        )
          return;
        event.preventDefault();
        setExpanded((value) => !value);
      }}
    >
      <WorkflowCardHeader
        detail={cardDetail?.detail}
        {...(cardDetail?.title === undefined ? {} : { detailTitle: cardDetail.title })}
        expanded={expanded}
        kind={kind}
        leading={questions}
        live={live}
        name={name}
        trailing={
          configure === undefined ? (
            (resume ?? cancel)
          ) : (
            <>
              {configure}
              {resume ?? cancel}
            </>
          )
        }
        {...(onOpenRun === undefined ? {} : { onOpenDetails: () => onOpenRun() })}
      />
      {shown === undefined || !hasRail ? null : (
        // When collapsed, only the agent is hidden, leaving the stage line as an overview of the run's progress.
        <div
          className={cn("wf-digest-plot overflow-hidden")}
          data-testid="workflow-digest-plot"
          style={{ height: timelineHeight(shown) + 8 }}
        >
          <WorkflowTimeline
            className="py-1"
            model={shown}
            {...(onOpenPill === undefined ? {} : { onOpenPill })}
            {...(onOpenWorkspace === undefined ? {} : { onOpenWorkspace })}
            {...(onOpenRun === undefined
              ? {}
              : { onOpenMore: (station) => onOpenRun({ phaseId: station.id }) })}
          />
        </div>
      )}
      {/*
          The line under the timeline, “details of n/m steps shown”: the header count is already the
          real step count, so this line only says that what stops at the surface is the **details**.
          It is present in the collapsed state too — it explains the numbers above, not the pills. A
          card without a rail (the row window does not reach back to the spawn row) is
          **single-line** by spec and has no count to qualify either, so this line is absent along
          with it.
          */}
      {hasRail ? <WorkflowTruncatedNotice run={run} testId="workflow-digest-truncated" /> : null}
      {/* The artifact bar (a belated mention of the "artifact pills"): the run's deliverables, present in both the collapsed and expanded states — the most useful line on a receipt. */}
      {run?.artifacts !== undefined && run.artifacts.length > 0 ? (
        <WorkflowArtifactStrip
          artifacts={run.artifacts}
          className="pb-0.5 pt-0.5"
          moreTestId="workflow-digest-artifacts-more"
          pillTestId="workflow-digest-artifact"
          testId="workflow-digest-artifacts"
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        />
      ) : null}
    </section>
  );
}

/**
 * The header's Configure button: a ghost `icon-md` with the slider glyph, same shape as Stop — the
 * header has no room for a button with text. Clicking it opens the “Configure” popover below
 * itself.
 */
function ConfigureRunButton({
  host,
  run,
}: {
  host: WorkflowRunSettingsHost;
  run: WorkflowRunState;
}) {
  const { intl } = useZCodeIntl();
  const { anchorRef, open, setOpen, toggleFrom } = useWorkflowRunSettingsPopoverState();
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.title" });
  return (
    <>
      <ControlHintTooltip title={label} side="top">
        <Button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={label}
          data-testid="workflow-digest-configure"
          onClick={(event) => toggleFrom(event.currentTarget)}
          size="icon-md"
          type="button"
          variant="ghost"
        >
          <SlidersHorizontalIcon className="size-3.5" />
        </Button>
      </ControlHintTooltip>
      <WorkflowRunSettingsPopover
        anchorRef={anchorRef}
        host={host}
        onOpenChange={setOpen}
        open={open}
        run={run}
      />
    </>
  );
}

/**
 * The header's Stop button: the same form as the ⤢ that opens the details (a ghost icon button + a
 * tooltip, no text — the header has no room for a button with text). “Stopping” is its own local
 * state; the host keys it by run status, so a status change remounts it and it resets naturally.
 *
 * The tooltip carries a second line, “You can resume at any time after stopping; the steps already
 * completed are kept.”: once the verb changed from “cancel” to “stop”, the moment of pressing it
 * also has to say out loud that this is not a discard (a stopped run is resumable). That line is
 * withdrawn while stopping — the decision has already been made and there is nothing left to argue
 * for.
 */
function CancelRunButton({ onCancel }: { onCancel: () => void }) {
  const { intl } = useZCodeIntl();
  const [cancelling, setCancelling] = useState(false);
  const label = intl.formatMessage({
    id: cancelling ? "chat.toolCall.workflow.run.cancelling" : "chat.toolCall.workflow.run.cancel",
  });
  return (
    <ControlHintTooltip
      title={label}
      side="top"
      {...(cancelling
        ? {}
        : {
            description: intl.formatMessage({ id: "chat.toolCall.workflow.run.stopHint" }),
          })}
    >
      <Button
        aria-label={label}
        data-testid="workflow-digest-cancel"
        disabled={cancelling}
        onClick={() => {
          setCancelling(true);
          onCancel();
        }}
        size="icon-md"
        type="button"
        variant="ghost"
      >
        <SquareIcon className="size-3.5 fill-current" />
      </Button>
    </ControlHintTooltip>
  );
}
