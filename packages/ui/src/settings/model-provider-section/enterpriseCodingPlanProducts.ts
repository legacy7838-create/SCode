/* eslint-disable max-lines -- The enterprise plan display model centrally carries the static
 * catalog, the live pricing, and the payment parameter conversions; splitting it would blur the
 * merge boundary.
 */
import type {
  CodingPlanStaticTeamProduct,
  EnterpriseCodingPlanPricingProduct,
  EnterpriseCodingPlanSubscribePeriod,
  ProviderFamilyDomain,
} from "@zcode/shared";
import {
  normalizeCodingPlanCardCopyItems,
  type CodingPlanPriceUnit,
  type CodingPlanProductDisplay,
} from "@/settings/model-provider-section/codingPlanProductPresentation.js";

export type EnterpriseCodingPlanProductDisplay = CodingPlanProductDisplay & {
  enterpriseProduct: EnterpriseCodingPlanPricingProduct;
  tier: EnterpriseCodingPlanPricingProduct["tier"];
  subscribeMode: EnterpriseCodingPlanPricingProduct["subscribeMode"];
  subscribePeriod: EnterpriseCodingPlanPricingProduct["subscribePeriod"];
  purchaseMethodName: string;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  teamProjects?: EnterpriseCodingPlanPricingProduct["teamProjects"];
  apiKeyStatus?: EnterpriseCodingPlanPricingProduct["apiKeyStatus"];
  apiKeyUnavailableReason?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableReason"];
  apiKeyUnavailableMessage?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableMessage"];
  subscribed?: boolean | null;
  dynamicPricingAvailable?: boolean;
  staticCatalogAvailable?: boolean;
  /**
   * The family this enterprise plan belongs to (zai / bigmodel). The original UI layer hardcoded
   * team plan items as derived from bigmodelCodingPlan, so a zai-family plan could not be rendered
   * even when a subscription existed. With the family marker added, the downstream visibility
   * function can find the codingPlanItem and the team key prefix of the matching family via
   * product.family. Defaulting to bigmodel keeps backward compatibility.
   */
  family?: ProviderFamilyDomain;
};

/**
 * When an older product has no family, it is interpreted as BigModel only at this normalization
 * boundary.
 */
export function resolveEnterpriseCodingPlanProductFamily(
  product: Pick<EnterpriseCodingPlanProductDisplay, "family">,
): ProviderFamilyDomain {
  return product.family ?? "bigmodel";
}

function buildEnterpriseCodingPlanProductList(
  products: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product): EnterpriseCodingPlanProductDisplay => {
    const purchaseMethodName = product.purchaseMethodName?.trim() ?? "";
    return {
      productId: product.productId,
      productName: formatEnterpriseCodingPlanTier(product.tier),
      productBigTitle: formatEnterpriseCodingPlanTier(product.tier),
      originalAmount: product.originalAmount,
      payAmount: resolveEnterpriseCodingPlanDisplayPayAmount(product),
      renewAmount: product.renewAmount,
      canRepurchase: product.canRepurchase,
      inCurrentPeriod: product.subscribed === true,
      campaignDiscountDetails: product.campaignDiscountDetails,
      priceUnit: mapEnterpriseCodingPlanPriceUnit(product.subscribePeriod),
      priceCurrency: "CNY",
      productEquityList: [],
      hasPreview: true,
      enterpriseProduct: product,
      tier: product.tier,
      subscribeMode: product.subscribeMode,
      subscribePeriod: product.subscribePeriod,
      purchaseMethodName,
      organizationId: product.organizationId,
      organizationName: product.organizationName,
      projectId: product.projectId,
      projectName: product.projectName,
      teamProjects: product.teamProjects,
      apiKeyStatus: product.apiKeyStatus,
      apiKeyUnavailableReason: product.apiKeyUnavailableReason,
      apiKeyUnavailableMessage: product.apiKeyUnavailableMessage,
      subscribed: product.subscribed,
      dynamicPricingAvailable: true,
    };
  });
}

