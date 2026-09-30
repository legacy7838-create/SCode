import type { IntlInstance } from "@/i18n/IntlProvider.js";

type UsageErrorSurface = "chatPlan" | "entitlement" | "stats";

const CREDENTIAL_ERROR_PATTERNS = [
  /token\s+(expired|incorrect)/i,
  /expired.*token/i,
  /incorrect.*token/i,
  /invalid.*(?:api\s*)?key/i,
  /(?:api\s*)?key.*invalid/i,
  /unauthorized/i,
  /forbidden/i,
  /\b40[13]\b/,
  /Authentication|Authentication|Authorization|Key|Invalid|Expired/i,
];

// Team package business errors (such as "Only the business master account can query corporate summary data",
// "You currently do not have a valid team package authorization record and cannot create an API Key") is the clear reason for business rejection on the remote end.
// The original text must be displayed. Among them, the "authorization record" contains the word "authorization". If you use credential first, it will be judged.
// It was misjudged to be a credential issue (translate the copy + check the API Key button), so business errors are matched first.
const TEAM_PLAN_BUSINESS_ERROR_PATTERNS = [
  /business owner account/,
  /Team Package/,
  /Unable to create API\s*Key/i,
  /authorization record/,
];

export function isUsageTeamPlanBusinessError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return TEAM_PLAN_BUSINESS_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function isUsageCredentialError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return CREDENTIAL_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatUsageErrorMessage(
  intl: IntlInstance,
  surface: UsageErrorSurface,
  error: string | null | undefined,
): string {
  // The team package business error is the clear reason for business rejection at the remote end, and the generic copy will cover up the real failure reason.
  // (For example, "Only the business master account can query the company's summary data.") The user cannot determine whether it is a permissions issue or a network issue.
  // It must be judged before credential: "You currently do not have a valid team package authorization record..." contains the word "authorization",
  // If it is judged later, it will be mistaken as a wrong document and the translation copy will be used.
  if (isUsageTeamPlanBusinessError(error) && error?.trim()) {
    return error.trim();
  }

  // The supplier interface will return an English authentication error, and displaying it directly will make users confused about how to troubleshoot next step.
  // Here, recoverable key/OAuth issues are uniformly translated into user-executable check items, and the original errors are still written to the log by the caller.
  if (isUsageCredentialError(error)) {
    return intl.formatMessage({ id: `usage.error.${surface}.credential` });
  }

  return intl.formatMessage({ id: `usage.error.${surface}.generic` });
}
