// ============================================================
// AgentRuntime-backed WorkflowDriver: Transcription orchestration (two driver-private things of amend-resume)
// ============================================================
// workflow-driver.ts reaches the upper limit of oxlint max-lines (400 lines), and arranges the transcription on the driver side——
// Different actor transcription truncation (seedActorSession), ask boundary accounting count (countSessionTranscript) and writeback
// (journalAskMessageBoundary) - Split this file into free functions; the public side remains unchanged. The mechanism itself still lives in
// workflow-actor-transcript.ts (copying and counting), here are just three calls made by the driver and their failure choices.
// The original method body is retained verbatim, only `this.deps` / `this.journal` is replaced with the deps passed in explicitly.

import type { SessionId } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import {
  refToString,
  WorkflowError,
  type ActorSessionSeed,
  type InstanceRef,
} from "@zcode/dynamic-workflow";
import { countActorTranscript, seedActorTranscript } from "./workflow-actor-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * Transcript truncation of a diverging actor (amend-resume): copy the first N messages of the source session
 * into the freshly minted session, then let the runtime open with that prior context.
 *
 * The order is **load-bearing**, and not one of the three steps may be swapped:
 *   1. The factory has returned => the session row is already in the database (`message.session_id` has an FK
 *      to `session(id)`, so copying first would necessarily fail);
 *   2. Copy into the **persistence layer**, not the in-memory history, because two readers depend on the
 *      persisted copy: this run's rehydration, and **future amendments to this run** (the chain walker will
 *      read this session as a transcript source);
 *   3. Rehydration goes through the existing `resumeFromStore` (the same machine as a resume reattach), and
 *      never a second hydration path. The session row and its messages were both just written, so the
 *      launch-side `SessionNotFound -> brand new` degradation branch is deliberately not copied here: the cause
 *      of that branch is "the session was cleaned up", whereas here it could only mean the wiring is wrong, and
 *      it should fail loudly.
 *
 * The **condition** on step 3: if something was really copied, hydration is mandatory; if nothing was copied
 * (skipped) and the journal already records this session id, it means the runtime factory has just reattached
 * via the resume path (launch's attachActorSession), and hydrating again would only emit one extra
 * SessionResumed and run one more round of SessionStart hooks. The case where neither condition holds (copy
 * skipped and no journal record = the previous life crashed between the copy and putActor) must still hydrate,
 * otherwise the runtime would start with an empty context on a session full of messages.
 *
 * This condition holds for **both** skip reasons of {@link seedActorTranscript}, and there is no need to tell
 * them apart: the criterion for both is "the target session already has its own content", and
 * `attachActorSession` uses the same predicate to decide whether to reattach (whether the journal holds a
 * sessionId for this actor), so the two always hold together or fail together.
 */
export async function seedActorSession(
  deps: AgentRuntimeWorkflowDriverDeps,
  input: {
    journaledSessionId: string | undefined;
    runtime: AgentRuntime;
    seed: ActorSessionSeed;
    sessionId: SessionId;
  },
): Promise<void> {
  const { journaledSessionId, runtime, seed, sessionId } = input;
  const store = deps.actorTranscriptStore;
  if (store === undefined) {
    throw new WorkflowError(
      "DriverError",
      `Subagent session ${sessionId} carries a transcript seed, but the driver has no ` +
        `transcript store (wiring error).`,
    );
  }
  const copied = await seedActorTranscript({
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    seed,
    store,
    targetSessionId: sessionId,
  });
  if (copied === undefined && journaledSessionId !== undefined) return;
  await runtime.resumeFromStore();
}

/** Count the messages already persisted for this session; on failure give up on accounting (an absent boundary rather than a wrong one). */
export async function countSessionTranscript(
  deps: AgentRuntimeWorkflowDriverDeps,
  state: SessionState,
  instance: InstanceRef,
): Promise<number | undefined> {
  const store = deps.actorTranscriptStore;
  if (store === undefined) return undefined;
  try {
    return await countActorTranscript(store, state.sessionId);
  } catch (error) {
    deps.logger?.warn?.("Dynamic workflow ask message boundary count failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.ask.message_boundary.count_failed",
      instance: refToString(instance),
      module: "bootstrap.app",
      sessionId: state.sessionId,
    });
    return undefined;
  }
}

/**
 * Backfill the message-count boundary into this ask's journal row (`NodeRecord.messageBoundary`).
 *
 * It is **of the same family** as the stats backfill: the record the engine writes at settlement does not
 * contain this field (it is a fact owned by the driver), so the same read-modify-write is used here:
 * `getNode` fetches the whole record just settled, only the boundary is added, then `putNode`; status /
 * result / actorSeq / inputHash / stats stay untouched. Writing after settlement is mandatory, because the
 * engine's settlement replaces the whole record and anything written before it would be wiped.
 *
 * Every ask writes it, without distinguishing named/anonymous or amending/normal run, because **whether it is
 * anonymous is only decided at import time**, and any run is a potential predecessor of a future amendment.
 * The cost is one small write per ask.
 *
 * The two early exits each have a reason: the record is gone (the run has been cleaned up) so there is
 * nowhere to write; and `currentInstance` has already changed hands, meaning the next ask has already started
 * on this session, so the length counted right now no longer belongs to this exchange; better to let the
 * boundary stay absent (that ask is not importable) than to write a too-large value (truncation would carry an
 * extra opening stretch of the next ask).
 */
export function journalAskMessageBoundary(
  deps: AgentRuntimeWorkflowDriverDeps,
  state: SessionState,
  instance: InstanceRef,
  boundary: number,
): void {
  const key = refToString(instance);
  if (state.currentInstance !== undefined && refToString(state.currentInstance) !== key) return;
  const runId = deps.runId ?? "run";
  try {
    const recorded = deps.journal.getNode(runId, instance.siteId, instance.ordinal);
    if (recorded === undefined) return;
    deps.journal.putNode({ ...recorded, messageBoundary: boundary });
  } catch (error) {
    // Failure in accounting writing should not trigger an ask that has been settled (and this is running on a free promise, so the throw will only become
    // unhandled rejection). The cost is the same as counting failure: the ask is not importable, and run is therefore not a precursor.
    deps.logger?.warn?.("Dynamic workflow ask message boundary write failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.ask.message_boundary.write_failed",
      instance: key,
      module: "bootstrap.app",
      runId,
    });
  }
}
