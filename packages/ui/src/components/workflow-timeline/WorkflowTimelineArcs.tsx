import type { ReactNode } from "react";
import type { TimelineArc, TimelineBand, TimelineInk, TimelineStation } from "./timeline-model.js";
import {
  ARC_BASE,
  ARC_LANE,
  arcEnds,
  arcTerminalOffsets,
  bandAt,
  bandForkX,
  bandMergeX,
  lampX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { MarchLight } from "./WorkflowMarchLight.js";

/**
 * Arc layer: the only layer of SVG in the timeline, only drawn
 * non-adjacent edges. The light from the source station rises to its own arc, traverses to the target station, and falls back to the target light with the arrow pointing downward. The arc end of one station——
 * Landing and takeoff are treated equally - each occupies one slot, and the slot distance is 10px (`arcTerminalOffsets`: the far end is on the left, and the far end is on the right.
 * The lowest lane on each side is the outermost), so the vertical segment going out will not cross the incoming arrow. Draw from source to target on first occurrence
 * (`pathLength=1` makes dashoffset independent of geometry); after that, only the ink color is changed; a layer of immobile light is stacked on the side that is walking
 * (`MarchLight`: gradually brightens toward the end of the light), leaving the action to the light itself.
 *
 * When there is a belt, the belt is **a node**: when the source is in the belt, it takes off from the meeting point of the belt, and the target is in the belt.
 * Just fall on the fork point of the strip (the landing point is 4px earlier, there is no light to stop there). The height of the arc comes from its own **empty** (`arc.air`): the same orbit within the band
 * The arcs live in the space of that orbit, and the arcs across orbits and stages all live in the top layer of space. Track segments are also moved into this level (`children`).
 *
 * The vertical segment of the arc of the band goes all the way to the endpoint of its own line: the source is the station taking off from its row of lights, the source is the band starting from the meeting point on the main line
 * Take-off; the landing point is the same, it is the bifurcation point on the main line or the row of target lights. Rule 3 of the Loops board says vertical segments "cross the branch lines and follow those
 * "Empty rows" - nothing passes through the edge of the top track. Instead, there is a whole row between the lights on the main line and its own arc.
 * It reads disconnected. The generator of the design canvas stops at `rowY[R−1]` to save trouble, not design.
 */
const INK_STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-workflow-trace-strong)",
  strong: "var(--color-workflow-trace-strong)",
};

export function WorkflowTimelineArcs({
  arcs,
  bands,
  children,
  height,
  layout,
  markerId,
  stations,
  width,
}: {
  arcs: readonly TimelineArc[];
  bands: readonly TimelineBand[];
  /** All stations (not the section cut by the draft): The subscript of the arc points to it, and the orbit of each station is to be read. */
  stations: readonly TimelineStation[];
  layout: TimelineLayout;
  width: number;
  height: number;
  markerId: string;
  children?: ReactNode;
}) {
  const terminals = arcTerminalOffsets(arcs, bands, stations);
  const { inset, rowY } = layout;
  const rowOf = (track: number): number => rowY[track] ?? rowY[0]!;
  const trackOf = (index: number): number => stations[index]?.track ?? 0;
  return (
    <svg
      aria-hidden
      className="absolute left-0 top-0 overflow-visible"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <defs>
        {(["faint", "strong"] as const).map((ink) => (
          <marker
            id={`${markerId}-${ink}`}
            key={ink}
            markerHeight="6"
            markerWidth="6"
            orient="auto-start-reverse"
            refX="7"
            refY="4"
            viewBox="0 0 8 8"
          >
            <path d="M0,0.5 L7,4 L0,7.5 Z" fill={INK_STROKE[ink]} />
          </marker>
        ))}
      </defs>
      {children}
      {arcs.map((arc, j) => {
        // The arcs of the same track in the band live entirely in the space of that track, with lights at both ends; the remaining arcs treat the band as a node (`arcEnds`).
        const { fromBand, toBand } = arcEnds(arc, bands, stations);
        const source = bandAt(bands, arc.from);
        const target = bandAt(bands, arc.to);
        const ly = rowOf(arc.air) - ARC_BASE - ARC_LANE * arc.lane;
        // Each end of the lamp has its own slot; the bifurcation point and the converging point are one point, not a row of lamps, and do not occupy a slot (the offset is always 0).
        const xa =
          fromBand && source !== undefined
            ? bandMergeX(source, inset)
            : lampX(arc.from, inset) + terminals.takeoff[j]!;
        const xb =
          toBand && target !== undefined
            ? bandForkX(target, inset)
            : lampX(arc.to, inset) + terminals.landing[j]!;
        const sign = xb < xa ? -1 : 1;
        // Take-off and landing are attached to the **endpoint own row**: the belt is the meeting point/divergence point of the main line, and the station is the row of its lights.
        const ya = fromBand ? rowY[0]! - 3 : rowOf(trackOf(arc.from)) - 7;
        const yb = toBand ? rowY[0]! - 4 : rowOf(trackOf(arc.to)) - 9;
        const tail = `V${yb}`;
        const path = `M${xa},${ya} V${ly + 8} Q${xa},${ly} ${xa + 8 * sign},${ly} H${xb - 8 * sign} Q${xb},${ly} ${xb},${ly + 8} ${tail}`;
        const ink = arc.ink === "march" ? "strong" : arc.ink;
        return (
          <g
            data-arc-from={arc.from}
            data-arc-ink={arc.ink}
            data-arc-to={arc.to}
            data-testid="workflow-timeline-arc"
            key={`${arc.from}-${arc.to}-${arc.air}`}
          >
            <path
              className="wf-ink wf-draw"
              d={path}
              fill="none"
              markerEnd={`url(#${markerId}-${ink})`}
              pathLength={1}
              stroke={INK_STROKE[ink]}
              strokeWidth={1}
            />
            {arc.ink === "march" ? (
              // The traveling light is 6px shorter and stops at the base of the arrow.
              <MarchLight
                d={`${path.slice(0, -tail.length)}V${yb - 6}`}
                from={{ x: xa, y: ya }}
                id={`${markerId}-lit-${j}`}
                to={{ x: xb, y: yb - 6 }}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
