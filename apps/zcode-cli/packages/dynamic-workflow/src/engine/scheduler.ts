/**
 * The ask scheduler: it splits "per-actor FIFO + hold rules + dispatch under the concurrency cap + ask settlement" out of the engine body so that
 * both files stay focused and readable (and satisfy the per-file line limit). The engine injects its
 * dependencies (driver, caps, ordinal allocation, run-level failure) through {@link SchedulerHost}; the scheduler owns only the ask lifecycle and never the run lifecycle.
 *
 * The key rules are described at the top of engine.ts: cache-hit short circuit, actorSeq admission order, the hold rules of replay, serial actors.
 *
 * The internal types and SchedulerHost live in scheduler-types.ts; the upward reporting of submit / turn lives in scheduler-submit.ts
 * (split because of the 400-line oxlint max-lines limit). SchedulerHost is re-exported in place here, so the import paths are unchanged.
 */

import { inputHash } from "./hash.js";
import { importedAskRecord, type ImportedActorState } from "./imported-cache.js";
import {
  defer,
  drainActorAdmission,
  hashMismatch,
  describeCause,
  headOfInstructions,
  type Actor,
  type AskNode,
  type Deferred,
  type SchedulerHost,
} from "./scheduler-types.js";
import { handleSubmitAttempted, handleTurnEnded, type SubmitSeam } from "./scheduler-submit.js";
import type {
  ActorId,
  ActorRef,
  AskMessage,
  AskSpec,
  AskStats,
  InstanceRef,
  JournalStorePort,
  NodeRecord,
  PersonaSpec,
  SessionRef,
} from "./types.js";
import { NUDGE_ATTEMPTS, refToString, REPAIR_ATTEMPTS, WorkflowError } from "./types.js";

export { hashMismatch } from "./scheduler-types.js";
export type { SchedulerHost } from "./scheduler-types.js";

export class AskScheduler {
  private readonly actors = new Map<ActorId, Actor>();
  private readonly actorOrder: Actor[] = [];
  private readonly liveNodes = new Map<string, AskNode>();
  /**
   * The ask instances whose "transcript predates this dispatch" (`siteId@ordinal`): those continuing a predecessor's in-flight ask, and those redispatched on resume
   * from the running rows. Their journaled stats have `worldToolCalls` stripped, see {@link journaledStats}.
   * They are not cleaned up after settlement -- a late stats backfill still has to look them up.
   */
  private readonly priorTranscriptAsks = new Set<string>();
  private activeAsks = 0;

  /** The free functions of scheduler-submit.ts use it to look up live nodes and settle by result (see {@link SubmitSeam}). */
  private readonly submitSeam: SubmitSeam;

  constructor(private readonly host: SchedulerHost) {
    this.submitSeam = {
      host,
      liveNode: (instance) => this.liveNodes.get(refToString(instance)),
      settleOk: (node, artifact) => this.settleOk(node, artifact),
      settleFailed: (node, error) => this.settleFailed(node, error),
    };
  }

  private get journal(): JournalStorePort {
    return this.host.driver.journal;
  }

  hasActor(id: ActorId): boolean {
    return this.actors.has(id);
  }

  /**
   * Registers an actor (a creation site x ordinal). `imported` is the import candidate for amend-resume: the engine has already matched it in
   * createActor by effective name + normalized persona, and the scheduler only has to consume it.
   */
  registerActor(
    ref: ActorRef,
    id: ActorId,
    name: string | undefined,
    persona: PersonaSpec,
    imported?: ImportedActorState,
  ): Actor {
    const recordedCount = this.journal
      .listNodes(this.host.runId)
      .filter(
        (n) => n.kind === "ask" && n.actorSiteId === ref.siteId && n.actorOrdinal === ref.ordinal,
      ).length;
    const actor: Actor = {
      ref,
      id,
      persona,
      name,
      recordedCount,
      nextAdmitSeq: 0,
      pendingRecorded: new Map(),
      pendingLive: [],
      liveQueue: [],
      ...(imported === undefined ? {} : { imported }),
    };
    // The sessionId recorded in the journal cannot be pre-parsed into actor.session/sessionPromise:
    // Let ensureSession after resume skip driver.createActorSession. But the session table of the production driver
    // **Only** populated in createActorSession, startAsk checks the session by table - so resume redispatches each
    // ask all failed with "unknown session". Both pure replay (zero dispatch) and fake driver (startAsk does not look up the table) are exposed
    // No more it. The session identity is owned by the driver (the production casting function is purely determined by (runId, actorRef), and when re-hanging
    // (cast the same id); the journal's dwf_actor.session_id is a record, not an authority, so it will never be used here.
    // Journal short-circuit session - the first dispatch will always go through driver.createActorSession (see ensureSession).
    this.actors.set(id, actor);
    this.actorOrder.push(actor);
    return actor;
  }

