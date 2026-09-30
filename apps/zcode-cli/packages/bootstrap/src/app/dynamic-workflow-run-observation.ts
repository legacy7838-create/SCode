// ============================================================
// Observation surface assistance of Dynamic Workflow Run (read-only half of run service)
// ============================================================
// Composition rules for snapshots/lists/details. Unpacked from dynamic-workflow-run-service.ts: the service file carries the entrance and gate,
// This file carries the pure synthesis rules of "registry + journal → external reading" (no I/O, no state).

import type { DwfRunListItem, DwfRunSessionListItem } from "@zcode/adapters/storage";
import {
  boundDynamicWorkflowRunEventPayload,
  type DynamicWorkflowRunError,
  type DynamicWorkflowRunLogEntry,
  type DynamicWorkflowRunPendingQuestion,
  type DynamicWorkflowRunSessionSummary,
  type DynamicWorkflowRunSnapshot,
  type DynamicWorkflowRunStopReason,
  type DynamicWorkflowRunSummary,
} from "@zcode/contracts";
import type {
  JournalStorePort,
  NodeRecord,
  RunRecord,
  RunSettlement,
  RunStatus,
  RunStopReason,
  StoredEvent,
  WorkflowErrorCode,
  WorkflowErrorJson,
} from "@zcode/dynamic-workflow";
import { artifactsOf } from "./dynamic-workflow-run-artifact-projection.js";
import { runLineageActiveMs } from "./dynamic-workflow-run-elapsed.js";
import { readRunScriptPath, readRunSubagentModel } from "./dynamic-workflow-run-launch-anchor.js";
import { resolveDynamicWorkflowRunLabel } from "./dynamic-workflow-run-label.js";
import { lineageFields, supersededByOf } from "./dynamic-workflow-run-lineage.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import type { WorkflowRunControl } from "./workflow-run-control.js";

/**
 * Artifact merging lives in dynamic-workflow-run-artifact-projection.ts (this file is up against oxlint's 400-line cap).
 * Re-exported as-is rather than making each of the four call sites change its import: what they are looking for is "the observation surface", while this split is a result of the line-count constraint, not a change of boundary -- turning it into a cross-module rename would only make git blame point at a commit unrelated to the intent.
 */
export { artifactsOf };

