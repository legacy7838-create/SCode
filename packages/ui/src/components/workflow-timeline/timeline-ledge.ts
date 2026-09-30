import type { CSSProperties } from "react";
import { lampX, stationX, STATION_WIDTH } from "./timeline-geometry.js";

/**
 * The pure geometry of the ledge: compression at both ends of a rail.
 *
 * The timeline scrolls freely; stations whose lamps scroll past the viewport edge **collapse** onto
 * the ledge on that side — the same 10px lamp, one every 16px, joined by small rail segments in the
 * same ink, resting on a clean backing at the viewport edge. Rail rows fade out over 40px beside
 * the ledge; pills fade only at the viewport boundary. Collapsing is a fixed point: the wider the
 * ledge (the more lamps), the more stations it presses beneath itself, so it is iterated until the
 * set stops changing.
 *
 * Everything is measured in viewport coordinates (x = the station's lamp center − scrollLeft). No
 * React, no DOM.
 */
export const LEDGE_LAMP = 10;
export const LEDGE_PITCH = 16;
export const LEDGE_PAD = 8;
export const LEDGE_FADE = 40;
export const LEDGE_MAX_LAMPS = 3;
/** The width the `+n` count occupies. */
const LEDGE_MORE = 26;
/**
 * The short rail segment from the ledge to the content side is not drawn when it is shorter than
 * that (drawing it would give a dot).
 */
const STUB_MIN = 6;
/** The minimum length of the scrollbar thumb. */
const THUMB_MIN = 24;

export interface TimelineFold {
  /** The stations collapsed onto the left ledge (ascending). */
  left: number[];
  /** The stations collapsed onto the right ledge (ascending). */
  right: number[];
}

export const NO_FOLD: TimelineFold = { left: [], right: [] };

/**
 * The width one side's ledge occupies (including the padding on both sides; 0 lamps = no ledge).
 */
export function ledgeWidth(count: number): number {
  if (count <= 0) return 0;
  const lamps = Math.min(count, LEDGE_MAX_LAMPS) * LEDGE_PITCH - (LEDGE_PITCH - LEDGE_LAMP);
  return LEDGE_PAD + lamps + (count > LEDGE_MAX_LAMPS ? LEDGE_MORE : 0) + LEDGE_PAD;
}

/**
 * The collapse set: the stations whose lamp lies under "ledge + fade"; iterated to a fixed point.
 * When the viewport is not measured (width 0) nothing is collapsed. `keep` is the station the
 * camera is flying to: the viewport was measured before `scrollTo`, so during the few hundred
 * milliseconds of the smooth scroll it counts as off-screen under the stale scrollLeft — yet it is
 * about to come in, and flashing a lamp on the ledge would be a false positive, so neither side
 * takes it. `inset` is the rightward shift of the whole rail when a band is present: the lamps move
 * with it, and so does the criterion for collapsing.
 */
export function foldStations(
  count: number,
  scrollLeft: number,
  clientWidth: number,
  keep?: number,
  inset = 0,
): TimelineFold {
  if (count === 0 || clientWidth <= 0) return NO_FOLD;
  const xs = Array.from({ length: count }, (_, i) => lampX(i, inset) - scrollLeft);
  let left: number[] = [];
  let right: number[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const lw = left.length === 0 ? 0 : ledgeWidth(left.length) + LEDGE_FADE;
    const rw = right.length === 0 ? 0 : ledgeWidth(right.length) + LEDGE_FADE;
    const nextLeft = xs.flatMap((x, i) => (x < lw && i !== keep ? [i] : []));
    const nextRight = xs.flatMap((x, i) =>
      x > clientWidth - rw && i !== keep && !nextLeft.includes(i) ? [i] : [],
    );
    if (nextLeft.length === left.length && nextRight.length === right.length) break;
    left = nextLeft;
    right = nextRight;
  }
  return left.length === 0 && right.length === 0 ? NO_FOLD : { left, right };
}

/**
 * The lamps exposed on the ledge (at most three, preferring the content-side end) and the count.
 */
export function ledgeLamps(
  indexes: readonly number[],
  side: "left" | "right",
): { shown: number[]; more: number } {
  const more = Math.max(0, indexes.length - LEDGE_MAX_LAMPS);
  const shown =
    more === 0
      ? [...indexes]
      : side === "left"
        ? indexes.slice(more)
        : indexes.slice(0, LEDGE_MAX_LAMPS);
  return { shown, more };
}

/**
 * The width of the short rail segment between the ledge and the first open station: for the left
 * ledge, from the ledge's inner edge to 6px before that station's lamp; for the right ledge, from
 * the **slot tail** of the last open station (not the lamp — otherwise it would cut straight across
 * that station's header text) to the ledge's inner edge. Not drawn when shorter than 6.
 */
export function ledgeStubWidth(
  fold: TimelineFold,
  side: "left" | "right",
  scrollLeft: number,
  clientWidth: number,
  inset = 0,
): number {
  const indexes = side === "left" ? fold.left : fold.right;
  if (indexes.length === 0) return 0;
  const inner = ledgeWidth(indexes.length) - LEDGE_PAD;
  let width: number;
  if (side === "left") {
    const open = indexes[indexes.length - 1]! + 1;
    width = lampX(open, inset) - scrollLeft - STUB_MIN - inner;
  } else {
    const open = indexes[0]! - 1;
    width = clientWidth - inner - (stationX(open, inset) + STATION_WIDTH - scrollLeft);
  }
  return width < STUB_MIN ? 0 : Math.round(width);
}

