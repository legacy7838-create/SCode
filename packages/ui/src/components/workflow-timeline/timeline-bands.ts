/**
 * Bands and tracks.
 *
 * The `alongside` reported by the analyzer is a **node fact**: when entering this phase, the
 * strands of other phases that have not yet joined are still running. Here it is folded into a
 * **band** on screen — a stretch of consecutive phases in declaration order, split internally into
 * several **tracks**, where track 0 is the main line (the bottom row) and branch tracks stack above
 * it. A band forks before it and joins after it; an arc treats the whole band as **one node**.
 *
 * Indices only — no ids, no ink, no pixels: the timeline model and the side pane's mini run line
 * share the same folding, and the latter has only the index space of `phaseNames`, with no display
 * graph.
 */

/** One band: every stop in the closed interval `[from, to]`; `tracks[0]` is the main line. */
export interface PhaseBand {
  from: number;
  to: number;
  tracks: number[][];
}

/**
 * Folds stops into bands. `alongside[i]` = the indices of the stops running alongside stop i
 * (out-of-range, self-referencing and unlisted entries are all treated as "not stated").
 *
 * 1. Symmetrized: `alongside` can only be reported by the later stop (when entering B, A is still
 *    running, and A's payload has no B), but on screen the two stops are peers.
 * 2. Connected components of `~` with >= 2 members yield the interval `[min, max]`; intersecting
 *    intervals are merged; gaps inside an interval count as members too (for robustness — this
 *    cannot occur when there are no cycles).
 * 3. Tracks are a greedy coloring of the interval graph, in **declaration order**: each member
 *    drops onto the lowest track that has no member running alongside it, otherwise a new track is
 *    opened. The first member therefore always lands on track 0.
 */
export function foldPhaseBands(
  count: number,
  alongside: readonly (readonly number[])[],
): PhaseBand[] {
  const near = Array.from({ length: Math.max(0, count) }, () => new Set<number>());
  for (let i = 0; i < near.length; i += 1) {
    for (const j of alongside[i] ?? []) {
      if (!Number.isInteger(j) || j < 0 || j >= near.length || j === i) continue;
      near[i]!.add(j);
      near[j]!.add(i);
    }
  }

  const seen = Array.from({ length: near.length }, () => false);
  const spans: { from: number; to: number }[] = [];
  for (let root = 0; root < near.length; root += 1) {
    if (seen[root] === true || near[root]!.size === 0) continue;
    let from = root;
    let to = root;
    const stack = [root];
    seen[root] = true;
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (i < from) from = i;
      if (i > to) to = i;
      for (const j of near[i]!) {
        if (seen[j] === true) continue;
        seen[j] = true;
        stack.push(j);
      }
    }
    spans.push({ from, to });
  }

  spans.sort((left, right) => left.from - right.from);
  const merged: { from: number; to: number }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }

  return merged.map((span) => {
    const tracks: number[][] = [];
    for (let i = span.from; i <= span.to; i += 1) {
      const free = tracks.find((members) => !members.some((member) => near[i]!.has(member)));
      if (free === undefined) tracks.push([i]);
      else free.push(i);
    }
    return { from: span.from, to: span.to, tracks };
  });
}

/** The band stop i belongs to; undefined when it is outside any band. */
export function bandOf<T extends PhaseBand>(bands: readonly T[], i: number): T | undefined {
  return bands.find((band) => band.from <= i && i <= band.to);
}

/** The track stop i belongs to; always 0 (the main line) when outside a band. */
export function trackOf(bands: readonly PhaseBand[], i: number): number {
  const track = bandOf(bands, i)?.tracks.findIndex((members) => members.includes(i));
  return track === undefined || track < 0 ? 0 : track;
}

/** The kind of track segment; absent = an ordinary segment on a single track. */
export type TimelineRailKind = "fork" | "merge" | "twin";

export interface RailSpec {
  from: number;
  to: number;
  kind?: TimelineRailKind;
}