/** A registry entry: a run that is in flight or settled recently. */
export interface RunRegistryEntry {
  controller: AbortController;
  startedAt: Date;
  toolCallId?: string;
  parentSessionId?: string;
  /**
   * In-memory copies of three pieces of submit-time metadata, serving only the **submit -> createRun microtask gap**: at that
   * moment the journal has no row yet, while the enumeration surface must be able to filter this run by project (cwd) and derive a label (name /
   * the script's first line). Once the row appears, the journal is authoritative for all three and the in-memory copies are no longer read.
   */
  cwd: string;
  name?: string;
  scriptText: string;
  /**
   * The concurrency ceiling actually in effect for this run (an in-memory copy of `dwf_run.caps_max_concurrency`, argued the same gap way).
   * submit / amend write the value, **resume does not** -- that path reuses the caps recorded in the journal, and its row was there long ago.
   */
  maxConcurrency?: number;
  /**
   * The live control surface of this run. It sits alongside
   * {@link controller} rather than merging with it: that one is the only channel for "stop this run", this one is the only channel for "change one
   * setting of this run", and their recipients (the harness's signal / the engine and the seat gate) are not even the same.
   *
   * All three entry-creating paths create one (submit / amend / resume), and launch connects both of its ends. The entry is present, yet the handle's
   * `setMaxConcurrency` returns false, which means "the run settled between those two steps" -- `retuneConcurrency` accordingly
   * returns `not_live`.
   */
  control?: WorkflowRunControl;
  /**
   * The subagent model of this run (an in-memory copy of the canonical picker string on the `run-launched` event,
   * `providerId/modelId[$reasoningLevel]`).
   * The same gap argument: `AmendWorkflow`'s resolveInput reads the snapshot to decide "what to keep using", while amending a run that
   * has just started happens to land in those few microtasks between submit and the engine recording the event.
   *
   * **All three entry-creating paths write the value**: submit / amend use the string just normalized, resume copies it over from the event header once.
   * The value is frozen in the generation that created the run and never changes for the rest of its life, so the copy and the event cannot
   * diverge -- the reading surface is therefore left with a single rule: if there is an entry, read the entry; only a cold row (this process
   * has no entry) scans the events. Absent means the subagent runs on the session model.
   */
  subagentModel?: string;
  /**
   * The script file of this run (an in-memory copy of that absolute path on the `run-launched` event). It follows exactly the same rules line by line as {@link subagentModel}:
   * all three entry-creating paths write the value (submit / amend use the one given in the arguments, resume copies it over from the event header once),
   * the value is frozen in the generation that created the run and never changes afterwards, so the copy and the event cannot diverge. Absent means this run has no file.
   */
  scriptPath?: string;
  /** The predecessor of an amended run (an in-memory copy of `dwf_run.resumed_from`, the only place the enumeration surface can read it before the journal row appears). */
  resumedFrom?: string;
  /**
   * The usage starting point of this run (`spentTokens` after the predecessor settled). The same gap argument: before the row is persisted, both reading surfaces can only read usage from the entry, while amending
   * a run that has just started happens to land in those few microtasks. **Only the amend path writes the value**: a fresh submit starts the account at zero,
   * and resume's row was there long ago.
   */
  inheritedTokens?: number;
  /**
   * The **session quiescence probe** this run's driver handed over (workflow-driver-quiescence.ts). It is filled in when the driver is
   * constructed, so a freshly created entry does not have it yet -- in that gap this run has not even created a single actor session, so there is nothing to ask it about.
   *
   * The only reader is amend: after superseding an in-flight predecessor it first has to confirm that those sessions have finished writing before it can
   * pick up that unfinished ask (`inFlight`). The probe's ownership lives on this entry -- one per run, born and dying with the driver,
   * with no separate process-level registry.
   */
  quiescence?: ActorSessionQuiescence;
  /** The settlement promise; waitForTask awaits it. That is where the fire-and-forget chain hangs. */
  settlement: Promise<RunSettlement>;
  /** The terminal state once settled (artifacts/errors live only here; the journal does not store the script's return value). */
  terminal?: RunSettlement;
  completedAt?: Date;
  /**
   * We have already logged once for this entry that "the journal row is a foreign terminal state" (see the priority note in {@link synthesizeRunStatus}).
   * The tracker polls once per second; without this flag the same warn would be emitted once per second.
   */
  foreignTerminalLogged?: true;
}

/**
 * The set of terminal states of a run (excluding pending / running).
 * This is the **single authority** on "what counts as terminal": the SQL on the journal side only does an index-friendly pre-filter, and before
 * convergence it judges once more against this set, so that when a non-terminal state is added in the future only this place has to change.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "errored",
  "stopped",
]);

/**
 * Synthesizes a snapshot from the journal record + the live registry. Returns undefined when neither has that run (the layer above normalizes that to lost).
 *
 * `pendingQuestions` is projected by the caller from the **in-memory** escalation park table and passed in (this file's discipline is no I/O,
 * no state). Passing an empty array means "there are no questions awaiting an answer right now" and the field is absent entirely -- an empty array is never sent.
 *
 * `concurrencyCeiling` is likewise supplied by the caller (reading it probes the process's core count = I/O): absent means "this read does not
 * judge a ceiling", and `maxConcurrency` is left out as a whole -- see {@link runConcurrencyField}.
 */
