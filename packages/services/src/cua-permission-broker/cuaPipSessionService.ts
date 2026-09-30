import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import {
  createPipSessionClient,
  type PipSessionClient,
  type PipSessionClientOptions,
} from "@zcode/zcode-cua/pip-session/node";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type { CuaPipSessionService } from "./cuaPipSession.js";

export interface CuaPipPresentationCredentials {
  socketPath: string;
}

type PipSessionClientResolution =
  | { client: PipSessionClient; skipReason?: never }
  | {
      client: null;
      skipReason:
        | "service-disabled"
        | "service-disposed"
        | "credentials-unavailable"
        | "transport-disabled";
    };

function eventLogContext(event: PipSessionEvent): Record<string, unknown> {
  if (event.kind === "focus-changed") {
    return {
      kind: event.kind,
      revision: event.revision,
      sessionId: event.sessionId,
      sourceWindowId: event.sourceWindowId,
    };
  }
  return {
    eventId: event.eventId,
    kind: event.kind,
    sequenceNumber: event.sequenceNumber,
    sessionId: event.sessionId,
    ...(event.kind === "session-closed" ? {} : { turnId: event.turnId }),
    ...(event.kind === "turn-ended" ? { outcome: event.outcome } : {}),
  };
}

export function createCuaPipSessionService(options: {
  enabled: boolean;
  resolveCredentials: () => Promise<CuaPipPresentationCredentials | undefined>;
  createClient?: (options: PipSessionClientOptions) => PipSessionClient;
  logger?: ServiceLogger;
}): CuaPipSessionService {
  const logger = options.logger ?? createServiceLogger("cua-pip-session");
  const clientFactory = options.createClient ?? createPipSessionClient;
  let current: {
    key: string;
    client: PipSessionClient;
  } | null = null;
  let disabledTransportKey: string | null = null;
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;
  /**
   * The `turn-started` lost by `credentials-unavailable` will be reissued when the credentials are available.
   *
   * PiP takes turn as scope and does not
   * There is no PiP window for `turn-started`. And it **must** predate Helper - Helper was created by the first CUA tool
   * Call lazy start, `turn-started` is sent at the beginning of turn; at this time, `resolveCredentials()` is neither
   * The host is managed and a stable socket cannot be detected (that path is probe-only and does not pull up), so undefined is returned.
   * Log evidence: turn-started(seq 3) → credentials-unavailable; then Helper starts up,
   * focus-changed(rev 11/12/13) all applied:true; turn-ended(seq 3862) →
   * applied:false/turn-mismatch. The passages are open, but the opening one is down.
   *
   * An earlier comment in this file stated that "In the past, turn-started was silently discarded, and PiP was permanently stuck in the last completed state."
   * But at that time, only the warn log was added, but not reissued. There is no second turn for a single prompt task, so the actual effect
   * It's PiP that never shows up.
   *
   * Only one cache is cached: the new turn-started directly replaces the old one (the old turn has passed, and it will only open one if it is reissued.
   * A turn that should have been closed long ago). The coordinator evaluates by `sequenceNumber`, so reissuance is idempotent.
   */
  let pendingTurnStarted: { event: PipSessionEvent; turnId: string } | null = null;
  /**
   * Reissue retry timer.
   *
   * Why can't you just wait for the "next event that happens to happen" to trigger a reissue?
   *   20:18:15.628 turn-started → credentials-unavailable (Helper has not started yet)
   *   20:18:23 Helper up → first capture_app → bindCapture → pending-turn
   *                 (Coordinator side PIP_SESSION_CAPTURE_PENDING_TTL_MS = 2s, expires about 20:18:25)
   *   20:18:30.420 The next event comes, and the reissue is successful applied:true - but it is 5 seconds late.
   * As a result, the capture temporarily stored when turn is opened has expired, captureAccepted is no longer triggered, and the window still does not open.
   *
   * Therefore, the credentials must be reissued as soon as they are available: a bounded polling is started while temporarily storing, and it stops when it hits. The interval is 250ms,
   * Far smaller than the 2s TTL of the coordinator; the upper limit of 30s covers Helper cold start (including the first TCC authorization dialog box).
   */
  let replayTimer: ReturnType<typeof setTimeout> | null = null;
  const REPLAY_RETRY_MS = 250;
  const REPLAY_DEADLINE_MS = 30_000;
  let replayDeadline = 0;

  const cancelReplayRetry = () => {
    if (replayTimer !== null) {
      clearTimeout(replayTimer);
      replayTimer = null;
    }
  };

  const getClient = async (): Promise<PipSessionClientResolution> => {
    if (!options.enabled) return { client: null, skipReason: "service-disabled" };
    if (disposed) return { client: null, skipReason: "service-disposed" };
    const credentials = await options.resolveCredentials();
    if (!credentials) return { client: null, skipReason: "credentials-unavailable" };
    const key = credentials.socketPath;
    if (disabledTransportKey === key) {
      return { client: null, skipReason: "transport-disabled" };
    }
    if (current?.key === key) return { client: current.client };
    current?.client.close();
    const client = clientFactory({
      socketPath: credentials.socketPath,
      onDiagnostic: (diagnostic) => {
        const message = `[cua-pip-session] ${diagnostic.code}: ${diagnostic.message}`;
        if (diagnostic.code === "version_mismatch") logger.warn(undefined, message);
        else logger.debug(undefined, message);
      },
    });
    current = { key, client };
    try {
      await client.connect();
      return { client };
    } catch (error) {
      if (current?.client === client) current = null;
      client.close();
      if ((error as { code?: unknown }).code === "version_mismatch") {
        disabledTransportKey = key;
      }
      throw error;
    }
  };

  /**
   * Bounded polling: Send the temporary turn-started as soon as the credentials are available, without waiting for the next event.
   * Serialized through the same `tail` to avoid race conditions with publish causing the reissue to be queued after the current event.
   */
  const scheduleReplayRetry = (): void => {
    cancelReplayRetry();
    if (disposed || pendingTurnStarted === null) return;
    if (Date.now() >= replayDeadline) {
      logger.warn(undefined, "[cua-pip-session] deferred turn-started expired before transport", {
        ...eventLogContext(pendingTurnStarted.event),
      });
      pendingTurnStarted = null;
      return;
    }
    replayTimer = setTimeout(() => {
      replayTimer = null;
      if (disposed || pendingTurnStarted === null) return;
      const operation = tail.then(async () => {
        if (disposed || pendingTurnStarted === null) return;
        let resolution;
        try {
          resolution = await getClient();
        } catch {
          // Connection failed (Helper has just started and has not listened yet): continue to wait for the next round.
          scheduleReplayRetry();
          return;
        }
        if (!resolution.client) {
          scheduleReplayRetry();
          return;
        }
        const replay = pendingTurnStarted;
        pendingTurnStarted = null;
        try {
          const result = await resolution.client.send(replay.event);
          logger.info(undefined, "[cua-pip-session] replayed deferred turn-started", {
            ...eventLogContext(replay.event),
            applied: result.applied,
            reason: result.reason,
          });
        } catch (error) {
          logger.warn(undefined, "[cua-pip-session] replay of deferred turn-started failed", {
            ...eventLogContext(replay.event),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      });
      tail = operation;
    }, REPLAY_RETRY_MS);
    // The poll timer is not supposed to keep the process alive: it's just waiting for a Helper that may never appear.
    replayTimer.unref?.();
  };

  const publish = (event: PipSessionEvent): Promise<void> => {
    if (disposed) return Promise.resolve();
    const operation = tail.then(async () => {
      try {
        const resolution = await getClient();
        if (!resolution.client) {
          if (
            resolution.skipReason === "credentials-unavailable" ||
            resolution.skipReason === "transport-disabled"
          ) {
            // Accounting (see the root cause of pendingTurnStarted): if turn-started is lost, wait until the credentials are available.
            // Reissue; if the turn-ended of the same turn is also lost, the cache will be invalidated - that turn is already in
            // Finishing the window without transmission, reissuance will only open a turn that should have been closed long ago.
            if (event.kind === "turn-started") {
              pendingTurnStarted = { event, turnId: event.turnId };
              replayDeadline = Date.now() + REPLAY_DEADLINE_MS;
              scheduleReplayRetry();
            } else if (
              (event.kind === "turn-ended" || event.kind === "session-closed") &&
              pendingTurnStarted !== null &&
              ("turnId" in event
                ? pendingTurnStarted.turnId === event.turnId
                : pendingTurnStarted.event.sessionId === event.sessionId)
            ) {
              pendingTurnStarted = null;
              cancelReplayRetry();
            }
            // Bug diagnosis: When the Helper is resident but the credential handover fails, turn-started and PiP will be lost silently in the past.
            // Permanently stops at the completion state of the previous round. There are only a constant number of life cycle events in each round, and the generated warn will not be flushed every frame.
            logger.warn(undefined, "[cua-pip-session] event delivery skipped", {
              ...eventLogContext(event),
              skipReason: resolution.skipReason,
            });
          } else {
            // service-disabled / service-disposed used to return completely silently,
            // Therefore, "not a single PiP event was sent" and "sent but rejected" are indistinguishable in the logs - they can only be inferred during troubleshooting.
            // Silent early departures all around the delivery chain. The life cycle events are constant in each round, and warn will not be flushed every frame.
            logger.warn(undefined, "[cua-pip-session] event delivery dropped", {
              ...eventLogContext(event),
              skipReason: resolution.skipReason,
            });
          }
          return;
        }
        // The credentials are in place: fill in the opening line first, so that the coordinator has an open turn to handle subsequent events.
        // It will not be reissued when the current event itself is turn-started (it has already cleared the cache).
        cancelReplayRetry();
        const replay = event.kind === "turn-started" ? null : pendingTurnStarted;
        pendingTurnStarted = null;
        if (replay !== null) {
          try {
            const replayed = await resolution.client.send(replay.event);
            logger.info(undefined, "[cua-pip-session] replayed deferred turn-started", {
              ...eventLogContext(replay.event),
              applied: replayed.applied,
              reason: replayed.reason,
            });
          } catch (error) {
            // Failure to reissue cannot bring down the current event: the current event still needs to be sent, or at worst it will fall back to a turn-mismatch.
            logger.warn(undefined, "[cua-pip-session] replay of deferred turn-started failed", {
              ...eventLogContext(replay.event),
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const result = await resolution.client.send(event);
        // Bug diagnosis: PiP group cutting spans the three processes of Main, Host, and broker; success and idempotence reject ACK if only writing
        // debug, production package cannot distinguish between turn-started not sent and stale-sequence/turn-mismatch.
        // This is a low-frequency life cycle log that does not record screenshots, tokens or prompts, and can be safely retained in the production environment.
        logger.info(undefined, "[cua-pip-session] event delivery acknowledged", {
          ...eventLogContext(event),
          applied: result.applied,
          reason: result.reason,
        });
      } catch (error) {
        logger.warn(undefined, "[cua-pip-session] event delivery failed", {
          ...eventLogContext(event),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    });
    tail = operation;
    return operation;
  };

  return {
    publishFocus: publish,
    publishLifecycle: publish,
    dispose() {
      disposed = true;
      cancelReplayRetry();
      pendingTurnStarted = null;
      current?.client.close();
      current = null;
    },
  };
}
