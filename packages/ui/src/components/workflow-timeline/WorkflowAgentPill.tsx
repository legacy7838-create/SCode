import type { CSSProperties, ReactNode } from "react";
import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  LoaderCircleIcon,
  TerminalIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LaneClass, StepRunStatus } from "@/components/workflow-graph/types.js";
import { WorkflowAgentFace, agentColor } from "@/components/workflow-timeline/WorkflowAgentFace.js";

export { agentColor, avatarColor } from "@/components/workflow-timeline/WorkflowAgentFace.js";

/**
 * The subagent pill: a colored avatar + a name + a status marker on the right. The station under
 * the card and the sidebar row are both this pill — one feature, one pill only.
 *
 * The avatar is a tile face (`WorkflowAgentFace`): the body color picks from a nine-color ring by
 * agent number, and the expression reads status. A workspace has no identity, so it has no color,
 * only a terminal glyph. `pending` is pixel-for-pixel identical to having no status (invariant 3):
 * no marker, the name in the second-faintest color, and the face asleep.
 *
 * When it is openable (`open` present) the whole pill is the button: hovering lands all four things
 * at once (the background steps up one level, an inner stroke in the avatar's hue, the avatar grows
 * and darkens, and ↗ takes the status marker's place in the tail slot), and a click opens that
 * subagent's transcript directly. A pill that cannot be opened has no hover state; `inertTitle`
 * explains why.
 *
 * The tail slot (`wf-pill-tail`) is a single 14px cell shared by the status marker and ↗: both
 * stack in the same cell, and on hover the marker shrinks out while the arrow shrinks in. So the
 * subagent pill and the script pill land their status markers on the same right edge — ↗ never
 * occupies a slot of its own (↗ must not still take up room while hidden: otherwise the subagent's
 * marker would sit one cell further left than the workspace's).
 */

/**
 * Lane glyph: agent lanes are tile faces (the number picks the color, status picks the expression),
 * workspace / unresolved lanes are icons.
 */
export function LaneGlyph({
  laneClass,
  className,
  avatarIndex,
  name,
  status,
}: {
  laneClass: LaneClass;
  className?: string;
  name: string;
  avatarIndex?: number | undefined;
  status?: StepRunStatus | undefined;
}) {
  if (laneClass === "agent") {
    return (
      <WorkflowAgentFace
        avatarIndex={avatarIndex}
        className={className}
        name={name}
        status={status}
      />
    );
  }
  const Glyph = laneClass === "workspace" ? TerminalIcon : CircleHelpIcon;
  return <Glyph aria-hidden className={className} />;
}

/**
 * Status marker: spinner / checkmark / cross; `pending` and undefined have no marker. A new marker
 * pops in when the status changes; on an openable pill it yields to ↗ on hover.
 */
export function PillStatusMark({ status }: { status: StepRunStatus | undefined }) {
  const { intl } = useZCodeIntl();
  if (status === undefined || status === "pending") return null;
  const label = intl.formatMessage({ id: `chat.toolCall.workflow.graph.status.${status}` });
  return (
    <span
      aria-label={label}
      className={cn(
        "wf-mark flex size-3.5 shrink-0 items-center justify-center",
        // Use a neutral color for the running ring to avoid normal loading being read as a warning.
        status === "running" && "text-foreground-subtle",
        status === "done" && "text-foreground-subtle",
        status === "failed" && "text-destructive",
      )}
      data-testid="workflow-pill-status"
      key={status}
      role="img"
      title={label}
    >
      {status === "running" ? (
        <LoaderCircleIcon
          aria-hidden
          className="size-3.5 animate-spin motion-reduce:animate-none"
        />
      ) : status === "done" ? (
        <CircleCheckIcon aria-hidden className="size-3.5" />
      ) : (
        <CircleXIcon aria-hidden className="size-3.5" />
      )}
    </span>
  );
}

/**
 * Wiring present when the pill is openable: the click callback, the accessibility label, and ↗'s
 * testid and data attributes (the sidebar row uses them to pin down the instance).
 */
