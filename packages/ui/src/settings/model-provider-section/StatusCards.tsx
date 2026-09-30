import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- Coding Plan/Start Plan status card centrally arranges status, actions and package blocks. Currently, keep the same file to avoid splitting the status semantics. */
import {
  BIGMODEL_PROVIDER_ID,
  isStartPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  type UsageEntitlementSubscriptionDetail,
  type UsageQuotaLimit,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { InfoIcon, Loader2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { logger } from "@/logger.js";
import { LocalizedCodingPlanQuotaResetAction } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.js";
import { CodingPlanQuotaResetOpportunity } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import { buildCodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import {
  formatQuotaResetTime,
  isCodingPlanQuotaLimitFull,
  isSameLimitCategory,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
  type CodingPlanFunnelContext,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  type CodingPlanStatus,
  type CodingPlanProviderId,
  type TeamPlanAvailabilityReason,
} from "./constants.js";
import type { CodingPlanStatusPanelViewState } from "./codingPlanStatusPanelViewState.js";
import { CodingPlanStatusMeta, StartPlanStatusMeta } from "./CodingPlanStatusMeta.js";
import { CodingPlanStatusActions, CodingPlanUpgradeAction } from "./CodingPlanStatusActions.js";
import type { CodingPlanLoginOptions } from "./codingPlanPricingCards.js";
import type { PurchaseAudience } from "./codingPlanEnterpriseTiers.js";
import { StartPlanCard } from "./StartPlanCard.js";
import { StartPlanQuotaStatusCard } from "./StartPlanQuotaStatusCard.js";
import { resolveStartPlanQuotaCardEntries } from "./StartPlanBalanceCard.js";
import { useStartPlanPreview } from "./useStartPlanPreview.js";
import {
  BigModelRegistrationHint,
  isBigModelUnregisteredAuthError,
} from "./BigModelRegistrationHint.js";
import { formatQuotaModelDisplayName } from "./quotaModelDisplayName.js";

const CODING_PLAN_USAGE_SUMMARY_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
] as const;

function PlanStatusCardSurface({
  planTitle,
  titleAccessory,
  statusMeta,
  trailingAction,
  usageContent,
}: {
  planTitle: string;
  titleAccessory?: ReactNode;
  statusMeta: ReactNode;
  trailingAction?: ReactNode;
  usageContent?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <h3 className="min-w-0 truncate text-ui-lg font-semibold leading-5 text-foreground">
              {planTitle}
            </h3>
            {titleAccessory}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {statusMeta}
          </div>
        </div>
        {trailingAction ? (
          <div className="shrink-0 max-sm:flex max-sm:w-full max-sm:[&>button]:w-full">
            {trailingAction}
          </div>
        ) : null}
      </div>
      {usageContent ? (
        <>
          <div className="my-4 border-t border-border" />
          {usageContent}
        </>
      ) : null}
    </div>
  );
}

export function ModelProviderLoadingCard({ loadingLabel }: { loadingLabel: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
        <Loader2Icon className="size-4 animate-spin" />
        <span>{loadingLabel}</span>
      </div>
    </div>
  );
}

export function PresetProviderPlaceholderCard({
  displayName,
  messageId = "settings.modelProvider.presetEmpty",
}: {
  displayName: string;
  messageId?: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="bg-background/50 rounded-2xl p-3">
      <div className="text-ui-lg font-semibold text-foreground">{displayName}</div>
      <div className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: messageId })}
      </div>
    </div>
  );
}

