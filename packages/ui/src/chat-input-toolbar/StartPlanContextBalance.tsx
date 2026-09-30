import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import { Loader2Icon, RocketIcon } from "lucide-react";
import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { formatStartPlanBucketResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import { formatQuotaModelDisplayName } from "@/settings/model-provider-section/quotaModelDisplayName.js";

export interface ChatStartPlanBalanceConfig {
  loading: boolean;
  /** Silent access refresh initiated when hover opens the context panel (consistent with the onAccess semantics of the Coding Plan section). */
  onAccess?: () => Promise<void> | void;
  onUpgradeClick?: () => void;
  /** This refresh promise triggered by hover is in progress; silent refresh does not set entitlement.loading, and the spinner needs to follow it. */
  refreshing?: boolean;
  snapshot: UsageEntitlementSnapshot | null;
}

function resolveLimitTotal(limit: UsageQuotaLimit): number {
  return limit.number ?? limit.unit ?? 0;
}

function resolveLimitRemaining(limit: UsageQuotaLimit): number {
  return limit.remaining ?? 0;
}

function formatStartPlanRemainingPercentage(ratio: number, locale: string): string {
  const boundedRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(boundedRatio);
}

function formatModelCode(modelCode: string): string {
  const normalized = modelCode.replace(/^model:/i, "");
  if (normalized.toLowerCase() === "glm-5-turbo") {
    return "GLM-5Turbo";
  }
  return normalized.toUpperCase();
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

function getVisibleStartPlanLimits(snapshot: UsageEntitlementSnapshot | null): UsageQuotaLimit[] {
  return (snapshot?.quota?.limits ?? []).filter((limit) => {
    const total = resolveLimitTotal(limit);
    const remaining = resolveLimitRemaining(limit);
    return total > 0 || remaining > 0;
  });
}

export function hasChatStartPlanBalance(config: ChatStartPlanBalanceConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  return (
    config.loading ||
    getVisibleStartPlanLimits(config.snapshot).length > 0 ||
    // Start Plan and Coding Plan connection methods are mutually exclusive. The hover refresh entry cannot be hung only in Coding Plan.
    // In terms of configuration; this section (including triggers) will not be rendered when there is no cached snapshot for the first time, and the user does not have a hover entry to initiate the first balance request.
    // The existence of onAccess is considered to be refreshable on demand, and the trigger is retained (aligned with the bottom line of hasChatCodingPlanUsageRemaining).
    Boolean(config.onAccess)
  );
}

function ChatStartPlanBalanceMeter({ limit, locale }: { limit: UsageQuotaLimit; locale: string }) {
  const total = resolveLimitTotal(limit);
  const remaining = resolveLimitRemaining(limit);
  const remainingRatio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  // The bucket refresh time only comes from expires_at (nextResetTime) of this bucket; package-level renewTime is no longer used.
  // Or set the global aggregation time, otherwise the same time will be copied into each bucket under multiple packages.
  const renewTime = formatStartPlanBucketResetTime(locale, limit.nextResetTime);

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="min-w-0 space-y-0.5 text-ui-sm">
        <div className="min-w-0 truncate text-foreground-subtle">{formatLimitModels(limit)}</div>
        <div className="min-w-0 text-ui-sm tabular-nums">
          <span className="font-mono text-foreground">
            {formatStartPlanRemainingPercentage(remainingRatio, locale)}
          </span>
          {renewTime ? <span className="text-foreground-subtle"> · {renewTime}</span> : null}
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
        {/* Aligned with the Coding Plan quota bar, the width smoothly transitions to the new value after hover silently refreshes and returns.
            Instantaneous jumps will make "refreshed" completely insensitive; while retaining motion-reduce's barrier-free degradation. */}
        <div
          className="h-full rounded-full bg-success transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${remainingRatio * 100}%` }}
        />
      </div>
    </div>
  );
}

export function ChatStartPlanBalancePanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatStartPlanBalanceConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const limits = getVisibleStartPlanLimits(config.snapshot);

  if (!config.loading && limits.length === 0) {
    return null;
  }

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.startPlan.balance.title" })}
          </span>
          {config.loading || config.refreshing === true ? (
            // Silent access will not set entitlement.loading to true when refreshing cached snapshots.
            // The spinner also needs to follow the current promise (refreshing) triggered by hover, which is consistent with the semantics of the Coding Plan segment.
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
        {config.onUpgradeClick ? (
          <CodingPlanEntryButton
            type="button"
            size="xs"
            className="h-6 shrink-0 gap-1 px-2 text-ui-sm"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              config.onUpgradeClick?.();
            }}
          >
            <RocketIcon className="size-3" />
            {intl.formatMessage({ id: "chat.quota.action.upgrade" })}
          </CodingPlanEntryButton>
        ) : null}
      </div>
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(limits.length))}>
        {limits.map((limit) => (
          <ChatStartPlanBalanceMeter
            key={`${limit.type}:${formatLimitModels(limit)}`}
            limit={limit}
            locale={locale}
          />
        ))}
      </div>
    </div>
  );
}
