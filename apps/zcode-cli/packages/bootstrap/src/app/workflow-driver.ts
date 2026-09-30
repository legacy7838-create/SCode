// ============================================================
// AgentRuntime-backed WorkflowDriver(Boundary B)
// ============================================================
// Drop the downward side effect port WorkflowDriver of the dynamic-workflow engine core onto the real ZCode AgentRuntime:
// One **persistent** child runtime per actor (repeat executeTurn to accumulate messageHistory), once per ask
// executeTurn, the results of typed ask are bridged back to the engine for adjudication via the session-level WorkflowSubmitPort.
//
// The other two halves of Boundary B - `executeWorldRead` and `executeArtifactPublish` - live in
// workflow-world-read.ts and workflow-artifact-publish.ts, this file is only forwarded. There is neither here nor there
// Common state (does not touch session, turn, submit bridge), so after separation, only "session and turn arrangement" remain in this document
// This one thing.
//
// Three timings (the core invariants of this document):
//   1. accept: The model calls submit_result → the handler blocks in port.respond → this driver reports
//      askSubmitAttempted → Engine verification passed → respondToSubmit(accept) → Unlock deferred to {accept:true}
//      → handler returns success (hang turnControl to stop turn) → executeTurn resolve → only report askStats (no longer report
//      askTurnEnded because the ask has been resolved by the engine).
//   2. reject (same as repair in turn): respondToSubmit(reject, violations) → Unlock deferred as
//      {accept:false, violations} → handler throws an error → error tool_result (no turnControl) → continue with the same turn
//      → Model retry → respond again → deferred again. The repair engine changes cancelAsk when the budget is exhausted.
//   3. nudge (turn ended but not submitted): executeTurn resolve and not accepted → report askTurnEnded → engine decides nudge
//      → respondToSubmit(nudge) (at this time **no** parked deferred, turn has ended) → initiated on the same persistent runtime
//      A **new** executeTurn (nudge hint).
//
// Three-value→two-value verdict mapping (engine SubmitVerdict three-value; contracts WorkflowSubmitPort two-value):
//   accept → {accept:true}; reject → {accept:false, violations} (Violation 1:1 mapping); nudge → no deferred,
//   Qixin turn. See respondToSubmit.
//
// The fourth timing (upgrade Q&A) is on the same level as the above three:
//   4. escalate: model calls escalate → handler blocks in escalatePort → driver casts qid, stops deferred,
//      Register the problem into the upgrade registry and issue escalation-raised (journal + emit) in two ways → the main agent runs
//      service's resolveQuestion lookup table → driver.respondToEscalation unwraps the deferred and issues it
//      escalation-resolved → tool result = answer text → actor's turn continues in place, ask settles as usual.
//      The engine core has **zero awareness** of this: the upgrade occurs within the boundaries of the driver execution ask (same layer as the repair/nudge round),
//      Do not write the dwf_node line. The escape hatch is cancelAsk - it rejects along with the parked upgrade deferred.
//
// amend-resume adds two driver-private things to this file, both of which only
// It is related to session transcription, so the mechanism lives in workflow-actor-transcript.ts, and only orchestration is done here (the three implementations of orchestration are in
// workflow-driver-transcript.ts):
//   - **ask boundary accounting**: After an exchange (including the repair/nudge round and the closing message after submit), the actor
//     The number of messages that have been logged out of the session is written into the journal line of this ask. Every ask is written - any run is for future revisions
//     potential precursor.
//   - **Transcription truncation**: When `createActorSession` is seeded, copy the first N messages of the source session into the newly cast session and rehydrate them.
// There is a third item in this round, which is also only related to transcription and also lives in its own module (workflow-driver-quiescence.ts):
//   - **Session Silent Registration**: When dispose, record whether there are still turns being written in each session. Revised one when flying the front wheel, amend
//     It is necessary to use it to judge "whether the number of messages counted at this moment is credible" before we can talk about continuing the unfinished ask.

