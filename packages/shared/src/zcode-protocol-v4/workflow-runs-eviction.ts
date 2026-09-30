// ============================================================
// Evacuate seats when the table is full: who can give up their seats, when they will take their seats, and how the vacated items can continue to be counted.
// ============================================================
// Elimination rules are pure functions and do not read the clock or perform I/O. The staged count of off-table entries is maintained by workflow-runs-unlisted.ts.
//
// Why should we make room? The old semantics of touching the boundary is **reject new**, and the reading picture is "which subagents are running at this moment" - so a wide
// After the fan-out run exceeds 1024, no new sub-agent can enter, and the run card and site roster will always stop at the earliest
// The reason for the existence of this characteristic has just been erased from the bodies of those people who have finished killing them. Make way to reverse it: the final entry gives way.
//
// Eliminating final state entries is not enough: a stage may
// After sending **all** actor-created and **all** node-queued in the first few seconds, the first 1024 items were still queued and the two tables were sent.
// It was full and there was no final state, so the next 976 jobs including people and jobs were all rejected; the scheduler then dispatched jobs according to FIFO, starting from the 1025th job.
// Initially every subagent that is running is not on the list. A subagent becomes important at the moment it is dispatched, not when
// The moment it is enqueued - so `node-dispatched` is also an enqueue opportunity (activation below).
//
// The priority in the table is from high to low, according to what this sub-agent is doing **at the moment**: **Running** (there are nodes in dispatched /
// executing/waiting/repairing/nudged)> **idle** (nothing is running, and there is still a queue: it is
// Waiting for slots) > **Completed** (all settled). Three invariants restrict who can give way, each of which corresponds to a visible consequence:
//   1. Running items will never give way - the ones running are exactly what you want to keep;
//   2. An actor never outlives its last **listed** node: the actor tristate is derived from the node under its name
//      (workflow-runs-actor-status.ts), actors without nodes will be derived as waiting, which is a
//      The pending badge will never move. Therefore, when walking, the whole group walks (actor + all its nodes), and you cannot bring yourself along.
//      The completed actor of that node is simply not listed (orphan rule);
//   3. The items that give way are still countable: in addition to the two counters of the run level (workflow-runs-caps.ts), press the **birth stage**
//      Remember one grid (workflow-runs-unlisted.ts) - the reading surface is drawn according to stations.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunState,
} from "./workflow-runs.js";
import { addToUnlistedBucket, withUnlistedBuckets } from "./workflow-runs-unlisted.js";

/**
 * The three entry-capacity bounds the reduction uses, defaulting to {@link WORKFLOW_RUNS_LIMITS}.
 * The eviction and counting rules apply to whatever bounds the caller passes in.
 */
export interface WorkflowRunEntryLimits {
  readonly maxActors: number;
  readonly maxNodes: number;
  readonly maxPhases: number;
}

interface InstanceRef {
  siteId: string;
  ordinal: number;
}

/** A candidate victim: the two keys the in-class ordering needs + its index in the table. */
interface Candidate {
  index: number;
  phaseName: string | undefined;
  failed: boolean;
}

/** A **non-live group**: one actor plus all of its listed nodes (indices), and which class it belongs to. */
interface Group extends Candidate {
  nodeIndexes: number[];
  /** Every node under it settled: this subagent's work is done. */
  finished: boolean;
  /** Not one running node but some still queued: this subagent is waiting for a slot, its work has not started. */
  idle: boolean;
  /** Not a single listed node under it: never asked yet, or its settlement is an actor-less cache hit. */
  zeroNode: boolean;
}

/** A departing subagent's increments in its bucket (`phaseName` is its **birth** phase). */
interface EvictedAgent {
  phaseName: string | undefined;
  actors: number;
  actorsSettled?: number;
  actorsFailed?: number;
}

/** The seating outcome of one node event. */
export interface WorkflowNodeSeating {
  /** The run after making room (possibly having evicted some entries) with the actor in place. */
  run: WorkflowRunState;
  /** May this instance enter the node table (false = reject new ones as before; the caller counts the rejection). */
  admitNew: boolean;
  /** Whether this call put an **off-table** instance back into the node table (the caller decrements nodesUnlisted by 1 accordingly). */
  activated: boolean;
}

