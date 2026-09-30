/* Client for the five off-peak server endpoints.
   It only covers the four JSON endpoints — quota snapshot / ticket take / batch status / settle — calling a model with messages does not go through here
   (the idle plan per-turn provider connects directly inside the agent process).
   No built-in retry: queueing / backoff semantics live in the caller (offPeakTaskService polling / the adapter layer). */
import { z } from "zod";
import type { OffPeakTakeNumberAvailability } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  withRequestIdHeader,
  REQUEST_ID_HEADER_NAME,
} from "#src/providers/api/requestIdHeaders.js";
import { buildZCodeSourceHeaders } from "#src/providers/sourceHeaders.js";
import {
  buildOffPeakPlanIdentityHeaders,
  type OffPeakCredentialSnapshot,
} from "./offPeakRuntimeModel.js";

/** Server-side admission state (the server axis of the two-axis state machine). */
export const offPeakTicketStateSchema = z.enum([
  "queued",
  "ready",
  "active",
  "expired",
  "settled",
  "not_found",
]);
export type OffPeakTicketState = z.infer<typeof offPeakTicketStateSchema>;

// The response field snake_case is based on server v2; it is parsed tolerantly (loose), and no error is reported for unknown fields.
// ⚠ next_poll_after unit is implemented in "seconds" (same convention as Retry-After).
const takeTicketResponseSchema = z
  .object({
    ticket_id: z.string().min(1),
    task_id: z.string().optional(),
    state: offPeakTicketStateSchema,
    accepted: z.boolean().optional(),
    // The server only returns numbers in the queued state, and will explicitly return null after entering the ready/active state;
    // This accepts null and normalizes it to the field default when mapping the domain model to avoid the entire batch of state synchronization being interrupted by parsing failure.
    position: z.number().int().nonnegative().nullish(),
    next_poll_after: z.number().nonnegative().optional(),
    queued_at: z.number().optional(),
    ready_deadline: z.number().optional(),
  })
  .passthrough();

const ticketStatusEntrySchema = z
  .object({
    ticket_id: z.string().min(1),
    task_id: z.string().optional(),
    state: offPeakTicketStateSchema,
    position: z.number().int().nonnegative().nullish(),
    active_deadline: z.number().optional(),
  })
  .passthrough();

const batchStatusResponseSchema = z
  .object({
    next_poll_after: z.number().nonnegative().optional(),
    tickets: z.array(ticketStatusEntrySchema).default([]),
  })
  .passthrough();

const settleResponseSchema = z
  .object({
    ticket_id: z.string().min(1).optional(),
    task_id: z.string().optional(),
    state: z.string().optional(),
    settled_at: z.number().optional(),
  })
  .passthrough();

const takeNumberAvailabilityResponseSchema = z
  .object({
    can_take_number: z.boolean(),
    next_take_at: z.number().int().positive().optional(),
  })
  .passthrough();