export interface WorkflowAgentPillOpen {
  onOpen: () => void;
  label: string;
  testId?: string;
  data?: Record<`data-${string}`, string>;
}

export function WorkflowAgentPill({
  children,
  avatarIndex,
  className,
  enterDelayMs,
  inertTitle,
  laneClass,
  name,
  open,
  size = "md",
  status,
  title,
  trailing,
}: {
  avatarIndex?: number | undefined;
  /**
   * Entrance delay (a column of pills lands in sequence, each offset by 30 ms); absent means
   * immediately.
   */
  enterDelayMs?: number;
  /** The localized display name (runtime name > lane display name). */
  name: string;
  laneClass: LaneClass;
  status: StepRunStatus | undefined;
  title?: string;
  className?: string;
  /** When present, the whole pill is a button (the existence of the callback is the gate). */
  open?: WorkflowAgentPillOpen;
  /**
   * The hint when it cannot be opened ("a session record only exists once the subagent has
   * started"); when absent, falls back to title / name.
   */
  inertTitle?: string;
  /**
   * Supplementary information after the name and before the status marker (the sidebar row's
   * activity and counts).
   */
  children?: ReactNode;
  /** Controls after the status marker. */
  trailing?: ReactNode;
  /**
   * `row` (24 px, no background at rest, only becoming a pill on hover) serves the two columns of
   * the side panel roster; the default is 32 px.
   */
  size?: "md" | "row";
}) {
  const tinted = laneClass === "agent";
  // Delayed entries must be filled backwards: keep the starting frame during the waiting period, otherwise the pill will be fully displayed first and then flash again to enter again.
  // Not using both:forwards will leave the transform on the element.
  const style = {
    ...(tinted ? { "--wf-avatar": agentColor(avatarIndex, name) } : {}),
    ...(enterDelayMs === undefined || enterDelayMs <= 0
      ? {}
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" as const }),
  } as CSSProperties;
  const settled = status !== undefined && status !== "pending";
  const hasMark = settled;
  const hasTail = hasMark || open !== undefined;
  const Root = open === undefined ? "span" : "button";
  const body = (
    <>
      <LaneGlyph
        laneClass={laneClass}
        name={name}
        avatarIndex={avatarIndex}
        status={status}
        className={cn(
          "shrink-0",
          size === "row" ? "size-3.5" : "size-4",
          tinted ? "text-[var(--wf-avatar)]" : "text-foreground-subtle",
        )}
      />
      <span
        className={cn(
          "wf-pill-name min-w-0 flex-1 truncate",
          settled ? "text-foreground" : "text-foreground-subtle",
        )}
      >
        {name}
      </span>
      {children}
      {hasTail ? (
        <span
          className="wf-pill-tail grid size-3.5 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1"
          data-testid="workflow-pill-tail"
        >
          <PillStatusMark status={status} />
          {open === undefined ? null : (
            <span
              aria-hidden
              className="wf-pill-go flex size-3.5 items-center justify-center text-foreground-subtlest"
              data-testid={open.testId ?? "workflow-pill-open"}
              {...open.data}
            >
              <ArrowUpRightIcon className="size-3.5" />
            </span>
          )}
        </span>
      ) : null}
      {trailing}
    </>
  );
  return (
    <Root
      aria-label={open?.label}
      className={cn(
        "wf-pill wf-agent-pill wf-arrive flex rounded-full min-w-0 items-center",
        size === "row"
          ? "h-6 gap-1.5 pl-1 pr-1.5 text-ui-sm"
          : "h-8 gap-2 bg-surface pl-2 pr-2.5 text-ui-sm",
        open !== undefined &&
          "wf-pill-open cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      data-agent-open={open === undefined ? undefined : "true"}
      data-agent-status={status ?? "pending"}
      data-pill-size={size}
      data-testid="workflow-agent-pill"
      onClick={open?.onOpen}
      style={style}
      title={open === undefined ? (inertTitle ?? title ?? name) : (title ?? name)}
      {...(open === undefined ? {} : { type: "button" as const })}
    >
      {body}
    </Root>
  );
}
