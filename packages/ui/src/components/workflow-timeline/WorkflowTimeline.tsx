import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelinePill, TimelineStation, WorkflowTimelineModel } from "./timeline-model.js";
import { ROSTER_PINS_CARD, rosterMore, stationRosterOf } from "./roster-model.js";
import { useTypewriter } from "./use-typewriter.js";
import { WorkflowAgentPill } from "./WorkflowAgentPill.js";
import { WorkflowMoreRow } from "./WorkflowMoreRow.js";
import {
  PILL_GAP,
  PILL_HEIGHT,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  stationX,
  timelineLayout,
  timelineWidth,
} from "./timeline-geometry.js";
import { WorkflowTimelineArcs } from "./WorkflowTimelineArcs.js";
import { WorkflowStationPlatform, WorkflowStationRow } from "./WorkflowTimelineStation.js";
import { WorkflowTimelineLamps, WorkflowTimelineTracks } from "./WorkflowTimelineTracks.js";
import {
  NO_FOLD,
  flightAfterScroll,
  foldStations,
  ledgeStubWidth,
  railKey,
  stationCameraLeft,
  timelineMaskStyle,
  type CameraFlight,
} from "./timeline-ledge.js";
import { useTimelineViewport } from "./use-timeline-viewport.js";
import {
  WorkflowLedge,
  WorkflowTimelineScrollbar,
  prefersReducedMotion,
} from "./WorkflowTimelineLedge.js";

export { STATION_GAP, STATION_PITCH, STATION_WIDTH, timelineWidth } from "./timeline-geometry.js";

/**
 * A horizontal timeline: one rail, stations on the rail, pills hanging below the stations, arcs in
 * the air above the rail. Pure DOM plus one layer of SVG (arcs only), no canvas library.
 *
 * The geometry constants are verbatim identical to the design canvas (`timeline-geometry.ts`):
 * station width 168, station pitch 24 (five stations = 936, which fits the 960-wide session
 * column), rail row 24, arc lane offset 14. The lamp lands in the pill avatar column (station left
 * edge + 17) and the name lands in the subagent name column (station left edge + 34) — a station
 * head is just a pill with no background.
 *
 * When it is wider than the container it scrolls freely: stations whose lamp has scrolled out of
 * the viewport fold onto that side's **ledge** — the same lamp, 16px each, resting on the clean
 * ground at the viewport edge; the rail row fades 40px beside the ledge, and the pills fade only at
 * the viewport's true boundary; position is shown in a 2px scrollbar at the bottom. The native
 * scrollbar is hidden, the right edge is no longer tinted with a gradient, and the header no longer
 * needs a rank band. The camera still aims at the running station; while the camera is in flight
 * the target station is not folded (the viewport is measured before scrollTo, so treating a stale
 * position as off-screen mid-flight is a false positive).
 *
 * A draft (`model.draft`) is written by a pen: stations are revealed one by one in declaration
 * order, the rail segment reaches out from the left, the lamp lands, the name is written out
 * character by character, and the cursor follows the pen, blinking as it catches up. Stations the
 * pen has not reached yet are not on the rail.
 */
function stationHeight(station: TimelineStation): number {
  // The station that passes the threshold is five pinned pills plus a line "n more": that line is the sixth pill
  // pills, so a stop is never more than six pills.
  const roster = stationRosterOf(station, ROSTER_PINS_CARD);
  const n = roster === undefined ? station.pills.length : roster.pinned.length + 1;
  return n === 0 ? 0 : n * PILL_HEIGHT + (n - 1) * PILL_GAP;
}

/**
 * The overall height of the timeline (arc lane + rail row + station row + the tallest column of
 * pills). Expanding / collapsing the tail summary transitions the outer frame's height between two
 * values, so it has to be computable outside rendering — which is why the row layout is a pure
 * function in `timeline-geometry.ts`. The trailing 8px of padding is where the scrollbar lives (6px
 * below the pills, 2px thick, 4px on hover) — it overlays the padding along the bottom edge without
 * changing the height.
 */
export function timelineHeight(model: WorkflowTimelineModel): number {
  const rows = timelineLayout(model.arcs, model.bands);
  return rows.pillsTop + Math.max(0, ...model.stations.map(stationHeight)) + 8;
}

/** The interval at which pills land one after another (the same value as on the design canvas). */
export const PILL_STAGGER_MS = 30;

