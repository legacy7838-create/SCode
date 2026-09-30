// ============================================================
// AgentRuntime-backed WorkflowDriver: Shared Type
// ============================================================
// workflow-driver.ts reaches the upper limit of oxlint max-lines (400 lines), and adds the driver’s dependency package
// (AgentRuntimeWorkflowDriverDeps), runtime factory signature (ActorRuntimeFactory) and each actor session
// The running state (SessionState) is split into this file for workflow-driver.ts / workflow-driver-escalation.ts /
// workflow-driver-helpers.ts is shared among three places; the public side (ActorRuntimeFactory) is still exported from workflow-driver.ts.
// There are only types, zero runtime code.

import type {
  ExecutionPort,
  FileSystemPort,
  Logger,
  ModelRequestAdmission,
  SessionId,
  SubmitVerdict as ContractsSubmitVerdict,
  ToolArtifactStorePort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type {
  ActorSubmitProfile,
  ActorRef,
  ActorSessionSeed,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  SessionRef,
} from "@zcode/dynamic-workflow";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { ActorModelActivity, WorkflowClock } from "./workflow-driver-concurrency.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

/** An externally settleable promise. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Actor runtime factory: given a session id / actor / persona / session-level submit port, it produces a fully assembled child AgentRuntime.
 * Injecting a submitPort registers the submit_result tool for that session (core's registration gate keys off the port's presence).
 *
 * Extracting "how to build a runtime" as an injection point: production wraps createScriptWorkflowAgentRuntime (carrying the real
 * model adapter and the full set of deps); tests use a minimal deps bag plus a scripted model adapter. The driver body itself
 * only handles lifetime and bridging.
 *
 * Returning a Promise is allowed: production has to persist the actor session and create the task link before returning, and `session_task_link.child_session_id`
 * has an FK to `session(id)`, so "create the session row" must come before "create the link". The engine's ensureSession awaits
 * createActorSession, so awaiting here is naturally safe — by the first ask's dispatch, the session is already persisted.
 */
export type ActorRuntimeFactory = (input: {
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   * This actor's submit profile. The factory decides which submit_result to register from it: `untyped` → **do not** inject a submitPort
   * (core's registration gate is the port's presence, so there is no tool); `mono` → inject the port + `workflowSubmitSchema` (a typed
   * declaration); `generic` → inject only the port (today's generic declaration). The driver looks it up by actor site from
   * deps.actorSubmitProfiles; absent means generic.
   */
  submitProfile: ActorSubmitProfile;
  /**
   * Session-level escalation port. Its injection is exactly isomorphic to submitPort: the port's presence registers the
   * `escalate` tool for that session (core's registration gate keys off the port's presence), and it is **always injected, never
   * opt-in** — the actor most likely to hit an unforeseen wall is precisely the one the author did not mark.
   */
  escalatePort: WorkflowEscalatePort;
  /**
   * Session seed for amend-resume, present only when this actor consumed at least one imported ask entry.
   *
   * The factory needs exactly one thing from it: `resolvedModel` is the **model pin resolved by the predecessor**, and it must
   * override tier re-resolution just like a pin in the journal does (silently swapping models under a transcript continuation is
   * exactly the identity mutation the pin exists to prevent). Copying the transcript itself is not the factory's job — that is what the driver does **after** the factory returns (the session row has to exist first, `message.session_id` has an FK to `session(id)`).
   */
  seed?: ActorSessionSeed;
  /**
   * Model-request admission port for this actor's runtime: present only when the driver has a governor port;
   * the factory places it in the runtime deps as `modelRequestAdmission`, and the runner passes through it before
   * every model request attempt. Absent means that runtime is not gated.
   */
  modelRequestAdmission?: ModelRequestAdmission;
}) => AgentRuntime | Promise<AgentRuntime>;

/** The dependencies needed to construct an AgentRuntime-backed driver (journal and emit are provided and owned by the caller / harness). */
export interface AgentRuntimeWorkflowDriverDeps {
  journal: JournalStorePort;
  emit: (event: RunEvent) => void;
  /** The filesystem port that world-read (files.glob / files.read / files.grep) lands on. */
  fileSystemPort: FileSystemPort;
  /**
   * The subprocess execution port that `git.*` world-reads land on (cwd = the workspace root).
   *
   * **Required rather than optional**: optional would open up a silently degraded runtime path — `git.*` works in production but
   * quietly becomes "not a git repository" in some assembly where nobody remembered to wire it, and those two failures look
   * exactly the same inside a script. Better to let the wiring error show up at compile time (this is also what the package already does for fileSystemPort).
   */
  executionPort: ExecutionPort;
  /**
   * The parking registry for escalation questions. The driver registers parked questions here, and the run service's `resolveQuestion`
   * feeds answers back through the same table.
   *
   * **Required rather than optional**, for the same reason as executionPort above: optional would open up a silently degraded runtime
   * path — without the table, `escalate` either hangs forever (the worst case) or silently degrades into "this capability does not
   * exist", which looks exactly like "the author gave this actor no escalation rights" in the model's eyes. Better to let the wiring error show up at compile time.
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /** The base directory for path resolution shared by world-read and artifact publishing (the workspace root). */
  cwd: string;
  /**
   * Where the bytes of user-facing artifacts (`artifact.file` / `artifact.markdown`) land. ⚠ The artifact here is the
   * **output delivered to the user**, not the engine-internal artifact (the top-level return value of `RunSettlement.artifact`,
   * which is for the model's eyes).
   *
   * **Optional**, by the same argument as `actorTranscriptStore`: an assembly without a store (pure replay, fake driver,
   * minimal stub) has nowhere to put the bytes in the first place. Absence is **not a silent degradation** — a content
   * member rejects the node with a named `ArtifactStoreUnavailable` (the script can catch it, the node lands in the
   * journal as failed), instead of falling back to writing the workspace, and instead of publishing an empty
   * artifact. Preseeded members (chart/table/…) are unaffected: they are declarations and never go through the driver.
   */
  artifactStore?: ToolArtifactStorePort;
  /**
   * The parent session id of this run, used **only** by artifact publishing: the store accounts for writes per session
   * scope (`zcode-artifact://<session>/<id>`), and that scope is the parent session.
   *
   * It appears together with `artifactStore` (the production assembly supplies both from the run service, both from
   * the same app session); when only half is given, publishing fails loudly with `ArtifactStoreUnavailable` as well, see
   * {@link ArtifactPublishDeps}. Actor session ids do not go through this field — those are minted by mintActorSessionId.
   */
  parentSessionId?: SessionId;
  /**
   * The approved command set for world.run (collected as compile-time literals). Structurally lands in
   * {@link WorldReadDeps}: absent means world.run denies everything (fail-closed).
   */
  declaredRunCommands?: ReadonlySet<string>;
  /**
   * The submit profile for each actor site, computed at compile time by `deriveActorSubmitProfiles` (the
   * compileOnce of the run submission path). Optional: absent = every actor is generic (legacy behavior), so
   * assemblies that are not about profiles (snippets, fake driver, existing tests) stay untouched.
   */
  actorSubmitProfiles?: ReadonlyMap<string, ActorSubmitProfile>;
  runtimeFactory: ActorRuntimeFactory;
  /**
   * The narrow port for the process-wide concurrency governor. When present the driver gives each actor
   * runtime a `ModelRequestAdmission` (handed down through the runtimeFactory argument into the runtime deps):
   * **every** model request attempt from the runner passes the gate first; and it subscribes to cap changes
   * for this run and fans them out as `concurrency-changed`. Absent means actors are not gated (fake / pure-replay
   * assemblies need zero changes). The engine side is unaware of this (v1's `acquireSlot` was removed).
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   * The seat gate for this run: when this run's **own** concurrency bound is lowered mid-flight, the excess subagents stop before
   * the next turn step. When present the driver does two things — wrap each actor's admission port with the gate, and feed the start
   * and end of asks to it (startAsk and the engine's `node-settled`, see workflow-driver.ts).
   *
   * Optional: absent means this run's bound never changes mid-flight (e.g. a snippet assembly without dynamic concurrency
   * adjustment), and the admission port is exactly as it was before. **Being present also does not change the behavior of a run
   * whose bound was never lowered**: requests above the bound pass straight through, the gate emits no events and holds no
   * tickets.
   */
  seatGate?: WorkflowRunSeatGate;
  /**
   * The transcript read/write surface for actor sessions (production is the session store itself). Two purposes share it, and they **must**
   * be the same one: the counts for ask boundary accounting and the copy for seed truncation (see the module notes in workflow-actor-transcript.ts).
   *
   * Optional, because an assembly without session storage (pure replay tests, minimal stub runtime) has no transcripts to count in the first
   * place: when absent, boundary accounting is absent as a whole, at the cost that **this run can no longer act as the predecessor of
   * an amend** (the service-side gate that "rejects any predecessor without a marker" will stop it), rather than a wrong boundary. Creating
   * a session with a seed, on the other hand, fails loudly when it is absent — the engine has already decided from the import fact that a transcript must be continued, so having no read/write surface then is a wiring error.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
  /**
   * The id of this run. Actor session ids are scoped by it — a scheme without runId would make the same site×ordinal actor of two
   * concurrent runs collide into the same session id (`createSessionId("wf-actor-" + refToString(actor))` is exactly that bug). The
   * default "run" exists only so that existing test assemblies are not broken.
   */
  runId?: string;
  /**
   * Clock and timers: the run-level stall clock, the re-drive of transient failures after a backoff, and the bounded wait for
   * session quiescence all use it. Injectable clocks are supported; `stallAfterMs` defaults to 20 minutes; `quiesceMs` defaults
   * to {@link AMEND_TRANSCRIPT_QUIESCE_MS}; `random` supplies backoff jitter.
   */
  clock?: WorkflowClock & {
    stallAfterMs?: number;
    quiesceMs?: number;
    random?: () => number;
  };
  /**
   * Hands out this driver's **session quiescence probe** (workflow-driver-quiescence.ts). Called exactly once at construction, and the
   * caller attaches the probe to its own run's registry entry — amend continuation asks it before the in-flight ask proceeds.
   *
   * A callback is used rather than having `createAgentRuntimeWorkflowDriver` return a tuple: the driver instance is only created by the
   * **engine** at `makeDriver(sink)`, and the assembly side cannot get hold of that return value. Absent means the caller does not
   * care about quiescence (e.g. a path that uses the harness directly).
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
}

/**
 * The runtime state of an actor session. per-actor FIFO (guaranteed by the engine) → at most one in-flight ask per session, so
 * currentInstance / pendingSubmit / accepted / cancelled are all "current instance" semantics and need no per-instance refinement.
 */
export interface SessionState {
  readonly ref: SessionRef;
  /** The same value as `ref.id`, only the branded type is preserved (the transcript read/write surface fetches by SessionId). */
  readonly sessionId: SessionId;
  readonly runtime: AgentRuntime;
  /**
   * The shape of submit_result actually registered for this session. Taken from the static profile at creation; the **only**
   * path that ever changes it is the runtime guard (ensureSubmitProfileFits in workflow-driver.ts): when the mono declaration does
   * not fit the actual ask's schema, it downgrades to generic and is never upgraded back.
   */
  submitProfile: ActorSubmitProfile;
  /** The instance of the currently in-flight ask; set by startAsk. */
  currentInstance?: InstanceRef;
  /** Whether the current ask is typed (untyped does not go through the submit bridge). */
  currentTyped: boolean;
  /** The adjudication deferred that the submit_result handler blocks on; at most one (a single prior instance). */
  pendingSubmit?: Deferred<ContractsSubmitVerdict>;
  /**
   * The escalation questions currently parked, keyed by qid. Unlike pendingSubmit, this **must** be multiple: within one turn the model
   * can issue several escalate tool calls in parallel, each an independent question (the ceiling is governed by escalationsUsed).
   */
  readonly pendingEscalations: Map<string, Deferred<string>>;
  /**
   * The escalations used up by this ask (the ones short-circuited by the ceiling do not count — see makeEscalatePort). A per-ask
   * count, zeroed by startAsk; nudge rounds do **not** zero it (a nudge is still inside the same ask).
   */
  escalationsUsed: number;
  /** The turn cancellation controller for the current ask; rebuilt by startAsk for every ask. */
  abortController?: AbortController;
  /** The current ask has been accepted by the engine: askTurnEnded is no longer reported when its turn resolves (the engine already settled it). */
  accepted: boolean;
  /** The current ask was cancelled by the engine: askFailed is not reported on turn reject (the engine has already settled failed/cancelled). */
  cancelled: boolean;
  /**
   * The turn rounds started on this session. It has exactly one use: to tell whether the engine **started another round** after
   * `askTurnEnded` (that is the path a nudge takes), and thereby whether this ask's exchange really ended — boundary accounting wants
   * the end of the whole exchange, not the end of an arbitrary turn.
   */
  turnGeneration: number;
  /**
   * The teardown chain of the currently in-flight turn (executeTurn together with onTurnResolved / onTurnRejected). It has one
   * reader: dispose has to let it land before closing the runtime — on the accept path the askStats arrive only after settle (the turn
   * resolves only after the submit), so closing synchronously would race this tail.
   */
  turn?: Promise<void>;
  /**
   * The model activity surface of this actor: the admission port plus session event observation (the source of the waiting / executing badges).
   */
  modelActivity: ActorModelActivity;
  /** The actor identity of this session (ProviderStop details name the subagent that triggered the stop). */
  readonly actor: ActorRef;
  readonly actorName: string | undefined;
  /**
   * The number of driver-side transient re-drives in the current ask: a transient failure let through by the runner (stream recovery
   * exhausted, etc.) does not settle the node and starts another round on the backoff curve. startAsk zeroes it.
   */
  transientAttempts: number;
  /** The re-drive alarm while waiting out a backoff; cancelAsk / dispose clears it. */
  cancelRedrive?: () => void;
}
