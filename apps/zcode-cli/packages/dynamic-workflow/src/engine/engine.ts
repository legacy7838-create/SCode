/**
 * The execution engine's deterministic state machine (the implementation of Boundary A, driving
 * Boundary B downward and reporting to the sink upward).
 *
 * The core does no I/O, reads no clock and uses no randomness: any decision that varies with time
 * or scheduling is either recorded in the journal or pinned by the deterministic rules of
 * "per-site ordinal + per-actor FIFO actorSeq", so that the first execution and the replay are
 * word-for-word identical.
 *
 * Key invariants:
 * - Instance identity = site id × per-site execution ordinal (the n-th ask#3 = ask#3@n). Actor
 *   identity = creating site × ordinal.
 * - Journal decisions: every host call first looks up (siteId, ordinal); a hit short-circuits
 *   (no driver call) and defensively verifies inputHash — a mismatch makes the whole run fail
 *   loudly (a structured error, never a silent drift).
 * - Per-actor FIFO + actorSeq admission order + the replay hold rules: see scheduler.ts (this
 *   file delegates the ask lifecycle to it).
 *
 * This file focuses on the run lifecycle: the host API entry points, usage accounting, run
 * settlement and event recording. The method bodies for the user-facing artifact, the report, the
 * world node + import cache, and the run terminal-state paths each live in sibling modules
 * (engine-artifacts.ts / engine-report.ts / engine-world.ts / engine-settlement.ts), reading and
 * writing this file's private state through the {@link EngineState} seam in engine-state.ts; only
 * thin delegations are left on the class (the reason for the split: the 400-line oxlint max-lines
 * limit). The two stamping functions for the birth phase coordinate (events and ProviderStop) are
 * pure functions living in engine-phase-stamp.ts and only read the `instancePhases` table this
 * class owns.
 */

