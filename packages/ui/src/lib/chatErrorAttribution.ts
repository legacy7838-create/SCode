import {
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
} from "@zcode/shared";
import {
  isGenericProviderInvalidRequestCode,
  isLocalModelValidationMessage,
  isQuotaMessage,
  resolveControlledUnknownMessageAttribution,
  resolveGenericProviderCodeAttribution,
  resolveKnownProviderCodeFailureReason,
  resolveLegacyProviderEnvelopeCode,
  resolveStableTransportCodeAttribution,
  resolveTrustedProviderCodeFailureReason,
} from "@/lib/chatErrorAttributionEvidence.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

const UNKNOWN_FAILURE_REASON = "unknown";

type TelemetryErrorSource = "provider" | "runtime" | "network" | "tool" | "";

interface TelemetryErrorAttribution {
  errorSource: TelemetryErrorSource;
  failureReason: string;
}

const RATE_LIMIT_MESSAGE_PATTERN =
  /error[_ -]?rate[_ -]?limited|rate[_ -]?limit|too many requests|request higher limits|throttl/iu;
const BALANCE_MESSAGE_PATTERN =
  /insufficient\s+(?:balance|funds|credit)|balance\s+(?:is\s+)?(?:insufficient|too\s+low)|Insufficient balance|Insufficient balance/iu;
const PLAN_EXPIRED_MESSAGE_PATTERN =
  /(?:coding|subscription|Package|plan).{0,24}(?:expired|Expired)/iu;
const CONTEXT_MESSAGE_PATTERN =
  /context.{0,32}(?:length|window|exceed|limit)|prompt.{0,24}too long|Context.{0,16}(?:exceed|limit)/iu;
const AUTH_MESSAGE_PATTERN =
  /unauthori[sz]ed|authentication|invalid\s+(?:api\s+)?key|access\s+denied|Authentication|Authentication failed/iu;
const NETWORK_MESSAGE_PATTERN =
  /network|connection|econn(?:reset|refused)|enotfound|tls|proxy|network|connection failed/iu;
const TIMEOUT_MESSAGE_PATTERN = /timeout|timed out|timeout/iu;
const OVERLOAD_MESSAGE_PATTERN = /overload|overloaded|server busy|service busy|overload/iu;
const INVALID_REQUEST_MESSAGE_PATTERN =
  /invalid\s+(?:request|argument|parameter)|bad request|Parameter error|Request parameter/iu;
const EMPTY_MODEL_RESPONSE_MESSAGE_PATTERN =
  /model\s+(?:returned|returning)\s+no\s+content|The model did not return any content/iu;
const PROVIDER_REJECTED_MESSAGE_PATTERN =
  /provider\s+rejected|method\s+not\s+allowed|param(?:eter)?\s+incorrect|Illegal parameter|unsupported\s+parameter/iu;
const PROVIDER_SERVER_ERROR_MESSAGE_PATTERN =
  /provider\s+returned\s+(?:a\s+)?server\s+error|internal\s+server\s+error/iu;
const PROVIDER_RATE_LIMIT_MESSAGE_PATTERN =
  /concurrency\s+limit|admission\s+concurrency|model\s+is\s+busy|system\s+is\s+busy/iu;
const ATTACHMENT_INVALID_MESSAGE_PATTERN =
  /(?:image|video)\s+attachments\s+are\s+too\s+large|unable\s+to\s+materialize\s+(?:image|video)\s+attachment\s+path/iu;
const QUEUE_FULL_MESSAGE_PATTERN = /request\s+queue\s+is\s+full/iu;
const CANCELLED_MESSAGE_PATTERN = /turn\s+was\s+cancelled/iu;

const STABLE_ERROR_ATTRIBUTION: Readonly<
  Record<string, { readonly source: "provider" | "runtime"; readonly reason: string }>
> = {
  model_config_missing: { source: "runtime", reason: "model_config_missing" },
  MODEL_CONFIG_MISSING: { source: "runtime", reason: "model_config_missing" },
  ModelConfigMissing: { source: "runtime", reason: "model_config_missing" },
  StreamRecoveryDiscarded: {
    source: "runtime",
    reason: "stream_recovery_discarded",
  },
  ERR_SQLITE_ERROR: { source: "runtime", reason: "storage_error" },
  INVALID_INPUT: { source: "runtime", reason: "invalid_input" },
  [MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE]: {
    source: "runtime",
    reason: "invalid_input",
  },
  [MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE]: {
    source: "runtime",
    reason: "invalid_input",
  },
  [MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE]: {
    source: "runtime",
    reason: "invalid_input",
  },
  MessageAbortedError: { source: "runtime", reason: "cancelled" },
  StartPlanBusyAutoRetryExhaustedError: {
    source: "provider",
    reason: "rate_limited",
  },
};