export interface ArcSpec {
  from: number;
  to: number;
  /**
   * Which track's air it is drawn in: arcs on the same track inside a band use that track's air,
   * everything else uses the topmost track's air.
   */
  air: number;
}

/**
 * The band plus its two on-screen endpoints: the predecessor stop where it forks and the successor
 * stop where it joins.
 */
export interface BoundBand extends PhaseBand {
  pred?: number;
  join?: number;
}

export interface PhaseEdgeFold {
  bands: BoundBand[];
  rails: RailSpec[];
  arcs: ArcSpec[];
}

/**
 * A band's fork / join: the immediately adjacent stop that is **outside the band** and has an edge
 * to any member of the band. Two adjacent bands do not count — between them there is a plain track.
 */
function bindBands(
  count: number,
  bands: readonly PhaseBand[],
  edges: readonly { from: number; to: number }[],
): BoundBand[] {
  const outside = (i: number): boolean => i >= 0 && i < count && bandOf(bands, i) === undefined;
  return bands.map((band) => {
    const before = band.from - 1;
    const after = band.to + 1;
    const pred =
      outside(before) &&
      edges.some((edge) => edge.from === before && bandOf(bands, edge.to) === band);
    const join =
      outside(after) &&
      edges.some((edge) => edge.to === after && bandOf(bands, edge.from) === band);
    return {
      ...band,
      ...(join ? { join: after } : {}),
      ...(pred ? { pred: before } : {}),
    };
  });
}

/**
 * The track segments that grow out of the band itself: adjacent members on the same track
 * (**unconditionally** — one track is one strand), forks, joins, and double segments.
 */
function bandRails(bands: readonly BoundBand[]): RailSpec[] {
  const rails: RailSpec[] = [];
  for (const band of bands) {
    band.tracks.forEach((members, track) => {
      for (let k = 1; k < members.length; k += 1) {
        rails.push({ from: members[k - 1]!, to: members[k]! });
      }
      if (band.pred !== undefined) {
        rails.push({
          from: band.pred,
          ...(track === 0 ? {} : { kind: "fork" as const }),
          to: members[0]!,
        });
      }
      if (band.join !== undefined) {
        rails.push({
          from: members[members.length - 1]!,
          ...(track === 0 ? {} : { kind: "merge" as const }),
          to: band.join,
        });
      }
    });
    // Double line segment: Two stations in the band that are adjacent in sequence but are not on the same track. Only the shelves and sidebars read it, never the march.
    for (let i = band.from; i < band.to; i += 1) {
      if (trackOf(bands, i) !== trackOf(bands, i + 1))
        rails.push({ from: i, kind: "twin", to: i + 1 });
    }
  }
  return rails;
}

/**
 * Edges -> track segments and arcs. A band eats part of the edges: forks and joins already say
 * "control passed through here", so only the rest become arcs, and an arc's endpoints are
 * **reattached** to the band's two ends — a band is one node.
 */
