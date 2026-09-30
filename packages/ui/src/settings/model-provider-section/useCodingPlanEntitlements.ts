import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ProviderSettingsView } from "@zcode/services";
import {
  getModelProviderFamilySpec,
  type ModelProviderFamilySpec,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  useUsageEntitlement,
  type UsageEntitlementRefreshOptions,
} from "@/hooks/useUsageEntitlement.js";
import type { CodingPlanEntitlementState } from "@/settings/model-provider-section/constants.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";

function resolveCodingPlanProviderFingerprintAutoRefresh({
  loading,
  providerFingerprint,
  skippedProviderFingerprint,
  suppressAutoRefresh,
}: {
  loading: boolean;
  providerFingerprint: string;
  skippedProviderFingerprint: string;
  suppressAutoRefresh: boolean;
}): {
  shouldRefresh: boolean;
  skippedProviderFingerprint: string;
} {
  if (loading || !providerFingerprint) {
    return { shouldRefresh: false, skippedProviderFingerprint };
  }
  if (suppressAutoRefresh) {
    return {
      shouldRefresh: false,
      skippedProviderFingerprint: providerFingerprint,
    };
  }
  if (skippedProviderFingerprint === providerFingerprint) {
    return {
      shouldRefresh: false,
      skippedProviderFingerprint: "",
    };
  }
  return { shouldRefresh: true, skippedProviderFingerprint: "" };
}

function useProviderFamilyEntitlements(params: {
  familySpec: ModelProviderFamilySpec;
  selection: ProviderFamilyConnectionSelection | undefined;
  providerSettingsView: ProviderSettingsView | null;
}) {
  const codingPlanProviderId =
    params.selection?.kind === "team-coding-plan"
      ? params.familySpec.teamCodingPlanProviderId
      : params.familySpec.individualCodingPlanProviderId;
  const startPlanProviderId = params.familySpec.startPlanProviderId;
  const accountAccess = resolveAccountProviderInspectionAccess(
    params.providerSettingsView,
    codingPlanProviderId,
  );
  const startOptions = buildStartPlanEntitlementOptions(
    params.providerSettingsView,
    startPlanProviderId,
  );
  const registryFingerprint = accountAccess
    ? JSON.stringify([params.providerSettingsView?.revision, accountAccess])
    : "";
  const startProviderFingerprint = startOptions.enabled ? (startOptions.cacheKey ?? "") : "";
  const entitlementAccess = resolveEntitlementAccountAccess(
    accountAccess?.access,
    params.selection,
  );
  // The Team query identity also contains product/org/project. Only use Registry static access
  // This will reuse the equity cache of the previous project after switching teams, so the cache identity must contain the execution account context.
  const codingFingerprint = registryFingerprint
    ? JSON.stringify([registryFingerprint, entitlementAccess])
    : "";
  const codingEnabled = Boolean(codingFingerprint);
  const startEnabled = Boolean(startProviderFingerprint);
  const coding = useUsageEntitlement({
    enabled: codingEnabled,
    refreshOnMount: false,
    includeSubscription: true,
    preferredProviderId: codingPlanProviderId,
    accountAccess: entitlementAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: codingPlanProviderId,
      providerFingerprint: codingFingerprint,
    }),
  });
  const start = useUsageEntitlement(startOptions);

  return useMemo(
    () => ({
      coding,
      codingEnabled,
      codingFingerprint,
      codingPlanProviderId,
      start,
      startEnabled,
      startPlanProviderId,
      startProviderFingerprint,
    }),
    // After the Family orchestration is reconstructed, new objects are returned every time it is rendered, resulting in the fact that the upper layer has equal rights and interests.
    // Loss of reference stability and amplification of package status updates into the access refresh cycle of the Provider settings page.
    [
      coding.error,
      coding.loading,
      coding.refresh,
      coding.snapshot,
      codingEnabled,
      codingFingerprint,
      codingPlanProviderId,
      start.error,
      start.loading,
      start.refresh,
      start.snapshot,
      startEnabled,
      startPlanProviderId,
      startProviderFingerprint,
    ],
  );
}

function resolveEntitlementAccountAccess(
  access: ZCodeProviderAccountAccess | undefined,
  selection: ProviderFamilyConnectionSelection | undefined,
): ZCodeProviderAccountAccess | ZCodeAccountAccess | undefined {
  if (access?.mode !== "team-coding-plan" || selection?.kind !== "team-coding-plan") {
    // The display query is for this package itself, and does not allow the current parser to be changed to another current package during execution.
    return access && (access.mode === "start-plan" || access.mode === "individual-coding-plan")
      ? { type: "zhipu-account", family: access.accountType, planKind: access.mode }
      : access;
  }
  return {
    type: "zhipu-account",
    family: access.accountType,
    planKind: "team-coding-plan",
    productId: selection.productId,
    organizationId: selection.organizationId,
    projectId: selection.projectId,
  };
}

export function useCodingPlanAccessRefresh({
  refresh,
  selectedPlanKey,
}: {
  refresh: (options?: UsageEntitlementRefreshOptions) => Promise<void>;
  selectedPlanKey: string | null;
}): void {
  useEffect(() => {
    if (!selectedPlanKey) {
      return;
    }
    // The original effect depends on the entire selectedNavItem, and the projection changes of the amount and loading will also
    // It was mistakenly determined that the user reopened the package. Only stable package selection identities will be responded here.
    void refresh({ silent: true, reason: "access" });
  }, [refresh, selectedPlanKey]);
}

