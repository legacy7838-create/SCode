import type {
  V4InteractionAnswer,
  V4InteractionRegistrationOptions,
} from "../zcode-protocol-v4/interaction-registry.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * Races the legacy reverse RPC (interaction/requestPermission and the like) against the v4 resolveInteraction command:
 * whichever delivers its answer first takes effect.
 *
 * The implementation is "await the RPC as the primary, cancel the RPC when v4 hits":
 * - register the interactionId in v4Interactions (= the business requestId, the same source as
 *   v4's projected PendingInteraction.interactionId); when the v4 answer arrives, record it and abort the internal
 *   controller, making requestClient reject with ProtocolRequestError(-32021).
 * - in the catch, if a v4 answer already exists, return the mapped result (swallowing the cancellation error); otherwise rethrow
 *   as-is (including a cancellation triggered by the caller's outerSignal), keeping the old path's error semantics unchanged.
 * - the finally uniformly deregisters + removes the outerSignal listener, and a late v4 answer counts as a miss
 *   (the resolveInteraction handler closes idempotently).
 */
export async function raceClientRequestWithV4Interaction<T>(
  context: ZCodeProtocolAgentServerContext,
  interactionId: string,
  outerSignal: AbortSignal | undefined,
  startRequest: (signal: AbortSignal) => Promise<T>,
  mapAnswer: (answer: V4InteractionAnswer) => T,
  registrationOptions?: V4InteractionRegistrationOptions,
): Promise<T> {
  const controller = new AbortController();
  // Each attempt independently waits for failure notification; success is still released by the registry's V4 answer.
  // Simply resetting the Boolean value will not wake up the legacy response that has been awaited; reusing the one-time notification will allow retries to be released in advance.
  let fullAccessFailure: Promise<void> | undefined;
  let finishAnswer!: () => void;
  const answerReady = new Promise<void>((resolve) => {
    finishAnswer = resolve;
  });
  const forwardAbort = () => {
    controller.abort();
    finishAnswer();
  };
  if (outerSignal?.aborted) {
    controller.abort();
  } else {
    outerSignal?.addEventListener("abort", forwardAbort, { once: true });
  }

  // Use containers rather than raw values ​​to distinguish "response is an undefined field" from "not yet answered".
  let v4Answer: { answer: V4InteractionAnswer } | undefined;
  const unregister = context.v4Interactions.register(
    interactionId,
    (answer) => {
      v4Answer = { answer };
      controller.abort();
      finishAnswer();
    },
    registrationOptions?.fullAccess
      ? {
          ...registrationOptions,
          fullAccess: async () => {
            let notifyFailure!: () => void;
            const failure = new Promise<void>((resolve) => {
              notifyFailure = resolve;
            });
            fullAccessFailure = failure;
            try {
              await registrationOptions.fullAccess!();
            } catch (error) {
              if (fullAccessFailure === failure) fullAccessFailure = undefined;
              notifyFailure();
              throw error;
            }
          },
        }
      : registrationOptions,
  );

  const waitForFullAccess = async () => {
    while (fullAccessFailure && !v4Answer && !outerSignal?.aborted) {
      await Promise.race([fullAccessFailure, answerReady]);
    }
  };

  try {
    const result = await startRequest(controller.signal);
    if (fullAccessFailure) {
      await waitForFullAccess();
      if (v4Answer) return mapAnswer(v4Answer.answer);
      outerSignal?.throwIfAborted();
    }
    return result;
  } catch (error) {
    if (fullAccessFailure) await waitForFullAccess();
    if (v4Answer) {
      return mapAnswer(v4Answer.answer);
    }
    throw error;
  } finally {
    unregister();
    outerSignal?.removeEventListener("abort", forwardAbort);
  }
}