  /** Accepts one ask: a completed-cache hit short circuits (following the hold rules), while a running hit or a miss is dispatched live. */
  admitAsk(
    siteId: string,
    actorId: ActorId,
    instructions: string,
    spec: AskSpec,
  ): Promise<unknown> {
    const actor = this.actors.get(actorId)!;
    const ordinal = this.host.nextOrdinal(siteId);
    const instance: InstanceRef = { siteId, ordinal };
    const hash = inputHash(instructions);
    const deferred = defer<unknown>();

    const recorded = this.journal.getNode(this.host.runId, siteId, ordinal);
    if (recorded !== undefined) {
      // A hit is a defensive check inputHash - inconsistency indicates that the purity contract is broken and the run fails loudly.
      if (recorded.inputHash !== hash) {
        const err = hashMismatch(instance, recorded.inputHash, hash);
        this.host.failRun(err);
        return Promise.reject(err);
      }
      const seq = recorded.actorSeq ?? 0;
      const reconcile = (): void =>
        actor.imported?.reconcileRecorded(
          seq,
          recorded.inputHash,
          this.host.wasLiveBeforeResume(instance),
          this.host.wasQueuedBeforeImportClose(instance),
        );
      if (recorded.status === "running") {
        // Crash in execution: re-live dispatch according to the recorded actorSeq position (the hold rule guarantees its admission order).
        // The transcription of this article already contains the messages that were sent in the previous round, so click "Transcription earlier than this distribution" to record the stats.
        actor.pendingRecorded.set(seq, () => {
          reconcile();
          this.admitLive(instance, actor, seq, instructions, hash, spec, deferred, true);
        });
      } else {
        // completed/failed: short circuit settlement, no driver call.
        actor.pendingRecorded.set(seq, () => {
          reconcile();
          this.releaseCachedAsk(instance, recorded, deferred);
        });
      }
      this.drainAdmission(actor);
      return deferred.promise;
    }

    // Miss (fresh): Register to pendingLive, admit and allocate new actorSeq in order of arrival after the record node is drained.
    // After assigning to seq, first ask the import cache (amend-resume): a hit means cached settle, not live.
    actor.pendingLive.push(() => {
      const seq = actor.nextAdmitSeq++;
      if (this.tryImportedSettle(instance, actor, seq, hash, deferred)) return;
      // Only after the miss does you know whether it is a "flying ask of the continuation pioneer" - the decision is made along with the difference in the take.
      const carried = actor.imported?.carriedAt(seq) === true;
      this.admitLive(instance, actor, seq, instructions, hash, spec, deferred, carried);
    });
    this.drainAdmission(actor);
    this.pumpAll();
    return deferred.promise;
  }

  /**
   * Admits an ask as a live node: it creates the node, writes the running record right at admission, enqueues it and records the event.
   *
   * `priorTranscript` being true means this one does not start from an empty transcript (continuing a predecessor's in-flight ask, or redispatched on resume from the running
   * rows) -- it affects only how the stats are journaled, see {@link journaledStats}.
   */
  private admitLive(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    instructions: string,
    hash: string,
    spec: AskSpec,
    deferred: Deferred<unknown>,
    priorTranscript = false,
  ): void {
    if (priorTranscript) this.priorTranscriptAsks.add(refToString(instance));
    // The beginning of the instruction falls into place with the birth event: instructions here is still
    // The author's original text - driver quality / schema endnotes are only added in startAsk, so the engine words will not be mixed into the summary.
    // Count once and exist on the node: the distribution must repeat the birth fact, and the two events must be the same string.
    const instructionsHead = headOfInstructions(instructions);
    const node: AskNode = {
      instance,
      actor,
      actorSeq: seq,
      instructions,
      hash,
      spec,
      deferred,
      repairsRemaining: REPAIR_ATTEMPTS,
      nudgesRemaining: NUDGE_ATTEMPTS,
      settled: false,
      dispatched: false,
      ...(instructionsHead === undefined ? {} : { instructionsHead }),
    };
    this.liveNodes.set(refToString(instance), node);
    // Fall after admission to running (with actorSeq + inputHash): The resume node that crashes during execution can be redistributed accordingly.
    this.journal.putNode({
      runId: this.host.runId,
      siteId: instance.siteId,
      ordinal: instance.ordinal,
      kind: "ask",
      actorSiteId: actor.ref.siteId,
      actorOrdinal: actor.ref.ordinal,
      actorSeq: seq,
      inputHash: hash,
      status: "running",
    });
    actor.liveQueue.push(node);
    this.host.record({
      type: "node-queued",
      instance,
      kind: "ask",
      actor: actor.ref,
      actorSeq: seq,
      ...(instructionsHead === undefined ? {} : { instructionsHead }),
    });
    // Switching to live does not turn off the import cache. Once closed here: any ask live
    // This means that the workspace may be overwritten. That's using the clock instead of the dependency - the one after the first miss in the same Promise.all
    // Brothers ask are all invalidated, and there is no dependence between them (actually measured 50-way fan-out lost 6 hits, 5-way fan-out
    // Throw away the only 1). What is closed now is the **first write**: reported by the driver when the subagent is about to execute the rewrite tool
    // askMutating, or a world.run live execution; the world before this is the same as the world left by the predecessor, and cache hits are true.
  }

