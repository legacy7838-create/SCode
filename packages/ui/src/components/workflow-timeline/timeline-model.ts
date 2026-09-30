import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { laneRefsById, type LaneRef } from "@/components/workflow-graph/lane-name.js";
import {
  collapseStatuses,
  liveParticipantView,
  participantStatus,
  participantsOfPhase,
  withImplicitPhase,
} from "@/components/workflow-graph/participant-model.js";
import { phaseBinder } from "@/components/workflow-graph/instance-phases.js";
import { phaseNameMatches, type PhaseNaming } from "@/components/workflow-graph/phase-name.js";
import { phaseMembers } from "@/components/workflow-graph/phase-model.js";
import { workflowRunOverlay } from "@/components/workflow-graph/run-status.js";
import {
  laneClassOf,
  type LaneClass,
  type StepRunStatus,
  type WorkflowCausalityGraphData,
} from "@/components/workflow-graph/types.js";
import { sharedTimelineModel } from "./timeline-cache.js";
import {
  observePhase,
  phaseEntryFor,
  siteIdsOf,
  stationUnlisted,
  type StationUnlisted,
} from "./station-observation.js";
import {
  assignAirLanes,
  bandOf,
  foldPhaseBands,
  foldPhaseEdges,
  trackOf,
  type RailSpec,
  type TimelineRailKind,
} from "./timeline-bands.js";

/**
 * The timeline model.
 *
 * One pure function folds the bounded display and the `workflowRuns` projection into three things:
 * stations (phases), track segments (between two adjacent stations that have an edge between them),
 * and arcs (non-adjacent edges). Chat cards, the confirmation dialog, and the sidebar list all
 * start from here — invariant 1, "one model, three consumers". No React, no DOM, no time.
 *
 * Order is **declaration order** (the payload's `phases[]` = the order of the first `phase()`
 * markers), no longer ranked: two sibling phases that only share a predecessor line up in one
 * column in declaration order, and the edge between them becomes an arc. Back edges are decided by
 * **direction** (the target station is on the left) and do not read the payload's `back` — the
 * analyzer marks a re-entry (a second `phase("plan")` marker) as a forward edge, yet on screen it
 * still points left.
 */

export type TimelineInk = "faint" | "strong" | "march";
export type { TimelineRailKind } from "./timeline-bands.js";
// The lane splitting of arcs is pure subscripted combinatorics, and lives with the folding of bands in timeline-bands.ts; here, when rolled out, the entrance to the rendering layer remains unchanged.
export { arcLaneCount, assignArcLanes } from "./timeline-bands.js";

export interface TimelinePill {
  /**
   * The split participant id (instance card `${participant}@${ordinal}`); also the React key and
   * the handle for opening the instance.
   */
  key: string;
  lane: LaneRef;
  laneClass: LaneClass;
  /**
   * The runtime name emitted by the engine (a persona may rewrite the name from the script); when
   * absent, render the lane display name.
   */
  runtimeName?: string;
  /** The avatar number assigned by agent identity within a workflow, reused across phases. */
  avatarIndex?: number;
  /** undefined when there is no run (a static pill, pixel-identical to pending). */
  status: StepRunStatus | undefined;
  /**
   * The instance this pill corresponds to in the projection; synthetic lanes (workspace / unknown)
   * have none.
   */
  instance?: { siteId: string; ordinal: number; sessionId?: string };
  /**
   * The slot identity a pill hands off: with an instance it is that instance's ordinal; without one
   * it is the ordinal it *will* have — member cards use `member.index + 1`, single cards and `many`
   * cards use 1 (the engine numbers by station order). Only agent lanes in a live run have it; with
   * it, a subagent that has not started yet can still open a placeholder transcript tab.
   */
  slot?: { siteId: string; ordinal: number };
  /**
   * The handle a script pill hands off: it has no instance and no session; what it can open is the
   * **script transcript of the whole run**, landing on the first card of this station. Mutually
   * exclusive with `slot`: only workspace lanes in a live run have it; with no run there is nothing
   * to open.
   */
  workspace?: { phaseId: string };
  /**
   * The step id of this participant in the current phase (activity and count material for sidebar
   * rows).
   */
  stepIds: string[];
  /**
   * Whether the instance has escalation questions awaiting an answer (`run.pendingQuestions`); the
   * roster's pinning rule reads it.
   */
  asking?: true;
}

