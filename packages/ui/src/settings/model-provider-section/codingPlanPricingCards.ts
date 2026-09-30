import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

// Dead code cleanup: The native purchasing component CodingPlanPricingCards and its supporting resolver have been shipped with
// CodingPlanPurchasePanel is offline together (the purchase process is switched to the embedded official website webview).
// This file only retains the login parameter types and package product source resolution that are still used by the settings page.

export type CodingPlanLoginOptions = {
  forceOAuth?: boolean;
};

export function resolveCodingPlanUpgradeProductsProviderId(
  providerId: CodingPlanProviderId,
): CodingPlanProviderId {
  // Start Plan is a free entry, and the programming package list should directly display the original Z.AI Coding Plan paid package.
  // Continuing to use the Start Plan providerId will display the free Start SKU repeatedly as a purchasable package.
  if (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
    return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
  }

  // BigModel Start Plan is also a free entrance and must be used when upgrading.
  // BigModel paid Coding Plan product source, you cannot use Start providerId to request free SKU.
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
    ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
    : providerId;
}
