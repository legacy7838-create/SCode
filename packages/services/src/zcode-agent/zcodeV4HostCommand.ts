// Host (services-layer) v4 command envelope construction and ACK handling shared code (send/interactive receipt convergence).
//
// Parallel to the renderer's packages/ui/src/v4/commandFactory.ts: the renderer uses a browser
// localStorage-persisted clientId; the host process uses a stable in-process clientId (host restart = new submitter;
// Idempotent tables with commandId as key are not affected). Not merged into one implementation because the ui package cannot depend on services in reverse.
import { randomBytes } from "node:crypto";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  type CommandAck,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** uuid v7 (RFC 9562): 48-bit Unix ms timestamp + 74-bit random; isomorphic to the renderer factory. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  let hex = "";
  for (const byte of bytes) hex += HEX[byte];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable clientId of the host services process; pendingCommands display and the idempotency table use it to tell submitters apart. */
const hostV4ClientId = `host-services-${uuidv7()}`;

interface CreateHostCommandEnvelopeInput<T extends CommandType> {
  type: T;
  payload: CommandPayloadMap[T];
  /** null when creating a session. */
  sessionId: string | null;
  /**
   * Idempotency key. Mobile replayable send_prompt uses the inputId (=traceId) as the commandId:
   * on the CLI side sendText starts a turn with the commandId as the inputId, so only the inputId of
   * the terminal event can reconcile with the traceId in the host command queue
   * (inputId→commandId alignment). Defaults to a generated uuid v7 (one-shot commands such as
   * stop/resolveInteraction).
   */
  commandId?: string;
  /** Mobile replayable keeps the original submitting clientId; defaults to the host process's stable id. */
  clientId?: string;
  baseRevision?: number;
  baseLogEpoch?: string;
}

/** Builds the host-side command envelope; CAS commands throw in place when baseRevision is missing. */
export function createHostCommandEnvelope<T extends CommandType>(
  input: CreateHostCommandEnvelopeInput<T>,
): CommandEnvelope {
  if (COMMANDS_REQUIRING_BASE_REVISION.has(input.type) && input.baseRevision === undefined) {
    throw new Error(`command ${input.type} is a CAS command and must carry baseRevision`);
  }
  if (ROW_TARGETING_COMMANDS.has(input.type) && !input.baseLogEpoch) {
    throw new Error(`command ${input.type} is a row target command and must carry baseLogEpoch`);
  }
  return {
    commandId: input.commandId ?? uuidv7(),
    clientId: input.clientId ?? hostV4ClientId,
    sessionId: input.sessionId,
    ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
    ...(input.baseLogEpoch ? { baseLogEpoch: input.baseLogEpoch } : {}),
    type: input.type,
    payload: input.payload,
    issuedAt: Date.now(),
  };
}

/** The server vetoed the v4 command (rejected/stale/failed). The code lets callers branch structurally and does not match error text. */
class ZCodeV4CommandRejectedError extends Error {
  readonly code = "ZCODE_V4_COMMAND_REJECTED";

  constructor(
    readonly commandType: CommandType,
    readonly ack: CommandAck,
    contextMessage: string,
  ) {
    super(
      `v4 command ${commandType} ${ack.status}` +
        `${ack.reasonCode ? ` (${ack.reasonCode})` : ""}` +
        `${ack.message ? `: ${ack.message}` : ""} — ${contextMessage}`,
    );
    this.name = "ZCodeV4CommandRejectedError";
  }
}

/**
 * ACK error mapping (legacy op throw semantics → the six v4 states):
 * - accepted: converged normally; duplicate: a retry replay under the same commandId, an idempotent success;
 * - noop: a late reply / already converged, an idempotent success (first-wins semantics for resolveInteraction);
 * - rejected/stale/failed: throw a structured error, carrying reasonCode through to the caller verbatim.
 */
export function assertV4CommandAckOk(
  commandType: CommandType,
  ack: CommandAck,
  contextMessage: string,
): CommandAck {
  if (ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop") {
    return ack;
  }
  throw new ZCodeV4CommandRejectedError(commandType, ack, contextMessage);
}

/**
 * Host-side submission of CAS commands (configuration writes pushed down): host services has no
 * local v4 projection and cannot obtain the current conversation revision — "a stale ACK always
 * carries revisionAtDecision" converges the retry with the latest revision reported by the server,
 * isomorphic to the renderer's dispatchConfigCas (packages/ui/src/v4/SessionPane.tsx). The first
 * send uses baseRevision=0 as a probe, so the typical path hits stale on the first try; each attempt
 * uses a new commandId (a stale verdict never enters the idempotency table, so this is semantically
 * equivalent and avoids ambiguity). The legacy facade never carried expectedRevision (no CAS), so
 * stale here only means concurrent progress rather than a conflict, and the retry is the faithful
 * "CAS-less submission" semantics; exhausting the attempts only happens under pathological
 * concurrency and is surfaced as a rejection.
 */
export async function sendHostCasCommandV4<T extends CommandType>(input: {
  send: (envelope: CommandEnvelope) => Promise<CommandAck>;
  type: T;
  payload: CommandPayloadMap[T];
  sessionId: string;
  contextMessage: string;
  maxAttempts?: number;
}): Promise<CommandAck> {
  const maxAttempts = input.maxAttempts ?? 4;
  let baseRevision = 0;
  let lastAck: CommandAck | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ack = await input.send(
      createHostCommandEnvelope({
        type: input.type,
        payload: input.payload,
        sessionId: input.sessionId,
        baseRevision,
      }),
    );
    if (ack.status === "stale") {
      lastAck = ack;
      baseRevision = ack.revisionAtDecision;
      continue;
    }
    return assertV4CommandAckOk(input.type, ack, input.contextMessage);
  }
  throw new ZCodeV4CommandRejectedError(
    input.type,
    lastAck ?? {
      commandId: "",
      status: "stale",
      revisionAtDecision: baseRevision,
    },
    `${input.contextMessage} (repeatedly stale, giving up on retries)`,
  );
}
