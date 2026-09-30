import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type { TimelinePill, TimelineStation } from "./timeline-model.js";

/**
 * Phase roster: once a station's participants pass the threshold, the pill column becomes "a few
 * pinned pills + the rest". All this does is the pure split — who is pinned, who is in the rest,
 * how many in each status — under one rule shared in four places: the card, the turn-tail summary,
 * the confirm dialog and the side pane (invariant 1). The card folds "the rest" into a single "n
 * more" row (see "five pills and one door", `rosterMore`); the side pane treats that same row as a
 * door, and behind it sits a roll grouped by status (see "one door and one roll", `rosterRoll`).
 *
 * Subagents the boundary cannot list (`station.unlisted`) have no pill, but the threshold, the
 * total, the counts and the "n more" row all have to account for them: a station's numbers do not
 * shrink when its subagents leave the table, only its rows do.
 */

/**
 * The column stays a pill column while participants are ≤ this many (six = 222 px, already taller
 * than the roster).
 */
export const ROSTER_THRESHOLD = 6;
/** Number of pills pinned on the card: five + one "n more" row = the height of six pills. */
export const ROSTER_PINS_CARD = 5;
/**
 * Number of pills pinned in the side pane (fills a whole column, leaving room to name a few more).
 */
export const ROSTER_PINS_PANE = 5;
/** Number of faces stacked on the "n more" row. */
export const ROSTER_DECK = 3;

export type RosterCounts = Record<StepRunStatus, number>;

/**
 * The unlisted ones (`station.unlisted`): a tally of the subagents the boundary cannot list — no
 * pill, no face, no row. The roster only **counts** them, because a station's numbers must not
 * shrink when its subagents leave the table. `settled` is the subset known to have finished;
 * `failed ⊆ settled`; the remaining `actors − settled` still have to run.
 */
export interface RosterUnlisted {
  actors: number;
  settled: number;
  failed: number;
}

const NO_UNLISTED: RosterUnlisted = { actors: 0, failed: 0, settled: 0 };

export interface StationRoster {
  /**
   * The pinned pills: asking → running → failed → then filled in participant order; a slot is never
   * empty.
   */
  pinned: TimelinePill[];
  /**
   * The remaining participants (the ones not pinned): in participant order. The unlisted are not
   * here — they have no pill.
   */
  rest: TimelinePill[];
  /**
   * All participants (pinned and unlisted alike) counted by status; a static pill counts as
   * pending.
   */
  counts: RosterCounts;
  /** The unlisted ones; zero when none are left out of the table. */
  unlisted: RosterUnlisted;
  total: number;
}

/** Static (no run) is pixel-for-pixel identical to pending, and counts in the same class. */
export function pillStatusOf(pill: Pick<TimelinePill, "status">): StepRunStatus {
  return pill.status ?? "pending";
}

/**
 * Instance key (`siteId@ordinal`): an open question attaches to its asker by it; a synthetic lane
 * has none.
 */
export function pillInstanceKey(pill: Pick<TimelinePill, "instance">): string | undefined {
  return pill.instance === undefined
    ? undefined
    : `${pill.instance.siteId}@${pill.instance.ordinal}`;
}

export function rosterCounts(pills: readonly TimelinePill[]): RosterCounts {
  const counts: RosterCounts = { done: 0, failed: 0, pending: 0, running: 0 };
  for (const pill of pills) counts[pillStatusOf(pill)] += 1;
  return counts;
}

/**
 * Folds the unlisted ones into a set of counts: only the `settled` part has an outcome (the
 * failures go to failed, the rest to done), and the remainder has not finished, so it goes to
 * pending. Subagents rejected at birth or dropped while queued are in `actors` too — calling those
 * done is the one false statement this boundary refuses to make. The count row and the station-wide
 * counts share this rule, so the two are always consistent.
 */
function addUnlisted(counts: RosterCounts, unlisted: RosterUnlisted): RosterCounts {
  counts.done += unlisted.settled - unlisted.failed;
  counts.failed += unlisted.failed;
  counts.pending += Math.max(0, unlisted.actors - unlisted.settled);
  return counts;
}

/**
 * Attention order: the stack of faces on the "n more" row surfaces the most urgent first; the
 * roll's groups are ordered by it too.
 */
export const ATTENTION_ORDER: readonly StepRunStatus[] = ["failed", "running", "pending", "done"];
const ATTENTION_RANK: Record<StepRunStatus, number> = {
  failed: 0,
  running: 1,
  pending: 2,
  done: 3,
};