const NETWORK_FAILURE_REASONS = new Set([
  "network_error",
  "proxy_error",
  "stale_connection",
  "stream_idle_timeout",
  "timeout",
  "tls_error",
]);

const RUNTIME_FAILURE_REASONS = new Set([
  "compact_rapid_refill_breaker",
  "storage_error",
  "model_config_missing",
  "stream_recovery_discarded",
  "invalid_input",
  "cancelled",
  "provider_not_configured",
]);

const PROVIDER_FAILURE_REASONS = new Set([
  "auth_failed",
  "balance_insufficient",
  "context_exceeded",
  "empty_model_response",
  "model_not_found",
  "plan_access_denied",
  "plan_expired",
  "provider_overloaded",
  "quota_exhausted",
  "server_error",
]);

function resolveSourceFromReason(reason: string): TelemetryErrorSource {
  if (NETWORK_FAILURE_REASONS.has(reason)) return "network";
  if (RUNTIME_FAILURE_REASONS.has(reason)) return "runtime";
  if (PROVIDER_FAILURE_REASONS.has(reason)) return "provider";
  return "";
}

function resolveSourceFromStatusCode(statusCode: number): TelemetryErrorSource {
  return statusCode === 408 || statusCode === 504 ? "network" : "provider";
}

function resolveSourceFromAdditionalEvidence(params: {
  error: ZCodeUiError;
  displayMessage: string;
}): TelemetryErrorSource {
  const statusCode = params.error.attribution?.statusCode;
  if (statusCode !== undefined) {
    return resolveSourceFromStatusCode(statusCode);
  }
  if (params.error.attribution?.providerErrorCode?.trim()) {
    return "provider";
  }

  const message = `${params.displayMessage}\n${params.error.message}`;
  if (ATTACHMENT_INVALID_MESSAGE_PATTERN.test(message)) {
    return "runtime";
  }
  if (CANCELLED_MESSAGE_PATTERN.test(message)) {
    return "runtime";
  }
  if (QUEUE_FULL_MESSAGE_PATTERN.test(message)) {
    return "";
  }
  if (
    NETWORK_MESSAGE_PATTERN.test(message) ||
    TIMEOUT_MESSAGE_PATTERN.test(message) ||
    /epipe|certificate|socket/iu.test(message)
  ) {
    return "network";
  }
  if (
    EMPTY_MODEL_RESPONSE_MESSAGE_PATTERN.test(message) ||
    PROVIDER_SERVER_ERROR_MESSAGE_PATTERN.test(message) ||
    PROVIDER_RATE_LIMIT_MESSAGE_PATTERN.test(message) ||
    BALANCE_MESSAGE_PATTERN.test(message) ||
    PLAN_EXPIRED_MESSAGE_PATTERN.test(message) ||
    RATE_LIMIT_MESSAGE_PATTERN.test(message) ||
    CONTEXT_MESSAGE_PATTERN.test(message) ||
    AUTH_MESSAGE_PATTERN.test(message) ||
    OVERLOAD_MESSAGE_PATTERN.test(message) ||
    isQuotaMessage(message) ||
    /provider|model\s+request|upstream/iu.test(message)
  ) {
    return "provider";
  }
  return "";
}