export interface TimelineStation {
  id: string;
  naming: PhaseNaming;
  pills: TimelinePill[];
  /** The fold of member step states; undefined when there is no run. */
  status: StepRunStatus | undefined;
  /** Whether any node in the projection sits on a station of this station. */
  visited: boolean;
  /** The largest ordinal among nodes on the stations of this station; 0 = not reached. */
  rounds: number;
  /**
   * Whether it is the source or the target of any back edge (a leftward arc) — only such stations
   * show `⟳ n`.
   */
  onLoop: boolean;
  /**
   * The track it belongs to (`timeline-bands.ts`); outside any band it is always 0, i.e. the main
   * line.
   */
  track: number;
  /**
   * `settled / observed`; absent when not a single node has been observed. Settled off-roster
   * instances are counted in these two numbers too.
   */
  fraction?: { settled: number; observed: number };
  /**
   * The off-roster entries the frontier spent at this station (`station-observation.ts`); absent
   * when it spent none.
   */
  unlisted?: StationUnlisted;
  /** The last station not yet closed in the streaming draft. */
  typing?: true;
}

/**
 * A stretch of track between two head-to-tail stations on one track; the index points into
 * `stations`.
 */
export interface TimelineRail {
  from: number;
  to: number;
  ink: TimelineInk;
  /**
   * Absent = an ordinary segment on a single track; a band's two ends are `fork` / `merge`, and two
   * adjacent stations that cross tracks inside a band are `twin`.
   */
  kind?: TimelineRailKind;
}

/**
 * A non-adjacent edge: `to < from` makes it a back edge. `lane` starts at 0 and the lane hugging
 * the track is 0; only arcs that **intersect** on x get separate lanes (see {@link
 * assignArcLanes}), while arcs unrelated to each other sit at the same height.
 */
export interface TimelineArc {
  from: number;
  to: number;
  lane: number;
  ink: TimelineInk;
  /**
   * The airspace above which track it is drawn in; lanes are assigned per airspace on their own, so
   * `arcLaneCount` has to be filtered by `air` first.
   */
  air: number;
}

/** A track inside a band; `stations` are its members, in declaration order. */
export interface TimelineTrack {
  stations: number[];
  /**
   * The ink by which a fork enters this track; with no predecessor, whether the first station has
   * been reached.
   */
  entry: TimelineInk;
  /**
   * The ink by which this track merges out; with no merge station, whether the last station has
   * been reached.
   */
  exit: TimelineInk;
}

/**
 * A band: a run of stations contiguous in declaration order, split across several tracks; arcs
 * treat it as a single node (`timeline-bands.ts`).
 */
export interface TimelineBand {
  from: number;
  to: number;
  /**
   * The predecessor station holding the fork; when absent, only a short stub of a tail is left on
   * screen.
   */
  pred?: number;
  /**
   * The successor station holding the merge; when absent, only a short stub of a dangling segment
   * is left on screen.
   */
  join?: number;
  tracks: TimelineTrack[];
}

export interface WorkflowTimelineModel {
  stations: TimelineStation[];
  rails: TimelineRail[];
  arcs: TimelineArc[];
  /**
   * The bands folded out of parallel phases, in ascending `from`; a timeline with no `alongside` is
   * empty.
   */
  bands: TimelineBand[];
  /** The running station (the rightmost one when there are several); undefined when there is none. */
  runningIndex: number | undefined;
  /** Whether a run projection takes part (decides whether the lamps / ink have anything to say). */
  live: boolean;
  /**
   * Streaming draft: stations are written out word by word by the pen, subagents are only counted
   * and not drawn (`draft-scan.ts`). The analyzer's model has none.
   */
  draft?: { agents: number };
}

