import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";

/**
 * The security code/message evidence of transcript and custom provider is determined here:
 * Low cardinality allowlist, each rule atomically returns the source/reason determined by the same evidence.
 */
interface TelemetryEvidenceAttribution {
  errorSource: "provider" | "runtime" | "network";
  failureReason: string;
}

const PROVIDER_BUSINESS_CODE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
]);

const PROVIDER_CODE_FAILURE_REASONS: Readonly<Record<string, string>> = {
  "1005": "quota_exhausted",
  "1006": "auth_failed",
  "1120": "server_error",
  "1210": "invalid_request",
  "1211": "model_not_found",
  "1214": "model_not_found",
  "1230": "server_error",
  "1234": "network_error",
  "1261": "context_exceeded",
  "1301": "invalid_request",
  "1302": "rate_limited",
  "1303": "rate_limited",
  "1304": "quota_exhausted",
  "1305": "rate_limited",
  "1308": "quota_exhausted",
  "1309": "plan_expired",
  "1310": "quota_exhausted",
  "1311": "plan_access_denied",
  "1312": "provider_overloaded",
  "1313": "quota_exhausted",
  "1314": "quota_exhausted",
  "1315": "quota_exhausted",
  "1316": "quota_exhausted",
  "1317": "quota_exhausted",
  "1318": "quota_exhausted",
  "1319": "quota_exhausted",
  "1320": "quota_exhausted",
  "1321": "quota_exhausted",
  "2007": "server_error",
  "3001": "invalid_request",
  "3002": "rate_limited",
  "3006": "model_not_found",
  "3007": "auth_failed",
  "3008": "rate_limited",
  "3009": "rate_limited",
  "3010": "rate_limited",
  "1213": "invalid_request",
  "3012": "invalid_request",
  "429": "rate_limited",
};

// The provider package may only retain the upstream business code, without the standard reason of the adapter;
// There is clear evidence of rejection semantics for these codes, which are only supplemented by low-cardinality invalid_request at telemetry boundaries.
const GENERIC_PROVIDER_INVALID_REQUEST_CODES = new Set(["BAD_REQUEST"]);

const LOCAL_MODEL_VALIDATION_MESSAGES = new Set([
  "maxOutputTokens is outside the model option range",
  "reasoningLevel is not supported by the model",
  "Model does not support tool calls",
  "Model does not support structured output",
  "Model does not support image input",
  "Model does not support PDF input",
]);

// The event may only persist the providerErrorCode, and the error text does not repeat the underlying errno;
// If allowlist only covers a small number of on-site samples, the confirmed network code of adapters such as ECONNRESET will degenerate into provider/unknown.
const STABLE_TRANSPORT_ERROR_CODES = new Set([
  "EPIPE",
  "ECONNABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "EADDRINUSE",
  "ENOBUFS",
  "ENOTCONN",
  "UND_ERR_SOCKET",
]);

const STABLE_TRANSPORT_TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ETIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const GENERIC_PROVIDER_CODE_ATTRIBUTION: Readonly<Record<string, TelemetryEvidenceAttribution>> = {
  service_unavailable: { errorSource: "provider", failureReason: "server_error" },
  server_error: { errorSource: "provider", failureReason: "server_error" },
  upstream_server_error: { errorSource: "provider", failureReason: "server_error" },
  upstream_unavailable: { errorSource: "provider", failureReason: "server_error" },
  upstream_not_found: { errorSource: "provider", failureReason: "model_not_found" },
  no_capacity: { errorSource: "provider", failureReason: "provider_overloaded" },
  stream_read_error: { errorSource: "network", failureReason: "network_error" },
  upstream_http2_stream_error: {
    errorSource: "network",
    failureReason: "network_error",
  },
  request_timeout: { errorSource: "network", failureReason: "timeout" },
  gateway_stream_terminated: { errorSource: "network", failureReason: "network_error" },
  invalid_parameter_error: {
    errorSource: "provider",
    failureReason: "invalid_request",
  },
  invalid_tool_call: { errorSource: "provider", failureReason: "invalid_request" },
  invalid_input: { errorSource: "provider", failureReason: "invalid_request" },
  validation_error: { errorSource: "provider", failureReason: "invalid_request" },
  model_capability_not_supported: {
    errorSource: "provider",
    failureReason: "invalid_request",
  },
  cyber_policy: { errorSource: "provider", failureReason: "invalid_request" },
  request_too_large: { errorSource: "provider", failureReason: "invalid_request" },
  chat_history_too_large: {
    errorSource: "provider",
    failureReason: "context_exceeded",
  },
  model_deprecated: { errorSource: "provider", failureReason: "model_not_found" },
  insufficient_balance: {
    errorSource: "provider",
    failureReason: "balance_insufficient",
  },
  quota_limit: { errorSource: "provider", failureReason: "quota_exhausted" },
  internal_server_error: { errorSource: "provider", failureReason: "server_error" },
  err_invalid_url: { errorSource: "runtime", failureReason: "invalid_input" },
};