export function snapshotOf(
  taskId: string,
  runs: Map<string, RunRegistryEntry>,
  journal: JournalStorePort,
  pendingQuestions: readonly DynamicWorkflowRunPendingQuestion[] = [],
  concurrencyCeiling?: number,
): DynamicWorkflowRunSnapshot | undefined {
  const entry = runs.get(taskId);
  const record = journal.getRun(taskId);
  if (entry === undefined && record === undefined) return undefined;

  // The only implementation of state synthesis (see {@link synthesizeRunStatus}). The vocabulary of the snapshot surface is not pending.
  // So fold in the last step: runStatusToTaskStatus reports pending and running together as running——
  // This is exactly the existing behavior of "running in the registry" (without it, the run that was just submitted will be judged as lost in the first poll).
  const status: DynamicWorkflowRunSnapshot["status"] = runStatusToTaskStatus(
    synthesizeRunStatus(entry, record?.status),
  );

  // The node line is scanned only once, and reports and artifacts are shared (both only take the count in the final state, see their respective comments).
  // Respectively, listNodes means decoding the entire list of a 256-node run twice.
  const nodes = status === "running" ? undefined : journal.listNodes(taskId);

  // activity duration of lineage:
  // Same finality gate, same argument as nodes - its only consumer is finality notifications, and snapshots are polled repeatedly by background trackers.
  const activeDurationMs = status === "running" ? undefined : runLineageActiveMs(journal, taskId);

  // true final state + stop reason + structured failure: Snapshot base class
  // `status` is a common vocabulary for background task trackers (stopped is folded into canceled, errored is folded into failed), notification
  // To tell the truth, you can only read these three fields. It is not taken before the final state (there is no ending to say yet).
  const runStatus = synthesizeRunStatus(entry, record?.status);
  const terminal = TERMINAL_RUN_STATUSES.has(runStatus);
  const stopReason = terminal ? stopReasonOf(entry, record) : undefined;
  const failure = terminal ? terminalErrorField(runStatus, entry, record).error : undefined;
  const error = failure?.message;
  // Attribution: AmendWorkflow
  // resolveInput reads the snapshot to determine "whether it is the run of this session"; see lineageFields for pointers at both ends of lineage.
  const parentSessionId = entry?.parentSessionId ?? record?.parentSessionId;

  return {
    runId: taskId,
    taskId,
    startedAt: entry?.startedAt ?? new Date(0),
    status,
    ...(terminal ? { runStatus } : {}),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...lineageFields(entry?.resumedFrom ?? record?.resumedFrom, supersededByOf(entry, record)),
    // The memory copy takes precedence over the journal, which is the same as for each gap field above: in the microtasks of submit → createRun
    // The row doesn't exist yet, and AmendWorkflow's resolveInput happens to read this snapshot at that time.
    ...runConcurrencyField(
      entry?.maxConcurrency ?? record?.caps.maxConcurrency,
      concurrencyCeiling,
    ),
    // Subagent model: **If there is an entry, read the entry** (the three paths to create an entry are all invalid, see RunRegistryEntry.subagentModel),
    // Only cold runs—this process has no entries—scan the event header (a bounded scan of eight entries, not the entire journal).
    // It does not have the criterion of "whether it is worth mentioning" like the concurrency upper bound: it only exists when the user explicitly sets it, and the presence itself is everything.
    // information. Absent is running on the session model.
    ...runSubagentModelField(
      entry === undefined ? readRunSubagentModel(journal, taskId) : entry.subagentModel,
    ),
    // Script file: It is the same as the sub-agent model one by one (if there is an entry, read the entry, and only scan the event header once when it is cold), the same
    // "Only present if you have a demerit." The final notification says the next step is to "edit that file in place", so the snapshot must take it with it.
    ...runScriptPathField(
      entry === undefined ? readRunScriptPath(journal, taskId) : entry.scriptPath,
    ),
    ...(failure === undefined ? {} : { failure }),
    ...(activeDurationMs === undefined ? {} : { activeDurationMs }),
    ...(entry?.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
    ...(error === undefined ? {} : { error }),
    // When there are zero entries, the entire field is absent (same as reports): The reading side makes the entire pending area disappear based on this, and does not render empty sections.
    ...(pendingQuestions.length === 0 ? {} : { pendingQuestions }),
    ...reportsOf(nodes),
    // User-facing products. ⚠ with the immediate `output`
    // (`entry.terminal.artifact` = the top-level return value of the script, also called artifact inside the engine) are **two different things**:
    // Here is the output of the script via `artifact.*` for the user to see, and there is the return value for the model to see.
    ...(nodes === undefined ? {} : artifactsOf(taskId, journal, nodes)),
    ...(entry?.terminal?.status === "completed"
      ? { output: entry.terminal.artifact }
      : // After restarting, the registry of this process is empty, and the products can only be obtained from the journal record (journal line
        // result_json). The memory final state takes priority in the previous one - it is the original value that this process just took over from the engine.
        record?.status === "completed" && record.result !== undefined
        ? { output: record.result }
        : {}),
  };
}

/**
 * `maxConcurrency` on the two reading surfaces (the `getTask` snapshot and the `getRunDetail` detail view)
 *
 * **Present only when it is below the current ceiling**: a run running at the ceiling has nothing to say -- it simply is the default behavior, and giving every row
 * a number equal to the default would only make the model read "no limit was set" as "a limit was set". When the ceiling is absent (the caller did not supply one) the
 * field is likewise left out entirely: with no criterion at all, reporting a number is guessing.
 *
 * One implementation shared by both reading surfaces: if each judged on its own, "does equality with the ceiling count as present" would eventually diverge during some future tuning pass.
 */
export function runConcurrencyField(
  applied: number | undefined,
  ceiling: number | undefined,
): { maxConcurrency?: number } {
  if (applied === undefined || ceiling === undefined || applied >= ceiling) return {};
  return { maxConcurrency: applied };
}

/**
 * `subagentModel` on the two reading surfaces (the `getTask` snapshot and the `getRunDetail` detail view)
 *
 * The rule is a single one: **present only if it was set**. Unlike {@link runConcurrencyField}, there is no comparable default here --
 * "runs on the session model" is not a string that can be written into this field, and filling in the current session model would make the reading side
 * read "not set" as "set, and it happens to equal the session model", and those two mean different things in amend's tri-state.
 *
 * One implementation shared by both reading surfaces, argued exactly the same way as the concurrency ceiling.
 */
export function runSubagentModelField(subagentModel: string | undefined): {
  subagentModel?: string;
} {
  return subagentModel === undefined ? {} : { subagentModel };
}

/**
 * `scriptPath` on the two reading surfaces. The rule is word for word the same as
 * {@link runSubagentModelField}: **present only if it was recorded**, and there is no comparable default -- "this run has no
 * script file" is not a path that can be written into this field, and filling in a guessed path would send the model off to edit a file unrelated to this
 * run. One implementation shared by both reading surfaces.
 */
export function runScriptPathField(scriptPath: string | undefined): { scriptPath?: string } {
  return scriptPath === undefined ? {} : { scriptPath };
}

/**
 * `reports` on a terminal snapshot: the journal's `kind = "report"` node rows (written once, always `completed`,
 * with the reported item right on `result`), in insertion order = reporting order.
 *
 * Why read from the journal instead of the projection: `workflowRuns.reports` is a bounded memory-only display surface
 * (empty after cold recovery), whereas these rows are the **durable home** of those entries. Completion notifications have to carry artifacts on failed / cancelled too --
 * a run that died on the 12th ask still did the work of 11 asks, and retrieving them is exactly the reason `report`
 * exists -- so what it reads must be the durable copy.
 *
 * Read only in a **terminal** state: `getTask` is polled repeatedly by the background tracker, and `listNodes` is a full table scan (a run with
 * 256 nodes has to decode 256 rows on every poll). The only consumers are the terminal notification and the terminal TaskOutput;
 * reading it while in flight has no reader, only cost. That criterion is enforced by the caller now -- `nodes` absent means "in flight, do not read" --
 * so that the same scan can also feed {@link artifactsOf}.
 */
function reportsOf(nodes: readonly NodeRecord[] | undefined): { reports?: readonly unknown[] } {
  if (nodes === undefined) return {};
  const items = nodes.filter((node) => node.kind === "report").map((node) => node.result);
  // When there are zero entries, the entire field is absent: the notification end makes the entire section `<reports>` disappear accordingly and does not send empty sections.
  return items.length === 0 ? {} : { reports: items };
}

/**
 * The **only implementation that synthesizes status truth**, with four levels of priority:
 *   in-memory terminal state > live entry (the journal status is only trusted when it is not terminal) > journal status > "in the registry but no row yet".
 *
 * While this process's engine is still alive, a terminal row in the journal may come from another instance's orphan convergence and must not be used to end local tracking.
 * Once local settlement is done, the in-memory terminal state wins; the second level handles live entries that have not settled yet, ignoring foreign terminal rows and waiting for the engine to settle,
 * so the model is not notified early and the real completion result is not thrown away after the task has been marked done.
 *
 * All three reading surfaces (snapshot, list, detail) share it. The reason it returns the journal's {@link RunStatus} vocabulary rather than the
 * snapshot's: that level is the finest-grained one -- `pending` (submitted, the engine has not created a row yet) is a distinction the model can understand on the introspection surface, while
 * the snapshot surface folds it into `running` purely because of its own vocabulary limit ({@link runStatusToTaskStatus} does the folding).
 * The other way round (fold first and then try to recover it) would force downstream code to guess "which kind of running is this?".
 */
function synthesizeRunStatus(
  entry: RunRegistryEntry | undefined,
  journalStatus: RunStatus | undefined,
): RunStatus {
  // Memory final state priority: The settlement that this process has just received from the engine is newer than the journal line (which may not be finished yet).
  if (entry?.terminal !== undefined) return terminalRunStatus(entry.terminal);
  // Go here `entry !== undefined`, that is, "live run held by this service": the final state on the line can only be external writing,
  // Ignore it and run as it is. Non-final lines (pending/running) are accepted as usual - they are written by the engine itself.
  // Deliberately block only the final status: `journalStatus`. The gap of absence still has to fall into the `pending` below (that level is finer,
  // And introspection treats it as a model that can understand the difference).
  if (
    entry !== undefined &&
    journalStatus !== undefined &&
    TERMINAL_RUN_STATUSES.has(journalStatus)
  ) {
    return "running";
  }
  if (journalStatus !== undefined) return journalStatus;
  // Registry exists, journal does not exist: submit → createRun microtask gap. `pending` is the **only honest** at this moment
  // Status - The run has been accepted, but the engine has not yet dropped a line.
  return "pending";
}

function terminalRunStatus(settlement: RunSettlement): RunStatus {
  switch (settlement.status) {
    case "completed":
      return "completed";
    case "stopped":
      return "stopped";
    default:
      return "errored";
  }
}

/**
 * Logical terminal state -> the common vocabulary of the background task tracker. The tracker (shared with bash / subagent tasks) does not know
 * stopped / errored: stopped folds into `cancelled` and errored into `failed`; the real words are exposed separately through the snapshot's
 * `runStatus` / `stopReason`.
 */
function runStatusToTaskStatus(status: RunStatus): DynamicWorkflowRunSnapshot["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    case "stopped":
      return "cancelled";
    // pending / running are still running.
    default:
      return "running";
  }
}

