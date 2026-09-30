// ============================================================
// Two things about actor session transcription: boundary counting and seed truncation replication (amend-resume)
// ============================================================
//
// These two things must live in the same module because they share a loadability invariant:
//
//   Boundary N ⇒ Copy the first N messages of the source conversation, just to get the complete transcription "up to the ask".
//
// The only reason why it is established is that counting messages and copying messages go through the same access interface ({@link ActorTranscriptStore.messages}),
// It is also the one read when core's `resumeFromStore` is rehydrated (core/src/runtime/methods/resume.ts).
// As long as one of the three readers changes to another caliber (such as counting only active branches, or counting by parts), the boundary will be in the eyes of the two readers.
// It is two lengths, and the truncated transcript will have one more or one less text - and that is the "top text seen by the model" and "the boundary between the journal notes"
// A quietly misplaced look. Therefore: **The counting caliber needs to be changed, and the three places must be changed at the same time**.
//
// The key property of the count offset (rather than the message id interval) is that the prefix remains unchanged after copying: the id changes completely after copying into a new session.
// The count remains unchanged, so the boundary value of the copied ask remains valid in the new session - chain revision (B copies from A, C then copies from B)
// The foundation is this.

import {
  createMessageId,
  createPartId,
  type Logger,
  type MessageId,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type PartId,
  type SessionId,
} from "@zcode/contracts";
import { cloneMessageForFork, clonePartForFork } from "@zcode/core";
import { WorkflowError, type ActorSessionSeed } from "@zcode/dynamic-workflow";

/**
 * The session transcript storage surface the driver needs: read all messages of one session, write one message
 * / one part.
 *
 * Structurally it is a proper subset of {@link import("@zcode/contracts").SessionStorePort}, so production can
 * simply pass the session store in. The reason for narrowing is the same as for the run service's journal /
 * task-link ports: the driver only needs these three methods, and declaring the whole store would make
 * "the driver depends on every capability of the session store" a true statement.
 */
export interface ActorTranscriptStore {
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  saveMessage(input: MessageInfo): Promise<void>;
  savePart(input: MessagePart): Promise<void>;
}

/**
 * The number of **persisted** messages an actor session currently has (the value ask-boundary accounting
 * records).
 *
 * Only the persisted ones are counted: the driver asks for this number when an exchange ends, and the runtime's
 * message persistence has already been awaited within the turn (core's persistMessage / persistPart), so what
 * has landed in the database at this moment is the entire output of this exchange.
 */
export async function countActorTranscript(
  store: ActorTranscriptStore,
  sessionId: SessionId,
): Promise<number> {
  return (await store.messages({ sessionID: sessionId })).length;
}

/**
 * Copy the first `seed.messageCount` messages of the source session (each with its own parts) into the target
 * session.
 *
 * Three properties:
 *
 * 1. **The predecessor is read-only**. Every message and every part copied out is minted with a new id:
 *    `message.id` / `part.id` are primary keys across the whole database, and the upsert in `saveMessage`
 *    rewrites `session_id` to the new value on an id conflict (messages.ts in adapters). Carrying ids over
 *    verbatim is not "copying", it is **moving away** the predecessor's transcript. Re-minting the ids in turn
 *    requires `parentID` and the in-part anchors to be remapped, which is exactly what core's fork cloners
 *    {@link cloneMessageForFork} / {@link clonePartForFork} already get right (a fork and this function are
 *    the same action: copying a stretch of transcript by value into another session, with the child continuing
 *    to write under local ids), so they are reused here instead of writing a second implementation.
 * 2. **Idempotent, and never writes into a session that has already started running**. Two skip rules, both
 *    are required:
 *
 *    - If the target already has >= messageCount messages, skip the whole stretch: that is the case of an
 *      amending run that crashed and was resumed, since the session id is minted purely deterministically from
 *      (runId, actorRef), so reattaching gets the very session that already holds "the copied + the newly
 *      produced" content, and copying again would double the prior context.
 *    - If the target has even one message that is **not** this session's seed id (see {@link seededMessageId}),
 *      skip as well. A session holding only seed messages is a "half-copied" prefix and is still topped up as
 *      usual; a session holding anything else has its own history, and not a single byte of it may be touched.
 *
 *    The second rule exists to prevent **re-copying after the boundary grows**: `inFlight.messageBoundary` is
 *    taken from the predecessor session's message count at this moment and is the one number in the import
 *    cache that is not a journal fact (see the file header of dynamic-workflow-import.ts). When it grows
 *    between two builds (the predecessor was resumed again and wrote a few more turns, or a late background
 *    notification message landed in it), an ordinary "stop -> resume" of the amending run calls back here with
 *    a larger M; if the target already has its own live messages but the total is still < M, the old rule
 *    would copy 0..M-1 all over again: the first N entries are upserts of existing seed ids (harmless), while
 *    N..M-1 are **new ids**, so the predecessor's messages end up appended **after** this session's own
 *    history (`message.sequence` takes `max+1` on insert, messages.ts in adapters). That is a stretch of
 *    prior context that reads out of order, does not belong to this subagent, and happens silently. "Only
 *    touch it when everything is a seed id" plugs this at the **copy point** in one stroke, and it holds for
 *    any future non-journal fact, without having to prove case by case that it will not grow.
 * 3. **Missing input fails loudly**. The source session does not exist (reads back empty) or is shorter than
 *    the boundary, which means this store cannot deliver the seed that the service constructed from journal
 *    facts; that is corruption level, not a degradable situation (the degradable half lives in the service's
 *    gate: a candidate with a missing session on the chain should already have been discarded there).
 *
 * @returns The number of entries actually copied; `undefined` means skipped (both rules collapse into this one
 *          return value, because the caller treats them identically: no second hydration, see
 *          seedActorSession in workflow-driver-transcript.ts).
 */