/** Business error body (parsed best-effort on non-2xx HTTP; the zai gateway convention is code/msg, missing fields tolerated). */
const errorBodySchema = z
  .object({
    code: z.number().optional(),
    msg: z.string().optional(),
    message: z.string().optional(),
    next_take_at: z.number().optional(),
    data: z
      .object({ next_take_at: z.number().int().positive().optional() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export interface OffPeakTakeTicketResult {
  ticketId: string;
  state: OffPeakTicketState;
  position?: number;
  /** Next poll interval (milliseconds; the server sends seconds, already converted here). */
  nextPollAfterMs?: number;
  registeredAt: number;
}

export interface OffPeakTicketStatusEntry {
  ticketId: string;
  state: OffPeakTicketState;
  position?: number;
  activeDeadline?: number;
}

export interface OffPeakBatchStatusResult {
  nextPollAfterMs?: number;
  tickets: OffPeakTicketStatusEntry[];
}

/** Typed server error: callers branch on bizCode (3101 no eligibility / 3103 take-number limit exceeded / everything else). */
export class OffPeakServerError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly bizCode?: number,
    readonly nextTakeAt?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "OffPeakServerError";
  }
}

interface OffPeakServerClientDeps {
  /** API origin (real server or mock gateway, with the ZCODE_OFFPEAK_MOCK switch handled at the wiring layer); the mock gateway starts lazily, so async is allowed. */
  resolveOrigin: () => string | Promise<string>;
  /** Credential snapshot: all four ticket endpoints carry the same selected credential snapshot. */
  resolveCredentials: () => Promise<OffPeakCredentialSnapshot>;
  fetchImpl?: typeof fetch;
  logger: ServiceLogger;
}

const REQUEST_TIMEOUT_MS = 10_000;

export interface OffPeakServerClient {
  getTakeNumberAvailability(): Promise<OffPeakTakeNumberAvailability>;
  takeTicket(taskId: string): Promise<OffPeakTakeTicketResult>;
  batchStatus(ticketIds: string[]): Promise<OffPeakBatchStatusResult>;
  settle(ticketId: string): Promise<void>;
}

export function createOffPeakServerClient(deps: OffPeakServerClientDeps): OffPeakServerClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const credentials = await deps.resolveCredentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const origin = await deps.resolveOrigin();
      // This client uses fetch directly, bypassing the source header and request id injection of NodeApiClient in the past;
      // The test server can only see user_agent=node, and the client log cannot be associated with the server request of 2007/naked 429.
      // Only the standard non-sensitive source header and link id are added here, and JWT/API Key is still prohibited from entering the log.
      const headers = withRequestIdHeader({
        ...buildZCodeSourceHeaders(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        authorization: `Bearer ${credentials.jwt}`,
        "x-coding-plan-api-key": credentials.codingPlanApiKey,
        ...buildOffPeakPlanIdentityHeaders(credentials),
      });
      const response = await fetchImpl(`${origin}/api/v1/off-peak${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      const json: unknown = text ? safeJsonParse(text) : {};
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(json);
        const errorBody = parsed.success ? parsed.data : {};
        const requestId =
          response.headers.get(REQUEST_ID_HEADER_NAME)?.trim() ||
          headers.get(REQUEST_ID_HEADER_NAME)?.trim() ||
          undefined;
        // Recoverable servers refuse to use warn; only contract metadata is recorded, and the original voucher text, fingerprint or response body is prohibited from being recorded.
        deps.logger.warn(undefined, "off-peak request rejected", {
          bizCode: errorBody.code,
          credentialKind: credentials.kind,
          httpStatus: response.status,
          method,
          path,
          requestId,
        });
        throw new OffPeakServerError(
          `off-peak ${path} failed: HTTP ${response.status}${errorBody.code ? ` code=${errorBody.code}` : ""}${(errorBody.msg ?? errorBody.message) ? ` ${errorBody.msg ?? errorBody.message}` : ""}`,
          response.status,
          errorBody.code,
          errorBody.next_take_at ?? errorBody.data?.next_take_at,
          requestId,
        );
      }
      // Compatible with both naked and {code:0,data} envelope forms (v2 documents are naked; gateway convention may include envelopes).
      if (
        json &&
        typeof json === "object" &&
        "data" in json &&
        (json as { code?: number }).code === 0
      ) {
        return (json as { data: unknown }).data;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getTakeNumberAvailability() {
      const raw = await request("GET", "/ticket/availability");
      const parsed = takeNumberAvailabilityResponseSchema.parse(raw);
      // A false snapshot that lacks recovery time will prevent the UI from being able to schedule a recheck, creating a permanent gray state again.
      // The contract requires that false must bring next_take_at; dirty responses are handled as query failures, and are covered by UI fail-open and POST /ticket.
      if (!parsed.can_take_number && parsed.next_take_at === undefined) {
        throw new Error("off-peak availability missing next_take_at while unavailable");
      }
      return {
        canTakeNumber: parsed.can_take_number,
        ...(parsed.next_take_at !== undefined ? { nextTakeAt: parsed.next_take_at } : {}),
      };
    },
    async takeTicket(taskId) {
      const raw = await request("POST", "/ticket", { task_id: taskId });
      const parsed = takeTicketResponseSchema.parse(raw);
      deps.logger.info(
        undefined,
        `off-peak take ticket ok task=${taskId} ticket=${parsed.ticket_id} state=${parsed.state} position=${parsed.position ?? "-"}`,
      );
      return {
        ticketId: parsed.ticket_id,
        state: parsed.state,
        ...(parsed.position != null ? { position: parsed.position } : {}),
        ...(parsed.next_poll_after !== undefined
          ? { nextPollAfterMs: parsed.next_poll_after * 1000 }
          : {}),
        registeredAt: Date.now(),
      };
    },
    async batchStatus(ticketIds) {
      if (ticketIds.length === 0) return { tickets: [] };
      // The upper limit of the contract is ≤100; the caller's listNonTerminal is much smaller than this, and if it exceeds the limit, it will truncate and warn instead of unpacking.
      // Before the number of non-terminal tasks for a single user reaches 100, the upper limit of number retrieval on the server has been blocked.
      const limited = ticketIds.slice(0, 100);
      if (limited.length < ticketIds.length) {
        deps.logger.warn(`off-peak batch status truncated ${ticketIds.length} -> 100`);
      }
      const raw = await request("POST", "/ticket/status", {
        ticket_ids: limited,
      });
      const parsed = batchStatusResponseSchema.parse(raw);
      return {
        ...(parsed.next_poll_after !== undefined
          ? { nextPollAfterMs: parsed.next_poll_after * 1000 }
          : {}),
        tickets: parsed.tickets.map((entry) => ({
          ticketId: entry.ticket_id,
          state: entry.state,
          ...(entry.position != null ? { position: entry.position } : {}),
          ...(entry.active_deadline !== undefined ? { activeDeadline: entry.active_deadline } : {}),
        })),
      };
    },
    async settle(ticketId) {
      // Idempotent: Repeated reports/unknown votes are always 2xx; no body.
      const raw = await request("POST", `/ticket/${encodeURIComponent(ticketId)}/settle`);
      settleResponseSchema.parse(raw);
      deps.logger.info(undefined, `off-peak settle acked ticket=${ticketId}`);
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
