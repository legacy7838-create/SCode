import {
  resolveTelemetryModelId,
  resolveTelemetryProviderScope,
  type ArmsCustomEventPayload,
  type IPlatformService,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  getProviderBusinessErrorUiAction,
  isProviderBusinessErrorCode,
  type ProviderBusinessErrorUiAction,
} from "@/lib/providerBusinessError.js";
import { resolveTelemetryAttribution } from "@/lib/chatErrorAttribution.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

const CHAT_ERROR_BANNER_ARMS_EVENT_NAME = "chat_error_banner";
const CHAT_ERROR_BANNER_ARMS_GROUP = "ui_error";
export type ChatErrorBannerSurface = "chat_input_error_banner" | "session_subscription_error";

const CHAT_ERROR_BANNER_MESSAGE_LIMIT = 500;

function sanitizeUnderlyingTelemetryText(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  // The underlying message may contain authentication headers or raw responses, and the telemetry privacy boundary cannot be bypassed by adding diagnostic fields.
  // Only the reported copy is affected; error display, classification and local details still use the original values.
  if (
    /authorization|\b(?:bearer|basic)\s+\S+|(?:https?|wss?|file):\/\/|(?:api[_-]?key|token|password|secret)\s*["']?\s*[:=]|<(?:html|body|script|form|!doctype)\b/i.test(
      value,
    )
  ) {
    return "sensitive error redacted";
  }
  return truncateTelemetryText(value);
}

// The provider/model whitelist and normalization implementation has converged to @zcode/shared's telemetryRedaction:
// Events such as plan_usage and ui_perf reuse the same whitelist to prevent multiple copies from drifting.

interface ChatProviderBusinessRecoveryAction {
  kind: ProviderBusinessErrorUiAction;
  providerBusinessCode: string;
}

export function resolveVisibleChatErrorTelemetryRecoveryAction(
  error: Pick<ZCodeUiError, "code" | "message">,
): ChatProviderBusinessRecoveryAction | null {
  // Reason for repair: The old UI will report the visible recovery actions of common provider business errors as aggregate dimensions;
  // Business codes with no visible actions (such as 3007/3001) will naturally return null here, and the action dimensions will no longer be reported.
  if (!isProviderBusinessErrorCode(error.code)) {
    return null;
  }
  const kind = getProviderBusinessErrorUiAction(error.code);
  return kind ? { kind, providerBusinessCode: error.code } : null;
}

function truncateTelemetryText(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value.length > CHAT_ERROR_BANNER_MESSAGE_LIMIT
    ? value.slice(0, CHAT_ERROR_BANNER_MESSAGE_LIMIT)
    : value;
}

function normalizeTelemetryKeyPart(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.replace(/[:\s]+/g, "_").slice(0, 128);
}

function hashTelemetryFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function resolveErrorKey(params: {
  errorKey?: string | null;
  error: ZCodeUiError;
  displayMessage: string;
  providerBusinessRecoveryAction: ChatProviderBusinessRecoveryAction | null;
}): string {
  const providerBusinessRecoveryAction = params.providerBusinessRecoveryAction;
  const fingerprint = [
    params.errorKey?.trim() ?? "",
    params.error.taskId ?? "",
    params.error.code ?? "",
    params.error.traceId ?? "",
    params.error.message,
    params.displayMessage,
    providerBusinessRecoveryAction?.kind ?? "",
    providerBusinessRecoveryAction?.providerBusinessCode ?? "",
  ].join("\u001f");

  // Reason for repair: The UI local deduplication key contains the complete error.message and cannot bypass the 500-character truncation and enter the buried point.
  // Telemetry only retains structured dimensions and short hashes, which can not only eliminate re-aggregation, but also avoid expanding the scope of the reported text.
  return [
    normalizeTelemetryKeyPart(params.error.taskId, "no-task"),
    normalizeTelemetryKeyPart(params.error.code, "UNKNOWN"),
    normalizeTelemetryKeyPart(params.error.traceId, "no-trace"),
    normalizeTelemetryKeyPart(providerBusinessRecoveryAction?.kind, "no-action"),
    normalizeTelemetryKeyPart(
      providerBusinessRecoveryAction?.providerBusinessCode,
      "no-provider-code",
    ),
    hashTelemetryFingerprint(fingerprint),
  ].join(":");
}

function buildChatErrorBannerTelemetryPayload(params: {
  surface?: ChatErrorBannerSurface;
  errorKey?: string | null;
  displayMessage: string;
  error: ZCodeUiError;
  providerBusinessRecoveryAction: ChatProviderBusinessRecoveryAction | null;
}): ArmsCustomEventPayload {
  const errorMsg = truncateTelemetryText(params.displayMessage);
  const underlyingErrorMessage = sanitizeUnderlyingTelemetryText(
    params.error.underlyingErrorMessage,
  );
  const taskId = params.error.taskId ?? "";
  const providerBusinessRecoveryAction = params.providerBusinessRecoveryAction;
  const attribution = params.error.attribution;
  const provider = resolveTelemetryProviderScope(attribution?.providerId);
  const { errorSource, failureReason } = resolveTelemetryAttribution({
    displayMessage: params.displayMessage,
    error: params.error,
  });

  return {
    name: CHAT_ERROR_BANNER_ARMS_EVENT_NAME,
    group: CHAT_ERROR_BANNER_ARMS_GROUP,
    value: 1,
    properties: {
      surface: params.surface ?? "chat_input_error_banner",
      error_key: resolveErrorKey({
        errorKey: params.errorKey,
        error: params.error,
        displayMessage: params.displayMessage,
        providerBusinessRecoveryAction,
      }),
      error_code: params.error.code ?? "",
      error_message: errorMsg,
      ...(underlyingErrorMessage ? { error_detail_message: underlyingErrorMessage } : {}),
      // The current telemetry contract prohibits uploading the complete detail; it is only retained in the local protocol and cannot be copied from the upstream error_detail_text.
      trace_id: params.error.traceId ?? "",
      task_id: taskId,
      has_detail: Boolean(params.error.detail),
      provider_business_action: providerBusinessRecoveryAction?.kind ?? "",
      provider_business_code: providerBusinessRecoveryAction?.providerBusinessCode ?? "",
      error_source: errorSource,
      failure_reason: failureReason,
      failure_phase: attribution?.errorPhase ?? "",
      failure_exception_kind: attribution?.exceptionKind ?? "",
      provider_scope: provider.providerScope,
      provider_id: provider.providerId,
      model_id: resolveTelemetryModelId(provider.providerScope, attribution?.modelId),
      provider_kind: attribution?.providerKind ?? "",
      transport: attribution?.transport ?? "",
      status_code: attribution?.statusCode ?? "",
      provider_error_code: attribution?.providerErrorCode ?? "",
      failure_retryable: attribution?.retryable ?? "",
    },
  };
}

export async function reportChatErrorBannerTelemetry(
  platform: Pick<IPlatformService, "reportArmsCustomEvent">,
  params: {
    surface?: ChatErrorBannerSurface;
    errorKey?: string | null;
    displayMessage: string;
    error: ZCodeUiError;
    providerBusinessRecoveryAction: ChatProviderBusinessRecoveryAction | null;
  },
): Promise<void> {
  try {
    // Reason for repair: The error banner is an abnormal observable and cannot be used for data warehouse business telemetry;
    // Here we use ARMS custom instead, keeping the same monitoring outlet as React ErrorBoundary.
    await platform.reportArmsCustomEvent(buildChatErrorBannerTelemetryPayload(params));
  } catch (error) {
    logger.warn("[ChatViewErrorBanner] ARMS report failed:", error);
  }
}
