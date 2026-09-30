import type { CSSProperties } from "react";
import { ArrowUpRightIcon, ChevronDownIcon, CircleXIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RosterCounts, RosterMore } from "./roster-model.js";
import type { TimelinePill } from "./timeline-model.js";
import { LaneGlyph } from "./WorkflowAgentPill.js";
import { RosterTally } from "./WorkflowRosterParts.js";

/**
 * The "n more" row: the sixth pill of the card's roster, after the five pinned ones — same height,
 * same base color, same padding, same radius, same hover grammar. Its content is three stacked
 * faces (the three most important of the rest, whose expressions carry state on their own), `n
 * more`, a red `✕ n` when failures are hidden, and a resident ↗ in the tail slot.
 *
 * It is a door, not a state: one click opens the run side panel, lands on this station and expands
 * the list (`onOpen` is wired by the card to `onSelectStation`). There is no state marker that has
 * to give way, so the ↗ is there without waiting for hover (an empty tail slot reads as "nothing
 * here"). Without a callback it is a static span.
 *
 * On the side panel the same body is a **door** (`door` present): the tail slot swaps in a down
 * arrow and it opens and closes in place. Closed, it carries a count row for the rest (when
 * failures are hidden the red lives in that count row instead of a separate `✕ n`); open, the count
 * row moves into the list's group header, leaving only the headcount on this row, one step higher
 * in base color, with the names turned to the foreground.
 */
export function WorkflowMoreRow({
  door,
  enterDelayMs,
  more,
  onOpen,
}: {
  more: RosterMore;
  /** Entrance delay (lands right after the pinned pills); absent means immediately. */
  enterDelayMs?: number;
  /** Present means the whole row is a button (the callback's presence is the gate). */
  onOpen?: () => void;
  /**
   * The door's form (side panel): the open/closed state and the count of the rest. Absent means the
   * row on the card (↗ always resident).
   */
  door?: { open: boolean; tally: RosterCounts };
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const nameOf = (pill: TimelinePill) => pill.runtimeName ?? laneDisplayName(pill.lane, format);
  const label = format(
    { id: "chat.toolCall.workflow.timeline.roster.more" },
    { count: more.count },
  );
  const title = format(
    {
      id:
        door === undefined
          ? "chat.toolCall.workflow.timeline.roster.moreTitle"
          : door.open
            ? "chat.toolCall.workflow.timeline.roster.door.fold"
            : "chat.toolCall.workflow.timeline.roster.door.list",
    },
    { count: more.count },
  );
  // The same entry discipline as pills: fill backwards when there is a delay.
  const style =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : ({ animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" } as CSSProperties);
  const Root = onOpen === undefined ? "span" : "button";
  return (
    <Root
      aria-label={title}
      aria-expanded={door?.open}
      className={cn(
        "wf-pill wf-agent-pill wf-more-row wf-arrive flex h-8 min-w-0 items-center gap-2 rounded-full pl-2 pr-2.5 text-ui-sm",
        door?.open === true ? "bg-surface-hover" : "bg-surface",
        onOpen !== undefined &&
          "wf-pill-open cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-door={door === undefined ? undefined : door.open ? "open" : "closed"}
      data-more-count={more.count}
      data-testid="workflow-roster-more-row"
      onClick={onOpen}
      style={style}
      title={title}
      {...(onOpen === undefined ? {} : { type: "button" as const })}
    >
      <span className="wf-more-deck flex shrink-0 items-center" data-testid="workflow-more-deck">
        {more.deck.map((pill) => (
          <LaneGlyph
            className="wf-more-face size-4 shrink-0 text-foreground-subtle"
            key={pill.key}
            avatarIndex={pill.avatarIndex}
            laneClass={pill.laneClass}
            name={nameOf(pill)}
            status={pill.status}
          />
        ))}
      </span>
      <span
        className={cn(
          "wf-pill-name min-w-0 flex-1 truncate",
          door?.open === true ? "text-foreground" : "text-foreground-subtle",
        )}
      >
        {label}
      </span>
      {door === undefined ? null : door.open ? null : (
        <RosterTally className="mr-0.5 shrink-0" counts={door.tally} />
      )}
      {door !== undefined || more.failed === 0 ? null : (
        <span
          className="flex shrink-0 items-center gap-[3px] font-mono text-ui-xs tabular-nums text-destructive"
          data-testid="workflow-more-failed"
          title={format(
            { id: "chat.toolCall.workflow.timeline.roster.failed" },
            { count: more.failed },
          )}
        >
          <CircleXIcon aria-hidden className="size-2.5" />
          <span className="font-medium">{more.failed}</span>
        </span>
      )}
      <span
        className="wf-pill-tail grid size-3.5 shrink-0 place-items-center"
        data-testid="workflow-pill-tail"
      >
        {door === undefined ? (
          <span
            aria-hidden
            className="wf-pill-go wf-pill-go-rest flex size-3.5 items-center justify-center text-foreground-subtlest"
            data-testid="workflow-more-open"
          >
            <ArrowUpRightIcon className="size-3.5" />
          </span>
        ) : (
          <span
            aria-hidden
            className={cn(
              "wf-pill-go wf-pill-go-rest flex size-3.5 items-center justify-center text-foreground-subtlest transition-transform",
              door.open && "rotate-180",
            )}
            data-testid="workflow-more-chevron"
          >
            <ChevronDownIcon className="size-3.5" />
          </span>
        )}
      </span>
    </Root>
  );
}
