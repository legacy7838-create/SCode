// A pure model of the sidebar workflow run line.
// The input is the confirmed collection of workflowActivity and rendering side issued by sessions-index, and the output is "which rows to draw and how many lights in each row".
// No clock, no DOM: When the ended row is folded, only the confirmation collection is looked at, not the time.
import type {
  SessionWorkflowActivity,
  SessionWorkflowPhaseSummary,
  SessionWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { isSessionWorkflowRunLive } from "@zcode/shared/zcode-protocol-v4";
import { bandOf, foldPhaseBands, trackOf } from "../components/workflow-timeline/timeline-bands.js";

/** The maximum number of run rows a session draws; the rest collapse into "+n". */
const WORKFLOW_RUN_LINE_MAX_LINES = 2;
/**
 * The maximum number of stations the mini rail draws; beyond that it folds to ±2 around the running
 * station and carries a "+n" tail.
 */
const WORKFLOW_RUN_RAIL_MAX_STATIONS = 6;
/** The number of stations kept on each side of the running station when folding. */
const RAIL_FOLD_RADIUS = 2;

export interface WorkflowRunRailStation {
  name: string;
  status: SessionWorkflowPhaseSummary["status"];
  /**
   * Whether the rail segment entering this station has already been walked by control flow (the
   * solid-colour segment).
   */
  reached: boolean;
  /**
   * The segment entering this station is a **double segment**: this station and the previous one
   * belong to the same band but sit on different rails, and control flow never walked from that
   * station to this one — the two run in parallel. The flag hangs on the **station** rather than on
   * the segment, so it survives the window folding described below.
   */
  twin?: true;
}

export interface WorkflowRunRail {
  stations: WorkflowRunRailStation[];
  /**
   * The number of stations dropped by the fold and not drawn (the "+n" tail); no tail is drawn when
   * 0.
   */
  hidden: number;
  /** The script has no phase glossary: draw one implicit station "Workflow". */
  implicit: boolean;
}

/** Whether control flow has reached this station: running / done / failed all count. */
function isWorkflowRunStationReached(status: SessionWorkflowPhaseSummary["status"]): boolean {
  return status !== "pending";
}

/**
 * Folding of the mini rail: up to 6 stations are all drawn; beyond that it centres on the running
 * station (with no running station, the last one control flow reached, and failing that the first
 * station) and keeps ±2 for a total of 5 stations, the rest collapsing into a "+n" tail. This is a
 * **fixed window** rather than a scroll: the sidebar has no horizontal gesture.
 */
export function foldWorkflowRunRail(
  phases: readonly SessionWorkflowPhaseSummary[],
): WorkflowRunRail {
  if (phases.length === 0) {
    return { stations: [], hidden: 0, implicit: true };
  }
  // Folding must be done on **the entire table**: only one section of the window is taken, and the band is a connected component in the declaration order, and is refolded according to the subscript in the window
  // Bands across window boundaries will be broken. After folding, it will be windowed, and the double line segment mark will follow the station.
  const bands = foldPhaseBands(
    phases.length,
    phases.map((phase) => phase.alongside ?? []),
  );
  const all: WorkflowRunRailStation[] = phases.map((phase, index) => {
    const band = index === 0 ? undefined : bandOf(bands, index);
    const twin =
      band !== undefined &&
      band === bandOf(bands, index - 1) &&
      trackOf(bands, index) !== trackOf(bands, index - 1);
    return {
      name: phase.name,
      status: phase.status,
      reached: isWorkflowRunStationReached(phase.status),
      ...(twin ? { twin: true as const } : {}),
    };
  });
  if (all.length <= WORKFLOW_RUN_RAIL_MAX_STATIONS) {
    return { stations: all, hidden: 0, implicit: false };
  }
  let anchor = all.findIndex((station) => station.status === "running");
  if (anchor < 0) {
    for (let index = all.length - 1; index >= 0; index -= 1) {
      if (all[index]!.reached) {
        anchor = index;
        break;
      }
    }
  }
  if (anchor < 0) anchor = 0;
  const windowSize = RAIL_FOLD_RADIUS * 2 + 1;
  let start = Math.max(0, anchor - RAIL_FOLD_RADIUS);
  const end = Math.min(all.length, start + windowSize);
  start = Math.max(0, end - windowSize);
  const stations = all.slice(start, end);
  return { stations, hidden: all.length - stations.length, implicit: false };
}

/**
 * The connector between parallel phases: the stations running at the same time sit side by side
 * instead of queueing.
 */
const WORKFLOW_RUN_PARALLEL_SEPARATOR = " ∥ ";

/**
 * The names of the stations running at the same time, joined into one stretch of text in the
 * tooltip. When running in parallel, "current phase" is no longer a single station — none of them
 * is more current than the others — so that stretch is replaced by the names of all the stations
 * currently running.
 *
 * With only one (or zero) station running it returns `undefined`: the caller falls back to
 * `currentPhase` and the wording is unchanged.
 */
export function workflowRunParallelPhaseLabel(
  phases: readonly SessionWorkflowPhaseSummary[],
): string | undefined {
  const running = phases.filter((phase) => phase.status === "running");
  return running.length > 1
    ? running.map((phase) => phase.name).join(WORKFLOW_RUN_PARALLEL_SEPARATOR)
    : undefined;
}

interface WorkflowRunLineSelection {
  lines: SessionWorkflowRunSummary[];
  /** The number of rows not drawn (the word in "+n"). */
  overflow: number;
}

/**
 * Picks the rows to draw: running ones are always drawn; finished ones only while
 * **unacknowledged** (acknowledged = the session has been opened). The input order is already
 * arranged by the projection (running ones first in start order, then the most recently finished),
 * so this only filters and truncates.
 */
export function selectWorkflowRunLines(
  activity: SessionWorkflowActivity | undefined,
  isAcknowledged: (runId: string) => boolean,
): WorkflowRunLineSelection {
  if (activity === undefined) return { lines: [], overflow: 0 };
  const visible = activity.runs.filter(
    (run) => isSessionWorkflowRunLive(run.status) || !isAcknowledged(run.runId),
  );
  return {
    lines: visible.slice(0, WORKFLOW_RUN_LINE_MAX_LINES),
    overflow: Math.max(0, visible.length - WORKFLOW_RUN_LINE_MAX_LINES),
  };
}

/** The ids of finished (acknowledgeable) runs: opening a session acknowledges them as a batch. */
export function settledWorkflowRunIds(activity: SessionWorkflowActivity | undefined): string[] {
  if (activity === undefined) return [];
  return activity.runs
    .filter((run) => !isSessionWorkflowRunLive(run.status))
    .map((run) => run.runId);
}

/**
 * The number of running runs (the pulse lamp and count beside a collapsed project group header).
 */
export function countLiveWorkflowRuns(activity: SessionWorkflowActivity | undefined): number {
  if (activity === undefined) return 0;
  return activity.runs.filter((run) => isSessionWorkflowRunLive(run.status)).length;
}
