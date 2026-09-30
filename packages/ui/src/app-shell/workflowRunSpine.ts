import type {
  TimelineInk,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";

/**
 * Spine layout: translates the timeline model into the vertical rails and curves that **each
 * segment** has to draw. A pure function over indices and pixel offsets only, no React and no DOM —
 * renderers just draw what it says.
 *
 * The vertical rail of track t sits at `x = 21 + 12t`; a branch track inside a band leaves the main
 * rail 13px below the top of the band's first segment with a fork curve, runs straight down to the
 * top of the merge station's segment (with no merge station, to the bottom of the band's last
 * segment), then returns to the main rail with a mirrored curve. In a branch station's segment the
 * main rail still passes through as usual, and the ink is that of the main-line segment spanning it
 * — control flow really does run through there, it is only this segment's lamp that is not on the
 * main line.
 *
 * Track segments are always looked up in **pairs** (`from → to`), never indexed by `from`: inside a
 * band one station can be the left end of a dual-line segment and the left end of a main-line
 * segment at the same time, so `from` is no longer unique.
 */

/** Height the fork / merge curves occupy. */
const SPINE_CURVE_PX = 13;

/**
 * A vertical rail segment. `from` / `to` override the default start and end (px, measured from the
 * segment top / bottom respectively) and exist only to make room for curves.
 */
export interface SpineRailPiece {
  track: number;
  ink: TimelineInk;
  /**
   * `above` = segment top to lamp, `below` = lamp to segment bottom, `full` = through the whole
   * segment.
   */
  position: "above" | "below" | "full";
  from?: number;
  to?: number;
}

/** The 13px by which a branch track leaves / rejoins the main rail. */
export interface SpineCurvePiece {
  kind: "fork" | "merge";
  track: number;
  ink: TimelineInk;
  /**
   * Whether it hugs the segment top or the segment bottom (with no merge station, the merge is
   * drawn at the bottom of the band's last segment).
   */
  at: "top" | "bottom";
}

export interface SpineSection {
  rails: SpineRailPiece[];
  curves: SpineCurvePiece[];
}

export function spineSections(model: WorkflowTimelineModel): SpineSection[] {
  const sections: SpineSection[] = model.stations.map(() => ({ curves: [], rails: [] }));
  const trackAt = (i: number): number => model.stations[i]?.track ?? 0;
  const plain = model.rails.filter((rail) => rail.kind === undefined);
  /**
   * The flat rail spanning the i-th segment with both ends on track t (read both by the main rail
   * through a branch station and by a branch track through someone else's station).
   */
  const spanning = (i: number, track: number): TimelineInk | undefined =>
    plain.find(
      (rail) =>
        rail.from < i && i < rail.to && trackAt(rail.from) === track && trackAt(rail.to) === track,
    )?.ink;
  const pairInk = (from: number, to: number): TimelineInk =>
    plain.find((rail) => rail.from === from && rail.to === to)?.ink ?? "faint";

  model.stations.forEach((station, i) => {
    const section = sections[i]!;
    const band =
      station.track === 0 ? undefined : model.bands.find((b) => b.from <= i && i <= b.to);
    const track = band?.tracks[station.track];
    if (track === undefined) {
      // Stations on the main line: As before, the previous station is drawn in the lower half and the next station is drawn in the upper half; if there is no border, leave it blank.
      const above = model.rails.find(
        (rail) => rail.to === i && rail.kind !== "twin" && rail.kind !== "merge",
      );
      const below = model.rails.find(
        (rail) => rail.from === i && rail.kind !== "twin" && rail.kind !== "fork",
      );
      if (above !== undefined) section.rails.push({ ink: above.ink, position: "above", track: 0 });
      if (below !== undefined) section.rails.push({ ink: below.ink, position: "below", track: 0 });
      return;
    }
    // Branch station: read its own track at the top and bottom, and read the incoming and outgoing ink of the track (that is, the ink of the bifurcation/merging section) at the beginning and end.
    const at = track.stations.indexOf(i);
    const previous = track.stations[at - 1];
    const next = track.stations[at + 1];
    section.rails.push({
      ink: previous === undefined ? track.entry : pairInk(previous, i),
      position: "above",
      track: station.track,
    });
    section.rails.push({
      ink: next === undefined ? track.exit : pairInk(i, next),
      position: "below",
      track: station.track,
    });
    const main = spanning(i, 0);
    if (main !== undefined) section.rails.push({ ink: main, position: "full", track: 0 });
  });

  for (const band of model.bands) {
    band.tracks.forEach((track, t) => {
      if (t === 0) return;
      const end = band.join ?? band.to;
      const first = track.stations[0]!;
      const last = track.stations[track.stations.length - 1]!;
      // When there is no merging station, the merging is drawn on the bottom with the end section, and the vertical rail of that section should be 13px shorter.
      const tail = band.join === undefined ? SPINE_CURVE_PX : undefined;
      sections[band.from]?.curves.push({ at: "top", ink: track.entry, kind: "fork", track: t });
      sections[end]?.curves.push({
        at: tail === undefined ? "top" : "bottom",
        ink: track.exit,
        kind: "merge",
        track: t,
      });
      for (let i = band.from; i <= end; i += 1) {
        const section = sections[i];
        if (section === undefined) continue;
        if (track.stations.includes(i)) {
          if (tail !== undefined && i === end) {
            for (const rail of section.rails) {
              if (rail.track === t && rail.position === "below") rail.to = tail;
            }
          }
          continue;
        }
        // When there is a merging station, the top of the merging section is a curve, and there is no vertical section to pass through.
        if (i === end && tail === undefined) continue;
        const ink =
          i < first ? track.entry : i > last ? track.exit : (spanning(i, t) ?? track.exit);
        section.rails.push({
          ink,
          position: "full",
          track: t,
          ...(i === band.from ? { from: SPINE_CURVE_PX } : {}),
          ...(tail !== undefined && i === end ? { to: tail } : {}),
        });
      }
    });
  }
  return sections;
}
