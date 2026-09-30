// ============================================================
// The startup execution body of Dynamic Workflow Run (the shared half of submit and resume)
// ============================================================
// submit (new runId) and resume (existing runId, the engine will
// resume branch) is completely isomorphic in the section "Assembly driver → Run runWorkflowScript", and this file is shared:
// Each of the two entrances maintains a copy. Sooner or later, one of them forgets to intercept the event sequence or rehydrate the actor.
//
// This document holds three things:
//   1. Journal sequence interception (emit side gets the sequence of the event just appended);
//   2. RunEvent → Session event payload (bounded + two derived fields);
//   3. Actor runtime access: new (drop session line + task link) or rehydrated (resumeFromStore).

import { randomUUID } from "node:crypto";
import {
  boundDynamicWorkflowRunEventPayload,
  CoreErrorType,
  ZCODE_DWF_CHILD_COMMAND,
  type CreateSessionTaskLinkInput,
  type DynamicWorkflowRunEvent,
  type DynamicWorkflowRunProgressPayload,
  type SessionId,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { parseModelPickerValue, type ModelSelection } from "@zcode/shared/model-selection";
import {
  type ActorSubmitProfile,
  refToString,
  validate,
  type ActorRef,
  type AskSpec,
  type Caps,
  type ImportedRunCache,
  type JournalStorePort,
  type JsonSchema,
  type RunEvent,
  type RunSettlement,
  type ValidateFn,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { createJournalSequenceCapture } from "./dynamic-workflow-run-sequence-capture.js";
import { isResumableSettlement } from "./dynamic-workflow-run-observation.js";
import {
  readRunLaunchAnchor,
  readRunSubagentModel,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import { createAgentRuntimeWorkflowDriver, mintActorSessionId } from "./workflow-driver.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import type { WorkflowRunControl } from "./workflow-run-control.js";
import { createWorkflowRunSeatGate } from "./workflow-seat-gate.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";

/** Adapts the in-package validator to the engine's ValidateFn contract (launch is the only call site of runWorkflowScript). */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

/** Everything one compilation produces. All four consumers share the same ts.Program (compiled once — see run service invariant 2). */
export interface CompiledDynamicWorkflowScript {
  lowered: string;
  scriptHash: string;
  askSpecs: Map<string, AskSpec>;
  /** The approved command set of world.run (collected as literals at compile time). */
  declaredRunCommands: ReadonlySet<string>;
  /** The submit profile of each actor site. */
  actorSubmitProfiles: ReadonlyMap<string, ActorSubmitProfile>;
}

interface LaunchDynamicWorkflowRunInput {
  caps: Caps;
  compiled: CompiledDynamicWorkflowScript;
  cwd: string;
  deps: DynamicWorkflowRunServiceDeps;
  /** The run's display name (the optional `input.name` of `CreateWorkflow`): travels in EngineConfig and lands in dwf_run.name at createRun time. */
  name?: string;
  /**
   * This run's arguments (the validated argument bag of a saved workflow). Two destinations:
   * in `dwf_run.args_json` via EngineConfig, and in the spawn payload as the sandbox's `args`
   * global.
   *
   * The resume branch passes **the copy read back from the journal**, not a freshly supplied
   * one — see the resume comment in the run service.
   */
  args?: Record<string, unknown>;
  parentSessionId?: string;
  runId: string;
  scriptText: string;
  signal: AbortSignal;
  toolCallId?: string;
  /**
   * The lineage pointer for an amended resume (`dwf_run.resumed_from`) and its import cache.
   * The two always appear **as a pair**: the pointer is a row-level fact (the UI's "resumed from
   * run X", and a post-crash resume rebuilds from it), while the cache is an acceleration
   * structure for this execution.
   *
   * They travel the same route as the rest of the metadata — launch → harness → EngineConfig,
   * with no processing in between. Building them (reading the predecessor's journal, walking
   * the `resumed_from` chain, resolving transcript sources) happens entirely in the run
   * service: this is already the execution side, so putting the build here would mean resume
   * and submit each build once (and they must be two calls of the same pure function).
   */
  resumedFrom?: string;
  importedCache?: ImportedRunCache;
  /**
   * Where usage starts when the run is created: the predecessor's `spentTokens` after it
   * settled. Same route as the lineage pointer — launch → harness → EngineConfig, with no
   * processing in between: the amend path supplies it, while a brand-new submit and a resume
   * omit it (the latter restores usage from the existing row).
   */
  inheritedTokens?: number;
  /**
   * The anchor of the turn that started the run. The submit path supplies it (the engine
   * records `run-launched` in the lifetime when the run is created); the resume path omits it
   * and this function reads it back from the journal — both paths use that same value to derive
   * `launchInputId` for the `actor-created` / `run-settled` progress events. The submit path
   * also rides along with the script's declared phase table (`phaseNames`) and this run's
   * subagent model (`subagentModel`, a canonical picker string); all three land in the journal
   * only in the lifetime when the run is created, and the resume path reads every one of them
   * back from that event.
   */
  launch?: RunLaunch;
  /**
   * The residency registry of escalation questions. The run service holds one, spanning all
   * in-flight runs under its name, and both entry points (submit / resume) pass **the same
   * object** — the registry is keyed by the full qid, so one registry per entry point would
   * leave a run that resumed unable to answer the question it just asked.
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /**
   * The live control plane of this run. The run service builds one per **registry entry** (all
   * three entry points — submit / amend / resume — build one), and this function wires up its
   * two ends here: the harness owns `bind(engine)`, this function owns `bindSeatGate`.
   *
   * Absent means this launch has no control plane (e.g. snippet execution) — the run still
   * finishes normally, only the ceiling cannot be changed midway.
   */
  control?: WorkflowRunControl;
  /**
   * Catches the **session quiescence probe** of the driver this launch just created
   * (workflow-driver-quiescence.ts). All three entry points pass the same thing: attach it to
   * this run's registry entry, so that a later amend of it can ask "has the predecessor's
   * session finished writing?". It is forwarded verbatim; this file does not read it.
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
}

/**
 * Start (or resume) a run: wire up sequence slicing → emit hooks → the real driver →
 * runWorkflowScript. The caller decides the fire-and-forget semantics (this function only
 * returns the settlement promise and does no registry bookkeeping).
 */
export function launchDynamicWorkflowRun(
  input: LaunchDynamicWorkflowRunInput,
): Promise<RunSettlement> {
  const {
    args,
    caps,
    compiled,
    control,
    cwd,
    deps,
    escalationRegistry,
    importedCache,
    name,
    parentSessionId,
    resumedFrom,
    runId,
    scriptText,
    signal,
    toolCallId,
  } = input;
  const childSpawn = dynamicWorkflowChildSpawn();
  // The **second** execution point of this run's own upper bound: the scheduler controls "whether another ask can be sent", and the gate controls "whether the next requests that are already running can be sent out."
  // The starting point is the caps of this startup (submit is the clamped request value, resume is the copy in the journal line), so a
  // A run that has never been retune always takes the fast path through the gate—no events, no tickets, and is literally the same as before.
  const seatGate = createWorkflowRunSeatGate({ limit: caps.maxConcurrency });
  control?.bindSeatGate(seatGate);
  // Anchor point: given by submit (this build run) or in journal (resume). pre-upgrade run has neither → absent,
  // The progress event does not have launchInputId and is not reported by the subagent.
  const launch = input.launch ?? readRunLaunchAnchor(deps.journal, runId);
  // lineage pointer: submit/amend path is given by input parameter; resume path input parameter is absent (createRun has been hard-coded), from
  // Journal line readback - `run-started` payloads for both paths are therefore isomorphic.
  const lineageFrom = resumedFrom ?? deps.journal.getRun(runId)?.resumedFrom;
  // Concurrency ceiling: The second host-derived field of the `run-started` payload. Counted once for each launch instead of for each event
  // Once - it is a process fact, the number of cores does not change after a run reaches half of the cores, and `availableParallelism()` is a system call.
  const concurrencyCeiling = resolveWorkflowConcurrencyCeiling(deps.availableParallelism);
  // Subagent model: given by submit (same as anchor) or in journal (resume is read back from the same run-launched).
  // With the same argument as the anchor, the two paths are therefore isomorphic; pre-upgrade run has neither side → absent = running on the conversational model.
  const subagentModel = input.launch?.subagentModel ?? readRunSubagentModel(deps.journal, runId);
  // String → selection, parsed once per launch. The progress payload takes the original string (toProgressPayload below),
  // What the actor runtime factory wants is structured selection (including reasoning gear, the two identities of pin cannot be brought back).
  const runSubagentModel =
    subagentModel === undefined ? undefined : parseModelPickerValue(subagentModel);

  // The journal sequence of events is only known by appendEvent, and the engine is in record()
  // `journal.appendEvent(...)` is **synchronized** immediately followed by `driver.emit(...)`, and the returned
  // StoredEvent(engine.ts). So here is a layer of journal to cut off the assigned sequence:
  // What emit got must be the one just now. The alternatives are worse - the local incrementing counter will be in resume(sequence
  // Continuing from the existing maximum value), the overall offset will occur, and checking the journal once for each event is a waste of IO.
  // The premise of "append follows emit, one-to-one correspondence" is nailed by the test: the sequence sequence seen by the hook must be consistent with
  // listEvents returns item-by-item equality.
  const sequenceCapture = createJournalSequenceCapture(deps.journal);

  const makeDriver = createAgentRuntimeWorkflowDriver({
    journal: sequenceCapture.journal,
    emit: (event) => {
      // Event fanout must not suspend run: the hook is an observer, and exceptions are swallowed at this boundary and logged.
      try {
        if (deps.onRunEvent === undefined) return;
        deps.onRunEvent(
          toProgressPayload({
            event,
            runId,
            sequence: sequenceCapture.sequenceOf(event),
            ...(toolCallId === undefined ? {} : { toolCallId }),
            ...(launch === undefined ? {} : { launchInputId: launch.inputId }),
            ...(lineageFrom === undefined ? {} : { resumedFrom: lineageFrom }),
            concurrencyCeiling,
            ...(subagentModel === undefined ? {} : { subagentModel }),
          }),
          // Routing and payload are separated: the event must fall in the session that initiated the run, and parentSessionId is
          // The only basis for judging "whether it is that conversation".
          parentSessionId === undefined ? {} : { parentSessionId },
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run event hook failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run_event.hook_failed",
          module: "bootstrap.app",
          runId,
        });
      }
    },
    executionPort: deps.executionPort,
    fileSystemPort: deps.fileSystemPort,
    escalationRegistry,
    cwd,
    // The placement point of user-facing products. Session scope fetch** this service
    // The ** parent session (= the session of this app) instead of the optional parentSessionId in the launch input parameter: both are
    // The same value in production (run start passes the runtime's own sessionId), but only the former is required, while
    // There should not be an undefined branch in "Which session's directory the bytes are written to". When store is absent, the entire pair will not be transmitted.
    // The driver side therefore rejects it loudly as ArtifactStoreUnavailable.
    ...(deps.artifactStore === undefined
      ? {}
      : {
          artifactStore: deps.artifactStore,
          parentSessionId: deps.parentSessionId as SessionId,
        }),
    declaredRunCommands: compiled.declaredRunCommands,
    // Which submit_result (typed/generic/none) each actor site takes is determined at compile time.
    actorSubmitProfiles: compiled.actorSubmitProfiles,
    runId,
    // Boundary accounting and seed replication both read and write actor session messages (on the driver side, see the file header of workflow-driver.ts).
    ...(deps.actorTranscriptStore === undefined
      ? {}
      : { actorTranscriptStore: deps.actorTranscriptStore }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    // Narrow port of process-level concurrency manager: present driver to each
    // actor runtime is a request-level access port (the runtimeFactory is downloaded as is below); its absence means that the actor is not subject to the gate.
    ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
    // The seat gate of this run: the driver wraps the admission port of each actor into it and feeds it the start and end of the ask
    // (startAsk with engine's `node-settled`).
    seatGate,
    // Test injected driver clock (fault matrix); production absent, driver real time.
    ...(deps.driverClock === undefined ? {} : { clock: deps.driverClock }),
    // The backfill port of the session silent probe (see input parameter field comments): driver is called once during construction.
    ...(input.onQuiescenceProbe === undefined
      ? {}
      : { onQuiescenceProbe: input.onQuiescenceProbe }),
    runtimeFactory: async ({
      sessionId,
      actor,
      persona,
      escalatePort,
      seed,
      submitPort,
      submitProfile,
      modelRequestAdmission,
    }) => {
      const runtime = deps.createActorRuntime({
        runId,
        sessionId,
        actor,
        persona,
        submitPort,
        // The factory determines whether the port is injected and whether the declaration is typed (createActorRuntime of create-app.ts) based on the profile.
        submitProfile,
        // The request-level admission port and the two tool ports are downloaded to the runtime deps via the same path.
        ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
        // The upgrade port and the submit port are transmitted through the same path: the registration gate on the core side is subject to the existence of the port, so it is always transmitted.
        escalatePort,
        // Resume pin: The model on which this actor ran last time. Must be read before **creating the runtime,
        // Because the following line journalActorResolvedModel will write this round of parsing results back to the same field.
        //
        // The pin brought by the seed is amend-resume: when the run is revised for the first time, the journal of this run is still there.
        // Without analysis results, pin can only come from the precursor - the silent change model under transcriptional continuation is exactly the identity mutation that pin needs to prevent. Both are there
        // field (revised run resumes after crash), the record of this run shall prevail: that is the actual behavior of this actor in **this run**
        // The running model is more specific than the front-wheel drive one, and the two are meant to be equal. The loud failure of misshapen pins follows the established routine.
        // (WorkflowActorPinnedModelError of workflow-actor-model.ts), no forking here.
        pinnedModel:
          pinnedActorModel({ actor, journal: deps.journal, runId }) ?? seed?.resolvedModel,
        // Subagent model for this run: on top of pin (priority table in workflow-actor-model.ts). It is the user's
        // This time the explicit statement of run (AmendWorkflow with subagent_model is the explicit statement of "resume when changing model"
        // Determine), pin just sticks to the implicit default without it. Unlike pin, it goes down the whole line with reasoning gear——
        // The pin of the journal only records two paragraphs of identity.
        ...(runSubagentModel === undefined ? {} : { runSubagentModel }),
      });
      // Which model the model gear of persona is actually parsed into can only be determined accurately by the built runtime (see gear mapping)
      // workflow-actor-model.ts). Drop the database first and then connect to the session: a failed session persistence will cause the ask to fail.
      // But the audit fact "which model was selected at that time" remains in the journal. The rehydrate path must also be written——
      // When the pin is absent (the old run before the upgrade), this round is the first time that the parsing results can be recorded.
      journalActorResolvedModel({
        actor,
        journal: deps.journal,
        selection: requireActorModelSelection(runtime, actor),
        runId,
      });
      const attached = await attachActorSession({
        actor,
        deps,
        runId,
        runtime,
        sessionId,
      });
      if (attached === "rehydrated") return runtime;
      await persistActorSession({
        actor,
        deps,
        parentSessionId,
        runId,
        runtime,
        sessionId,
      });
      return runtime;
    },
  });

  return runWorkflowScript({
    askSpecs: compiled.askSpecs,
    caps,
    // The spawn strategy must be changed under SEA, and will not be passed under non-SEA.
    ...(childSpawn === undefined ? {} : { childSpawn }),
    cwd,
    lowered: compiled.lowered,
    makeDriver,
    // When the entry file cannot be written into the project `.zcode/`, the harness will fall back to the OS temporary directory and will beep - run and start as usual.
    // But this log is the only clue to troubleshoot "why there is no workflow-runs archive in the project".
    onWarning: (warning) => {
      deps.logger?.warn?.("Dynamic workflow entry file fell back to the OS temp dir", {
        event: "dynamic_workflow.entry_file.fallback",
        module: "bootstrap.app",
        runId,
        ...warning,
      });
    },
    // name and scriptText share the same metadata path: harness is transferred to EngineConfig as it is (journal when resume
    // Hit short-circuit createRun, passing it is harmless and keeps the submit/resume two launch inputs homogeneous).
    ...(name === undefined ? {} : { name }),
    // Really participates in the same metadata path of name / scriptText, but has one more destination: harness is transferred to EngineConfig
    // (fall args_json), also put into the spawn payload injection sandbox.
    ...(args === undefined ? {} : { args }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    runId,
    // What is included in the library is the author's original text and its hash, not the lowered function body (the comparison benchmark of resume is the original text).
    scriptHash: compiled.scriptHash,
    scriptText,
    // The associated anchor point is dropped with run: after restarting, the tool card join and resume notifications can only restore it from dwf_run.
    ...(toolCallId === undefined ? {} : { toolCallId }),
    // Revision and continuation: drop the lineage pointer into the library (createRun is written once) and import the cache injection engine (pure data, core zero I/O).
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(importedCache === undefined ? {} : { importedCache }),
    // The usage starting point is the same as the cache: the engine writes it as the initial value of spent_tokens when creatingRun, and ignores it when it hits an existing row.
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // The anchor point is only built in the run journal (the door on the engine side), and it is harmless when resumed.
    ...(launch === undefined ? {} : { launch }),
    signal,
    // The control surface is the same as the signal: that one is "stop this run", this one is "change a setting of this run".
    // The harness binds (harness.ts) in the same synchronization piece that the engine constructed, so the run can be modified from the first event.
    ...(control === undefined ? {} : { control }),
    validate: validateFn,
  });
}

/**
 * Spawn strategy for the sandbox child process: under SEA it re-execs through a hidden
 * subcommand, otherwise it takes no position (the harness default is
 * `node --max-old-space-size=… <entry>`).
 *
 * A SEA single-file binary does not interpret Node CLI flags, so the `--max-old-space-size`
 * in the harness's default argv lands verbatim in the CLI's strict parseArgs and the child
 * dies immediately with a parse error — **under SEA every workflow run would fail**. The fix
 * is the same one the official plugin host uses (`officialPluginHostPrefixArgs` in
 * official-plugin-runtime.ts).
 *
 * The SEA check stays in bootstrap instead of sinking into the harness: the harness is
 * app-free (it depends only on `@zcode/dynamic-workflow` and node builtins), so it can
 * neither reach contracts' subcommand constants nor should it know which host packaged it.
 * `isSea` is injectable purely for testability — the default probe inevitably returns false
 * in a test process, which makes "no argsPrefix outside SEA" an assertable fact.
 */
export function dynamicWorkflowChildSpawn(
  isSea: boolean = isSeaRuntime(),
): { argsPrefix: readonly string[] } | undefined {
  return isSea ? { argsPrefix: [ZCODE_DWF_CHILD_COMMAND] } : undefined;
}

/** SEA runtime probe (a local mirror of the identically named private helper in official-plugin-runtime.ts, deliberately not shared across files). */
function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => { isSea(): boolean })
    | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

/**
 * Resume re-hydration: the journal already records a session id for this actor ⇒ this is a
 * re-attach (the session row and its messages were persisted long ago; `mintActorSessionId`
 * is purely deterministic, so sessionId is the very one from back then, and the driver side
 * cross-checks it). `resumeFromStore` rebuilds messageHistory from the persisted
 * message/part rows — an interrupted tool call is pinned by the hydrator to "[Tool execution
 * was interrupted before resume]", which is exactly the right semantics for a killed ask.
 *
 * `SessionNotFound` (the session row was cleaned up) is not an error but a documented
 * exception: fall back to the fresh-persistence path and let the actor start over from an
 * empty context — more honest than wedging the whole run. Every other exception is rethrown
 * as-is (low layers never swallow errors — house rule).
 */
async function attachActorSession(input: {
  actor: ActorRef;
  deps: DynamicWorkflowRunServiceDeps;
  runId: string;
  runtime: AgentRuntime;
  sessionId: SessionId;
}): Promise<"fresh" | "rehydrated"> {
  const { actor, deps, runId, runtime } = input;
  const journaledSessionId = deps.journal.getActor(runId, actor.siteId, actor.ordinal)?.sessionId;
  if (journaledSessionId === undefined) return "fresh";
  try {
    await runtime.resumeFromStore();
    // The session line and task link were both dropped in the previous life (both were upsert), and they will not be rebuilt again if they are hung again.
    return "rehydrated";
  } catch (error) {
    if (!isSessionNotFound(error)) throw error;
    deps.logger?.warn?.("Dynamic workflow actor session pruned; starting fresh", {
      actor: refToString(actor),
      event: "dynamic_workflow.actor.rehydrate_fallback",
      module: "bootstrap.app",
      runId,
      sessionId: input.sessionId,
    });
    return "fresh";
  }
}

/** Structured detection of core's SessionNotFound (flow decisions never key off the error text). */
function isSessionNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === CoreErrorType.SessionNotFound
  );
}

/**
 * Make the actor session real: write the session row + create the task link (the legacy path
 * demonstrates this in script-workflow-runtime.ts).
 *
 * The order is **load-bearing**: `session_task_link.child_session_id` has an FK on
 * `session(id)`, so the session row must land before the link. That is also why
 * ActorRuntimeFactory is allowed to return a Promise.
 *
 * Events of the actor runtime are **no longer** subscribed to here: the live channel was
 * already wired up during the child runtime's **construction** (the eventSink in
 * script-workflow-child-runtime.ts → the parent runtime's external sink set). The old
 * `subscribeEvents` channel was installed after the
 * `ensureSessionPersistedForExternalActivity` line below, and it writes SessionTitleUpdated as
 * sequenceNumber 1 — the v4 gateway only drains a contiguous seq run, so the subscription
 * waits from seq 2 for a seq 1 that will never come and the transcript stays blank forever.
 */
async function persistActorSession(input: {
  actor: ActorRef;
  deps: DynamicWorkflowRunServiceDeps;
  parentSessionId?: string;
  runId: string;
  runtime: AgentRuntime;
  sessionId: SessionId;
}): Promise<void> {
  const { actor, deps, parentSessionId, runId, runtime, sessionId } = input;
  const title = `workflow subagent ${refToString(actor)}`;

  await runtime.ensureSessionPersistedForExternalActivity(title);

  if (deps.taskLinkStore) {
    await deps.taskLinkStore.createSessionTaskLink({
      childSessionId: sessionId,
      id: `tasklink_${randomUUID()}`,
      // rootWorkflowRunId is intentionally left blank. **Verified Fact** (not a guess): The column is declared as
      // `root_workflow_run_id text references workflow_run(id)`(migration 0007,
      // See session_task_link table creation), pointing to the **legacy** workflow_run table, and the records of workflow run are in
      // dwf_run;migration runner on pragma foreign_keys = on. Detected against the real store:
      // Calling with workflow runId will result in `FOREIGN KEY constraint failed`, if omitted, it will succeed. So run as identity
      // The path column below has no FK. Don't "fix" it back.
      //
      // path is a mini-contract: `dwf/<runId>/<siteId>@<ordinal>`. runId is character set safe; siteId segment
      // Keep the original `#`/`@` (free text column and sanitized form in session id). **No code today
      // Parse it** - it serves human reading and possible future prefix scanning ("all actor sessions for this run").
      // If you want to build an index query based on run id in the future, you will need a rebuild
      // The migration of session_task_link changes or removes FK.
      path: `dwf/${runId}/${refToString(actor)}`,
      ...(parentSessionId === undefined ? {} : { parentSessionId: parentSessionId as SessionId }),
      // It is deliberately distinguished from the legacy "workflow_agent" (script-workflow-runtime.ts), rather than reused:
      // The two are different groups of people. The root_workflow_run_id of the legacy row points to workflow_run and is not empty, the dwf row
      // This column is always empty and the run identity is in path. Sharing a role value will cause "fetch rows by role and then dereference"
      // The consumer of root_workflow_run_id" gets null from the dwf row. Column is `text not null`, no CHECK,
      // There is no enum and no zod on the contract side (checked), so the new value is legal.
      role: "workflow_actor",
      status: "running",
    } satisfies CreateSessionTaskLinkInput);
  }
}

/**
 * Write which model the actor actually ran on into the journal (`ActorRecord.resolvedModel`,
 * landing in the dwf_actor resolved_model column).
 *
 * Why it must be a **read-modify-write**: `putActor` replaces the whole record, and this
 * record's other fields (name / persona / sessionId) are not this function's to know; writing
 * a record with only resolvedModel would erase the frozen persona the engine just wrote.
 *
 * Why the driver side writes it: which model a subagent runs on is a host fact (the choice the
 * parent session made at the time), and the engine cannot see it at the moment it persists the
 * persona synchronously in createActor. The engine's two putActor calls carry this field
 * through unchanged — see dynamic-workflow's engine.ts / scheduler.ts.
 */
export function journalActorResolvedModel(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  selection: ModelSelection;
  runId: string;
}): void {
  const { actor, journal, selection, runId } = input;
  const existing = journal.getActor(runId, actor.siteId, actor.ordinal);
  journal.putActor({
    ...(existing ?? { runId, siteId: actor.siteId, ordinal: actor.ordinal }),
    resolvedModel: formatActorResolvedModel(selection),
  });
}

/** How `resolvedModel` is written in the journal: `providerId/modelId`, the exact inverse of how a pin is read (workflow-actor-model.ts). */
function formatActorResolvedModel(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}

/**
 * A freshly built actor runtime must already have a model selection: the child inherits the
 * parent session's current choice (script-workflow-child-runtime.ts), and without a choice the
 * parent session cannot even send the first model request. Fail loudly here rather than
 * recording "no model chosen" as an empty pin.
 */
function requireActorModelSelection(runtime: AgentRuntime, actor: ActorRef): ModelSelection {
  const selection = runtime.getSessionModelSelection();
  if (selection === undefined) {
    throw new Error(
      `actor session has no model selection, cannot record resolvedModel: ${actor.siteId}#${actor.ordinal}`,
    );
  }
  return selection;
}

/**
 * The pin read on resume: this actor's `resolvedModel` as recorded in the journal
 * (`providerId/modelId`).
 *
 * Only resume ever reads a value: the engine carries the field forward when replaying
 * `createActor`, while a brand-new run has no resolution result yet at the moment the runtime
 * factory runs, so it is naturally absent. **It must be read before the runtime is built**,
 * because `journalActorResolvedModel` then writes this round's resolution back into the same
 * field — reading too late would mistake this round's result for the previous round's pin.
 * For which of the pin and this run's subagentModel wins, see workflow-actor-model.ts (the
 * run's choice is on top; the pin only guards the default when there is no run choice — the
 * persistence half of the frozen-persona invariant).
 */
function pinnedActorModel(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  runId: string;
}): string | undefined {
  return input.journal.getActor(input.runId, input.actor.siteId, input.actor.ordinal)
    ?.resolvedModel;
}

