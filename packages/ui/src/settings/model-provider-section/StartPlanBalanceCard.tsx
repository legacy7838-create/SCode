import { Loader2Icon } from "lucide-react";
import type { UsageEntitlementSubscriptionDetail, UsageQuotaLimit } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatStartPlanBucketResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import { formatStartPlanExpireDate } from "./CodingPlanStatusMeta.js";
import { formatQuotaModelDisplayName } from "./quotaModelDisplayName.js";

export function StartPlanBalanceCard({
  isChecking,
  limits,
  expireTime,
  embedded = false,
}: {
  isChecking: boolean;
  limits: UsageQuotaLimit[];
  expireTime?: string | null;
  embedded?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const visibleLimits = limits.filter((limit) => {
    const total = resolveLimitTotal(limit);
    const remaining = resolveLimitRemaining(limit);
    return total > 0 || remaining > 0;
  });
  // Today's balance backend already returns balances by product priority.
  // Continuing to invert the UI will put GLM-5.2 at the end, which is inconsistent with server configuration and user expectations.
  const displayLimits = visibleLimits;
  if (!isChecking && visibleLimits.length === 0) {
    return null;
  }
  const expireTimeLabel = formatStartPlanBalanceExpireTimeLabel({
    expireTime,
    intl,
    locale,
  });
  return (
    <div className={embedded ? "" : "rounded-lg border border-border bg-card p-4"}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <h4 className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({
              id: "settings.modelProvider.startPlan.balance.title",
            })}
          </h4>
          {isChecking ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
        {expireTimeLabel ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtle">{expireTimeLabel}</span>
        ) : null}
      </div>
      {displayLimits.length > 0 ? (
        <div className="mt-3 flex gap-2 max-sm:flex-col">
          {displayLimits.map((limit) => (
            <StartPlanBalanceLimit
              key={resolveLimitKey(limit)}
              limit={limit}
              locale={locale}
              // The bucket refresh time only comes from expires_at (limit.nextResetTime) of this bucket.
              // No longer use package-level renewTime to avoid copying to all buckets at the same time.
              renewTimeLabel={formatStartPlanBucketResetTime(locale, limit.nextResetTime)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StartPlanBalanceLimit({
  limit,
  locale,
  renewTimeLabel,
}: {
  limit: UsageQuotaLimit;
  locale: string;
  renewTimeLabel?: string;
}) {
  const total = resolveLimitTotal(limit);
  const remaining = resolveLimitRemaining(limit);
  const remainingRatio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  const remainingPercent = formatRemainingPercent(locale, remainingRatio);

  return (
    <div className="min-w-0 flex-1 rounded-lg bg-surface p-3">
      <div className="truncate text-ui-base font-medium text-foreground">
        {formatLimitModels(limit)}
      </div>
      <div className="mt-2 flex min-w-0 items-baseline justify-between gap-3">
        <span className="shrink-0 text-ui-lg font-semibold leading-none text-foreground">
          {remainingPercent}
        </span>
        {renewTimeLabel ? (
          <span className="min-w-0 truncate text-right text-ui-xs text-foreground-subtle">
            {renewTimeLabel}
          </span>
        ) : null}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-success"
          style={{ width: `${remainingRatio * 100}%` }}
        />
      </div>
      <div className="mt-2 truncate text-ui-xs text-foreground-subtle">
        {formatFullTokenUsage(locale, remaining)} / {formatFullTokenUsage(locale, total)}
      </div>
    </div>
  );
}

function resolveLimitKey(limit: UsageQuotaLimit): string {
  return `${limit.type}:${formatLimitModels(limit)}`;
}

function resolveLimitTotal(limit: UsageQuotaLimit): number {
  return limit.number ?? limit.unit ?? 0;
}

function resolveLimitRemaining(limit: UsageQuotaLimit): number {
  return limit.remaining ?? 0;
}

function formatRemainingPercent(locale: string, ratio: number): string {
  return new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: ratio >= 0.1 ? 0 : 1,
    style: "percent",
  }).format(ratio);
}

function formatFullTokenUsage(locale: string, value: number): string {
  return new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: 0,
  }).format(value);
}

interface StartPlanQuotaCardEntry {
  plan: UsageEntitlementSubscriptionDetail;
  limits: UsageQuotaLimit[];
}

export function resolveStartPlanQuotaCardEntries({
  plans,
  limits,
}: {
  plans: UsageEntitlementSubscriptionDetail[];
  limits: UsageQuotaLimit[];
}): StartPlanQuotaCardEntry[] {
  return plans.map((plan) => ({
    plan,
    // Quota buckets are accurately attributed only according to plan_id. The server contract ensures that each bucket has plan_id.
    // No more single package guarantees for buckets without plan_id, otherwise the same bucket will be copied into each card under multiple packages.
    limits: limits.filter((limit) => limit.planId?.trim() === plan.productId.trim()),
  }));
}

function formatStartPlanBalanceExpireTimeLabel({
  expireTime,
  intl,
  locale,
}: {
  expireTime?: string | null;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
}): string | null {
  const normalizedExpireTime = expireTime?.trim();
  if (!normalizedExpireTime) {
    return null;
  }
  return intl.formatMessage(
    { id: "settings.modelProvider.codingPlan.expiresAt" },
    {
      date: formatStartPlanExpireDate(normalizedExpireTime, locale),
    },
  );
}

function formatLimitModels(limit: UsageQuotaLimit): string {
  const modelNames = limit.usageDetails
    .map((detail) => {
      const displayName = detail.displayName?.trim();
      return formatQuotaModelDisplayName(displayName || formatModelCode(detail.modelCode.trim()));
    })
    .filter((modelName) => modelName.length > 0);
  if (modelNames.length === 0) {
    return limit.type;
  }

  return modelNames.join(" / ");
}

function formatModelCode(modelCode: string): string {
  const normalized = modelCode.replace(/^model:/i, "");
  if (normalized.toLowerCase() === "glm-5-turbo") {
    return "GLM-5Turbo";
  }
  return normalized.toUpperCase();
}