/**
 * The association between `currentPhase` and a station, following the same naming rule as
 * `phaseEntryFor`.
 */
function isCurrentPhase(run: WorkflowRunState | undefined, name: string | undefined): boolean {
  return phaseNameMatches(name, run?.currentPhase);
}

/**
 * A station's lamp. Member nodes speak first — running / failed are hard facts; only then does
 * control flow get a say: if this station is the current phase and the run is still going, it is
 * running (before the first ask is dispatched, and after the last ask settles until the next marker
 * arrives, control flow sits at this station); a station where not a single node was observed (zero
 * members, or the whole station skipped) can only be lit by its entry record. `nodeStatus` is the
 * result of the fold, and absent (undefined) means "no nodes" — the fold never invents a pending
 * for a station that control flow never visited.
 */
function stationStatus(
  run: WorkflowRunState | undefined,
  nodeStatus: StepRunStatus | undefined,
  current: boolean,
  entered: boolean,
): StepRunStatus | undefined {
  if (run === undefined) return undefined;
  if (nodeStatus === "running" || nodeStatus === "failed") return nodeStatus;
  const live = run.status === "running" || run.status === "pending";
  if (current && live) return "running";
  // The current phase ends with the final state of run: the failure occurred at this station (regardless of whether it has nodes or not); how to draw canceled and nodes
  // Consistent, also failed.
  if (current) return run.status === "completed" ? "done" : "failed";
  if (nodeStatus !== undefined) return nodeStatus;
  return entered ? "done" : "pending";
}

/**
 * One model, three consumers (invariant 1): cards, the detail page, and the sidebar list all get
 * the **same** model object within one frame, memoized by the object identity of (graph, run) — why
 * identity is the right key is covered in `timeline-cache.ts`. The model is read-only, no consumer
 * mutates it, so sharing doubles as a source of reference stability.
 */
export function buildWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): WorkflowTimelineModel {
  return sharedTimelineModel(input, run, () => computeWorkflowTimeline(input, run));
}

function computeWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): WorkflowTimelineModel {
  const graph = withImplicitPhase(input);
  const phases = graph.phases ?? [];
  const index = new Map(phases.map((phase, i) => [phase.id, i]));
  const members = phaseMembers(graph);
  const overlay = workflowRunOverlay(run, graph);
  const live = liveParticipantView(graph, run);
  const binder = phaseBinder(graph, run);
  const laneRefs = laneRefsById(graph.lanes);
  const sessionByInstance = new Map(
    (run?.actors ?? []).map((actor) => [`${actor.siteId}@${actor.ordinal}`, actor.sessionId]),
  );
  const askingInstances = new Set(
    (run?.pendingQuestions ?? [])
      .filter(
        (question) => question.actorSiteId !== undefined && question.actorOrdinal !== undefined,
      )
      .map((question) => `${question.actorSiteId}@${question.actorOrdinal}`),
  );

  // Edge: First press the subscript to remove duplicates (edges from loops and points to unlisted stages have nothing to say at this granularity), and then hand it over to the folding of the belt——
  // Adjacent ones form orbital segments, the rest form arcs, and the bands that branch and merge are eaten (`timeline-bands.ts`).
  const edges: { from: number; to: number }[] = [];
  const seen = new Set<string>();
  for (const edge of graph.phaseEdges ?? []) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  const folded = foldPhaseBands(
    phases.length,
    phases.map((phase) =>
      (phase.alongside ?? []).flatMap((id) => {
        const at = index.get(id);
        return at === undefined ? [] : [at];
      }),
    ),
  );
  const fold = foldPhaseEdges(phases.length, folded, edges);
  const arcPairs = [...fold.arcs].sort(
    (left, right) => Math.abs(left.from - left.to) - Math.abs(right.from - right.to),
  );
  // The two ends of the return edge are looped; when the endpoint is in the band, the entire band is looped - the band is a node, and the reentry is the entire band.
  const onLoop = new Set<number>();
  for (const arc of arcPairs) {
    if (arc.to >= arc.from) continue;
    for (const end of [arc.from, arc.to]) {
      const band = bandOf(folded, end);
      if (band === undefined) onLoop.add(end);
      else for (let i = band.from; i <= band.to; i += 1) onLoop.add(i);
    }
  }

  // Name hashes collide; consecutive numbers are assigned to instance identities, and the same agent maintains the same avatar across stages.
  const avatarIndexes = new Map<string, number>();
  const stations: TimelineStation[] = phases.map((phase, i) => {
    const memberSteps = members.get(phase.id) ?? [];
    const unlisted = stationUnlisted(run, binder, phase.id);
    const observed = observePhase(
      run,
      siteIdsOf(memberSteps),
      phaseEntryFor(run, phase.name),
      (node) => binder.has(phase.id, node.phaseName),
      unlisted,
    );
    const pills: TimelinePill[] = participantsOfPhase(live.graph, phase.id).map((participant) => {
      const instance = live.instances[participant.id];
      const lane = laneRefs.get(participant.lane) ?? {
        id: participant.lane,
        laneClass: laneClassOf(participant.lane),
      };
      // Collapse to NULL = This subagent did nothing at this stop, this run: Empty is honest. undefined is left only
      // Static pill without run.
      const status =
        run === undefined
          ? undefined
          : (participantStatus(participant, overlay.statuses, live.participantStatuses) ??
            "pending");
      const sessionId =
        instance === undefined
          ? undefined
          : sessionByInstance.get(`${participant.lane}@${instance.ordinal}`);
      const slot =
        run !== undefined && lane.laneClass === "agent"
          ? {
              ordinal: instance?.ordinal ?? (participant.member?.index ?? 0) + 1,
              siteId: participant.lane,
            }
          : undefined;
      const avatarKey = `${participant.lane}@${instance?.ordinal ?? (participant.member?.index ?? 0) + 1}`;
      if (lane.laneClass === "agent" && !avatarIndexes.has(avatarKey)) {
        avatarIndexes.set(avatarKey, avatarIndexes.size);
      }
      return {
        ...(lane.laneClass === "agent" ? { avatarIndex: avatarIndexes.get(avatarKey)! } : {}),
        key: participant.id,
        lane,
        laneClass: lane.laneClass,
        ...(instance?.name === undefined ? {} : { runtimeName: instance.name }),
        status,
        ...(instance === undefined
          ? {}
          : {
              instance: {
                ordinal: instance.ordinal,
                siteId: participant.lane,
                ...(sessionId === undefined ? {} : { sessionId }),
              },
            }),
        ...(slot === undefined ? {} : { slot }),
        ...(run !== undefined && lane.laneClass === "workspace"
          ? { workspace: { phaseId: phase.id } }
          : {}),
        stepIds: [...participant.steps],
        ...(instance !== undefined && askingInstances.has(`${participant.lane}@${instance.ordinal}`)
          ? { asking: true as const }
          : {}),
      };
    });
    return {
      id: phase.id,
      naming: { id: phase.id, ...(phase.name === undefined ? {} : { name: phase.name }) },
      pills,
      status: stationStatus(
        run,
        collapseStatuses(
          memberSteps.map((step) => step.id),
          overlay.statuses,
        ),
        isCurrentPhase(run, phase.name),
        observed.entered,
      ),
      visited: observed.visited,
      rounds: observed.rounds,
      onLoop: onLoop.has(i),
      track: trackOf(folded, i),
      ...(observed.observed === 0
        ? {}
        : { fraction: { observed: observed.observed, settled: observed.settled } }),
      ...(unlisted === undefined ? {} : { unlisted }),
    };
  });

  const visited = (i: number): boolean => stations[i]?.visited === true;
  let runningIndex: number | undefined;
  for (let i = stations.length - 1; i >= 0; i -= 1) {
    if (stations[i]?.status === "running") {
      runningIndex = i;
      break;
    }
  }

  const rails: TimelineRail[] = fold.rails.map((rail: RailSpec) => ({
    from: rail.from,
    ink: visited(rail.from) && visited(rail.to) ? ("strong" as TimelineInk) : "faint",
    ...(rail.kind === undefined ? {} : { kind: rail.kind }),
    to: rail.to,
  }));
  const lanes = assignAirLanes(arcPairs);
  const arcs: TimelineArc[] = arcPairs.map((arc, at) => {
    const back = arc.to < arc.from;
    const strong = back
      ? visited(arc.from) && (stations[arc.to]?.rounds ?? 0) >= 2
      : visited(arc.from) && visited(arc.to);
    return {
      air: arc.air,
      from: arc.from,
      ink: strong ? "strong" : "faint",
      lane: lanes[at] ?? 0,
      to: arc.to,
    };
  });

  // Traveling edge: The edge from the previous resolved phase into the running phase. Projections do not have timestamps, so follow the rule of three
  // Take the most honest one: the return side of reentry > the track segment entering the station > any arc falling on the station.
  // Walk through each station that is running - two tracks in the strip can be running at the same time, and their respective branches should be lit.
  for (let r = 0; r < stations.length; r += 1) {
    if (stations[r]?.status !== "running") continue;
    const entry = bandOf(folded, r)?.from ?? r;
    const reentry = arcs.find(
      (arc) =>
        arc.to === entry && arc.from > arc.to && visited(arc.from) && stations[r]!.rounds >= 2,
    );
    if (reentry !== undefined) {
      reentry.ink = "march";
      continue;
    }
    // The double line segment is not a road that controls the flow. It only says "these two stations are parallel" and never travels.
    const inbound = rails.filter(
      (rail) => rail.to === r && rail.kind !== "twin" && visited(rail.from),
    );
    if (inbound.length > 0) {
      for (const rail of inbound) rail.ink = "march";
      continue;
    }
    const landing = arcs.find((arc) => arc.to === r && visited(arc.from));
    if (landing !== undefined) landing.ink = "march";
  }

  const railInk = (from: number, to: number): TimelineInk =>
    rails.find((rail) => rail.from === from && rail.to === to && rail.kind !== "twin")?.ink ??
    "faint";
  const bands: TimelineBand[] = fold.bands.map((band) => ({
    from: band.from,
    ...(band.join === undefined ? {} : { join: band.join }),
    ...(band.pred === undefined ? {} : { pred: band.pred }),
    to: band.to,
    tracks: band.tracks.map((members) => {
      const head = members[0]!;
      const tail = members[members.length - 1]!;
      return {
        entry:
          band.pred === undefined
            ? ((visited(head) ? "strong" : "faint") as TimelineInk)
            : railInk(band.pred, head),
        exit:
          band.join === undefined
            ? ((visited(tail) ? "strong" : "faint") as TimelineInk)
            : railInk(tail, band.join),
        stations: [...members],
      };
    }),
  }));

  return { arcs, bands, live: run !== undefined, rails, runningIndex, stations };
}

/**
 * What one pill "is doing": first the label of the running step, then the last settled one, then
 * the first.
 */
export function pillActivity(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  pill: TimelinePill,
): { label: string; asks: number; reads: number } {
  const stepsById = new Map(graph.steps.map((step) => [step.id, step]));
  const statuses = run === undefined ? {} : workflowRunOverlay(run, graph).statuses;
  let asks = 0;
  let reads = 0;
  let running: string | undefined;
  let done: string | undefined;
  let first: string | undefined;
  for (const id of pill.stepIds) {
    const step = stepsById.get(id);
    if (step === undefined) continue;
    if (step.kind === "world-read") reads += 1;
    else asks += 1;
    first ??= step.label;
    const status = statuses[id];
    if (status === "running") running ??= step.label;
    else if (status === "done" || status === "failed") done = step.label;
  }
  return { asks, label: running ?? done ?? first ?? "", reads };
}