/**
 * The RunEvent → protocol event mapping (**this comment is the contract**): `type` is the
 * event's discriminant, and `payload` is the remaining fields of that same event object with
 * `type` removed, bounded by {@link boundDynamicWorkflowRunEventPayload}. Field names are
 * deliberately not reshaped — the read side (the detail page's event log) interprets the
 * payload per event kind, and the engine's vocabulary *is* that schema.
 *
 * The kinds the engine actually emits: run-started / actor-created / node-queued /
 * node-dispatched / node-repairing / node-nudged / node-settled / usage-updated / log /
 * report / phase-entered / run-settled. (`executing` is not an observable event; `compaction`
 * is never emitted in v1.) Two further kinds are emitted by the **driver** and travel the same
 * two rails: escalation-raised / escalation-resolved (the escalation bridge in
 * workflow-driver.ts).
 *
 * Adding an event kind is zero-diff in **this function**, which is exactly what "do not
 * reshape field names" buys: `type` is the discriminant, the payload is everything else, and
 * there is no per-kind branch here to miss. **There is, however, a per-kind switch
 * downstream**: `applyWorkflowRunEvent` in `zcode-protocol-v4/product-projection.ts` reduces
 * kind by kind and its `eventType` parameter is `string` rather than `RunEvent["type"]`, so a
 * missing arm is not a tsc error — when you add an event kind, go read that switch instead of
 * relying on the compiler.
 */
