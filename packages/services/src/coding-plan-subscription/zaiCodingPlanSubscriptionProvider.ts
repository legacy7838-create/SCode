import { BUILTIN_MODEL_PROVIDER_IDS, resolveZaiBusinessBaseUrl } from "@zcode/shared";
import type { CodingPlanSubscriptionProviderId } from "@zcode/shared";
import {
  BigModelCodingPlanSubscriptionProvider,
  createZaiLoginAuthHeaders,
} from "./bigmodelCodingPlanSubscriptionProvider.js";

/**
 * ZaiCodingPlanSubscriptionProvider
 *
 * Historically Team Plan enterprise pricing only landed on the bigmodel family: the service
 * layer sent every enterprise read request straight to BigModelCodingPlanSubscriptionProvider,
 * hardcoding the bigmodel domain + bigmodelCodingPlan providerId + bigmodel OAuth token. Even
 * when the zai family produced a team plan connection key it had no independent pricing data
 * source (dead code).
 *
 * zai and bigmodel Team Plan are made symmetric across the whole chain: this class extends
 * BigModelCodingPlanSubscriptionProvider and overrides only the family dimension of the
 * enterprise read path:
 *   - providerId  → zaiCodingPlan
 *   - business domain → resolveZaiCodingPlanHost() (ZAI Business origin configured for tests / api.z.ai in production)
 *   - OAuth token → loadZaiAuthorization() (oauth:zai:access_token, reusing the parent)
 *   - auth headers → createZaiLoginAuthHeaders()
 *
 * Override scope: only the family dimension behind getEnterprisePricing +
 * enrichEnterprisePricingTeamProjects (through protected virtual methods). The enterprise
 * purchase loop (balance/order/pending/cancel/continue/status) still goes to the bigmodel
 * domain through the parent, matching the zai Team Plan product boundary of "pricing reads +
 * team context only".
 *
 * Every other method (batchPreview/preview/productInfo/checkPayment/checkPendingOrders/
 * Stripe/PayPal/createSign/updateSign/staticConfigs) fully reuses the parent:
 *   - purchase calls are already routed dynamically by request.providerId inside the parent's
 *     resolveEndpointConfig (zai → /api/pay + zai host + zai token, bigmodel → /api/biz + bigmodel host + bigmodel token).
 *   - staticConfigs is platform-level client/configs, unrelated to family.
 */
export class ZaiCodingPlanSubscriptionProvider extends BigModelCodingPlanSubscriptionProvider {
  protected codingPlanProviderId(): CodingPlanSubscriptionProviderId {
    return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
  }

  protected resolveFamilyEnterpriseHost(): string {
    return resolveZaiCodingPlanHost();
  }

  protected async loadFamilyEnterpriseToken(): Promise<string> {
    // Reuse parent class loadZaiAuthorization: credential key = oauth:zai:access_token.
    return this.loadZaiAuthorization();
  }

  protected createFamilyEnterpriseAuthHeaders(token: string): Record<string, string> {
    return createZaiLoginAuthHeaders(token);
  }
}

/**
 * zai business domain (for /api/biz and /api/pay).
 * Equivalent to the file-scoped resolveZaiCodingPlanHost in the parent; it is duplicated here
 * because the parent does not export that function. It must stay identical to the parent
 * implementation: follow the product environment (ZAI Business origin configured for tests /
 * api.z.ai in production).
 */
function resolveZaiCodingPlanHost(): string {
  return resolveZaiBusinessBaseUrl(process.env);
}
