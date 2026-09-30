// Command Envelope Factory.
// commandId = uuid v7 (time-ordered, unchanged on retries); clientId is stable and persistent for each client instance,
// Both the server-side idempotent table and the display of pendingCommands use it to distinguish the submitting side.
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";
import { uuidv7 } from "@zcode/shared";
export { uuidv7 } from "@zcode/shared";

const CLIENT_ID_STORAGE_KEY = "zcode-v4-client-id:v1";
let cachedClientId: string | null = null;

/**
 * The stable clientId of this client instance. localStorage persistence is preferred (it survives a
 * refresh, so the idempotency table can still recognize retries across refreshes); in environments
 * without storage it degrades to a stable value for the lifetime of the process.
 */
export function getV4ClientId(): string {
  if (cachedClientId) return cachedClientId;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  } catch {
    // The incognito/node test environment has no localStorage and degrades to memory cache.
  }
  const clientId = stored ?? `client-${uuidv7()}`;
  if (!stored) {
    try {
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
    } catch {
      // Same as above, ignore
    }
  }
  cachedClientId = clientId;
  return clientId;
}

interface CreateCommandEnvelopeInput<T extends CommandType> {
  type: T;
  payload: CommandPayloadMap[T];
  /** null while createSession is in flight. */
  sessionId: string | null;
  baseRevision?: number;
  baseLogEpoch?: string;
}

/**
 * Builds the command envelope; a CAS command missing baseRevision throws outright (a client
 * programming error surfaces right where it happens).
 */
export function createCommandEnvelope<T extends CommandType>(
  input: CreateCommandEnvelopeInput<T>,
): CommandEnvelope {
  if (COMMANDS_REQUIRING_BASE_REVISION.has(input.type) && input.baseRevision === undefined) {
    throw new Error(`command ${input.type} is a CAS command and must carry baseRevision`);
  }
  if (ROW_TARGETING_COMMANDS.has(input.type) && !input.baseLogEpoch) {
    throw new Error(`command ${input.type} is a row target command and must carry baseLogEpoch`);
  }
  return {
    commandId: uuidv7(),
    clientId: getV4ClientId(),
    sessionId: input.sessionId,
    ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
    ...(input.baseLogEpoch ? { baseLogEpoch: input.baseLogEpoch } : {}),
    type: input.type,
    payload: input.payload,
    issuedAt: Date.now(),
  };
}
