import { arcLaneCount } from "./timeline-bands.js";
import type { TimelineArc, TimelineBand, TimelineStation } from "./timeline-model.js";

/**
 * Geometry constants for the horizontal timeline. Word-for-word identical to the design canvas:
 * station width 168, station gap 24, the lamp lands at the station's left edge + 17 (the pill
 * avatar column). It is a file of its own because the eave's pure geometry has to read them, and it
 * must not depend back on the rendering components.
 */
export const STATION_WIDTH = 168;
export const STATION_GAP = 24;
export const STATION_PITCH = STATION_WIDTH + STATION_GAP;
/** Distance from a station's left edge to its lamp center: outer margin 12 + radius 5. */
export const MARK_X = 17;

/** Rail row height. */
export const RAIL_ROW = 24;
/** Height difference between two adjacent lanes. */
export const ARC_LANE = 14;
/**
 * Height of the lowest lane above the rail centerline. It has to be big enough to hold: the 8px
 * corner radius plus the vertical run that lands (the arrow is 5.25 long, and leaving a few more
 * pixels of straight line is what makes the arrow look like it fell from above). It used to be 16:
 * with the radius eating 8, the vertical run was left with −1px — the last segment actually went up
 * by one pixel, `marker-end` pointed up with it, and the arrow "disappeared".
 */
export const ARC_BASE = 26;
/** Spacing between two adjacent arc terminals (takeoff or landing) on the same lamp. */
export const TERMINAL_PITCH = 10;
export const PILL_HEIGHT = 32;
export const PILL_GAP = 6;

/**
 * The platform row: only a timeline with bands has one — a 24px row that the station caption (name
 * + metadata) moved into from the rail row, because the main line sits directly above it and only
 * stations on a branch rail need a leader line.
 */
export const PLATFORM_ROW = 24;
/**
 * Left edge of the name on the platform: the same value as the lamp's outer margin, so the lamp,
 * the name and the pill avatars line up on one vertical spine.
 */
export const CAPTION_X = 12;
/**
 * Distance from a fork point to the left edge of the first station; each higher branch rail shifts
 * 8 further left.
 */
export const FORK_BACK = 16;
/** Distance from a merge point to the left edge of the merging station (negative = to its left). */
export const MERGE_BACK = 10;
/**
 * Length of the tail stub when there is no predecessor, and of the stub when there is no merge
 * station.
 */
export const TAIL = 4;
export const STUB = 6;

export function timelineWidth(count: number, inset = 0): number {
  return count === 0 ? 0 : (count - 1) * STATION_PITCH + STATION_WIDTH + inset;
}

/** Left edge of station i. */
export function stationX(index: number, inset = 0): number {
  return index * STATION_PITCH + inset;
}

/** Lamp center of station i. */
export function lampX(index: number, inset = 0): number {
  return stationX(index, inset) + MARK_X;
}

/**
 * The x at which a band forks off the main line; when a band starts at station 0 there is no room
 * on the left, so it lands on 4 (the timeline shifts right by `inset` overall).
 */
export function bandForkX(band: Pick<TimelineBand, "from">, inset = 0): number {
  return band.from === 0 ? TAIL : stationX(band.from, inset) - FORK_BACK;
}

/**
 * The x at which a band merges back into the main line; with no merge station it lands 6px past the
 * end of the last station's slot — that is still where strands meet.
 */
export function bandMergeX(band: Pick<TimelineBand, "join" | "to">, inset = 0): number {
  return band.join === undefined
    ? stationX(band.to, inset) + STATION_WIDTH + STUB
    : stationX(band.join, inset) - MERGE_BACK;
}

/**
 * The band station i sits in; undefined when it is outside any band (the same-named function in
 * `timeline-bands.ts` only knows index bands, this one knows the model's bands).
 */
export function bandAt(bands: readonly TimelineBand[], index: number): TimelineBand | undefined {
  return bands.find((band) => band.from <= index && index <= band.to);
}

/**
 * Where an arc's two ends attach. An arc on the same rail within a band has a lamp at both ends
 * (`inTrack`); every other arc treats the band as a single node: when the source is in a band it
 * takes off from the band's merge point (`fromBand`), and when the target is in a band it lands on
 * the band's fork point (`toBand`). A band's self-loop also has both ends in the same band, but its
 * `air` is the empty space on the topmost level and its landing always sits on rail 0, so it is
 * never taken for `inTrack`.
 */
export interface ArcEnds {
  inTrack: boolean;
  fromBand: boolean;
  toBand: boolean;
}

export function arcEnds(
  arc: Pick<TimelineArc, "air" | "from" | "to">,
  bands: readonly TimelineBand[],
  stations: readonly Pick<TimelineStation, "track">[],
): ArcEnds {
  const source = bandAt(bands, arc.from);
  const target = bandAt(bands, arc.to);
  const trackOf = (index: number): number => stations[index]?.track ?? 0;
  const inTrack =
    source !== undefined &&
    source === target &&
    trackOf(arc.from) === arc.air &&
    trackOf(arc.to) === arc.air;
  return {
    fromBand: !inTrack && source !== undefined,
    inTrack,
    toBand: !inTrack && target !== undefined,
  };
}

