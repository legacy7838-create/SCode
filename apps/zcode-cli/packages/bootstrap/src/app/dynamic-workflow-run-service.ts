// ============================================================
// Dynamic Workflow Run Service (production implementation of DynamicWorkflowRunPort)
// ============================================================
// This service is responsible for:
// Compile once → register AbortController → start the engine (fire-and-forget, the execution body is
// dynamic-workflow-run-launch.ts) → Put the observation surface of run (snapshot/wait/cancel/restore/enumerate/
// Event paging) is handed over through the narrow port.
//
// There are seven invariants. Violation of any one of them will be expressed in a way that is "far away from the cause", so it is written in the file header:
//
//   1. **Engine exclusive createRun**. This service never pre-inserts dwf_run lines. The pre-existing line will flip the engine constructor into
//      resume branch (engine.ts): node count is recalculated based on completed records, budget is restored from records, status is
//      updateRunStatus Override. A brand new run will not report an error when taking the resume branch, but will only silently start from an empty journal.
//      "recover". resume, in turn, relies on this mechanism: it relaunches the existing runId, allowing the engine to hit
//      Already existing row. The two entrances are in opposite directions and never share a door.
//   2. **Compile exactly once**. A ts.Program feeds site tables, schema synthesis and lowering at the same time; scriptHash is provided by
//      This service does not count (harness intentionally does not count - if it hashes "the text it sees", the lowered path will be stored in the library)
//      The hash of lowered function body, the comparison object of resume verification is silently wrong).
//   3. **This service will not be constructed without a journal**. Durability is a prerequisite for run: a run that silently loses persistence
//      Worse than no run (resume has no evidence, details page has no source, and there is no record after cancellation). When narrowing fails
//      The caller of {@link createDynamicWorkflowRunService} gets undefined, so CreateWorkflow
//      Back to the placeholder diagnostic path - this is a visible degradation, not a broken feature.
//   4. **Converge the orphan run of this session when constructing, and only converge the ** of this session. See {@link reconcileOrphanRuns}:
//      The `running` line left by the dead process can only be determined at this moment, and "this session" is the only safe scope.
//      Convergence is written as `stopped(interrupted)` (with `Interrupted` failure code), which is recoverable like other stops.
//   5. **resume first replaces the registry entries and then starts**. `waitForTask` returns directly to the runId that is not in the registry
//      Journal snapshot - the entry is one step later, and the heavy-arm notification watcher will immediately settle against the old final state.
//   6. **Register as a resident blocking job in the same sync slice that is started every time**. The engine is a closure of the parent session App and does not enter
//      runtime task registry; the resident pool therefore only sees "registry retired" and replaces the ones with the flying engine
//      The App is closed by pressing idle (10 minutes), and resume starts the second engine. There is only one registration point——
//      {@link trackSettlement}, shared by submit / amend / resume - counting in the same sync slice of launch
//      Added, finally released at settlement.
//   7. **close stops every run it owns, and that transaction is written by the engine itself**. When the App is closed, the service will be
//      `"interrupted"` abort each in-flight entry and wait for them to settle (not timeout, not polling), harness
//      This reason is normalized to `engine.stop("interrupted", Interrupted)`, so the normal finishRun of the engine is executed
//      The tail is completed as `stopped(interrupted)` which can be resumed. service never writes its own final line: bypassing the engine and writing it, it will
//      Create a second writer of dwf_run (same argument as invariant 1), and there will be no corresponding run-settled in the journal.
//      After closing, submit / amend / resume is thrown directly - the closing gate of the resident pool has blocked the command, and here is
//      Wrong wiring, contracts' rejection enum should not be allowed to widen for it (same argument as invariant 1).

