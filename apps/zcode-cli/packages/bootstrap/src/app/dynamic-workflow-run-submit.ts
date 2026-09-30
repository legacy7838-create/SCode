// ============================================================
// Dynamic Workflow Run Service: three startup entrances (submit / amend / resume) and "compile once"
// ============================================================
// dynamic-workflow-run-service.ts reaches the upper limit of oxlint max-lines (400 lines), put `submit` /
// The two entries of `resume` together with their shared compileOnce / mintRunId are split into this file; the public side is still from
// dynamic-workflow-run-service.ts export. The two entrances have opposite directions and never share the same door (the file header invariant 1 there),
// But they share the same registration form, the same parking list and the same settlement bookkeeping - these three things
// {@link DynamicWorkflowRunEntryContext} is passed in explicitly from service. This file does not hold any state of its own.

import { createHash, randomUUID } from "node:crypto";
import type {
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
  TraceContext,
} from "@zcode/contracts";
import {
  buildAskSpecs,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  deriveActorSubmitProfilesFor,
  lowerWorkflow,
  synthesizeAskSchemas,
  type Caps,
  type CompileDiagnostic,
  type ImportedRunCache,
  type RunSettlement,
  type WorkflowProgram,
} from "@zcode/dynamic-workflow";
import { formatModelPickerValue } from "@zcode/shared/model-selection";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  buildImportedCache,
  preflightAmendImport,
  rebuildImportedCacheForResume,
} from "./dynamic-workflow-import.js";
import {
  launchDynamicWorkflowRun,
  type CompiledDynamicWorkflowScript,
} from "./dynamic-workflow-run-launch.js";
import {
  readRunLaunchAnchor,
  readRunScriptPath,
  readRunSubagentModel,
  resolveLaunchAnchor,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { isResumableRecord, type RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import { createWorkflowRunControl } from "./workflow-run-control.js";

/**
 * The service-internal state that both entry points need. All of it is a **reference**, not a
 * copy: the registry and the resident table are the service's own, `trackSettlement` is the
 * service's settlement bookkeeping (terminal states into entries, failure normalization,
 * settlement notifications), and `caps` is the ceiling computed on the submit path from the
 * concurrency probe of the moment (resume reuses the caps recorded in the journal, not this).
 */
export interface DynamicWorkflowRunEntryContext {
  deps: DynamicWorkflowRunServiceDeps;
  runs: Map<string, RunRegistryEntry>;
  escalations: WorkflowEscalationRegistry;
  /**
   * The caps for this launch. The argument is the **requested** concurrency ceiling (the
   * `max_concurrency` of `CreateWorkflow` / `AmendWorkflow`, already normalized by the tool layer
   * into a single number or absent): absent means the ceiling, present means clamp to [1, ceiling].
   */
  caps: (requestedMaxConcurrency?: number) => Caps;
  trackSettlement: (
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ) => Promise<RunSettlement>;
}

/** Body of `DynamicWorkflowRunPort.submit`: a brand-new run, no predecessor, no cache. */
export async function submitDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  request: DynamicWorkflowRunSubmitRequest,
): Promise<DynamicWorkflowRunSubmitResult> {
  const runId = startNewRun(ctx, {
    runId: mintRunId(),
    scriptText: request.scriptText,
    cwd: request.cwd,
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.args === undefined ? {} : { args: request.args }),
    ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    ...(request.launchInputId === undefined ? {} : { launchInputId: request.launchInputId }),
    ...(request.phaseNames === undefined ? {} : { phaseNames: request.phaseNames }),
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    ...(request.subagentModel === undefined ? {} : { subagentModel: request.subagentModel }),
    // The script file is in the same vehicle as the subagent model: download it as it is.
    // The port makes no inferences - whether a draft was written or not is a fact on the tool's side, and absence means there really is no document.
    ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
    ...(request.phaseAlongside === undefined ? {} : { phaseAlongside: request.phaseAlongside }),
    trace: request.trace,
  });
  return { ok: true, runId };
}

