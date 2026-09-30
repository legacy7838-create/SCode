/* An adapter-layer special case for the off-peak (idle-time task) queue protocol.
   The semantics apply only to requests whose Model Config explicitly declares the off-peak-queue protocol — business codes 3105/3102
   may mean something else in other bigmodel APIs, so they must never be written into the global failure-provider-business-codes mapping.

   - 429 (including business code 3105) = a queue acknowledgement: a single wait clamped to min(Retry-After, 5min) x unbounded idempotent probing;
     the caller freezes the attempt budget (otherwise the default 11 attempts get misjudged as an API failure); abort runs through the sleep.
   - 400/3102 = ticket unavailable (active 3h expiry / a dead ready ticket): fail immediately with a stable marker; the
     desktop end recognizes the marker and switches to "refetch the number for the same task_id, then resume and keep running", not an ordinary failure.
   - Abandoning the first dispatch is not implemented at the adapter layer: when the first dispatch hangs at the gateway, the ready 5min
     TTL expires on its own and naturally triggers 3102, the resumed run re-enters the queue, and the wait bound ≈ TTL + one clamped probe
     ≤ 10min, which satisfies the intent of the rule while keeping one less set of state. */
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isProviderBusinessError } from "./model-execution.js";

/**
 * ⚠ Kept at the same value across packages with the same-named constant on the desktop side in @zcode/shared/src/off-peak-types.ts (a wire contract):
 * the providerId is injected along with the per-turn runtimeModel, and the error marker travels back in the task's terminal error text, so a change must be made on both sides.
 */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";

/** The clamp for a single queue wait: min(Retry-After, 5min); without a Retry-After, probe conservatively at 60s. */
const OFF_PEAK_QUEUE_WAIT_CAP_MS = 5 * 60_000;
const OFF_PEAK_QUEUE_WAIT_DEFAULT_MS = 60_000;

type OffPeakFailureDecision = { kind: "queued"; delayMs: number } | { kind: "ticketExpired" };

/**
 * Decide whether a failure carries off-peak-specific semantics; any non-idle-plan provider returns null unconditionally (zero impact).
 * error must be the original error after unwrapRetryError (only a ProviderBusinessError exposes the business code).
 */
export function resolveOffPeakFailureDecision(params: {
  offPeak: boolean;
  failure: ClassifiedModelFailure;
  error: unknown;
}): OffPeakFailureDecision | null {
  if (!params.offPeak) return null;
  const businessCode = isProviderBusinessError(params.error)
    ? params.error.providerCode
    : undefined;
  // Server-side latest contract uses 3102; retain 3001 for compatibility with old gateway responses during rolling releases.
  if (businessCode === "3102" || businessCode === "3001") {
    return { kind: "ticketExpired" };
  }
  // Queued real signal = HTTP 429 (3105 with Retry-After); naked 429 without business code is also processed as queued.
  if (businessCode === "3105" || params.failure.statusCode === 429) {
    return {
      kind: "queued",
      delayMs: Math.min(
        params.failure.retryAfterMs ?? OFF_PEAK_QUEUE_WAIT_DEFAULT_MS,
        OFF_PEAK_QUEUE_WAIT_CAP_MS,
      ),
    };
  }
  return null;
}

export function offPeakTicketExpiredMessage(original: string): string {
  return `${OFF_PEAK_TICKET_EXPIRED_MARKER}: ${original}`;
}
