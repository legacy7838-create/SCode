// ============================================================
// Pure reduction of workflowRuns: a dwf progress event → new workflowRuns state
// ============================================================
// Cohabits with workflow-runs.ts (the state schema) because they are two halves of the same vocabulary: the schema says "what does the state look like",
// Here it is said "how does the event advance it one frame". Reduction must be implemented in a single way: if it is in bootstrap's v4 product-projection,
// And TUI also needs the same status——
// It is extracted to adhere to the **single clock** principle (workflow-runs.ts): projection and TUI mirroring are not allowed to be reduced to one copy each.
//
// This module is pure function: no Date.now, no randomness, no I/O. The **impure part** of the projection (identity gate,
// recordDynamicWorkflowRunProgress wiring, cold hydration classification, state.updated emission) stay in bootstrap.
//
// Dependency direction: contracts → shared. So the input event type is **structured definition** here, without import contracts
// DynamicWorkflowRunProgressPayload; the bootstrap side assigns the bounded payload of contracts to
// WorkflowRunProgressEnvelope, the assignment itself is a compile-time gate that prevents the shapes on both sides from drifting.
//
// Three **structural** facts from the engine Boundary C that are worth knowing before reading the code, otherwise the following points will be confusing:
//   1. The node phase is the event actually emitted by the engine: queued/dispatched/executing/waiting/repairing/nudged/settled.
//      `executing` / `waiting` are driver observations:
//      The model request is actually sent/waiting for process-level slots or backoff; the two switch back and forth after dispatched.
//   2. The completion of resume hits the short circuit** and sends node-settled** directly without going through node-queued (ask in scheduler.ts
//      releaseCachedAsk/tryImportedSettle, world-read replay and import hits in engine-world.ts),
//      And `kind` is only carried on queued - so node.kind is defaultable, not missing.
//   3. Run-level usage: `usage-updated` directly carries the total amount of spent tokens;
//      `nodesUsed` is counted by the first phase transition of `node-dispatched` (replay of the same instance does not count twice),
//      There is no upper bound for back calculation, nor is it needed.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunNode,
  type WorkflowRunPendingQuestion,
  type WorkflowRunReport,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

import { serializeWorkflowArtifact } from "./workflow-artifact.js";
import { withDerivedWorkflowActorStatuses } from "./workflow-runs-actor-status.js";
import {
  countTaggedReport,
  upsertBoundedByArtifactId,
  workflowArtifactSummary,
} from "./workflow-runs-artifacts.js";
import {
  countUnlistedInstance,
  discountUnlistedInstance,
  evictForEntryBudget,
} from "./workflow-runs-caps.js";
import {
  absorbRefusedActor,
  absorbRefusedSettledNode,
  admitsNewEntry,
  seatWorkflowNode,
  withRoomForActor,
  type WorkflowRunEntryLimits,
} from "./workflow-runs-eviction.js";
import {
  reduceConcurrencyChanged,
  reduceRunCapsChanged,
  withoutCooldown,
} from "./workflow-runs-concurrency.js";
import {
  boundedActorName,
  boundedPhaseName,
  nonEmptyString,
  workflowActorEntry,
} from "./workflow-runs-entries.js";
import { canonicalWorkflowRun, workflowRunUnchanged } from "./workflow-runs-delta.js";
import { readRunIdField, readWorkflowRunStopReason } from "./workflow-runs-lineage.js";
import { carryNodeProgress, reduceNodeProgress } from "./workflow-runs-node-progress.js";
import { reducePhaseEntered, reduceRunLaunched } from "./workflow-runs-phases.js";
import { reduceRunStarted } from "./workflow-runs-started.js";
import { upsertBoundedByInstance, upsertBoundedByQid } from "./workflow-runs-tables.js";

/**
 * Node event → phase. Rather than `eventType.slice("node-".length)` (the event name happens to be
 * the phase name), an explicit table lets a reader see every node event and which phase it lands
 * on at a glance, so adding events later does not rely on lucky string slicing.
 */
