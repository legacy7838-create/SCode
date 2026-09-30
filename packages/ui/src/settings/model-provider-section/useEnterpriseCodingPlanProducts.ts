import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getModelProviderFamilySpec,
  type CodingPlanStaticTeamProduct,
  type EnterpriseCodingPlanPricingResponse,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { logger } from "@/logger.js";
import {
  resolveEnterpriseCodingPlanProductList,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import { normalizeErrorMessage } from "@/settings/model-provider-section/useCodingPlanProducts.js";

interface EnterpriseCodingPlanProductsState {
  snapshot: EnterpriseCodingPlanProductsSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface EnterpriseCodingPlanProductsSnapshot {
  productList: EnterpriseCodingPlanProductDisplay[];
  raw: EnterpriseCodingPlanPricingResponse;
  authenticated: boolean;
  /**
   * The static catalog drives the purchase banner; live pricing must not be used to fabricate
   * products that are missing from the catalog.
   */
  staticProductIds?: string[];
}

function shouldRetainEnterprisePricingSnapshotForRefresh(
  snapshot: EnterpriseCodingPlanProductsSnapshot | null,
  authenticated: boolean,
): boolean {
  return snapshot?.authenticated === authenticated;
}

function resolveEnterprisePricingFailureSnapshot({
  currentSnapshot,
  authenticated,
  staticProducts,
  family = "bigmodel",
}: {
  currentSnapshot: EnterpriseCodingPlanProductsSnapshot | null;
  authenticated: boolean;
  staticProducts: CodingPlanStaticTeamProduct[] | undefined;
  family?: ProviderFamilyDomain;
}): EnterpriseCodingPlanProductsSnapshot | null {
  if (shouldRetainEnterprisePricingSnapshotForRefresh(currentSnapshot, authenticated)) {
    return currentSnapshot;
  }
  if (!Array.isArray(staticProducts)) {
    return null;
  }
  const raw: EnterpriseCodingPlanPricingResponse = { productList: [] };
  return {
    raw,
    productList: tagEnterpriseProductsFamily(
      resolveEnterpriseCodingPlanProductList(staticProducts, raw.productList),
      family,
    ),
    authenticated,
  };
}

/**
 * Tags the enterprise plan display list with a family marker (zai / bigmodel). Downstream
 * visibility helpers (appendSubscribedTeamPlanItems and the like) need to find the matching
 * codingPlanItem and team key prefix by family; the original list has no family field and could
 * only derive bigmodelCodingPlan, which left the zai team plan unrenderable.
 */
function tagEnterpriseProductsFamily(
  products: EnterpriseCodingPlanProductDisplay[],
  family: ProviderFamilyDomain,
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product) => ({ ...product, family }));
}

/**
 * The original hook served only the bigmodel family: getStaticTeamProducts hardcoded reads of the
 * bigmodelCodingPlan bucket, and getEnterprisePricing was called without a family. After the zai
 * family was made symmetric, the hook takes a family parameter:
 * - read the static bucket by family (zaiCodingPlan / bigmodelCodingPlan)
 * - pass the family to service.getEnterprisePricing, which routes to the matching provider on that
 *   basis With no family given it stays on bigmodel, which keeps the existing call sites
 *   compatible.
 */