import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import type {
  TraceContext,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunArtifactItemPage,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
  DynamicWorkflowRunEventPage,
  DynamicWorkflowResolveQuestionResult,
  DynamicWorkflowRunPort,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
  DynamicWorkflowRunSessionSummary,
  DynamicWorkflowRunSnapshot,
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunCancelInitiator,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
  ExecutionPort,
  FileSystemPort,
  Logger,
  SessionId,
  ModelRequestAdmission,
  ModelSelection,
  ToolArtifactStorePort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { WORKFLOW_RUNS_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type {
  ActorSubmitProfile,
  ActorRef,
  Caps,
  JournalStorePort,
  PersonaSpec,
} from "@zcode/dynamic-workflow";
import { toProtocolEvent } from "./dynamic-workflow-run-launch.js";
import { readWorkflowArtifactBytes } from "./dynamic-workflow-run-artifact-read.js";
import { replayRunProgress } from "./dynamic-workflow-run-replay.js";
import { listArtifactItemsFrom } from "./dynamic-workflow-run-artifact-queries.js";
import {
  supportsRunEnumeration,
  supportsRunIntrospection,
  type DynamicWorkflowTaskLinkStore,
} from "./dynamic-workflow-run-journal.js";
import { createRunIntrospectionMethods } from "./dynamic-workflow-run-introspection.js";
import { reconcileOrphanRuns } from "./dynamic-workflow-run-reconcile.js";
import {
  resumeDynamicWorkflowRun,
  amendDynamicWorkflowRun,
  submitDynamicWorkflowRun,
  type DynamicWorkflowRunEntryContext,
} from "./dynamic-workflow-run-submit.js";
import {
  listWorkspaceNodesFrom,
  readWorkspaceNodeResultFrom,
} from "./dynamic-workflow-run-workspace.js";
import {
  artifactsOf,
  settleOrAbort,
  snapshotOf,
  toSessionSummary,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import {
  createRunServiceLifecycle,
  type DynamicWorkflowRunSettledNotice,
} from "./dynamic-workflow-run-lifecycle.js";
import { retuneRunConcurrency } from "./dynamic-workflow-run-retune.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import {
  clampRunConcurrency,
  resolveWorkflowConcurrencyCeiling,
} from "./workflow-concurrency-ceiling.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";
import {
  createWorkflowEscalationRegistry,
  type WorkflowEscalationRegistry,
} from "./workflow-escalation-registry.js";

/** Default/limit count for listRunsForSession (the enumeration surface is bounded, it never scans the store without limit). */
const DEFAULT_LIST_RUNS_LIMIT = 16;
const MAX_LIST_RUNS_LIMIT = 64;

/** Input to the actor runtime factory. runId is inside it because both the session id and the task link are run-scoped. */
export interface DynamicWorkflowActorRuntimeInput {
  runId: string;
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   * This actor's submit profile: `untyped` injects no
   * submitPort (no tool), `mono` injects the port plus a typed declaration, `generic` injects only the port. The factory is the single
   * landing point of this mapping (the same seam as the fixed disallowlist on the subagent tool surface).
   */
  submitProfile: ActorSubmitProfile;
  /**
   * The session-level escalation port: injecting it registers the `escalate`
   * tool for that actor's session, structurally identical to submitPort. **Always present**, never opt-in -- the actor most likely to
   * hit an unforeseen wall is exactly the one the author did not mark.
   */
  escalatePort: WorkflowEscalatePort;
  /**
   * The model this actor resolved to last time (the `resolvedModel` in the journal, `providerId/modelId`),
   * and only a resume carries it. When there is no {@link DynamicWorkflowActorRuntimeInput.runSubagentModel}, the factory
   * must adopt it ahead of the parent session model: see the reasoning behind the pin in `workflow-actor-model.ts` (the persistence
   * half of the persona freeze invariant).
   */
  pinnedModel?: string;
  /**
   * This run's own subagent model (the `subagent_model` of `CreateWorkflow` / `AmendWorkflow`, parsed back
   * from the journal's `run-launched` event). The whole choice, reasoning tier included.
   *
   * It has the **highest** priority, above {@link DynamicWorkflowActorRuntimeInput.pinnedModel} and the parent session model
   * (`workflowActorModelPolicy` in workflow-actor-model.ts): this one is the user's explicit
   * statement about this particular run, while the pin only guards the implicit default when it is absent. It governs subagents only and never the main agent. Absent means the run executes on the pin or the session model.
   */
  runSubagentModel?: ModelSelection;
  /**
   * The model request admission port of this actor runtime:
   * the driver supplies it when the governor port is present; the factory puts it into the runtime deps as is. Absent means no gate constraint applies.
   */
  modelRequestAdmission?: ModelRequestAdmission;
}

export interface DynamicWorkflowRunServiceDeps {
  /** The durable journal (the dwf_* tables). Without it this service is not constructed; see invariant 3 in the file header. */
  journal: JournalStorePort;
  /**
   * Resolution of the launch anchor: yields the inputId of the parent runtime's active turn at the
   * moment of submit; it gives back `undefined` when `trace.turnId` disagrees with the active turn or there is no active turn (the submit side mints a fallback value).
   * Absent means the host has no concept of a "current turn" (CLI, test wiring).
   */
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  /**
   * The parent session id of this service instance (= this app's session, see create-app.ts).
   *
   * It is the **scope for orphan convergence and enumeration**, so it is not optional: without it only two paths remain -- a global sweep (which would mark an in-flight run of a
   * sibling session in the same process as dead, since both share the same sqlite and each keeps its own in-memory registry) or no convergence at all
   * (which is exactly the "run stays in running forever" bug). Better to let a wiring mistake surface at compile time.
   */
  parentSessionId: string;
  /** The filesystem port that world-read (files.glob / files.read / files.grep) lands on. */
  fileSystemPort: FileSystemPort;
  /** The subprocess execution port that git.* world-read lands on (cwd = the run's workspace). */
  executionPort: ExecutionPort;
  /**
   * The byte landing spot for user-facing artifacts (`artifact.file` / `artifact.markdown`), handed to the driver as is. ⚠ Here artifact means the **output delivered
   * to the user**, not the top-level return value inside the engine.
   *
   * **Optional**: an assembly without a store (tests, a minimal stub) can still run a run as before, only content members will reject with a named
   * `ArtifactStoreUnavailable` -- a failure a script can catch, not a silent degradation. The session scope
   * is this service's own {@link DynamicWorkflowRunServiceDeps.parentSessionId} (= this app's session,
   * that is, the parent session).
   */
  artifactStore?: ToolArtifactStorePort;
  /** Builds a child AgentRuntime for an actor (production wraps createScriptWorkflowAgentRuntime). */
  createActorRuntime: (input: DynamicWorkflowActorRuntimeInput) => AgentRuntime;
  /** The persistence surface for an actor session's task link; when absent, link creation is skipped (the session itself is still persisted). */
  taskLinkStore?: DynamicWorkflowTaskLinkStore;
  /**
   * The transcript access surface of an actor session (in production the session store itself). The driver uses it for two things: the counting behind
   * ask boundary accounting, and the truncated copy of a divergent actor's transcript on amend-resume.
   *
   * When absent, boundary accounting is absent as a whole -- the run still finishes, it just **can no longer serve as the predecessor of a revision** (the service's
   * "reject outright when there is no marker predecessor" gate will stop it). It is optional rather than required because an assembly without session storage has no transcript
   * to count in the first place; seeded session creation fails loudly from the driver when it is absent.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  /**
   * The engine event hook: what it hands over is an **already prepared session event payload** (a bounded payload + the journal sequence +
   * two derived fields), and the caller is only responsible for appending it to the parent session (create-app wires the runtime's record method).
   *
   * Why this service prepares it instead of letting the caller assemble it: the sequence and spentTokens can only be read from the journal,
   * and the journal is a dependency of this service; the actor session id can only be computed by the function that minted it. Pushing these three things onto
   * the caller amounts to copying three contracts into a layer that has no journal.
   *
   * The second argument is **routing** information, deliberately kept apart from the payload: `parentSessionId` decides which session the event should land in,
   * but it is not part of the payload itself (the event is already in that session, storing another copy is redundant). Callers use it for the identity gate,
   * see {@link createDynamicWorkflowRunProgressSink}.
   */
  onRunEvent?: (
    progress: DynamicWorkflowRunProgressPayload,
    routing: { parentSessionId?: string },
  ) => void;
  logger?: Logger;
  /** Injected concurrency probe, so the caps default tests can pin a dual-core machine (the floor must be 1). */
  availableParallelism?: () => number;
  /**
   * The narrow port of the process-level concurrency governor. Handed to the driver as is:
   * effective concurrency = min(this run's caps.maxConcurrency, the shared live cap of that provider key). Absent means only
   * the per-run upper bound applies (test wiring, hosts without a governor).
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   * Registers one launch as the parent runtime's **resident blocking work**.
   *
   * The engine lives in the session App's closure and never enters the runtime task registry, while the resident pool back then
   * only read the registry -- a still-running run was read as idle, the App got closed, and resume started a second engine. Registration goes
   * through the runtime's single entry point (`trackResidencyBlockingWork`), so the resident pool no longer has to guess about the sidecar.
   *
   * Absent means the host has no residency concept (one-shot CLI execution, test wiring): the run finishes as usual, it just does not block shutdown.
   */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /**
   * The driver's clock and timers: both the run-level
   * stall clock and the backoff re-drive of transient failures read it. **Injected for tests only** (the failure matrix shrinks the 2s->60s re-drive curve and the
   * 20-minute stall window down to milliseconds); production wiring never sets it, and when absent the driver uses real time.
   */
  driverClock?: AgentRuntimeWorkflowDriverDeps["clock"];
}

export {
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
  supportsRunIntrospection,
  type DynamicWorkflowTaskLinkStore,
} from "./dynamic-workflow-run-journal.js";

/**
 * The full surface of this service: {@link DynamicWorkflowRunPort} (used by the engine / tool layer) plus two **session-level** lifecycle
 * read surfaces. The sole consumer of the latter is the host's provider registry safety boundary:
 * subagents share the parent session's live adapter, and an in-flight run is a stretch of active Loop in the parent session --
 * a registry replace has to wait for it to settle.
 */
interface DynamicWorkflowRunService extends DynamicWorkflowRunPort {
  /** The number of runs that have still not settled at this moment (entries in the registry with `terminal === undefined`). */
  countLiveRuns(): number;
  /**
   * Subscribe to settlement: each run notifies exactly once after it reaches a terminal state (completed / errored / stopped, including a pre-launch failure),
   * with the bookkeeping already done (the count has already been decremented by it). Returns the unsubscribe function. A listener that throws is only logged and does not affect settlement.
   */
  subscribeRunSettled(listener: (notice: DynamicWorkflowRunSettledNotice) => void): () => void;
  /**
   * Stops every in-flight run this service owns and waits for them to settle (invariant 7 in the file header). **Not on the contracts'
   * {@link DynamicWorkflowRunPort}**: it is a lifecycle action of the host App, not a capability of the engine and tool layer.
   * Idempotent -- a second call returns the same promise and aborts nothing further.
   */
  close(): Promise<void>;
}

/**
 * Builds the workflow run service. Returns {@link DynamicWorkflowRunService}: the port implementation plus the two session-level
 * lifecycle read surfaces (the in-flight run count, the settlement subscription), and the latter stay off the narrow contracts port -- they serve
 * the host's registry safety boundary, not the engine and tool layer.
 */
export function createDynamicWorkflowRunService(
  deps: DynamicWorkflowRunServiceDeps,
): DynamicWorkflowRunService {
  const runs = new Map<string, RunRegistryEntry>();
  /**
   * The resident table of escalation questions. **One table, spanning every in-flight run under this service**:
   * a globally unique qid is exactly for this -- `resolveQuestion` takes a single opaque token, and with several runs in flight letting the model pair
   * `(runId, qid)` up by itself is a breeding ground for mismatches. Purely in memory, sharing the fate of the resident deferred (cleared the moment the process dies, self-healing
   * because the actor asks again after resume; persisting a pending table would only tell lies).
   */
  const escalations: WorkflowEscalationRegistry = createWorkflowEscalationRegistry();

  // Structure means convergence: Nothing under this instance is running at the moment, so the non-terminal lines of this session are the relics of the dead process.
  // See header invariant 4 with {@link reconcileOrphanRuns}.
  reconcileOrphanRuns(deps);

  /**
   * The concurrency ceiling of this process.
   * The very same implementation as the governor's per-bucket ceiling at process level: the run upper bound and the bucket ceiling always line up.
   *
   * It has four readers inside this service, all of them going through this one function: the caps starting point of a new run, the
   * {@link DynamicWorkflowRunPort.concurrencyCeiling} on the port (the tool layer clamps against it and decides whether a "value is not worth reporting"),
   * the `maxConcurrency` criterion of the two read surfaces, and the derived field on the `run-started` payload.
   */
  const concurrencyCeiling = (): number =>
    resolveWorkflowConcurrencyCeiling(deps.availableParallelism);

  // caps only contains the concurrency upper bound and no wall clock timeout; cancellation is the only means of stopping.
  // The upper bound **starts from the ceiling** and can only be lowered by requests and never raised——
  // Absence is the ceiling, and if it is given, it reaches [1, ceiling].
  const caps = (requested?: number): Caps => {
    return { maxConcurrency: clampRunConcurrency(requested, concurrencyCeiling()) };
  };

  // The introspection interface is connected according to the capability detection (those four queries are not on the engine port). In their absence, the following two optional members are not implemented at all:
  // The consumer's `typeof port.listRuns === "function"` detection is therefore false and the tool layer normalizes it to
  // The business failure of "this session does not have this capability" - rather than a silent empty list.
  const introspection = supportsRunIntrospection(deps.journal) ? deps.journal : undefined;

  // The implementation of life cycle bookkeeping (settlement/closing/closing the gate/external final state lines leaving traces; file header invariants 6 and 7) is in
  // dynamic-workflow-run-lifecycle.ts: They only borrow the registry and journal here and pass them through narrow dependencies.
  const {
    countLiveRuns,
    subscribeRunSettled,
    trackSettlement,
    close,
    assertOpen,
    noteForeignTerminalRow,
  } = createRunServiceLifecycle({
    journal: deps.journal,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    parentSessionId: deps.parentSessionId,
    ...(deps.registerResidencyBlockingWork === undefined
      ? {}
      : { registerResidencyBlockingWork: deps.registerResidencyBlockingWork }),
    runs,
  });

  // The implementation of the two entries (submit / resume) is in dynamic-workflow-run-submit.ts: they only borrow from here
  // The registry, docking table, caps and settlement bookkeeping are passed explicitly through ctx, and those two paragraphs will not be copied in this document.
  const entryContext: DynamicWorkflowRunEntryContext = {
    deps,
    runs,
    escalations,
    caps,
    trackSettlement,
  };

  return {
    countLiveRuns,
    subscribeRunSettled,
    close,

    // Closed door with three entrances. `async` just turns this wiring error into a rejection rather than a synchronous throw; the gate is related to the subsequent
    // There is no await between delegates, so the "register and launch the same synchronization slice" of invariant 6 is not affected.
    async submit(
      request: DynamicWorkflowRunSubmitRequest,
    ): Promise<DynamicWorkflowRunSubmitResult> {
      assertOpen();
      return submitDynamicWorkflowRun(entryContext, request);
    },

    async amend(request: DynamicWorkflowRunAmendRequest): Promise<DynamicWorkflowRunAmendResult> {
      assertOpen();
      return amendDynamicWorkflowRun(entryContext, request);
    },

    /**
     * The concurrency ceiling of this process (for the port contract see {@link DynamicWorkflowRunPort.concurrencyCeiling}).
     * It is the **same** {@link concurrencyCeiling} as the starting point of the caps: the value the tool layer clamps must equal the value the port then
     * persists, otherwise the confirmation window would not be showing the number that is about to take effect.
     */
    concurrencyCeiling,

    /**
     * Changes one in-flight run's own concurrency upper bound in place (for the port contract see
     * {@link DynamicWorkflowRunPort.retuneConcurrency}; the implementation lives in dynamic-workflow-run-retune.ts).
     *
     * Deliberately **does not pass the shutdown gate**: the three launch entry points need `assertOpen` because they start an engine, whereas this one starts nothing --
     * in a shutting-down service every entry is settling, and the liveness check reports it as `not_live` all by itself.
     */
    async retuneConcurrency(
      request: DynamicWorkflowRunRetuneRequest,
    ): Promise<DynamicWorkflowRunRetuneResult> {
      return retuneRunConcurrency({ runs, journal: deps.journal, concurrencyCeiling }, request);
    },

    async resume(runId: string): Promise<DynamicWorkflowRunResumeResult> {
      assertOpen();
      return resumeDynamicWorkflowRun(entryContext, runId);
    },

    async listRunsForSession(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]> {
      if (!supportsRunEnumeration(deps.journal)) {
        // No enumeration query (such as memory journal): the empty list is the honest answer - run in the memory journal is
        // The process will not survive, and there will be nothing to restore after restarting.
        return [];
      }
      const capped = Math.max(1, Math.min(limit ?? DEFAULT_LIST_RUNS_LIMIT, MAX_LIST_RUNS_LIMIT));
      let rows: DwfRunSessionListItem[];
      try {
        rows = deps.journal.listRunsByParentSession(deps.parentSessionId, capped);
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run enumeration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.list_failed",
          module: "bootstrap.app",
        });
        return [];
      }
      // Live entries are also handed over to the summary: session enumeration and snapshot/list/details share the same priority (rule three),
      // Otherwise, this side will display a run marked by external writes.
      return rows.map((row) => toSessionSummary(row, runs.get(row.runId)));
    },

    async replayProgressForSession(input: {
      excludeRunIds: ReadonlySet<string>;
    }): Promise<DynamicWorkflowRunProgressPayload[]> {
      if (!supportsRunEnumeration(deps.journal)) return [];
      let rows: DwfRunSessionListItem[];
      try {
        // The upper bound is the same constant as the projection elimination: cold state = the state that a long-lived process would hold at this moment.
        rows = deps.journal.listRunsByParentSession(
          deps.parentSessionId,
          WORKFLOW_RUNS_LIMITS.maxRuns,
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run replay enumeration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.replay_failed",
          module: "bootstrap.app",
        });
        return [];
      }
      const payloads: DynamicWorkflowRunProgressPayload[] = [];
      // The latest update of the enumeration surface is first; the oldest is prioritized for playback, and the elimination of reducers is the same as the arrival order during live.
      for (const row of [...rows].reverse()) {
        // Runs that already have events in the caller's memory (ran by this process) and runs that are in the registry will not be played back:
        // Their events are all in the memory store, and feeding them again will only cause run-started to return the phase to the starting point.
        if (input.excludeRunIds.has(row.runId) || runs.has(row.runId)) continue;
        // The ceiling has the same source as the live side: the `run-started` payload of cold playback must be equal to the live one byte by byte.
        payloads.push(...replayRunProgress(row, deps.journal, concurrencyCeiling()));
      }
      return payloads;
    },

    async getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined> {
      noteForeignTerminalRow(taskId);
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        concurrencyCeiling(),
      );
    },

    /**
     * The script archived for the run (for the port contract see {@link DynamicWorkflowRunPort.getScript}). The registry entry comes first:
     * in the gap between submit and createRun the journal has no row yet, so what is on the entry is those very same bytes. The journal copy is also the bytes
     * that resume's hash check reads, so `AmendWorkflow` carrying over, the `script_unchanged` pre-check and resume
     * can never give two answers to "what is this run running".
     */
    async getScript(runId: string): Promise<string | undefined> {
      return runs.get(runId)?.scriptText ?? deps.journal.getRun(runId)?.scriptText;
    },

    async waitForTask(
      taskId: string,
      options?: { signal?: AbortSignal },
    ): Promise<DynamicWorkflowRunSnapshot | undefined> {
      const entry = runs.get(taskId);
      // Not in the registry: It may be a previous run of this process (recorded in the journal) or completely unknown. Neither can wait.
      if (entry === undefined) {
        return snapshotOf(
          taskId,
          runs,
          deps.journal,
          escalations.pendingFor(taskId),
          concurrencyCeiling(),
        );
      }
      if (entry.terminal === undefined) await settleOrAbort(entry.settlement, options?.signal);
      // Parked items are reprojected after **waiting**: the question may have been answered or removed during the waiting period.
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        concurrencyCeiling(),
      );
    },

    /**
     * Answers a blocking question that an actor escalated up. Table lookup -> driver settlement -> the tool result of `escalate` becomes this
     * answer, and the actor's turn continues in place. **The run state never moves** throughout: an escalation is one slow tool call inside an ask,
     * not a run lifecycle event (by design escalate neither terminates nor freezes the run).
     *
     * The discrimination and the wording of the three structured refusals both live in the registry (only it knows whether a qid never existed, has already been answered,
     * or was withdrawn along with its ask). This method deliberately adds no second check -- judging once in each of the two places would sooner or later make the same qid
     * get two different readings on the two layers.
     */
    async resolveQuestion(
      qid: string,
      answer: string,
    ): Promise<DynamicWorkflowResolveQuestionResult> {
      return escalations.resolve(qid, answer);
    },

    async cancel(
      runId: string,
      initiator: DynamicWorkflowRunCancelInitiator = "user",
    ): Promise<boolean> {
      const entry = runs.get(runId);
      // Unknown run (or settled) has nothing to abort. Return false to normalize the upper layer into structured not_found,
      // Instead of reporting a cancellation that didn't happen.
      if (entry === undefined || entry.terminal !== undefined) return false;
      // abort is the only "true stop" in the harness: abort the flying ask, kill child process, the engine passes stop(initiator)
      // Settlement stopped (completed journal entries retained → can be resumed). The reason for abort is the initiator——
      // The harness reads `signal.reason` to decide whether it is stopped(user) or stopped(model). From then on, the reason is stored in the database.
      // No longer just live in the background task registry.
      entry.controller.abort(initiator);
      return true;
    },

    async listEvents(
      runId: string,
      options: DynamicWorkflowRunEventPage,
    ): Promise<DynamicWorkflowRunEvent[]> {
      const page = deps.journal.listEvents(runId, {
        ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return page.map((stored) => toProtocolEvent(stored.sequence, stored.event));
    },

    /**
     * The inventory of user-facing artifacts of this run. The durable way for UI cold recovery and the hub detail view
     * to read it: the `workflowRuns.artifacts` projection is memory-only and empty after a restart, while the persistent home of version history has always been
     * the journal's `kind = "artifact"` rows.
     *
     * The merge rules reuse {@link artifactsOf} wholesale -- the terminal snapshot (`getTask`) and this method have to give the **same**
     * inventory, and merging one each in the two places would eventually diverge on things like "does a failed row count as a version".
     *
     * ⚠ Terminology: here artifact is the output the script publishes for the user to see, not the `output` on the port (the script's top-level
     * return value, which the engine also calls an artifact).
     *
     * An unknown runId and "this journal has no artifact read surface" both return `undefined`: to the caller these are the same business fact.
     */
    async listArtifacts(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined> {
      return artifactsOf(runId, deps.journal).artifacts;
    },

    /**
     * The `report` entries feeding a given seeded artifact, paginated in ascending journal sequence (the board's fetch surface).
     * An out-of-range cursor gets an empty page rather than an error -- running off the end is a normal paging outcome.
     */
    async listArtifactItems(
      runId: string,
      artifactId: string,
      page: DynamicWorkflowRunArtifactItemPage,
    ): Promise<readonly DynamicWorkflowRunArtifactItem[]> {
      return listArtifactItemsFrom(deps.journal, runId, artifactId, {
        ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
        limit: page.limit,
      });
    },

    /**
     * Reads the bytes of one artifact version. The whole authorization chain (the run belongs to this session AND the journal has a completed row for that version => take the
     * uri on the row) lives in {@link readWorkflowArtifactBytes}, which diagrams the chain.
     *
     * `parentSessionId` uses **this service's own** value (= this app's session), deliberately without a parameter: a service instance is constructed
     * per parent session anyway, so letting the caller pass an arbitrary session would open a cross-session read hole -- the same
     * argument as for `listRunsForSession`, except that one enumerates while this one reads bytes.
     */
    async readArtifact(
      runId: string,
      artifactId: string,
      version: number,
    ): Promise<DynamicWorkflowRunArtifactBytes | undefined> {
      return readWorkflowArtifactBytes(
        {
          journal: deps.journal,
          parentSessionId: deps.parentSessionId,
          ...(deps.artifactStore === undefined ? {} : { artifactStore: deps.artifactStore }),
        },
        runId,
        artifactId,
        version,
      );
    },

    /**
     * The inventory and bodies of the workspace transcripts. The authorization chain
     * is the same one as for readArtifact (the run belongs to this session), and both run -- the args on the inventory are already paths and command lines.
     * The whole thing lives in dynamic-workflow-run-workspace.ts.
     */
    async listWorkspaceNodes(
      runId: string,
    ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined> {
      return listWorkspaceNodesFrom(
        { journal: deps.journal, parentSessionId: deps.parentSessionId },
        runId,
      );
    },

    async readWorkspaceNodeResult(
      runId: string,
      siteId: string,
      ordinal: number,
      query: DynamicWorkflowRunWorkspaceNodeResultQuery,
    ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined> {
      return readWorkspaceNodeResultFrom(
        { journal: deps.journal, parentSessionId: deps.parentSessionId },
        runId,
        siteId,
        ordinal,
        query,
      );
    },

    ...(introspection === undefined
      ? {}
      : createRunIntrospectionMethods({
          introspection,
          journal: deps.journal,
          parentSessionId: deps.parentSessionId,
          runs,
          escalations,
          concurrencyCeiling,
        })),
  };
}
