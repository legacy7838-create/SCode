// ============================================================
// Two pure rules for publisher key-level increments of `workflowRun.*`: old consumer encoding, and fast path growth bound
// ============================================================
// The reason for living outside publisher is as important as the fact that they are pure functions: both rules need to be pinned separately, and publisher is
// A runtime shell with a subscription registry and retained logs. To try these two things on it, you need to build half of the transport layer first.
//
// ── 1. Old consumer code ──
// What is stored in the retention log is always the original OP (one fact, one log), and the encoding is a matter of **each subscriber**: brought during handshake
// The connection of `workflowRunDeltas` directly receives the delta, and the client without it does not even recognize the discriminant of op——
// `conversationDeltaSchema` is discriminatedUnion, unknown `op` causes the entire union to fail to parse, and the entire
// The logical frame was discarded by the assembler, and the op was not included in the resent snapshot, so the subscription was silent from now on.
// So this is not "optimization", it is the dividing line between whether the client of that generation can continue to see run.
//
// There is only one rewrite rule: all `workflowRun.*` in the entire batch will be discarded, and one will be added to the position where the **last one** was discarded.
// `state.updated{workflowRuns: current projection}`. Why is it the position of the last item instead of the first one: Integer substitution implication
// The full effect of this batch of increments is placed at the position of the last item, and its relative order with the rest of the ops in the batch is consistent with item-by-item delivery.
// (The row op and the status key are independent of each other and can be exchanged). Why does it bring the **current** projection instead of the historical intermediate state:
// The increment in the log when resuming playback is no longer the latest fact, and what the client wants is the final state - the intermediate state is skipped and
// coalesce is doing the same thing every day.
//
// Clamping to the old bound (256) is handled by `clampWorkflowRunsForLegacy`, see its header for the reason.

import type { ConversationDelta, WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import { clampWorkflowRunsForLegacy, utf8JsonByteLength } from "@zcode/shared/zcode-protocol-v4";

function isWorkflowRunDelta(delta: ConversationDelta): boolean {
  return delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed";
}

/**
 * The encoding for legacy consumers of a delta batch. When the batch holds no `workflowRun.*`, **the very same array is returned as-is** (this path
 * runs for every subscriber on every ingest, and it should not build a new array for unrelated batches).
 *
 * When `workflowRuns` is absent it only drops, never fills: the projection has no such key yet, so there is nothing to replace
 * it with wholesale. The producing side never gets here (a delta implies a state); this only keeps it from becoming one `{workflowRuns: undefined}`.
 */
export function encodeConversationDeltasForLegacy(
  deltas: readonly ConversationDelta[],
  workflowRuns: WorkflowRunsState | undefined,
): readonly ConversationDelta[] {
  let lastIndex = -1;
  for (let index = deltas.length - 1; index >= 0; index -= 1) {
    if (isWorkflowRunDelta(deltas[index]!)) {
      lastIndex = index;
      break;
    }
  }
  if (lastIndex < 0) return deltas;

  const replacement: ConversationDelta | null =
    workflowRuns === undefined
      ? null
      : { op: "state.updated", patch: { workflowRuns: clampWorkflowRunsForLegacy(workflowRuns) } };
  const encoded: ConversationDelta[] = [];
  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index]!;
    if (!isWorkflowRunDelta(delta)) {
      encoded.push(delta);
      continue;
    }
    if (index === lastIndex && replacement !== null) encoded.push(replacement);
  }
  return encoded;
}

// ── 2. The growth upper bound of ingest fast path ──
//
// Today, every DWF engine event takes the exact path: clone the projection + copy the entire wire snapshot `JSON.stringify`
// to the 16MiB gate. There are thousands of events in one run. This item itself is a MB-level repeated overhead, which is the same account as whole key retransmission.
// Two halves. Key-level increments give a cheap and **reliable** upper bound on "how long is this step", so that most events don't need to be measured in full.

/** The headroom reserved for the JSON envelope (`{"kind":"deltas","deltas":[…]}` and the frame envelope); the same value as the streaming-append fast path. */
const WORKFLOW_RUN_DELTA_ENVELOPE_SLACK_BYTES = 64;

/**
 * The byte upper bound on snapshot growth when a delta batch contains **only** key-level deltas; null when any other op is present (that case must be measured exactly).
 *
 * Why the bound holds: everything `workflowRun.updated` writes into the snapshot is carried in that op's payload (the header key is replaced
 * wholesale, entries are upserted whole), so the snapshot can grow at most by that much; `workflowRun.removed` only makes the snapshot smaller.
 *
 * An **empty batch** satisfies the criterion just as well (nothing that is not a key-level delta), and its growth argument is even stronger: the only change a delta-less
 * event makes to the snapshot is the `seq` number — the headroom is amply sufficient. This branch is not a special case, it is the criterion read
 * all the way down, and it is exactly what keeps a replay event whose reduction is idempotent and produces not one delta from paying for a full serialization.
 *
 * The other half covered by null is part of the contract too: when the diff cannot recognize a structural change it degrades to a whole-key `state.updated`,
 * and that op's byte count is **not** an upper bound on growth (it replaces the entire key, and the old value's bytes are not part of
 * it), so it must fall back to the exact path. The criterion is therefore "every entry is a key-level delta", not "there is a key-level delta".
 *
 * The headroom is **per batch**, not per entry: the same allowance covers the JSON envelope and the growth of the decimal digits of `seq`.
 */
export function workflowRunDeltaGrowthUpperBound(
  deltas: readonly ConversationDelta[],
): number | null {
  for (const delta of deltas) {
    if (delta.op !== "workflowRun.updated" && delta.op !== "workflowRun.removed") return null;
  }
  return utf8JsonByteLength(deltas) + WORKFLOW_RUN_DELTA_ENVELOPE_SLACK_BYTES;
}