const NODE_EVENT_PHASE: Readonly<Record<string, WorkflowRunNode["phase"]>> = {
  "node-queued": "queued",
  "node-dispatched": "dispatched",
  "node-executing": "executing",
  "node-waiting": "waiting",
  "node-repairing": "repairing",
  "node-nudged": "nudged",
  "node-settled": "settled",
};

/**
 * The **structured** input of one workflow run progress event. The fields are shaped like the
 * contracts' `DynamicWorkflowRunProgressPayload`, but all optional here: this module does no schema
 * validation, and instead treats truncated input as "reduce as much as possible" (a missing
 * runId / eventType makes the whole entry invalid).
 *
 * `actorSessionId` is a derived field the run service hangs **outside** the payload
 * (see toProgressPayload in dynamic-workflow-run-launch.ts): the deterministically minted actor
 * session id. It is not an observable fact of the engine, but without it downstream would have to
 * re-create the contract on its own.
 */
export interface WorkflowRunProgressEnvelope {
  runId?: string;
  toolCallId?: string;
  sequence?: number;
  eventType?: string;
  payload?: Record<string, unknown>;
  actorSessionId?: string;
}

/**
 * Reduces one progress event into the `workflowRuns` state key.
 *
 * Returning `null` means **no semantic change**: an invalid event (missing runId / eventType), or
 * a replay of the same event whose content is byte-for-byte identical. Callers use that to decide
 * not to send `state.updated` / not to refresh the UI — so the revision only advances when
 * something really changed (an idempotent replay does not bump the revision).
 *
 * An absent `previous` is equivalent to the empty state `{ revision: 0, runs: [] }`. `limits`
 * defaults to {@link WORKFLOW_RUNS_LIMITS} (production has no second set of bounds).
 */
