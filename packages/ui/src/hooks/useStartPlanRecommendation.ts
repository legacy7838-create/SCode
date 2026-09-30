import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback } from "react";
import type { ModelSelectionView } from "@zcode/provider";
import {
  TID_START_PLAN_RECOMMENDATION_DIALOG,
  isStartPlanModelProviderId,
  type ModelSelection,
} from "@zcode/shared";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { resolveStartPlanRecommendation } from "@/lib/startPlanRecommendation.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/**
 * The recommendation only edits the choices from this submission; settings and quotas remain owned
 * by the App/Host's original services.
 */
export function useStartPlanRecommendation(
  view: ModelSelectionView | null | undefined,
  surface?: "subagent",
) {
  const services = useOptionalBaseWorkspaceServices();
  const { intl } = useZCodeIntl();
  const requestChoice = useConfirmDialogStore((state) => state.requestChoice);
  // The Registry has already validated login brand, entitlement, and model configuration; do not infer the execution identity from the display name.
  const start = view?.providers.find((provider) => isStartPlanModelProviderId(provider.providerId));
  const settings = useProviderSettingsView();
  const entitlement = useUsageEntitlementWithService(services?.usageStatsService, {
    ...buildStartPlanEntitlementOptions(
      settings.state.status === "ready" ? settings.state.view : null,
      start?.providerId ?? "",
    ),
    refreshOnMount: true,
    mountRefreshReason: "access",
  });
  return useCallback(
    async (selection: ModelSelection): Promise<ModelSelection | null> => {
      // Submission does not wait on the network; an expired quota skips the recommendation, and the access refresh keeps the one-minute throttle and failure backoff.
      void entitlement.refresh({ silent: true, reason: "access" });
      const candidate = entitlement.error
        ? null
        : resolveStartPlanRecommendation(selection, view, entitlement.snapshot);
      if (!candidate || !services) return selection;
      try {
        // Read the same Host's preference each time so it picks up a change made at another entry point or just checked on mobile before this submission.
        if ((await services.settingService.get()).startPlanRecommendationDismissed)
          return selection;
      } catch (error) {
        logger.warn(
          "[StartRecommendation] failed to read the recommendation preference, keeping the current selection",
          { error },
        );
        return selection;
      }
      let dismissed = false;
      const choice = await requestChoice({
        testId: TID_START_PLAN_RECOMMENDATION_DIALOG,
        title: intl.formatMessage({ id: "startPlan.recommendation.title" }),
        description: intl.formatMessage(
          {
            id:
              surface === "subagent"
                ? "startPlan.recommendation.subagentDescription"
                : "startPlan.recommendation.description",
          },
          { model: selection.modelId },
        ),
        confirmLabel: intl.formatMessage({ id: "startPlan.recommendation.switch" }),
        cancelLabel: intl.formatMessage({ id: "startPlan.recommendation.decline" }),
        showCloseButton: true,
        showKeyboardHints: false,
        checkbox: {
          label: intl.formatMessage({ id: "startPlan.recommendation.dismiss" }),
          onCheckedChange: (checked) => {
            dismissed = checked;
          },
        },
      });
      if (choice === "dismiss") return null;
      if (dismissed) {
        try {
          await services.settingService.update({ startPlanRecommendationDismissed: true });
        } catch (error) {
          logger.warn("[StartRecommendation] failed to save the recommendation preference", {
            error,
          });
          toast(intl.formatMessage({ id: "startPlan.recommendation.preferenceSaveFailed" }));
        }
      }
      return choice === "confirm" ? candidate : selection;
    },
    [
      entitlement.error,
      entitlement.snapshot,
      entitlement.refresh,
      intl,
      requestChoice,
      services,
      surface,
      view,
    ],
  );
}
