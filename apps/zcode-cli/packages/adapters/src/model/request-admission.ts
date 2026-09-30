import type {
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";

/**
 * Admission for a single attempt.
 *
 * The runner calls `admitAttempt` **before issuing** each attempt and only sends the request once it holds a
 * ticket; `release` happens when the attempt ends (success, failure, a throw, or the consumer abandoning the
 * stream early). No ticket is held during the backoff sleep, so the process-level cap bounds the number of
 * in-flight requests the provider actually sees. The ticket is also the status-event sink for that attempt:
 * `publishModelStatus` delivers that attempt's events to it as well (see
 * `statusPublishOptions`), and the governor decides the outcome from them; `release` is only a fallback and is
 * idempotent.
 *
 * When a request has no `modelRequestAdmission`, return a no-op implementation: call sites do not have to
 * branch, and runner behavior stays literally unchanged.
 */
export interface AttemptAdmission {
  /** Admission ticket; absent when the request has no admission port (publish then does not forward). */
  readonly ticket?: ModelRequestAdmissionTicket;
  /** Return the slot; idempotent (called both from the finally block and before the backoff sleep). */
  release(): void;
}

const NO_ADMISSION: AttemptAdmission = { release() {} };

/**
 * Wait for admission. Try the synchronous fast path `tryAcquire` first; only on a miss queue up with `acquire`,
 * invoking `onQueued` / `onAdmitted` at the two ends (the runner emits
 * `model_request_queued` / `model_request_admitted` from them). A port without a fast path cannot tell
 * "queued" apart from "let through immediately", so it does not call back. Rejects when `signal` is aborted
 * (with `signal.reason`, the same shape as `sleep`'s abort error, classified as cancelled by the caller).
 */
export async function admitAttempt(input: {
  admission?: ModelRequestAdmission;
  model: ModelRequestTarget;
  signal?: AbortSignal;
  onQueued?: () => Promise<void>;
  onAdmitted?: (queuedMs: number) => Promise<void>;
}): Promise<AttemptAdmission> {
  if (input.admission === undefined) return NO_ADMISSION;
  const hasFastPath = typeof input.admission.tryAcquire === "function";
  let ticket = hasFastPath ? input.admission.tryAcquire!({ model: input.model }) : undefined;
  if (ticket === undefined) {
    const queuedAt = Date.now();
    if (hasFastPath) await input.onQueued?.();
    ticket = await input.admission.acquire({
      model: input.model,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (hasFastPath) await input.onAdmitted?.(Date.now() - queuedAt);
  }
  let released = false;
  return {
    ticket,
    release() {
      if (released) return;
      released = true;
      ticket.release();
    },
  };
}