export async function seedActorTranscript(input: {
  logger?: Logger;
  seed: ActorSessionSeed;
  store: ActorTranscriptStore;
  targetSessionId: SessionId;
}): Promise<number | undefined> {
  const { logger, seed, store, targetSessionId } = input;
  const existing = await store.messages({ sessionID: targetSessionId });
  if (existing.length >= seed.messageCount) return undefined;
  if (!holdsOnlySeedMessages(existing, targetSessionId)) {
    // One note: walking here means that the seed boundary is larger than last time, and this is the only place where you can see it.
    logger?.warn?.("Dynamic workflow actor session already has its own history; seeding skipped", {
      event: "dynamic_workflow.actor.seed_skipped_live_session",
      existingMessageCount: existing.length,
      messageCount: seed.messageCount,
      module: "bootstrap.app",
      sessionId: targetSessionId,
    });
    return undefined;
  }

  const source = await store.messages({ sessionID: seed.sourceSessionId as SessionId });
  if (source.length < seed.messageCount) {
    throw new WorkflowError(
      "DriverError",
      `Cannot seed the subagent transcript: source session ${seed.sourceSessionId} has only ` +
        `${source.length} messages, but the boundary requires the first ${seed.messageCount}.`,
      { mismatch: { expected: String(seed.messageCount), got: String(source.length) } },
    );
  }

  // Old id → New id: The parent ID of the assistant and the embedded anchor point of the part are remapped according to it. The prefixes are consecutive,
  // Therefore, the earlier message referenced by each message must already be in the table (the subscript is strictly increasing).
  const messageIds = new Map<MessageId, MessageId>();
  for (let index = 0; index < seed.messageCount; index++) {
    const message = source[index]!;
    const nextMessageId = seededMessageId(targetSessionId, index);
    const cloned = cloneMessageForFork(message.info, {
      forkedSessionId: targetSessionId,
      messageIdMap: messageIds,
      nextMessageId,
    });
    messageIds.set(message.info.id, nextMessageId);
    await store.saveMessage(cloned);
    for (const [partIndex, part] of message.parts.entries()) {
      await store.savePart(
        clonePartForFork(part, {
          forkedSessionId: targetSessionId,
          messageIdMap: messageIds,
          nextMessageId,
          nextPartId: seededPartId(targetSessionId, index, partIndex),
        }),
      );
    }
  }
  return seed.messageCount;
}

/**
 * Whether the target session holds **only** this session's seed copies (entry i is exactly the i-th
 * {@link seededMessageId}).
 *
 * The criterion is the id, not a count or a timestamp: seed ids are purely deterministic from (target session,
 * index), so "is this message one I copied in" has an answer that depends on no clock and on nothing beyond
 * read order. An empty session counts as true (nothing has been copied yet, so of course it can be).
 * `messages()` returns in ascending `sequence` order and the seeds are written in index order, so the index is
 * the position.
 */
function holdsOnlySeedMessages(
  existing: readonly MessageWithParts[],
  targetSessionId: SessionId,
): boolean {
  return existing.every(
    (message, index) => message.info.id === seededMessageId(targetSessionId, index),
  );
}

/**
 * The id of a seed copy: purely deterministic from (target session, prefix index).
 *
 * What determinism buys is **repairability of a half-finished copy**: if the copy crashes halfway, the rows
 * already there are upserted back under the same id on reattach instead of growing a duplicate alongside. The
 * session id already contains runId and actorRef, so copies in two different target sessions never collide.
 */
function seededMessageId(targetSessionId: SessionId, index: number): MessageId {
  return createMessageId(`${targetSessionId}-seed-${index}`);
}

function seededPartId(targetSessionId: SessionId, index: number, partIndex: number): PartId {
  return createPartId(`${targetSessionId}-seed-${index}-${partIndex}`);
}