/**
 * Body of `DynamicWorkflowRunPort.amend`.
 *
 * The order is the entire semantics:
 *   1. **Pre-check** the predecessor (exists AND its bounds are complete) - on rejection nothing has moved, the predecessor runs on;
 *   2. Mint a new id;
 *   3. If the predecessor is in flight, cancel it with `{ superseded: newRunId }` and **await its own settlement promise** - no timeout, no journal polling; it therefore settles as `stopped(superseded, supersededBy)`;
 *   4. Boundedly wait for the aborted turn to finish its tail, then ask which sessions can be safely counted now - that alone decides how in-flight asks continue, the completed prefix's boundary being a journal fact (the full argument is in the comment further down);
 *   5. Build the cache from the settled predecessor - the pre-check already passed, so a rejection here can only be a host fault and is thrown upward;
 *   6. Launch along the same path as a brand-new submit, carrying `resumedFrom` and the cache.
 *
 * The old version let `submit({resumeFrom})` answer `not_amendable` for an in-flight predecessor,
 * forcing the model into three steps: TaskStop -> poll until stopped -> resubmit; this method
 * folds the stop and the settlement wait into the service, and the race disappears with it.
 */
export async function amendDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  request: DynamicWorkflowRunAmendRequest,
): Promise<DynamicWorkflowRunAmendResult> {
  const { deps, runs } = ctx;
  const preflight = preflightAmendImport(deps.journal, request.predecessorRunId);
  if (!preflight.ok) {
    deps.logger?.info?.("Dynamic workflow amend refused", {
      event: "dynamic_workflow.amend.refused",
      module: "bootstrap.app",
      predecessorRunId: request.predecessorRunId,
      reason: preflight.reason,
    });
    return { ok: false, reason: preflight.reason };
  }
  const predecessor = preflight.run;
  const runId = mintRunId();

  // In Feiju, look at the **registry of this process** instead of the journal status: journal says running but it is not in the registry, it is something else.
  // When the process (or dead process) runs, this service cannot be stopped or waited for - it will be processed as settled and let the final state gate built by the import speak.
  // (If it is not the final state, it is thrown away, see below).
  const live = runs.get(request.predecessorRunId);
  let supersededRunId: string | undefined;
  if (live !== undefined && live.terminal === undefined) {
    live.controller.abort({ superseded: runId });
    // Wait for the predecessor's own settlement promise (the same promise as waitForTask; trackSettlement guarantees that it will never reject).
    await live.settlement;
    supersededRunId = request.predecessorRunId;
    deps.logger?.info?.("Dynamic workflow run superseded by an amendment", {
      event: "dynamic_workflow.amend.superseded",
      module: "bootstrap.app",
      predecessorRunId: request.predecessorRunId,
      runId,
    });
  }

  // Gates of Silence.
  //
  // Root cause: `dispose()` is synchronous, and only one `state.turn.then(close, close)` is hung for the session that is still turning.
  // Instead of waiting for it; the engine resolves immediately after `cancelAsk` aborts the turn. So the above sentence `await live.settlement`
  // What is guaranteed is "the run is resolved", not "the aborted turn has finished writing its tail". Now let’s count the precursor sessions
  // The number of messages, maybe one less, or one message whose part has not yet been completed - and that number will become the continuation position
  // (`inFlight.messageBoundary`), used by the driver to truncate and copy. Completed prefixes are not listed here: their boundaries are
  // The ask is already journaled at settlement, and is a fact rather than an observation at the moment.
  //
  // So ask the driver "Which sessions have been silenced" and only continue the silenced sessions. **This is not using timeouts to cover up race conditions**:
  // A session that has not landed at this point will not be used as a silent continuation, it just cannot get `inFlight` - which is what it was before this feature.
  // Behavior (entire on-the-fly transcription discarded, ask restarted with full prefix). We would rather do one less optimization than take one optimization
  // Change the number of bars to truncate the transcript.
  //
  // Neither case waits for a second, because there is no doubtful number in either case:
  //   - This process does not have a live entry for this predecessor (already terminated, or a line left by a dead process) → without a driver, there is nothing.
  //     the session in which it was written;
  //   - The entire assembly has no transcription access interface → the number of entries cannot be counted at all, and `inFlight` cannot be generated (the same is required on the builder side)
  //     `messageCount` will be discussed later), waiting is in vain.
  // Both fall into the category of "absent = all silent" (see AmendImportOptions.quietSessions).
  const quietSessions =
    deps.actorTranscriptStore === undefined ? undefined : await live?.quiescence?.quietSessions();

  const built = await buildImportedCache(
    deps,
    request.predecessorRunId,
    quietSessions === undefined ? undefined : { quietSessions },
  );
  if (!built.ok) {
    // The pre-inspection has just passed: run exists and the boundaries are complete; it has been rejected until now and only the "precursor non-final state" is left - the registry says it is no longer flying.
    // The journal says it is still running (held by another process). This is not an input that can be changed by the model, and will be thrown up due to wiring faults.
    throw new Error(
      `dynamic workflow amend could not import from run ${request.predecessorRunId} after preflight: ${built.reason}`,
    );
  }

  // Usage starting point: **After precursor settlement** read the row again. The preflight one is a snapshot before stopping. Using it will miss the last few rounds of the front wheel drive.
  // Spend - Revise an on-the-fly run happens to be the most common use of this path. Unreadable lines are treated as 0 (the predecessor has just been cleared).
  const settledPredecessor = deps.journal.getRun(request.predecessorRunId);
  const inheritedTokens = settledPredecessor?.spentTokens ?? 0;
  // Actual parameters are only used when explicitly stated by the caller (GUI "Configuration" reruns the precursor's own script, see port field comments); tool path
  // If not passed, the revision will still take no actual parameters. When the predecessor has no arguments (inline script/old line) the entire field is absent.
  const inheritedArgs =
    request.inheritArgs === true && settledPredecessor?.args !== undefined
      ? settledPredecessor.args
      : undefined;

  startNewRun(ctx, {
    runId,
    scriptText: request.scriptText,
    cwd: request.cwd,
    inheritedTokens,
    // The display name follows the predecessor: revision is the next version of the same work. Changing the name in cards and notifications will only make users think it is another workflow.
    ...(request.name !== undefined
      ? { name: request.name }
      : predecessor.name === undefined
        ? {}
        : { name: predecessor.name }),
    ...(inheritedArgs === undefined ? {} : { args: inheritedArgs }),
    ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    ...(request.phaseNames === undefined ? {} : { phaseNames: request.phaseNames }),
    // The concurrency upper bound is not inherited from the predecessor: "If omitted, the predecessor will be used" is a three-state of **tool surface**, `AmendWorkflow`
    // resolveInput has normalized it to a number here or absent (absent = ceiling). If the port is inherited again,
    // "Unrestriction" (`null`) will never get here.
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    // The subagent model also does not inherit from the predecessor. It is the same argument as the upper concurrency bound above: "Omitting it means inheriting the predecessor" is the **tool surface**
    // Three-state, `AmendWorkflow`'s resolveInput has normalized it to a choice here or absence (absence = return
    // session model). If the port is inherited again, "return to the session model" (`null`) will never get here.
    ...(request.subagentModel === undefined ? {} : { subagentModel: request.subagentModel }),
    // Script files **never inherit from predecessor**: the revision records which file the script of this revision comes from (`path` submission is
    // That document, inline commit is the draft you just wrote). Following the path of the predecessor is equivalent to letting the model edit the old script next time.
    ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
    ...(request.phaseAlongside === undefined ? {} : { phaseAlongside: request.phaseAlongside }),
    trace: request.trace,
    imported: { cache: built.cache, resumedFrom: built.resumedFrom },
  });
  return { ok: true, runId, ...(supersededRunId === undefined ? {} : { supersededRunId }) };
}