const LEGACY_PROVIDER_ENVELOPE_PATTERN =
  /^\[(\d{3,6})\]\[[^\]\r\n]{1,500}\]\[[^\]\r\n]{4,160}\](?:\s*\(request id: [^)]+\))?$/u;

export function isLocalModelValidationMessage(message: string): boolean {
  return LOCAL_MODEL_VALIDATION_MESSAGES.has(message.trim());
}

export function resolveStableTransportCodeAttribution(
  code: string,
): TelemetryEvidenceAttribution | undefined {
  const normalizedCode = code.trim().toUpperCase();
  if (STABLE_TRANSPORT_TIMEOUT_ERROR_CODES.has(normalizedCode)) {
    return { errorSource: "network", failureReason: "timeout" };
  }
  if (STABLE_TRANSPORT_ERROR_CODES.has(normalizedCode)) {
    return { errorSource: "network", failureReason: "network_error" };
  }
  return undefined;
}

export function resolveGenericProviderCodeAttribution(
  code: string | undefined,
): TelemetryEvidenceAttribution | undefined {
  return GENERIC_PROVIDER_CODE_ATTRIBUTION[code?.trim().toLowerCase() ?? ""];
}

export function resolveKnownProviderCodeFailureReason(
  code: string | undefined,
): string | undefined {
  return PROVIDER_CODE_FAILURE_REASONS[code?.trim() ?? ""];
}

export function resolveTrustedProviderCodeFailureReason(params: {
  providerId: string | undefined;
  providerErrorCode: string | undefined;
  errorCode: string | undefined;
}): string | undefined {
  const providerId = params.providerId?.trim();
  if (!providerId || !PROVIDER_BUSINESS_CODE_PROVIDER_IDS.has(providerId)) {
    return undefined;
  }
  return resolveKnownProviderCodeFailureReason(
    params.providerErrorCode?.trim() || params.errorCode?.trim(),
  );
}

export function isGenericProviderInvalidRequestCode(code: string): boolean {
  return GENERIC_PROVIDER_INVALID_REQUEST_CODES.has(code.trim().toUpperCase());
}

export function resolveLegacyProviderEnvelopeCode(
  errorCode: string | undefined,
  message: string,
): string | undefined {
  const envelopeCode = LEGACY_PROVIDER_ENVELOPE_PATTERN.exec(message.trim())?.[1];
  if (!envelopeCode) return undefined;
  const normalizedErrorCode = errorCode?.trim();
  return normalizedErrorCode === "AiSdkModelAdapterError" || normalizedErrorCode === envelopeCode
    ? envelopeCode
    : undefined;
}

export function isQuotaMessage(message: string): boolean {
  return /quota|usage\s+limit|limit\s+exhausted|exceed(?:ed)?\s+(?:the\s+)?(?:limit|quota)|Quota|Usage upper limit|Usage upper limit|Usage upper limit/iu.test(
    message,
  );
}

