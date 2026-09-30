/* eslint-disable max-lines -- The Coding Plan provider needs to centrally maintain the BigModel Alipay and Z.ai Stripe/PayPal interface mappings; splitting them would make the shared auth and response unpacking harder to trace. */
import type {
  ApiClient,
  ApiRequestInit,
  ForceUpdateConfig,
  CodingPlanAgreementResponse,
  CodingPlanBatchPreviewRequest,
  CodingPlanBatchPreviewResponse,
  CodingPlanCreateSignRequest,
  CodingPlanPaymentCheckRequest,
  CodingPlanPaymentCheckResponse,
  CodingPlanPendingOrderCheckResponse,
  CodingPlanPaypalSetupTokenRequest,
  CodingPlanPaypalSetupTokenResponse,
  CodingPlanPaypalSubscribeRequest,
  CodingPlanPaypalSubscribeResponse,
  CodingPlanPaypalSupportRequest,
  CodingPlanPaypalSupportResponse,
  CodingPlanProductInfo,
  CodingPlanProductInfoRequest,
  CodingPlanStaticTeamProduct,
  CodingPlanStaticProductsConfig,
  CodingPlanStaticTeamProductsConfig,
  CodingPlanSubscriptionProviderId,
  CodingPlanPreviewRequest,
  CodingPlanPreviewResponse,
  CodingPlanStripeBindRequest,
  CodingPlanStripeBindResponse,
  CodingPlanStripeCard,
  CodingPlanStripePayRequest,
  CodingPlanStripePayResponse,
  CodingPlanStripeUnbindRequest,
  CodingPlanUpdateSignRequest,
  EnterpriseCodingPlanCancelOrderRequest,
  EnterpriseCodingPlanCancelOrderResponse,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanBalanceResponse,
  EnterpriseCodingPlanContinuePayRequest,
  EnterpriseCodingPlanOrderCalculateRequest,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanOrderStatusRequest,
  EnterpriseCodingPlanOrderStatusResponse,
  EnterpriseCodingPlanPricingRequest,
  EnterpriseCodingPlanPricingResponse,
  EnterpriseCodingPlanPricingProduct,
  EnterpriseCodingPlanProjectApiKeyUnavailableReason,
  EnterpriseCodingPlanProjectContext,
  StartPlanPreviewConfig,
  ZCodeModelContextBudgetStrategy,
  DynamicWorkflowClientConfig,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import type { OffPeakClientConfig } from "./codingPlanSubscription.js";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  CODING_PLAN_SYSTEM_BUSY,
  buildRuntimeZCodeApiUrl,
  isZaiCodingPlanProviderId,
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  ZAI_PROVIDER_ID,
  ZCODE_VERSION,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  createDynamicWorkflowClientConfig,
  normalizeDynamicWorkflowMode,
  resolveDynamicWorkflowClientConfig,
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { readApiJson } from "../providers/api/apiJson.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  ensureBigModelTeamPlanProjectApiKeyWithStatus,
  type BigModelTeamPlanApiKeyEnsureResult,
  type BigModelTeamPlanBizContext,
} from "#src/bigmodel/teamPlanApiKey.js";

const BIGMODEL_CODING_PLAN_API_PREFIX = "/api/biz";
const ZAI_CODING_PLAN_PAY_API_PREFIX = "/api/pay";
const ZCODE_CLIENT_CONFIG_API_PREFIX = "/api/v1/client/configs";
const REQUEST_TIMEOUT_MS = 15_000;
const CLIENT_CONFIG_CACHE_TTL_MS = 60 * 60 * 1000;
const CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED = "coding_plan_zai_overseas_payment_required";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const log = createServiceLogger("codingPlanSubscription");

interface RemoteEnvelope<T> {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: T | null;
}

interface ZCodeClientConfigEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: {
    configs?: {
      forceUpdate?: ForceUpdateConfig | null;
      codingPlanStaticProducts?: CodingPlanStaticProductsConfig;
      codingPlanStaticTeamProducts?: CodingPlanStaticTeamProductsConfig;
      startPlanPreview?: StartPlanPreviewConfig | null;
      // Idle time task grayscale (server side): The inner field server side is snake_case, mixed with the outer camelCase.
      offPeak?: {
        enable_offpeak_task?: boolean;
      } | null;
      modelContextBudget?: {
        strategy?: unknown;
      } | null;
      // Dynamic workflow grayscale: The value range of mode is
      // The normalizeDynamicWorkflowMode decision of shared is kept unknown here, and the server is not assumed to be legal at the type level.
      dynamicWorkflow?: {
        mode?: unknown;
      } | null;
    } | null;
  } | null;
}

interface BigModelCodingPlanSubscriptionProviderOptions {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
}

interface TeamPlanProjectApiKeyPrewarmStatus {
  status: "available" | "unavailable";
  reason?: EnterpriseCodingPlanProjectApiKeyUnavailableReason;
  message?: string | null;
}

interface CodingPlanEndpointConfig {
  providerId: CodingPlanSubscriptionProviderId;
  host: string;
  headers: Record<string, string>;
}

interface BigModelCustomerInfoResponse {
  organizations?: Array<{
    organizationId?: string | null;
    organizationName?: string | null;
    projects?: Array<{
      projectId?: string | null;
      projectName?: string | null;
      projectType?: number | string | null;
    }> | null;
  }> | null;
}

export class BigModelCodingPlanSubscriptionProvider {
  protected readonly apiClient: ApiClient;
  protected readonly credentialService: Pick<ICredentialService, "load">;
  private readonly resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
  private clientConfigSnapshot: ZCodeClientConfigEnvelope | null = null;
  private clientConfigSnapshotExpiresAt = 0;
  private clientConfigRequest: Promise<ZCodeClientConfigEnvelope> | null = null;

  constructor(options: BigModelCodingPlanSubscriptionProviderOptions) {
    this.apiClient = options.apiClient;
    this.credentialService = options.credentialService;
    this.resolveOffPeakModelSelectionView = options.resolveOffPeakModelSelectionView;
  }