interface StartNewRunInput {
  runId: string;
  scriptText: string;
  cwd: string;
  name?: string;
  args?: Record<string, unknown>;
  parentSessionId?: string;
  toolCallId?: string;
  launchInputId?: string;
  /** The phase table declared by the script (passed by both submit and amend: an amendment uses the phase table of the **new** script). */
  phaseNames?: string[];
  /** The requested concurrency ceiling; absent means the ceiling. Clamping happens in {@link DynamicWorkflowRunEntryContext.caps}. */
  maxConcurrency?: number;
  /**
   * The subagent model for this run. Absent means subagents run on the session model.
   * A structured selection comes in and is normalized into a picker string before it is stored -
   * see the comment in startNewRun.
   */
  subagentModel?: ModelSelection;
  /**
   * The absolute path of this run's script file. Absent means this
   * run has no editable script file. Purely model-facing metadata: it takes part neither in
   * execution nor in resume validation.
   */
  scriptPath?: string;
  /** The "concurrently running" table aligned with `phaseNames`; an index points into that very table, and the two always come and go together. */
  phaseAlongside?: number[][];
  trace: TraceContext;
  /**
   * The usage starting point for this run (the predecessor's `spentTokens` after settlement). Given on the amend path, absent for a brand-new submit (= 0).
   */
  inheritedTokens?: number;
  /** amend path: the lineage pointer and the import cache always appear as a pair. */
  imported?: { cache: ImportedRunCache; resumedFrom: string };
}

