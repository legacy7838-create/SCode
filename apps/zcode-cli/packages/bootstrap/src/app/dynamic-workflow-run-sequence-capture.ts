// Journal sequence interception layer for engine events. Separate into modules instead of staying in launch.ts: the responsibility there is to "assemble and start a run", while here it is
// "Truncate the number assigned to appendEvent to the emit that follows it" - the two things are complete on their own, and this one has only one consumer.
import type { JournalStorePort, RunEvent, StoredEvent } from "@zcode/dynamic-workflow";

/**
 * A journal wrapper whose only purpose is to capture the sequence that `appendEvent` assigned, for the emit
 * that immediately follows.
 *
 * Premise (guaranteed by the engine's `record()` and pinned by tests): every event is "appendEvent immediately
 * followed by a synchronous emit", one to one. So "the sequence of the last append" is the sequence of "the
 * event currently being emitted". To be safe, verify by **reference equality** of the event object: inequality
 * means the premise is broken, in which case fall back to the last sequence rather than guessing one. A
 * silently wrong sequence number is harder to diagnose than staying put, and tests would find it long before
 * production does.
 */
export function createJournalSequenceCapture(journal: JournalStorePort): {
  journal: JournalStorePort;
  sequenceOf: (event: RunEvent) => number;
} {
  let lastStored: StoredEvent | undefined;
  // Explicit forwarding method by method instead of `{...journal, appendEvent}`: both implementations are classes, and expansion only copies its own properties.
  // All methods on the prototype will be discarded (the engine will raise TypeError when calling getRun later). The forwarding plane only has engine ports:
  // Orphan convergence and enumerated narrow queries are deliberately not included - they happen on the service side, directly to deps.journal, without going through this layer.
  const wrapped: JournalStorePort = {
    createRun: (record) => journal.createRun(record),
    getRun: (runId) => journal.getRun(runId),
    updateRunStatus: (runId, status, settlement) =>
      journal.updateRunStatus(runId, status, settlement),
    updateRunUsage: (runId, spentTokens) => journal.updateRunUsage(runId, spentTokens),
    updateRunCaps: (runId, caps) => journal.updateRunCaps(runId, caps),
    putActor: (record) => journal.putActor(record),
    getActor: (runId, siteId, ordinal) => journal.getActor(runId, siteId, ordinal),
    listActors: (runId) => journal.listActors(runId),
    putNode: (record) => journal.putNode(record),
    getNode: (runId, siteId, ordinal) => journal.getNode(runId, siteId, ordinal),
    listNodes: (runId) => journal.listNodes(runId),
    appendEvent: (runId, event) => {
      const stored = journal.appendEvent(runId, event);
      lastStored = stored;
      return stored;
    },
    listEvents: (runId, opts) => journal.listEvents(runId, opts),
  };
  return {
    journal: wrapped,
    sequenceOf: (event) =>
      lastStored?.event === event ? lastStored.sequence : (lastStored?.sequence ?? 0),
  };
}
