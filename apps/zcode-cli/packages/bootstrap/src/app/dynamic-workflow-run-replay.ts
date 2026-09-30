// ============================================================
// Cold replay of Dynamic Workflow Run: journal → the same progress load as live
// ============================================================
// `workflowRuns` projection has only one source of memory.
// It is empty after restarting; and dwf_event contains every event sent by the engine - the same bounded serialization that is fed to the projection during live.
// This module recasts them into DynamicWorkflowRunProgressPayload in journal order, and cold materialization treats this batch of payloads as
// Memory events are fed to the same reducer, so the projections before and after restarts are consistent byte by byte.
//
// Separate into modules rather than stuffed into observation.ts: the casting chain (toProgressPayload) is in launch.ts, and launch.ts
// Already import observation.ts (predicate), the reverse import is the ring.

import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import type { DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import type { JournalStorePort, RunEvent, StoredEvent } from "@zcode/dynamic-workflow";
import { toProgressPayload } from "./dynamic-workflow-run-launch.js";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";

/**
 * Every progress payload of a run, ascending by journal sequence.
 *
 * **The row is the authority on settlement**: when the row is terminal (completed / errored / stopped), the last `run-settled` of the replay is
 * always minted from the row — a `run-settled` stored at the tail (if any) is replaced by it, and when there is none (process death, or orphan convergence
 * only rewrote the row and deliberately synthesized no event — the journal's contract is "what the engine emitted") it is appended. Same minting chain, same resumable
 * predicate (inside toProgressPayload); the reducer's `run-settled` branch already does all the normalization, so no second normalizer is needed here.
 * The minted payload **exists only in this replay's return value** and is never written into dwf_event.
 *
 * The terminal-state vocabulary rework (completed / errored / stopped) was mapped
 * only in the row's codec, while the dwf_event payload is raw JSON — a `run-settled` written earlier carries the old words
 * `cancelled` / `failed`. The original implementation, seeing a `run-settled` already at the tail, stopped minting and fed the old words straight to the reducer;
 * the reducer did not recognize the word, so the run was left running: the card stayed lit, Cancel was clickable, and the backend had nothing to cancel. The row is the sole authority on state
 * (the codec has already translated old rows into the new words), so settlement is always derived from the row; no matter how the event vocabulary changes, cold replay
 * never lies against old events again. A run on the new vocabulary yields byte-identical payloads on both paths (the engine's `run-settled` happens to carry
 * only those four fields from the row), so the contract that live and cold replay agree is unchanged.
 *
 * `concurrencyCeiling` is **required** rather than optional: it is a host-derived field on the `run-started` payload, always present on the live
 * side (computed at the moment of launch), and dropping it here would make the first cold-replay payload one key short of live — while
 * "byte equality on both sides" is the only contract of this module. The caller supplies the same `resolveWorkflowConcurrencyCeiling`.
 */
export function replayRunProgress(
  row: DwfRunSessionListItem,
  journal: Pick<JournalStorePort, "listEvents">,
  concurrencyCeiling: number,
): DynamicWorkflowRunProgressPayload[] {
  return replayRunProgressFromEvents(row, journal.listEvents(row.runId, {}), concurrencyCeiling);
}

/**
 * The same minting chain, but with the events handed in **already read** by the caller.
 *
 * There is exactly one reason for this to exist: `getRunDetail` must, in one and the same call, both reduce the run state and compute the situational
 * cross-section as of the event times. Having each side call `listEvents` separately
 * means paying twice for the same data — and this read surface is exactly the most expensive part on a long run.
 *
 * What is handed in must be **all events of that run, ascending by sequence** (i.e. the return of `listEvents(runId, {})`),
 * because the tail-settlement replacement logic depends on "the last one really is the last one".
 */
export function replayRunProgressFromEvents(
  row: DwfRunSessionListItem,
  stored: readonly StoredEvent[],
  concurrencyCeiling: number,
): DynamicWorkflowRunProgressPayload[] {
  const toolCallId = row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId };
  // Launch anchor point: The same casting chain as live, and the derived fields must also be consistent——
  // It is a contract (test pinning) of this module that cold replay payloads are byte-for-byte equal to live payloads. The anchor point is in this batch of events (the first
  // run-launched), there is no need to check the journal again; the run before upgrade does not have it, and the field is absent.
  const launched = stored.find((entry) => entry.event.type === "run-launched")?.event;
  const launchInputId =
    launched?.type === "run-launched" ? { launchInputId: launched.inputId } : {};
  // The lineage pointer has the same origin as live (the launch side reads from the input parameter or journal line, here it is directly the line).
  const resumedFrom = row.resumedFrom === undefined ? {} : { resumedFrom: row.resumedFrom };
  // Subagent model has the same origin as the anchor: the same `run-launched` event (zero SQL, no column on dwf_run).
  // The live side reads back the same specification string from the launch input parameters or the same event, so the loads on both sides are still equal byte by byte. Be present only after setting it up.
  const subagentModel =
    launched?.type === "run-launched" && launched.subagentModel !== undefined
      ? { subagentModel: launched.subagentModel }
      : {};
  const terminal = TERMINAL_RUN_STATUSES.has(row.status);
  const last = stored.at(-1);
  // Only replace the **tail** settlement: the `run-settled` of the previous life is still lying in the middle of the run after resume. That is real history.
  // The following `run-started` will turn it back to running (the existing semantics of reducer), leaving it unchanged.
  const trailingSettle = terminal && last?.event.type === "run-settled" ? last : undefined;
  const replayable = trailingSettle === undefined ? stored : stored.slice(0, -1);
  const payloads = replayable.map((entry) =>
    toProgressPayload({
      event: entry.event,
      runId: row.runId,
      sequence: entry.sequence,
      ...toolCallId,
      ...launchInputId,
      ...resumedFrom,
      ...subagentModel,
      concurrencyCeiling,
    }),
  );
  if (!terminal) return payloads;
  const settled: RunEvent = {
    type: "run-settled",
    status: row.status,
    // The stopped line must have a reason (when the old line is decoded and the warehouse has been converted to user), the other states do not.
    ...(row.status === "stopped" ? { stopReason: row.stopReason ?? "user" } : {}),
    ...(row.status === "stopped" && row.supersededBy !== undefined
      ? { supersededBy: row.supersededBy }
      : {}),
    ...(row.failure === undefined ? {} : { error: row.failure }),
  };
  payloads.push(
    toProgressPayload({
      event: settled,
      runId: row.runId,
      // When replacing, the sequence of the one being replaced is used (the water level is consistent with live); when appending, it is followed after the last one.
      sequence: trailingSettle?.sequence ?? (last?.sequence ?? 0) + 1,
      ...toolCallId,
      ...launchInputId,
      ...resumedFrom,
      ...subagentModel,
      concurrencyCeiling,
    }),
  );
  return payloads;
}