/**
 * Stop reason: the in-memory terminal state wins (a settlement this process just received from the engine), then the journal row. It is only meaningful for stopped;
 * every other state returns undefined.
 *
 * The same priority as {@link synthesizeRunStatus}: **a live entry has no stop reason**. A reason written on the row can only be a
 * foreign write, and the three reading surfaces have to give the same answer -- the status saying "running"
 * while the reason says "it was interrupted" is harder to debug than both of them being wrong.
 */
function stopReasonOf(
  entry: RunRegistryEntry | undefined,
  record: { status?: RunStatus; stopReason?: RunStopReason } | undefined,
): DynamicWorkflowRunStopReason | undefined {
  if (entry?.terminal !== undefined) {
    return entry.terminal.status === "stopped" ? entry.terminal.reason : undefined;
  }
  if (entry !== undefined) return undefined;
  if (record?.status === "stopped") return record.stopReason ?? "user";
  return undefined;
}

/**
 * A journal row (+ an optional in-memory entry) -> the common cross-section of the list and detail surfaces.
 *
 * The timestamps are **read straight off the journal row**, deliberately bypassing {@link snapshotOf}'s `new Date(0)` fallback: once the in-memory entry has been
 * evicted that start time is fake, and the introspection surface's times are what the model judges "how long ago" from.
 */