export function reduceWorkflowRunsState(
  previous: WorkflowRunsState | undefined,
  envelope: WorkflowRunProgressEnvelope,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunsState | null {
  const runId = envelope.runId;
  if (!runId || typeof envelope.eventType !== "string") return null;
  const sequence = typeof envelope.sequence === "number" ? envelope.sequence : 0;
  const payload = isPlainRecord(envelope.payload) ? envelope.payload : {};

  const prior: WorkflowRunsState = previous ?? { revision: 0, runs: [] };
  const existing = prior.runs.find((run) => run.runId === runId);
  const base: WorkflowRunState = existing ?? {
    runId,
    ...(envelope.toolCallId ? { toolCallId: envelope.toolCallId } : {}),
    status: "pending",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: sequence,
  };

  // Canonical key order (workflow-runs-delta.ts): reduction is advanced by `{...run, new key: v}`, and newly appearing optional keys are therefore pressed
  // **Arrival order** is appended to the end, and the consumer side of the key-level increment does not have that history. Each side is rearranged in schema order.
  // `JSON.stringify(apply(prior, diff(prior, next))) === JSON.stringify(next)` is true byte by byte.
  const next = canonicalWorkflowRun(
    applyWorkflowRunEvent(base, envelope.eventType, payload, {
      ...(envelope.actorSessionId === undefined ? {} : { actorSessionId: envelope.actorSessionId }),
      ...(envelope.toolCallId === undefined ? {} : { toolCallId: envelope.toolCallId }),
      // Monotone: late/replayed events will not push the water level back.
      sequence: Math.max(base.lastEventSequence, sequence),
      // The counter of the rejected instance is **added**, and there is no identity to deduplicate, so only events that have exceeded the water level are recognized.
      // (See workflow-runs-caps.ts). The water level is the value before this event.
      advancesWaterMark: sequence > base.lastEventSequence,
      limits,
    }),
  );

  // Idempotent: no change in semantics and no delta (no revision when replaying the same event). The criterion is **structural** comparison rather than the entire run
  // JSON.stringify - the latter requires serializing the entire table for each event (it is the O(N) bytes that this transformation will eliminate),
  // Moreover, "different key sequence and same content" will be misjudged as a change. It shares the same criterion as diff's "Has this key changed?"
  if (existing !== undefined && workflowRunUnchanged(existing, next)) return null;

  const runs = existing
    ? prior.runs.map((run) => (run.runId === runId ? next : run))
    : [...prior.runs, next];
  // The most recent ~8, eliminated by oldest. The complete facts of the final run are still in the journal (the details page is available via event log query).
  // These two **cross-run** boundaries use true constants and do not use the `limits` injection port: the latter is only to reduce the pressure of a single run.
  // The number of run items and item budget have nothing to do with the injected rules.
  const bounded =
    runs.length > WORKFLOW_RUNS_LIMITS.maxRuns
      ? runs.slice(runs.length - WORKFLOW_RUNS_LIMITS.maxRuns)
      : runs;
  // The entry budget is added after the number of entries: the total of 8 full runs is too close to the snapshot upper limit (workflow-runs-caps.ts).
  return { revision: prior.revision + 1, runs: evictForEntryBudget(bounded, runId) };
}

function applyWorkflowRunEvent(
  base: WorkflowRunState,
  eventType: string,
  payload: Record<string, unknown>,
  derived: {
    actorSessionId?: string;
    toolCallId?: string;
    sequence: number;
    advancesWaterMark: boolean;
    limits: WorkflowRunEntryLimits;
  },
): WorkflowRunState {
  const run: WorkflowRunState = {
    ...base,
    ...(derived.toolCallId && !base.toolCallId ? { toolCallId: derived.toolCallId } : {}),
    lastEventSequence: derived.sequence,
  };

  switch (eventType) {
    /**
     * run-started: back to running, usage zeroed, the previous life's settlement residue stripped
     * away, and this run's own concurrency bound recorded.
     * The rules live in the same-family workflow-runs-started.ts (resume's re-arm semantics deserve
     * a whole file header).
     */
    case "run-started":
      return reduceRunStarted(run, payload);
    case "actor-created": {
      const ref = workflowInstanceRef(payload.actor);
      if (!ref) return run;
      // Birth stage: `actor-created` is the actor's birth event, and can only be found here.
      // No subsequent events can carry it or rewrite it.
      const phaseName = boundedPhaseName(nonEmptyString(payload.phaseName));
      const actor = workflowActorEntry(ref, payload.name, phaseName, derived.actorSessionId);
      // When the table is full, make room for the live newcomer (workflow-runs-eviction.ts); if the seat cannot be made, the newcomer will still be rejected.
      // The replayed event neither vacates nor admits (the latter only tightens on overflowed runs, see admitsNewEntry).
      const seated = derived.advancesWaterMark ? withRoomForActor(run, ref, derived.limits) : run;
      const upserted = upsertBoundedByInstance(seated.actors, actor, derived.limits.maxActors, {
        admitNew: admitsNewEntry(run, derived.advancesWaterMark),
      });
      // Rejected subagents are also countable: there is no actor counter at the run level, its only trace is its own birth stage.
      const absorbed =
        upserted.truncated && derived.advancesWaterMark
          ? absorbRefusedActor(seated, phaseName, derived.limits)
          : seated;
      return withDerivedWorkflowActorStatuses({
        ...absorbed,
        actors: upserted.list,
        ...(upserted.truncated || seated.truncated ? { truncated: true } : {}),
      });
    }
    case "node-queued":
    case "node-dispatched":
    case "node-executing":
    case "node-waiting":
    case "node-repairing":
    case "node-nudged":
    case "node-settled": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      const phase = NODE_EVENT_PHASE[eventType]!;
      // There are two birth events (the same as the determination of workflow-runs-caps.ts): `node-queued`, and replay
      // `node-settled { cached: true }` is sent directly on hit. **overflow** run only recognizes the birth event brought about by living
      // New keys (see admitsNewEntry): replayed events, and intermediate phases of an off-table instance, should not be put back into the table
      // ——It has already been included in nodesUnlisted, and listing it again means both listing and counting.
      const born =
        eventType === "node-queued" || (eventType === "node-settled" && payload.cached === true);
      const actorRef = workflowInstanceRef(payload.actor);
      // `node-dispatched` with birth fact: The engine resends the `node-queued` of this instance and the `actor-created` of its sub-agent at the moment of dispatch
      // The same fact has been carried, so the instance outside the table can be brought back to the table with the person alive at the moment it is dispatched.
      // The missing actor ref, that is, the naked distribution of the old journal or world-read, is still processed as usual.
      const dispatchActor =
        eventType === "node-dispatched" && actorRef !== null
          ? workflowActorEntry(
              actorRef,
              payload.actorName,
              boundedPhaseName(nonEmptyString(payload.actorPhaseName)),
              derived.actorSessionId,
            )
          : null;
      // The only entrance (workflow-runs-eviction.ts) for three things: vacancy, B2 rejection and activation.
      const seating = seatWorkflowNode(
        run,
        {
          eventType,
          ref,
          actorRef,
          actor: dispatchActor,
          born,
          advancesWaterMark: derived.advancesWaterMark,
        },
        derived.limits,
      );
      const seated = seating.run;
      const previousNode = seated.nodes.find(
        (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
      );
      const kind =
        payload.kind === "ask" || payload.kind === "world-read" ? payload.kind : previousNode?.kind;
      // Birth stage name: The engine only stamps on birth events - `node-queued`, and when replay hits
      // Directly send `node-settled { cached: true }` (that node is not queued, it is a birth event). The rest
      // `node-*` is not carried, carried forward, the same precedent as the kind / actorSiteId above.
      const phaseName =
        boundedPhaseName(nonEmptyString(payload.phaseName)) ?? previousNode?.phaseName;
      const node: WorkflowRunNode = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        ...(kind === undefined ? {} : { kind }),
        phase,
        ...(payload.outcome === "ok" ||
        payload.outcome === "failed" ||
        payload.outcome === "cancelled"
          ? { outcome: payload.outcome }
          : {}),
        ...(payload.cached === true ? { cached: true } : {}),
        ...(actorRef
          ? { actorSiteId: actorRef.siteId, actorOrdinal: actorRef.ordinal }
          : previousNode?.actorSiteId !== undefined
            ? { actorSiteId: previousNode.actorSiteId, actorOrdinal: previousNode.actorOrdinal }
            : {}),
        ...(phaseName === undefined ? {} : { phaseName }),
        // Task summary and progress reading: node-queued takes the load, other events are carried forward, and the birth event clears the count of the previous life.
        // The rules are in workflow-runs-node-progress.ts of the same family (it also explains why they must be carried explicitly).
        ...carryNodeProgress(eventType, payload, previousNode),
      };
      const upsertedNodes = upsertBoundedByInstance(seated.nodes, node, derived.limits.maxNodes, {
        admitNew: seating.admitNew,
      });
      // Number of steps: The **first** dispatch of an instance counts as one step. When replaying the same node-dispatched, the previousNode is already in
      // The phases after dispatched are no longer counted - the reduction must be idempotent (the top level relies on structural comparison to determine "no change").
      // Instances that are rejected when touching the boundary cannot find the previousNode and will be counted as usual: the number of steps is a run-level fact and is not constrained by the display boundary.
      // Precisely because it cannot find the previousNode, the phase deduplication method is invalid for it - replaying the dispatched line will change the step number.
      // Push higher and higher. Therefore, this count is the same as nodesUnlisted on the **overflowed** run.
      // Only events that have exceeded the water level are recognized; each instance under the boundary has its own row, and phase deduplication is sufficient without changing a single byte.
      const firstDispatch =
        eventType === "node-dispatched" &&
        admitsNewEntry(run, derived.advancesWaterMark) &&
        (previousNode === undefined || previousNode.phase === "queued");
      // To return to the instance on the table, first subtract it from `nodesUnlisted`: it both lists and counts one more step.
      const restored = seating.activated ? discountUnlistedInstance(seated.usage) : seated.usage;
      // Two counters for rejected instances (workflow-runs-caps.ts): `upsertedNodes.truncated` happens to be
      // "This instance was not included in the table" - the run-level truncated bit is calculated separately below, and the two cannot be mixed.
      const usage = countUnlistedInstance(
        firstDispatch ? { ...restored, nodesUsed: restored.nodesUsed + 1 } : restored,
        {
          rejected: upsertedNodes.truncated,
          advancesWaterMark: derived.advancesWaterMark,
          eventType,
          cached: payload.cached === true,
        },
      );
      // Rejected **Settled at birth** Example: The run level count is recorded above, here record the cell of its birth stage, and follow the orphan rules
      // Remove the actor that cannot be brought into its own node (workflow-runs-eviction.ts).
      const absorbed =
        upsertedNodes.truncated && derived.advancesWaterMark && born && phase === "settled"
          ? absorbRefusedSettledNode(seated, node, derived.limits)
          : seated;
      return withDerivedWorkflowActorStatuses({
        ...absorbed,
        ...(usage === seated.usage ? {} : { usage }),
        nodes: upsertedNodes.list,
        ...(upsertedNodes.truncated || seated.truncated ? { truncated: true } : {}),
      });
    }
    /**
     * node-progress: some turn of one ask finished resolving (the driver emits one per resolved
     * turn).
     *
     * **Not a lifecycle event**: it sets no phase, counts no step, touches no actor state — it only
     * writes three readings onto that node. That is why it is deliberately not in the case group
     * above and not in the NODE_EVENT_PHASE table. The rules live in
     * workflow-runs-node-progress.ts.
     */
    case "node-progress": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      return reduceNodeProgress(run, ref, payload);
    }
    /**
     * report: a progressive artifact handed over by the script's `report(item)` (the data source
     * of the detail page's Results section).
     *
     * It **deliberately does not touch `nodes[]`**: a report has no node-queued/node-settled
     * lifecycle, and counting it would inflate the step count of a report-heavy workflow (compact
     * cards and the task list read `settled/observed` straight off nodes), and would drag an
     * instance with no ordering meaning into the state fold. For the same reason it does not touch
     * actor state — it is no evidence of any actor doing work.
     */
    case "report": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      // The second actual parameter of `report(item, artifactId)`: which preset dashboard this item is fed to. Absent is a normal report, and the following counting branches are not taken at all.
      const artifactId = nonEmptyString(payload.artifactId);
      const report: WorkflowRunReport = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        preview: workflowReportPreview(payload.item),
        ...(artifactId === undefined ? {} : { artifactId }),
      };
      const existingReports = run.reports ?? [];
      // The deduplication key of the count is the same as the reports table: (siteId, ordinal). Must be evaluated before upsert **,
      // Otherwise, after the upsert is completed, each item "already exists". See below in countTaggedReport why this judgment is out of bounds
      // What happens next, and why misalignment in that direction is safe.
      const firstSighting = !existingReports.some(
        (item) => item.siteId === ref.siteId && item.ordinal === ref.ordinal,
      );
      // Press (siteId, ordinal) upsert: Each report call will be rerun when the script replays (the engine presses the same key
      // Silently skipping the logged one), so the same instance must end up on the same line instead of two lines. boundary semantics and
      // Actors/nodes sibling: New entries are rejected, existing entries are updated as usual, and extra-terrestrial facts are still in the journal.
      const upserted = upsertBoundedByInstance(
        existingReports,
        report,
        WORKFLOW_RUNS_LIMITS.maxReports,
      );
      // Tagged entries are still included in reports: there is an upper limit for one channel, and labels are just one more place to go, not a diversion.
      const counted =
        artifactId !== undefined && firstSighting
          ? countTaggedReport(run.artifacts, artifactId)
          : run.artifacts;
      return {
        ...run,
        reports: upserted.list,
        ...(counted === undefined ? {} : { artifacts: counted }),
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * artifact-published: the script published, via `artifact.*`, one version of a **user-facing**
     * artifact, or declared a preset board. A successful content member publish and a preset member
     * declaration both go through this one case; a cache hit is not re-emitted (same as report).
     *
     * ⚠ Terminology: the artifact here is an output meant for the **user**. The "script top-level
     * return value" behind `resultPreview` is also called an artifact inside the engine, and that one
     * is meant for the **model** — the two are unrelated. See workflow-artifacts.ts.
     *
     * Just like report, it **does not touch `nodes[]` or actor state**: an artifact station is in no
     * graph and has no node lifecycle events (it does not even emit node-settled, precisely so
     * that no untracked node grows in the sidebar). It does not count steps either — delivering an
     * artifact is not "one more step run".
     *
     * The dedup key is the **artifact id**, not the station instance: publishing the same id again
     * is a **new version**, and a new version must overwrite the same card instead of growing a
     * second one. That is a different family from the three tables — nodes/actors/reports — that
     * dedup by (siteId, ordinal): two versions of the same id come from two different station
     * instances, and deduping by instance would yield two cards.
     */
    case "artifact-published": {
      const summary = workflowArtifactSummary(payload.artifact);
      if (summary === undefined) return run;
      const upserted = upsertBoundedByArtifactId(
        run.artifacts ?? [],
        summary,
        WORKFLOW_RUNS_LIMITS.maxArtifacts,
      );
      return {
        ...run,
        artifacts: upserted.list,
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * artifact-failed: a content artifact publish was rejected (file missing / out of bounds /
     * over the cap / store absent).
     *
     * **Deliberately changes no state at all.** A failed publish claims no id, claims no kind, and
     * takes no version number (only completed rows claim those, otherwise the live path would
     * claim things the resume path cannot claim — two sets of accounts). So there is nothing here
     * to upsert: standing up a "failed card" for an artifact that never existed would show the
     * user a deliverable that does not exist, while the script has very likely already caught the
     * error, had a subagent fill it in, and republished successfully.
     *
     * The reader of this event is the **event log** (the detail page's audit surface reads it by
     * paging the journal, without going through this reduction). The case is listed explicitly
     * rather than falling through to default so that "changes no state" is a **visible decision**,
     * not a forgotten branch.
     */
    case "artifact-failed":
      return run;
    case "usage-updated": {
      // The event directly carries the total amount spent (the engine has written dwf_run.spent_tokens in the line before emit); in its absence, the known value is maintained.
      if (typeof payload.spentTokens !== "number") return run;
      return { ...run, usage: { ...run.usage, spentTokens: payload.spentTokens } };
    }
    /**
     * escalation: an actor escalated a blocking question to the main agent and parked itself in
     * its own ask waiting for an answer.
     *
     * Just like report, it **does not touch `nodes[]` or actor state**: an escalation has no node
     * lifecycle and counts no step (waiting is not work — the same doctrine as report's
     * exemption). Nor should it flip the asking actor to idle — that actor's ask is still
     * dispatched, its status is still derived from the node phase, and not one character of it
     * changes here.
     *
     * The dedup key is `qid` rather than the station instance: an escalation has no site identity.
     * Upserting (rather than pushing) makes replay inherently idempotent — the same raised event
     * arriving again yields a byte-for-byte identical table, and the top-level JSON comparison then
     * returns null.
     */
    case "escalation-raised": {
      const qid = nonEmptyString(payload.qid);
      const question = nonEmptyString(payload.question);
      // qid is the identity, and question is the entire reason for the existence of this record; without either one, there is no way to display it, it only raises the water level.
      if (qid === undefined || question === undefined) return run;
      // The actor ref cannot be read without discarding the entire entry: the identity is the qid, and the actor is just an attribute. For a mutilated ref
      // Hiding the problem just destroys the only hidden value of "the stuck problem must be visible" (there is also a hidden label on the rendering side).
      const actorRef = workflowInstanceRef(payload.actor);
      const actorName = boundedActorName(nonEmptyString(payload.actorName));
      const context = nonEmptyString(payload.context);
      // The question time can only be carried by events: this module has no clock (purity convention in the file header). The event side is required, but the old journal
      // Events resulting from replay may not have it - in its absence the entire field does not fall, and the rendering side accordingly does not display the wait duration.
      const askedAt =
        typeof payload.askedAt === "number" && Number.isFinite(payload.askedAt)
          ? payload.askedAt
          : undefined;
      const pending: WorkflowRunPendingQuestion = {
        qid,
        ...(actorRef ? { actorSiteId: actorRef.siteId, actorOrdinal: actorRef.ordinal } : {}),
        ...(actorName === undefined ? {} : { actorName }),
        question: boundedQuestionText(question),
        ...(context === undefined ? {} : { context: boundedQuestionText(context) }),
        ...(askedAt === undefined ? {} : { askedAt }),
      };
      const upserted = upsertBoundedByQid(
        run.pendingQuestions ?? [],
        pending,
        WORKFLOW_RUNS_LIMITS.maxPendingQuestions,
      );
      return {
        ...run,
        pendingQuestions: upserted.list,
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * The main agent answered: that actor's turn continues in place and the question is no longer
     * outstanding.
     *
     * The answer itself **is not projected**: it lives in the actor turn's transcript as the tool
     * result of `escalate` (on a cache hit the whole turn is replayed byte-for-byte); here all
     * that is needed is to strike the question out of the "outstanding answers" table. The event
     * log row still carries the answer verbatim — that is the audit surface, a different thing
     * from the live fact of "who still owes an answer".
     */
    case "escalation-resolved": {
      const qid = nonEmptyString(payload.qid);
      if (qid === undefined) return run;
      return withoutPendingQuestions(run, (pending) => pending.qid !== qid);
    }

    /**
     * concurrency-changed: the process-level governor adjusted the cap of the provider key this run
     * belongs to. Does not touch `nodes[]` or actor state: a cap is a gate, not the business of
     * any node. The rules live in workflow-runs-concurrency.ts.
     */
    case "concurrency-changed":
      return reduceConcurrencyChanged(run, payload);

    /**
     * run-caps-changed: while the run was **in flight**, its own concurrency bound was changed (a
     * revision that only touches `max_concurrency` takes effect in place, without stopping this run
     * and without starting another). The payload is shaped like `run-started` and the rule is the
     * same one, so it lives together with it in workflow-runs-concurrency.ts.
     * Likewise it does not touch `nodes[]` or actor state: a bound is a gate, not the business of
     * any node.
     */
    case "run-caps-changed":
      return reduceRunCapsChanged(run, payload);

    /** phase-entered / run-launched: the phase reduction lives in the same-family workflow-runs-phases.ts (the latter only carries over the declared phase table). */
    case "phase-entered":
      return reducePhaseEntered(run, payload);
    case "run-launched":
      return reduceRunLaunched(run, payload);

    case "run-settled": {
      const status = payload.status;
      const error = isPlainRecord(payload.error) ? payload.error : undefined;
      const message = typeof error?.message === "string" ? error.message : undefined;
      // Final state clearing and parking problem: The truth is that the parking deferred in the process, and the final state run by definition has no one listening.
      // (cancel has caused cancelAsk to reject them; when the process dies, the entire registry disappears, and the `resolved` event
      // will never come). Leaving them in would be a sidebar that poses a question that cannot be answered—worse than not showing it at all, because
      // It reads like "Someone else is waiting." Empty occurs on **all** final states, including completed: a completed run
      // If it's still pending, it's just an afterimage that will never be followed.
      // Cooldown is "how long until new dispatches are frozen", the final state run no longer dispatches anything - leaving it on will just make the status header display a
      // Countdown without object. cap / ceiling remain: they are historical facts about the concurrency under which this run was run.
      const cleared = withoutCooldown(withoutPendingQuestions(run, () => false));
      // The boundary between waiting / completed in the actor's three states depends on whether run is the final state, so the final state needs to be re-derived:
      // An actor that is built but has not been asked changes from "waiting" to "completed" at the end of the run.
      // Three final state words; `stopReason` is only moved when stopped,
      // The successor pointer is only reached with superseded (the card draws links "replaced by run X" according to it).
      const carriedStopReason =
        status === "stopped" ? readWorkflowRunStopReason(payload.stopReason) : undefined;
      const supersededBy =
        carriedStopReason === "superseded" ? readRunIdField(payload.supersededBy) : undefined;
      // The status of `run-settled` in the previous journal is
      // Old words canceled/failed. Here, it turns out that words outside the closed set are "ignored", so the cold playback changes a run that has already stopped
      // Leave running: the card is lit, Cancel can be clicked, and there is nothing to cancel in the backend. When the settlement event arrives, run will never be alive again:
      // Unrecognized words will be finalized as errored (unrecoverable, unlit Resume), and the text will be retained. If it is absent, it will indicate which word it is.
      // The cold replay on the CLI side has been changed to cast settlement by row (dynamic-workflow-run-replay.ts), which is the second online gate.
      const terminal = status === "completed" || status === "errored" || status === "stopped";
      const settledMessage = terminal
        ? message
        : (message ?? `run settled with an unrecognized status: ${String(status)}`);
      return withDerivedWorkflowActorStatuses({
        ...cleared,
        status: terminal ? status : "errored",
        ...(carriedStopReason === undefined ? {} : { stopReason: carriedStopReason }),
        ...(supersededBy === undefined ? {} : { supersededBy }),
        ...(settledMessage === undefined
          ? {}
          : { error: settledMessage.slice(0, WORKFLOW_RUNS_LIMITS.maxErrorLength) }),
        // Recoverability is adjudicated by the CLI on the payload (same predicate of the resume gate), where only transfers are present; is present if true.
        ...(payload.resumable === true ? { resumable: true as const } : {}),
      });
    }
    // log / compaction is not a step, nor does it have a site id, so it only raises the water level (they only enter the event log, not the picture).
    default:
      return run;
  }
}

/** The engine's `InstanceRef` / `ActorRef` are isomorphic: site id × ordinal. Missing either makes it unlocatable, so null is returned. */
function workflowInstanceRef(value: unknown): { siteId: string; ordinal: number } | null {
  if (!isPlainRecord(value)) return null;
  const siteId = nonEmptyString(value.siteId);
  const ordinal = value.ordinal;
  if (siteId === undefined || typeof ordinal !== "number") return null;
  return { siteId, ordinal };
}

/**
 * Keeps the pending questions matching a predicate, and **removes the whole key when not a single
 * one is left** (rather than leaving an empty array).
 *
 * "Zero entries ⇒ key absent" is this field's protocol contract (see the schema comment); the
 * sidebar renders no section at all on that basis. It is also the pivot of idempotency: resolving a
 * qid that is already not in the table yields a byte-for-byte identical run object, and the
 * top-level JSON comparison then returns null — no revision bump, no UI refresh.
 */
function withoutPendingQuestions(
  run: WorkflowRunState,
  keep: (pending: WorkflowRunPendingQuestion) => boolean,
): WorkflowRunState {
  const current = run.pendingQuestions;
  if (current === undefined) return run;
  const remaining = current.filter(keep);
  if (remaining.length === current.length) return run;
  if (remaining.length > 0) return { ...run, pendingQuestions: remaining };
  const { pendingQuestions: _emptied, ...withoutKey } = run;
  return withoutKey;
}

/** Display bound for the question / supplementary explanation. The ellipsis makes the truncation visible, the same idiom as the report preview. */
function boundedQuestionText(text: string): string {
  const limit = WORKFLOW_RUNS_LIMITS.maxQuestionLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * The display preview of a report entry.
 *
 * The serialization rules are the **same source** as the run artifact hand-back
 * (`serializeWorkflowArtifact`: strings as-is, everything else pretty JSON — it used to live in
 * contracts, moved into this package together with this reduction, and is re-exported on the
 * contracts side), because the same value shows up both in the completion notification's
 * `<reports>` and in the detail page's Results section, and the two looking different is a bug.
 * Computed on the reduction side rather than left to the renderer: the preview is a **bounded**
 * field on the protocol wire, and copying the serialization contract into the UI layer will one
 * day drift apart from the text in the notification / TaskOutput.
 */
function workflowReportPreview(item: unknown): string {
  // The payload has been passed boundDynamicWorkflowRunEventPayload(String 2048 / Depth 6 / 32 keys), so here
  // It can only go out of bounds because "objects with many keys become longer after being expanded into pretty JSON". The ellipsis makes the truncation visible on the UI,
  // So there is no need to add a protocol field to each entry (run-level truncated means "there are entries that did not come in", which are two different things).
  const text = serializeWorkflowArtifact(item) ?? "";
  const limit = WORKFLOW_RUNS_LIMITS.maxReportPreviewLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
