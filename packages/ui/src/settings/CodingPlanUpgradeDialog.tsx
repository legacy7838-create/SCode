import { useCallback } from "react";
import { resolveModelProviderFamilyIdByProviderId } from "@zcode/shared";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { type CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";
import { resolveCodingPlanUpgradeProductsProviderId } from "@/settings/model-provider-section/codingPlanPricingCards.js";
import { normalizeCodingPlanProviderId } from "@/settings/model-provider-section/codingPlanPurchaseAuth.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import {
  beginCodingPlanUpgradeLogin,
  resolvePendingCodingPlanUpgradeAfterLogin,
  type CodingPlanUpgradeDialogTarget,
} from "@/settings/codingPlanUpgradeLoginRecovery.js";
import { CodingPlanEmbeddedWebviewDialog } from "@/settings/CodingPlanEmbeddedWebviewDialog.js";
import { logger } from "@/logger.js";

export { isCodingPlanPurchaseAuthPending } from "@/settings/model-provider-section/codingPlanPurchaseAuth.js";
export {
  beginCodingPlanUpgradeLogin,
  resolvePendingCodingPlanUpgradeAfterLogin,
} from "@/settings/codingPlanUpgradeLoginRecovery.js";
export type { CodingPlanUpgradeDialogTarget } from "@/settings/codingPlanUpgradeLoginRecovery.js";

interface CodingPlanUpgradeDialogProps {
  target?: CodingPlanUpgradeDialogTarget;
  onClose: () => void;
  onOpenResult?: (opened: boolean) => void;
  // Compatible with existing contracts of CodingPlanUpgradeDialogProvider.
  // Reason for transformation: After the purchase/login process is moved to the official website webview, the App no longer needs to "close the pop-up window to log in → reopen after success"
  // The recovery link; this prop is currently not used, and the signature is retained to avoid changing the Provider.
  onReopen?: (target: CodingPlanUpgradeDialogTarget) => void;
}

// Complete refresh: The official web page returns the call after successful purchase through window.zcodeBridge.notifyPurchaseComplete.
async function refreshCodingPlanUpgradeCompletion(params: {
  productsProviderId: CodingPlanProviderId | null;
  providerId: CodingPlanProviderId | null;
  refreshCodingPlanEntitlements: () => Promise<unknown> | unknown;
  refreshProviderState: () => Promise<unknown> | unknown;
  refreshTeamPlanProducts?: () => Promise<unknown> | unknown;
}) {
  await Promise.all([
    params.refreshProviderState(),
    params.refreshCodingPlanEntitlements(),
    // The Team Plan connection item relies on the authenticated pricing/customer project snapshot.
    // You must also refresh the global purchase pop-up window before closing it to avoid not being able to see the new team item after Done.
    params.refreshTeamPlanProducts?.(),
  ]);
}

async function closeAndRefreshCodingPlanUpgradeFromWebview(params: {
  onClose: () => void;
  refresh: () => Promise<unknown> | unknown;
  onRefreshError?: (error: unknown) => void;
}) {
  // The completion signal semantics sent back by the official website webview is "close the upgrade pop-up window and refresh the provider".
  // Closing must occur first to prevent the user from being blocked on the webview by provider/rights refresh under a weak network after successful payment.
  params.onClose();
  try {
    await params.refresh();
  } catch (error) {
    params.onRefreshError?.(error);
  }
}

export function CodingPlanUpgradeDialog({
  target,
  onClose,
  onOpenResult,
}: CodingPlanUpgradeDialogProps) {
  const { providerSettingsService, credentialService, codingPlanSubscriptionService } =
    useServices();
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const { refresh: refreshCodingPlanEntitlements } = useCodingPlanEntitlements({
    providerSettingsView,
  });

  const providerId = normalizeCodingPlanProviderId(target?.providerId);
  const productsProviderId = providerId
    ? resolveCodingPlanUpgradeProductsProviderId(providerId)
    : null;
  const teamPlanFamily = productsProviderId
    ? resolveModelProviderFamilyIdByProviderId(productsProviderId)
    : null;
  const refreshProviderState = useCallback(
    () => providerSettingsService.refresh("coding-plan-purchase-complete"),
    [providerSettingsService],
  );
  // Official website purchase completion postback: webview tells the App to close the upgrade pop-up window and refresh the current provider in the background.
  const handlePurchaseComplete = useCallback(async () => {
    await closeAndRefreshCodingPlanUpgradeFromWebview({
      onClose,
      refresh: () =>
        refreshCodingPlanUpgradeCompletion({
          productsProviderId,
          providerId,
          refreshCodingPlanEntitlements,
          refreshProviderState,
          refreshTeamPlanProducts:
            teamPlanFamily !== null
              ? () =>
                  // After the purchase is completed, the webview pop-up window will be closed first, and the hook in the pop-up window will be uninstalled.
                  // Here, directly use service to pull the team project of the current family to avoid the refresh request being swallowed up by the uninstallation sequence.
                  codingPlanSubscriptionService.getEnterprisePricing({
                    authenticated: true,
                    family: teamPlanFamily,
                  })
              : undefined,
        }),
      onRefreshError: (error) => {
        // Refresh failure does not block the shutdown: the user has paid successfully, and the package will be updated at the next natural refresh.
        logger.warn("[CodingPlanUpgradeDialog] refresh state after purchase completion failed", {
          providerId,
          productsProviderId,
          error,
        });
      },
    });
  }, [
    codingPlanSubscriptionService,
    onClose,
    productsProviderId,
    providerId,
    refreshCodingPlanEntitlements,
    refreshProviderState,
    teamPlanFamily,
  ]);

  if (!target || !providerId || !productsProviderId) {
    return null;
  }

  return (
    <CodingPlanEmbeddedWebviewDialog
      open
      onOpenResult={onOpenResult}
      credentialService={credentialService}
      providerId={providerId}
      funnelContext={target.funnelContext}
      audience={target.initialAudience}
      teamPlanKey={target.initialTeamPlanKey}
      onPurchaseComplete={handlePurchaseComplete}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    />
  );
}