export function journalRunSummary(
  row: DwfRunListItem,
  entry: RunRegistryEntry | undefined,
  ownerSessionId: string,
): DynamicWorkflowRunSummary {
  const ownedByThisSession = entry !== undefined || row.parentSessionId === ownerSessionId;
  // What is read is the status of **journal instead of the synthesized one: the semantics is "journal says it is not over yet, and this conversation
  // Unable to confirm". (The two must be equal on this branch - if it is not in this session or in the registry, there is no memory final state that can be overwritten.
  // journal - written literally so that this assertion will still hold when new sources of truth are added in the future. )
  const possiblyInterrupted = !TERMINAL_RUN_STATUSES.has(row.status) && !ownedByThisSession;
  const stopReason = stopReasonOf(entry, row);
  return {
    runId: row.runId,
    ...resolveDynamicWorkflowRunLabel({
      runId: row.runId,
      ...(row.name === undefined ? {} : { name: row.name }),
      ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
    }),
    status: synthesizeRunStatus(entry, row.status),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...lineageFields(entry?.resumedFrom ?? row.resumedFrom, supersededByOf(entry, row)),
    ownedByThisSession,
    // Only present if true: absence reads "no such doubt", while `false` causes each line to have a noise field.
    ...(possiblyInterrupted ? { possiblyInterrupted: true } : {}),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
  };
}