function sameInstance(left: InstanceRef, right: InstanceRef): boolean {
  return left.siteId === right.siteId && left.ordinal === right.ordinal;
}

function isFailed(node: WorkflowRunNode): boolean {
  return node.outcome === "failed" || node.outcome === "cancelled";
}

/**
 * Whether this event may put a **new key** into the table — and, by the same token, advance
 * `nodesUsed`.
 *
 * **Only runs that have overflowed (`truncated`) tighten up**; `live` carries that tightened
 * condition (a birth event that advanced the waterline, or the activation below). Everything under
 * the bound is admitted, word for word the same as before the make-room rework.
 *
 * Why tighten: making room is the first thing that makes the table **shorter**, so a freed slot can
 * bring back an instance long since counted into `nodesUnlisted` (a replayed event, or a middle phase
 * that arrived only after its `queued` was rejected), and that instance is then both listed and
 * counted, so the total lies.
 *
 * Why not extend it to every run: the reduction **still applies** events below the waterline (it
 * only refuses to pull the waterline back down), and the CLI's cold materialization feeds journal
 * replay and live events into the same reduction. If a live event really did open a run first, its
 * whole journal prefix would sit below the waterline — tightening without distinction would leave
 * that run's card empty. Both of those holes presuppose "a rejection or an eviction happened
 * earlier", i.e. `truncated`, so keying on that leaves every below-the-bound path untouched.
 */
export function admitsNewEntry(run: WorkflowRunState, live: boolean): boolean {
  return run.truncated !== true || live;
}

/**
 * Makes room for a **live newcomer** when the actor table is full: evicts one finished group. When
 * the table is not full, when the newcomer is in fact already in the table, or when there is no
 * finished group at all, it returns the input unchanged (the caller then upserts as before, and
 * hitting the bound still rejects new entries).
 *
 * A birth can only squeeze out something **finished**: on what grounds would a newcomer that is
 * still queued evict another that is still queued — neither has started, and whichever gets listed
 * is the same informationless record. Idle groups only give way to an activation (one that really
 * started working).
 */
export function withRoomForActor(
  run: WorkflowRunState,
  ref: InstanceRef,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  if (run.actors.length < limits.maxActors) return run;
  if (run.actors.some((actor) => sameInstance(actor, ref))) return run;
  const victim = pickVictim(listedGroups(run).filter((group) => group.finished));
  return victim === undefined ? run : evictGroup(run, victim, limits);
}

/**
 * The seating of one node event: the single entry point for the three things — making room, B2's
 * rejection, and dispatch carrying birth facts (activation).
 *
 * The main reducer file therefore only has to hand the event over as-is, without deciding for itself
 * whether "this one should be seated" — that criterion has three arms, and each arm has a reason
 * that only exists after an overflow.
 */