export function CodingPlanStatusPanel({
  providerId,
  providerName,
  status,
  viewState,
  loginLoading,
  disconnectLoading,
  purchaseUrl,
  planLevel,
  inactivePlanTitle,
  subscriptionRenewTime,
  subscriptionExpireTime,
  subscriptionDetails,
  quotaLimits = [],
  mcpQuotaLimit = null,
  authError,
  onOpenRegistration,
  onLogin,
  onRetry,
  reloginOnFailure = false,
  onOpenPurchase,
  onDisconnect,
  onOpenUpgradePlans,
  purchaseInitialAudience = "personal",
  loginActionPlacement = "inline",
  loginActionVisible = false,
  usageDetailsVisible = true,
  upgradeActionVisible = true,
  upgradePlansVisible: controlledUpgradePlansVisible,
  onUpgradePlansVisibleChange,
  startPlanPreviewVisible = true,
  statusLabelId,
  statusMessage,
  teamPlanAvailabilityReason,
  quotaResetSourceKey,
  quotaResetAccountAccess,
  onQuotaResetEntitlementRefresh,
}: {
  providerId: CodingPlanProviderId;
  providerName: string;
  status: CodingPlanStatus;
  viewState?: CodingPlanStatusPanelViewState;
  loginLoading?: boolean;
  disconnectLoading?: boolean;
  purchaseUrl?: string;
  planLevel?: string | null;
  inactivePlanTitle?: string | null;
  subscriptionRenewTime?: string | null;
  subscriptionExpireTime?: string | null;
  subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
  quotaLimits?: UsageQuotaLimit[];
  /** Official Server MCP quota (total quota issued by the server). Not in quota.limits[], it is transparently transmitted by nav item alone. */
  mcpQuotaLimit?: UsageQuotaLimit | null;
  authError?: string | null;
  onOpenRegistration?: () => void;
  onLogin?: (options?: CodingPlanLoginOptions) => number | void | Promise<void>;
  /** If the credential acquisition fails, you will be prompted to log in again automatically, and the account will not be automatically logged out accordingly. */
  reloginOnFailure?: boolean;
  /** If the Start package fails to be obtained, the Host will be refreshed manually and re-login will not be forced. */
  onRetry?: () => void;
  onOpenPurchase?: (url: string) => void;
  onDisconnect?: () => void;
  onOpenUpgradePlans?: (options: {
    initialAudience: PurchaseAudience;
    funnelContext: CodingPlanFunnelContext | null;
  }) => void;
  /** After the native panel is removed, the Team status card still needs to pass the purchase object to the unified upgrade portal. */
  purchaseInitialAudience?: PurchaseAudience;
  loginActionPlacement?: "inline" | "trailing";
  loginActionVisible?: boolean;
  usageDetailsVisible?: boolean;
  upgradeActionVisible?: boolean;
  upgradePlansVisible?: boolean;
  onUpgradePlansVisibleChange?: (visible: boolean) => void;
  startPlanPreviewVisible?: boolean;
  statusLabelId?: string;
  statusMessage?: string | null;
  teamPlanAvailabilityReason?: TeamPlanAvailabilityReason;
  /** Team Plan must pass the complete connection key to avoid sharing reset status with personal plans of the same provider. */
  quotaResetSourceKey?: string;
  quotaResetAccountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  onQuotaResetEntitlementRefresh?: () => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [internalUpgradePlansVisible, setInternalUpgradePlansVisible] = useState(false);
  const [startPlanEntitlementRefreshing, setStartPlanEntitlementRefreshing] = useState(false);
  const upgradePlansVisible = controlledUpgradePlansVisible ?? internalUpgradePlansVisible;
  const setUpgradePlansVisible = onUpgradePlansVisibleChange ?? setInternalUpgradePlansVisible;
  const refreshStartPlanEntitlement = async () => {
    if (!onQuotaResetEntitlementRefresh || startPlanEntitlementRefreshing) {
      return;
    }
    setStartPlanEntitlementRefreshing(true);
    try {
      await onQuotaResetEntitlementRefresh();
    } catch (error) {
      // The quota bucket may not be ready for a short time after the effective time. When the refresh fails, the button must be retained for retry.
      // The "Not yet synchronized" error cannot be converged to completed due to a network error.
      logger.warn("[ModelProviderSection] refresh start plan entitlement failed", {
        error: error instanceof Error ? error.message : String(error),
        providerId,
      });
    } finally {
      setStartPlanEntitlementRefreshing(false);
    }
  };
  const effectiveViewState = viewState ?? {
    displayStatus: status,
    actionStatus: status,
    balanceStatus: status,
    loginLoading: loginLoading === true,
  };
  const isDisconnected = effectiveViewState.displayStatus === "disconnected";
  const isChecking = effectiveViewState.displayStatus === "checking";
  const isUnavailable = effectiveViewState.displayStatus === "unavailable";
  const isUnsupported = effectiveViewState.displayStatus === "unsupported";
  const isPurchased = effectiveViewState.displayStatus === "purchased";
  const isNotPurchased = effectiveViewState.displayStatus === "notPurchased";
  const actionIsDisconnected = effectiveViewState.actionStatus === "disconnected";
  const isStartPlanProvider = isStartPlanModelProviderId(providerId);
  const providerIcon =
    resolveModelProviderFamilySpecByProviderId(providerId)?.oauthProviderId ?? null;
  const canDisconnectProvider =
    !isStartPlanProvider &&
    Boolean(onDisconnect) &&
    !isDisconnected &&
    !isChecking &&
    !isUnavailable &&
    !isUnsupported;
  const loginButtonId = isStartPlanProvider
    ? isUnavailable
      ? "chat.error.action.relogin"
      : "settings.modelProvider.startPlan.login"
    : "settings.modelProvider.codingPlan.connect";
  const defaultStatusBadgeId = isUnsupported
    ? "settings.modelProvider.codingPlan.status.unsupported"
    : isDisconnected
      ? "settings.modelProvider.codingPlan.status.disconnected"
      : isChecking
        ? "settings.modelProvider.codingPlan.status.checking"
        : isUnavailable
          ? "settings.modelProvider.codingPlan.status.unavailable"
          : isPurchased
            ? "settings.modelProvider.codingPlan.status.purchased"
            : "settings.modelProvider.codingPlan.status.notPurchased";
  // The inspection status may still carry the previous round of team errors; the status line only displays the current inspection status to avoid double icons and old errors from flashing.
  const statusBadgeId = isChecking
    ? defaultStatusBadgeId
    : (statusLabelId ??
      (isStartPlanProvider && isDisconnected
        ? "settings.modelProvider.startPlan.status.loginRequired"
        : isStartPlanProvider && isNotPurchased
          ? "settings.modelProvider.startPlan.status.noPlan"
          : defaultStatusBadgeId));
  const statusBadgeMessage = isChecking ? undefined : statusMessage?.trim();
  // Display copy is not status authority. The Team Plan interaction only reads explicit business reasons,
  // Prevent Project Key errors from being misjudged as "Team package not assigned" by translating the key.
  const teamPlanUnavailableStatusVisible =
    teamPlanAvailabilityReason === "not-allocated" || teamPlanAvailabilityReason === "expired";
  const teamPlanWarningVisible = !isChecking && teamPlanAvailabilityReason !== undefined;
  const recoverableUnavailable =
    effectiveViewState.actionStatus === "unavailable" && !teamPlanUnavailableStatusVisible;
  const reloginVisible = recoverableUnavailable && reloginOnFailure && Boolean(onLogin);
  const retryVisible =
    (recoverableUnavailable ||
      statusLabelId === "settings.modelProvider.codingPlan.status.unavailable") &&
    !reloginVisible &&
    Boolean(onRetry);
  const trailingLoginVisible =
    !reloginVisible &&
    !retryVisible &&
    loginActionVisible &&
    loginActionPlacement === "trailing" &&
    (actionIsDisconnected || recoverableUnavailable) &&
    Boolean(onLogin);
  const rawPlanLevel = planLevel?.trim() ?? "";
  const normalizedPlanLevel = rawPlanLevel.toUpperCase();
  const isMaxPlanLevel = isMaxCodingPlanLevel(rawPlanLevel);
  const displayPlanLevel = /^GLM[\s_-]+CODING\b/i.test(rawPlanLevel)
    ? formatQuotaModelDisplayName(rawPlanLevel)
    : normalizedPlanLevel;
  const canUpgrade =
    // Max is already the highest level but still needs to be renewed. The button cannot be hidden just because it cannot be upgraded.
    upgradeActionVisible && isPurchased && !isChecking && !isUnsupported;
  const canManageCodingPlan =
    !isDisconnected &&
    !isChecking &&
    !isUnsupported &&
    isPurchased &&
    Boolean(purchaseUrl) &&
    Boolean(onOpenPurchase);
  const disconnectedStartPlanPricingVisible =
    isStartPlanProvider && (isDisconnected || isNotPurchased);
  const startPlanCardVisible =
    startPlanPreviewVisible && disconnectedStartPlanPricingVisible && !upgradePlansVisible;
  const startPlanPreview = useStartPlanPreview({
    enabled: startPlanCardVisible,
  });
  const shouldShowBigModelRegistrationHint =
    isChecking &&
    providerIcon === BIGMODEL_PROVIDER_ID &&
    isBigModelUnregisteredAuthError(authError);
  const createSettingPlanCardFunnelContext = (eventText: string) =>
    createCodingPlanFunnelContext({
      providerId,
      // Reason for repair: The upgrade entrance of Start Plan and the ordinary Coding Plan package card belong to different link methods.
      // The hidden points must be identified separately to avoid misclassifying Start Plan users as ordinary package card sources.
      upgradeSource: isStartPlanProvider ? "setting_start_plan_card" : "setting_plan_card",
      eventRegion: "app.setting",
      eventText,
      entryPlanState: resolveCodingPlanEntryPlanState({
        displayStatus: effectiveViewState.displayStatus,
        providerId,
        planLevel,
      }),
    });
  const openUpgradePlans = (
    initialAudience: PurchaseAudience,
    nextFunnelContext: CodingPlanFunnelContext | null,
  ) => {
    if (onOpenUpgradePlans) {
      // The Coding Plan purchase process should not continue to be mounted inside Model Settings;
      // The status card is only responsible for initiating the intention, and the pop-up hook hosts the purchase panel.
      onOpenUpgradePlans({
        initialAudience,
        funnelContext: nextFunnelContext,
      });
      return;
    }
    setUpgradePlansVisible(true);
  };
  const upgradeAction = canUpgrade ? (
    <CodingPlanUpgradeAction
      loginLoading={effectiveViewState.loginLoading}
      upgradePlansVisible={upgradePlansVisible}
      actionLabelId={
        isMaxPlanLevel
          ? "settings.modelProvider.codingPlan.renew"
          : "settings.modelProvider.codingPlan.upgrade"
      }
      onUpgradePlansVisibleChange={(visible) => {
        if (visible) {
          openUpgradePlans(
            purchaseInitialAudience,
            createSettingPlanCardFunnelContext(
              intl.formatMessage({
                id: isMaxPlanLevel
                  ? "settings.modelProvider.codingPlan.renew"
                  : "settings.modelProvider.codingPlan.upgrade",
              }),
            ),
          );
          return;
        }
        setUpgradePlansVisible(visible);
      }}
    />
  ) : null;
  const buyAction =
    !isStartPlanProvider && !canUpgrade && isNotPurchased && !isChecking && !isUnsupported ? (
      <CodingPlanEntryButton
        type="button"
        size="lg"
        // The unpurchased status may also be waiting for the equity interface to return; at this time, it must be contacted with Upgrade
        // The button is also disabled to prevent old notPurchased snapshots from being submitted for purchase in advance.
        disabled={effectiveViewState.loginLoading}
        onClick={() => {
          openUpgradePlans(
            purchaseInitialAudience,
            createSettingPlanCardFunnelContext(
              intl.formatMessage({
                id: "settings.modelProvider.codingPlan.subscribe",
              }),
            ),
          );
        }}
      >
        {/* Single card synchronization may be later than global package query; only disabling it will lose waiting feedback, consistent with Upgrade. */}
        {effectiveViewState.loginLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
        {intl.formatMessage({
          id: "settings.modelProvider.codingPlan.subscribe",
        })}
      </CodingPlanEntryButton>
    ) : null;
  const inlineDisconnectVisible = canDisconnectProvider && !isPurchased;
  const planTitle = resolveCodingPlanStatusCardTitle({
    isPurchased,
    isUnavailable,
    isStartPlanProvider,
    inactivePlanTitle,
    rawPlanLevel,
    displayPlanLevel,
    startPlanTitle: intl.formatMessage({
      id: "settings.modelProvider.planCard.startPlan",
    }),
    codingPlanTitle: intl.formatMessage({
      id: "settings.modelProvider.planCard.codingPlan",
    }),
  });
  const notPurchasedStatusLabel = isNotPurchased ? (
    <span className="flex w-fit items-center gap-1.5 text-foreground-subtle">
      <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
      <span>{intl.formatMessage({ id: statusBadgeId })}</span>
    </span>
  ) : null;
  const startPlanEntries = resolveStartPlanQuotaCardEntries({
    plans: subscriptionDetails ?? [],
    limits: quotaLimits,
  });
  const statusMeta =
    isPurchased && isStartPlanProvider ? (
      // Product semantics: The usage card of the experience package does not display the "Manage" and "Unbind" operations (the free package does not have a management page,
      // The login state is managed by the family-level connection method), and only the expiration time and the upgrade Coding Plan entry on the right are retained.
      <StartPlanStatusMeta
        expireTime={subscriptionExpireTime}
        entitlements={subscriptionDetails?.[0]?.entitlements}
        hasQuota={hasStartPlanEntitlementQuota(
          subscriptionDetails?.[0]?.entitlements,
          startPlanEntries[0]?.limits ?? quotaLimits,
        )}
        refreshing={startPlanEntitlementRefreshing}
        onRefresh={refreshStartPlanEntitlement}
      />
    ) : isPurchased ? (
      <CodingPlanStatusMeta
        renewTime={subscriptionRenewTime}
        expireTime={subscriptionExpireTime}
        manageLabel={
          canManageCodingPlan
            ? intl.formatMessage({
                id: "settings.modelProvider.codingPlan.manage",
              })
            : null
        }
        unlinkLabel={
          canDisconnectProvider
            ? intl.formatMessage({
                id: "settings.modelProvider.codingPlan.disconnect",
              })
            : null
        }
        unlinkLoading={disconnectLoading}
        onManage={
          canManageCodingPlan && purchaseUrl && onOpenPurchase
            ? () => onOpenPurchase(purchaseUrl)
            : undefined
        }
        onUnlink={canDisconnectProvider ? onDisconnect : undefined}
      />
    ) : shouldShowBigModelRegistrationHint ? (
      <BigModelRegistrationHint onOpenRegistration={onOpenRegistration} />
    ) : inlineDisconnectVisible ? (
      <CodingPlanStatusMeta
        statusLabel={notPurchasedStatusLabel ?? intl.formatMessage({ id: statusBadgeId })}
        unlinkLabel={intl.formatMessage({
          id: "settings.modelProvider.codingPlan.disconnect",
        })}
        unlinkLoading={disconnectLoading}
        onUnlink={onDisconnect}
      />
    ) : (
      <span
        className={
          teamPlanWarningVisible
            ? "flex w-fit items-center gap-1.5 text-ui-base text-warning"
            : "flex w-fit items-center gap-1.5 text-ui-base text-foreground-subtle"
        }
      >
        {isChecking ? <Loader2Icon className="size-3 animate-spin" /> : null}
        {isNotPurchased || teamPlanWarningVisible ? (
          <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
        ) : null}
        {statusBadgeMessage || intl.formatMessage({ id: statusBadgeId })}
      </span>
    );
  const usageCardsVisible =
    usageDetailsVisible &&
    isPurchased &&
    (isStartPlanProvider || hasDisplayableCodingPlanUsageLimits(quotaLimits));
  // When the family is logged in, the default login action is only refresh; active recovery after credential failure must be forced into OAuth.
  const trailingAction = reloginVisible ? (
    <Button
      type="button"
      size="lg"
      onClick={() => onLogin?.({ forceOAuth: true })}
      disabled={effectiveViewState.loginLoading}
    >
      {intl.formatMessage({ id: "login.expired.action" })}
    </Button>
  ) : retryVisible ? (
    <Button type="button" size="lg" onClick={onRetry} disabled={effectiveViewState.loginLoading}>
      {intl.formatMessage({ id: "common.retry" })}
    </Button>
  ) : trailingLoginVisible ? (
    <Button
      type="button"
      size="lg"
      onClick={() => onLogin?.()}
      disabled={effectiveViewState.loginLoading}
    >
      {effectiveViewState.loginLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
      {intl.formatMessage({ id: loginButtonId }, { provider: providerName })}
    </Button>
  ) : upgradeAction ? (
    // Upgrade is the main operation of Plan Card, and it is a card-level action like the connection entry.
    // If placed next to the title, it will vibrate as the title wraps. Place it on the right side and use buttons of the same size, so the hierarchy and position are more stable.
    upgradeAction
  ) : buyAction ? (
    buyAction
  ) : null;
  const statusContent = (
    <>
      {isPurchased && statusLabelId === "settings.modelProvider.codingPlan.status.unavailable" ? (
        <span className="text-ui-base text-warning">
          {intl.formatMessage({ id: statusLabelId })}
        </span>
      ) : null}
      {statusMeta}
      <CodingPlanStatusActions
        providerName={providerName}
        isDisconnected={actionIsDisconnected}
        isUnavailable={recoverableUnavailable}
        isPurchased={isPurchased}
        loginLoading={effectiveViewState.loginLoading}
        loginButtonId={loginButtonId}
        loginVisible={
          loginActionVisible && !trailingLoginVisible && !reloginVisible && !retryVisible
        }
        canDisconnectProvider={inlineDisconnectVisible ? false : canDisconnectProvider}
        disconnectLoading={disconnectLoading}
        onLogin={onLogin}
        onDisconnect={onDisconnect}
      />
    </>
  );
  const planCards =
    isStartPlanProvider && isPurchased && startPlanEntries.length > 0
      ? startPlanEntries.map(({ plan, limits: planLimits }, index) => (
          <PlanStatusCardSurface
            key={`${plan.productId}:${index}`}
            planTitle={plan.productName.trim() || planTitle}
            statusMeta={
              index === 0 ? (
                statusContent
              ) : (
                <StartPlanStatusMeta
                  expireTime={plan.expireTime}
                  entitlements={plan.entitlements}
                  hasQuota={hasStartPlanEntitlementQuota(plan.entitlements, planLimits)}
                  refreshing={startPlanEntitlementRefreshing}
                  onRefresh={refreshStartPlanEntitlement}
                />
              )
            }
            trailingAction={index === 0 ? trailingAction : undefined}
            usageContent={
              usageDetailsVisible &&
              (effectiveViewState.balanceStatus === "checking" || planLimits.length > 0) ? (
                <StartPlanQuotaStatusCard
                  isChecking={effectiveViewState.balanceStatus === "checking"}
                  limits={planLimits}
                  embedded
                />
              ) : undefined
            }
          />
        ))
      : [
          <PlanStatusCardSurface
            key="current-plan"
            planTitle={planTitle}
            statusMeta={statusContent}
            trailingAction={trailingAction}
            usageContent={
              usageCardsVisible ? (
                isStartPlanProvider ? (
                  // The server contract guarantees that balances only belong to active plans: purchased snapshots must contain package details.
                  // Multi-card paths are bound to be available. The bottom branch (nav item has no package details) must not use the full quotaLimits
                  // Insert a single card, otherwise the unowned bucket violates the agreement that "buckets without matching plan_id shall not be attached to any card";
                  // When the balance is not settled, only the query placeholder will be reserved.
                  effectiveViewState.balanceStatus === "checking" ? (
                    <StartPlanQuotaStatusCard
                      isChecking
                      limits={[]}
                      expireTime={subscriptionExpireTime}
                      embedded
                    />
                  ) : undefined
                ) : (
                  <CodingPlanUsageSummaryCards
                    limits={quotaLimits}
                    mcpQuotaLimit={mcpQuotaLimit}
                    sourceKey={quotaResetSourceKey ?? providerId}
                    preferredProviderId={providerId}
                    accountAccess={quotaResetAccountAccess}
                    onEntitlementRefresh={onQuotaResetEntitlementRefresh}
                  />
                )
              ) : undefined
            }
          />,
        ];

  return (
    <div className="space-y-3">
      {planCards}

      {startPlanCardVisible && !startPlanPreview.loading && startPlanPreview.preview ? (
        <StartPlanCard preview={startPlanPreview.preview} />
      ) : null}
    </div>
  );
}

function hasStartPlanEntitlementQuota(
  entitlements: UsageEntitlementSubscriptionDetail["entitlements"],
  limits: readonly UsageQuotaLimit[],
): boolean {
  const entitlementIds = new Set(
    (entitlements ?? [])
      .map((entitlement) => entitlement.entitlementId.trim().toLowerCase())
      .filter(Boolean),
  );
  if (entitlementIds.size === 0) {
    return limits.length > 0;
  }
  return limits.some((limit) => entitlementIds.has(limit.type.trim().toLowerCase()));
}

function resolveCodingPlanStatusCardTitle({
  isPurchased,
  isUnavailable = false,
  isStartPlanProvider,
  inactivePlanTitle,
  rawPlanLevel,
  displayPlanLevel,
  startPlanTitle,
  codingPlanTitle,
}: {
  isPurchased: boolean;
  isUnavailable?: boolean;
  isStartPlanProvider: boolean;
  inactivePlanTitle?: string | null;
  rawPlanLevel: string;
  displayPlanLevel: string;
  startPlanTitle: string;
  codingPlanTitle: string;
}): string {
  if (!isPurchased) {
    return inactivePlanTitle?.trim() || (isStartPlanProvider ? startPlanTitle : codingPlanTitle);
  }

  if (isStartPlanProvider) {
    // Start providers occasionally host benefit snapshots of paid Coding Plans of the same brand.
    // Only real Start benefits will continue to display Start Plan; otherwise, the back-end benefit name must be exposed to prevent paying users from seeing the free package title.
    return isStartPlanEntitlementName(rawPlanLevel)
      ? startPlanTitle
      : displayPlanLevel || startPlanTitle;
  }

  return displayPlanLevel || codingPlanTitle;
}

function isStartPlanEntitlementName(planLevel: string): boolean {
  const normalized = planLevel.trim().toLowerCase();
  return (
    normalized === "start" || normalized === "start plan" || normalized.endsWith(" start plan")
  );
}

function isMaxCodingPlanLevel(planLevel: string): boolean {
  return /(^|[\s_-])MAX($|[\s_-])/i.test(planLevel);
}

function CodingPlanUsageSummaryCards({
  limits,
  mcpQuotaLimit,
  sourceKey,
  preferredProviderId,
  accountAccess,
  onEntitlementRefresh,
}: {
  limits: UsageQuotaLimit[];
  mcpQuotaLimit: UsageQuotaLimit | null;
  sourceKey: string;
  preferredProviderId: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  onEntitlementRefresh?: () => void | Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  const [quotaResetDialogOpen, setQuotaResetDialogOpen] = useState(false);
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey,
    preferredProviderId,
    accountAccess,
    onEntitlementRefresh,
  });
  const fiveHourLimit = resolveCodingPlanQuotaResetLimit(
    findUsageLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyLimit = resolveCodingPlanQuotaResetLimit(
    findUsageLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );
  // There is no profit from resetting when the balance is 100%: Hide the reset button and opportunity logo (pure display, does not affect distribution and polling).
  const fiveHourQuotaFull = isCodingPlanQuotaLimitFull(fiveHourLimit);
  const weeklyQuotaFull = isCodingPlanQuotaLimitFull(weeklyLimit);
  const standardCards = [
    createCodingPlanUsageSummaryCard({
      key: "fiveHour",
      label: intl.formatMessage({
        id: "settings.usage.entitlementFiveHourUsage",
      }),
      limit: fiveHourLimit ?? undefined,
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[0],
      resetTimeFormat: "dateTime",
    }),
    createCodingPlanUsageSummaryCard({
      key: "weekly",
      label: intl.formatMessage({
        id: "settings.usage.entitlementWeeklyUsage",
      }),
      limit: weeklyLimit ?? undefined,
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[1],
      resetTimeFormat: "date",
    }),
    createCodingPlanUsageSummaryCard({
      key: "monthlyTool",
      label: intl.formatMessage({
        id: "settings.usage.entitlementMonthlyMcpUsage",
      }),
      limit: findUsageLimit(limits, "TIME_LIMIT", 5, 1),
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[2],
      resetTimeFormat: "date",
    }),
    createCodingPlanUsageSummaryCard({
      key: "serverMcp",
      label: intl.formatMessage({
        id: "settings.usage.entitlementServerMcpUsage",
      }),
      limit: mcpQuotaLimit ?? undefined,
      progressColor: "var(--color-usage-chart-5)",
      // The official Server MCP limit is reset according to the natural day. The reset time is always 00:00, and the date caliber is consistent with other limit cards.
      resetTimeFormat: "date",
    }),
  ].filter((card): card is CodingPlanUsageSummaryCard => card !== null);
  const cards =
    standardCards.length > 0
      ? standardCards
      : limits
          .filter(isDisplayableUsageLimit)
          .slice(0, 3)
          .map((limit, index) => ({
            key: `generic-${index}`,
            label: resolveGenericUsageLimitLabel(limit, intl),
            limit,
            progressColor:
              CODING_PLAN_USAGE_SUMMARY_COLORS[index % CODING_PLAN_USAGE_SUMMARY_COLORS.length] ??
              CODING_PLAN_USAGE_SUMMARY_COLORS[0],
            resetTimeFormat: "date" as const,
          }));

  const fiveHourCardVisible = cards.some((card) => card.key === "fiveHour");
  const weeklyCardVisible = cards.some((card) => card.key === "weekly");
  // The five-hour and weekly opportunities are combined into one logo, the times are accumulated, and the countdown takes the earliest expiration level.
  const opportunityBadge = mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible: fiveHourCardVisible && resetUi.opportunityVisible && !fiveHourQuotaFull,
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible: weeklyCardVisible && resetUi.week.opportunityVisible && !weeklyQuotaFull,
    },
  ]);
  const quotaResetDialog = buildCodingPlanQuotaResetDialogConfig({
    fiveHourEnabled: Boolean(fiveHourLimit),
    fiveHourQuotaFull,
    resetUi,
    usageItems: cards.map((card) => {
      const percentage = resolveLimitRemainingPercentage(card.limit);
      return {
        color: card.progressColor,
        id: card.key,
        label: card.label,
        percentage,
        resetTime: formatQuotaResetTime({
          locale,
          value: card.limit.nextResetTime,
          format: card.resetTimeFormat,
          compactToday: card.resetTimeFormat === "dateTime",
        }),
        value: formatRemainingPercentage(locale, percentage),
      };
    }),
    weekEnabled: Boolean(weeklyLimit),
    weekQuotaFull: weeklyQuotaFull,
  });

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <h4 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
        </h4>
        {(fiveHourCardVisible && resetUi.entry) || (weeklyCardVisible && resetUi.week.entry) ? (
          <CodingPlanQuotaResetOpportunity
            count={opportunityBadge.count}
            dialog={quotaResetDialog}
            dialogOpen={quotaResetDialogOpen}
            expiresAt={opportunityBadge.expiresAt}
            placement="inline"
            visible={opportunityBadge.visible}
            onDialogOpenChange={setQuotaResetDialogOpen}
          />
        ) : null}
      </div>
      <div className="flex w-full gap-2 max-sm:flex-col">
        {cards.map((card) => (
          <PlanUsageMetricCard
            key={card.key}
            action={
              // The entrance next to the quota title only opens a unified pop-up window; the actual write-off is triggered by the corresponding type button in the pop-up window.
              card.key === "fiveHour" &&
              resetUi.entry &&
              ((resetUi.opportunityVisible && !fiveHourQuotaFull && opportunityBadge.count <= 1) ||
                resetUi.processing ||
                resetUi.entry.status === "completed") ? (
                <LocalizedCodingPlanQuotaResetAction
                  completedAt={resetUi.entry.completedAt}
                  processing={resetUi.processing}
                  onOpenDialog={() => setQuotaResetDialogOpen(true)}
                />
              ) : card.key === "weekly" &&
                resetUi.week.entry &&
                ((resetUi.week.opportunityVisible &&
                  !weeklyQuotaFull &&
                  opportunityBadge.count <= 1) ||
                  resetUi.week.processing ||
                  resetUi.week.entry.status === "completed") ? (
                <LocalizedCodingPlanQuotaResetAction
                  completedAt={resetUi.week.entry.completedAt}
                  processing={resetUi.week.processing}
                  resetType="WEEK"
                  onOpenDialog={() => setQuotaResetDialogOpen(true)}
                />
              ) : undefined
            }
            label={card.label}
            limit={card.limit}
            infoDescription={
              card.key === "serverMcp"
                ? intl.formatMessage({
                    id: "sidebar.usage.plan.zcodeMcpDescription",
                  })
                : undefined
            }
            progressColor={card.progressColor}
            resetTimeFormat={card.resetTimeFormat}
          />
        ))}
      </div>
    </div>
  );
}