/**
 * The launch tail shared by submit and amend: compile -> anchor -> registry entry -> fire-and-forget
 * launch. Returns the runId (synchronously: the registry entry already exists before this function
 * returns, see the comment below).
 */
function startNewRun(ctx: DynamicWorkflowRunEntryContext, input: StartNewRunInput): string {
  const { deps, runs, escalations } = ctx;
  const { imported, runId } = input;
  const compiled = compileOnce(input.scriptText);
  // The clamped upper bound only counts **once**: it must both drop dwf_run.caps_max_concurrency with EngineConfig and be used as
  // A gapped copy of the registry entry (the only place getTask / getRunDetail can read before the journal line appears).
  // Counting twice is equivalent to having the two reading surfaces give different numbers at the moment the ceiling changes.
  const caps = ctx.caps(input.maxConcurrency);
  // Canonical string form (`providerId/modelId[$reasoningLevel]`). The port accepts structured selection, and the journal
  // The event, two reading surfaces and the progress load all require a string - they are normalized once here and transported throughout the downstream process.
  const subagentModel =
    input.subagentModel === undefined ? undefined : formatModelPickerValue(input.subagentModel);

  // Initiation anchor point: revision inherits from predecessor, direct activation uses explicit value, chat uses activity wheel,
  // If you don't have any, just cast one. When the engine is being run, remember it as run-launched.
  // The stage table declared by the script is merged side by side with the subagent model and anchor point of this run: the revised continuation uses the inputId of the predecessor,
  // However, it uses the stage table of **new script** and never inherits the model of the predecessor, so neither of them enter resolveLaunchAnchor.
  const launch: RunLaunch = {
    ...resolveLaunchAnchor({
      ...(input.launchInputId === undefined ? {} : { requested: input.launchInputId }),
      trace: input.trace,
      ...(deps.resolveLaunchInputId === undefined
        ? {}
        : { resolveLaunchInputId: deps.resolveLaunchInputId }),
      ...(imported === undefined
        ? {}
        : (() => {
            const predecessor = readRunLaunchAnchor(deps.journal, imported.resumedFrom);
            return predecessor === undefined ? {} : { predecessor };
          })()),
    }),
    ...(input.phaseNames === undefined ? {} : { phaseNames: input.phaseNames }),
    // Subagent models are placed side by side with the stage table (also without resolveLaunchAnchor: the revision never inherits the predecessor's model).
    // Zero SQL - it lives in this event, and there is no corresponding column on `dwf_run` (no migration is done on purpose).
    ...(subagentModel === undefined ? {} : { subagentModel }),
    // The script file is in the same car as the subagent model (also not included in resolveLaunchAnchor: the revision notes the file of the new script).
    // Zero SQL - it lives in this event and there is no corresponding column on `dwf_run`.
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    ...(input.phaseAlongside === undefined ? {} : { phaseAlongside: input.phaseAlongside }),
  };

  // Registration must precede startup: cancellation may arrive at any time after submit returns, and background trackers may
  // Start polling the snapshot immediately - the registry is the only synchronized fact that "run exists" (journal's dwf_run line
  // You have to wait for the engine to be constructed, which will be a few microtasks later).
  const controller = new AbortController();
  // The living control surface and the AbortController are created and entered at the same time (see RunRegistryEntry.control):
  // "Stop this run" and "Change a setting of this run" are two channels that should be available at the same moment, and both of them must be in
  // Exists before launch - retune may arrive in any microtask after submit returns.
  const control = createWorkflowRunControl();
  const entry: RunRegistryEntry = {
    controller,
    control,
    startedAt: new Date(),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    // The only source of project keys and tags that the enumeration can read before the journal line appears (see RunRegistryEntry).
    cwd: input.cwd,
    ...(input.name === undefined ? {} : { name: input.name }),
    scriptText: input.scriptText,
    // The effective concurrency upper bound (= the share that falls into the library). Same gap argument: resolveInput of `AmendWorkflow` reads
    // getTask determines "what to use", and revising a run that has just started will fall into this gap.
    maxConcurrency: caps.maxConcurrency,
    // A gapped copy of the subagent model, consistent with the concurrency upper bound (see RunRegistryEntry.subagentModel). Here it is
    // The **only** thing about "structured selection → canonical string" is that it is recorded as `run-launched`, and the two reads are the same as
    // This is what the `run-started` payload reads, so the format cannot be forked between the three places.
    ...(subagentModel === undefined ? {} : { subagentModel }),
    // A gapped copy of the script file, as in the subagent model (see RunRegistryEntry.scriptPath).
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    ...(imported === undefined ? {} : { resumedFrom: imported.resumedFrom }),
    // The gap copy of the usage starting point is the same as the concurrency upper bound: before the journal line falls, the two reading surfaces can only read the usage from the entry.
    // And revising a just-started run happens to fall into those few microtasks - reporting 0 will cause the details to say "This lineage costs nothing."
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // The actual settlement promise is replaced below; a placeholder is taken first to satisfy the type (sync visible).
    settlement: Promise.resolve<RunSettlement>({ status: "stopped", reason: "user" }),
  };
  runs.set(runId, entry);

  // fire-and-forget: Never await settlement in submit. The contract of submit is "start and hand over runId".
  entry.settlement = ctx.trackSettlement(
    runId,
    entry,
    launchDynamicWorkflowRun({
      caps,
      compiled,
      cwd: input.cwd,
      deps,
      // name is in the same metadata path as scriptText / cwd: launch → harness is transferred to EngineConfig as is,
      // The engine drops dwf_run.name on createRun. The service side deliberately does not do the second UPDATE - then
      // Makes the second writer of dwf_run (same argument for file header invariant 1).
      ...(entry.name === undefined ? {} : { name: entry.name }),
      // The actual parameters follow the same metadata path: launch → harness → EngineConfig (fall args_json) + spawn
      // payload (the args global injected into the sandbox). Inline scripts have no arguments and fields are completely absent.
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(entry.parentSessionId === undefined ? {} : { parentSessionId: entry.parentSessionId }),
      escalationRegistry: escalations,
      control,
      runId,
      scriptText: input.scriptText,
      signal: controller.signal,
      ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
      // The session silence probe is backfilled to the entry: when this run is revised in the future, that amend will ask it
      // (quietSessions of dynamic-workflow-import.ts). All three entrances are connected, because which run will become
      // The precursor is something that will only be known in the future.
      onQuiescenceProbe: (probe) => {
        entry.quiescence = probe;
      },
      // The lineage pointer and the cache table are downloaded in pairs (launch → harness → EngineConfig): the former falls into dwf_run
      // resumed_from (createRun is written once), the latter only lives in this execution.
      ...(imported === undefined
        ? {}
        : { importedCache: imported.cache, resumedFrom: imported.resumedFrom }),
      // The usage starts from the same path (launch → harness → EngineConfig): the engine writes the initial value of spent_tokens according to it.
      ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
      // The subagent model doesn't just go all the way: it's in launch (see RunLaunch above), along with a `run-launched`
      // After entering the journal, the launch side takes it out from the same object and parses it into a selection and hands it to the actor runtime factory.
      launch,
    }),
  );

  return runId;
}

