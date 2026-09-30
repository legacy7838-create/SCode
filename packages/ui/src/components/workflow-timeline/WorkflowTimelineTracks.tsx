import { useId } from "react";
import { cn } from "@/components/lib/utils.js";
import type {
  TimelineBand,
  TimelineInk,
  TimelineStation,
  WorkflowTimelineModel,
} from "./timeline-model.js";
import {
  bandAt,
  bandForkX,
  bandMergeX,
  lampX,
  STUB,
  TAIL,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { MarchLight } from "./WorkflowMarchLight.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";

/**
 * The track layer.
 *
 * In a timeline without bands, a track segment is still a stretch of border inside the stop-head
 * row (unchanged pixel for pixel). **With bands**, the whole track moves into the arc layer's SVG:
 * the main line runs along the bottom row and branch tracks stack on top of it, forking before the
 * band and merging after it, while two 8px quarter circles lift the branch up and put it back down
 * (branches go up). The lamp is still DOM (the state classes need to be), absolutely positioned
 * onto the row of its own track; stop heads move to the platform row, and a stop on a branch track
 * is connected back to its own name by a dotted leader line.
 */
const INK_STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-workflow-trace-strong)",
  strong: "var(--color-workflow-trace-strong)",
};

/** A point on the canvas. */
export interface TimelinePoint {
  x: number;
  y: number;
}

/**
 * A stretch of track on screen: one path, one ink, plus the two stops it joins (a handle for
 * testing and debugging).
 */
export interface TimelineRailPiece {
  key: string;
  d: string;
  /**
   * The first and last point of the path, derived from the same numbers as `d`—the travelling
   * edge's light has to lay its gradient along these two points (`MarchLight`) rather than going
   * back to parse `d`.
   */
  start: TimelinePoint;
  end: TimelinePoint;
  ink: TimelineInk;
  /**
   * `fork` / `merge` are curves with both ends; `tail` / `stub` are the short stretch of main line
   * used when there is no predecessor / merge stop.
   */
  kind?: "fork" | "merge" | "tail" | "stub";
  from?: number;
  to?: number;
}

/**
 * A path and its two endpoints: in `timelineRailPieces` every segment kind first computes these
 * three, then pairs them with the ink and the two stops.
 */
type RailShape = Pick<TimelineRailPiece, "d" | "end" | "start">;

/**
 * Track segment → path (a pure function). A plain segment on a track is a straight line on that row
 * (lamp + 8 → lamp − 8); the main line's segments pass through the fork point and the merge point,
 * so the main line is naturally a straight line. A plain segment whose ends are both in **different
 * bands** can only be the stretch between two adjacent bands, drawn on the main line from the
 * previous band's merge point to the next band's fork point. Double segments are not drawn on the
 * card.
 */
export function timelineRailPieces(
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">,
  layout: TimelineLayout,
): TimelineRailPiece[] {
  const { bands, rails, stations } = model;
  const { inset, rowY } = layout;
  const y0 = rowY[0]!;
  const rowOf = (track: number): number => rowY[track] ?? y0;
  const lx = (i: number): number => lampX(i, inset);
  const forkX = (band: TimelineBand): number => bandForkX(band, inset);
  const mergeX = (band: TimelineBand): number => bandMergeX(band, inset);
  const trackOfStation = (i: number): number => stations[i]?.track ?? 0;

  /** A straight-line segment on one row. */
  const straight = (x1: number, x2: number, y: number): RailShape => ({
    d: `M${x1},${y} H${x2}`,
    end: { x: x2, y },
    start: { x: x1, y },
  });
  // The branch track t leaves the main line at forkX − 8(t−1), and the two quarter-circle sections rise to their own rows, and then reach 8px in front of the first light.
  const forkPath = (band: TimelineBand, track: number, head: number): RailShape => {
    const xf = forkX(band) - 8 * (track - 1);
    const yt = rowOf(track);
    return {
      d: `M${xf},${y0} Q${xf + 8},${y0} ${xf + 8},${y0 - 8} V${yt + 8} Q${xf + 8},${yt} ${xf + 16},${yt} H${lx(head) - 8}`,
      end: { x: lx(head) - 8, y: yt },
      start: { x: xf, y: y0 },
    };
  };
  // The merge is a mirror image of the fork: from 8px behind the last light to xm − 8, falling back to the main line. The higher the track in the belt, the further to the left the landing point is.
  const mergePath = (band: TimelineBand, track: number, tail: number): RailShape => {
    const xm = mergeX(band) - 8 * (band.tracks.length - 1 - track);
    const yt = rowOf(track);
    return {
      d: `M${lx(tail) + 8},${yt} H${xm - 8} Q${xm},${yt} ${xm},${yt + 8} V${y0 - 8} Q${xm},${y0} ${xm + 8},${y0}`,
      end: { x: xm + 8, y: y0 },
      start: { x: lx(tail) + 8, y: yt },
    };
  };

  const pieces: TimelineRailPiece[] = [];
  // The belt without a precursor/merging station has two ends: a small tail/stub of the main line, and the curve of the branch track - in the model
  // There is no corresponding track segment (bifurcation and merging must have a stop to form a segment), and the ink color takes the entry/exit of the track itself.
  for (const band of bands) {
    const main = band.tracks[0]!;
    if (band.pred === undefined) {
      const head = main.stations[0]!;
      pieces.push({
        ...straight(forkX(band) - TAIL, lx(head) - 8, y0),
        ink: main.entry,
        key: `tail:${band.from}`,
        kind: "tail",
        to: head,
      });
      band.tracks.forEach((track, t) => {
        if (t === 0) return;
        const first = track.stations[0]!;
        pieces.push({
          ...forkPath(band, t, first),
          ink: track.entry,
          key: `fork:${band.from}:${t}`,
          kind: "fork",
          to: first,
        });
      });
    }
    if (band.join === undefined) {
      const last = main.stations[main.stations.length - 1]!;
      pieces.push({
        ...straight(lx(last) + 8, mergeX(band) + STUB, y0),
        ink: main.exit,
        key: `stub:${band.to}`,
        kind: "stub",
        from: last,
      });
      band.tracks.forEach((track, t) => {
        if (t === 0) return;
        const end = track.stations[track.stations.length - 1]!;
        pieces.push({
          ...mergePath(band, t, end),
          ink: track.exit,
          key: `merge:${band.to}:${t}`,
          kind: "merge",
          from: end,
        });
      });
    }
  }

  for (const rail of rails) {
    // The double line segment only says "these two stations are parallel" and is not drawn on the card - the bifurcation and merging have already made the parallel clear.
    if (rail.kind === "twin") continue;
    const ends = { from: rail.from, ink: rail.ink, key: `${rail.from}>${rail.to}`, to: rail.to };
    if (rail.kind === "fork") {
      const band = bandAt(bands, rail.to);
      if (band === undefined) continue;
      pieces.push({ ...ends, ...forkPath(band, trackOfStation(rail.to), rail.to), kind: "fork" });
      continue;
    }
    if (rail.kind === "merge") {
      const band = bandAt(bands, rail.from);
      if (band === undefined) continue;
      pieces.push({
        ...ends,
        ...mergePath(band, trackOfStation(rail.from), rail.from),
        kind: "merge",
      });
      continue;
    }
    const source = bandAt(bands, rail.from);
    const target = bandAt(bands, rail.to);
    if (source !== undefined && target !== undefined && source !== target) {
      pieces.push({ ...ends, ...straight(mergeX(source), forkX(target), y0) });
      continue;
    }
    const yt = rowOf(trackOfStation(rail.from));
    pieces.push({ ...ends, ...straight(lx(rail.from) + 8, lx(rail.to) - 8, yt) });
  }
  return pieces;
}