/**
 * Slot assignment for arc terminals: both ends of an arc that sit on lamps — the **takeoff** at the
 * source station and the **landing** at the target station — are terminals of that station. Each
 * terminal of a station takes one slot, slots are `TERMINAL_PITCH` apart and centered on the lamp
 * center; a station with only one terminal still uses the lamp center, so a timeline with no
 * conflicts stays pixel-for-pixel unchanged.
 *
 * Previously only landings were offset while takeoffs always sat on the lamp center: when a station
 * had both an incoming and an outgoing arc, the outgoing vertical run passed right through the
 * incoming arrow, the two runs collapsed onto a single line and the arrow got stuck halfway down it
 * (stations Branch A and Branch B in testfield's "Workflow stress test"). Lanes separate the two
 * arcs that share a station in y, but they have nothing to say about x.
 *
 * Slot order, left to right: first the terminals whose far end lies to the **left** of this
 * station, then those whose far end is to the **right**; within each side, the **lowest lane goes
 * outermost**. The vertical run and the horizontal run of an arc form an L that opens toward the
 * far end: a left-opening L goes on the left, a right-opening one on the right, and the two sides'
 * Ls face away from each other and never meet. Within one side, if the lower-bending arc sat on the
 * inside, the vertical run of the higher-bending one would have to cross its horizontal run — that
 * is the lane's closed-interval argument turned ninety degrees. Band fork points and merge points
 * take no slot: a fork point only has landings and a merge point only has takeoffs, so the runs at
 * one point share a single line the way strands do, and no arrow ever sits underneath it.
 *
 * Returns two columns of offsets (px, relative to the lamp center) one-to-one with `arcs`; the side
 * whose endpoint is not a lamp is always 0.
 */
export function arcTerminalOffsets(
  arcs: readonly Pick<TimelineArc, "air" | "from" | "lane" | "to">[],
  bands: readonly TimelineBand[],
  stations: readonly Pick<TimelineStation, "track">[],
): { takeoff: number[]; landing: number[] } {
  const takeoff = arcs.map(() => 0);
  const landing = arcs.map(() => 0);
  interface Terminal {
    arc: number;
    end: "takeoff" | "landing";
    /** −1 when the far end is on the left, 1 when on the right. */
    side: -1 | 1;
    lane: number;
  }
  const byStation = new Map<number, Terminal[]>();
  const add = (station: number, terminal: Terminal): void => {
    const list = byStation.get(station) ?? [];
    list.push(terminal);
    byStation.set(station, list);
  };
  arcs.forEach((arc, j) => {
    const ends = arcEnds(arc, bands, stations);
    if (!ends.fromBand) {
      add(arc.from, { arc: j, end: "takeoff", lane: arc.lane, side: arc.to > arc.from ? 1 : -1 });
    }
    if (!ends.toBand) {
      add(arc.to, { arc: j, end: "landing", lane: arc.lane, side: arc.from > arc.to ? 1 : -1 });
    }
  });
  for (const list of byStation.values()) {
    // When arcs at the same station and on the same floor intersect two by two (closed intervals), the lanes must be different; stable sequencing allows the arc sequence to be guaranteed.
    list.sort(
      (left, right) =>
        left.side - right.side || (left.side < 0 ? left.lane - right.lane : right.lane - left.lane),
    );
    list.forEach((terminal, k) => {
      const offset = (k - (list.length - 1) / 2) * TERMINAL_PITCH;
      if (terminal.end === "takeoff") takeoff[terminal.arc] = offset;
      else landing[terminal.arc] = offset;
    });
  }
  return { landing, takeoff };
}

/**
 * The timeline's rows: each rail's centerline, the platform row, the top of the pill column, and
 * the overall right shift.
 */
export interface TimelineLayout {
  /** Centerline y of each rail, index = rail number; `rowY[0]` is the main line (the bottom row). */
  rowY: number[];
  /**
   * Centerline of the platform row; it degrades to the main-line row when there are no bands,
   * because the station caption is still on the rail row then.
   */
  capY: number;
  /** Top of the pill column. */
  pillsTop: number;
  /**
   * How far the whole rail shifts right: 12 when a band starts at station 0 (the fork needs
   * somewhere to land), otherwise 0.
   */
  inset: number;
  /** There are bands on screen. */
  banded: boolean;
}

/**
 * Row layout: from top to bottom `t = R−1 … 0`, each rail first reserves its own **air** (the arc
 * lanes), then a 24px rail row; the main line therefore lands at the very bottom, right next to the
 * platform row. Air is computed from the number of lanes in that level's gap: with no arcs the
 * topmost level keeps 6px of breathing room and the rest are 0. With no bands R = 1, and the whole
 * formula falls back pixel-for-pixel to the old "lanes + rail row".
 */
export function timelineLayout(
  arcs: readonly TimelineArc[],
  bands: readonly TimelineBand[],
): TimelineLayout {
  const banded = bands.length > 0;
  const tracks = banded ? Math.max(2, ...bands.map((band) => band.tracks.length)) : 1;
  const rowY: number[] = [];
  let y = 0;
  for (let t = tracks - 1; t >= 0; t -= 1) {
    const lanes = arcLaneCount(arcs.filter((arc) => arc.air === t));
    // The top line of the highest lane falls at y = 8: rowY = air + RAIL_ROW/2 = 8 + ARC_BASE + ARC_LANE × (lanes − 1).
    const air =
      lanes === 0
        ? t === tracks - 1
          ? 6
          : 0
        : 8 + ARC_BASE - RAIL_ROW / 2 + ARC_LANE * (lanes - 1);
    y += air;
    rowY[t] = y + RAIL_ROW / 2;
    y += RAIL_ROW;
  }
  const capY = banded ? y + PLATFORM_ROW / 2 : rowY[0]!;
  if (banded) y += PLATFORM_ROW;
  return {
    banded,
    capY,
    inset: banded && bands.some((band) => band.from === 0) ? CAPTION_X : 0,
    pillsTop: y + 8,
    rowY,
  };
}