/** Body of `DynamicWorkflowRunPort.resume`. */
export async function resumeDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  runId: string,
): Promise<DynamicWorkflowRunResumeResult> {
  const { deps, runs, escalations } = ctx;
  const record = deps.journal.getRun(runId);
  if (record === undefined) return { ok: false, reason: "not_found" };
  // in-process In flight, the runId: journal status is running, which is not recoverable; the single column reason is
  // Because it and "irrecoverable final state" are different actions for the caller (wait for it to resolve vs. give up).
  const live = runs.get(runId);
  if (live !== undefined && live.terminal === undefined) {
    return { ok: false, reason: "already_running" };
  }
  // The revised run single-column reason: and "irrecoverable final state" are different actions for the caller (see follow-up vs abandon).
  if (record.status === "stopped" && record.stopReason === "superseded") {
    return { ok: false, reason: "superseded" };
  }
  if (!isResumableRecord(record)) return { ok: false, reason: "not_resumable" };
  // scriptText is dropped from workflow-live-run; earlier records do not have rerunable scripts.
  if (record.scriptText === undefined) return { ok: false, reason: "script_missing" };

  // The original text of the journal of the old run was written according to the facade at that time. After reconstruction,
  // May no longer pass type checking. compileOnce is a hard fail for dirty scripts (that's a miswired channel), resume hits it but
  // A user-predictable business branch - structured rejection + bounded diagnosis, UI / TUI / tool surface points to AmendWorkflow accordingly,
  // Rather than a generalized "execution failure". Diagnosis and subsequent compilation share the same Program and are still "compile once".
  const workflow = createWorkflowProgram(record.scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) {
    deps.logger?.warn?.("Dynamic workflow resume refused: stored script no longer compiles", {
      diagnosticCount: diagnostics.length,
      event: "dynamic_workflow.resume.compile_failed",
      module: "bootstrap.app",
      runId,
    });
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedResumeDiagnostics(runId, diagnostics),
    };
  }
  const compiled = compileProgram(record.scriptText, workflow);
  // Server-side priori (the engine is still verified twice during construction, defense depth): the record itself has been overwritten by an external force (scriptText and
  // scriptHash is no longer self-consistent), the registry entry will not be created and will not be started - a synchronization error on the engine side will record the entry as
  // failed final state, covering up the fact that "the record can still be repaired".
  if (record.scriptHash !== undefined && record.scriptHash !== compiled.scriptHash) {
    deps.logger?.warn?.("Dynamic workflow resume refused: script hash mismatch", {
      event: "dynamic_workflow.resume.script_hash_mismatch",
      expected: record.scriptHash,
      got: compiled.scriptHash,
      module: "bootstrap.app",
      runId,
    });
    return { ok: false, reason: "script_mismatch" };
  }

  // Revised resume of run: rebuild import cache.
  // Consumed hits are true in the journal of this run and are replayed as usual; unconsumed imports only live in memory.
  // If you don't rebuild, it will become a live rerun in this continuation run. Reconstruction and commit-time construction are the same pure function that reads the same precursor.
  // journal, so the certainty is established - the engine re-pushes the divergence point according to the record line of this run (imported-cache.ts
  // reconcileRecorded), so the two sides are not misaligned.
  //
  // **Reconstruction failure will never bring down resume**: The precursor journal is the survival dependency of the revision run, but it is only an acceleration structure——
  // It becomes expensive if you lose it, but it’s not wrong. When the precursor is cleared/the boundary gate is no longer passed, it will start without cache as usual, and unconsumed imports will degrade into
  // live re-executes, while run's own journal lines are still replayed one by one.
  const rebuilt =
    record.resumedFrom === undefined
      ? undefined
      : await rebuildImportedCacheForResume(deps, {
          predecessorRunId: record.resumedFrom,
          runId,
        });

  // Replace registry entries: same runId, new AbortController, new settlement promise - cancel will be available from now on.
  // Must precede launch (header invariant 5: entry is a prerequisite for watcher).
  const resumedSubagentModel = readRunSubagentModel(deps.journal, runId);
  const resumedScriptPath = readRunScriptPath(deps.journal, runId);
  const controller = new AbortController();
  // Same as submit method: new entry = new AbortController + new control plane. The handle of the previous life is tied to the one that has been settled.
  // engine, leaving it in will let retune speak to a dead engine.
  const control = createWorkflowRunControl();
  const entry: RunRegistryEntry = {
    controller,
    control,
    startedAt: new Date(),
    // The effective concurrency upper bound of this run: **resume route is subject to journal behavior** (an in-place retune has already written the new value into
    // `caps_max_concurrency`, so the one in the row is the upper bound to run in this life). The entry is copied so that
    // `retuneConcurrency` has only one rule with two reading surfaces - there are entries reading entries.
    maxConcurrency: record.caps.maxConcurrency,
    ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
    ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
    // Gap metadata for the enumeration side (see RunRegistryEntry): the resume authority is in the journal record,
    // Here is just a memory copy of the same fact. cwd has the same origin as the value of launch below.
    cwd: record.cwd ?? process.cwd(),
    ...(record.name === undefined ? {} : { name: record.name }),
    scriptText: record.scriptText,
    // Subagent model: Read the event header once and copy the entry (see RunRegistryEntry.subagentModel). It’s worth building and running that life
    // Just write it down on `run-launched`, and the run will remain unchanged for the rest of its life, so copying it will not branch from the event; after copying it, there will be two readings
    // There is only one rule left - read the entries if there are entries, and scan the events only if you are cold.
    ...(resumedSubagentModel === undefined ? {} : { subagentModel: resumedSubagentModel }),
    // Script file: The same reading and the same argument as the sub-agent model (build run and write it to death in that life, and it will remain unchanged in the rest of your life. It will not work if you copy it.
    // fork with events). After resume, the two reading pages are still "there are entries to read entries".
    ...(resumedScriptPath === undefined ? {} : { scriptPath: resumedScriptPath }),
    settlement: Promise.resolve<RunSettlement>({ status: "stopped", reason: "user" }),
  };
  runs.set(runId, entry);

  entry.settlement = ctx.trackSettlement(
    runId,
    entry,
    launchDynamicWorkflowRun({
      // Caps follows the journal record: spentTokens are accumulated against this set of caps.
      // To recalculate is to quietly move the goalposts.
      caps: record.caps,
      compiled,
      cwd: record.cwd ?? process.cwd(),
      deps,
      ...(record.name === undefined ? {} : { name: record.name }),
      // resume **replays** the saved arguments and never accepts new ones: the identity of a run includes its arguments,
      // This is the same rule as "only valid for byte-identical scripts". The resume entry deliberately has no actual parameters.
      // So the only source here is the journal record; there are no old rows for this column (absent → sandbox
      // Pronounced `{}`). Changing actual parameters = a new run = a new confirmation window.
      ...(record.args === undefined ? {} : { args: record.args }),
      // The sub-agent model is not downloaded either: it lives with the anchor `run-launched`, and the run version is programmed to death, and the launch side
      // Read back from the event header of the journal yourself (the same read that copied the entry above). Same discipline as caps / args
      // ——The identity of a run includes the model on which it is run. Resume replays the saved copy and never accepts new ones.
      ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
      // Both portals share the same docking table (see field notes above).
      escalationRegistry: escalations,
      // The control surface is different from the parking table: **Build one** for each entrance (it is tied to the engine of this life and the seat gate of this life).
      control,
      runId,
      scriptText: record.scriptText,
      signal: controller.signal,
      ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
      // The same thing as submit / amend: the resumed run may still become the precursor to the next revision.
      onQuiescenceProbe: (probe) => {
        entry.quiescence = probe;
      },
      // resumedFrom will no longer be downloaded: createRun has been written to death as early as submission, and the engine hits the existing file on the resume path.
      // OK, don’t use createRun at all. Only the rebuilt cache needs to be deleted.
      ...(rebuilt === undefined ? {} : { importedCache: rebuilt }),
    }),
  );

  return {
    ok: true,
    runId,
    ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
  };
}