/**
 * Tracks and leader lines, drawn in the arc layer's SVG (mounted only when there are bands). A
 * travelling segment stacks an extra layer by the same rule arcs always did, except that layer is
 * now **still** light (`MarchLight`): it fades in from the segment's start and is brightest at the
 * lamp end.
 */
export function WorkflowTimelineTracks({
  folded,
  layout,
  model,
}: {
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">;
  layout: TimelineLayout;
  /** A stop folded onto the eave: its leader line fades out together with the lamp. */
  folded: ReadonlySet<number>;
}) {
  const pieces = timelineRailPieces(model, layout);
  // The track layer is hung in the arc layer SVG, and the gradient id must be unique in the entire SVG: instance prefix + segment key (remove `:` `>` these).
  const gradientBase = useId();
  return (
    <g>
      {pieces.map((piece) => (
        <g
          data-rail-from={piece.from}
          data-rail-ink={piece.ink}
          data-rail-kind={piece.kind}
          data-rail-to={piece.to}
          data-testid="workflow-timeline-rail"
          key={piece.key}
        >
          <path
            className="wf-ink"
            d={piece.d}
            fill="none"
            stroke={INK_STROKE[piece.ink]}
            strokeWidth={1}
          />
          {piece.ink === "march" ? (
            <MarchLight
              d={piece.d}
              from={piece.start}
              id={`${gradientBase}lit-${piece.key.replace(/[^\w-]/g, "-")}`}
              to={piece.end}
            />
          ) : null}
        </g>
      ))}
      {model.stations.map((station, i) =>
        station.track === 0 ? null : (
          <path
            className={cn("wf-foldable", folded.has(i) && "wf-folded")}
            d={`M${lampX(i, layout.inset)},${(layout.rowY[station.track] ?? layout.rowY[0]!) + 7} V${layout.capY - 10}`}
            data-leader-station={i}
            data-testid="workflow-timeline-leader"
            fill="none"
            key={station.id}
            stroke="var(--color-workflow-trace)"
            strokeDasharray="1 2"
            strokeLinecap="round"
            strokeWidth={1}
          />
        ),
      )}
    </g>
  );
}

/**
 * The lamp (when there are bands): still a DOM span—the state classes, halo and pulse all live in
 * CSS—only absolutely positioned onto the row of its own track instead of flowing along with the
 * stop heads.
 */
export function WorkflowTimelineLamps({
  draft,
  folded,
  layout,
  stations,
}: {
  stations: readonly TimelineStation[];
  layout: TimelineLayout;
  folded: ReadonlySet<number>;
  draft: boolean;
}) {
  return (
    <>
      {stations.map((station, i) => (
        <span
          aria-hidden
          className={cn(
            stationLampClass(station.status),
            "absolute",
            "wf-foldable",
            folded.has(i) && "wf-folded",
            draft && "wf-land",
          )}
          data-lamp={station.status ?? "pending"}
          data-lamp-track={station.track}
          key={station.id}
          style={{
            left: lampX(i, layout.inset) - 5,
            top: (layout.rowY[station.track] ?? layout.rowY[0]!) - 5,
          }}
        />
      ))}
    </>
  );
}
