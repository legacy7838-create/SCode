import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";

type CodingPlanQuotaResetFormat = "date" | "dateTime" | "adaptive";

/**
 * The set of equivalent types for Token / Credit quotas.
 *
 * The zai service backend uses `CREDIT_LIMIT` as the type for a Team Plan's quota/limit, while the
 * bigmodel service backend uses `TOKENS_LIMIT`. The two have exactly the same unit/number semantics
 * (unit=3,number=5 → a 5-hour window; unit=6 → weekly); only the type enum name differs. Treating
 * the two types as equivalent here lets zai/bigmodel team plans both match under the same set of UI
 * consumers. If the zai backend later aligns to TOKENS_LIMIT, this set remains compatible.
 */
const TOKEN_LIMIT_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

/**
 * The type for Tool quotas. Both the bigmodel and zai backends currently use TIME_LIMIT for the
 * monthly tool-call quota, so no equivalent set is needed yet.
 */
const TOOL_LIMIT_TYPES = new Set(["TIME_LIMIT"]);

export function isSameLimitCategory(
  limitType: string,
  queryType: UsageQuotaLimit["type"],
): boolean {
  if (limitType === queryType) {
    return true;
  }
  // zai team plan returns CREDIT_LIMIT, and the consumer must also hit it when querying by TOKENS_LIMIT.
  if (TOKEN_LIMIT_TYPES.has(queryType)) {
    return TOKEN_LIMIT_TYPES.has(limitType);
  }
  if (TOOL_LIMIT_TYPES.has(queryType)) {
    return TOOL_LIMIT_TYPES.has(limitType);
  }
  return false;
}

export function findCodingPlanQuotaLimit(
  limits: UsageQuotaLimit[] | undefined,
  type: UsageQuotaLimit["type"],
  unit: number,
  number?: number,
): UsageQuotaLimit | null {
  return (
    limits?.find(
      (limit) =>
        isSameLimitCategory(limit.type, type) &&
        limit.unit === unit &&
        (number == null || limit.number === number),
    ) ?? null
  );
}

/**
 * The official Server MCP allowance (the total allowance pushed down by the server).
 *
 * The server puts it in a standalone field of the entitlement snapshot instead of in
 * quota.limits[], so findCodingPlanQuotaLimit cannot be used to query it; it is funnelled into a
 * single access point here, so that each display site does not write its own `?.` chain.
 */
export function resolveMcpQuotaLimit(
  snapshot: UsageEntitlementSnapshot | null | undefined,
): UsageQuotaLimit | null {
  return snapshot?.mcpQuota?.aggregate ?? null;
}

export function getQuotaRemainingPercentage(limit: UsageQuotaLimit | null): number | null {
  if (typeof limit?.percentage !== "number" || !Number.isFinite(limit.percentage)) {
    return null;
  }

  // The percentage of the quota interface indicates the used proportion, while Usage Remaining is related to
  // The limit cards used in statistics all express "how much is left". Invert them uniformly here to avoid inconsistent display calibers in the two places.
  return Math.max(0, Math.min(100, 100 - limit.percentage));
}

/**
 * Resetting buys nothing while the allowance is still 100% (nothing has been consumed), so the UI
 * hides the "Reset" button and the opportunity badge. This is a presentation-layer gate only: it
 * does not affect server-side granting, status polling, or the opportunity state itself; the
 * processing / completed displays do not go through this check, so the completion feedback of a
 * manual reset still plays in full.
 */
export function isCodingPlanQuotaLimitFull(limit: UsageQuotaLimit | null | undefined): boolean {
  return getQuotaRemainingPercentage(limit ?? null) === 100;
}

export function formatQuotaRemainingPercentage(
  locale: string,
  limit: UsageQuotaLimit | null,
): string {
  const remainingPercentage = getQuotaRemainingPercentage(limit);
  if (remainingPercentage == null) {
    return "--";
  }

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: remainingPercentage >= 10 ? 0 : 1,
  }).format(remainingPercentage)}%`;
}

/**
 * The only formatting entry point for the Start Plan allowance bucket renewal time (shared by the
 * settings balance card and the chat input bubble).
 *
 * Both ends once kept their own verbatim copy of formatStartPlanBalanceRenewTime, so a format
 * change that missed either one would bring back the inconsistency between the two. The bucket
 * renewal time format is aligned with Coding Plan: time of day only (HH:mm) when it is the same
 * day, date only otherwise.
 */
export function formatStartPlanBucketResetTime(
  locale: string,
  value: number | null | undefined,
): string | undefined {
  return formatQuotaResetTime({ locale, value, format: "adaptive" });
}

export function formatQuotaResetTime(params: {
  locale: string;
  value: number | null | undefined;
  format: CodingPlanQuotaResetFormat;
  compactToday?: boolean;
}): string | undefined {
  if (!params.value) {
    return undefined;
  }

  const resetAt = new Date(params.value);
  if (Number.isNaN(resetAt.getTime())) {
    return undefined;
  }

  const now = new Date();
  const isToday =
    resetAt.getFullYear() === now.getFullYear() &&
    resetAt.getMonth() === now.getMonth() &&
    resetAt.getDate() === now.getDate();

  if (params.format === "date") {
    return new Intl.DateTimeFormat(params.locale, {
      month: "short",
      day: "numeric",
    }).format(resetAt);
  }

  // Adaptive: Only display HH:mm on the current day (you can only take action at the time), and only display the date on non-current days.
  //(Same as the display semantics of the Coding Plan's five-hour window/week-month reset).
  if (params.format === "adaptive") {
    if (isToday) {
      return new Intl.DateTimeFormat(params.locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(resetAt);
    }
    return new Intl.DateTimeFormat(params.locale, {
      month: "short",
      day: "numeric",
    }).format(resetAt);
  }

  return new Intl.DateTimeFormat(params.locale, {
    ...(params.compactToday && isToday
      ? {}
      : {
          month: "short",
          day: "numeric",
        }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetAt);
}
