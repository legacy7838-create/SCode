/**
 * zcode-plan / Coding Plan business error codes and the front-end handling convention.
 *
 * | Scenario | code | HTTP | Front-end handling |
 * |-----------------------------|----------|------|--------------------|
 * | JWT missing / expired | 1006 | 200 | Jump to login or re-authorize | | Quota exhausted | 1005 |
 * 200 | Disable the entry point, refresh the quota | | Model unavailable | 3006 | 400 | Switch to
 * another model in the Built-in Provider | | Invalid parameters | 3001 | 400 | Inspect the request
 * body | | Security check rejected | 3007 | 403 | The client cannot satisfy the security check;
 * prompt the user to contact support | | Model concurrency limit | 3010 | 429 | Show the upgrade
 * banner under Start Plan | | Rate limited | 3002/429 | 429 | Show a rate-limit notice and retry
 * later | | Off-peak ticket unavailable | 3102 | 400 | The single run segment hit its time cap;
 * prompt the user to start an off-peak task to continue | | Upstream HTTP error | 2007 | 500 |
 * Retryable; refresh the quota, do not deduct the allowance locally |
 */
import { isOffPeakTicketExpiredError } from "@zcode/shared";

const PROVIDER_BUSINESS_ERROR_CODES = [
  "1006",
  "1005",
  "3006",
  "3001",
  "3007",
  "3008",
  "3009",
  "3010",
  "3002",
  "3102",
  "2007",
  "429",
] as const;

type ProviderBusinessErrorCode = (typeof PROVIDER_BUSINESS_ERROR_CODES)[number];

export type ProviderBusinessErrorUiAction =
  | "login"
  | "refresh-quota"
  | "switch-model"
  | "retry-later"
  | "upgrade";

const PROVIDER_BUSINESS_ERROR_MESSAGE_IDS: Record<ProviderBusinessErrorCode, string> = {
  "1006": "zcode.error.providerBusiness.1006",
  "1005": "zcode.error.providerBusiness.1005",
  "3006": "zcode.error.providerBusiness.3006",
  "3002": "zcode.error.providerBusiness.3002",
  "3001": "zcode.error.providerBusiness.3001",
  "3007": "zcode.error.providerBusiness.3007",
  "3008": "zcode.error.providerBusiness.3008",
  "3009": "zcode.error.providerBusiness.3009",
  "3010": "zcode.error.providerBusiness.3010",
  "3102": "zcode.error.providerBusiness.3102",
  "2007": "zcode.error.providerBusiness.2007",
  "429": "zcode.error.providerBusiness.429",
};

const PROVIDER_BUSINESS_ERROR_UI_ACTIONS: Record<
  ProviderBusinessErrorCode,
  ProviderBusinessErrorUiAction | null
> = {
  "1006": "login",
  "1005": "refresh-quota",
  "3006": "switch-model",
  "3001": null,
  // 3007 Security check rejected: The client cannot complete the security check and there is no executable recovery action.
  "3007": null,
  // 3008/3009/3010 Concurrency limit: Start Plan goes to upgrade banner, non-Start Plan goes to upgrade action
  "3008": "upgrade",
  "3009": "upgrade",
  "3010": "upgrade",
  "3002": "retry-later",
  // 3102 The idle time ticket is not available: you can only create a new idle time task and continue running, and the retry/cut model in the banner cannot save it.
  "3102": null,
  "2007": "retry-later",
  "429": "retry-later",
};

export function isProviderBusinessErrorCode(
  code: string | undefined,
): code is ProviderBusinessErrorCode {
  if (!code) {
    return false;
  }
  return (PROVIDER_BUSINESS_ERROR_CODES as readonly string[]).includes(code);
}

export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {
  if (!isProviderBusinessErrorCode(code)) {
    return undefined;
  }
  return PROVIDER_BUSINESS_ERROR_MESSAGE_IDS[code];
}

export function getProviderBusinessErrorUiAction(
  code: string | undefined,
): ProviderBusinessErrorUiAction | null {
  if (!isProviderBusinessErrorCode(code)) {
    return null;
  }
  return PROVIDER_BUSINESS_ERROR_UI_ACTIONS[code];
}

const START_PLAN_QUOTA_EXHAUSTED_WRAPPER_CODES = new Set([
  "PROVIDER_BUSINESS_ERROR",
  "SEND_FAILED",
  "unknown_error",
]);

export function resolveStartPlanQuotaExhaustedBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "1005" | undefined {
  if (code === "1005") {
    return "1005";
  }

  const normalizedCode = code?.trim();
  const normalizedMessage = message?.trim().toLowerCase();
  if (!normalizedMessage) {
    return undefined;
  }

  // The old version of running/historical tasks only retains the outer error code, and the real providerCode=1005 is suppressed.
  // PROVIDER_BUSINESS_ERROR / SEND_FAILED / unknown_error + "exceed limit/exceed quota limit".
  // ChatView will call this within the boundaries of the Start Plan provider to avoid errors with the same name in other providers.
  if (
    (normalizedMessage.includes("exceed limit") ||
      normalizedMessage.includes("exceed quota limit") ||
      normalizedMessage.includes("quota exceeded")) &&
    (!normalizedCode || START_PLAN_QUOTA_EXHAUSTED_WRAPPER_CODES.has(normalizedCode))
  ) {
    return "1005";
  }

  return undefined;
}

const CONCURRENT_LIMIT_WRAPPER_CODES = new Set([
  "PROVIDER_BUSINESS_ERROR",
  "SEND_FAILED",
  "unknown_error",
  "MODEL_RATE_LIMITED",
]);

const CONCURRENT_LIMIT_MESSAGE_PATTERNS = ["concurrent", "concurrency", "Concurrency"];

const MODEL_SCOPED_CONCURRENT_LIMIT_MESSAGE_PATTERNS = ["model", "model"];

export const START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE =
  "Start Plan is busy and automatic model stream recovery reached the maximum retry count.";

export type StartPlanConcurrentLimitBannerReason = "initial-busy" | "retry-exhausted-busy";

export const GLM_QUOTA_BANNER_BUSINESS_CODES = [
  "1308",
  "1309",
  "1310",
  "1311",
  "1313",
  "1314",
  "1315",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
] as const;

export type GlmQuotaBannerBusinessCode = (typeof GLM_QUOTA_BANNER_BUSINESS_CODES)[number];

const GLM_QUOTA_BANNER_BUSINESS_CODE_SET = new Set<string>(GLM_QUOTA_BANNER_BUSINESS_CODES);

/**
 * Whether this is a concurrency-limit business error (3008/3009/3010). When it hits under Start
 * Plan, the concurrency-limit upgrade banner is used instead of the ordinary error banner.
 */
export function resolveStartPlanConcurrentLimitBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3008" | "3009" | "3010" | undefined {
  if (code === "3008") {
    return "3008";
  }
  if (code === "3009") {
    return "3009";
  }
  if (code === "3010") {
    return "3010";
  }

  const normalizedCode = code?.trim();
  const normalizedMessage = message?.trim().toLowerCase();
  if (!normalizedMessage) {
    return undefined;
  }

  // Bottom line: The old link may compress 3008/3009/3010 into packaging code + concurrency related copywriting.
  // Some historical tasks only persist unknown_error + "model concurrency limit exceeded";
  // This type of error is model-level concurrency and cannot degenerate into blocking 3008, otherwise composer will still be locked after recovery.
  if (
    CONCURRENT_LIMIT_MESSAGE_PATTERNS.some((pattern) => normalizedMessage.includes(pattern)) &&
    (!normalizedCode || CONCURRENT_LIMIT_WRAPPER_CODES.has(normalizedCode))
  ) {
    return MODEL_SCOPED_CONCURRENT_LIMIT_MESSAGE_PATTERNS.some((pattern) =>
      normalizedMessage.includes(pattern),
    )
      ? "3009"
      : "3008";
  }

  return undefined;
}

export function resolveGlmQuotaBannerBusinessCode(
  code: string | undefined,
): GlmQuotaBannerBusinessCode | undefined {
  const normalizedCode = code?.trim();
  if (normalizedCode && GLM_QUOTA_BANNER_BUSINESS_CODE_SET.has(normalizedCode)) {
    // GLM API 1308/1309/1310/1311/1313-1321 are all quotas,
    // Package or account usage boundaries should not cover the upgrade entrance with ordinary error banners.
    return normalizedCode as GlmQuotaBannerBusinessCode;
  }
  return undefined;
}

export function resolveStartPlanConcurrentLimitBannerReason(
  message: string | undefined,
): StartPlanConcurrentLimitBannerReason {
  return message?.trim() === START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE
    ? "retry-exhausted-busy"
    : "initial-busy";
}

/** Kept in sync with the anomaly guard wording in core `model-errors.ts`. */
export const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

/**
 * Off-peak ticket unavailable (upstream 3102: the ticket is invalid or expired). The adapter wraps
 * that business code as `off-peak-ticket-expired: <upstream text>` into the turn error, and relies
 * on that stable marker when the outer code has been squashed into a wrapper code such as
 * PROVIDER_BUSINESS_ERROR; otherwise the banner would dump the raw "off peak ticket is invaliad or
 * expired" text straight at the user.
 */
export function resolveOffPeakTicketExpiredBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3102" | undefined {
  if (code?.trim() === "3102") {
    return "3102";
  }
  return isOffPeakTicketExpiredError(message) ? "3102" : undefined;
}

export function isSuspiciousEmptyModelResultMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    message.includes(SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE) ||
    message.includes("Model returned no text")
  );
}
