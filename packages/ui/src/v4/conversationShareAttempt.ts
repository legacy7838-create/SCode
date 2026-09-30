import type { ConversationShareAttempt } from "@/store/conversationShareSelectionStore.js";

export type { ConversationShareAttempt } from "@/store/conversationShareSelectionStore.js";

interface ConversationShareAttemptIdFactory {
  now?: () => number;
  randomUUID?: () => string | undefined;
}

export function ensureConversationShareAttempt(
  current: ConversationShareAttempt | null,
  attemptKey: string,
  sessionId: string,
  factory: ConversationShareAttemptIdFactory = {},
): ConversationShareAttempt {
  if (current?.key === attemptKey) return current;

  const now = factory.now ?? Date.now;
  const disclosureAcceptedAt = now();
  const requestSuffix = factory.randomUUID?.() ?? `${sessionId}-${disclosureAcceptedAt}`;

  // The same idempotent request body must be reused when retrying. Previously, only clientRequestId was reused.
  // However, disclosureAcceptedAt is regenerated every time the SessionPane is clicked, causing payload_sha256 to change.
  // The server identifies the same idempotent key as a request body conflict and returns 409.
  return {
    key: attemptKey,
    clientRequestId: `share-${requestSuffix}`,
    disclosureAcceptedAt,
  };
}