function mergeEnterpriseCodingPlanProductList(
  staticProducts: CodingPlanStaticTeamProduct[],
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  const pricingByProductId = new Map(
    pricingProducts.map((product) => [product.productId, product]),
  );
  const staticProductIds = new Set(staticProducts.map((product) => product.productId));
  const mergedStaticProducts = staticProducts.map((staticProduct) => {
    const pricingProduct = pricingByProductId.get(staticProduct.productId);
    const enterpriseProduct: EnterpriseCodingPlanPricingProduct = pricingProduct ?? {
      productId: staticProduct.productId,
      tier: staticProduct.tier,
      subscribeMode: staticProduct.subscribeMode,
      subscribePeriod: staticProduct.subscribePeriod,
      purchaseMethodName: staticProduct.purchaseMethodName,
      originalAmount: staticProduct.originalAmount,
      discountAmount: staticProduct.discountAmount,
      payAmount: staticProduct.payAmount,
      renewAmount: staticProduct.renewAmount,
      canRepurchase: false,
    };
    const display = buildEnterpriseCodingPlanProductList([enterpriseProduct])[0]!;
    return {
      ...display,
      productName: staticProduct.productName,
      productBigTitle: staticProduct.productName,
      originalAmount: pricingProduct?.originalAmount ?? staticProduct.originalAmount,
      payAmount: pricingProduct
        ? display.payAmount
        : (staticProduct.payAmount ?? staticProduct.renewAmount),
      renewAmount: pricingProduct?.renewAmount ?? staticProduct.renewAmount,
      priceCurrency: staticProduct.priceCurrency,
      equity: normalizeCodingPlanCardCopyItems(staticProduct.equity ?? []),
      descriptionItems: normalizeCodingPlanCardCopyItems(staticProduct.description ?? []),
      dynamicPricingAvailable: pricingProduct !== undefined,
      staticCatalogAvailable: true,
    };
  });
  const purchasedPricingProducts = pricingProducts
    .filter((product) => product.subscribed === true && !staticProductIds.has(product.productId))
    .map((product) => ({
      ...buildEnterpriseCodingPlanProductList([product])[0]!,
      // The team static directory of client/configs is only responsible for the display of purchasable SKUs;
      // The identity of the purchased Team Plan comes from pricing/customerInfo and cannot be due to the static catalog grayscale being empty or missing products.
      // Just hide the real team connection method and usage statistics entrance.
      staticCatalogAvailable: false,
    }));
  return [...mergedStaticProducts, ...purchasedPricingProducts];
}

export function resolveEnterpriseCodingPlanProductList(
  staticProducts: CodingPlanStaticTeamProduct[] | undefined,
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  // When the static directory is missing or fails to be read, pricing remains the authoritative source of team subscription identity and project context;
  // Only when an explicit empty array is successfully read, all team SKUs are hidden according to configuration semantics.
  return !Array.isArray(staticProducts)
    ? buildEnterpriseCodingPlanProductList(pricingProducts)
    : mergeEnterpriseCodingPlanProductList(staticProducts, pricingProducts);
}

function resolveEnterpriseCodingPlanDisplayPayAmount(
  product: EnterpriseCodingPlanPricingProduct,
): number | undefined {
  const candidateAmounts = [product.payAmount, product.renewAmount].filter(hasPositiveOrZeroAmount);
  if (candidateAmounts.length > 0) {
    // For real enterprise pricing, annual payment products will be issued with payAmount=originalAmount and renewAmount=discounted price.
    // The card must display "discounted price + original price crossed out" consistent with the personal package, so the displayed price should be the lowest value among the available payment amounts.
    return Math.min(...candidateAmounts);
  }
  if (
    hasPositiveOrZeroAmount(product.originalAmount) &&
    hasPositiveAmount(product.discountAmount)
  ) {
    // The personal package card shows the discounted price + the original price crossed out; the discountAmount of the enterprise pricing is the discount amount.
    // It cannot be directly passed to a general card as the price, but for annual payment products, only originalAmount + discountAmount may be issued.
    return roundCurrencyAmount(Math.max(0, product.originalAmount - product.discountAmount));
  }
  return undefined;
}

function hasPositiveAmount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasPositiveOrZeroAmount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function roundCurrencyAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatEnterpriseCodingPlanTier(tier: EnterpriseCodingPlanPricingProduct["tier"]): string {
  const normalized = tier.trim();
  if (!normalized) {
    return tier;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function mapEnterpriseCodingPlanPriceUnit(
  period: EnterpriseCodingPlanSubscribePeriod,
): CodingPlanPriceUnit {
  return period === "YEARLY" ? "year" : period === "QUARTERLY" ? "quarter" : "month";
}