  /**
   * Asks the import cache (amend-resume) once when admitting a fresh ask. A hit settles as **cached** and returns true
   * (the caller does not go live); both the decision and the divergence bookkeeping live in {@link ImportedActorState}.
   *
   * A hit writes one **real** dwf_node and emits only `node-settled cached:true` -- the same posture as a replay hit in
   * {@link releaseCachedAsk}: no node-queued / node-dispatched is emitted,
   * nothing enters the liveQueue, no session is created, and `actor.current` is not occupied.
   */
  private tryImportedSettle(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    hash: string,
    deferred: Deferred<unknown>,
  ): boolean {
    // Caching is turned off ⇒ only put **pure** ask (precursor notes toolCalls === 0): it only relies on the command and transcription prefix, and the workspace
    // has nothing to do, so the answer to the old world is also true to the new world; the entry with the tool also has the same hash as the live-it read
    // The workspace may have been overwritten. The ask that transferred live makes the actor different (the transcription will be different from now on), and the consumed prefix is still the seed
    // The basis for the boundary.
    const entry = this.host.importCacheClosed()
      ? actor.imported?.takeIfPure(seq, hash)
      : actor.imported?.take(seq, hash);
    if (entry === undefined) return false;
    this.journal.putNode(importedAskRecord(this.host.runId, instance, actor.ref, seq, hash, entry));
    this.host.record({ type: "node-settled", instance, outcome: "ok", cached: true });
    deferred.resolve(entry.result);
    return true;
  }

  // ———————————————————————————————— Return upward ——————————————————————————————

  /** submit_result arrives: the body is handleSubmitAttempted in scheduler-submit.ts. */
  submitAttempted(instance: InstanceRef, payload: unknown): void {
    handleSubmitAttempted(this.submitSeam, instance, payload);
  }

  /** A turn ended (no submit): the body is handleTurnEnded in scheduler-submit.ts. */
  turnEnded(instance: InstanceRef, finalText: string): void {
    handleTurnEnded(this.submitSeam, instance, finalText);
  }