/**
 * Compile exactly once: one ts.Program feeds the site table, the schema synthesis and the lowering
 * at the same time.
 *
 * A dirty script hard-fails here and **does not create a run**: the handler only calls submit on
 * `ok`, so a dirty script that gets here can only be a wiring bug. The defensive check reads the
 * program diagnostics from that same compile instead of spinning up a second Program (which would
 * break "compile once"). resume recompiles the original text from the journal with the same
 * function - a byte-identical script necessarily passes the same checks again.
 */
function compileOnce(scriptText: string): CompiledDynamicWorkflowScript {
  return compileProgram(scriptText, createWorkflowProgram(scriptText));
}

/** The cap on diagnostics in the resume rejection text (the same order of magnitude as the compile_failed of a hub-launched run). */
const RESUME_DIAGNOSTICS_MAX_CHARS = 2000;

/** Human-readable diagnostics for compile_failed: one `L:C message` per line, bounded overall. */
function boundedResumeDiagnostics(runId: string, diagnostics: CompileDiagnostic[]): string {
  const body = [
    `The stored script of run ${runId} no longer compiles against the current workflow facade:`,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > RESUME_DIAGNOSTICS_MAX_CHARS
    ? `${body.slice(0, RESUME_DIAGNOSTICS_MAX_CHARS - 1)}…`
    : body;
}

/**
 * The second half of compileOnce: site table / schema synthesis / lowering over the
 * **already-built** Program. resume first takes the diagnostics from that same Program and then
 * hands over here, so it is still "compile once" (a Program caches its own diagnostics; re-reading
 * them recomputes nothing).
 */
function compileProgram(
  scriptText: string,
  workflow: WorkflowProgram,
): CompiledDynamicWorkflowScript {
  const diagnostics = [
    ...workflow.program.getSyntacticDiagnostics(),
    ...workflow.program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script that does not typecheck (${diagnostics.length} diagnostics); no run was created`,
    );
  }

  const table = collectSites(workflow);
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table);
  if (schemaDiagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with unsupported ask result types: ${schemaDiagnostics
        .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  // The command set of world.run is collected in the same compilation (authorization surface: compile-time literal + confirmation window display + driver verification).
  // The non-literal cmd has been blocked in the analyze stage of the handler; here, there is still a wiring error, and the hard failure does not build the run.
  const worldRun = collectWorldRunCommands(workflow, table);
  if (worldRun.diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with non-literal world.run commands (${worldRun.diagnostics.length} diagnostics); no run was created`,
    );
  }

  // buildAskSpecs is the only correct construct for askSpecs: untyped site explicit notation {typed:false}.
  // Using schemas keys to construct will make the untyped site completely absent, and the engine will hard-fail the absence as a wiring error.
  const askSpecs = buildAskSpecs(table, schemas);

  return {
    askSpecs,
    // submit profile for each actor site: in the same
    // Explain on Program + site map projection (analyzeWorkflowScript has already analyzed the same text in the analyze phase of the handler.
    // After running these two steps), it is still "compile once". resume recalculates byte-identical text using the same function, deterministically.
    actorSubmitProfiles: deriveActorSubmitProfilesFor(workflow, table, askSpecs),
    declaredRunCommands: new Set(worldRun.commands),
    lowered: lowerWorkflow(workflow, table).code,
    // The ownership of scriptHash is here, not in the harness. harness collects scriptText and lowered at the same time,
    // And deliberately not verify whether the two are self-consistent - verification is equivalent to running the compilation again, which is what "compile once" should omit.
    // (harness.ts writes this as an invariant for the caller). So the hash must be calculated on the author's original text:
    // If you let the harness hash the text it sees, the lowered path will be the hash of the lowered function body.
    // And resume compares the original text of the author - the comparison object will be silently misaligned. This function is produced simultaneously from the same compilation
    // Lowered and hash are structurally consistent.
    scriptHash: createHash("sha256").update(scriptText, "utf8").digest("hex"),
  };
}

/**
 * The run id. The character set must be safe: it goes into actor session ids, URLs, file paths
 * and logs, so only `[A-Za-z0-9-]` is used (exactly randomUUID's alphabet) and never `#`/`@`/`/`.
 */
function mintRunId(): string {
  return `dwfrun-${randomUUID()}`;
}