export function useCodingPlanEntitlements({
  providerSettingsView,
  connectionSelections = {},
  suppressProviderFingerprintAutoRefresh = false,
}: {
  providerSettingsView: ProviderSettingsView | null;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  suppressProviderFingerprintAutoRefresh?: boolean;
}): {
  entitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  /** There is currently a Start Plan Provider with Account Access and the ability to independently query benefits. */
  enabledStartPlanProviderIds: string[];
  refresh: (options?: UsageEntitlementRefreshOptions) => Promise<void>;
} {
  const skippedProviderFingerprintAutoRefreshRef = useRef("");
  const loading = providerSettingsView === null;
  // React Hooks must maintain a fixed calling order, so call both families explicitly instead of dynamically traversing the Spec.
  const zaiFamily = useProviderFamilyEntitlements({
    familySpec: getModelProviderFamilySpec("zai"),
    selection: connectionSelections.zai,
    providerSettingsView,
  });
  const bigmodelFamily = useProviderFamilyEntitlements({
    familySpec: getModelProviderFamilySpec("bigmodel"),
    selection: connectionSelections.bigmodel,
    providerSettingsView,
  });

  const refresh = useCallback(
    (options: UsageEntitlementRefreshOptions = {}) => {
      // Start/Coding uses independent provider id and cache key; refresh in parallel when both are available.
      const refreshJobs: Array<Promise<void>> = [];
      if (zaiFamily.codingEnabled) {
        refreshJobs.push(zaiFamily.coding.refresh(options));
      }
      if (zaiFamily.startEnabled) {
        refreshJobs.push(zaiFamily.start.refresh(options));
      }
      if (bigmodelFamily.codingEnabled) {
        refreshJobs.push(bigmodelFamily.coding.refresh(options));
      }
      if (bigmodelFamily.startEnabled) {
        refreshJobs.push(bigmodelFamily.start.refresh(options));
      }
      return Promise.all(refreshJobs).then(() => undefined);
    },
    [
      bigmodelFamily.coding.refresh,
      bigmodelFamily.codingEnabled,
      bigmodelFamily.start.refresh,
      bigmodelFamily.startEnabled,
      zaiFamily.coding.refresh,
      zaiFamily.codingEnabled,
      zaiFamily.start.refresh,
      zaiFamily.startEnabled,
    ],
  );

  const providerFingerprint = useMemo(
    () =>
      [
        zaiFamily.codingFingerprint,
        zaiFamily.startEnabled ? zaiFamily.startProviderFingerprint : "",
        bigmodelFamily.codingFingerprint,
        bigmodelFamily.startEnabled ? bigmodelFamily.startProviderFingerprint : "",
      ]
        .filter(Boolean)
        .join("|"),
    [
      bigmodelFamily.codingFingerprint,
      bigmodelFamily.startEnabled,
      bigmodelFamily.startProviderFingerprint,
      zaiFamily.codingFingerprint,
      zaiFamily.startEnabled,
      zaiFamily.startProviderFingerprint,
    ],
  );

  useEffect(() => {
    const decision = resolveCodingPlanProviderFingerprintAutoRefresh({
      loading,
      providerFingerprint,
      skippedProviderFingerprint: skippedProviderFingerprintAutoRefreshRef.current,
      suppressAutoRefresh: suppressProviderFingerprintAutoRefresh,
    });
    skippedProviderFingerprintAutoRefreshRef.current = decision.skippedProviderFingerprint;
    if (!decision.shouldRefresh) {
      return;
    }

    // After the provider configuration is loaded or saved asynchronously, the first entitlement snapshot may still be stale.
    // Connection method synchronization will refresh Account Access separately, and the same change cannot be diffused into package/balance refresh.
    refresh({ force: true, silent: true, reason: "auth" });
  }, [providerFingerprint, loading, refresh, suppressProviderFingerprintAutoRefresh]);

  return useMemo(
    () => ({
      entitlements: {
        [zaiFamily.codingPlanProviderId]: {
          snapshot: zaiFamily.coding.snapshot,
          loading: zaiFamily.coding.loading,
          error: zaiFamily.coding.error,
        },
        [zaiFamily.startPlanProviderId]: {
          snapshot: zaiFamily.startEnabled ? zaiFamily.start.snapshot : null,
          loading: zaiFamily.startEnabled ? zaiFamily.start.loading : false,
          error: zaiFamily.startEnabled ? zaiFamily.start.error : null,
        },
        [bigmodelFamily.codingPlanProviderId]: {
          snapshot: bigmodelFamily.coding.snapshot,
          loading: bigmodelFamily.coding.loading,
          error: bigmodelFamily.coding.error,
        },
        [bigmodelFamily.startPlanProviderId]: {
          snapshot: bigmodelFamily.startEnabled ? bigmodelFamily.start.snapshot : null,
          loading: bigmodelFamily.startEnabled ? bigmodelFamily.start.loading : false,
          error: bigmodelFamily.startEnabled ? bigmodelFamily.start.error : null,
        },
      },
      enabledStartPlanProviderIds: [
        ...(zaiFamily.startEnabled ? [zaiFamily.startPlanProviderId] : []),
        ...(bigmodelFamily.startEnabled ? [bigmodelFamily.startPlanProviderId] : []),
      ],
      refresh,
    }),
    [bigmodelFamily, refresh, zaiFamily],
  );
}