import { ImportedWorldQueue, matchImportedActor } from "./imported-cache.js";
import type { ArtifactContentOp, ArtifactPresetOp } from "../facade/registry.js";
import { AskScheduler, type SchedulerHost } from "./scheduler.js";
import type { ArtifactIdState, EngineState, RunSettlement } from "./engine-state.js";
import {
  declarePresetArtifact,
  publishContentArtifact,
  rememberArtifactRow,
} from "./engine-artifacts.js";
import { publishReport } from "./engine-report.js";
import { closeImportCache, readWorld, recoverImportClosure } from "./engine-world.js";
import { recoverSettleOrder, ReplaySettleOrder } from "./replay-order.js";
import { settleCompleted, settleFailed, settleStopped } from "./engine-settlement.js";
import type {
  ActorId,
  ArtifactRef,
  AskProgress,
  AskSpec,
  AskStats,
  AskWaitInfo,
  Caps,
  ConcurrencyChange,
  ImportedRunCache,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  RunStallInfo,
  RunStatus,
  RunStopReason,
  ValidateFn,
  WorkflowDriver,
  WorkflowHostApi,
  WorkflowReportSink,
  WorldReadOp,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";
import { runLaunchedEvent, type RunLaunchConfig } from "./engine-launch.js";
import { enrichProviderStopPhase, stampBirthPhase } from "./engine-phase-stamp.js";

/** Engine construction configuration. */
export interface EngineConfig {
  runId: string;
  driver: WorkflowDriver;
  caps: Caps;
  /**
   * The static spec of each ask site (typed + schema). It **must cover every ask site in the
   * script** — the site table and the schema synthesis come from the same compile, so an absence can
   * only be a wiring error, and the engine treats it as a hard error (MissingAskSpec). An untyped
   * site has to be recorded explicitly as `{ typed: false }`.
   */
  askSpecs: ReadonlyMap<string, AskSpec>;
  /** The injected schema validator (the core does not import a schema implementation). */
  validate: ValidateFn;
  /** run metadata (written to dwf_run, only at this createRun; a resume does not overwrite the record). */
  scriptText?: string;
  /**
   * The run's display name (the optional `input.name` of `CreateWorkflow`). The engine never reads
   * it; it only writes it to the store alongside `scriptText` when creating the run — the host's
   * enumeration surface uses it to label runs. See {@link RunRecord.name}.
   */
  name?: string;
  /**
   * The hash of the script text. On resume it is compared with the value in the journal record: if
   * both are present and differ, this resume is rejected (a V1 resume only works for a
   * byte-identical script).
   */
  scriptHash?: string;
  /**
   * The actual arguments of this run (validated and back-filled). The engine never reads it; it only
   * writes it to the store alongside `scriptText` when creating the run; the sandbox-side injection
   * goes through the harness's spawn payload, not through the engine. See {@link RunRecord.args}.
   */
  args?: Record<string, unknown>;
  parentSessionId?: string;
  cwd?: string;
  /**
   * The id of the CreateWorkflow tool call that started the run (see {@link RunRecord.toolCallId}).
   * The engine never reads it; it only writes it with the rest of the metadata at createRun.
   */
  toolCallId?: string;
  /**
   * Which predecessor run this run amends (see {@link RunRecord.resumedFrom}). The engine never
   * reads it; it only writes it with the rest of the metadata at createRun — building the import
   * cache happens in the run service, not in the core.
   */
  resumedFrom?: string;
  /**
   * The anchor of the turn that started the run. The engine never reads it; it only records one
   * `run-launched` right after the first `run-started`, in the very lifetime in which the run is
   * created; a resume that hits an existing row records none (the anchor is unique across
   * lifetimes). `phaseNames` rides along with the anchor: the phase table declared by the script,
   * which the engine likewise never reads and only writes to the journal. `phaseAlongside` is
   * aligned with it by position (an index points into the same table) and rides along by the same
   * rules. `subagentModel` rides along too: this run's subagent selection (canonical picker
   * string), which the engine likewise never reads — the entire model side lives on the host
   * (bootstrap's workflow-actor-model.ts), and the host reads it back off this event, zero SQL.
   * `scriptPath` rides along by the same rules: which file this run's script came from (absolute
   * path), which the engine never reads and the host reads back off this event to hand to the
   * model side.
   */
  launch?: RunLaunchConfig;
  /**
   * The usage starting point when creating the run: the predecessor run's `spentTokens`. It is given
   * on the amend path and absent for a brand-new submit (= billing from zero); on the resume path it
   * is given but useless — when an existing row is hit, usage is restored from that row.
   *
   * The semantics are "this run reports the spend of the whole lineage": each predecessor's number
   * is itself already a cumulative total, so a chained amendment sums by construction and nobody
   * has to walk the `resumed_from` chain. A cache hit costs nothing more (that bill is already in
   * this inherited value); only the live turns actually running this time add on top.
   */
  inheritedTokens?: number;
  /**
   * The import cache for amend-resume ({@link ImportedRunCache}). **Pure data injection** — which
   * keeps the core a zero-I/O deterministic state machine: reading the predecessor's journal,
   * walking the `resumed_from` chain and resolving transcript sources all happen in the run service;
   * the engine merely receives a ready-built table and compares by runtime identity (actor name +
   * persona, `{op,args}` content + order of appearance). Absent means this is not an amending
   * continuation.
   */
  importedCache?: ImportedRunCache;
}

/** The run's final settlement (the definition moved with the settlement module's seam to engine-state.ts and is re-exported here in place). */
export type { RunSettlement } from "./engine-state.js";

interface SettledDeferred {
  promise: Promise<RunSettlement>;
  resolve: (value: RunSettlement) => void;
}

export class WorkflowEngine implements WorkflowHostApi, WorkflowReportSink {
  private readonly runId: string;
  private readonly driver: WorkflowDriver;
  private readonly journal: JournalStorePort;
  /**
   * The concurrency ceiling of this run. **Mutable** (see {@link setMaxConcurrency}): an amendment
   * that changes only `max_concurrency` takes effect in place on the live run. The whole thing is
   * replaced rather than having a field patched — the caps already written into events and the
   * journal must stay as they were when recorded (and the object the caller passed in is likewise
   * not written back to).
   */
  private caps: Caps;
  private readonly askSpecs: ReadonlyMap<string, AskSpec>;
  private readonly validate: ValidateFn;
  private readonly scheduler: AskScheduler;

  /** Per-site execution ordinal counters (shared by ask / world-read / actor; their site ids are all different). */
  private readonly ordinals = new Map<string, number>();
  /**
   * The number of phase entries, by name. **Not sharing a table with** `ordinals`: a phase name is
   * an arbitrary string from the author, so a phase that happens to be called `report#1` must not
   * shift that site's node ordinal (site-id stability), and vice versa.
   */
  private readonly phaseOrdinals = new Map<string, number>();
  /**
   * The phase name the control flow is currently in (maintained by `enterPhase`; undefined before
   * the first marker). It is read only at the minting point — see {@link nextOrdinal}.
   */
  private currentPhase: string | undefined;
  /**
   * Instance (`siteId@ordinal`) -> the phase name it had **at birth**. Written at the minting point
   * and read in the stamping funnel of {@link record}: the static causality graph copies sites by
   * phase, so a runtime instance has to carry the same coordinate, otherwise the instances on one
   * lane would be claimed simultaneously by every phase copy of that site (the shape of this bug:
   * five phases of 20 subagents each, five cards each showing 100).
   */
  private readonly instancePhases = new Map<string, string>();

  /**
   * The **non-empty effective actor names** already claimed in this run -> the actor that claimed
   * them (used in failure messages to name an earlier holder). See {@link createActor} for the
   * duplicate check and the replay-safety note.
   */
  private readonly actorNames = new Map<string, string>();

  /** The import cache for amend-resume (pure data; absent means this is not an amending continuation). */
  private readonly importedCache?: ImportedRunCache;
  /** The consumption cursor of the world import queue (the n-th occurrence matches the n-th entry). */
  private readonly importedWorld: ImportedWorldQueue;
  /**
   * Whether the import cache has been **closed**: set true before the first write and never
   * reopened — a live subagent is about to run a mutating tool (the driver reports askMutating), or
   * a world.run executes live. After closing, world nodes and asks carrying tools no longer consult
   * the import table (a hash only compares text; it cannot tell that the workspace has been
   * rewritten); pure asks (toolCalls 0) still hit as usual. On resume it is restored from the
   * `import-cache-closed` event, see {@link recoverImportClosure}.
   */
  private importClosed = false;
  /**
   * The settlement order gate for replay: settlements that hit the cache are released by the
   * **first-birth settlement order** recorded in the journal rather than by admission order — every
   * site ordinal after a join is decided by that order. A non-resume is always an empty gate
   * (everyone passes).
   */
  private replaySettleOrder = ReplaySettleOrder.empty();
  /** The "ask instances that were live before the crash" restored from events on resume (`siteId@ordinal`); empty for a non-resume. */
  private liveAskInstances: ReadonlySet<string> = new Set();
  /** The "ask instances admitted before the closure" restored from the event order on resume; the decision about resuming in-flight asks is reproduced from that. */
  private queuedBeforeImportClose: ReadonlySet<string> = new Set();

  /**
   * The number of reports published in this run (the counter behind REPORT_CAPS.maxItemsPerRun). On
   * resume it is restored from the number of kind:"report" rows in the journal — the cap is
   * run-level and has to keep counting across resumes, otherwise a run that is resumed over and
   * over could report without limit.
   */
  private reportCount = 0;
  /**
   * The state of every **user-facing artifact** id in this run. Restored the same way as
   * `reportCount`: on resume it is rebuilt from the journal's `kind: "artifact"` rows and maintained
   * in memory from then on — the caps (32 ids / 16 versions per id) and the version numbers are
   * run-level facts that have to stay continuous across resumes, otherwise a run resumed over and
   * over could publish without limit.
   *
   * ⚠ Terminology: artifact = a user-facing artifact, not `RunSettlement.artifact` (the top-level
   *   return value).
   */
  private readonly artifacts = new Map<string, ArtifactIdState>();
  /** Cumulative token usage (an observation surface: it only books and only broadcasts, and never fails the run). */
  private spentTokens = 0;
  private runSettled = false;
  private runFailure?: WorkflowError;

  private readonly settledDeferred: SettledDeferred;
  /** The seam through which free functions in sibling modules read and write the private state (assembled with arrow closures in the constructor, see engine-state.ts). */
  private readonly state: EngineState;

  constructor(config: EngineConfig) {
    this.runId = config.runId;
    this.driver = config.driver;
    this.journal = config.driver.journal;
    // Keep a copy for yourself: the object in the hands of the caller (harness/run service) should not be overwritten because of a retune.
    this.caps = { maxConcurrency: config.caps.maxConcurrency };
    this.askSpecs = config.askSpecs;
    this.validate = config.validate;
    this.importedCache = config.importedCache;
    this.importedWorld = new ImportedWorldQueue(config.importedCache?.world ?? new Map());

    let resolve!: (value: RunSettlement) => void;
    const promise = new Promise<RunSettlement>((res) => {
      resolve = res;
    });
    this.settledDeferred = { promise, resolve };

    this.state = {
      runId: this.runId,
      driver: this.driver,
      journal: this.journal,
      artifacts: this.artifacts,
      importedCache: this.importedCache,
      importedWorld: this.importedWorld,
      isRunSettled: () => this.runSettled,
      runError: () => this.runError(),
      failRun: (error) => this.failRun(error),
      record: (event) => this.record(event),
      nextOrdinal: (siteId) => this.nextOrdinal(siteId),
      holdForReplay: (instance, release) => {
        this.replaySettleOrder.hold(instance, release);
      },
      reportCount: () => this.reportCount,
      countReport: () => {
        this.reportCount++;
      },
      importClosed: () => this.importClosed,
      closeImport: () => {
        this.importClosed = true;
      },
      markSettled: (failure) => {
        this.runSettled = true;
        if (failure !== undefined) this.runFailure = failure;
        // The gate is permanently opened with settlement: all release actions still hanging on the sequence table will be released, otherwise the promises on the script side will be released.
        // Never fulfilled (the sandbox will be turned off, but the device running the script in the same process will hang).
        this.replaySettleOrder.open();
      },
      abortInFlight: (error, emitCancelled) => this.scheduler.abortInFlight(error, emitCancelled),
      resolveSettled: (settlement) => this.settledDeferred.resolve(settlement),
    };

    // caps is **readable** for the scheduler: setMaxConcurrency replaces this.caps entirely, and the dispatch criterion must see the new value
    // (See SchedulerHost.caps). The arrow closure instead of `this` in the object literal - the latter refers to the literal itself.
    const readCaps = (): Caps => this.caps;
    const host: SchedulerHost = {
      runId: this.runId,
      get caps(): Caps {
        return readCaps();
      },
      driver: this.driver,
      validate: this.validate,
      nextOrdinal: (siteId) => this.nextOrdinal(siteId),
      holdForReplay: (instance, release) => {
        this.replaySettleOrder.hold(instance, release);
      },
      record: (event) => this.record(event),
      isRunSettled: () => this.runSettled,
      runError: () => this.runError(),
      failRun: (error) => this.failRun(error),
      importCacheClosed: () => this.importClosed,
      wasLiveBeforeResume: (instance) => this.liveAskInstances.has(refToString(instance)),
      wasQueuedBeforeImportClose: (instance) =>
        this.queuedBeforeImportClose.has(refToString(instance)),
    };
    this.scheduler = new AskScheduler(host);

    const existing = this.journal.getRun(this.runId);
    if (existing === undefined) {
      // Revise run to start accounting from the cumulative value of the predecessor;
      // Brand new run is 0 if absent. The normalization (non-finite values and negative numbers are rounded to the nearest decimal place) is here: this number must fall
      // The `spent_tokens` column, the protocol schema requires non-negative integers, and this is pure data beyond the harness boundary - a NaN
      // It will poison the column value and the projected patch at the same time, so the dirty value must die before writing to the library, rather than dying in the projected patch verification.
      const inherited = config.inheritedTokens ?? 0;
      this.spentTokens = Number.isFinite(inherited) ? Math.max(0, Math.floor(inherited)) : 0;
      this.journal.createRun({
        runId: this.runId,
        caps: this.caps,
        spentTokens: this.spentTokens,
        status: "running",
        // Metadata is only saved when creating a run; incoming scripts and session fields are saved for recovery and script_hash verification.
        // name is the display metadata later added to the same path. Default fields remain absent (undefined keys are not implemented).
        ...(config.scriptText === undefined ? {} : { scriptText: config.scriptText }),
        // It actually participates in the same metadata path as scriptText, and is only written once when creating a run: resume is read back from here.
        // Replay never accepts new arguments given by the caller.
        ...(config.args === undefined ? {} : { args: config.args }),
        ...(config.name === undefined ? {} : { name: config.name }),
        ...(config.scriptHash === undefined ? {} : { scriptHash: config.scriptHash }),
        ...(config.parentSessionId === undefined
          ? {}
          : { parentSessionId: config.parentSessionId }),
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.toolCallId === undefined ? {} : { toolCallId: config.toolCallId }),
        // Lineage is also only written once when building a run: the revision is supersede (new run), and the predecessor line is zero-touched.
        ...(config.resumedFrom === undefined ? {} : { resumedFrom: config.resumedFrom }),
      });
    } else {
      // Preconditions for resume: The script must be the same byte by byte as when run was created. Hash
      // The inconsistency indicates that the caller reused the same runId with another script - the site id is the key of the journal, continue
      // The new script's site will be matched with the results of the old script. Reject **this resume** (thrown synchronously) instead of accepting it first
      // Then failRun: The latter will cover failed on a record that can still be resumed with the correct script.
      if (
        existing.scriptHash !== undefined &&
        config.scriptHash !== undefined &&
        existing.scriptHash !== config.scriptHash
      ) {
        throw new WorkflowError(
          "ScriptHashMismatch",
          `Cannot resume run ${this.runId}: its script changed (recorded hash ${existing.scriptHash}, ` +
            `got ${config.scriptHash}). Resume needs the byte-identical script; to run a revised ` +
            `script, start a new run with resume_from instead.`,
          { mismatch: { expected: existing.scriptHash, got: config.scriptHash } },
        );
      }
      // resume: The settlement sequence is resumed according to the own events of this run (this gate is part of the correctness of replay, not an observation surface:
      // The site serial number is based on the call arrival order, and the fan-out arrival order can only be reproduced in the first-born settlement order). Node rows are read only once,
      // The report count below shares it with product recovery.
      const nodes = this.journal.listNodes(this.runId);
      this.replaySettleOrder = recoverSettleOrder(this.journal, this.runId, nodes);
      // Report counts are restored by the number of rows in the journal for kind:"report"; usage is restored from records (continuous across lifetimes).
      this.reportCount = nodes.filter((n) => n.kind === "report").length;
      // Product status and reportCount are restored at the same time: id ownership (type, preset spec) and number of successful versions are all determined by
      // The journal line is derived so that version 3 after a crash recovery is still version 3 instead of counting back from 1.
      for (const node of nodes) {
        if (node.kind !== "artifact" || node.status !== "completed") continue;
        rememberArtifactRow(this.state, node.artifactId, node.result);
      }
      this.spentTokens = existing.spentTokens;
      // Revise the crash recovery of run: the import table is completely reconstructed, and "whether the door is closed" is not dropped into the database - accurate recovery from the event.
      if (this.importedCache !== undefined) {
        const recovered = recoverImportClosure(this.journal, this.runId);
        this.liveAskInstances = recovered.live;
        this.queuedBeforeImportClose = recovered.queuedBeforeClose;
        this.importClosed = recovered.closed;
      }
      this.journal.updateRunStatus(this.runId, "running");
    }
    this.record({ type: "run-started", runId: this.runId, caps: this.caps });
    // The anchor point is remembered only when run is created, and placed after run-started: the projection treats run-started as an entry creation event.
    // Anchor events just raise the water level for it (the default branch of the reducer).
    if (existing === undefined && config.launch !== undefined) {
      this.record(runLaunchedEvent(config.launch, config));
    }
    // Usage inherited (amend) or resumed (resume) is reposted here: projection treats `run-started` as
    // "Usage reset" (workflow-runs-started.ts peels off the settlement residual image of the previous life), so if it is not reissued, the card will be
    // The first live turn shows 0 before landing - and "this run has not been spent yet" is false. I don't have any live ask when
    // Even worse: the projection will stay stuck at 0 until the cold replay matches the uplink value.
    // Zero is not sent: reset itself has already said zero, and sending another one is a noise event that must be paid for every new run.
    if (this.spentTokens > 0) this.record({ type: "usage-updated", spentTokens: this.spentTokens });
  }

  /** The run settlement promise: fulfilled on completion / failure / cancellation. */
  get settled(): Promise<RunSettlement> {
    return this.settledDeferred.promise;
  }

  /** The current run state. */
  status(): RunStatus {
    return this.journal.getRun(this.runId)?.status ?? "running";
  }

  // ——————————————————————————————— Boundary A ———————————————————————————————

  /**
   * Creates an actor. The **effective name** is the `spec.name` after `normalizePersona` (a
   * persona.name overrides the name argument), and if non-empty it must be unique within this run —
   * a duplicate name makes the whole run fail loudly (DuplicateActorName).
   *
   * Why a run-level failure rather than renaming or warning: a named actor is the identity key for
   * amend-resume cache import, and any run is a potential predecessor of a future amendment, so a
   * duplicate name in a predecessor would make the import matching ambiguous. The rule therefore
   * applies to every run, not only amending ones. Anonymous actors (absent or the empty string) are
   * never checked and any number of them is legal — the cost has been ruled on: no cache
   * eligibility.
   *
   * **Replay safety**: the duplicate table is purely in memory and born with the engine instance. A
   * resume of a byte-identical script re-runs the same series of createActor calls from the start in
   * a **brand-new** engine instance, so each name is registered exactly once and the previous
   * round's own registration is not mistaken for a duplicate. That is also why it cannot be
   * journaled — a stored table would collide with itself on resume.
   *
   * **Attaching the import cache happens here too** (amend-resume): look up
   * `importedCache.actors` by effective name, and only if the persona matches after normalization
   * attach the candidate to the scheduler's actor state. The comparison happens at **runtime**
   * rather than statically at submit time against two scripts: names and personas are runtime values
   * (the arguments of `agent()` may be dynamic expressions), and a static comparison would be a
   * second source of truth — precisely what this package guards against everywhere (the verdict is
   * `matchImportedActor` in imported-cache.ts).
   */
  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId {
    this.assertRunning("createActor");
    const ordinal = this.nextOrdinal(siteId);
    const ref = { siteId, ordinal };
    const id = refToString(ref);
    const spec = normalizePersona(name, persona);
    const effectiveName = spec.name;
    if (effectiveName !== undefined && effectiveName !== "") {
      const claimed = this.actorNames.get(effectiveName);
      if (claimed !== undefined) {
        // assertRunning synchronization surface with the same attitude: createActor has no promise to reject, it can only throw.
        const err = new WorkflowError(
          "DuplicateActorName",
          `Subagent name "${effectiveName}" is used twice in this run (${claimed} and ${id}). ` +
            `A named subagent is the identity an amended re-run matches its cache by, so names must ` +
            `be unique; give this one its own name or drop the name to make it anonymous.`,
        );
        this.failRun(err);
        throw err;
      }
      this.actorNames.set(effectiveName, id);
    }
    this.scheduler.registerActor(ref, id, name, spec, matchImportedActor(this.importedCache, spec));
    // putActor is the replacement of the entire record, and sessionId / resolvedModel is the field owned by **driver**
    // (The former is written by ensureSession and the latter is written by the runtime factory on the host side). Here you must bring the existing value as it is.
    // Otherwise, when replay hits the same (siteId, ordinal), both will be erased.
    const existing = this.journal.getActor(this.runId, siteId, ordinal);
    this.journal.putActor({
      runId: this.runId,
      siteId,
      ordinal,
      name,
      persona: spec,
      sessionId: existing?.sessionId,
      resolvedModel: existing?.resolvedModel,
    });
    this.record({ type: "actor-created", actor: ref, name, persona: spec });
    return id;
  }

  ask(siteId: string, actorId: ActorId, instructions: string): Promise<unknown> {
    if (this.runSettled) return Promise.reject(this.runError());
    if (!this.scheduler.hasActor(actorId)) {
      // Unknown actor: The script/lowering contract was broken and the entire run failed loudly.
      const err = new WorkflowError("UnknownActor", `Unknown subagent handle: ${actorId}.`);
      this.failRun(err);
      return Promise.reject(err);
    }
    const spec = this.askSpecs.get(siteId);
    if (spec === undefined) {
      // The site table and schema synthesis come from the same compilation, so the miss can only be a wiring error (the two compilation products are
      // put together). `?? { typed: false }` will silently downgrade typed ask to untyped:
      // Do not register submit_result, use the last round of text as the result, and the schema verification disappears - a downgrade to
      // A type system that "results are always valid" is worse than no type system at all, so it's better to have the entire run fail loudly.
      const err = new WorkflowError(
        "MissingAskSpec",
        `Ask site ${siteId} has no spec: askSpecs is incomplete (compile output mismatch).`,
      );
      this.failRun(err);
      return Promise.reject(err);
    }
    return this.scheduler.admitAsk(siteId, actorId, instructions, spec);
  }

  /** World nodes (world-read / world-run): the method body is readWorld in engine-world.ts. */
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown> {
    return readWorld(this.state, siteId, op, args);
  }

  log(message: string): void {
    if (this.runSettled) return;
    this.record({ type: "log", message });
  }

  /**
   * Control flow passed a `phase("…")` marker (Boundary A's `enterPhase`). It has the same posture as
   * `log`: synchronous, returns nothing, a no-op after settlement, and **writes no journal row** —
   * a marker is not a site, so there is no `dwf_node` to write.
   *
   * The ordinal is counted by name, using its own table ({@link phaseOrdinals}): a phase name and a
   * site id never consume each other's ordinals (site-id stability).
   * **Every evaluation emits**: the second round of `for { phase("B"); ask }` is B's second entry;
   * if "same name as the current phase means no emit", the rounds of a single-phase loop body would
   * be lost. A resume re-runs and emits the prefix again — deduplication is deliberately absent
   * here (it would require the engine to read the event table), and the reducer folds it
   * monotonically as `rounds = max(rounds, ordinal)`.
   */
  enterPhase(name: string): void {
    if (this.runSettled) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const ordinal = (this.phaseOrdinals.get(trimmed) ?? 0) + 1;
    this.phaseOrdinals.set(trimmed, ordinal);
    // Subsequent examples of casting were all born at this stage.
    this.currentPhase = trimmed;
    this.record({ type: "phase-entered", name: trimmed, ordinal });
  }

  /** Publishes an intermediate result (Boundary A's `report`): the method body is publishReport in engine-report.ts. */
  report(siteId: string, item: unknown, artifactId?: string): void {
    publishReport(this.state, siteId, item, artifactId);
  }

  /**
   * Publishes a **content artifact** (`artifact.file` / `artifact.markdown`): the method body is
   * publishContentArtifact in engine-artifacts.ts.
   */
  publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef> {
    return publishContentArtifact(this.state, siteId, op, args);
  }

  /**
   * Declares a **preset artifact** (`artifact.chart` / `table` / `metrics` / `board`): the method
   * body is declarePresetArtifact in engine-artifacts.ts.
   */
  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void {
    declarePresetArtifact(this.state, siteId, op, args);
  }

  // —————————————————————— Externally driven run life cycle ——————————————————————

  /** The sandbox script successfully returns a top-level artifact and settles as completed: the method body is settleCompleted in engine-settlement.ts. */
  complete(artifact: unknown): void {
    settleCompleted(this.state, artifact);
  }

  /**
   * External stop: in-flight asks are aborted (the deferred is rejected with Cancelled and a
   * node-settled(cancelled) is emitted), and the run settles as `stopped(reason)`; already completed
   * journal entries are kept (resumable). All four reasons take the same path: `user` / `model`
   * (the initiator passed into the cancel entry), `interrupted` (a sandbox fault from the harness),
   * and `provider` (a deterministic model-side error reported by the driver through `stopRun`).
   * `error` is present only for the latter two. first-wins: once settled, calls are ignored. The
   * method body is settleStopped in engine-settlement.ts.
   */
  stop(reason: RunStopReason, error?: WorkflowError, supersededBy?: string): void {
    settleStopped(this.state, reason, error, supersededBy);
  }

  /**
   * External failure: the failure dual of complete. The harness uses it to file a child-process
   * `{complete, ok:false, error}` (the script threw), a child-process crash, a wall-clock timeout, an
   * NDJSON parse failure and the like as a run failure
   * rather than disguising them as a cancel — otherwise the journal's failure and the result the
   * caller sees would diverge.
   * It takes the internal failRun path: first-wins (against complete/cancel/internal failure), the
   * driver cancels in-flight asks, the journal run state becomes failed + failure_json, a run-failure
   * event is emitted, and the settled promise resolves as failed.
   */
  fail(error: WorkflowError): void {
    this.failRun(error);
  }

  /**
   * Changes this run's **own** concurrency ceiling in place.
   * An amendment carrying only `max_concurrency` acts on the live run: the same runId, no successor
   * minted, no supersede, and not one in-flight ask is dropped — that is the whole difference from
   * AmendWorkflow, and the only reason this exists.
   *
   * It returns **whether this call really changed anything**. Both no-ops return false and write
   * nothing to the store and emit no event: the run is already settled (a race between the host's
   * liveness check and this call — the caller falls back to a real amend on that basis), and the
   * new value equals the current one.
   *
   * When it does change, three things happen in the same synchronous step, so the three are always
   * consistent: the whole caps is swapped in (the scheduler reads it live),
   * `dwf_run.caps_max_concurrency` is written (a resume reuses the caps in the row; without this
   * write it would be restored to the old ceiling), and a `run-caps-changed` is recorded. A **raise**
   * additionally does one `pumpAll()` — the ceiling is read live before dispatch, but no other
   * event triggers a rescan, so queued asks would otherwise wait until the next settlement. A
   * lower does not recall in-flight asks: they run to completion as usual, and the ceiling only
   * governs "can one more still be let through".
   *
   * Clamping to `[1, ceiling]` is the caller's job — the ceiling is a host fact (the machine's core
   * count), which the engine neither sees nor should see. Only the persistence normalization is done
   * here, following the same discipline as `inheritedTokens` in the constructor: this number lands
   * in `caps_max_concurrency` (integer not null), and a single NaN would poison both the column
   * value and the dispatch criterion.
   */
  setMaxConcurrency(maxConcurrency: number): boolean {
    if (this.runSettled) return false;
    if (!Number.isFinite(maxConcurrency)) return false;
    const previous = this.caps;
    const next = Math.max(1, Math.floor(maxConcurrency));
    if (next === previous.maxConcurrency) return false;
    const caps: Caps = { maxConcurrency: next };
    this.caps = caps;
    this.journal.updateRunCaps(this.runId, caps);
    this.record({ type: "run-caps-changed", runId: this.runId, caps, previous });
    if (next > previous.maxConcurrency) this.scheduler.pumpAll();
    return true;
  }

  // ———————————————————————————— Boundary B (Upward return) ——————————————————————————

  askSubmitAttempted(instance: InstanceRef, payload: unknown): void {
    this.scheduler.submitAttempted(instance, payload);
  }

  askTurnEnded(instance: InstanceRef, finalText: string): void {
    this.scheduler.turnEnded(instance, finalText);
  }

  /**
   * In-ask progress observation: a **pure pass-through**,
   * with the same posture as askStats -> usage-updated — it does not change scheduling, does not
   * enter inputHash, and replay does not compare it. As with usage, a late observation arriving
   * after settlement only drops an event (there is no account to book here), and does not grow a
   * tail on an already finished run.
   */
  askProgress(instance: InstanceRef, progress: AskProgress): void {
    if (this.runSettled) return;
    this.record({ type: "node-progress", instance, ...progress });
  }

  askStats(instance: InstanceRef, stats: AskStats): void {
    this.scheduler.noteStats(instance, stats);
    this.spentTokens += stats.tokens;
    // Usage cannot be dropped into the database only once in createRun(0): accumulation without writing back will cause resume to restore zero usage.
    // It is persisted immediately after accumulation and earlier than the event - the event payload and the column value are generated in the same synchronization step, and they are always equal.
    this.journal.updateRunUsage(this.runId, this.spentTokens);
    // straggler stats arrived after settlement (the actual actor usage is not known until turn parsing, the last
    // ask's stats (always arrive later than complete/cancel) cannot send events as usual - events are appended after run-settled,
    // Downstream projection is not expected (run-settled must be the last event stream). Only accounting after settlement (usage line + noteStats
    // The node backfills are journal row updates, not events), and no more events will be sent. The account still needs to be credited: the run usage that can be resumed
    // Continuous across life cycles.
    if (this.runSettled) return;
    this.record({ type: "usage-updated", spentTokens: this.spentTokens });
  }

  askFailed(instance: InstanceRef, error: WorkflowError): void {
    this.scheduler.failed(instance, error);
  }

  /**
   * A deterministic model-side error: the node is not settled,
   * and the whole run stops as `stopped(provider)`. A call arriving after the run is settled is
   * ignored by the first-wins of `stop`.
   */
  stopRun(error: WorkflowError): void {
    this.stop("provider", enrichProviderStopPhase(error, this.instancePhases));
  }

  /** Run-level stall observation: it only records; a call arriving after the run is settled is ignored. */
  runStalled(info: RunStallInfo): void {
    if (this.runSettled) return;
    this.record({ type: "run-stalled", ...info });
  }

  // Three pure observations about adaptive concurrency: the engine only records,
  // Do not make any decisions based on them. run calls that arrive after the node has settled or the node has settled are ignored - that's a late observation,
  // Dropping the journal will only cause the tail of a completed run to grow.
  askWaiting(instance: InstanceRef, info: AskWaitInfo): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    this.record({ type: "node-waiting", instance, ...info });
  }

  askExecuting(instance: InstanceRef): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    this.record({ type: "node-executing", instance });
  }

  /**
   * The only driver observation the engine makes a decision on: the subagent of an in-flight ask is
   * about to rewrite the workspace => close the import cache. A late observation (run or node
   * already settled) is ignored, the same posture as the two above.
   */
  askMutating(instance: InstanceRef): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    closeImportCache(this.state, instance, "mutating-tool", this.scheduler.liveActorName(instance));
  }

  concurrencyChanged(change: ConcurrencyChange): void {
    if (this.runSettled) return;
    this.record({ type: "concurrency-changed", ...change });
  }

  // ———————————————————————————————— Internal ——————————————————————————————

  /** Run-level failure (first-wins): the method body is settleFailed in engine-settlement.ts. */
  private failRun(error: WorkflowError): void {
    settleFailed(this.state, error);
  }

  /**
   * The **only** minting point of a site ordinal (createActor / the first line of admitAsk / worldRead /
   * report / artifact all go through it synchronously), and therefore the only recording point of an
   * instance's birth phase: this line always executes in the same tick as the script call, whereas
   * the event need not — an ask's `node-queued` can be held off until after the next marker.
   */
  private nextOrdinal(siteId: string): number {
    const next = (this.ordinals.get(siteId) ?? 0) + 1;
    this.ordinals.set(siteId, next);
    if (this.currentPhase !== undefined)
      this.instancePhases.set(refToString({ siteId, ordinal: next }), this.currentPhase);
    return next;
  }

  private assertRunning(op: string): void {
    if (this.runSettled)
      throw (
        this.runFailure ??
        new WorkflowError("Cancelled", `Run already settled; ${op} is no longer accepted.`)
      );
  }

  private runError(): WorkflowError {
    return this.runFailure ?? new WorkflowError("Cancelled", "Run already settled.");
  }

  /**
   * Every event is both written to the journal (dwf_event, durable) and fanned out via driver.emit
   * (Boundary C, live).
   *
   * The single funnel for all events, and therefore where the birth phase is filled in
   * ({@link stampBirthPhase}). Both routes must receive the **same object**: bootstrap's
   * `createJournalSequenceCapture` checks the sequence number by reference equality.
   */
  private record(event: RunEvent): void {
    const stamped = stampBirthPhase(event, this.instancePhases);
    this.journal.appendEvent(this.runId, stamped);
    this.driver.emit(stamped);
  }
}

/** Persona normalization: a string is treated as the system prompt; a display name lands in persona.name. */ function normalizePersona(
  name: string | undefined,
  persona: string | PersonaSpec | undefined,
): PersonaSpec {
  const base: PersonaSpec =
    typeof persona === "string" ? { system: persona } : persona ? { ...persona } : {};
  if (base.name === undefined && name !== undefined) base.name = name;
  return base;
}
