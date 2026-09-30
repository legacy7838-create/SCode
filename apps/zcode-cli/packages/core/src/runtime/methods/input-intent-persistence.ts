import type { TurnInputIntentMetadata } from "../deps.js";

/**
 * Assemble the runtime's protocol-independent parameters into the complete input fact shared by the
 * transcript/ledger.
 *
 * If only text and a set of metadata were saved separately, the recovery side would have to infer delivery,
 * steer and dispatch all over again, which easily lets the live projection and the cold snapshot end up in
 * different states. Here they are fixed once at the
 * admission/drain boundary, and later consumers may only read them, never re-guess.
 */
export function buildPersistedConversationInputIntent(
  text: string,
  intent: TurnInputIntentMetadata | undefined,
  dispatchState: "queued" | "drained",
): Record<string, unknown> | undefined {
  if (!intent) return undefined;

  const steer = intent.fallbackReasonCode
    ? { state: "fellBack", reasonCode: intent.fallbackReasonCode }
    : intent.admittedDelivery === "guide"
      ? { state: dispatchState === "drained" ? "guided" : "steering" }
      : { state: "notRequested" };

  return {
    sourceCommandId: intent.sourceCommandId,
    queueItemId: intent.queueItemId,
    clientId: intent.clientId,
    kind: intent.kind,
    // The message text of goal can be `/goal...` to display the copy; admission has runtime
    // Parsed canonical objective, persistence must use it first to ensure live/cold equivalence.
    text: intent.text ?? text,
    attachments: intent.attachmentRefs ?? [],
    ...(intent.modelSelection ? { modelSelection: intent.modelSelection } : {}),
    ...(intent.mode ? { mode: intent.mode } : {}),
    ...(intent.planEnabled !== undefined ? { planEnabled: intent.planEnabled } : {}),
    ...(intent.sharedContextRefs ? { sharedContextRefs: intent.sharedContextRefs } : {}),
    delivery: {
      requested: intent.requestedDelivery,
      admitted: intent.admittedDelivery,
      ...(intent.fallbackReasonCode ? { fallbackReasonCode: intent.fallbackReasonCode } : {}),
    },
    order: {
      admissionSeq: intent.admissionSeq,
      ...(intent.queuePosition !== undefined ? { queuePosition: intent.queuePosition } : {}),
    },
    steer,
    dispatch: { state: dispatchState },
    admittedAt: intent.admittedAt,
    ...(intent.provenance ? { provenance: intent.provenance } : {}),
  };
}
