import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- the footer package logo, upgrade entry and entitlement detection share the same file
   Provider selection and family filtering context, splitting files will make zai/bigmodel symmetry difficult to track. */
import { useEffect, useMemo } from "react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  normalizeProviderFamilyDomain,
  resolveModelProviderFamilyIdByProviderId,
  TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON,
} from "@zcode/shared";
import { BarChart3Icon, RocketIcon } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import {
  resolveCodingPlanUsageRemainingState,
  type CodingPlanUsageAvailableProvider,
} from "@/CodingPlanUsageRemainingPanel.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  resolveEntitledAccountProviderAccess,
  resolveEntitledAccountProviderAccessFingerprint,
} from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import {
  isMaxCodingPlanSnapshot,
  resolveSidebarCodingPlanUpgradeFallbackProviderId,
} from "@/lib/sidebarCodingPlanUpgrade.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
  type CodingPlanFunnelContext,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { type SidebarUsageCodingPlanProviderId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import {
  buildCodingPlanUsageSources,
  resolveSidebarCurrentCodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { parseCustomProviderIdFromSupplierKey } from "@/lib/modelConfigSync.js";
import { setPendingSettingsUsageIntent } from "@/lib/settingsNavigation.js";
import {
  resolveSidebarFooterPlanBadgeLabel,
  resolveSidebarFooterProfilePlanBadge,
} from "@/WorkspaceSidebarFooterPlanBadgeHelpers.js";

export {
  resolveSidebarFooterPlanBadgeLabel,
  resolveSidebarFooterProfilePlanBadge,
} from "@/WorkspaceSidebarFooterPlanBadgeHelpers.js";

const TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON = "sidebar-coding-plan-upgrade-button";

export function WorkspaceSidebarFooterUsageSummary({
  enabled,
  onUsageClick,
  onUpgradeClick,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  onUsageClick?: () => void;
  onUpgradeClick?: (
    providerId: SidebarUsageCodingPlanProviderId,
    funnelContext: CodingPlanFunnelContext,
  ) => void;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const state = useWorkspaceSidebarFooterUsageSummaryState({
    enabled,
    workspaceIdentity,
    workspacePath,
  });
  return (
    <WorkspaceSidebarFooterUsageSummaryContent
      state={state}
      onUsageClick={onUsageClick}
      onUpgradeClick={onUpgradeClick}
    />
  );
}

export function useWorkspaceSidebarFooterUsageSummaryState({
  enabled,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const { settings: sharedSettings } = useSettings();
  const providerFamilyDomain = normalizeProviderFamilyDomain(sharedSettings?.providerFamilyDomain);
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  // A first-time read failure cannot be interpreted as "already loaded and has no package"; only Ready can consume Provider facts.
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  const selectedSupplierKey = useZCodeSessionStore((state) =>
    workspacePath
      ? selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).selectedSupplierKey
      : "",
  );
  const availableCodingPlanProviders = useMemo(
    () =>
      [
        BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      ].flatMap((providerId): CodingPlanUsageAvailableProvider[] => {
        const access = resolveEntitledAccountProviderAccess(providerSettingsView, providerId);
        if (!access) return [];
        return [
          {
            providerId,
            accountAccess: access.access,
            label:
              access.label ||
              (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
                ? "Z.ai - Coding Plan"
                : "BigModel - Coding Plan"),
          },
        ];
      }),
    [providerSettingsView],
  );
  const zaiProvider = availableCodingPlanProviders.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const bigmodelProvider = availableCodingPlanProviders.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const zaiProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const bigmodelProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const zaiTeamProvider = resolveEntitledAccountProviderAccess(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  );
  const bigmodelTeamProvider = resolveEntitledAccountProviderAccess(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  );
  const selectedProviderIdFromSupplierKey =
    parseCustomProviderIdFromSupplierKey(selectedSupplierKey);
  const selectedProviderFamilyId = selectedProviderIdFromSupplierKey
    ? resolveModelProviderFamilyIdByProviderId(selectedProviderIdFromSupplierKey)
    : null;
  // providerFamilyDomain is the current login/running family boundary; BigModel Team selectedKey
  // It will be retained after switching to Z.ai. If the footer is not filtered by the current domain, the logo next to the avatar will be mistakenly displayed as Team.
  const scopedSelectedProviderId =
    selectedProviderFamilyId &&
    providerFamilyDomain &&
    selectedProviderFamilyId !== providerFamilyDomain
      ? null
      : selectedProviderIdFromSupplierKey;
  const bigmodelFamilyAllowed = providerFamilyDomain !== "zai";
  // Originally, there was only single variable bigmodelFamilyAllowed, but enterprise products under zai family was not included at all.
  // Zai team plan symmetry requires Zai family to independently pull out enterprise pricing.
  const zaiFamilyAllowed = providerFamilyDomain !== "bigmodel";
  const bigmodelEnterpriseProducts = useEnterpriseCodingPlanProducts({
    // Both the footer badge and the upgrade entrance are required to identify the Team Plan.
    // The Team project context is only returned in enterprise pricing/customerInfo, and the account-level avatar logo cannot be stuck by the current connection method.
    enabled:
      enabled && !providerSourcesLoading && bigmodelFamilyAllowed && Boolean(bigmodelTeamProvider),
    authenticated: true,
    family: "bigmodel",
  });
  const zaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled: enabled && !providerSourcesLoading && zaiFamilyAllowed && Boolean(zaiTeamProvider),
    authenticated: true,
    family: "zai",
  });
  const subscribedTeamProducts = useMemo(
    () => [
      ...(bigmodelEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(zaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [bigmodelEnterpriseProducts.snapshot?.productList, zaiEnterpriseProducts.snapshot?.productList],
  );
  const teamSources = useMemo(
    () =>
      buildCodingPlanUsageSources({
        accountAccesses: {
          ...(zaiTeamProvider?.access
            ? {
                zai: zaiTeamProvider.access,
              }
            : {}),
          ...(bigmodelTeamProvider?.access
            ? {
                bigmodel: bigmodelTeamProvider.access,
              }
            : {}),
        },
        subscribedTeamProducts,
      }),
    [bigmodelTeamProvider?.access, subscribedTeamProducts, zaiTeamProvider?.access],
  );
  const currentUsageSource = useMemo(
    () =>
      resolveSidebarCurrentCodingPlanUsageSource({
        selections: sharedSettings?.providerFamilyConnectionSelections,
        selectedProviderId: scopedSelectedProviderId,
        accountAccesses: {
          ...(resolveEntitledAccountProviderAccess(
            providerSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          )?.access
            ? {
                zai: resolveEntitledAccountProviderAccess(
                  providerSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                )!.access,
              }
            : {}),
          ...(resolveEntitledAccountProviderAccess(
            providerSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          )?.access
            ? {
                bigmodel: resolveEntitledAccountProviderAccess(
                  providerSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
                )!.access,
              }
            : {}),
        },
        teamSources,
      }),
    [
      scopedSelectedProviderId,
      bigmodelProvider?.accountAccess,
      sharedSettings?.providerFamilyConnectionSelections,
      teamSources,
      zaiProvider?.accountAccess,
    ],
  );
  const selectedProviderId = currentUsageSource?.sourceId;

  const zaiEntitlement = useUsageEntitlement({
    enabled:
      enabled &&
      !providerSourcesLoading &&
      providerFamilyDomain !== "bigmodel" &&
      Boolean(zaiProvider),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    accountAccess: resolveEntitledAccountProviderAccess(
      providerSettingsView,
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    )?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      providerFingerprint: zaiProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const bigmodelEntitlement = useUsageEntitlement({
    enabled:
      enabled && !providerSourcesLoading && bigmodelFamilyAllowed && Boolean(bigmodelProvider),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: resolveEntitledAccountProviderAccess(
      providerSettingsView,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    )?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      providerFingerprint: bigmodelProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const teamEntitlement = useUsageEntitlement({
    // The original hard-tied bigmodelCodingPlan providerId is used to determine the providerId of team source.
    // It is zaiCodingPlan, and the team branch can never be entered. As a result, the zai team quota is not queried and the badge is not displayed.
    // Instead, use the currentUsageSource.audience === "team" route, and the providerId is dynamically obtained.
    enabled: enabled && !providerSourcesLoading && currentUsageSource?.audience === "team",
    includeSubscription: true,
    preferredProviderId:
      currentUsageSource?.providerId ?? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: currentUsageSource?.teamSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: currentUsageSource?.teamSource?.id,
    refreshOnMount: false,
  });
  // footer is a permanent entry, refreshOnMount: false and nothing else after cold start
  // Entrance entitlement, personal plan logo missing. Trigger an access refresh when visible and reuse the share
  // 1 minute freshness window, failure backoff and in-flight merge; refresh is no-op when hook disabled.
  useEffect(() => {
    for (const refresh of [
      zaiEntitlement.refresh,
      bigmodelEntitlement.refresh,
      teamEntitlement.refresh,
    ]) {
      void refresh({ silent: true, reason: "access" });
    }
  }, [zaiEntitlement.refresh, bigmodelEntitlement.refresh, teamEntitlement.refresh]);
  const profilePlanBadge = resolveSidebarFooterProfilePlanBadge({
    individualEntitlements: [
      ...(providerFamilyDomain !== "bigmodel"
        ? [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              snapshot: zaiEntitlement.snapshot,
              loading: zaiEntitlement.loading,
            },
          ]
        : []),
      ...(bigmodelFamilyAllowed
        ? [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
              snapshot: bigmodelEntitlement.snapshot,
              loading: bigmodelEntitlement.loading,
            },
          ]
        : []),
    ],
    // The avatar logo uses the Team entitlement of the account; the pricing result is only responsible for the credit source and package details.
    hasTeamPlanEntitlement:
      providerFamilyDomain === "zai"
        ? Boolean(zaiTeamProvider)
        : providerFamilyDomain === "bigmodel"
          ? Boolean(bigmodelTeamProvider)
          : Boolean(zaiTeamProvider || bigmodelTeamProvider),
  });
  const providerEntitlements = [
    ...(currentUsageSource?.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan &&
    currentUsageSource.audience === "individual"
      ? [
          {
            sourceId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            accountAccess: currentUsageSource.accountAccess,
            ...zaiEntitlement,
          },
        ]
      : []),
    ...(currentUsageSource?.providerId ===
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan &&
    currentUsageSource.audience === "individual"
      ? [
          {
            sourceId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            accountAccess: currentUsageSource.accountAccess,
            ...bigmodelEntitlement,
          },
        ]
      : []),
    // The original team branch hard-coded bigmodelCodingPlan providerId, and the team source cannot come in.
    // Change to unified routing based on audience === "team", covering the team sources of both zai/bigmodel families.
    ...(currentUsageSource?.audience === "team" && currentUsageSource.teamSource
      ? [
          {
            sourceId: currentUsageSource.teamSource.id,
            providerId: currentUsageSource.teamSource.providerId,
            accountAccess: currentUsageSource.teamSource.accountAccess,
            label: currentUsageSource.teamSource.label,
            ...teamEntitlement,
          },
        ]
      : []),
  ];
  const usageState = resolveCodingPlanUsageRemainingState({
    availableProviders: availableCodingPlanProviders,
    entitlements: providerEntitlements,
    modelProvidersLoading: providerSourcesLoading,
    selectedProviderId,
  });
  const visibleUsageState = usageState?.hasAnyActiveCodingPlan ? usageState : null;
  const selectedUpgradeProviderId: SidebarUsageCodingPlanProviderId | undefined =
    selectedProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    selectedProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
      ? selectedProviderId
      : undefined;
  const upgradeTargetProviderId =
    selectedUpgradeProviderId ??
    currentUsageSource?.providerId ??
    availableCodingPlanProviders[0]?.providerId ??
    resolveSidebarCodingPlanUpgradeFallbackProviderId(providerFamilyDomain);
  return {
    audience: currentUsageSource?.audience,
    availableCodingPlanProviders,
    providerSourcesLoading,
    providerEntitlements,
    profilePlanBadge,
    selectedProviderId,
    upgradeTargetProviderId,
    usageState: visibleUsageState,
  };
}

type WorkspaceSidebarFooterUsageSummaryState = ReturnType<
  typeof useWorkspaceSidebarFooterUsageSummaryState
>;

export function WorkspaceSidebarFooterUsageSummaryContent({
  state,
  onUsageClick,
  onUpgradeClick,
}: {
  state: WorkspaceSidebarFooterUsageSummaryState;
  onUsageClick?: () => void;
  onUpgradeClick?: (
    providerId: SidebarUsageCodingPlanProviderId,
    funnelContext: CodingPlanFunnelContext,
  ) => void;
}) {
  const { intl } = useZCodeIntl();
  const entryGate = useCodingPlanEntryGate();
  const { providerEntitlements, upgradeTargetProviderId } = state;
  const upgradeProviderSnapshot =
    providerEntitlements.find((item) => item.providerId === upgradeTargetProviderId)?.snapshot ??
    null;
  const upgradeActionLabelId = isMaxCodingPlanSnapshot(upgradeProviderSnapshot)
    ? "sidebar.usage.plan.renew"
    : "sidebar.usage.plan.upgrade";

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid={TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON}
        onSelect={() => {
          setPendingSettingsUsageIntent();
          onUsageClick?.();
        }}
      >
        <BarChart3Icon className="size-4" />
        {intl.formatMessage({ id: "sidebar.usage.plan.openStats" })}
      </DropdownMenuItem>
      {/* Product requirements: The upgrade entrance is always displayed; when the current package is not resolved, the brand is determined by the current provider family. */}
      <DropdownMenuItem
        data-testid={TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON}
        disabled={entryGate.status === "loading"}
        aria-busy={entryGate.status === "loading"}
        onSelect={() => {
          if (entryGate.status !== "ready") {
            entryGate.retry?.();
            return;
          }
          onUpgradeClick?.(
            upgradeTargetProviderId,
            createCodingPlanFunnelContext({
              providerId: upgradeTargetProviderId,
              upgradeSource: "profile_menu",
              eventRegion: "app.profile",
              eventText: intl.formatMessage({ id: upgradeActionLabelId }),
              entryPlanState: resolveCodingPlanEntryPlanState({
                snapshot: upgradeProviderSnapshot,
              }),
            }),
          );
        }}
      >
        <RocketIcon className="size-4" />
        {entryGate.label ?? intl.formatMessage({ id: upgradeActionLabelId })}
      </DropdownMenuItem>
    </>
  );
}

export function WorkspaceSidebarFooterPlanBadge({
  state,
}: {
  state: WorkspaceSidebarFooterUsageSummaryState;
}) {
  const { intl } = useZCodeIntl();
  const label =
    state.profilePlanBadge?.audience === "team"
      ? intl.formatMessage({ id: "sidebar.usage.plan.audienceTeam" })
      : resolveSidebarFooterPlanBadgeLabel(state.profilePlanBadge?.snapshot ?? null);
  if (!label) {
    return null;
  }

  return (
    <span
      className="min-w-0 max-w-20 shrink truncate rounded-full border border-border bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle"
      title={label}
    >
      {label}
    </span>
  );
}
