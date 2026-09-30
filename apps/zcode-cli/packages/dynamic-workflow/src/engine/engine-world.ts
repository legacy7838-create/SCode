/**
 * engine.ts hit the oxlint max-lines limit (400 lines), so the admit-settle path of the world nodes (world-read /
 * world-run) and the close / restore seam of the amend-resume import cache are split into this file; the public surface is still exported from engine.ts.
 *
 * Free functions read and write engine state through the {@link EngineState} seam; WorkflowEngine.worldRead is only a
 * thin delegate, closing is triggered by the scheduler through SchedulerHost, and restore is called in the resume branch of the engine constructor.
 */

import { canonicalJson, inputHash } from "./hash.js";
import { heldResolution } from "./replay-order.js";
import { boundWorldReadInput } from "./world-read-input.js";
import { hashMismatch } from "./scheduler.js";
import type { EngineState } from "./engine-state.js";
import type {
  InstanceRef,
  JournalStorePort,
  NodeKind,
  WorkflowErrorJson,
  WorldReadInput,
  WorldReadOp,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";

export function readWorld(
  state: EngineState,
  siteId: string,
  op: WorldReadOp,
  args: unknown[],
): Promise<unknown> {
  if (state.isRunSettled()) return Promise.reject(state.runError());
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };
  // inputHash overrides `{op, args}` (not the single-argument `{op, arg}`). This is **intentional load deflection**:
  // In the old journal (written before the multi-parameter world-read), every world-read hit would cause the inputHash to be inconsistent, causing the run to end with
  // InputHashMismatch fails loudly. Acceptable - v1's resume inherently requires the script text to be identical byte-for-byte.
  // (script_hash), the script whose facade surface is earlier than the multi-parameter world-read will not be the script to be resumed.
  // I write it here because the fault point is in resume, which is far away from this line.
  const hash = inputHash({ op, args });
  // Bounded `{op, args}`: written with the same access as hash,
  // And bring it over in the upsert of settlement as it is - putNode is the whole replacement, if there is any omission, it will be erased back to NULL.
  const input = boundWorldReadInput(op, args);

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      const err = hashMismatch(instance, recorded.inputHash, hash);
      state.failRun(err);
      return Promise.reject(err);
    }
    // Completion hits a short circuit (journalized world reading makes resume immune to disk changes between run and resume).
    // The release point passes through the replay sequence gate: the world in a fan-out branch reads the same thing that other people's continuations are waiting for.
    // Putting them in admission order will misalign the serial numbers after the join.
    if (recorded.status === "completed") {
      return heldResolution(state.holdForReplay, instance, () => {
        state.record({ type: "node-settled", instance, outcome: "ok", cached: true });
        return recorded.result;
      });
    }
    if (recorded.status === "failed") {
      return heldResolution(state.holdForReplay, instance, () => {
        state.record({
          type: "node-settled",
          instance,
          outcome: "failed",
          cached: true,
          error: recorded.error,
        });
        throw WorkflowError.fromJSON(recorded.error!);
      });
    }
    // status === "running": Crash during execution, fall to the bottom and restart live execution.
  }

  // op "run" is an effect rather than a read. Journal is a single type (world-run): the mechanism is isomorphic and the audit is honest. The remaining ops remain world-read.
  const kind: NodeKind = op === "run" ? "world-run" : "world-read";

  // amend-resume: There is no such line in the journal of this run, so it is the turn to import the cache (journal replay always takes priority——
  // Revised: When run resumes after crashing, the consumed hits are already real rows, and the cursor cannot be moved when replaying them).
  // If hit, write a completed record with the same shape as settleWorldRead + send node-settled(cached),
  // **Do not adjust driver**: world-run effects are never silently replayed.
  // The table is no longer asked (and the cursor is not advanced) after caching is turned off: the command text remains unchanged, but the world it reads may have been replaced by a live subagent
  // Rewrite.
  const imported = state.importClosed() ? undefined : state.importedWorld.take(hash);
  if (imported !== undefined) {
    state.journal.putNode({
      runId: state.runId,
      siteId,
      ordinal,
      kind,
      inputHash: hash,
      input,
      status: "completed",
      result: imported.result,
    });
    state.record({ type: "node-settled", instance, outcome: "ok", cached: true });
    return Promise.resolve(imported.result);
  }

  // live world-read: not subject to actor FIFO/concurrency upper limit (harness IO).
  if (state.isRunSettled()) return Promise.reject(state.runError());
  // live's world.run is a write (effect, not read): once it executes, the workspace is different from the one left by the predecessor, so in
  // Turn off the import cache before dispatching - under the same rules and at the same time as the subagent's rewrite tool (before you start). world-read is not relevant:
  // Reading doesn’t change the world.
  if (kind === "world-run") closeImportCache(state, instance, "world-run");
  // Fall after admission. Running: The world that crashes during execution can be read resume and can be re-executed accordingly.
  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind,
    inputHash: hash,
    input,
    status: "running",
  });
  state.record({ type: "node-queued", instance, kind });
  state.record({ type: "node-dispatched", instance });
  return state.driver.executeWorldRead(op, args).then(
    (value) =>
      settleWorldRead(state, instance, kind, hash, input, { status: "completed", result: value }),
    (cause: unknown) => {
      const err =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError("DriverError", `World read failed: ${op} ${canonicalJson(args)}.`, {
              cause,
            });
      return settleWorldRead(state, instance, kind, hash, input, {
        status: "failed",
        error: err.toJSON(),
      });
    },
  );
}