export function useEnterpriseCodingPlanProducts({
  enabled,
  authenticated,
  family = "bigmodel",
  staticOnly = false,
}: {
  enabled: boolean;
  /**
   * The signed-out purchase banner only reads the public static catalog and does not request live
   * pricing.
   */
  staticOnly?: boolean;
  authenticated: boolean;
  family?: ProviderFamilyDomain;
}) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const codingPlanProviderId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  const [state, setState] = useState<EnterpriseCodingPlanProductsState>({
    snapshot: null,
    loading: enabled,
    error: null,
  });

  const refresh = useCallback(
    async (_options?: { force?: boolean }) => {
      if (!enabled) {
        setState((current) => ({
          snapshot: current.snapshot,
          loading: false,
          error: null,
        }));
        return;
      }
      if (!service) {
        setState({
          snapshot: null,
          loading: false,
          error: "service_unavailable",
        });
        return;
      }

      setState((current) => ({
        // When enterprise/individual switching and login status refresh, the package area should not be replaced with a whole loading block;
        // Keep the last round of enterprise package data, so that the refresh status is only reflected in the refresh button and the partial status of the card.
        // However, the field semantics of public pricing and login pricing are different. Old data must be discarded when switching authentication sources.
        // Otherwise, the upgraded Coding Plan list page will continue to display unauthenticated plan results.
        snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
          ? current.snapshot
          : null,
        loading: true,
        error: null,
      }));

      try {
        // The static catalog is the display configuration, and pricing is the authoritative source of subscription identities and real-time prices.
        // Both must be requested independently to avoid blocking the recovery of the purchased Team Plan when the grayscale environment lacks new configuration fields.
        const [staticResult, pricingResult] = await Promise.allSettled([
          service.getStaticTeamProducts(),
          staticOnly
            ? Promise.resolve<EnterpriseCodingPlanPricingResponse>({ productList: [] })
            : service.getEnterprisePricing({ authenticated, family }),
        ]);
        const staticProducts =
          staticResult.status === "fulfilled"
            ? Object.prototype.hasOwnProperty.call(staticResult.value, codingPlanProviderId)
              ? staticResult.value[codingPlanProviderId]
              : undefined
            : undefined;
        const raw: EnterpriseCodingPlanPricingResponse =
          pricingResult.status === "fulfilled" ? pricingResult.value : { productList: [] };
        const pricingError = pricingResult.status === "rejected" ? pricingResult.reason : null;
        if (pricingError) {
          const message = normalizeErrorMessage(pricingError);
          setState((current) => ({
            // Failure to refresh pricing means that the real-time status is unknown and cannot be overwritten with a static directory or an empty list.
            // The subscription identity and price that were valid in the previous round under the same authentication state; the static disabled card will be displayed only after the first failure.
            snapshot: resolveEnterprisePricingFailureSnapshot({
              currentSnapshot: current.snapshot,
              authenticated,
              staticProducts,
              family,
            }),
            loading: false,
            error: message,
          }));
          if (!isRemoteWorkspaceDisconnectedError(pricingError)) {
            logger.warn("[useEnterpriseCodingPlanProducts] read enterprise live pricing failed", {
              authenticated,
              error: message,
            });
          }
          return;
        }
        setState({
          snapshot: {
            raw,
            staticProductIds: staticProducts?.map((product) => product.productId) ?? [],
            productList: tagEnterpriseProductsFamily(
              resolveEnterpriseCodingPlanProductList(staticProducts, raw.productList),
              family,
            ),
            authenticated,
          },
          loading: false,
          error: pricingError ? normalizeErrorMessage(pricingError) : null,
        });
        if (
          staticResult.status === "rejected" &&
          !isRemoteWorkspaceDisconnectedError(staticResult.reason)
        ) {
          logger.warn(
            "[useEnterpriseCodingPlanProducts] read team static config failed, falling back to live pricing",
            {
              authenticated,
              error: normalizeErrorMessage(staticResult.reason),
            },
          );
        }
      } catch (error) {
        const message = normalizeErrorMessage(error);
        // The remote workspace shell will be rendered briefly before the attachment is bound; at this time, the error reported by the disconnection agent is
        // Expected initialization wait states should not disguise themselves as pricing failures. Real RPC errors remain warned.
        if (!isRemoteWorkspaceDisconnectedError(error)) {
          logger.warn(
            "[useEnterpriseCodingPlanProducts] read enterprise coding plan products failed",
            {
              authenticated,
              error: message,
            },
          );
        }
        setState((current) => ({
          // If the enterprise pricing interface fails, if you clear the snapshot directly,
          // When switching to the team package page, only "No programming packages are available for purchase" will be left. Users cannot tell whether the interface fails or there is indeed no product.
          // Keep the last round of visible packages and explicitly throw errors to the UI to avoid disguising recoverable refresh failures as empty lists.
          snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
            ? current.snapshot
            : null,
          loading: false,
          error: message,
        }));
      }
    },
    [authenticated, codingPlanProviderId, enabled, family, service, staticOnly],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return useMemo(
    () => ({
      ...state,
      refresh,
    }),
    [refresh, state],
  );
}