export function seatWorkflowNode(
  run: WorkflowRunState,
  seat: {
    eventType: string;
    ref: InstanceRef;
    actorRef: InstanceRef | null;
    /** Only a `node-dispatched` that carries birth facts: the actor entry minted from those facts. */
    actor: WorkflowRunActor | null;
    /** This event is this instance's birth event (`node-queued`, or a cache-hit `node-settled`). */
    born: boolean;
    advancesWaterMark: boolean;
  },
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowNodeSeating {
  const byBirth = admitsNewEntry(run, seat.born && seat.advancesWaterMark);
  if (!seat.advancesWaterMark) return { run, admitNew: byBirth, activated: false };
  // The replayed event neither vacates the seat nor takes the seat: the following two are both based on the premise of "lifting over the water level".
  if (seat.eventType === "node-dispatched" && seat.actor !== null && run.truncated === true) {
    return activateInstance(run, seat.ref, seat.actor, limits);
  }
  if (seat.eventType !== "node-queued") return { run, admitNew: byBirth, activated: false };
  // B2: In the overflowed run, a queued whose owner cannot be recognized should not even occupy a seat - it cannot draw a badge (pill button
  // run.actors filter), and the job sent later needs that seat. Free nodes (world-read) are not included in this list.
  if (
    run.truncated === true &&
    seat.actorRef !== null &&
    !run.actors.some((actor) => sameInstance(actor, seat.actorRef!))
  ) {
    return { run, admitNew: false, activated: false };
  }
  return {
    run: withRoomForNode(run, seat.ref, seat.actorRef, limits),
    admitNew: byBirth,
    activated: false,
  };
}

/**
 * Makes room for a **live newcomer** when the node table is full: first evict one settled loose node
 * (a world-read belongs to no one's group, so evicting it costs only one row), and if there is none,
 * evict one finished group. It likewise returns the input unchanged when no room can be made.
 *
 * `owner` is the actor this new node belongs to. **Its own group is never the victim**: when a
 * subagent that has done three asks in a row hits the full table on the fourth, its group from the
 * first three looks "finished", and evicting it amounts to pulling this **being-dispatched**
 * subagent off the actor table — the new node stays in the table pointing at an actor that is not
 * on it, so it ends up with not a single badge. A group that just got work is by definition not
 * finished.
 */
function withRoomForNode(
  run: WorkflowRunState,
  ref: InstanceRef,
  owner: InstanceRef | null,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  if (run.nodes.length < limits.maxNodes) return run;
  if (run.nodes.some((node) => sameInstance(node, ref))) return run;
  const loose = pickVictim(looseSettledNodes(run));
  if (loose !== undefined) return evictSingleNode(run, loose, limits);
  const victim = pickVictim(spareGroups(run, owner).filter((group) => group.finished));
  return victim === undefined ? run : evictGroup(run, victim, limits);
}

/**
 * **Dispatch means seating.** A `node-dispatched` carrying birth facts (the engine re-sends, at
 * the moment of dispatch, the very facts this instance's `node-queued` and its subagent's
 * `actor-created` carried) puts the off-table instance back into the node table, and its subagent
 * back into the actor table too when needed.
 *
 * The order of making room is "actor slot first, node slot second", and each step judges on its own:
 * evicting a **group** for the actor slot also frees at least one node row, while evicting a
 * **zero-node** actor frees none — so the second step still has to look at the table length again.
 * When no room can be made the whole thing is rejected (the earlier eviction is voided and the
 * unchanged run is returned), and **not** just the node inserted — a node pointing at an off-table
 * actor is exactly what this rule exists to eliminate.
 */
function activateInstance(
  run: WorkflowRunState,
  ref: InstanceRef,
  actor: WorkflowRunActor,
  limits: WorkflowRunEntryLimits,
): WorkflowNodeSeating {
  const nodeListed = run.nodes.some((node) => sameInstance(node, ref));
  const actorListed = run.actors.some((listed) => sameInstance(listed, actor));
  if (nodeListed && actorListed) return { run, admitNew: true, activated: false };
  let next = run;
  if (!actorListed && next.actors.length >= limits.maxActors) {
    const victim = pickGroupVictim(next, null, true);
    if (victim === undefined) return { run, admitNew: false, activated: false };
    next = evictGroup(next, victim, limits);
  }
  if (!nodeListed && next.nodes.length >= limits.maxNodes) {
    // Order: The oldest settled node under your own name > settled free node > other people’s group. Throw away your own history first,
    // It's because there's only one row missing when you lose it, and the actor is still on the table (the badge doesn't move) - a subagent before taking someone else's row
    // Hand over your own first. Without this, a sub-agent that performs ask k times in a row will be blocked by tasks that it has already completed.
    // Outside the table: They are neither a group that can be eliminated (their own group is not a victim), but they also occupy seats.
    const own = ownSettledNodes(next, actor)[0];
    if (own !== undefined) next = evictSingleNode(next, own, limits);
    else {
      const loose = pickVictim(looseSettledNodes(next));
      if (loose !== undefined) next = evictSingleNode(next, loose, limits);
      else {
        // The zero-node actor cannot help here (it is the actor slot, not the node slot), so it is not allowed to be a victim.
        const victim = pickGroupVictim(next, actor, false);
        if (victim === undefined) return { run, admitNew: false, activated: false };
        next = evictGroup(next, victim, limits);
      }
    }
  }
  if (!actorListed) {
    // The subagent returned to the table is subtracted from its cell (workflow-runs-unlisted.ts): it is no longer one outside the table.
    next = withUnlistedBuckets(
      { ...next, actors: [...next.actors, actor] },
      addToUnlistedBucket(next.unlistedByPhase, actor.phaseName, { actors: -1 }, limits.maxPhases),
    );
  }
  return { run: next, admitNew: true, activated: !nodeListed };
}

/**
 * A **refused** `actor-created`: there is no run-level actor counter, so its only trace is its own
 * bucket. That bucket can later go up and down — it means "the number of subagents not on the table
 * right now", not a historical total.
 */
export function absorbRefusedActor(
  run: WorkflowRunState,
  phaseName: string | undefined,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  return withUnlistedBuckets(
    run,
    addToUnlistedBucket(run.unlistedByPhase, phaseName, { actors: 1 }, limits.maxPhases),
  );
}

/**
 * A node that is **born settled** being kept off the table (a cache-hit `node-settled`, which is
 * itself the birth event): counted into the bucket of its birth phase, and by the orphan rule its
 * actor — which has not a single listed node — is removed along with it.
 *
 * When the actor was not on the table to begin with, **only** the node's bucket is counted: that
 * subagent was long ago counted as `actors` under **its own** birth phase, while the node's phase
 * stamp need not be the same; worse, a subagent with two cache hits would thereby be counted twice
 * as "finished". An attribution that cannot be got right is better left uncounted — it is still an
 * unlisted subagent, which the read side counts as pending until it is listed again. The two
 * run-level counters are not touched here — that is `countUnlistedInstance`'s job, and counting in
 * both places would double.
 */
export function absorbRefusedSettledNode(
  run: WorkflowRunState,
  node: WorkflowRunNode,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  let buckets = addToUnlistedBucket(
    run.unlistedByPhase,
    node.phaseName,
    { settled: 1 },
    limits.maxPhases,
  );
  const owner =
    node.actorSiteId === undefined || node.actorOrdinal === undefined
      ? null
      : { siteId: node.actorSiteId, ordinal: node.actorOrdinal };
  const index = owner === null ? -1 : run.actors.findIndex((actor) => sameInstance(actor, owner));
  const actor = index < 0 ? undefined : run.actors[index]!;
  const orphan = actor !== undefined && !ownsListedNode(run, actor);
  if (orphan) {
    // Orphaning is attributable and happens only once: the actor is on the table and its birth stage is the one it brought in.
    buckets = addToUnlistedBucket(
      buckets,
      actor.phaseName,
      { actors: 1, actorsSettled: 1, actorsFailed: isFailed(node) ? 1 : 0 },
      limits.maxPhases,
    );
  }
  return withUnlistedBuckets(
    orphan ? { ...run, actors: run.actors.filter((_, position) => position !== index) } : run,
    buckets,
  );
}

/**
 * The two tables for a new life. **A run that has overflowed reopens from empty tables**: the
 * replay arm re-sends the whole script prefix, and only empty tables let every instance be, in
 * this life, either listed or counted — exactly once. Keeping a table that has lost entries counts
 * both ways — the evicted instance from the prefix first goes into `nodesUnlisted`, and on the
 * re-send it lands back in the table.
 *
 * A run that has not overflowed is kept as-is (not even the reference is swapped): the history of an
 * ordinary resume should not be erased.
 */
export function workflowRunTablesForNewLife(run: WorkflowRunState): {
  actors: WorkflowRunActor[];
  nodes: WorkflowRunNode[];
} {
  if (run.truncated !== true) return { actors: run.actors, nodes: run.nodes };
  return { actors: [], nodes: [] };
}

/**
 * The group victim for one activation: finished group > idle group > zero-node actor. `owner`'s own
 * group is always excluded.
 *
 * `allowZeroNode` is passed true only by the **actor slot** branch: removing a zero-node actor
 * frees one actor slot and not a single node row, and using it to fill a node slot would leave the
 * caller thinking it made room while that node still cannot get in.
 */
function pickGroupVictim(
  run: WorkflowRunState,
  owner: InstanceRef | null,
  allowZeroNode: boolean,
): Group | undefined {
  const groups = spareGroups(run, owner);
  return (
    pickVictim(groups.filter((group) => group.finished)) ??
    // The free group is the last one in the list: the last one created under the FIFO is the last one to be dispatched, and its seat is the least urgent to use.
    groups.filter((group) => group.idle).at(-1) ??
    // In the same way, the zero-node actor is the last one, and it is the last one: it has no nodes, no scores, and no history in the table or inside.
    // The reader will see nothing lost by eliminating it, and it will come back with the facts the next time it is dispatched. Missing this gear, once
    // The wide fan-out after resume will be stuck - the empty table is restarted, the prefix rebuilds 2000 actors, and the cache is hit.
    // The settlement does not include actors, so a table full of zero-node actors cannot be eliminated by anyone, and every distribution thereafter is rejected.
    (allowZeroNode ? groups.filter((group) => group.zeroNode).at(-1) : undefined)
  );
}

function spareGroups(run: WorkflowRunState, owner: InstanceRef | null): Group[] {
  const groups = listedGroups(run);
  if (owner === null) return groups;
  return groups.filter((group) => !sameInstance(run.actors[group.index]!, owner));
}

/**
 * The in-class ordering: non-failed ones go first (a failure is the one settled fact a reader still
 * wants back), then the phase with the most candidates (spend the bound where the entries are
 * crowded), and finally the earliest in the table. A pure function, so a cold replay evicts the
 * same set.
 */
function pickVictim<T extends Candidate>(candidates: readonly T[]): T | undefined {
  if (candidates.length === 0) return undefined;
  const unfailed = candidates.filter((candidate) => !candidate.failed);
  const pool = unfailed.length > 0 ? unfailed : candidates;
  const crowd = new Map<string, number>();
  // The stage name cannot be an empty string (schema's min(1)), so using the empty string as the key for the "no stage" cell will not cause a crash.
  for (const candidate of pool) {
    const key = candidate.phaseName ?? "";
    crowd.set(key, (crowd.get(key) ?? 0) + 1);
  }
  let best = pool[0]!;
  let bestCrowd = crowd.get(best.phaseName ?? "") ?? 0;
  for (const candidate of pool) {
    const size = crowd.get(candidate.phaseName ?? "") ?? 0;
    // Substitutions are only made when the queue is more crowded, so the one at the front of the table is left at the same time.
    if (size > bestCrowd) {
      best = candidate;
      bestCrowd = size;
    }
  }
  return best;
}

/**
 * All **non-live** groups in the table, in actor-table order. Having at least one listed node is the
 * precondition for forming a group — an actor that has not yet gotten work is nobody's candidate
 * (its `node-queued` may still be on the way).
 *
 * Split into two classes by what this subagent is doing **right now**: no queued node at all = its
 * work is done (finished); some queued node = it is waiting for a slot (idle), and a few settled
 * asks of its own do not change that. A subagent doing three asks in a row is the latter right
 * after its first ask finishes while its second is still queued — judge it by "all nodes queued" and
 * it becomes a group that is neither live nor evictable by anyone, so a table stuffed with such
 * groups keeps the genuinely live newcomers out, which is exactly the symptom this set of rules
 * exists to eliminate (in a generated engine-shaped event stream each run would otherwise lose
 * 2–4 live subagents this way).
 */
function listedGroups(run: WorkflowRunState): Group[] {
  const owned = new Map<
    string,
    { nodeIndexes: number[]; live: boolean; queued: boolean; failed: boolean }
  >();
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) return;
    const key = instanceKey({ siteId: node.actorSiteId, ordinal: node.actorOrdinal });
    const bucket = owned.get(key) ?? { nodeIndexes: [], live: false, queued: false, failed: false };
    bucket.nodeIndexes.push(index);
    if (node.phase === "queued") bucket.queued = true;
    else if (node.phase !== "settled") bucket.live = true;
    if (isFailed(node)) bucket.failed = true;
    owned.set(key, bucket);
  });
  const groups: Group[] = [];
  run.actors.forEach((actor, index) => {
    const bucket = owned.get(instanceKey(actor));
    if (bucket?.live === true) return;
    groups.push({
      index,
      phaseName: actor.phaseName,
      failed: bucket?.failed ?? false,
      nodeIndexes: bucket?.nodeIndexes ?? [],
      finished: bucket !== undefined && !bucket.queued,
      idle: bucket?.queued === true,
      // There is no listed node: only the actor bit of activation that takes it as a victim (see pickGroupVictim),
      // Both birth paths only recognize `finished`, so this will not change anything below the boundary.
      zeroNode: bucket === undefined,
    });
  });
  return groups;
}

