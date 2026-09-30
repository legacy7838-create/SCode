// The real-life adaptation and deactivation execution surface of the Session resident pool.

import type { SessionId } from "@zcode/contracts";
import type {
  SessionDeactivationDecision,
  SessionResidentPoolHost,
} from "./session-resident-pool.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

interface SessionResidencyFinalizationOwner {
  residencyFinalizationCount?: number;
}

/**
 * The residency lease covers only the wrap-up window of the Bootstrap detached runner, so the pool never recycles a
 * record that is still in use. The busy/idle authority for prompt admission now belongs to Core; activeAbortController is only
 * a compatibility cancel handle of the old command path and must no longer serve as the prompt scheduling lock.
 */
function acquireSessionResidencyFinalization(
  record: SessionResidencyFinalizationOwner,
): () => void {
  record.residencyFinalizationCount = (record.residencyFinalizationCount ?? 0) + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.residencyFinalizationCount = Math.max(0, (record.residencyFinalizationCount ?? 1) - 1);
  };
}

/** Register the lease synchronously, then start the detached runner; both a synchronous throw and the async terminal state guarantee the release. */
export function runWithSessionResidencyFinalization<T>(
  record: SessionResidencyFinalizationOwner,
  run: () => Promise<T>,
): Promise<T> {
  const release = acquireSessionResidencyFinalization(record);
  try {
    return run().finally(release);
  } catch (error) {
    release();
    return Promise.reject(error);
  }
}

/**
 * Release the resident runtime only; no persistent session/task fact is deleted.
 *
 * Awaiting app.close before removing the record from the registry lets a new cold subscribe land on an
 * old runtime that is already shutting down inside that await window; deleting the record first without setting the
 * pool gate lets the old and the new app touch the same session resource concurrently. The synchronous
 * removal and the asynchronous close must therefore be composed into one lifecycle transaction by the pool's in-flight gate.
 */
async function deactivateSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<void> {
  const record = context.sessions.get(sessionId);
  if (!record) return;
  // The rejection of the CommandInbox pin had occurred after unsubscribe, and the exception would have remained in the registry
  // But the half-clear record of the runtime event cannot be received. All preflightable rejections must precede the first side effect.
  context.v4Gateway?.assertSessionRuntimeDeactivatable(sessionId);
  record.unsubscribe?.();
  context.v4Gateway?.deactivateSession(sessionId);
  context.sessions.delete(sessionId);
  await record.app.close?.();
  // The in-memory event store must be equivalent to "never loaded" after deactivation.
  await record.eventStore.deleteSession(sessionId as SessionId);
}

export function createSessionResidentPoolHost(
  context: ZCodeProtocolAgentServerContext,
): SessionResidentPoolHost {
  return {
    deactivate: (sessionId) => deactivateSessionRecord(context, sessionId),
    listSessionIds: () => [...context.sessions.keys()],
    readResidencyFacts: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        hasPendingInteractions: context.v4Interactions.hasPendingForSession(sessionId),
        hasQueuedCommands: context.v4Gateway?.hasResidencyBlockingCommands(sessionId) ?? false,
        hasLegacySubscriber: record.legacyStreamSubscribed === true,
        // active/queue and registry background task cannot cover title, MCP, memory
        // Wait for detached work; unified query is maintained by runtime, and protocol finalization only supplements protocol ownership.
        hasResidencyBlockingWork:
          record.activeAbortController !== undefined ||
          (record.residencyFinalizationCount ?? 0) > 0 ||
          record.app.runtime.hasResidencyBlockingWork(),
        hasSubscribers: context.v4Gateway?.hasConversationSubscribers(sessionId) ?? false,
        lastActivityAt: record.updatedAt,
        persisted: record.persistence === "immediate",
      };
    },
    onDeactivated: (sessionId, decision) => {
      context.logger?.info("Session resident runtime deactivated", {
        ...deactivationLogContext(decision),
        event: "zcode_protocol.session.resident_deactivated",
        sessionId,
      });
    },
    onError: (sessionId, error, decision) => {
      context.logger?.warn("Session resident deactivation failed", {
        ...deactivationLogContext(decision),
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.resident_deactivation_failed",
        sessionId,
      });
    },
  };
}

function deactivationLogContext(
  decision: SessionDeactivationDecision,
): Record<string, number | string> {
  return {
    highWaterCount: decision.highWaterCount,
    idleMs: decision.idleMs,
    idleTimeoutMs: decision.idleTimeoutMs,
    reason: decision.reason,
    residentCountBefore: decision.residentCountBefore,
    targetCount: decision.targetCount,
  };
}