export function resolveTelemetryAttribution(params: {
  error: ZCodeUiError;
  displayMessage: string;
}): TelemetryErrorAttribution {
  // Reason for fix: The unknown of the adapter may be a conservative product runtime classification and cannot represent the lack of upstream evidence for ARMS;
  // This only completes low-cardinality attribution at the telemetry boundary by provider code/status/visible copy, without changing retry or UI behavior.
  const explicitSource = params.error.attribution?.source;
  const providerId = params.error.attribution?.providerId?.trim();
  const trustedProviderBusinessCode = providerId
    ? params.error.attribution?.providerErrorCode?.trim() || params.error.code?.trim() || ""
    : "";
  const trustedProviderReason = resolveTrustedProviderCodeFailureReason({
    providerId: params.error.attribution?.providerId,
    providerErrorCode: params.error.attribution?.providerErrorCode,
    errorCode: params.error.code,
  });
  const resolve = (
    failureReason: string,
    inferredSource: TelemetryErrorSource = "",
  ): TelemetryErrorAttribution => ({
    errorSource: explicitSource ?? inferredSource,
    failureReason,
  });
  const structuredReason = params.error.attribution?.reason?.trim();
  const message = `${params.displayMessage}\n${params.error.message}`;
  const transportErrorCode = (
    params.error.attribution?.providerErrorCode ??
    params.error.code ??
    ""
  )
    .trim()
    .toUpperCase();
  const stableTransportAttribution =
    !structuredReason || structuredReason === UNKNOWN_FAILURE_REASON
      ? resolveStableTransportCodeAttribution(transportErrorCode)
      : undefined;
  if (stableTransportAttribution) {
    // Bug reason: The old runner only writes to the provider source according to the response boundary, but stable sockets such as EPIPE
    // code is stronger transmission evidence; it only corrects empty/unknown reasons and never overwrites explicit structured attributions.
    return stableTransportAttribution;
  }
  const genericProviderAttribution =
    explicitSource === "provider" &&
    (!structuredReason || structuredReason === UNKNOWN_FAILURE_REASON)
      ? resolveGenericProviderCodeAttribution(params.error.attribution?.providerErrorCode)
      : undefined;
  if (genericProviderAttribution) {
    // Reason for the bug: The stable semantic code of the custom provider is already a low-cardinality evidence, and the old logic only recognizes BAD_REQUEST.
    // As a result, clear failures such as server/network/invalid will sink into unknown; only allowlist code is consumed here.
    return genericProviderAttribution;
  }
  if (structuredReason && structuredReason !== UNKNOWN_FAILURE_REASON) {
    const unambiguousSource = resolveSourceFromReason(structuredReason);
    if (unambiguousSource === "network" || unambiguousSource === "runtime") {
      // Reason for the bug: response boundary can only prove that the call has entered the provider link and cannot cover network/runtime
      // reason itself carries a narrower boundary; otherwise EPIPE and local provider configuration errors will be written into the provider bucket.
      return { errorSource: unambiguousSource, failureReason: structuredReason };
    }
    if (
      explicitSource === "provider" &&
      structuredReason === "rate_limited" &&
      params.error.attribution?.retryable === false &&
      trustedProviderReason === "quota_exhausted"
    ) {
      // Bug reason: The reason of the adapter is also responsible for the runtime failure classification, so the final package quota code is unified.
      // rate_limited; telemetry only for trusted builtin + non-retry fact specification for business root cause quota_exhausted.
      return { errorSource: "provider", failureReason: "quota_exhausted" };
    }
    // Reason for the bug: The old implementation normalizes reason first, and then deduces all non-empty reasons into providers.
    // Known facts such as proxy_error/provider_not_configured will be placed in the wrong bucket. source must be parsed using the same piece of evidence;
    // Ambiguous reason such as invalid_request/rate_limited remains empty when upstream evidence is missing.
    return resolve(
      structuredReason,
      resolveSourceFromReason(structuredReason) || resolveSourceFromAdditionalEvidence(params),
    );
  }

  if (
    params.error.code?.trim() === "invalid_model_request" &&
    !explicitSource &&
    isLocalModelValidationMessage(params.error.message)
  ) {
    // Reason for the bug: The capability/option verification before requesting the old transcript only has stable code/message.
    // There is no attribution written by the runner; only the exact copy generated by ZCode itself is matched to avoid receiving provider 400 by mistake.
    return { errorSource: "runtime", failureReason: "invalid_request" };
  }

  const legacyProviderCode = resolveLegacyProviderEnvelopeCode(
    params.error.code,
    params.error.message,
  );
  const legacyProviderReason = resolveKnownProviderCodeFailureReason(legacyProviderCode);
  if (legacyProviderReason) {
    // Bug reason: The old transcript only persists the three-part official error text of AiSdkModelAdapterError;
    // Strict envelope + allowlist code is enough to recover low cardinality facts, but 1234 indicates network failure and cannot be
    // The carrier source of the provider envelope is mistaken for a failure boundary, otherwise a provider/network_error will be generated.
    return {
      errorSource: resolveSourceFromReason(legacyProviderReason) || "provider",
      failureReason: legacyProviderReason,
    };
  }

  const stableAttribution = STABLE_ERROR_ATTRIBUTION[params.error.code?.trim() ?? ""];
  if (stableAttribution) {
    return resolve(stableAttribution.reason, stableAttribution.source);
  }

  // Reason for repair: Business codes such as 130x/300x are the provider partial vocabulary of BigModel/Z.AI and cannot be customized
  // The provider's code with the same name is mistakenly attributed to package expiration or quota exhaustion; it can only be returned when the provider identity is missing.
  // HTTP status code/controlled copy evidence to avoid treating general error.code as a global business code.
  if (trustedProviderReason) {
    return resolve(trustedProviderReason, "provider");
  }
  if (
    params.error.attribution?.source === "provider" &&
    isGenericProviderInvalidRequestCode(trustedProviderBusinessCode)
  ) {
    return resolve("invalid_request", "provider");
  }

  const statusCode = params.error.attribution?.statusCode;
  if (
    statusCode === 413 &&
    /chat history.{0,80}(?:message limit|too large)|input token.{0,80}(?:exceed|limit)|context.{0,80}(?:exceed|limit)/iu.test(
      message,
    )
  ) {
    return resolve("context_exceeded", "provider");
  }
  if (statusCode === 413 && /request body|payload limit|attachment|tool input/iu.test(message)) {
    return resolve("invalid_request", "provider");
  }
  if (statusCode === 405) {
    return resolve("invalid_request", "provider");
  }
  if (statusCode === 402 && BALANCE_MESSAGE_PATTERN.test(params.displayMessage)) {
    return resolve("balance_insufficient", "provider");
  }
  if (statusCode === 401 || statusCode === 403) {
    return resolve("auth_failed", "provider");
  }
  if (statusCode === 408 || statusCode === 504) {
    return { errorSource: "network", failureReason: "timeout" };
  }
  if (statusCode === 429) return resolve("rate_limited", "provider");
  if (statusCode === 404 || statusCode === 410) {
    return resolve("model_not_found", "provider");
  }
  if (statusCode === 400 || statusCode === 422) {
    return resolve("invalid_request", "provider");
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return resolve("server_error", "provider");
  }

  const controlledMessageAttribution = resolveControlledUnknownMessageAttribution(message);
  if (
    controlledMessageAttribution &&
    (controlledMessageAttribution.errorSource !== "provider" ||
      explicitSource === undefined ||
      explicitSource === "provider")
  ) {
    // Bug reason: Controlled copy is the lowest priority evidence; if it is in trusted provider code, legacy envelope or
    // Returned before HTTP status, weak copy will override more reliable structured facts such as 401/1308.
    return controlledMessageAttribution;
  }

  if (EMPTY_MODEL_RESPONSE_MESSAGE_PATTERN.test(message)) {
    return resolve("empty_model_response", "provider");
  }
  if (PROVIDER_REJECTED_MESSAGE_PATTERN.test(message)) {
    return resolve("invalid_request", resolveSourceFromAdditionalEvidence(params));
  }
  if (PROVIDER_SERVER_ERROR_MESSAGE_PATTERN.test(message)) {
    return resolve("server_error", "provider");
  }
  if (PROVIDER_RATE_LIMIT_MESSAGE_PATTERN.test(message)) {
    return resolve("rate_limited", "provider");
  }
  if (ATTACHMENT_INVALID_MESSAGE_PATTERN.test(message)) {
    return resolve("invalid_input", "runtime");
  }
  if (QUEUE_FULL_MESSAGE_PATTERN.test(message)) {
    return resolve("rate_limited");
  }
  if (CANCELLED_MESSAGE_PATTERN.test(message)) {
    return resolve("cancelled", "runtime");
  }
  if (BALANCE_MESSAGE_PATTERN.test(message)) {
    return resolve("balance_insufficient", "provider");
  }
  if (PLAN_EXPIRED_MESSAGE_PATTERN.test(message)) {
    return resolve("plan_expired", "provider");
  }
  if (RATE_LIMIT_MESSAGE_PATTERN.test(message)) {
    return resolve("rate_limited", "provider");
  }
  if (CONTEXT_MESSAGE_PATTERN.test(message)) {
    return resolve("context_exceeded", "provider");
  }
  if (AUTH_MESSAGE_PATTERN.test(message)) {
    return resolve("auth_failed", "provider");
  }
  if (NETWORK_MESSAGE_PATTERN.test(message)) {
    return resolve("network_error", "network");
  }
  if (TIMEOUT_MESSAGE_PATTERN.test(message)) {
    return resolve("timeout", "network");
  }
  if (OVERLOAD_MESSAGE_PATTERN.test(message)) {
    return resolve("provider_overloaded", "provider");
  }
  if (isQuotaMessage(message)) {
    return resolve("quota_exhausted", "provider");
  }
  if (INVALID_REQUEST_MESSAGE_PATTERN.test(message)) {
    return resolve("invalid_request");
  }

  return resolve(
    structuredReason || (params.error.attribution ? UNKNOWN_FAILURE_REASON : ""),
    resolveSourceFromAdditionalEvidence(params),
  );
}