function settleWorldRead(
  state: EngineState,
  instance: InstanceRef,
  // putNode is an upsert (whole replacement). If settle is hard-coded, world-read will replace the world-run when entering.
  // Quietly change it back - kind must have the same origin as admission.
  kind: NodeKind,
  hash: string,
  // Same reason: the bounded input written by the admission must be replaced with the entire settlement.
  input: WorldReadInput,
  outcome:
    | { status: "completed"; result: unknown }
    | { status: "failed"; error: WorkflowErrorJson },
): unknown {
  if (state.isRunSettled()) throw state.runError();
  state.journal.putNode({
    runId: state.runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind,
    inputHash: hash,
    input,
    status: outcome.status,
    ...(outcome.status === "completed" ? { result: outcome.result } : { error: outcome.error }),
  });
  if (outcome.status === "completed") {
    state.record({ type: "node-settled", instance, outcome: "ok" });
    return outcome.result;
  }
  state.record({ type: "node-settled", instance, outcome: "failed", error: outcome.error });
  throw WorkflowError.fromJSON(outcome.error);
}

/**
 * Closes the import cache (idempotent). There are two trigger points, both **before the first write**: the driver
 * reports that a live subagent is about to execute a mutating tool (`mutating-tool`), or a `world.run` is about to
 * execute live (`world-run`). The `import-cache-closed` event is emitted only when this really is an amend run — it is
 * the only source of truth for restoring "the gate is closed" on resume; a non-amend run has no table to close, and the flag is harmless but no event is emitted.
 */
export function closeImportCache(
  state: EngineState,
  instance: InstanceRef,
  cause: "mutating-tool" | "world-run",
  actorName?: string,
): void {
  if (state.importClosed()) return;
  state.closeImport();
  if (state.importedCache === undefined) return;
  state.record({
    type: "import-cache-closed",
    instance,
    cause,
    ...(actorName === undefined || actorName === "" ? {} : { actorName }),
  });
}

/**
 * On resume, restores the closed-gate decision, the set of "ask instances that were ever live", and the set of "ask
 * instances admitted before the gate closed".
 *
 * The source of truth is this run's own events: a live node emits `node-queued` at admission (with the actor ref for
 * an ask), while a cache hit only emits `node-settled cached:true`, so "which asks were ever live" is an exact set.
 * Whether the gate is closed is decided by the `import-cache-closed` event — an ask turning live no longer implies a closed gate (it may not have touched a single file); only a write closes it, and only this event records that a write happened. Zero schema change.
 *
 * `queuedBeforeClose` is likewise zero schema change, relying on **event ordering**: the decision to resume an
 * in-flight ask and that ask's `node-queued` land in the same synchronous slice as admission (see the scheduler's
 * admitAsk → tryImportedSettle → admitLive), so "the gate was open at the moment of admission" ⇔ "this node-queued
 * precedes the first import-cache-closed". With no close event, everything counts as in.
 */
export function recoverImportClosure(
  journal: JournalStorePort,
  runId: string,
): { live: ReadonlySet<string>; queuedBeforeClose: ReadonlySet<string>; closed: boolean } {
  const live = new Set<string>();
  const queuedBeforeClose = new Set<string>();
  let closed = false;
  for (const { event } of journal.listEvents(runId)) {
    if (event.type === "import-cache-closed") closed = true;
    if (event.type !== "node-queued" || event.kind !== "ask") continue;
    const key = refToString(event.instance);
    live.add(key);
    if (!closed) queuedBeforeClose.add(key);
  }
  return { live, queuedBeforeClose, closed };
}
