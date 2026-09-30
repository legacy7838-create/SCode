import type { ApiClient } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";
import { BigModelCodingPlanSubscriptionProvider } from "./bigmodelCodingPlanSubscriptionProvider.js";
import type { ModelSelectionView } from "@zcode/provider";
import { ZaiCodingPlanSubscriptionProvider } from "./zaiCodingPlanSubscriptionProvider.js";

interface CodingPlanSubscriptionServiceDependencies {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
}

/**
 * The original service bound every call directly to a single BigModelCodingPlanSubscriptionProvider;
 * the zai family has no independent Team Plan pricing source (dead code).
 *
 * Full-path symmetry between zai and bigmodel Team Plan:
 * it holds both the bigmodel and zai provider instances at the same time; the enterprise read path
 * (getEnterprisePricing) routes to the matching instance by request.family; when family is omitted it
 * stays on bigmodel, staying backward compatible with existing call sites.
 *
 * The remaining methods (purchase/staticConfigs/preview, etc.) are family-agnostic in meaning or are
 * already routed dynamically inside the provider by request.providerId, so they can be uniformly
 * delegated to the bigmodel provider:
 *   - The enterprise purchase loop (balance/order/pending/cancel/continue/status) still runs only against the bigmodel domain, per product decision.
 *   - staticConfigs is the platform-level client/configs, unrelated to family.
 *   - Purchase-related methods (Stripe/PayPal/preview/createSign, etc.) are already routed inside the provider via request.providerId.
 */
export function createCodingPlanSubscriptionService(
  dependencies: CodingPlanSubscriptionServiceDependencies,
): ICodingPlanSubscriptionService {
  const bigmodelProvider = new BigModelCodingPlanSubscriptionProvider(dependencies);
  const zaiProvider = new ZaiCodingPlanSubscriptionProvider(dependencies);

  // Select the enterprise read path provider by family; by default (including historical calls without specified family), bigmodel is used.
  const resolveEnterprisePricingProvider = (
    family?: "bigmodel" | "zai",
  ): BigModelCodingPlanSubscriptionProvider => (family === "zai" ? zaiProvider : bigmodelProvider);

  return {
    batchPreview: (request) => bigmodelProvider.batchPreview(request),
    getStaticProducts: () => bigmodelProvider.getStaticProducts(),
    getStaticTeamProducts: () => bigmodelProvider.getStaticTeamProducts(),
    getStartPlanPreview: () => bigmodelProvider.getStartPlanPreview(),
    getOffPeakClientConfig: (options) => bigmodelProvider.getOffPeakClientConfig(options),
    // Dynamic workflow grayscale: same origin as client/configs,
    // Therefore, like other platform-level configurations, the bigmodel provider is fixed and has nothing to do with family.
    getDynamicWorkflowClientConfig: (options) =>
      bigmodelProvider.getDynamicWorkflowClientConfig(options),
    getModelContextBudgetStrategy: () => bigmodelProvider.getModelContextBudgetStrategy(),
    getForceUpdateConfig: () => bigmodelProvider.getForceUpdateConfig(),
    productInfo: (request) => bigmodelProvider.productInfo(request),
    preview: (request) => bigmodelProvider.preview(request),
    createSign: (request) => bigmodelProvider.createSign(request),
    updateSign: (request) => bigmodelProvider.updateSign(request),
    checkPayment: (request) => bigmodelProvider.checkPayment(request),
    checkPendingOrders: (request) => bigmodelProvider.checkPendingOrders(request),
    queryStripeCards: (request) => bigmodelProvider.queryStripeCards(request),
    bindStripeCard: (request) => bigmodelProvider.bindStripeCard(request),
    unbindStripeCard: (request) => bigmodelProvider.unbindStripeCard(request),
    payStripe: (request) => bigmodelProvider.payStripe(request),
    checkPaypalSupport: (request) => bigmodelProvider.checkPaypalSupport(request),
    createPaypalSetupToken: (request) => bigmodelProvider.createPaypalSetupToken(request),
    subscribePaypal: (request) => bigmodelProvider.subscribePaypal(request),
    getEnterprisePricing: (request) =>
      resolveEnterprisePricingProvider(request?.family).getEnterprisePricing(request),
    getEnterpriseBalance: () => bigmodelProvider.getEnterpriseBalance(),
    calculateEnterpriseOrder: (request) => bigmodelProvider.calculateEnterpriseOrder(request),
    createEnterpriseOrder: (request) => bigmodelProvider.createEnterpriseOrder(request),
    getEnterprisePendingOrders: () => bigmodelProvider.getEnterprisePendingOrders(),
    cancelEnterpriseOrder: (request) => bigmodelProvider.cancelEnterpriseOrder(request),
    continueEnterpriseOrderPayment: (request) =>
      bigmodelProvider.continueEnterpriseOrderPayment(request),
    checkEnterpriseOrderStatus: (request) => bigmodelProvider.checkEnterpriseOrderStatus(request),
  };
}