export function resolveControlledUnknownMessageAttribution(
  message: string,
): TelemetryEvidenceAttribution | undefined {
  if (/off-peak-ticket-expired/iu.test(message)) {
    return { errorSource: "runtime", failureReason: "offpeak_ticket_expired" };
  }
  if (
    /cannot connect to api:.*(?:self-signed certificate|ssl routines:.*key_usage_bit_incorrect)/iu.test(
      message,
    )
  ) {
    return { errorSource: "network", failureReason: "tls_error" };
  }
  if (/cannot connect to api:\s*(?:\n|$)/iu.test(message)) {
    return { errorSource: "network", failureReason: "network_error" };
  }
  if (/cannot connect to api:.*(?:connect|write|read)\s+eacces/iu.test(message)) {
    return { errorSource: "network", failureReason: "network_error" };
  }
  if (
    /cannot connect to api:.*getaddrinfo\s+(?:enoent|ebusy|eai_again|enotfound)/iu.test(message) ||
    /upstream stream (?:ended|disconnected|terminated|closed).*(?:without a terminal marker|before terminal|before completion|unexpected eof|before \[done\])/iu.test(
      message,
    ) ||
    /upstream truncated response without stop reason/iu.test(message) ||
    /server disconnected without sending a response/iu.test(message) ||
    /responses\s+Streaming call failed/iu.test(message) ||
    /engine protocol predict request failed:\s*fetch failed/iu.test(message) ||
    /the model provider encountered a streaming error/iu.test(message) ||
    /Upstream streaming response has no data for a long time/iu.test(message) ||
    /(?:^|\n)stream_read_error(?:\n|$)/iu.test(message)
  ) {
    return {
      errorSource: "network",
      failureReason: /长时间无数据/iu.test(message) ? "stream_idle_timeout" : "network_error",
    };
  }
  if (
    /model stream stalled:\s*no event received for \d+ms|codebuddy cli produced no stream output for \d+ms/iu.test(
      message,
    )
  ) {
    return { errorSource: "network", failureReason: "stream_idle_timeout" };
  }
  if (/user is not allowed to access.{0,160}(?:action plan limited|plan limited)/iu.test(message)) {
    return { errorSource: "provider", failureReason: "plan_access_denied" };
  }
  if (/authorization not found/iu.test(message)) {
    return { errorSource: "provider", failureReason: "auth_failed" };
  }
  if (
    /upstream access forbidden|do not have access to (?:this|the requested) resource/iu.test(
      message,
    )
  ) {
    return { errorSource: "provider", failureReason: "auth_failed" };
  }
  if (
    /auth_unavailable:\s*no auth available|model provider is missing an api key/iu.test(message)
  ) {
    return { errorSource: "runtime", failureReason: "provider_not_configured" };
  }
  if (
    /failed to deserialize the json body.*(?:unknown variant|expected)/iu.test(message) ||
    /field\s+reasoningeffort\s+invalid/iu.test(message) ||
    /function call is not supported for this model/iu.test(message) ||
    /model is not a vlm/iu.test(message) ||
    /engine protocol predict request returned 400:.*(?:invalid_request_error|failed to parse grammar)/iu.test(
      message,
    ) ||
    /model returned invalid tool input/iu.test(message) ||
    /failed to generate a valid tool call/iu.test(message) ||
    /model rejected this request.*(?:input|parameter)/iu.test(message) ||
    /tool call id.*must be/iu.test(message) ||
    /litellm\.badrequesterror:.*invalid_request_error/iu.test(message) ||
    /media item count was exceeded/iu.test(message) ||
    /Incomplete, illegal or non-existent tool call/iu.test(message)
  ) {
    return { errorSource: "provider", failureReason: "invalid_request" };
  }
  if (
    /upstream service temporarily unavailable|model service is temporarily unavailable|the service is temporarily unavailable/iu.test(
      message,
    ) ||
    /Service is temporarily unavailable/iu.test(message) ||
    /Responsible Party[::]Server/iu.test(message) ||
    /the model has crashed/iu.test(message) ||
    /fatal exception in the backend generation thread/iu.test(message) ||
    /\[500\]\[Operation failed\]/iu.test(message) ||
    /502\s+Exception in service response content/iu.test(message) ||
    /An internal error occurred during streaming inference/iu.test(message) ||
    /a server error occurred/iu.test(message) ||
    /engine protocol predict stream returned an error:.*(?:"code":500|"type":"server_error"|errordevicelost)/iu.test(
      message,
    )
  ) {
    return { errorSource: "provider", failureReason: "server_error" };
  }
  if (/\bat capacity\b|high demand.{0,120}capacity|no capacity/iu.test(message)) {
    return { errorSource: "provider", failureReason: "provider_overloaded" };
  }
  if (
    /Insufficient business application resources.*Application for capacity expansion/iu.test(
      message,
    )
  ) {
    return { errorSource: "provider", failureReason: "provider_overloaded" };
  }
  if (/Requests are too frequent/iu.test(message)) {
    return { errorSource: "provider", failureReason: "rate_limited" };
  }
  if (
    /session\s+[^\s]+\s+is already in flight|Concurrency (?:number)?(?:already)?reached the upper limit|Concurrency upper limit/iu.test(
      message,
    )
  ) {
    return { errorSource: "provider", failureReason: "rate_limited" };
  }
  if (/credentials?.*cooling down/iu.test(message)) {
    return { errorSource: "provider", failureReason: "rate_limited" };
  }
  if (
    / greaterbalance than \$?0|account.*in arrests|top up the account|failure to pay past invoices|credit has been exhausted|balance_depleted|welfare version model.*need to recharge first/iu.test(
      message,
    )
  ) {
    return { errorSource: "provider", failureReason: "balance_insufficient" };
  }
  if (/budget has been exceeded|daily cost limit reached/iu.test(message)) {
    return { errorSource: "provider", failureReason: "quota_exhausted" };
  }
  if (/"type":"notfounderror".*model.*does not exist/iu.test(message)) {
    return { errorSource: "provider", failureReason: "model_not_found" };
  }
  if (/maximum conversation length reached/iu.test(message)) {
    return { errorSource: "provider", failureReason: "context_exceeded" };
  }
  if (
    /No available package.*(?:Subscription|Renewal)|No effective package.*Activate subscription/iu.test(
      message,
    )
  ) {
    return { errorSource: "provider", failureReason: "plan_access_denied" };
  }
  if (/No api calling permission.*Not subscribed.*(?:codeplan|Resource package)/iu.test(message)) {
    return { errorSource: "provider", failureReason: "plan_access_denied" };
  }
  return undefined;
}