  // ─────────── family dimension abstraction (overridden by ZaiCodingPlanSubscriptionProvider)───────────
  // Original enterprise reading method (getEnterprisePricing / enrichEnterprisePricingTeamProjects, etc.)
  // Hardcode family into bigmodel: providerId=bigmodelCodingPlan, host=resolveBigModelApiOrigin,
  // token=loadBigModelAccessToken. The zai family cannot be reused during symmetry.
  // Here, the family dimension is extracted into a protected virtual method. The default implementation of bigmodel maintains the original behavior and can be overridden by zai subclasses.

  /** Coding Plan providerId of the current family (bigmodelCodingPlan / zaiCodingPlan). */
  protected codingPlanProviderId(): CodingPlanSubscriptionProviderId {
    return BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
  }

  /** Business domain of the current family (bigmodel domain / zai domain). */
  protected resolveFamilyEnterpriseHost(): string {
    return resolveBigModelApiOrigin(process.env);
  }

  /** Business OAuth token of the current family. */
  protected async loadFamilyEnterpriseToken(): Promise<string> {
    return this.loadBigModelAccessToken();
  }

  /** Business auth headers of the current family. */
  protected createFamilyEnterpriseAuthHeaders(token: string): Record<string, string> {
    return createBigModelLoginAuthHeaders(token);
  }

  async batchPreview(
    request: CodingPlanBatchPreviewRequest = {},
  ): Promise<CodingPlanBatchPreviewResponse> {
    return this.post<CodingPlanBatchPreviewResponse>(request.providerId, "/pay/batch-preview", {
      invitationCode: request.invitationCode,
    });
  }