/**
 * A run that only has an in-memory entry (the microtask gap between submit -> createRun) -> the common cross-section.
 *
 * Ownership is always true (it is right there in this session's registry), so it also never carries `possiblyInterrupted`. The timestamp comes from
 * the moment of registration -- that is not a fallback guess but the run's real submission time (the journal row records the same millisecond-scale
 * `Date.now()` when it lands).
 */
export function registryRunSummary(
  runId: string,
  entry: RunRegistryEntry,
): DynamicWorkflowRunSummary {
  return {
    runId,
    ...resolveDynamicWorkflowRunLabel({
      runId,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      scriptText: entry.scriptText,
    }),
    status: synthesizeRunStatus(entry, undefined),
    ...(entry.terminal?.status === "stopped" ? { stopReason: entry.terminal.reason } : {}),
    ...lineageFields(entry.resumedFrom, supersededByOf(entry, undefined)),
    ownedByThisSession: true,
    createdAt: entry.startedAt.getTime(),
    updatedAt: (entry.completedAt ?? entry.startedAt).getTime(),
  };
}

/**
 * Only a completed run carries artifacts, and an `undefined` artifact means **the whole field is absent** (same rule as the completion notification).
 *
 * The priority is the same as {@link snapshotOf}: the artifact in the in-memory terminal state is the **original value** this process just received from the engine,
 * while the journal's result_json is its shape after a JSON round trip; only after the entry is evicted does it fall back to the latter.
 * The value itself is **handed over as-is, not serialized** -- the model-facing text projection has a single implementation in core, and having the port do it a second time would
 * produce "the same artifact looks different in the notification than in the tool".
 */
export function terminalResultField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { result?: unknown },
): { result?: unknown } {
  if (status !== "completed") return {};
  if (entry?.terminal?.status === "completed" && entry.terminal.artifact !== undefined) {
    return { result: entry.terminal.artifact };
  }
  // `result: null` is a legal product (`ask<T | null>` will return it), so the criterion is `!== undefined`
  // Instead of truthfulness - the decoding side also only writes out the key if the column is non-NULL.
  return row?.result === undefined ? {} : { result: row.result };
}

/**
 * errored always carries a failure; stopped only does so for provider / interrupted (a user / model stop has no failure to speak of).
 * The journal's `failure_json` is the **authority**: it carries a structured code, so `Interrupted` (the process died),
 * `ProviderStop` (a deterministic error on the model side) and `DriverError` (the script genuinely failed) can be told apart by the model -- so
 * the code is exposed as-is here and never folded into one generic failure; `ProviderStop`'s structured detail is exposed along with it.
 */
export function terminalErrorField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { failure?: WorkflowErrorJson },
): { error?: DynamicWorkflowRunError } {
  if (status !== "errored" && status !== "stopped") return {};
  // Memory final state priority: The settlement zone that this process just took over from the engine has the original value (ProviderStop details are complete), and the journal line is
  // Its state after a JSON round trip; the entry is evicted before falling back to the latter.
  const memoryError =
    entry?.terminal?.status === "errored"
      ? entry.terminal.error
      : entry?.terminal?.status === "stopped"
        ? entry.terminal.error
        : undefined;
  if (memoryError !== undefined) {
    // The path that failed before the engine was constructed (the child process cannot spawn, the construction throws an error) has a wrapped one in the registry.
    // Common Error - There may be no code at runtime. Return DriverError instead of coding a new one: failure of that path
    // It really comes from the driver layer outside of the engine.
    const code = typeof memoryError.code === "string" ? memoryError.code : "DriverError";
    const providerStop = (memoryError as { providerStop?: WorkflowErrorJson["providerStop"] })
      .providerStop;
    return {
      error: {
        code,
        message: memoryError.message,
        ...(providerStop === undefined ? {} : { providerStop }),
      },
    };
  }
  if (row?.failure !== undefined) {
    return {
      error: {
        code: row.failure.code,
        message: row.failure.message,
        ...(row.failure.providerStop === undefined
          ? {}
          : { providerStop: row.failure.providerStop }),
      },
    };
  }
  return {};
}