export function toProtocolEvent(sequence: number, event: RunEvent): DynamicWorkflowRunEvent {
  const { type, ...rest } = event;
  const { payload, truncated } = boundDynamicWorkflowRunEventPayload(
    rest as Record<string, unknown>,
  );
  return { sequence, type, payload, ...(truncated ? { truncated } : {}) };
}

/**
 * RunEvent → session event payload. The `payload` uses the very same serialization as
 * {@link toProtocolEvent}; derived fields sit outside the payload so that the engine event
 * text is preserved.
 *
 * `actorSessionId` comes from the same generator the driver uses, so the renderer never
 * reimplements the session id rules. Both `actor-created` and a `node-dispatched` carrying an
 * actor fill that field in, so a live instance that gets folded into the bounded table can
 * still be linked to its subagent session. The process concurrency ceiling and the subagent
 * model are added under their own event conditions below.
 */
export function toProgressPayload(input: {
  event: RunEvent;
  runId: string;
  sequence: number;
  toolCallId?: string;
  /** The run's anchor inputId; derived only on actor-created / run-settled (the two moments of subagent attribution). */
  launchInputId?: string;
  /** The predecessor of an amended run; derived only on `run-started` (the card's "adjusted from run X"). */
  resumedFrom?: string;
  /**
   * The process concurrency ceiling at the moment this payload is minted; derived on both
   * `run-started` and `run-caps-changed`.
   *
   * Engine events only carry their own `caps.maxConcurrency`, while "this number is not worth
   * showing" requires comparing it against the ceiling — and the ceiling is a host fact (the
   * machine's core count) that the engine can neither see nor should see. The projection
   * records this run's own ceiling when `caps.maxConcurrency < concurrencyCeiling`, and the
   * UI's concurrency chip then takes min(shared cap, this run's own ceiling).
   *
   * An in-place retune emits `run-caps-changed` with **new** caps, yet the criterion is the
   * same one: below the ceiling, write down the ceiling; equal to the ceiling, clear it
   * (= no restriction). Both event kinds therefore have to get the same ceiling, which is
   * this one.
   */
  concurrencyCeiling?: number;
  /**
   * This run's subagent model (a canonical picker string); derived only on `run-started`, and
   * present **only when it was set**. Unlike `concurrencyCeiling` it needs no comparison
   * against any default: the engine has no idea this exists (the whole model surface lives on
   * the host side), so absent means "subagents run on the session model". A cold replay yields
   * the same key from the same `run-launched` event, so the payloads on both sides are
   * byte-identical.
   */
  subagentModel?: string;
}): DynamicWorkflowRunProgressPayload {
  const {
    event,
    runId,
    sequence,
    toolCallId,
    launchInputId,
    resumedFrom,
    concurrencyCeiling,
    subagentModel,
  } = input;
  const protocolEvent = toProtocolEvent(sequence, event);
  const actorRef = actorSessionRefOf(event);
  return {
    runId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    sequence,
    eventType: protocolEvent.type,
    // `run-settled` takes one more `resumable`:
    // The predicate of the resume gate is only available in the CLI. The projection and UI only carry this bit and will never deduce it by status.
    // Predicate = stopped ∧ not superseded; cold replay has converged on orphans
    // Rows are given to the same key - two chains, one predicate (isResumableSettlement). stopReason / supersededBy is exposed as is with the event payload.
    // `run-started` has more than `resumedFrom`: the engine event does not have it (the engine does not read lineage), but the card needs to draw this edge.
    // There is also `concurrencyCeiling` in the same crack: the engine only sends its own caps, and "is this upper bound the default value?"
    // Compare this to the host's ceiling (see field notes above). The two are not related to each other, and each is absent.
    // `run-caps-changed` walks the same crack and the same ceiling: retune on the spot once and then rely on it to determine the new upper bound when reading.
    // Should it be written down or should it be cleared away? Without it, this event would be just two numbers without a scale.
    payload:
      event.type === "run-settled" && isResumableSettlement(event.status, event.stopReason)
        ? { ...protocolEvent.payload, resumable: true }
        : event.type === "run-started"
          ? {
              ...protocolEvent.payload,
              ...(resumedFrom === undefined ? {} : { resumedFrom }),
              ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              ...(subagentModel === undefined ? {} : { subagentModel }),
            }
          : event.type === "run-caps-changed"
            ? {
                ...protocolEvent.payload,
                ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              }
            : protocolEvent.payload,
    ...(protocolEvent.truncated ? { truncated: true } : {}),
    ...(actorRef === undefined ? {} : { actorSessionId: mintActorSessionId(runId, actorRef) }),
    // The third derived field: the buried fact layer is only for these two events
    // Anchors are required - actor-created registers sub-agent ownership, run-settled settles all sub-agents of the run.
    ...((event.type === "actor-created" || event.type === "run-settled") &&
    launchInputId !== undefined
      ? { launchInputId }
      : {}),
  };
}

/**
 * Which subagent this event names (the ref that gets `actorSessionId` filled in); undefined
 * when it names none.
 *
 * Two event kinds: `actor-created` (a subagent's birth), and a `node-dispatched` carrying an
 * `actor` (the birth fact repeated at ask dispatch). A world-read dispatch carries no
 * `actor`, so nothing is filled in — it has no transcript to open.
 */
function actorSessionRefOf(event: RunEvent): ActorRef | undefined {
  if (event.type === "actor-created") return event.actor;
  if (event.type === "node-dispatched") return event.actor;
  return undefined;
}