  noteStats(instance: InstanceRef, stats: AskStats): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node !== undefined) {
      node.lastStats = stats;
      return;
    }
    // The node has left liveNodes - typed-accept dominant path: submit stops turning and is dropped when settling, while the real
    // The actor usage is not known until the turn is parsed (after submit), so stats arrive after settlement. Backfill settled
    // Journal record: only add/overwrite stats, retain status/result/actorSeq/inputHash/error/kind/actor identity.
    // Best effort and idempotent; budget deductions are still in engine.askStats (only journal integrity is supplemented here).
    const recorded = this.journal.getNode(this.host.runId, instance.siteId, instance.ordinal);
    if (recorded === undefined) return;
    this.journal.putNode({ ...recorded, stats: this.journaledStats(instance, stats) });
  }

  /**
   * The stats journaled: `worldToolCalls` is stripped for an ask whose **transcript predates this dispatch**.
   *
   * The root cause: the driver's tool counters live in memory and are zeroed at the start of every ask, so an ask continuing from an existing transcript only counts
   * its own few turns and not a single pre-existing tool call in the transcript. Under-reporting is not a bookkeeping inaccuracy (that is what tokens are
   * for), it is **corruption of the purity criterion**: an ask reporting 0 is later taken by a revision for a pure entry and still settles from the cache
   * after the gate closes -- even though it did touch the workspace. The absence of this key already means "it touched" (the conservative reading), so stripping it is the honest record.
   * tokens / toolCalls / turns are recorded as usual: they are usage, not a purity claim.
   */
  private journaledStats(instance: InstanceRef, stats: AskStats): AskStats {
    if (!this.priorTranscriptAsks.has(refToString(instance))) return stats;
    const { worldToolCalls: _unreliable, ...rest } = stats;
    return rest;
  }

  failed(instance: InstanceRef, error: WorkflowError): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node === undefined || node.settled) return;
    this.settleFailed(node, error);
  }

  /** Whether this instance is still a live ask in flight (admitted, not yet settled) -- a rate limit observation event only means something for such a node. */
  isLive(instance: InstanceRef): boolean {
    const node = this.liveNodes.get(refToString(instance));
    return node !== undefined && !node.settled;
  }

  /** The effective name of the subagent an in-flight ask belongs to (used to name it in the gate event); undefined when it is not in flight. */
  liveActorName(instance: InstanceRef): string | undefined {
    const node = this.liveNodes.get(refToString(instance));
    return node === undefined || node.settled ? undefined : node.actor.persona.name;
  }

  /** Aborts all in-flight asks: used when a run is cancelled or fails. When emitCancelled is true it also emits node-settled(cancelled). */
  abortInFlight(error: WorkflowError, emitCancelled: boolean): void {
    for (const node of this.liveNodes.values()) {
      if (node.settled) continue;
      node.settled = true;
      if (node.dispatched) this.host.driver.cancelAsk(node.instance);
      if (emitCancelled) {
        this.host.record({ type: "node-settled", instance: node.instance, outcome: "cancelled" });
      }
      node.deferred.reject(error);
    }
    this.liveNodes.clear();
    this.activeAsks = 0;
  }

  // ———————————————————————————————— Internal: Admission/Distribution ————————————————————————————

  private drainAdmission(actor: Actor): void {
    drainActorAdmission(actor);
    this.pumpActor(actor);
  }

  /**
   * Asks with a hit record: they are released in the **settlement order** recorded in the journal. The hold rules pin the admission order within one actor, while the completion order
   * across actors only comes back through this gate -- every journal call after an await on a fan-out branch is numbered by it.
   */
  private releaseCachedAsk(
    instance: InstanceRef,
    recorded: NodeRecord,
    deferred: Deferred<unknown>,
  ): void {
    this.host.holdForReplay(instance, () => this.settleCachedAsk(instance, recorded, deferred));
  }

  private settleCachedAsk(
    instance: InstanceRef,
    recorded: NodeRecord,
    deferred: Deferred<unknown>,
  ): void {
    if (recorded.status === "completed") {
      this.host.record({ type: "node-settled", instance, outcome: "ok", cached: true });
      deferred.resolve(recorded.result);
    } else {
      // Logged failures are also subject to short-circuit replay: the script may have try/catched it and branched accordingly, and the replay must replay the same rejection.
      this.host.record({
        type: "node-settled",
        instance,
        outcome: "failed",
        cached: true,
        error: recorded.error,
      });
      deferred.reject(WorkflowError.fromJSON(recorded.error!));
    }
  }

  /**
   * Rescans the pending dispatch queue of every actor. The public surface exists **for exactly one caller**: the engine calls it after raising this run's concurrency upper bound.
   * The bound itself is
   * read fresh before every dispatch by {@link pumpActor}, but no other event triggers a rescan -- without one, a queued ask
   * would sit there until the next settlement, and "run a few more right after raising it" is precisely what this command buys.
   */
  pumpAll(): void {
    for (const actor of this.actorOrder) this.pumpActor(actor);
  }

  private pumpActor(actor: Actor): void {
    if (this.host.isRunSettled()) return;
    if (actor.current !== undefined) return;
    if (actor.liveQueue.length === 0) return;
    if (this.activeAsks >= this.host.caps.maxConcurrency) return;
    const node = actor.liveQueue.shift()!;
    actor.current = node;
    this.activeAsks++;
    void this.dispatch(node);
  }

  private async dispatch(node: AskNode): Promise<void> {
    let session: SessionRef;
    try {
      session = await this.ensureSession(node.actor);
    } catch (cause) {
      if (this.host.isRunSettled() || node.settled) return;
      // Bring the text of cause into message: WorkflowError.toJSON only falls in code/message, and cause does not enter journal.
      // No one keeps logs, so "Failed to create actor session" becomes an undiagnosable black box in the GUI/journal
      // (The bottom layer on the real machine is actually the FOREIGN KEY constraint failed of session_task_link).
      this.settleFailed(
        node,
        new WorkflowError(
          "DriverError",
          `Failed to create the subagent session: ${describeCause(cause)}`,
          { cause },
        ),
      );
      return;
    }
    if (this.host.isRunSettled() || node.settled) return;
    // node-dispatched after the session is ready. Process level concurrency gate
    // Not here: it requests admission according to the model and lives in the runtime deps under the driver; the scheduler only observes
    // A per-run ask-level upper bound.
    // This one repeats the birth fact of the instance (`node-dispatched` in types.ts): the ones the scheduler has on hand
    // Similar to its `node-queued` counterpart, the two birth stage names are filled in by the engine according to the same casting table in the record.
    this.host.record({
      type: "node-dispatched",
      instance: node.instance,
      kind: "ask",
      actor: node.actor.ref,
      ...(node.actor.name === undefined ? {} : { actorName: node.actor.name }),
      ...(node.instructionsHead === undefined ? {} : { instructionsHead: node.instructionsHead }),
    });
    node.dispatched = true;
    const message: AskMessage = {
      instructions: node.instructions,
      typed: node.spec.typed,
      schema: node.spec.schema,
    };
    this.host.driver.startAsk(session, node.instance, message);
  }

  private ensureSession(actor: Actor): Promise<SessionRef> {
    if (actor.sessionPromise !== undefined) return actor.sessionPromise;
    // The seed is only known at the divergence point (discovered during runtime), so it must be handed over to the driver from the engine side here - the engine holds it.
    // In the import state, the driver holds the session store, and this signature is the minimum convergence point of the two.
    const seed = actor.imported?.seed();
    const promise = this.host.driver
      .createActorSession(actor.ref, actor.persona, seed)
      .then((session) => {
        actor.session = session;
        // resolvedModel is written **inside** createActorSession by the runtime factory on the host side (it only knows
        // which model "lite" falls into). putActor is the replacement of the entire record, so this write must read back the value just written
        // Bring it over, otherwise it will be erased here - the audit and resume basis for gear resolution will be lost.
        const resolvedModel = this.journal.getActor(
          this.host.runId,
          actor.ref.siteId,
          actor.ref.ordinal,
        )?.resolvedModel;
        this.journal.putActor({
          runId: this.host.runId,
          siteId: actor.ref.siteId,
          ordinal: actor.ref.ordinal,
          name: actor.name,
          persona: actor.persona,
          sessionId: session.id,
          resolvedModel,
        });
        return session;
      });
    actor.sessionPromise = promise;
    return promise;
  }

  // ———————————————————————————————— Internal: Settlement ——————————————————————————————

  private settleOk(node: AskNode, artifact: unknown): void {
    if (node.settled) return;
    node.settled = true;
    this.journal.putNode(this.nodeRecordFor(node, { status: "completed", result: artifact }));
    this.host.record({ type: "node-settled", instance: node.instance, outcome: "ok" });
    this.finishLiveNode(node);
    node.deferred.resolve(artifact);
  }

  private settleFailed(node: AskNode, error: WorkflowError): void {
    if (node.settled) return;
    node.settled = true;
    // Settlement failures must fall into the journal (overriding the running time of admission): failure is "complete", and the script may have observed the rejection
    // And branching accordingly, replay must reproduce it - failure to journalize is a requirement for replay correctness, not an option.
    this.journal.putNode(this.nodeRecordFor(node, { status: "failed", error: error.toJSON() }));
    this.host.record({
      type: "node-settled",
      instance: node.instance,
      outcome: "failed",
      error: error.toJSON(),
    });
    this.finishLiveNode(node);
    // If the node fails, only the ask will be rejected, and the entire run will not fail (the script can be try/catch).
    node.deferred.reject(error);
  }

  private finishLiveNode(node: AskNode): void {
    this.liveNodes.delete(refToString(node.instance));
    if (node.actor.current === node) {
      node.actor.current = undefined;
      this.activeAsks--;
    }
    this.pumpAll();
  }

  private nodeRecordFor(
    node: AskNode,
    outcome:
      | { status: "completed"; result: unknown }
      | { status: "failed"; error: NodeRecord["error"] },
  ): NodeRecord {
    const record: NodeRecord = {
      runId: this.host.runId,
      siteId: node.instance.siteId,
      ordinal: node.instance.ordinal,
      kind: "ask",
      actorSiteId: node.actor.ref.siteId,
      actorOrdinal: node.actor.ref.ordinal,
      actorSeq: node.actorSeq,
      inputHash: node.hash,
      status: outcome.status,
    };
    if (outcome.status === "completed") record.result = outcome.result;
    else record.error = outcome.error;
    if (node.lastStats !== undefined)
      record.stats = this.journaledStats(node.instance, node.lastStats);
    return record;
  }
}