/**
 * A `log` event in the journal -> a logTail entry of the port.
 *
 * The message is bounded by {@link boundDynamicWorkflowRunEventPayload} instead of being sliced here: the string cap
 * (2048) and the proxy-item-safe truncation rule have already been written once on the port side, and copying them a second time would let them diverge during some future tuning pass.
 * The query already pushes `type='log'` down as a filter, so a non-log event can only come from implementation drift -- in that case give an empty message rather than
 * crashing the entire detail surface.
 */
export function toLogTailEntry(stored: StoredEvent): DynamicWorkflowRunLogEntry {
  const message = stored.event.type === "log" ? stored.event.message : "";
  const { payload } = boundDynamicWorkflowRunEventPayload({ message });
  return {
    sequence: stored.sequence,
    message: typeof payload.message === "string" ? payload.message : "",
    // The drop-in time has crossed the boundary as it is; there is no old journal with this column (the age will not be given on the reading side accordingly).
    ...(stored.timeCreated === undefined ? {} : { at: stored.timeCreated }),
  };
}

/** Awaits settlement but respects the caller's signal (being interrupted while waiting is not the same as the run being cancelled). */
export async function settleOrAbort(
  settlement: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) {
    await settlement;
    return;
  }
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    void settlement.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
    );
  });
}

/**
 * The failure code written by orphan convergence (a host-level member the engine itself never produces). It lands in the journal together with `stopped(interrupted)`:
 * status + stopReason already say "interrupted by process death", and this code is a second piece of evidence for the same fact (older rows have only it).
 */
export const INTERRUPTED_FAILURE_CODE: WorkflowErrorCode = "Interrupted";

/**
 * The resume gate's only predicate: **stopped is resumable**,
 * except for `superseded` -- its unfinished work already belongs to the successor, and replaying it would mean doing the same thing twice against the workspace the successor is editing;
 * errored / completed are not resumable. {@link DynamicWorkflowRunSessionSummary.resumable} uses the same one --
 * if the UI re-derives it from status on its own, the two predicates will disagree one day: the button lights up but the command is rejected.
 */
export function isResumableRecord(record: Pick<RunRecord, "status" | "stopReason">): boolean {
  return isResumableSettlement(record.status, record.stopReason);
}

/**
 * The "settled fact" shape of that same predicate: the `resumable` bit on the `run-settled` payload is computed by it (live is computed by
 * toProgressPayload from the engine events, cold replay is computed by the backfill from the journal row), and the reducer only carries it.
 */
export function isResumableSettlement(status: RunStatus, stopReason?: RunStopReason): boolean {
  return status === "stopped" && stopReason !== "superseded";
}

/**
 * An enumeration row -> the session enumeration summary. All three things are deliberately sourced from elsewhere:
 *   - `resumable` uses the resume gate's very same predicate ({@link isResumableRecord});
 *   - `label` uses the derivation chain shared by the two reading surfaces ({@link resolveDynamicWorkflowRunLabel}) -- if the enumeration surface
 *     rolled its own fallback, the same run would show up under different names in `/dwf list` and on the tool card;
 *   - `updatedAt` is read straight off the journal row's `timeUpdated` (`RunRecord` carries no time, hence the input is the enumeration row).
 */
export function toSessionSummary(
  row: DwfRunSessionListItem,
  entry?: RunRegistryEntry,
): DynamicWorkflowRunSessionSummary {
  const { label } = resolveDynamicWorkflowRunLabel({
    runId: row.runId,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
  });
  // The fourth reading plane also follows the same priority ({@link synthesizeRunStatus}): the final state on the downstream side of the live entry is external writing.
  // The status is reported as running, but the reason for the stop and the failure are not displayed. Without this one, the conversation list will show only one that has been "stopped"
  // run, and the snapshot/list/details all say it is running.
  const status = synthesizeRunStatus(entry, row.status);
  const stopReason = stopReasonOf(entry, row);
  const live = entry !== undefined && entry.terminal === undefined;
  return {
    runId: row.runId,
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    label,
    updatedAt: row.timeUpdated,
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...lineageFields(row.resumedFrom, supersededByOf(entry, row)),
    ...(live || row.failure?.code === undefined ? {} : { failureCode: row.failure.code }),
    ...(live || row.failure?.message === undefined ? {} : { failureMessage: row.failure.message }),
    resumable: isResumableSettlement(status, stopReason),
  };
}