/** Loose nodes: listed nodes with no actor (world-read). Only settled ones are candidates. */
function looseSettledNodes(run: WorkflowRunState): Candidate[] {
  const candidates: Candidate[] = [];
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId !== undefined || node.phase !== "settled") return;
    candidates.push({ index, phaseName: node.phaseName, failed: isFailed(node) });
  });
  return candidates;
}

/**
 * The newcomer's **own** settled nodes, in table order (earliest = that oldest ask).
 *
 * It does not go through {@link pickVictim}: the choice in this class is not "which one deserves to
 * go" but "which piece of history is oldest", and the oldest is precisely the one a reader is least
 * likely to come back for. The group as a whole is still never the victim — what gets lost here is
 * a row, not a person.
 */
function ownSettledNodes(run: WorkflowRunState, owner: InstanceRef): Candidate[] {
  const candidates: Candidate[] = [];
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId !== owner.siteId || node.actorOrdinal !== owner.ordinal) return;
    if (node.phase !== "settled") return;
    candidates.push({ index, phaseName: node.phaseName, failed: isFailed(node) });
  });
  return candidates;
}

function ownsListedNode(run: WorkflowRunState, actor: WorkflowRunActor): boolean {
  return run.nodes.some(
    (node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal,
  );
}

function instanceKey(ref: InstanceRef): string {
  return `${ref.siteId}\0${ref.ordinal}`;
}

/** A whole group leaving: the actor and all of its nodes disappear from both tables in the **same** reduction, the remaining entries keeping their order. */
function evictGroup(
  run: WorkflowRunState,
  group: Group,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  const actor = run.actors[group.index]!;
  const dropped = new Set(group.nodeIndexes);
  const evicted = group.nodeIndexes.map((index) => run.nodes[index]!);
  // The completed group left with "This subagent has ended"; the idle group just gave way, its work has not started yet, and it will continue to work in the future.
  // Returns to the activation table (activation) at the moment it is dispatched, so actorsSettled is not recorded.
  return {
    ...withUnlistedEvictions(
      run,
      evicted,
      {
        phaseName: actor.phaseName,
        actors: 1,
        ...(group.finished ? { actorsSettled: 1, actorsFailed: group.failed ? 1 : 0 } : {}),
      },
      limits,
    ),
    actors: run.actors.filter((_, index) => index !== group.index),
    nodes: run.nodes.filter((_, index) => !dropped.has(index)),
    truncated: true,
  };
}

/**
 * A single node row leaving: one settled loose node, or the newcomer's own oldest settled node.
 *
 * Both sites use the same bookkeeping, because it makes no difference to the books of **people**:
 * no actor leaves, so only the node's three entries apply (the two run-level counters + the
 * `settled` of that node's birth-phase bucket).
 */
function evictSingleNode(
  run: WorkflowRunState,
  candidate: Candidate,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  const node = run.nodes[candidate.index]!;
  return {
    ...withUnlistedEvictions(run, [node], undefined, limits),
    nodes: run.nodes.filter((_, index) => index !== candidate.index),
    truncated: true,
  };
}

/**
 * Evicted entries go into the two run-level counters and into the bucket of their own birth phase.
 *
 * `nodesUnlisted` is incremented by **all** evicted nodes, `nodesUnlistedSettled` only by the
 * **settled** ones among them: when an idle group leaves it takes queued nodes with it, and those
 * have not settled, so counting them would inflate completion.
 */
function withUnlistedEvictions(
  run: WorkflowRunState,
  nodes: readonly WorkflowRunNode[],
  agent: EvictedAgent | undefined,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  let buckets = run.unlistedByPhase;
  if (agent !== undefined) {
    const { phaseName, ...delta } = agent;
    buckets = addToUnlistedBucket(buckets, phaseName, delta, limits.maxPhases);
  }
  let settledCount = 0;
  for (const node of nodes) {
    if (node.phase !== "settled") continue;
    settledCount += 1;
    buckets = addToUnlistedBucket(buckets, node.phaseName, { settled: 1 }, limits.maxPhases);
  }
  const settledTotal = (run.usage.nodesUnlistedSettled ?? 0) + settledCount;
  return withUnlistedBuckets(
    {
      ...run,
      usage: {
        ...run.usage,
        nodesUnlisted: (run.usage.nodesUnlisted ?? 0) + nodes.length,
        // At zero time the entire key is absent (same as workflow-runs-caps.ts).
        ...(settledTotal > 0 ? { nodesUnlistedSettled: settledTotal } : {}),
      },
    },
    buckets,
  );
}
