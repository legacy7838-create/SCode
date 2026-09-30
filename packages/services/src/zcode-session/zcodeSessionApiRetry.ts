import {
  normalizeZCodeApiRetryStatus,
  isZCodeModelRetryRecoveryProgressPayload,
  resolveWorkspaceKey,
  type ZCodeSessionApiRetryStatus,
  type ZCodeSessionStateSnapshot,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
} from "@zcode/shared";
import type { ZCodeSessionServiceEvent, ZCodeTaskTarget } from "#src/zcode-session/zcodeSession.js";

export function createZCodeSessionApiRetryRuntimeTracker(): {
  trackApiRetryFromSessionEvent: (
    params: ZCodeTaskTarget,
    event: ZCodeSessionServiceEvent,
  ) => ZCodeSessionServiceEvent;
  withApiRetryRuntime: (snapshot: ZCodeSessionStateSnapshot) => ZCodeSessionStateSnapshot;
} {
  const apiRetryBySessionKey = new Map<string, ZCodeSessionApiRetryStatus | null>();

  function trackApiRetryFromSessionEvent(
    params: ZCodeTaskTarget,
    event: ZCodeSessionServiceEvent,
  ): ZCodeSessionServiceEvent {
    if (
      event.type === "session.event" &&
      (event.event.type === "session.updated" || event.event.type === "streamRecovery.updated")
    ) {
      // The desktop-continuous snapshot runtime needs to keep up with the progress of core recovery;
      // Otherwise, you will only see an empty retry status when switching back to the recovering session.
      const apiRetry = apiRetryFromSessionPayload(asRecord(event.event.payload));
      const key = sessionKey({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionId: event.event.sessionId,
      });
      if (apiRetry !== undefined) {
        apiRetryBySessionKey.set(key, apiRetry);
      } else if (
        apiRetryBySessionKey.get(key) != null &&
        isZCodeModelRetryRecoveryProgressPayload(asRecord(event.event.payload))
      ) {
        // The snapshot runtime and live UI should use the same recovery success boundary;
        // The retry attempt is unclear at first, and will not be cleared until the first model progress is reached, to avoid status flickering during reconnection or remaining after switching back to the task.
        apiRetryBySessionKey.set(key, null);
      }
      return event;
    }
    if (event.type === "snapshot") {
      return {
        ...event,
        snapshot: withApiRetryRuntime(event.snapshot),
      };
    }
    return event;
  }

  function withApiRetryRuntime(snapshot: ZCodeSessionStateSnapshot): ZCodeSessionStateSnapshot {
    const sessionId = snapshot.session?.sessionId;
    const workspacePath = snapshot.session?.workspace?.workspacePath;
    if (!sessionId || !workspacePath) {
      return snapshot;
    }
    const key = sessionKey({
      workspacePath,
      workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
      sessionId,
    });
    if (snapshot.runtime?.apiRetry !== undefined) {
      apiRetryBySessionKey.set(key, snapshot.runtime.apiRetry);
      return snapshot;
    }
    if (snapshot.session.status === "completed" || snapshot.session.status === "error") {
      apiRetryBySessionKey.set(key, null);
      return {
        ...snapshot,
        runtime: {
          ...snapshot.runtime,
          apiRetry: null,
        },
      };
    }
    if (!apiRetryBySessionKey.has(key)) {
      return snapshot;
    }
    return {
      ...snapshot,
      runtime: {
        ...snapshot.runtime,
        // The desktop-continuous main path does not go through the task adapter when reading the protocol snapshot.
        // Here, the subscribed network retry is temporarily added to the snapshot. When switching back to the running task, the retry prompt will continue to be displayed at the bottom of the current turn.
        apiRetry: apiRetryBySessionKey.get(key) ?? null,
      },
    };
  }

  function sessionKey(params: ZCodeTaskTarget): string {
    return `${resolveWorkspaceKey(params)}\u0000${params.sessionId}`;
  }

  return {
    trackApiRetryFromSessionEvent,
    withApiRetryRuntime,
  };
}

function apiRetryFromSessionPayload(
  payload: Record<string, unknown>,
): ZCodeSessionApiRetryStatus | null | undefined {
  if ("apiRetry" in payload) {
    return normalizeZCodeApiRetryStatus(payload.apiRetry);
  }
  const runtimeRetry = normalizeZCodeApiRetryStatus(asRecord(payload.runtime).apiRetry);
  if (runtimeRetry !== undefined) {
    return runtimeRetry;
  }
  const metaRetry = normalizeZCodeApiRetryStatus(asRecord(asRecord(payload._meta).zcode).apiRetry);
  if (metaRetry !== undefined) {
    return metaRetry;
  }
  return (
    zcodeApiRetryFromStreamRecoveryPayload(payload) ??
    zcodeApiRetryFromModelNetworkStatusPayload(payload)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
