import type { SessionEvent } from "./session.events.js";
import { SessionEventType } from "./session.events.js";

/**
 * Transient events that run at the same frequency as the message stream.
 * They still get a seq from the event store and are handed to the live sink, but they can be evicted from memory once the
 * turn has ended and been superseded by the next turn: the text of a finished turn is re-synthesized from the persisted
 * messages, and reducer / rewind / fork / checkpoint do not consume these types.
 */
export const TRANSIENT_SESSION_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set([
  SessionEventType.ModelStreaming,
  SessionEventType.ToolCallProgress,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ModelNetworkStatus,
]);

/**
 * The time-based fallback for a sealed turn that has no successor turn.
 * A subagent child session has only one turn and will never see the next turn_started,
 * so on a real machine a single child session leaves about 10k deltas behind until the record is reclaimed by the pool;
 * the 60s sampling tick calls `collectExpired`, and sealed turns past the grace period are evicted together.
 */
export const SEALED_TURN_TRANSIENT_GRACE_MS = 120_000;

export function isTransientSessionEvent(event: Pick<SessionEvent, "type">): boolean {
  return TRANSIENT_SESSION_EVENT_TYPES.has(event.type);
}

export type SessionEventRetentionMode = "unbounded" | "turn-window";

export interface SessionEventRetentionPolicy {
  /**
   * Called once after every append. The return value is the list of turnIds whose transient events should be evicted from
   * memory; an empty array means nothing is evicted.
   * The policy looks only at the event sequence itself and does not depend on persistence results.
   */
  onAppend(event: Pick<SessionEvent, "type" | "turnId">, nowMs: number): readonly string[];
  /**
   * Time-based fallback: returns the list of sealed turnIds that ended before `nowMs - graceMs` and still have no successor
   * turn, and removes them from the pending-eviction set. Called by the low-frequency tick.
   */
  collectExpired(nowMs: number, graceMs: number): readonly string[];
}

const NO_EVICTION: readonly string[] = [];

function createUnboundedRetention(): SessionEventRetentionPolicy {
  return { onAppend: () => NO_EVICTION, collectExpired: () => NO_EVICTION };
}

/**
 * Turn-window policy: `turn_complete` / `turn_error` only mark the turn as ended (sealed),
 * and the transient events of all sealed turns are evicted in one go once the next `turn_started` arrives (one turn of lag).
 * The reason for the lag: right after a turn ends the messages may not be on disk yet, and a cold restore still has to
 * assemble the text from the in-memory transient events; the next turn starting means the user sent a message again,
 * so the previous turn is definitely persisted.
 */
function createTurnWindowRetention(): SessionEventRetentionPolicy {
  const openTurns = new Set<string>();
  const sealedAt = new Map<string, number>();
  return {
    onAppend(event, nowMs) {
      const turnId = event.turnId;
      if (!turnId) {
        return NO_EVICTION;
      }
      switch (event.type) {
        case SessionEventType.TurnStarted: {
          const evict = [...sealedAt.keys()].filter((sealed) => sealed !== turnId);
          sealedAt.clear();
          openTurns.add(turnId);
          return evict;
        }
        case SessionEventType.TurnComplete:
        case SessionEventType.TurnError: {
          openTurns.delete(turnId);
          if (!sealedAt.has(turnId)) {
            sealedAt.set(turnId, nowMs);
          }
          return NO_EVICTION;
        }
        default:
          return NO_EVICTION;
      }
    },
    collectExpired(nowMs, graceMs) {
      const expired: string[] = [];
      for (const [turnId, at] of sealedAt) {
        if (nowMs - at >= graceMs) {
          expired.push(turnId);
        }
      }
      for (const turnId of expired) {
        sealedAt.delete(turnId);
      }
      return expired;
    },
  };
}

export function createSessionEventRetentionPolicy(
  mode: SessionEventRetentionMode,
): SessionEventRetentionPolicy {
  return mode === "unbounded" ? createUnboundedRetention() : createTurnWindowRetention();
}