/**
 * Whether each side of the viewport still has content outside it (left: scrolled past; right: not
 * scrolled to the end).
 */
export interface EdgeOverflow {
  left: boolean;
  right: boolean;
}

/**
 * The scroll layer's mask, split into **two horizontal bands** (user revision: pills fade only at
 * the real boundary, moving in and out together with their own station's lamp):
 * - The rail band (the arc's air + the rail row, height `railBand`): on a side that has a ledge it
 *   is fully transparent under the ledge and then fades to opaque over 40px — the ledge has to rest
 *   on a clean backing; on a side without a ledge but with overflow it fades over 40px starting at
 *   the viewport edge (station header text is not cut hard).
 * - The pill band (the remaining height): it fades over 40px only at the viewport edge, and only
 *   when that side really has content outside. Pills do not collapse along with the lamps
 *   (symmetric on both sides); they stay lit under the ledge, all the way to the boundary. The two
 *   mask layers each occupy one band (no-repeat, cut apart by position / size), and the default add
 *   compositing = union. When neither side overflows there is no mask.
 */
export function timelineMaskStyle(
  fold: TimelineFold,
  railBand: number,
  edges: EdgeOverflow,
): CSSProperties | undefined {
  if (!edges.left && !edges.right) return undefined;
  const edgeLeft = edges.left ? `transparent 0px, #000 ${LEDGE_FADE}px` : "#000 0px";
  const edgeRight = edges.right
    ? `#000 calc(100% - ${LEDGE_FADE}px), transparent 100%`
    : "#000 100%";
  const railLeft =
    fold.left.length > 0
      ? `transparent ${ledgeWidth(fold.left.length) + LEDGE_PAD}px, #000 ${ledgeWidth(fold.left.length) + LEDGE_PAD + LEDGE_FADE}px`
      : edgeLeft;
  const railRight =
    fold.right.length > 0
      ? `#000 calc(100% - ${ledgeWidth(fold.right.length) + LEDGE_PAD + LEDGE_FADE}px), transparent calc(100% - ${ledgeWidth(fold.right.length) + LEDGE_PAD}px)`
      : edgeRight;
  const image = `linear-gradient(90deg, ${railLeft}, ${railRight}), linear-gradient(90deg, ${edgeLeft}, ${edgeRight})`;
  const size = `100% ${railBand}px, 100% calc(100% - ${railBand}px)`;
  const position = `0 0, 0 ${railBand}px`;
  return {
    WebkitMaskImage: image,
    WebkitMaskPosition: position,
    WebkitMaskRepeat: "no-repeat, no-repeat",
    WebkitMaskSize: size,
    maskImage: image,
    maskPosition: position,
    maskRepeat: "no-repeat, no-repeat",
    maskSize: size,
  };
}

/**
 * Scrollbar thumb: length = viewport² / content (never shorter than 24), position by the scroll
 * ratio; absent when there is no overflow.
 */
export function scrollbarThumb(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: number; width: number } | undefined {
  if (clientWidth <= 0 || scrollWidth <= clientWidth) return undefined;
  const width = Math.max(THUMB_MIN, (clientWidth * clientWidth) / scrollWidth);
  const range = scrollWidth - clientWidth;
  const left = ((clientWidth - width) * Math.min(Math.max(scrollLeft, 0), range)) / range;
  return { left: Math.round(left), width: Math.round(width) };
}

/**
 * One leg of the camera's flight: `scrollTo(target)` has been issued but has not landed yet.
 * `index` is not collapsed while flying. `from` is the scrollLeft sampled last time — smooth scroll
 * only approaches the target monotonically, so "farther than last time" means the user has taken
 * over.
 */
export interface CameraFlight {
  index: number;
  /** The landing point already clamped to `scrollWidth − clientWidth`. */
  target: number;
  from: number;
}

/**
 * Whether the flight is still on after one scroll sample: it ends on landing (±1px) or on deviation
 * (the user taking over); otherwise this position is recorded and the flight continues. It is
 * decided purely by the scroll position, with no timer — a smooth scroll interrupted by the user
 * never reaches the target, and a timer fallback would make the target station miss collapsing.
 */
export function flightAfterScroll(
  flight: CameraFlight | undefined,
  scrollLeft: number,
): CameraFlight | undefined {
  if (flight === undefined) return undefined;
  const distance = Math.abs(scrollLeft - flight.target);
  if (distance <= 1) return undefined;
  if (distance > Math.abs(flight.from - flight.target) + 1) return undefined;
  return scrollLeft === flight.from ? flight : { ...flight, from: scrollLeft };
}

/**
 * The camera: the scrollLeft that scrolls a station to the exact center of the viewport (never past
 * 0 on the left). Clicking a lamp on the ledge takes this path.
 */
export function stationCameraLeft(index: number, clientWidth: number, inset = 0): number {
  return Math.max(0, stationX(index, inset) - (clientWidth - STATION_WIDTH) / 2);
}

/**
 * The lookup key of a rail segment: a **pair of stations**, not a start point. One station in a
 * band can grow several segments at once — one on the main line, one on a fork, one on a double
 * segment — and a lookup by start point would return whichever was ordered first.
 */
export function railKey(from: number, to: number): string {
  return `${from}>${to}`;
}
