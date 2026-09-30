// ============================================================
// Side rail ridge parts
// ============================================================
// Unpacked from WorkflowRunPhaseList.tsx (max-lines 400): the manifest file holds expansion status, issue ownership and pill wiring,
// This document carries four purely display pieces - track segments, lights, avatar strings on folding joint heads, and rounds.

import { useId, type CSSProperties } from "react";
import { Repeat2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type {
  TimelineInk,
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";
import { LaneGlyph, agentColor } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { MarchLight } from "@/components/workflow-timeline/WorkflowMarchLight.js";
import type { SpineSection } from "@/app-shell/workflowRunSpine.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** How many avatars fit on a collapsed section header; the rest collapse into `+n`. */
const CLUSTER_MAX = 3;

/**
 * Center of the vertical rail for track t; the main line sits at 21 and each branch is 12px further
 * right (`workflowRunSpine.ts`).
 */
const TRACK_X = 21;
const TRACK_GAP = 12;

/**
 * Half of a rail segment. The stretch of rail between two adjacent stations is drawn as two halves:
 * the previous station runs from the bottom of its lamp to the bottom of the section, the next one
 * from the top of the section to the top of its lamp — same ink for both halves, joined at the
 * section's boundary. That way the rail grows and shrinks with the section's expand / collapse on
 * its own, without being measured.
 *
 * The band also carries a third kind: `full` runs through the whole section (the main rail passing
 * a branch station, a branch rail passing someone else's station); `from` / `to` give the 13px that
 * the fork and merge curves need. The x of a rail t > 0 is supplied by an inline style — it is
 * computed, so Tailwind cannot generate that class.
 *
 * A marching segment (`march`) is a 1.5px **lit** rail that does not move: it names the edge the
 * control flow has already crossed, leaving the motion to the running lamp. Brightness rises along
 * the direction of the control flow — `data-rail-position` is what the stylesheet uses to pick the
 * gradient, and both halves have to carry it: `below` (the lower half of the previous section)
 * fades in from transparent to 70% of the warning color, `above` (the upper half of the running
 * section) rises from 70% to full and stays lit right into the lamp, and `full` is a flat 70%.
 */
function SpineRail({
  from,
  ink,
  position,
  to,
  track = 0,
}: {
  ink: TimelineInk;
  position: "above" | "below" | "full";
  track?: number;
  from?: number;
  to?: number;
}) {
  const style: CSSProperties = {};
  if (track > 0)
    style.left = (ink === "march" ? TRACK_X - 0.75 : TRACK_X - 0.5) + TRACK_GAP * track;
  if (from !== undefined) style.top = from;
  if (to !== undefined) style.bottom = to;
  return (
    <span
      aria-hidden
      className={cn(
        "wf-ink absolute rounded-full",
        ink === "march" ? "left-[20.25px] w-[1.5px]" : "left-[20.5px] w-px",
        position === "above" ? "top-0 h-3" : position === "below" ? "bottom-0 top-6" : "inset-y-0",
        ink !== "march" && "bg-foreground-subtlest",
        ink === "march" && "wf-spine-march",
      )}
      data-rail-ink={ink}
      data-rail-position={position}
      data-rail-track={track}
      data-testid="workflow-run-spine-rail"
      style={Object.keys(style).length === 0 ? undefined : style}
    />
  );
}

/**
 * Fork / merge curves: a branch rail leaves the main rail within the 13px above the band's first
 * section and comes back on a mirrored curve at the top of the section of the merge station (or the
 * bottom of the section, for the band's last one). Light ink and dark ink are drawn the same way
 * here (consistent with the vertical rails); while marching, a lit light (`MarchLight`) is layered
 * along the very same path: fading in from the end the control flow arrives from, brightest at the
 * end with the lamp, motionless. The two ends of the gradient are exactly the two points used to
 * draw the `path` (a fork goes from the top of the main rail to the bottom of the branch, a merge
 * the other way round) — the path string is not parsed; `id` comes from `useId()`, unique within
 * one SVG.
 */
function SpineCurve({
  at,
  ink,
  kind,
  track,
}: {
  kind: "fork" | "merge";
  track: number;
  ink: TimelineInk;
  at: "top" | "bottom";
}) {
  const lightId = useId();
  const x = TRACK_X - 0.5 + TRACK_GAP * track;
  const main = TRACK_X - 0.5;
  const path =
    kind === "fork"
      ? `M${main},0 V1 C${main},8 ${x},5 ${x},13`
      : `M${x},0 C${x},8 ${main},5 ${main},13`;
  const from = kind === "fork" ? { x: main, y: 0 } : { x, y: 0 };
  const to = kind === "fork" ? { x, y: 13 } : { x: main, y: 13 };
  const width = x + 8;
  return (
    <svg
      aria-hidden
      className={cn("absolute left-0", at === "top" ? "top-0" : "bottom-0")}
      data-curve-ink={ink}
      data-curve-track={track}
      data-testid={`workflow-run-spine-${kind}`}
      height={13}
      viewBox={`0 0 ${width} 13`}
      width={width}
    >
      <path
        d={path}
        fill="none"
        stroke="var(--color-foreground-subtlest)"
        strokeLinecap="round"
        strokeWidth={1}
      />
      {ink === "march" ? <MarchLight d={path} from={from} id={lightId} to={to} /> : null}
    </svg>
  );
}

/**
 * All the vertical rails and curves of a section (precomputed by `workflowRunSpine.ts`), drawn in a
 * single pass.
 */
export function SpinePieces({ section }: { section: SpineSection }) {
  return (
    <>
      {section.rails.map((rail) => (
        <SpineRail key={`${rail.track}:${rail.position}`} {...rail} />
      ))}
      {section.curves.map((curve) => (
        <SpineCurve key={`${curve.kind}:${curve.track}`} {...curve} />
      ))}
    </>
  );
}

/**
 * The lamp on a rail: hollow = not reached yet, green = already passed, red with a ring = failed,
 * amber with a pulse = running. A running lamp shares the card lamp's lifecycle
 * (`wf-lamp-running`): a steady glow plus a heartbeat; under `motion-reduce` only the glow remains.
 */
export function SpineLamp({ status, track = 0 }: { status: StepRunStatus; track?: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp absolute left-4 top-[13px] size-2.5 rounded-full",
        STATUS_DOT[status],
        status === "pending" && "bg-background",
        status === "running" && "wf-lamp-running motion-reduce:animate-none",
      )}
      data-lamp={status}
      data-testid="workflow-run-phase-lamp"
      style={track === 0 ? undefined : { left: 16 + TRACK_GAP * track }}
    />
  );
}