function pillName(pill: TimelinePill, format: Parameters<typeof laneDisplayName>[1]): string {
  return pill.runtimeName ?? laneDisplayName(pill.lane, format);
}

export interface WorkflowTimelineProps {
  model: WorkflowTimelineModel;
  className?: string;
  /**
   * Clicking a station; absent means the station head is not a control — the click bubbles to the
   * host (the tail summary's whole-block toggle).
   */
  onSelectStation?: (station: TimelineStation) => void;
  /**
   * Clicking the "n more" row of a rostered station: opens the run detail and lands on that
   * station. It is gated separately from the station head's `onSelectStation`: in the tail summary
   * the station head is still part of the whole-block toggle, but that row is a door. Absent means
   * the row is static.
   */
  onOpenMore?: (station: TimelineStation) => void;
  /**
   * Clicking a pill (opens the transcript when there is a session, opens a placeholder when there
   * is not); absent means it is not clickable.
   */
  onOpenPill?: (pill: TimelinePill) => void;
  /**
   * Clicking a script pill: opens the script transcript of the whole run and lands on that station;
   * absent means the script pill is not clickable. Each of them gates its own lane separately from
   * `onOpenPill`.
   */
  onOpenWorkspace?: (pill: TimelinePill) => void;
}

export const WorkflowTimeline = memo(function WorkflowTimeline({
  className,
  model,
  onOpenMore,
  onOpenPill,
  onOpenWorkspace,
  onSelectStation,
}: WorkflowTimelineProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const markerId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  // The scroll layer elements enter the state at the same time: the first draft frame n === 0 returns null, the scroll layer is hung up one frame later - the viewport hook relies on the element,
  // The element will only be monitored when it appears (when relying on the ref object, the null in the first frame will never allow it to be monitored).
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScroller(element);
  }, []);
  // A flight of shots: recorded when taking off, cleared when landing or user takes over; target station not broken during flight.
  const [flight, setFlight] = useState<CameraFlight | undefined>(undefined);

  const { arcs } = model;
  const draft = model.draft !== undefined;
  const fullNames = model.stations.map((station) => phaseDisplayName(station.naming, format));
  const pen = useTypewriter(draft ? fullNames : undefined);
  const stations = draft ? model.stations.slice(0, pen.visible) : model.stations;
  const n = stations.length;
  const rails = draft ? model.rails.filter((rail) => rail.to < n) : model.rails;
  // Arrangement of rows: When there is a belt, the main line falls at the bottom
  // A row, branches are stacked on it, and the station head is moved to the platform row; when there is no belt, the entire set of formulas returns to the previous "arc + track row" pixel by pixel.
  // DOM also takes the original one.
  const layout = timelineLayout(model.arcs, model.bands);
  const { banded, inset, pillsTop } = layout;
  const top = layout.rowY[0]! - RAIL_ROW / 2;
  const width = timelineWidth(n, inset);
  const height = timelineHeight(draft ? { ...model, stations } : model);
  // The pills fall to the ground sequentially from left to right according to the station, and from top to bottom within the station: the kth pill is delayed k × 30 ms (the line "n more" is also queued).
  let pillOrdinal = 0;
  const nextDelay = () => {
    const delay = PILL_STAGGER_MS * pillOrdinal;
    pillOrdinal += 1;
    return delay;
  };
  // Check the track section by **pair of stations**: one station in the belt can grow one of the main lines at the same time,
  // Bifurcated one and two line segments.
  const railByPair = useMemo(
    () => new Map(rails.map((rail) => [railKey(rail.from, rail.to), rail])),
    [rails],
  );

  // Viewport: Where to scroll, how wide, and how wide the content is. When the amount is less than (jsdom), the three are 0, and nothing below is folded.
  const viewport = useTimelineViewport(scroller, width);
  // The flight is settled after each rolling sampling: it ends when it lands or deviates. Determined only by position, no timer required.
  useEffect(() => {
    setFlight((current) => flightAfterScroll(current, viewport.scrollLeft));
  }, [viewport.scrollLeft]);
  const overflow = viewport.clientWidth > 0 && viewport.scrollWidth > viewport.clientWidth;
  const fold = overflow
    ? foldStations(n, viewport.scrollLeft, viewport.clientWidth, flight?.index, inset)
    : NO_FOLD;
  const folded = useMemo(() => new Set([...fold.left, ...fold.right]), [fold]);
  // The mask is divided into two bands: the track band fades next to the eaves, and the pill band fades only at the real boundary of the viewport.
  const mask = overflow
    ? timelineMaskStyle(fold, pillsTop - 8, {
        left: viewport.scrollLeft > 0,
        right: viewport.scrollLeft < viewport.scrollWidth - viewport.clientWidth - 1,
      })
    : undefined;

  const scrollTo = useCallback((left: number) => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTo({ behavior: prefersReducedMotion() ? "auto" : "smooth", left });
  }, []);
  // Light on the eaves: The shot brings that station back to the center (same rule as the shot of the running station).
  const selectFolded = useCallback(
    (index: number) =>
      scrollTo(stationCameraLeft(index, scrollRef.current?.clientWidth ?? 0, inset)),
    [inset, scrollTo],
  );
  // When the focus is on the lamp at the head of the station or on the eaves, ← → roll one station each.
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-testid='workflow-timeline-station'], .wf-ledge") === null) return;
      const element = scrollRef.current;
      if (element === null || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      scrollTo(element.scrollLeft + (event.key === "ArrowLeft" ? -STATION_PITCH : STATION_PITCH));
    },
    [scrollTo],
  );

  // Lens: When it is wider than the container, the focus station will be rolled into the field of view; the user will no longer grab it if he rolls it (only re-anchors when the focus station changes).
  // In run, the focus is the running station (centered); in draft, the focus follows the pen - the latest displayed station is against the right edge.
  // The landing point of the draft is index·PITCH + STATION_WIDTH − clientWidth: You cannot add an extra station distance (it will overshoot by 24px, and it can only fall correctly if it is clamped by the browser).
  const focusIndex = draft ? (n > 0 ? n - 1 : undefined) : model.runningIndex;
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || focusIndex === undefined) return;
    if (element.scrollWidth <= element.clientWidth) return;
    const left = draft
      ? Math.max(0, stationX(focusIndex, inset) + STATION_WIDTH - element.clientWidth)
      : stationCameraLeft(focusIndex, element.clientWidth, inset);
    // Take-off: The target is clamped according to the rolling range; it is not considered flying if it is on the target.
    const target = Math.min(left, element.scrollWidth - element.clientWidth);
    const from = element.scrollLeft;
    setFlight(Math.abs(from - target) <= 1 ? undefined : { from, index: focusIndex, target });
    element.scrollTo({ behavior: prefersReducedMotion() ? "auto" : "smooth", left });
  }, [draft, focusIndex, inset]);

  if (n === 0) return null;

  const stationTitleOf = (phaseId: string): string => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };
  const stationTitle = (station: TimelineStation): string => {
    const name = phaseDisplayName(station.naming, format);
    return station.onLoop && station.rounds > 0
      ? `${name} · ${intl.formatMessage({ id: "chat.toolCall.workflow.timeline.rounds" }, { count: station.rounds })}`
      : name;
  };

  const renderPill = (pill: TimelinePill) => {
    const enterDelayMs = nextDelay();
    const label = pillName(pill, format);
    // All sub-agent pills in the live run can be opened: there is a session to open the transcript, but it has not been started yet.
    // Open a placeholder for the same tab - the slot identity (`pill.slot`) is its starting point. Without run there is no slot.
    // The same set of opening syntax for script pills: there are grabbers in the live run
    // You can open the first card that falls to this station. Without hue, hover strokes fall back to border-hover (the pill's own rules).
    const open =
      onOpenPill !== undefined && pill.slot !== undefined
        ? {
            label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
            onOpen: () => onOpenPill(pill),
            testId: "workflow-timeline-pill-open",
          }
        : onOpenWorkspace !== undefined && pill.workspace !== undefined
          ? {
              label: format(
                { id: "chat.toolCall.workflow.timeline.openScript" },
                { phase: stationTitleOf(pill.workspace.phaseId) },
              ),
              onOpen: () => onOpenWorkspace(pill),
              testId: "workflow-timeline-workspace-open",
            }
          : undefined;
    return (
      <WorkflowAgentPill
        enterDelayMs={enterDelayMs}
        key={pill.key}
        avatarIndex={pill.avatarIndex}
        laneClass={pill.laneClass}
        name={label}
        status={pill.status}
        {...(open === undefined ? {} : { open })}
      />
    );
  };

  const ledgeProps = {
    nameOf: (index: number) => fullNames[index]!,
    onSelect: selectFolded,
    rails: railByPair,
    stations,
    top,
  };

  return (
    <div
      className={cn("wf-motion wf-timeline min-w-0", className)}
      data-testid="workflow-timeline"
      onKeyDown={onKeyDown}
    >
      {/* The ledge and the scrollbar overlay the scroll layer, positioned relative to it rather than to the padded outer frame. */}
      <div className="relative">
        <div
          className="wf-scroller overflow-x-auto overflow-y-hidden"
          data-testid="workflow-timeline-scroller"
          data-timeline-fade={
            fold.left.length > 0 && fold.right.length > 0
              ? "both"
              : fold.left.length > 0
                ? "left"
                : fold.right.length > 0
                  ? "right"
                  : undefined
          }
          ref={attachScroller}
          style={mask}
        >
          <div className="relative" style={{ height, width }}>
            <WorkflowTimelineArcs
              arcs={arcs}
              bands={model.bands}
              height={height}
              layout={layout}
              markerId={markerId}
              stations={model.stations}
              width={width}
            >
              {/* With a band present the rail joins this SVG layer too: branching and merging are curves, which a DOM border cannot draw. */}
              {banded ? (
                <WorkflowTimelineTracks
                  folded={folded}
                  layout={layout}
                  model={{ bands: model.bands, rails, stations }}
                />
              ) : null}
            </WorkflowTimelineArcs>

            {banded ? (
              <WorkflowTimelineLamps
                draft={draft}
                folded={folded}
                layout={layout}
                stations={stations}
              />
            ) : null}

            {banded ? (
              <WorkflowStationPlatform
                folded={folded}
                fullNames={fullNames}
                layout={layout}
                stations={stations}
                titleOf={stationTitle}
                {...(onSelectStation === undefined ? {} : { onSelectStation })}
              />
            ) : (
              <WorkflowStationRow
                draft={draft}
                folded={folded}
                fullNames={fullNames}
                pen={pen}
                rails={railByPair}
                stations={stations}
                titleOf={stationTitle}
                top={top}
                width={width}
                {...(onSelectStation === undefined ? {} : { onSelectStation })}
              />
            )}

            {stations.map((station, i) => {
              const roster = stationRosterOf(station, ROSTER_PINS_CARD);
              // There is still something to say about the roster: when all the pills in a station are eliminated by the world, the line "n more" is left instead of disappearing out of thin air.
              if (station.pills.length === 0 && roster === undefined) return null;
              return (
                <div
                  className="absolute flex flex-col"
                  data-station-roster={roster === undefined ? undefined : "true"}
                  data-testid="workflow-timeline-pills"
                  key={station.id}
                  style={{
                    gap: PILL_GAP,
                    left: stationX(i, inset),
                    top: pillsTop,
                    width: STATION_WIDTH,
                  }}
                >
                  {roster === undefined ? (
                    station.pills.map(renderPill)
                  ) : (
                    // Roster Station: The pinned five follows the wiring of the pill, followed by a row
                    // "There are n more" - click it to open the run details and drop to this stop (`onOpenMore`, your own door).
                    <>
                      {roster.pinned.map(renderPill)}
                      <WorkflowMoreRow
                        enterDelayMs={nextDelay()}
                        more={rosterMore(roster)}
                        {...(onOpenMore === undefined ? {} : { onOpen: () => onOpenMore(station) })}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {/* The ledge: stations folded onto both sides of the viewport, a row of lamps resting on the rail row, with the content under the ledge already cleared by a mask. */}
        <WorkflowLedge
          indexes={fold.left}
          side="left"
          stubWidth={ledgeStubWidth(fold, "left", viewport.scrollLeft, viewport.clientWidth, inset)}
          {...ledgeProps}
        />
        <WorkflowLedge
          indexes={fold.right}
          side="right"
          stubWidth={ledgeStubWidth(
            fold,
            "right",
            viewport.scrollLeft,
            viewport.clientWidth,
            inset,
          )}
          {...ledgeProps}
        />
        {overflow ? <WorkflowTimelineScrollbar scrollRef={scrollRef} viewport={viewport} /> : null}
      </div>
    </div>
  );
});
