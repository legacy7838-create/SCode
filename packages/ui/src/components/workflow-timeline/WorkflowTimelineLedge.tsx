import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import { LEDGE_PITCH, LEDGE_LAMP, ledgeLamps, railKey, scrollbarThumb } from "./timeline-ledge.js";
import type { TimelineViewport } from "./use-timeline-viewport.js";

/**
 * Ledge and scrollbar.
 *
 * Ledge: the stops collapsed to one side of the viewport, drawn as a row of identical 10px lamps
 * (16px each), with ink-colored rail segments of that edge in between; on the content side a short
 * rail segment reaches the first open stop, and the far end shows `+n` once there are more than
 * five. Every lamp is a button: one click brings that stop back into view. Collapsed stops are not
 * drawn in the content — the lamp on the ledge **is** them.
 *
 * Scrollbar: one 2px bar at the bottom of the timeline, track in the border color and thumb in
 * foreground-subtlest; opacity 0 at rest, revealed while the pointer is over the card or while
 * scrolling, and the track thickens to 4px on hover; the thumb is draggable and clicking the track
 * pages. The native scrollbar is hidden.
 */

/**
 * Stop lamp: the `STATUS_DOT` vocabulary, plus a 3px glow (breathing) on running — it is the only
 * thing on screen that glows.
 */