interface CodingPlanUsageSummaryCard {
  key: string;
  label: string;
  limit: UsageQuotaLimit;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}

function createCodingPlanUsageSummaryCard(card: {
  key: string;
  label: string;
  limit: UsageQuotaLimit | undefined;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}): CodingPlanUsageSummaryCard | null {
  // The remaining balance display of the Coding Plan must be the same as the sidebar/context and only display the balance items actually returned by the interface.
  // Limits[0]/[1]/[2] cannot be used anymore, otherwise three cards will appear in the provider details and will be inconsistent with other entries.
  if (!card.limit) {
    return null;
  }
  return {
    key: card.key,
    label: card.label,
    limit: card.limit,
    progressColor: card.progressColor,
    resetTimeFormat: card.resetTimeFormat,
  };
}

function hasDisplayableCodingPlanUsageLimits(limits: UsageQuotaLimit[]): boolean {
  return Boolean(
    findUsageLimit(limits, "TOKENS_LIMIT", 3, 5) ||
    findUsageLimit(limits, "TOKENS_LIMIT", 6) ||
    findUsageLimit(limits, "TIME_LIMIT", 5, 1) ||
    limits.some(isDisplayableUsageLimit),
  );
}

function isDisplayableUsageLimit(limit: UsageQuotaLimit): boolean {
  return (
    typeof limit.percentage === "number" ||
    typeof limit.remaining === "number" ||
    typeof limit.currentValue === "number" ||
    typeof limit.usage === "number"
  );
}