export function foldPhaseEdges(
  count: number,
  folded: readonly PhaseBand[],
  edges: readonly { from: number; to: number }[],
): PhaseEdgeFold {
  const bands = bindBands(count, folded, edges);
  const top = Math.max(1, ...bands.map((band) => band.tracks.length)) - 1;
  const rails = bandRails(bands);
  const arcs: ArcSpec[] = [];
  for (const edge of edges) {
    const source = bandOf(bands, edge.from);
    const target = bandOf(bands, edge.to);
    if (source === undefined && target === undefined) {
      if (edge.to === edge.from + 1) rails.push({ from: edge.from, to: edge.to });
      else arcs.push({ air: top, from: edge.from, to: edge.to });
      continue;
    }
    if (source !== undefined && source === target) {
      const track = trackOf(bands, edge.from);
      if (track !== trackOf(bands, edge.to)) {
        // Cross-track: The forward side bifurcation has already been said; the backward one is the self-looping of the entire belt.
        if (edge.to < edge.from) arcs.push({ air: top, from: source.to, to: source.from });
        continue;
      }
      const members = source.tracks[track]!;
      // Same orbit and next to each other: the strand is already there, no need to draw it again.
      if (members[members.indexOf(edge.from) + 1] !== edge.to) {
        arcs.push({ air: track, from: edge.from, to: edge.to });
      }
      continue;
    }
    // Outgoing/incoming belt: The one immediately adjacent has been absorbed by the convergence/bifurcation, and the rest are re-hung to both ends of the belt.
    if (source !== undefined && target === undefined && edge.to === source.to + 1) continue;
    if (source === undefined && target !== undefined && edge.from === target.from - 1) continue;
    const from = source === undefined ? edge.from : source.to;
    const to = target === undefined ? edge.to : target.from;
    if (source !== undefined && target !== undefined && source.to + 1 === target.from) {
      rails.push({ from, to });
      continue;
    }
    arcs.push({ air: top, from, to });
  }
  return {
    arcs: dedupe(arcs, (arc) => `${arc.air}:${arc.from}>${arc.to}`),
    bands,
    rails: order(rails),
  };
}

function dedupe<T extends { from: number; to: number }>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.from === item.to || seen.has(key(item))) return false;
    seen.add(key(item));
    return true;
  });
}

/**
 * Track segments are ordered by left end, then by right end; with no bands the order is item for
 * item identical to the one derived stop by stop as before.
 */
function order(rails: RailSpec[]): RailSpec[] {
  return dedupe(rails, (rail) => `${rail.from}>${rail.to}:${rail.kind ?? ""}`).sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
}

/**
 * The number of arc lanes (the highest lane + 1); the rendering layer reserves height for the arcs
 * based on it.
 */
export function arcLaneCount(arcs: readonly { lane: number }[]): number {
  return arcs.reduce((max, arc) => Math.max(max, arc.lane + 1), 0);
}

/**
 * Arc lane assignment: a greedy coloring of the interval graph. Arcs go, shortest span to longest
 * (payload order kept on ties), onto the **lowest free lane** — "free" = the arcs already on that
 * lane do **not** intersect it at the stop indices (closed intervals: even sharing a single
 * endpoint counts as intersecting, because the vertical pieces of two arcs at the same stop join
 * into one line). Hence: unrelated arcs share a height; nested arcs are short inside and tall
 * outside (the short one lands first, the long one can only go up); only genuinely crossing arcs
 * get pushed up.
 *
 * The earlier formulation was "the k-th arc is lane k": two back edges, each at one end and
 * unrelated to each other, would still end up at different heights, and a reader would go looking
 * for the reason behind it — which does not exist.
 */
export function assignArcLanes(
  pairs: readonly { from: number; to: number }[],
): { from: number; to: number; lane: number }[] {
  const placed: { lo: number; hi: number; lane: number }[] = [];
  return pairs.map((pair) => {
    const lo = Math.min(pair.from, pair.to);
    const hi = Math.max(pair.from, pair.to);
    const taken = new Set(
      placed
        .filter((other) => Math.max(lo, other.lo) <= Math.min(hi, other.hi))
        .map((other) => other.lane),
    );
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    placed.push({ hi, lane, lo });
    return { from: pair.from, lane, to: pair.to };
  });
}

/**
 * Colored separately per `air`: only that track's arcs live in a track's air, cross-track arcs all
 * live in the topmost layer of air, and arcs in the two layers of air yield to each other even when
 * they intersect in x. Returns lane numbers that correspond one-to-one with the inputs.
 */
export function assignAirLanes(arcs: readonly ArcSpec[]): number[] {
  const lanes = Array.from({ length: arcs.length }, () => 0);
  for (const air of new Set(arcs.map((arc) => arc.air))) {
    const group = arcs.flatMap((arc, at) => (arc.air === air ? [{ ...arc, at }] : []));
    assignArcLanes(group).forEach((placed, k) => {
      lanes[group[k]!.at] = placed.lane;
    });
  }
  return lanes;
}