/** Stable attention ordering: within the same level, participant order is preserved. */
function byAttention(pills: readonly TimelinePill[]): TimelinePill[] {
  return pills
    .map((pill, index) => ({ index, pill }))
    .sort(
      (left, right) =>
        ATTENTION_RANK[pillStatusOf(left.pill)] - ATTENTION_RANK[pillStatusOf(right.pill)] ||
        left.index - right.index,
    )
    .map((entry) => entry.pill);
}

/**
 * Pin order asking → running → failed → participant order: a running pill has no cap, so however
 * many are running all of them get pinned. Participant order is kept within a bucket, so a running
 * pill gives up its pin only when it stops itself — pins change one at a time and the column never
 * flips wholesale. A finished run has neither an asking nor a running pill, so this order degrades
 * on its own into failed → participant order, with no extra liveness input needed.
 */
export function stationRoster(
  pills: readonly TimelinePill[],
  options: { pins: number; unlisted?: RosterUnlisted },
): StationRoster | undefined {
  const unlisted = options.unlisted ?? NO_UNLISTED;
  // The threshold is judged according to **in-table + out-of-table**: there are only four pills left, 300 eliminated stations behind, and it is still a roster - otherwise that line
  // Once they disappeared, the three hundred subagents ceased to exist on the screen.
  const total = pills.length + unlisted.actors;
  if (total <= ROSTER_THRESHOLD) return undefined;
  const counts = addUnlisted(rosterCounts(pills), unlisted);

  const pinned: TimelinePill[] = [];
  const pin = (pill: TimelinePill) => {
    if (pinned.length < options.pins && !pinned.includes(pill)) pinned.push(pill);
  };
  for (const pill of pills) if (pill.asking === true) pin(pill);
  for (const pill of pills) if (pillStatusOf(pill) === "running") pin(pill);
  for (const pill of pills) if (pillStatusOf(pill) === "failed") pin(pill);
  for (const pill of pills) pin(pill);

  const rest = pills.filter((pill) => !pinned.includes(pill));
  return { counts, pinned, rest, total, unlisted };
}

/**
 * A station's roster: the unlisted cell is read from the station (`station.unlisted`), so the card
 * and the side pane read the same value and neither has to dig through `run.unlistedByPhase`
 * itself.
 */
export function stationRosterOf(
  station: Pick<TimelineStation, "pills" | "unlisted">,
  pins: number,
): StationRoster | undefined {
  return stationRoster(station.pills, {
    pins,
    // The `nodesSettled` in the standing cell refers to nodes, and the roster counts people: it only enters fraction, not here.
    ...(station.unlisted === undefined
      ? {}
      : {
          unlisted: {
            actors: station.unlisted.actors,
            failed: station.unlisted.failed,
            settled: station.unlisted.settled,
          },
        }),
  });
}

/**
 * The count row on the closed-door row: everything behind the door — the rest inside the table,
 * plus the unlisted ones that have no pill.
 */
export function rosterRestCounts(roster: StationRoster): RosterCounts {
  return addUnlisted(rosterCounts(roster.rest), roster.unlisted);
}

/** The contents of the "n more" row on the card. */
export interface RosterMore {
  /**
   * Number of participants not pinned (the unlisted count too — they sit behind this row as well).
   */
  count: number;
  /**
   * The stacked faces: the first few of the rest in attention order (failed → running → pending →
   * done). The unlisted have no faces.
   */
  deck: TimelinePill[];
  /**
   * Number of failed hidden behind this row (pinned ones excluded, unlisted failures included) —
   * the only status this row reports on the card.
   */
  failed: number;
}

export function rosterMore(roster: StationRoster, deck: number = ROSTER_DECK): RosterMore {
  const pinnedFailed = roster.pinned.filter((pill) => pillStatusOf(pill) === "failed").length;
  return {
    count: roster.rest.length + roster.unlisted.actors,
    deck: byAttention(roster.rest).slice(0, deck),
    // `counts.failed` already includes the ones that failed outside the table, minus the pinned ones, that is, "there are still a few hidden behind this line."
    failed: roster.counts.failed - pinnedFailed,
  };
}

/**
 * One group of the side-pane roll: remaining participants of the same status, in participant order.
 */
export interface RollGroup {
  status: StepRunStatus;
  pills: TimelinePill[];
}

/**
 * The roll behind the door: the rest grouped by status, group order is attention order, empty
 * groups absent.
 */
export function rosterRoll(roster: StationRoster): RollGroup[] {
  return ATTENTION_ORDER.map((status) => ({
    pills: roster.rest.filter((pill) => pillStatusOf(pill) === status),
    status,
  })).filter((group) => group.pills.length > 0);
}