export function stationLampClass(status: StepRunStatus | undefined): string {
  const resolved = status ?? "pending";
  return cn(
    "wf-lamp size-2.5 shrink-0 rounded-full",
    STATUS_DOT[resolved],
    resolved === "running" && "wf-lamp-running motion-reduce:animate-none",
  );
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// The patch line needs to be 1px the same as the static main track to avoid thick and thin seams at the scrolling edge.
// Double line segment: When two stations on the eaves run parallel, they are not a line.
// Instead, they are two lines 1px apart and 2px apart - the eaves flatten the band, and the bifurcation and merging cannot be drawn. Two side by side lines are the only thing that can be said here.
// The sign of "simultaneously".
function Segment({ rail, width }: { rail: TimelineRail | undefined; width: number }) {
  if (rail?.kind === "twin") {
    return (
      <span
        aria-hidden
        className="relative h-0 shrink-0"
        data-ledge-ink={rail.ink}
        data-ledge-twin="true"
        style={{ width }}
      >
        <span
          className="absolute inset-x-0 h-0 border-t border-foreground-subtlest"
          style={{ top: -1 }}
        />
        <span
          className="absolute inset-x-0 h-0 border-t border-foreground-subtlest"
          style={{ top: 1 }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "h-0 shrink-0 border-t border-foreground-subtlest",
        rail === undefined && "invisible",
      )}
      data-ledge-ink={rail?.ink ?? "none"}
      style={{ width }}
    />
  );
}

export function WorkflowLedge({
  indexes,
  nameOf,
  onSelect,
  rails,
  side,
  stations,
  stubWidth,
  top,
}: {
  side: "left" | "right";
  /** Stops collapsed onto this side (ascending). */
  indexes: readonly number[];
  stations: readonly TimelineStation[];
  /**
   * Rail segment between two adjacent stops, indexed by a **pair of stops** (`railKey`): a single
   * stop inside a band can grow several segments.
   */
  rails: ReadonlyMap<string, TimelineRail>;
  /** Width of the short rail segment between the ledge and the first open stop; 0 = not drawn. */
  stubWidth: number;
  /** Top of the rail row (same height as the ledge and the lamps). */
  top: number;
  nameOf: (index: number) => string;
  onSelect: (index: number) => void;
}) {
  const { intl } = useZCodeIntl();
  if (indexes.length === 0) return null;
  const { shown, more } = ledgeLamps(indexes, side);
  const stubRail =
    side === "left"
      ? rails.get(railKey(indexes[indexes.length - 1]!, indexes[indexes.length - 1]! + 1))
      : rails.get(railKey(indexes[0]! - 1, indexes[0]!));
  const stub = stubWidth > 0 ? <Segment rail={stubRail} width={stubWidth} /> : null;
  const count =
    more > 0 ? (
      <span
        className="shrink-0 text-center font-mono text-ui-2xs text-foreground-subtlest"
        data-testid="workflow-timeline-ledge-more"
        style={{ width: 26 }}
      >
        +{more}
      </span>
    ) : null;
  const lamps = shown.map((index, k) => {
    const station = stations[index]!;
    const label = `${nameOf(index)} · ${intl.formatMessage({ id: `chat.toolCall.workflow.graph.status.${station.status ?? "pending"}` })}`;
    return (
      <span className="flex items-center" key={station.id}>
        {k > 0 ? (
          <Segment
            rail={rails.get(railKey(shown[k - 1]!, index))}
            width={LEDGE_PITCH - LEDGE_LAMP}
          />
        ) : null}
        <button
          aria-label={label}
          className="wf-ledge-lamp relative flex shrink-0 cursor-pointer items-center justify-center rounded-full outline-none before:absolute before:-inset-1 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring/40"
          data-station-index={index}
          data-testid="workflow-timeline-ledge-lamp"
          onClick={() => onSelect(index)}
          style={{ height: LEDGE_LAMP, width: LEDGE_LAMP }}
          title={label}
          type="button"
        >
          <span
            aria-hidden
            className={cn(stationLampClass(station.status), "wf-land")}
            data-lamp={station.status ?? "pending"}
          />
        </button>
      </span>
    );
  });
  return (
    <div
      aria-label={intl.formatMessage(
        { id: `chat.toolCall.workflow.timeline.ledge.${side === "left" ? "earlier" : "later"}` },
        { count: indexes.length },
      )}
      className={cn(
        "wf-ledge pointer-events-auto absolute flex h-6 items-center",
        side === "left" ? "left-0 pl-2" : "right-0 pr-2",
      )}
      data-testid={`workflow-timeline-ledge-${side}`}
      role="group"
      style={{ top }}
    >
      {side === "left" ? count : stub}
      {lamps}
      {side === "left" ? stub : count}
    </div>
  );
}

/**
 * After the thumb is dragged or the track is clicked, the browser still fires one extra click that
 * bubbles up the DOM to the host card — the end-of-turn summary card treats a click on empty space
 * as collapse / expand, and its child-control predicate only recognizes button / a / form elements,
 * not a scrollbar. The user drags the slider once and the card folds itself away. Clicks on the
 * scrollbar stop there: it has already consumed that interaction.
 */
function stopClick(event: ReactMouseEvent<HTMLDivElement>) {
  event.stopPropagation();
}

export function WorkflowTimelineScrollbar({
  scrollRef,
  viewport,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  viewport: TimelineViewport;
}) {
  const { intl } = useZCodeIntl();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null);
  const thumb = scrollbarThumb(viewport.scrollLeft, viewport.clientWidth, viewport.scrollWidth);
  if (thumb === undefined) return null;
  const range = viewport.scrollWidth - viewport.clientWidth;
  const ratio = viewport.scrollWidth / viewport.clientWidth;

  const onThumbDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      startLeft: viewport.scrollLeft,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onThumbMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    const element = scrollRef.current;
    if (state === null || element === null || state.pointerId !== event.pointerId) return;
    element.scrollLeft = state.startLeft + (event.clientX - state.startX) * ratio;
  };
  const onThumbUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };
  const onTrackDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const element = scrollRef.current;
    if (element === null) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const direction = x < thumb.left ? -1 : 1;
    element.scrollBy({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      left: direction * viewport.clientWidth,
    });
  };
  return (
    <div
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.timeline.scrollbar" })}
      aria-orientation="horizontal"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round((100 * Math.min(viewport.scrollLeft, range)) / range)}
      className="wf-sb absolute inset-x-0 bottom-0 h-0.5 cursor-pointer rounded-full bg-border"
      data-dragging={dragging ? "true" : undefined}
      data-scrolling={viewport.scrolling ? "true" : undefined}
      data-testid="workflow-timeline-scrollbar"
      onClick={stopClick}
      onPointerDown={onTrackDown}
      role="scrollbar"
    >
      <span
        className="wf-sb-thumb absolute inset-y-0 rounded-full bg-foreground-subtlest"
        data-testid="workflow-timeline-scrollbar-thumb"
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        style={{ left: thumb.left, width: thumb.width }}
      />
    </div>
  );
}