function resolveGenericUsageLimitLabel(
  limit: UsageQuotaLimit,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  if (limit.type === "TIME_LIMIT") {
    return intl.formatMessage({
      id: "settings.usage.entitlementMonthlyMcpUsage",
    });
  }
  // The quota limit of the Team Plan may not be the quota limit of the individual Coding Plan in the test environment.
  // TOKENS_LIMIT(3/5, 6) form. At this time, the remaining balance should still be displayed, and it should not be blank because the type is not in the whitelist.
  return intl.formatMessage({
    id: "settings.modelProvider.planCard.usage.totalTokens",
  });
}

function PlanUsageMetricCard({
  action,
  infoDescription,
  label,
  limit,
  progressColor,
  resetTimeFormat,
}: {
  action?: ReactNode;
  infoDescription?: string;
  label?: string;
  limit?: UsageQuotaLimit;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}) {
  const { locale } = useZCodeIntl();
  const remainingPercentage = resolveLimitRemainingPercentage(limit);
  const progressPercentage = remainingPercentage ?? 0;
  const modelLabel = limit && limit.type !== "TIME_LIMIT" ? formatLimitModels(limit) : "";
  const resetTime = formatQuotaResetTime({
    locale,
    value: limit?.nextResetTime,
    format: resetTimeFormat,
    compactToday: resetTimeFormat === "dateTime",
  });

  return (
    <div className="min-w-0 flex-1 rounded-lg bg-surface p-3">
      {label ? (
        // Fixed 24px will cause the 30px line box with a 20px interface font size to overflow; the minimum height will maintain the default alignment and allow large font sizes to be raised.
        <div className="flex min-h-6 min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">{label}</span>
          {infoDescription ? (
            <ControlHintTooltip title={infoDescription} standalone>
              <button
                type="button"
                aria-label={infoDescription}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtle transition-colors hover:text-foreground"
                data-zcode-mcp-info="model-settings"
              >
                <InfoIcon className="size-3.5" aria-hidden="true" />
              </button>
            </ControlHintTooltip>
          ) : null}
          {action ? <span className="shrink-0">{action}</span> : null}
        </div>
      ) : null}
      {modelLabel ? (
        <div className={`truncate text-ui-xs text-foreground-subtle ${label ? "mt-1" : ""}`}>
          {modelLabel}
        </div>
      ) : null}
      <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
        <span className="text-ui-lg font-semibold leading-none text-foreground">
          {formatRemainingPercentage(locale, remainingPercentage)}
        </span>
        {resetTime ? (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{resetTime}</span>
        ) : null}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${progressPercentage}%`,
            backgroundColor: progressColor,
          }}
        />
      </div>
    </div>
  );
}

function findUsageLimit(
  limits: UsageQuotaLimit[],
  type: UsageQuotaLimit["type"],
  unit: number,
  number?: number,
): UsageQuotaLimit | undefined {
  return limits.find(
    (limit) =>
      // zai team plan returns CREDIT_LIMIT, bigmodel returns TOKENS_LIMIT,
      // unit/number semantics are consistent. Use isSameLimitCategory to make both hits equal.
      isSameLimitCategory(limit.type, type) &&
      limit.unit === unit &&
      (number == null || limit.number === number),
  );
}

function resolveLimitRemainingPercentage(limit: UsageQuotaLimit | undefined): number | null {
  const usedPercentage = normalizeUsagePercentage(limit?.percentage);
  if (usedPercentage !== null) {
    // The percentage of the Coding Plan quota interface is the used percentage.
    // The Plan Card belongs to the "remaining balance" view and needs to be displayed in an inverted manner consistent with the remaining balance menu in the sidebar.
    return Math.max(0, Math.min(100, 100 - usedPercentage));
  }
  const remaining = limit?.remaining;
  const total = limit?.number;
  if (
    typeof remaining === "number" &&
    Number.isFinite(remaining) &&
    typeof total === "number" &&
    Number.isFinite(total) &&
    total > 0
  ) {
    return Math.max(0, Math.min(100, (remaining / total) * 100));
  }
  return null;
}

function normalizeUsagePercentage(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

function formatRemainingPercentage(locale: string, value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(Math.max(0, Math.min(100, value)))}%`;
}

function formatLimitModels(limit: UsageQuotaLimit): string {
  const modelNames = limit.usageDetails
    .map((detail) => {
      const displayName = detail.displayName?.trim();
      return formatQuotaModelDisplayName(displayName || formatModelCode(detail.modelCode.trim()));
    })
    .filter((modelName) => modelName.length > 0);
  return Array.from(new Set(modelNames)).join(" / ");
}

function formatModelCode(modelCode: string): string {
  const normalized = modelCode
    .replace(/^model:/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return normalized || modelCode;
}