/**
 * The avatar strip on a collapsed section header: who is at this station, visible at a glance;
 * subagents are tile faces colored by number, workspaces use the terminal glyph.
 */
export function AvatarCluster({
  pills,
  nameOf,
}: {
  pills: readonly TimelinePill[];
  nameOf: (pill: TimelinePill) => string;
}) {
  if (pills.length === 0) return null;
  const shown = pills.slice(0, CLUSTER_MAX);
  const more = pills.length - shown.length;
  return (
    <span className="flex items-center gap-1" data-testid="workflow-run-phase-cluster">
      {shown.map((pill) => {
        const tinted = pill.laneClass === "agent";
        const color = tinted ? agentColor(pill.avatarIndex, nameOf(pill)) : undefined;
        return (
          <span
            className={cn(
              "contents",
              tinted ? "text-[var(--wf-avatar)]" : "text-foreground-subtle",
            )}
            key={pill.key}
            style={color === undefined ? undefined : { ["--wf-avatar" as string]: color }}
            title={nameOf(pill)}
          >
            <LaneGlyph
              className="size-4 shrink-0"
              avatarIndex={pill.avatarIndex}
              laneClass={pill.laneClass}
              name={nameOf(pill)}
              status={pill.status}
            />
          </span>
        );
      })}
      {more > 0 ? (
        <span className="ml-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          +{more}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Round: `⟳ n`, present only at both ends of a back edge and only once at least one round has run
 * (the same rule as on the card).
 */
export function Rounds({ station }: { station: TimelineStation }) {
  const { intl } = useZCodeIntl();
  if (!station.onLoop || station.rounds === 0) return null;
  return (
    <span
      className="flex items-center gap-[3px]"
      data-testid="workflow-run-phase-rounds"
      title={intl.formatMessage(
        { id: "chat.toolCall.workflow.timeline.rounds" },
        { count: station.rounds },
      )}
    >
      <Repeat2Icon aria-hidden className="size-[11px]" />
      <span>{station.rounds}</span>
    </span>
  );
}
