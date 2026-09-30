import { useEffect, useRef } from "react";
import type { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";

const SESSION_SUBSCRIPTION_ERROR_SURFACE = "session_subscription_error";
const FALLBACK_SUBSCRIPTION_ERROR_CODE = "fault.subscribe.unknown";
const STANDALONE_REASON_CODE_PATTERN = /^fault\.[A-Za-z0-9._-]+$/;
const SUFFIX_REASON_CODE_PATTERN = /\((fault\.[A-Za-z0-9._-]+)\)\s*$/;

type SubscriptionErrorReporter = Pick<ConversationTelemetrySupervisor, "reportVisibleChatError">;

function resolveSessionSubscriptionErrorCode(message: string): string {
  const trimmedMessage = message.trim();
  // Bug reason: recovery fail-closed will write pure reasonCode directly into lastError, and the old logic will only recognize
  // "Body (reasonCode)" form, causing structured errors to be incorrectly aggregated into fault.subscribe.unknown.
  return (
    STANDALONE_REASON_CODE_PATTERN.exec(trimmedMessage)?.[0] ??
    SUFFIX_REASON_CODE_PATTERN.exec(trimmedMessage)?.[1] ??
    FALLBACK_SUBSCRIPTION_ERROR_CODE
  );
}

export function useSessionSubscriptionErrorTelemetry(params: {
  supervisor: SubscriptionErrorReporter | null;
  sessionId: string | null;
  lastError: string | null;
  visible: boolean;
}): void {
  const reportedKeysRef = useRef(new Set<string>());

  useEffect(() => {
    if (!params.visible || !params.supervisor || !params.sessionId || !params.lastError) {
      return;
    }
    const errorCode = resolveSessionSubscriptionErrorCode(params.lastError);
    const errorKey = `${params.sessionId}:${errorCode}:${params.lastError}`;
    if (reportedKeysRef.current.has(errorKey)) return;
    reportedKeysRef.current.add(errorKey);

    // Reason for the bug: ErrorBoundary will no longer be thrown after subscription failure is converged into visible error state by the store.
    // It also bypasses Composer’s error banner embedding; chat_error_banner is reused here to complete the real visible exposure.
    params.supervisor.reportVisibleChatError({
      surface: SESSION_SUBSCRIPTION_ERROR_SURFACE,
      errorKey,
      displayMessage: params.lastError,
      error: {
        code: errorCode,
        message: params.lastError,
        taskId: params.sessionId,
      },
    });
  }, [params.lastError, params.sessionId, params.supervisor, params.visible]);
}
