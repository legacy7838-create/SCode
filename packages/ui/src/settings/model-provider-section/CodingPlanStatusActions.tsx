import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import { ArrowLeftIcon, Loader2Icon, RocketIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanLoginOptions } from "./codingPlanPricingCards.js";

export function CodingPlanStatusActions({
  providerName,
  isDisconnected,
  isUnavailable,
  isPurchased,
  loginLoading,
  loginButtonId,
  loginVisible,
  canDisconnectProvider,
  disconnectLoading,
  onLogin,
  onDisconnect,
}: {
  providerName: string;
  isDisconnected: boolean;
  isUnavailable: boolean;
  isPurchased: boolean;
  loginLoading?: boolean;
  loginButtonId: string;
  loginVisible: boolean;
  canDisconnectProvider: boolean;
  disconnectLoading?: boolean;
  onLogin?: (options?: CodingPlanLoginOptions) => void;
  onDisconnect?: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex shrink-0 flex-wrap justify-start gap-2">
      {loginVisible && (isDisconnected || isUnavailable) && onLogin ? (
        <Button type="button" size="lg" onClick={() => onLogin()} disabled={loginLoading}>
          {loginLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({ id: loginButtonId }, { provider: providerName })}
        </Button>
      ) : null}
      {canDisconnectProvider && onDisconnect && !isPurchased ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disconnectLoading}
          onClick={onDisconnect}
        >
          {disconnectLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({
            id: "settings.modelProvider.codingPlan.disconnect",
          })}
        </Button>
      ) : null}
    </div>
  );
}

export function CodingPlanUpgradeAction({
  loginLoading,
  upgradePlansVisible,
  actionLabelId = "settings.modelProvider.codingPlan.upgrade",
  onUpgradePlansVisibleChange,
}: {
  loginLoading?: boolean;
  upgradePlansVisible: boolean;
  actionLabelId?: string;
  onUpgradePlansVisibleChange: (visible: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  // The open source version does not enjoy quota activity benefits. The upgrade entrance only displays operations and does not come with discount logos or rules instructions.
  return (
    <CodingPlanEntryButton
      bypassGate={upgradePlansVisible}
      type="button"
      size="lg"
      onClick={() => {
        // The purchase/upgrade entrance must first open the panel. OAuth failure recovery is selected by the user in the panel.
        // Plan/cycle post-processing to avoid clicking Upgrade and jumping directly to login, causing users to not see the purchase process.
        onUpgradePlansVisibleChange(!upgradePlansVisible);
      }}
      disabled={loginLoading}
    >
      {loginLoading ? (
        // Upgrade may first trigger the refresh of the OAuth business token.
        // During the waiting period, there is only disabled and no spinner, and the user will mistakenly think that there is no response to the click.
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : upgradePlansVisible ? (
        <ArrowLeftIcon className="size-3.5" />
      ) : (
        <RocketIcon className="size-3.5" />
      )}
      {intl.formatMessage({
        id: upgradePlansVisible ? "settings.modelProvider.codingPlan.cancelUpgrade" : actionLabelId,
      })}
    </CodingPlanEntryButton>
  );
}