  async getStaticProducts(): Promise<CodingPlanStaticProductsConfig> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigProducts(payload);
  }

  async getStaticTeamProducts(): Promise<CodingPlanStaticTeamProductsConfig> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigTeamProducts(payload);
  }

  async getStartPlanPreview(): Promise<StartPlanPreviewConfig | null> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigStartPlanPreview(payload);
  }

  /**
   * Off-peak task rollout config: reuses the client/configs channel with zero extra requests.
   * forceRefresh backs "open the Automations entry point to backfill" (otherwise a rollout flip can stay invisible for up to 1h behind the 1h snapshot).
   */
  async getOffPeakClientConfig(options?: { forceRefresh?: boolean }): Promise<OffPeakClientConfig> {
    if (process.env["ZCODE_OFFPEAK_MOCK"] === "1") {
      // Mock has clearly replaced the remote exposure configuration and cannot wait for /client/configs first:
      // Offline Desktop E2E will always stop at Loading and cannot enter the idle execution chain at all.
      const modelSelectionView = await this.resolveOffPeakModelSelectionView?.();
      return resolveOffPeakClientConfig({}, process.env, modelSelectionView);
    }
    if (options?.forceRefresh) {
      this.clientConfigSnapshot = null;
      this.clientConfigSnapshotExpiresAt = 0;
    }
    const payload = await this.getClientConfigs();
    const modelSelectionView = await this.resolveOffPeakModelSelectionView?.();
    return resolveOffPeakClientConfig(payload, process.env, modelSelectionView);
  }

  /**
   * Dynamic workflow rollout snapshot: shares the client/configs channel with off-peak
   * tasks, zero extra requests. Three boundaries:
   *   1. The local override (ZCODE_DYNAMIC_WORKFLOW_MODE) is decided before any network action and returns on a hit —
   *      so preview builds and manual developer testing are unaffected by the 1h snapshot and the first Host race;
   *   2. forceRefresh is synonymous with Off-Peak: drop the snapshot and refetch (a rollout flip can stay invisible for up to 1h);
   *   3. A failed request fails closed: return default (disabled) and warn, never throw at the caller —
   *      the caller sits on the session create/client readiness path, so a failed rollout read must not block ordinary chat.
   */
  async getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig> {
    // Legal overwriting is a short-circuit: both the criterion (normalize) and the snapshot construction (resolve) remain in shared, and the value range will not be repeated here.
    if (normalizeDynamicWorkflowMode(process.env[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV])) {
      return resolveDynamicWorkflowClientConfig({ remote: undefined, env: process.env });
    }
    if (options?.forceRefresh) {
      this.clientConfigSnapshot = null;
      this.clientConfigSnapshotExpiresAt = 0;
    }
    try {
      const payload = await this.getClientConfigs();
      return resolveDynamicWorkflowClientConfig({
        remote: payload.data?.configs?.dynamicWorkflow,
        env: process.env,
      });
    } catch (error) {
      log.warn(undefined, "failed to read dynamic workflow rollout config, treating it as off", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
    }
  }

  async getModelContextBudgetStrategy(): Promise<ZCodeModelContextBudgetStrategy> {
    // 3.12.2: The budget is unified to preflight-v1; the compatibility method is retained, but you can no longer wait for remote configuration for each session establishment.
    return DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
  }

  async getForceUpdateConfig(): Promise<ForceUpdateConfig | null> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigForceUpdate(payload);
  }

  async preview(request: CodingPlanPreviewRequest): Promise<CodingPlanPreviewResponse> {
    return this.post<CodingPlanPreviewResponse>(
      request.providerId,
      resolvePreviewPath(request.providerId),
      {
        productId: request.productId,
        invitationCode: request.invitationCode,
        imRef: request.imRef ?? null,
        ticket: request.ticket ?? null,
        randstr: request.randstr ?? null,
        // The Coding Plan trial calculation interface is processed by the Maas channel by default. If not explicitly marked, the zcode source attribution will be lost.
        salesChannel: request.salesChannel ?? "zcode",
      },
    );
  }

  async productInfo(request: CodingPlanProductInfoRequest): Promise<CodingPlanProductInfo> {
    const url = new URL(
      `${resolveCodingPlanHost(request.providerId)}${BIGMODEL_CODING_PLAN_API_PREFIX}/product/info`,
    );
    url.searchParams.set("productId", request.productId);
    return this.get<CodingPlanProductInfo>(request.providerId, url);
  }

  async createSign(request: CodingPlanCreateSignRequest): Promise<CodingPlanAgreementResponse> {
    if (request.providerId && isZaiCodingPlanProviderId(request.providerId)) {
      throw new Error(CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED);
    }

    return this.post<CodingPlanAgreementResponse>(request.providerId, "/pay/create-sign", {
      bizId: request.bizId,
      payType: request.payType ?? "ALI",
      invitationCode: request.invitationCode,
      renew: request.renew ?? null,
      isDelay: request.isDelay ?? 0,
      effectiveTime: request.effectiveTime ?? null,
    });
  }

  async updateSign(request: CodingPlanUpdateSignRequest): Promise<CodingPlanAgreementResponse> {
    if (request.providerId && isZaiCodingPlanProviderId(request.providerId)) {
      throw new Error(CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED);
    }

    return this.post<CodingPlanAgreementResponse>(request.providerId, "/pay/product/update/sign", {
      bizId: request.bizId,
      payType: request.payType ?? "ALI",
    });
  }

  async checkPayment(
    request: CodingPlanPaymentCheckRequest,
  ): Promise<CodingPlanPaymentCheckResponse> {
    const url = new URL(
      `${resolveCodingPlanHost(request.providerId)}${BIGMODEL_CODING_PLAN_API_PREFIX}/pay/check`,
    );
    url.searchParams.set("bizId", request.bizId);
    const status = await this.get<string>(request.providerId, url);
    return { status };
  }

  async checkPendingOrders(
    request: {
      providerId?: CodingPlanSubscriptionProviderId;
    } = {},
  ): Promise<CodingPlanPendingOrderCheckResponse> {
    return this.get<CodingPlanPendingOrderCheckResponse>(
      request.providerId,
      new URL(
        `${resolveCodingPlanHost(request.providerId)}${BIGMODEL_CODING_PLAN_API_PREFIX}/pay/check-pending-orders`,
      ),
    );
  }

  async queryStripeCards(
    request: {
      providerId?: CodingPlanSubscriptionProviderId;
    } = {},
  ): Promise<CodingPlanStripeCard[]> {
    return this.getZaiPay<CodingPlanStripeCard[]>(request.providerId, "/stripe/query");
  }

  async bindStripeCard(
    request: CodingPlanStripeBindRequest,
  ): Promise<CodingPlanStripeBindResponse> {
    return this.postZaiPay<CodingPlanStripeBindResponse>(request.providerId, "/stripe/bind", {
      paymentMethodId: request.paymentMethodId,
      returnUrl: request.returnUrl,
      trackingContext: request.trackingContext,
    });
  }

  async unbindStripeCard(request: CodingPlanStripeUnbindRequest): Promise<string> {
    return this.postZaiPay<string>(request.providerId, "/stripe/unbind", {
      paymentMethodId: request.paymentMethodId,
    });
  }

  async payStripe(request: CodingPlanStripePayRequest): Promise<CodingPlanStripePayResponse> {
    return this.postZaiPay<CodingPlanStripePayResponse>(request.providerId, "/stripe/pay", {
      productId: request.productId,
      paymentMethodId: request.paymentMethodId,
      isSubscribe: request.isSubscribe ?? true,
      returnUrl: request.returnUrl,
      channelCode: request.channelCode,
      estimatePayAmount: request.estimatePayAmount,
      invitationCode: request.invitationCode,
      bizId: request.bizId,
      renew: request.renew ?? false,
    });
  }

  async checkPaypalSupport(
    request: CodingPlanPaypalSupportRequest = {},
  ): Promise<CodingPlanPaypalSupportResponse> {
    return this.getZaiPay<CodingPlanPaypalSupportResponse>(request.providerId, "/paypal/isSupport");
  }

  async createPaypalSetupToken(
    request: CodingPlanPaypalSetupTokenRequest,
  ): Promise<CodingPlanPaypalSetupTokenResponse> {
    return this.postZaiPay<CodingPlanPaypalSetupTokenResponse>(
      request.providerId,
      "/paypal/setupToken",
      {
        returnUrl: request.returnUrl,
        cancelUrl: request.cancelUrl,
      },
    );
  }

  async subscribePaypal(
    request: CodingPlanPaypalSubscribeRequest,
  ): Promise<CodingPlanPaypalSubscribeResponse> {
    return this.postZaiPay<CodingPlanPaypalSubscribeResponse>(
      request.providerId,
      "/paypal/subscribe",
      {
        productId: request.productId,
        productDesc: request.productDesc,
        setupTokenId: request.setupTokenId,
        amount: request.amount,
        isSubscribe: request.isSubscribe ?? true,
        estimatePayAmount: request.estimatePayAmount,
        invitationCode: request.invitationCode,
        bizId: request.bizId,
        channelCode: request.channelCode,
      },
    );
  }

  async getEnterprisePricing(
    request: EnterpriseCodingPlanPricingRequest = {},
  ): Promise<EnterpriseCodingPlanPricingResponse> {
    const providerId = this.codingPlanProviderId();
    const host = this.resolveFamilyEnterpriseHost();
    if (request.authenticated === false) {
      const payload = await readCodingPlanApiJson<
        RemoteEnvelope<EnterpriseCodingPlanPricingResponse>
      >(
        this.apiClient,
        `${host}${BIGMODEL_CODING_PLAN_API_PREFIX}/campaign/partner/enterprise/pricing`,
        {
          method: "GET",
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
      );
      return unwrapEnvelope(payload, providerId);
    }

    const response = await this.get<EnterpriseCodingPlanPricingResponse>(
      providerId,
      new URL(`${host}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/pricing`),
    );
    return this.enrichEnterprisePricingTeamProjects(response);
  }

  async getEnterpriseBalance(): Promise<EnterpriseCodingPlanBalanceResponse> {
    return this.get<EnterpriseCodingPlanBalanceResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      new URL(
        `${resolveBigModelEnterpriseHost()}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/balance`,
      ),
    );
  }

  async calculateEnterpriseOrder(
    request: EnterpriseCodingPlanOrderCalculateRequest,
  ): Promise<EnterpriseCodingPlanOrderCalculateResponse> {
    return this.post<EnterpriseCodingPlanOrderCalculateResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      "/subscription/enterprise/v2/order/calculate",
      { ...request },
    );
  }

  async createEnterpriseOrder(
    request: EnterpriseCodingPlanCreateOrderRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse> {
    return this.post<EnterpriseCodingPlanCreateOrderResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      "/subscription/enterprise/v2/order",
      { ...request },
    );
  }

  async getEnterprisePendingOrders(): Promise<EnterpriseCodingPlanPendingOrder[]> {
    const url = new URL(
      `${resolveBigModelEnterpriseHost()}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/orders/pending`,
    );
    return this.get<EnterpriseCodingPlanPendingOrder[]>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      url,
    );
  }

  async cancelEnterpriseOrder(
    request: EnterpriseCodingPlanCancelOrderRequest,
  ): Promise<EnterpriseCodingPlanCancelOrderResponse> {
    return this.post<EnterpriseCodingPlanCancelOrderResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      `/subscription/enterprise/v2/order/${encodeURIComponent(request.orderNo)}/cancel`,
      {},
    );
  }

  async continueEnterpriseOrderPayment(
    request: EnterpriseCodingPlanContinuePayRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse> {
    return this.post<EnterpriseCodingPlanCreateOrderResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      `/subscription/enterprise/v2/order/${encodeURIComponent(request.orderNo)}/pay`,
      {},
    );
  }

  async checkEnterpriseOrderStatus(
    request: EnterpriseCodingPlanOrderStatusRequest,
  ): Promise<EnterpriseCodingPlanOrderStatusResponse> {
    const url = new URL(
      `${resolveBigModelEnterpriseHost()}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/order/${encodeURIComponent(request.orderNo)}/status`,
    );
    return this.get<EnterpriseCodingPlanOrderStatusResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      url,
    );
  }

  private async post<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(
      this.apiClient,
      `${endpoint.host}${BIGMODEL_CODING_PLAN_API_PREFIX}${path}`,
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: endpoint.headers,
        body: JSON.stringify(dropUndefined(body)),
      },
    );
    return unwrapEnvelope(payload, endpoint.providerId);
  }

  private async get<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    url: URL,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(this.apiClient, url, {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: endpoint.headers,
    });
    return unwrapEnvelope(payload, endpoint.providerId);
  }

  private async postZaiPay<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    assertZaiPaymentProvider(endpoint.providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(
      this.apiClient,
      `${endpoint.host}${ZAI_CODING_PLAN_PAY_API_PREFIX}${path}`,
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: endpoint.headers,
        body: JSON.stringify(dropUndefined(body)),
      },
    );
    return unwrapEnvelope(payload, endpoint.providerId);
  }

  private async getZaiPay<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    path: string,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    assertZaiPaymentProvider(endpoint.providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(
      this.apiClient,
      `${endpoint.host}${ZAI_CODING_PLAN_PAY_API_PREFIX}${path}`,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: endpoint.headers,
      },
    );
    return unwrapEnvelope(payload, endpoint.providerId);
  }

  private async getClientConfigs(): Promise<ZCodeClientConfigEnvelope> {
    if (this.clientConfigSnapshot && this.clientConfigSnapshotExpiresAt > Date.now()) {
      return this.clientConfigSnapshot;
    }
    if (this.clientConfigRequest) {
      return await this.clientConfigRequest;
    }

    // client/configs and other ZCode platform interfaces must share runtime endpoints;
    // The E2E/test environment will point to the local mock through ZCODE_BASE_URL. Hardcoding the online domain name will make the package status uncontrollable.
    const url = resolveCodingPlanClientConfigUrl(process.env);
    url.searchParams.set("app_version", ZCODE_VERSION);
    url.searchParams.set("platform", resolveClientPlatformKey());
    // Both StartPlanCard and plan list come from the same client/configs.
    // When reading preview/products separately on the same screen, the requests must be merged to avoid repeated remote configuration on the settings page without logging in.
    this.clientConfigRequest = readCodingPlanApiJson<ZCodeClientConfigEnvelope>(
      this.apiClient,
      url,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
    try {
      const payload = await this.clientConfigRequest;
      this.clientConfigSnapshot = payload;
      this.clientConfigSnapshotExpiresAt = Date.now() + CLIENT_CONFIG_CACHE_TTL_MS;
      return payload;
    } finally {
      this.clientConfigRequest = null;
    }
  }

  private async resolveEndpointConfig(
    providerId: CodingPlanSubscriptionProviderId | undefined,
  ): Promise<CodingPlanEndpointConfig> {
    const normalizedProviderId =
      providerId ?? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    if (isZaiCodingPlanProviderId(normalizedProviderId)) {
      const authorization = await this.loadZaiAuthorization();
      return {
        providerId: normalizedProviderId,
        host: resolveZaiCodingPlanHost(),
        headers: createZaiLoginAuthHeaders(authorization),
      };
    }

    const token = await this.loadBigModelAccessToken();
    return {
      providerId: normalizedProviderId,
      host: resolveBigModelApiOrigin(process.env),
      headers: createBigModelLoginAuthHeaders(token),
    };
  }

  private async loadBigModelAccessToken(): Promise<string> {
    const token = (
      await this.credentialService.load(`oauth:${BIGMODEL_PROVIDER_ID}:access_token`)
    )?.trim();
    if (!token) {
      throw new Error("bigmodel_oauth_required");
    }
    const zcodeJwtToken = (await this.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim();
    if (zcodeJwtToken && token === zcodeJwtToken) {
      // The old version of BigModel OAuth callback used to write zcode JWT at the same time
      // oauth:bigmodel:access_token, the paid package preview will use it to call bigmodel.cn and report that the token has expired.
      // Here, old tainted states are intercepted at the service boundary to avoid continuing to send incorrect credentials to the BigModel business interface.
      log.warn(undefined, "BigModel access token is stale zcode JWT; login required");
      throw new Error("bigmodel_oauth_required");
    }
    return token;
  }

  protected async enrichEnterprisePricingTeamProjects(
    response: EnterpriseCodingPlanPricingResponse,
  ): Promise<EnterpriseCodingPlanPricingResponse> {
    if (response.productList.length === 0) {
      return response;
    }
    const hasSubscribedProduct = response.productList.some(
      (product) => product.subscribed === true,
    );
    const hasSubscribedProductMissingProjectContext = response.productList.some(
      (product) =>
        product.subscribed === true &&
        (!product.projectId?.trim() || !product.organizationId?.trim()),
    );
    if (hasSubscribedProduct && !hasSubscribedProductMissingProjectContext) {
      const apiKeyStatuses = await this.ensureSubscribedTeamPlanProjectApiKeys(
        response,
        await this.loadFamilyEnterpriseToken(),
      );
      return applyTeamPlanProjectApiKeyStatuses(response, apiKeyStatuses);
    }

    const token = await this.loadFamilyEnterpriseToken();
    const host = this.resolveFamilyEnterpriseHost();
    const customerInfo = await readCodingPlanApiJson<RemoteEnvelope<BigModelCustomerInfoResponse>>(
      this.apiClient,
      `${host}${BIGMODEL_CODING_PLAN_API_PREFIX}/customer/getCustomerInfo`,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: this.createFamilyEnterpriseAuthHeaders(token),
      },
    );
    const teamProjects = resolveBigModelTeamProjects(customerInfo.data);
    if (teamProjects.length === 0) {
      return response;
    }
    const fallbackSubscribedProductId = hasSubscribedProduct
      ? null
      : (resolveFallbackEnterpriseTeamPlanProduct(response.productList)?.productId ?? null);

    const enrichedResponse = {
      ...response,
      productList: response.productList.map((product) => {
        const shouldEnrichProduct =
          product.subscribed === true ||
          (fallbackSubscribedProductId !== null &&
            product.productId === fallbackSubscribedProductId);
        if (!shouldEnrichProduct) {
          return product;
        }
        const matchedTeamProjects = resolveProductTeamProjects(product, teamProjects);
        if (matchedTeamProjects.length === 0) {
          return product;
        }
        const primaryProject = matchedTeamProjects[0];
        return {
          ...product,
          // For subscribed products of enterprise pricing, only productId/tier is returned, not org/project.
          // Some accounts only return organizationId and not projectId; you must continue to read the customerInfo.organizations array.
          // And match team projects by organization, otherwise multi-organization accounts will miss the real Team Plan connection method.
          // There are also test environment accounts with pricing all returning subscribed=false, but customerInfo already has projectType=2 team projects;
          // At this time, customerInfo is a more reliable purchase credential, and the current team package entry needs to be reversed.
          organizationId: primaryProject?.organizationId ?? product.organizationId,
          organizationName: primaryProject?.organizationName ?? product.organizationName,
          projectId: primaryProject?.projectId ?? product.projectId,
          projectName: primaryProject?.projectName ?? product.projectName,
          teamProjects: matchedTeamProjects,
          subscribed: true,
        };
      }),
    };
    const apiKeyStatuses = await this.ensureSubscribedTeamPlanProjectApiKeys(
      enrichedResponse,
      token,
    );
    return applyTeamPlanProjectApiKeyStatuses(enrichedResponse, apiKeyStatuses);
  }

  protected async ensureSubscribedTeamPlanProjectApiKeys(
    response: EnterpriseCodingPlanPricingResponse,
    token: string,
  ): Promise<Map<string, TeamPlanProjectApiKeyPrewarmStatus>> {
    const teamContexts = collectSubscribedTeamPlanProjectContexts(response.productList);
    const statuses = new Map<string, TeamPlanProjectApiKeyPrewarmStatus>();
    if (teamContexts.length === 0) {
      return statuses;
    }
    const host = this.resolveFamilyEnterpriseHost();
    log.info(undefined, "Team Plan project api key prewarm started", {
      family: this.codingPlanProviderId(),
      teamProjectCount: teamContexts.length,
    });
    for (const teamContext of teamContexts) {
      try {
        const result = await ensureBigModelTeamPlanProjectApiKeyWithStatus({
          apiClient: this.apiClient,
          authorization: token,
          host,
          teamContext,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        log.info(undefined, "Team Plan project api key prewarm result", {
          family: this.codingPlanProviderId(),
          diagnostics: result.diagnostics,
          organizationId: teamContext.organizationId,
          projectId: teamContext.projectId,
          status: result.status,
        });
        statuses.set(
          createTeamPlanProjectStatusKey(teamContext),
          createTeamPlanProjectApiKeyPrewarmStatusFromEnsureResult(result),
        );
      } catch (error) {
        // Each project in the multi-team package requires a separate zcode-team-api-key.
        // Failure to create a single team project cannot prevent pricing from returning, otherwise other team entries will be invisible.
        log.warn(undefined, "Team Plan project api key prewarm failed", {
          family: this.codingPlanProviderId(),
          organizationId: teamContext.organizationId,
          projectId: teamContext.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        statuses.set(createTeamPlanProjectStatusKey(teamContext), {
          status: "unavailable",
          reason: "request_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return statuses;
  }

  protected async loadZaiAuthorization(): Promise<string> {
    const token = (
      await this.credentialService.load(`oauth:${ZAI_PROVIDER_ID}:access_token`)
    )?.trim();
    if (!token) {
      throw new Error("zai_oauth_required");
    }

    return token;
  }
}

function resolveCodingPlanClientConfigUrl(env: NodeJS.ProcessEnv): URL {
  return new URL(buildRuntimeZCodeApiUrl(env, ZCODE_CLIENT_CONFIG_API_PREFIX));
}

function resolveFallbackEnterpriseTeamPlanProduct(
  products: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanPricingProduct | null {
  let selected: EnterpriseCodingPlanPricingProduct | null = null;
  let selectedScore = Number.NEGATIVE_INFINITY;
  for (const product of products) {
    const score = getEnterpriseTeamPlanFallbackProductScore(product);
    if (score > selectedScore) {
      selected = product;
      selectedScore = score;
    }
  }
  return selected;
}

function applyTeamPlanProjectApiKeyStatuses(
  response: EnterpriseCodingPlanPricingResponse,
  statuses: Map<string, TeamPlanProjectApiKeyPrewarmStatus>,
): EnterpriseCodingPlanPricingResponse {
  if (statuses.size === 0) {
    return response;
  }
  return {
    ...response,
    productList: response.productList.map((product) =>
      applyTeamPlanProjectApiKeyStatus(product, statuses),
    ),
  };
}

function applyTeamPlanProjectApiKeyStatus(
  product: EnterpriseCodingPlanPricingProduct,
  statuses: Map<string, TeamPlanProjectApiKeyPrewarmStatus>,
): EnterpriseCodingPlanPricingProduct {
  const teamProjects = product.teamProjects?.map((project) =>
    applyTeamPlanProjectContextApiKeyStatus(project, statuses),
  );
  const productStatus = getTeamPlanProjectApiKeyStatus(
    {
      organizationId: product.organizationId ?? "",
      projectId: product.projectId ?? "",
    },
    statuses,
  );
  return {
    ...product,
    ...(teamProjects ? { teamProjects } : {}),
    ...(productStatus ? createTeamPlanProjectApiKeyStatusFields(productStatus) : {}),
  };
}

function applyTeamPlanProjectContextApiKeyStatus(
  project: EnterpriseCodingPlanProjectContext,
  statuses: Map<string, TeamPlanProjectApiKeyPrewarmStatus>,
): EnterpriseCodingPlanProjectContext {
  const status = getTeamPlanProjectApiKeyStatus(project, statuses);
  if (!status) {
    return project;
  }
  return {
    ...project,
    ...createTeamPlanProjectApiKeyStatusFields(status),
  };
}

function createTeamPlanProjectApiKeyStatusFields(
  status: TeamPlanProjectApiKeyPrewarmStatus,
): Pick<
  EnterpriseCodingPlanProjectContext,
  "apiKeyStatus" | "apiKeyUnavailableReason" | "apiKeyUnavailableMessage"
> {
  return {
    apiKeyStatus: status.status,
    apiKeyUnavailableReason: status.status === "unavailable" ? (status.reason ?? null) : null,
    apiKeyUnavailableMessage: status.status === "unavailable" ? (status.message ?? null) : null,
  };
}

function getTeamPlanProjectApiKeyStatus(
  project: Pick<EnterpriseCodingPlanProjectContext, "organizationId" | "projectId">,
  statuses: Map<string, TeamPlanProjectApiKeyPrewarmStatus>,
): TeamPlanProjectApiKeyPrewarmStatus | null {
  const organizationId = project.organizationId?.trim() ?? "";
  const projectId = project.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return null;
  }
  return statuses.get(createTeamPlanProjectStatusKey({ organizationId, projectId })) ?? null;
}

function createTeamPlanProjectApiKeyPrewarmStatusFromEnsureResult(
  result: BigModelTeamPlanApiKeyEnsureResult,
): TeamPlanProjectApiKeyPrewarmStatus {
  if (result.apiKey) {
    return { status: "available" };
  }
  return {
    status: "unavailable",
    reason: isNoValidTeamPlanAuthorizationMessage(result.diagnostics.create?.msg)
      ? "no_valid_team_plan_authorization"
      : "request_failed",
    message: result.diagnostics.create?.msg ?? result.diagnostics.list.msg ?? null,
  };
}

function createTeamPlanProjectStatusKey(
  project: Pick<EnterpriseCodingPlanProjectContext, "organizationId" | "projectId">,
): string {
  return `${project.organizationId.trim()}:${project.projectId.trim()}`;
}

function isNoValidTeamPlanAuthorizationMessage(message: string | null | undefined): boolean {
  return Boolean(
    message?.includes("There is currently no valid team package authorization record"),
  );
}

function getEnterpriseTeamPlanFallbackProductScore(
  product: EnterpriseCodingPlanPricingProduct,
): number {
  let score = 0;
  if (product.tier === "PRO") {
    score += 100;
  }
  if (product.subscribeMode === "ONE_TIME") {
    score += 20;
  }
  if (product.subscribePeriod === "MONTHLY") {
    score += 10;
  }
  return score;
}

function resolveProductTeamProjects(
  product: EnterpriseCodingPlanPricingProduct,
  teamProjects: EnterpriseCodingPlanProjectContext[],
): EnterpriseCodingPlanProjectContext[] {
  const organizationId = product.organizationId?.trim() ?? "";
  const projectId = product.projectId?.trim() ?? "";
  return teamProjects.filter((project) => {
    if (organizationId && project.organizationId !== organizationId) {
      return false;
    }
    if (projectId && project.projectId !== projectId) {
      return false;
    }
    return true;
  });
}

function collectSubscribedTeamPlanProjectContexts(
  products: readonly EnterpriseCodingPlanPricingProduct[],
): BigModelTeamPlanBizContext[] {
  const result: BigModelTeamPlanBizContext[] = [];
  const seen = new Set<string>();
  for (const product of products) {
    if (product.subscribed !== true) {
      continue;
    }
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? null,
              projectId: product.projectId ?? null,
            },
          ];
    for (const projectContext of projectContexts) {
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectId = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectId) {
        continue;
      }
      const key = `${organizationId}\0${projectId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ organizationId, projectId });
    }
  }
  return result;
}

function resolveBigModelTeamProjects(
  customerInfo: BigModelCustomerInfoResponse | null | undefined,
): EnterpriseCodingPlanProjectContext[] {
  const result: EnterpriseCodingPlanProjectContext[] = [];
  for (const organization of customerInfo?.organizations ?? []) {
    const organizationId = organization.organizationId?.trim() ?? "";
    if (!organizationId) {
      continue;
    }
    for (const project of organization.projects ?? []) {
      const projectId = project.projectId?.trim() ?? "";
      if (!projectId || !isBigModelTeamCodingPlanProject(project)) {
        continue;
      }
      result.push({
        organizationId,
        organizationName: organization.organizationName ?? null,
        projectId,
        projectName: project.projectName ?? null,
      });
    }
  }
  return result;
}

function isBigModelTeamCodingPlanProject(
  project: NonNullable<
    NonNullable<BigModelCustomerInfoResponse["organizations"]>[number]["projects"]
  >[number],
): boolean {
  // Team plan project types are identified by customerInfo.projectType.
  // The project name cannot be hard-coded, otherwise the team project will be missed after the name is changed or the international name is changed.
  return String(project.projectType ?? "").trim() === "2";
}

export function createBigModelLoginAuthHeaders(token: string): Record<string, string> {
  return {
    // The BigModel login state business interface requires Authorization to pass accessToken directly.
    // Bearer cannot be used here; Bearer is only applicable to model/API Key class interfaces.
    Authorization: token,
    "Content-Type": "application/json",
  };
}

export function createZaiLoginAuthHeaders(token: string): Record<string, string> {
  return {
    // Z.ai provider connection has persisted access_token as business JWT.
    // The model API key cannot be used here, nor can the Bearer prefix be added to the business JWT.
    Authorization: token,
    "Content-Type": "application/json",
  };
}

function resolveCodingPlanHost(providerId: CodingPlanSubscriptionProviderId | undefined): string {
  return providerId && isZaiCodingPlanProviderId(providerId)
    ? resolveZaiCodingPlanHost()
    : resolveBigModelApiOrigin(process.env);
}

function resolveZaiCodingPlanHost(): string {
  // The /api/biz and /api/pay business interfaces of Z.ai Coding Plan must follow the product environment.
  // Business tokens must be sent to the ZAI Business origin configured in .env; if not overridden, the default is api.z.ai.
  return resolveZaiBusinessBaseUrl(process.env);
}

function resolveBigModelEnterpriseHost(): string {
  // The enterprise package token must be sent to the BigModel origin configured in .env; if not covered, the default is bigmodel.cn.
  // The server returns an empty response and is normalized as system busy.
  return resolveBigModelApiOrigin(process.env);
}

function resolvePreviewPath(providerId: CodingPlanSubscriptionProviderId | undefined): string {
  return providerId && isZaiCodingPlanProviderId(providerId) ? "/pay/zai-preview" : "/pay/preview";
}

function assertZaiPaymentProvider(providerId: CodingPlanSubscriptionProviderId): void {
  if (!isZaiCodingPlanProviderId(providerId)) {
    throw new Error(CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED);
  }
}

function unwrapEnvelope<T>(
  payload: RemoteEnvelope<T>,
  providerId: CodingPlanSubscriptionProviderId,
): T {
  if (payload.code !== undefined && payload.code !== 200) {
    throw new Error(normalizeRemoteErrorMessage(payload.msg, providerId, payload.code));
  }
  if (payload.success === false) {
    throw new Error(normalizeRemoteErrorMessage(payload.msg, providerId));
  }
  if (payload.data === null || payload.data === undefined) {
    const providerName = resolveCodingPlanProviderName(providerId);
    throw new Error(payload.msg?.trim() || `${providerName} response missing data`);
  }
  return payload.data;
}

/** The legacy server catalog still uses builtin keys; convert only at the config boundary, never let it spread into a runtime identity alias. */
function normalizeStaticProductProviderIds<T>(
  products: Partial<Record<CodingPlanSubscriptionProviderId, T[]>>,
): Partial<Record<CodingPlanSubscriptionProviderId, T[]>> {
  const normalized = { ...products };
  const raw = products as Record<string, T[]>;
  for (const [legacyId, currentId] of [
    ["builtin:bigmodel-coding-plan", BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan],
    ["builtin:zai-coding-plan", BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan],
  ] as const) {
    // An explicit empty array means closing the directory; the new key will be used only if the old key does not exist, and the length cannot be used to judge the fallback.
    if (Object.hasOwn(raw, legacyId)) normalized[currentId] = raw[legacyId];
    delete (normalized as Record<string, T[]>)[legacyId];
  }
  return normalized;
}

function unwrapClientConfigProducts(
  payload: ZCodeClientConfigEnvelope,
): CodingPlanStaticProductsConfig {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
  const products = payload.data?.configs?.codingPlanStaticProducts;
  if (!products || typeof products !== "object") {
    throw new Error("ZCode client config missing Coding Plan products");
  }
  return normalizeStaticProductProviderIds(products);
}

function unwrapClientConfigTeamProducts(
  payload: ZCodeClientConfigEnvelope,
): CodingPlanStaticTeamProductsConfig {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
  const products: unknown = payload.data?.configs?.codingPlanStaticTeamProducts;
  if (!products || typeof products !== "object") {
    throw new Error("ZCode client config missing Coding Plan team products");
  }
  for (const providerProducts of Object.values(products)) {
    if (
      !Array.isArray(providerProducts) ||
      !providerProducts.every(isCodingPlanStaticTeamProduct)
    ) {
      // There is no runtime type guarantee for remote configuration; invalid static directories must be downgraded to read failure as a whole.
      // Let the UI continue to use real-time pricing to restore the team subscription identity and not throw errors during the merge phase.
      throw new Error("ZCode client config has invalid Coding Plan team products");
    }
  }
  return normalizeStaticProductProviderIds(products as CodingPlanStaticTeamProductsConfig);
}

function isCodingPlanStaticTeamProduct(value: unknown): value is CodingPlanStaticTeamProduct {
  if (!value || typeof value !== "object") {
    return false;
  }
  const product = value as Record<string, unknown>;
  return (
    isNonEmptyString(product.productId) &&
    isNonEmptyString(product.productName) &&
    (product.tier === "LITE" || product.tier === "PRO" || product.tier === "MAX") &&
    (product.subscribeMode === "CONTINUOUS" || product.subscribeMode === "ONE_TIME") &&
    (product.subscribePeriod === "MONTHLY" ||
      product.subscribePeriod === "QUARTERLY" ||
      product.subscribePeriod === "YEARLY") &&
    isNonEmptyString(product.purchaseMethodName) &&
    product.priceCurrency === "CNY" &&
    isValidCardCopyConfig(product.equity) &&
    isValidCardCopyConfig(product.description)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidCardCopyConfig(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isValidCardCopyConfigItem));
}

function isValidCardCopyConfigItem(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    isNonEmptyString(item.text) && (item.tooltip === undefined || typeof item.tooltip === "string")
  );
}

function unwrapClientConfigStartPlanPreview(
  payload: ZCodeClientConfigEnvelope,
): StartPlanPreviewConfig | null {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
  const preview = payload.data?.configs?.startPlanPreview;
  if (!preview) {
    return null;
  }
  if (
    typeof preview.planId !== "string" ||
    typeof preview.name !== "string" ||
    !Array.isArray(preview.entitlements)
  ) {
    throw new Error("ZCode client config invalid Start Plan preview");
  }
  return {
    planId: preview.planId,
    name: preview.name,
    entitlements: preview.entitlements.filter(isValidStartPlanPreviewEntitlement),
  };
}

function unwrapClientConfigForceUpdate(
  payload: ZCodeClientConfigEnvelope,
): ForceUpdateConfig | null {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }

  const forceUpdate = payload.data?.configs?.forceUpdate;
  if (!forceUpdate) {
    return null;
  }

  const minimalVersion = forceUpdate.minimalVersion;
  if (typeof minimalVersion !== "string" || minimalVersion.trim() === "") {
    return null;
  }

  return { minimalVersion: minimalVersion.trim() };
}

function isValidStartPlanPreviewEntitlement(
  entitlement: StartPlanPreviewConfig["entitlements"][number],
): boolean {
  return (
    typeof entitlement?.grantUnits === "number" &&
    typeof entitlement.meter === "string" &&
    typeof entitlement.period === "string" &&
    typeof entitlement.showName === "string" &&
    typeof entitlement.unitType === "string"
  );
}

function resolveClientPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function normalizeRemoteErrorMessage(
  msg: string | undefined,
  providerId: CodingPlanSubscriptionProviderId,
  code?: number,
) {
  const message = msg?.trim();
  if (message && isUnrenderableRemoteErrorMessage(message)) {
    return CODING_PLAN_SYSTEM_BUSY;
  }
  const providerName = resolveCodingPlanProviderName(providerId);
  return message || `${providerName} request failed${code ? `: ${code}` : ""}`;
}

async function readCodingPlanApiJson<T>(
  apiClient: ApiClient,
  input: string | URL,
  init?: ApiRequestInit,
): Promise<T> {
  try {
    return await readApiJson<T>(apiClient, input, init);
  } catch (error) {
    const message = readRemoteErrorMessage(error);
    if (isUnrenderableRemoteErrorMessage(message)) {
      // The payment interface occasionally returns WAF/HTML pages or non-JSON responses, and the entire paragraph will be
      // HTML is rendered to the payment confirmation page. The service boundary first converges to a stable error code, and then the UI provides localized prompts.
      throw new Error(CODING_PLAN_SYSTEM_BUSY);
    }
    throw error;
  }
}

function readRemoteErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

function isUnrenderableRemoteErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("<!doctype") ||
    /<\s*(html|head|body|script|style|title|meta)\b/.test(normalized) ||
    normalized.includes("errors.aliyun.com") ||
    normalized.includes("request has been blocked") ||
    normalized.includes("unexpected token '<'") ||
    normalized.includes("unexpected end of json input") ||
    normalized.includes("invalid json response")
  );
}

function resolveCodingPlanProviderName(providerId: CodingPlanSubscriptionProviderId): string {
  return isZaiCodingPlanProviderId(providerId) ? "Z.ai" : "BigModel";
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/**
 * Off-peak task rollout criteria (a pure function for unit tests): the remote side only provides the
 * exposure switch, while model membership and facts come from the ZCode Built-in Provider / Model Config.
 * Mock mode (ZCODE_OFFPEAK_MOCK=1) only replaces product exposure and plan status; model candidates still come from the Registry.
 */
export function resolveOffPeakClientConfig(
  payload: ZCodeClientConfigEnvelope,
  env: NodeJS.ProcessEnv,
  modelSelectionView: ModelSelectionView = EMPTY_OFF_PEAK_MODEL_SELECTION_VIEW,
): OffPeakClientConfig {
  const hasModels = modelSelectionView.providers.some((provider) => provider.models.length > 0);
  if (env["ZCODE_OFFPEAK_MOCK"] === "1") {
    return {
      enabled: hasModels,
      modelSelectionView,
      // ZCODE_OFFPEAK_MOCK_NO_PLAN=1 demonstrates the "non-coding plan locked" state; it is considered subscribed by default.
      codingPlanActive: env["ZCODE_OFFPEAK_MOCK_NO_PLAN"] !== "1",
    };
  }
  const raw = payload.data?.configs?.offPeak;
  return {
    enabled: raw?.enable_offpeak_task === true && hasModels,
    modelSelectionView,
  };
}

const EMPTY_OFF_PEAK_MODEL_SELECTION_VIEW: ModelSelectionView = Object.freeze({
  revision: 0,
  providers: Object.freeze([]),
});