import type { SessionId, WorkflowEscalatePort } from "@zcode/contracts";
import type { TurnResult } from "@zcode/core";
import {
  GENERIC_SUBMIT_PROFILE,
  refToString,
  WorkflowError,
  type ActorRef,
  type ActorSessionSeed,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
  type AskMessage,
  type InstanceRef,
  type JournalStorePort,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type SubmitVerdict as EngineSubmitVerdict,
  type WorkflowDriver,
  type WorkflowReportSink,
  type WorldReadOp,
} from "@zcode/dynamic-workflow";
import { executeArtifactPublish } from "./workflow-artifact-publish.js";
import { qualityEpilogue } from "./workflow-ask-epilogue.js";
import { ensureSubmitProfileFits } from "./workflow-driver-submit-profile.js";
import { executeWorldRead } from "./workflow-world-read.js";
import {
  createActorModelActivity,
  createRunStallClock,
  type RunStallClock,
} from "./workflow-driver-concurrency.js";
import { handleModelTurnFailure, type ModelFailureHost } from "./workflow-driver-model-failure.js";
import {
  createActorSessionQuiescence,
  releaseActorSessions,
  type ActorSessionQuiescenceLedger,
} from "./workflow-driver-quiescence.js";
import {
  makeSessionEscalatePort,
  respondToParkedEscalation,
  withdrawSessionEscalations,
  type EscalationHost,
} from "./workflow-driver-escalation.js";
import {
  NUDGE_PROMPT,
  TYPED_TOOL_EPILOGUE,
  effectiveActorName,
  isTurnCancelled,
  mapViolations,
  mintActorSessionId,
  reportTurnObservations,
  schemaEpilogue,
  toWorkflowError,
} from "./workflow-driver-helpers.js";
import { makeSessionSubmitPort, type SubmitBridgeHost } from "./workflow-driver-submit-bridge.js";
import {
  countSessionTranscript,
  journalAskMessageBoundary,
  seedActorSession,
} from "./workflow-driver-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * The real implementation of WorkflowDriver. Construction goes through {@link createAgentRuntimeWorkflowDriver} (binding deps and back-filling the sink).
 */
class AgentRuntimeWorkflowDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;
  readonly emit: (event: RunEvent) => void;

  private readonly sink: WorkflowReportSink;
  private readonly deps: AgentRuntimeWorkflowDriverDeps;
  private readonly sessions = new Map<string, SessionState>();
  /** refToString(instance) → the session that owns it, so respondToSubmit / cancelAsk can look it back up. */
  private readonly instanceToSession = new Map<string, SessionState>();
  /** qid → the session that parks it, so respondToEscalation can look it back up (a sibling of instanceToSession). */
  private readonly qidToSession = new Map<string, SessionState>();
  /** A per-run monotonic escalation sequence number; the second segment of the qid. Together with runId it forms a collision-free id. */
  private escalationSeq = 0;
  /** The idempotency gate for dispose (the engine contract is exactly once, but a gate here is cheaper and steadier). */
  private disposed = false;
  /** This run's subscription to governor cap changes (one per run, unsubscribed on dispose). */
  private readonly concurrencyUnsubscribe?: () => void;
  /**
   * The host surface handed to the escalation bridge (workflow-driver-escalation.ts): both tables are shared by reference, and the sequence
   * number and record come back into this class through closures — private state never leaks and the bridge need not know the class shape.
   */
  private readonly escalationHost: EscalationHost;
  /** The host surface handed to model-side failure containment (workflow-driver-model-failure.ts): the same shared-by-reference approach. */
  private readonly modelFailureHost: ModelFailureHost;
  /** The host surface handed to the submit bridge (workflow-driver-submit-bridge.ts): as above, both shared by reference. */
  private readonly submitHost: SubmitBridgeHost;
  /** The run-level stall clock: the success / retry beats of every actor funnel into this single table. */
  private readonly stallClock: RunStallClock;
  /**
   * The session quiescence ledger (workflow-driver-quiescence.ts): at the moment of dispose, whether each session still has a turn writing.
   * Its only reader is amend — before continuing the predecessor's in-flight ask it must confirm that the session has finished writing.
   */
  private readonly quiescence: ActorSessionQuiescenceLedger;

  constructor(deps: AgentRuntimeWorkflowDriverDeps, sink: WorkflowReportSink) {
    this.deps = deps;
    this.sink = sink;
    this.journal = deps.journal;
    // The engine's record() calls driver.emit (engine.ts) immediately for each event, so here is driver
    // The only place where we can see the end of ask: `node-settled` is the three settlement paths (settleOk / settleFailed /
    // abortInFlight), that is, the seat gate, etc. "This one is not working."
    //
    // Why not use the driver's own state judgment: `state.currentInstance` is never cleared, untyped ask
    // askTurnEnded is still true after `live()` is resolved on the engine side - if you use it to vacate the seat, it will never be vacated and the FIFO will wait.
    //
    // The ** passed down must be the same object reference **: the sequence on the launch side is intercepted and the sequence number is checked according to reference equality.
    // (createJournalSequenceCapture of dynamic-workflow-run-launch.ts).
    this.emit =
      deps.seatGate === undefined
        ? deps.emit
        : (event) => {
            if (event.type === "node-settled") deps.seatGate?.askSettled(event.instance);
            deps.emit(event);
          };
    this.escalationHost = {
      deps,
      sessions: this.sessions,
      qidToSession: this.qidToSession,
      nextEscalationSeq: () => ++this.escalationSeq,
      record: (event) => this.record(event),
    };
    this.submitHost = { sessions: this.sessions, sink };
    this.modelFailureHost = {
      deps,
      sink,
      isDisposed: () => this.disposed,
      runTurn: (state, instance, input, epilogueStart) =>
        this.runTurn(state, instance, input, epilogueStart),
    };
    this.stallClock = createRunStallClock({
      ...(deps.clock?.now === undefined ? {} : { now: deps.clock.now }),
      ...(deps.clock?.schedule === undefined ? {} : { schedule: deps.clock.schedule }),
      ...(deps.clock?.stallAfterMs === undefined ? {} : { afterMs: deps.clock.stallAfterMs }),
      onStalled: (info) => this.sink.runStalled(info),
    });
    this.quiescence = createActorSessionQuiescence({
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.clock?.quiesceMs === undefined ? {} : { quiesceMs: deps.clock.quiesceMs }),
    });
    // The probe is handed over at construction time: the run service will hook it on the entry, and amend may be in the life of this run.
    // Any moment comes. Submitting it after dispose is too late - by then the service is already counting sessions.
    deps.onQuiescenceProbe?.(this.quiescence);
    if (deps.concurrency !== undefined) {
      // Fanout only goes to runs that have in-flight/queued requests on that key, so the subscription itself can be done in one go at construction time.
      this.concurrencyUnsubscribe = deps.concurrency.subscribe(deps.runId ?? "run", (change) => {
        this.stallClock.noteCap(change.next);
        this.sink.concurrencyChanged(change);
      });
    }
  }

  async createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    const sessionId = mintActorSessionId(this.deps.runId ?? "run", actor);
    // resume session identity mutual authentication: journal's dwf_actor.session_id is a **record**, and the casting function is authoritative
    // ((runId, actorRef) is purely deterministic, and the same id will be cast when re-hanging). The inconsistency between the two can only be due to casting rules
    // Drift (renamed/second implementation) - the consequence is that the wrong session is read in the heavy water, and the details page opens a non-existent session, which is far from the cause.
    // So the first step of rehanging fails loudly with a structured mismatch (the same shape as the two hash mismatch errors).
    const journaled = this.journal.getActor(
      this.deps.runId ?? "run",
      actor.siteId,
      actor.ordinal,
    )?.sessionId;
    if (journaled !== undefined && journaled !== sessionId) {
      throw new WorkflowError(
        "DriverError",
        `Subagent session identity mismatch for ${refToString(actor)}: the journaled session ` +
          `id and the minted one differ.`,
        { mismatch: { expected: journaled, got: sessionId } },
      );
    }
    const ref: SessionRef = { id: sessionId };
    // Session-level submit port (implemented in workflow-driver-submit-bridge.ts, followed by the upgrade port
    // Symmetry one by one): closure is bound to this session, and the model cannot override the routing identity (instance is taken from currentInstance).
    const submitPort = makeSessionSubmitPort(this.submitHost, sessionId);
    // Upgrade port isomorphism: also bound by session closure, also constant injection (see field comments of ActorRuntimeFactory).
    // Once persona is merged into closure: the effective name is **frozen** (set by the engine when creatingActor and remains unchanged thereafter),
    // Therefore, counting it once here is cheaper than checking it every time it escalates, and the name will not be changed midway.
    const escalatePort = this.makeEscalatePort(sessionId, actor, persona);
    // Model active surface: The access port is downloaded with the runtime deps (the runner tries to pass the gate first every time),
    // Waiting/executing observations are only reported when there is an ask in flight and it has not yet been resolved/cancelled by the engine - a late observation is very important to a
    // The completed ask is meaningless, and the engine side will block it again. The state is built below, so it is bound late through closure.
    let state: SessionState | undefined;
    const live = (): InstanceRef | undefined =>
      state === undefined ||
      state.currentInstance === undefined ||
      state.accepted ||
      state.cancelled
        ? undefined
        : state.currentInstance;
    const modelActivity = createActorModelActivity({
      port: this.deps.concurrency,
      runId: this.deps.runId ?? "run",
      live,
      // Seat gate by **actor** type (not ask instance): per-actor FIFO guarantees that at most one actor is flying
      // ask, so "working subagents" and "flying ask" have the same count, and the admission port is based on actor session
      // Made.
      ...(this.deps.seatGate === undefined
        ? {}
        : { seat: { gate: this.deps.seatGate, key: refToString(actor) } }),
      handlers: {
        // Subagent's first workspace write ⇒ Engine off import cache.
        onMutating: (instance) => this.sink.askMutating(instance),
        onWaiting: (info) => {
          const instance = live();
          if (instance !== undefined) this.sink.askWaiting(instance, info);
        },
        onExecuting: () => {
          const instance = live();
          if (instance !== undefined) this.sink.askExecuting(instance);
        },
        // Two ticks of the run-level stall clock: the successful reset of any actor, and the retry of any reload.
        onRequestCompleted: () => this.stallClock.noteSuccess(),
        onRetryScheduled: (reason) => this.stallClock.noteRetryScheduled(reason),
      },
    });
    // Submit profile: Check by actor **site** - the same site
    // Each ordinal (each lane of fan-out) runs the same set of ask sites, and the profiles are naturally the same. absent = generic.
    const submitProfile =
      this.deps.actorSubmitProfiles?.get(actor.siteId) ?? GENERIC_SUBMIT_PROFILE;
    // await: The production factory drops the session into the library and builds a task link before returning (FK requires the session line to exist first).
    // The engine's ensureSession will await this method, so persistence is completed before the first ask is dispatched.
    const runtime = await this.deps.runtimeFactory({
      sessionId,
      actor,
      persona,
      submitPort,
      submitProfile,
      escalatePort,
      ...(seed === undefined ? {} : { seed }),
      ...(modelActivity.admission === undefined
        ? {}
        : { modelRequestAdmission: modelActivity.admission }),
    });
    if (seed !== undefined) {
      await seedActorSession(this.deps, {
        journaledSessionId: journaled,
        runtime,
        seed,
        sessionId,
      });
    }
    state = {
      ref,
      sessionId,
      runtime,
      submitProfile,
      currentTyped: false,
      accepted: false,
      cancelled: false,
      turnGeneration: 0,
      pendingEscalations: new Map(),
      escalationsUsed: 0,
      modelActivity,
      actor,
      actorName: effectiveActorName(persona),
      transientAttempts: 0,
    };
    modelActivity.observe(runtime, sessionId);
    this.sessions.set(sessionId, state);
    return ref;
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    const state = this.sessions.get(session.id);
    if (state === undefined) {
      // The theory will not happen (the engine creates a session first and then asks); it is normalized to report DriverError instead of silently.
      this.sink.askFailed(
        instance,
        new WorkflowError("DriverError", `Unknown subagent session: ${session.id}`),
      );
      return;
    }
    // If the previous ask left a stop on the abnormal path (the turn was interrupted by a method other than abort), remove it here:
    // Once a new ask is launched, no one will ever read the answers to those questions, and remaining in the registry will only let the snapshots lie.
    this.withdrawEscalations(state);
    state.currentInstance = instance;
    state.currentTyped = message.typed;
    state.accepted = false;
    state.cancelled = false;
    state.pendingSubmit = undefined;
    // The per-ask budget is reset to zero (nudge takes runTurn, not through this - nudge is still in the same ask).
    state.escalationsUsed = 0;
    state.abortController = new AbortController();
    // The waiting/executing phase and tool count of the previous ask cannot be brought to this ask; the same applies to the transient redrive count.
    state.modelActivity.reset();
    // The starting point of ask is fed to the seat gate (the end point is identified as `node-settled` in emit): from this moment on, the subagent is considered "working",
    // Its next turn step is therefore past the seat. When the same actor is connected to the next ask, this is an idempotent join——
    // It has been working all the time and has never been idle.
    this.deps.seatGate?.askStarted(refToString(state.actor), instance);
    state.transientAttempts = 0;
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    this.instanceToSession.set(refToString(instance), state);

    // Quality endnotes treat typed / untyped equally; schema endnotes are only typed. Both sections are calculated in the scheduler.
    // Append after inputHash, so the identity is not cached.
    // The schema endnotes of typed ask are forked according to the submit profile: the schema of the mono subagent is already in the tool declaration, and the endnotes are only
    // One sentence; the generic subagent still writes the entire schema into the endnote. The guard runs first: when the static profile does not match this ask, it will
    // Decrease the session to generic (or let ask fail), and what you read below is the corrected form.
    if (message.typed && !ensureSubmitProfileFits(this.deps, this.sink, state, instance, message)) {
      return;
    }
    const input = message.typed
      ? `${message.instructions}${qualityEpilogue(message.schema)}${
          state.submitProfile.kind === "mono" ? TYPED_TOOL_EPILOGUE : schemaEpilogue(message.schema)
        }`
      : `${message.instructions}${qualityEpilogue(undefined)}`;
    // Endnote boundary: This is how the GUI folds endnotes into the disclosure. Instruction text
    // After that, it is all engine text, and the boundary is the text length; the model still receives the full text, as well as the persistent text part.
    // fire-and-forget: Never await turn completion within startAsk (Boundary B contract).
    this.runTurn(state, instance, input, message.instructions.length);
  }

  respondToSubmit(instance: InstanceRef, verdict: EngineSubmitVerdict): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined) return;
    switch (verdict.kind) {
      case "accept": {
        // Mark accept: AskTurnEnded will no longer be reported when the ask's turn resolves (the engine has settledOk).
        state.accepted = true;
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: true });
        return;
      }
      case "reject": {
        // Fixed in the same turn: handler will throw an error when receiving {accept:false} → error tool_result → model retry.
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: false, violations: mapViolations(verdict.violations) });
        return;
      }
      case "nudge": {
        // The turn has ended and there is no parked deferred: Initiate a new turn on the same persistent runtime to promote its submission.
        // nudge Entire text is engine text: border 0.
        this.runTurn(state, instance, NUDGE_PROMPT, 0);
        return;
      }
    }
  }

  cancelAsk(instance: InstanceRef): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined) return;
    // Engine active cancellation (repair/nudge budget exhausted, run canceled/failed): abort the in-flight turn and unblock the submit that may be hung
    // deferred, to avoid permanent blocking of the handler; mark canceled so that turn reject will no longer report askFailed.
    state.cancelled = true;
    const deferred = state.pendingSubmit;
    state.pendingSubmit = undefined;
    deferred?.reject(new WorkflowError("Cancelled", "The ask was cancelled by the engine."));
    // The pending upgrade Q&A has the same treatment as the submit deferred: rejected together, otherwise the `escalate` handler will be in one
    // The canceled ask is permanently blocked. This is the escape hatch of "no answer = indefinite blocking" (no timeout by design):
    // The behavior of run cancel and CLI process death is therefore consistent byte by byte with today - ask rejects Cancelled, run transfers
    // Interrupted, after the resume, the ask is run again, the actor asks the question again and gets a new qid.
    this.withdrawEscalations(state);
    // The waiting re-drive is removed together: the ask has been resolved by the engine, and another round will only burn tokens on a node that no one listens to.
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    state.abortController?.abort(new Error("workflow ask cancelled"));
  }

  /**
   * Resource release after a run settles (the engine calls this exactly once after run-settled, see WorkflowDriver.dispose).
   *
   * For each actor runtime, run the **same** chain the app uses to close a session — `closeBrowserSession` internally does
   * beginShutdown, node_repl session release and browser session close in turn; building a separate subagent-closing chain would
   * drift. It does not close execution / MCP / the session store: subagents do not own them. A session with a turn in flight waits
   * for it to land before being closed (see SessionState.turn); a failed close only warns and never makes settlement throw. All three
   * tables are cleared afterwards.
   *
   * This method is **synchronous**, and deliberately does not wait for in-flight turns — the engine's contract is to release
   * resources immediately after settlement. The price is that "the settlement promise has resolved" does not imply "the aborted turn
   * has finished writing its tail", so at the same time as releasing, each session's in-flight turn is recorded into the quiescence
   * ledger: amend then uses it to judge which session's message count is trustworthy. Both are orchestrated in
   * {@link releaseActorSessions} (the file header of workflow-driver-quiescence.ts carries the full argument).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stallClock.dispose();
    releaseActorSessions(this.deps, this.sessions.values(), this.quiescence);
    this.concurrencyUnsubscribe?.();
    this.sessions.clear();
    this.instanceToSession.clear();
    this.qidToSession.clear();
  }

  /**
   * Settle a parked escalation Q&A (called in by the run service through the registry). The implementation lives in
   * workflow-driver-escalation.ts ({@link respondToParkedEscalation}); this only delegates.
   */
  respondToEscalation(qid: string, answer: string): boolean {
    return respondToParkedEscalation(this.escalationHost, qid, answer);
  }

  /** Withdraw every parked escalation Q&A on a session; the implementation is in {@link withdrawSessionEscalations}. */
  private withdrawEscalations(state: SessionState): void {
    withdrawSessionEscalations(this.escalationHost, state);
  }

  /**
   * World read: the whole thing delegates to {@link executeWorldRead} (workflow-world-read.ts).
   *
   * This only forwards because a world read **shares no state** with the rest of this file: it touches neither actor sessions, nor
   * turns, nor the submit bridge, and needs just three things (two ports plus a cwd). Split out, this file is left with the single
   * job of "orchestrating sessions and turns", while op arity, cap enforcement and the fixed argv for git live in one place.
   */
  async executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    return await executeWorldRead(this.deps, op, args);
  }

  /**
   * Publishing user-facing artifacts: the whole thing delegates to {@link executeArtifactPublish} (workflow-artifact-publish.ts),
   * for the exact same reason as the world read above — it shares no state with this file and needs only two ports, a cwd and
   * a session id.
   *
   * The method is **optional** on Boundary B (`executeArtifactPublish?`), yet this driver always implements it: "is there a store"
   * is an assembly fact, expressed by `artifactStore` in deps and failing loudly on that side, and it should not be expressed a
   * second time through the "is the method there" channel (two channels would give the same thing two failure shapes).
   */
  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    return await executeArtifactPublish(this.deps, request);
  }

  // ———————————————————————————————— Internal: turn arrangement ——————————————————————————————

  private runTurn(
    state: SessionState,
    instance: InstanceRef,
    input: string,
    epilogueStart: number,
  ): void {
    const abortSignal = state.abortController?.signal;
    state.turnGeneration++;
    state.turn = state.runtime
      .executeTurn(input, undefined, {
        ...(abortSignal ? { abortSignal } : {}),
        epilogueStart,
      })
      .then(
        (result) => this.onTurnResolved(state, instance, result),
        (error) => this.onTurnRejected(state, instance, error),
      );
  }

  private onTurnResolved(state: SessionState, instance: InstanceRef, result: TurnResult): void {
    // The order and load of the two reports parsed by a turn (progress precedes usage) are in reportTurnObservations.
    reportTurnObservations(this.sink, state, instance, result);
    if (this.deps.actorTranscriptStore === undefined) {
      // No transcription access plane: the original synchronization path, not a single await is required (boundary accounting is completely absent, see the deps field comment).
      this.reportTurnOutcome(state, instance, result);
      return;
    }
    void this.settleExchange(state, instance, result);
  }

  /**
   * Report the outcome of a turn and answer "is this ask's exchange over".
   *
   * There is only one road besides accept: hand the final text to the engine (typed → a nudge or an exhausted failure; untyped → settle
   * accordingly). On a nudge the engine starts a brand new turn via respondToSubmit **within this call stack**, so turnGeneration
   * changes — which is exactly the criterion for "the exchange is not over yet" (repair rounds are not in this class: they live in
   * the same turn, so this method is never even called for them).
   */
  private reportTurnOutcome(
    state: SessionState,
    instance: InstanceRef,
    result: TurnResult,
  ): boolean {
    // Submitted and accepted by the engine: ask has been settled, the end of the turn is just confirmation, and askTurnEnded will no longer be reported.
    if (state.accepted) return true;
    const generation = state.turnGeneration;
    this.sink.askTurnEnded(instance, result.response);
    return state.turnGeneration === generation;
  }

  /**
   * The wrap-up of one exchange: count messages → report the outcome → if the exchange really is over, write that boundary into the
   * ask's journal row.
   *
   * **Count first, report second** — the order is load-bearing: once reported, the engine may immediately dispatch this actor's
   * next ask on the same session (per-actor FIFO only guarantees serialization, not a gap in between), and that round's messages
   * land in the same session, inflating this count. Counting first means what is read is the length at the moment this exchange ended.
   */
  private async settleExchange(
    state: SessionState,
    instance: InstanceRef,
    result: TurnResult,
  ): Promise<void> {
    const boundary = await countSessionTranscript(this.deps, state, instance);
    const ended = this.reportTurnOutcome(state, instance, result);
    if (!ended || boundary === undefined) return;
    journalAskMessageBoundary(this.deps, state, instance, boundary);
  }

  private onTurnRejected(state: SessionState, instance: InstanceRef, error: unknown): void {
    // If turn dies, no one will read the tool results anymore: the parked upgrade questions and answers must be removed together, otherwise they will remain there forever.
    // In the pendingQuestions of the snapshot, ask the master agent to answer a question that has no listeners.
    this.withdrawEscalations(state);
    if (state.cancelled || isTurnCancelled(error)) {
      // Engine-initiated abort: The engine has settled the ask, and the driver will not report it again.
      return;
    }
    // Model-side errors are contained in workflow-driver-model-failure.ts (policy table judgment stop/context_exceeded/
    // Transient redrive); it is not a model layer error but a driver side failure.
    if (handleModelTurnFailure(this.modelFailureHost, state, instance, error)) return;
    this.sink.askFailed(instance, toWorkflowError(error));
  }

  // ———————————————————————————————— Internal: Upgraded Q&A Bridge ——————————————————————————————

  /**
   * Create a session-level escalation port; the implementation is in workflow-driver-escalation.ts ({@link makeSessionEscalatePort}),
   * which also carries the point-for-point symmetric argument with {@link makeSessionSubmitPort}.
   */
  private makeEscalatePort(
    sessionId: SessionId,
    actor: ActorRef,
    persona: PersonaSpec,
  ): WorkflowEscalatePort {
    return makeSessionEscalatePort(this.escalationHost, sessionId, actor, persona);
  }

  /**
   * Landing one driver-side event on both tracks: durable into `dwf_event`, live fanned out through emit.
   *
   * Byte-for-byte the same shape as the engine's `record()` (engine.ts), and the order cannot be swapped: the launch-side sequence
   * capture relies on "emit follows appendEvent immediately and synchronously, with the same event object reference" to hand the
   * just-allocated sequence to emit (createJournalSequenceCapture in dynamic-workflow-run-launch.ts).
   */
  private record(event: RunEvent): void {
    this.journal.appendEvent(this.deps.runId ?? "run", event);
    this.emit(event);
  }
}

/**
 * Build a driver factory with deps bound, serving directly as the harness's makeDriver. The journal and emit come from deps,
 * and the caller (tests/production) holds references to them for assertions and Boundary C fan-out.
 */
export function createAgentRuntimeWorkflowDriver(
  deps: AgentRuntimeWorkflowDriverDeps,
): (sink: WorkflowReportSink) => WorkflowDriver {
  return (sink) => new AgentRuntimeWorkflowDriver(deps, sink);
}

export { mintActorSessionId } from "./workflow-driver-helpers.js";
export type { ActorRuntimeFactory } from "./workflow-driver-types.js";
