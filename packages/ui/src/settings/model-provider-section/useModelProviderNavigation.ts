/* eslint-disable max-lines -- Model Provider navigation needs the groups, the selected item and the
 * Coding Plan entitlement state computed in one place; they can be narrowed down if it is split
 * later.
 */
import { useEffect, useMemo } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import type {
  ProviderFamilyConnectionSelection,
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
} from "@zcode/shared";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isStartPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  resolveProviderFamilyDomainFromOAuthProvider,
  type OAuthProviderId,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  CODING_PLAN_PROVIDER_SPECS,
  type CodingPlanEntitlementState,
  type ModelProviderNavGroup,
  type PresetProviderSpec,
} from "@/settings/model-provider-section/constants.js";
import { pickCodingPlanEntitlementProvider } from "@/lib/codingPlanProvider.js";
import {
  createCodingPlanProviderNodeKey,
  createCustomProviderNodeKey,
  createPresetProviderNodeKey,
} from "@/settings/model-provider-section/utils.js";
import {
  sortModelProvidersForDisplay,
  type ProviderOrderView,
} from "@/lib/modelProviderOrdering.js";
import type { EnterpriseCodingPlanProductDisplay } from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import {
  buildVisibleFamilyConnectionItems,
  resolveCodingPlanEntitlementState,
} from "@/settings/model-provider-section/providerFamilyConnectionVisibility.js";

interface PresetProviderWithConfig extends PresetProviderSpec {
  provider: ProviderSettingsFormProvider | null;
}

interface UseModelProviderNavigationOptions {
  presetProviders: PresetProviderWithConfig[];
  modelProviders: ProviderSettingsFormProvider[];
  /**
   * The providers the current account definitely has entitlements for. Absent is equivalent to
   * having no account entitlements yet; the production settings page always passes it explicitly.
   */
  entitledAccountProviderIds?: ReadonlySet<string>;
  modelProvidersLoading?: boolean;
  displayOrder?: ProviderOrderView;
  codingPlanEntitlements?: Partial<Record<string, CodingPlanEntitlementState>>;
  providerFamilyDomain?: ProviderFamilyDomain | null;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
  familyConnectionSettingsLoading?: boolean;
  familyConnectionSettingsFailed?: boolean;
  subscribedTeamProducts?: EnterpriseCodingPlanProductDisplay[];
  showPurchasedTeamPlanFallback?: boolean;
  selectedNodeKey: string | null;
  setSelectedNodeKey: (key: string | null) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}

export function useModelProviderNavigation({
  presetProviders,
  modelProviders,
  entitledAccountProviderIds = new Set(),
  modelProvidersLoading = false,
  displayOrder,
  codingPlanEntitlements = {},
  providerFamilyDomain = null,
  connectionSelections = {},
  pendingConnectionSelections = {},
  familyConnectionSettingsLoading = false,
  familyConnectionSettingsFailed = false,
  subscribedTeamProducts = [],
  showPurchasedTeamPlanFallback = false,
  selectedNodeKey,
  setSelectedNodeKey,
  intl,
}: UseModelProviderNavigationOptions) {
  const customProviders = useMemo(() => {
    const allCustomProviders = modelProviders.filter(
      (provider) => provider.config.group === "standard-personal",
    );
    // The display order of the model menu is reused here to ensure that the settings page and chat box suppliers are in the same order.
    return sortModelProvidersForDisplay(allCustomProviders, displayOrder);
  }, [displayOrder, modelProviders]);

  const codingPlanItems = useMemo(
    () =>
      CODING_PLAN_PROVIDER_SPECS.filter((spec) =>
        shouldShowCodingPlanForProviderFamilyDomain(spec.oauthProviderId, providerFamilyDomain),
      ).map((spec) => {
        const provider = modelProviders.find((item) => item.providerId === spec.id) ?? null;
        const accountEntitled = entitledAccountProviderIds.has(spec.id);
        const entitlementProvider = pickCodingPlanEntitlementProvider(provider);
        const entitlement = codingPlanEntitlements[spec.id];
        const state = resolveCodingPlanEntitlementState({
          providerId: spec.id,
          accountEntitled,
          accountAvailability: provider?.accountState?.availability,
          accountUnavailableReason: provider?.accountState?.unavailableReason,
          entitlement,
          modelProvidersLoading,
        });

        return {
          key: createCodingPlanProviderNodeKey(spec.id),
          type: "codingPlan" as const,
          presetId: spec.id,
          oauthProviderId: spec.oauthProviderId,
          label: isStartPlanModelProviderId(spec.id)
            ? "Start Plan"
            : `${spec.providerName} - ${intl.formatMessage({
                id: "settings.modelProvider.connectionMode.codingPlan",
              })}`,
          providerName: spec.providerName,
          provider: entitlementProvider,
          accountEntitled,
          status: state.status,
          statusLabelId: state.statusLabelId,
          ...(isStartPlanModelProviderId(spec.id) &&
          entitlement?.snapshot?.unavailableReason === "not_authenticated"
            ? {
                accountLoginRequired: true,
                statusLabelId: "settings.modelProvider.startPlan.status.loginExpired",
              }
            : {}),
          planLevel: state.planLevel,
          currentProductId: state.currentProductId,
          subscriptionBillingCycle: state.subscriptionBillingCycle,
          subscriptionRenewTime: state.subscriptionRenewTime,
          subscriptionExpireTime: state.subscriptionExpireTime,
          subscriptionDetails: state.subscriptionDetails,
          quotaLimits: state.quotaLimits,
          mcpQuotaLimit: state.mcpQuotaLimit ?? null,
          purchaseUrl: spec.purchaseUrl,
          statusActive: entitlementProvider?.executable === true,
        };
      }),
    [
      entitledAccountProviderIds,
      codingPlanEntitlements,
      intl,
      modelProviders,
      modelProvidersLoading,
      providerFamilyDomain,
    ],
  );
  const connectionModeCodingPlanItems = useMemo(
    () =>
      buildVisibleFamilyConnectionItems({
        items: codingPlanItems.filter((item) => !isStartPlanModelProviderId(item.presetId)),
        codingPlanEntitlements,
        subscribedTeamProducts,
        showPurchasedTeamPlanFallback,
        connectionSelections: {
          ...connectionSelections,
          ...pendingConnectionSelections,
        },
        teamPlanSelections: Object.fromEntries(
          Object.entries({ ...connectionSelections, ...pendingConnectionSelections }).filter(
            ([, selection]) => selection?.kind === "team-coding-plan",
          ),
        ),
      }),
    [
      codingPlanEntitlements,
      showPurchasedTeamPlanFallback,
      codingPlanItems,
      connectionSelections,
      pendingConnectionSelections,
      subscribedTeamProducts,
    ],
  );

  const navigationGroups = useMemo<ModelProviderNavGroup[]>(() => {
    const groups: ModelProviderNavGroup[] = [
      {
        id: "preset",
        title: intl.formatMessage({ id: "settings.modelProvider.presetTitle" }),
        items: [
          ...presetProviders.map(({ id, displayName, provider }) => {
            const statusProvider = resolvePresetFamilyStatusProvider({
              presetId: id,
              provider,
              connectionModeItems: connectionModeCodingPlanItems,
              connectionSelections,
              modelProviders,
            });
            return {
              key: createPresetProviderNodeKey(id),
              type: "preset" as const,
              presetId: id,
              label: displayName,
              logo: modelProviders.find(
                (candidate) =>
                  candidate.providerId ===
                  resolveModelProviderFamilySpecByProviderId(id)?.individualCodingPlanProviderId,
              )?.config.logo,
              provider,
              displayName,
              statusProvider,
              statusActive: statusProvider?.executable === true,
            };
          }),
          ...codingPlanItems.filter((item) => isStartPlanModelProviderId(item.presetId)),
        ],
      },
      {
        id: "custom",
        title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
        items: customProviders.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom" as const,
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable === true,
        })),
      },
    ];

    return groups;
  }, [
    customProviders,
    codingPlanItems,
    connectionModeCodingPlanItems,
    // The left navigation group title is formatted within this memo.
    // The provider/interest reference may not change when the language is switched, and you must rely on intl to refresh the copy of the old locale.
    intl,
    connectionSelections,
    pendingConnectionSelections,
    presetProviders,
    modelProviders,
  ]);

  const navigationItems = useMemo(() => {
    const visibleItems = navigationGroups.flatMap((group) => group.items);
    const visibleKeys = new Set(visibleItems.map((item) => item.key));
    return [
      ...visibleItems,
      ...connectionModeCodingPlanItems.filter((item) => !visibleKeys.has(item.key)),
    ];
  }, [connectionModeCodingPlanItems, navigationGroups]);

  const selectableNavigationItems = useMemo(
    () => navigationItems.filter((item) => item.type !== "codingPlanLoading"),
    [navigationItems],
  );
  const selectableSideNavigationItems = useMemo(
    () =>
      navigationGroups
        .flatMap((group) => group.items)
        .filter((item) => item.type !== "codingPlanLoading"),
    [navigationGroups],
  );

  const navigationItemByKey = useMemo(
    () => new Map(selectableNavigationItems.map((item) => [item.key, item])),
    [selectableNavigationItems],
  );
  const sideNavigationItemByKey = useMemo(
    () => new Map(selectableSideNavigationItems.map((item) => [item.key, item])),
    [selectableSideNavigationItems],
  );

  const selectedNavItem = selectedNodeKey
    ? resolveSelectedProviderFamilyConnectionItem({
        selectedNodeKey,
        navigationItemByKey,
        selectableNavigationItems,
        connectionSelections,
        pendingConnectionSelections,
        familyConnectionSettingsLoading,
        familyConnectionSettingsFailed,
        modelProvidersLoading,
      })
    : null;

  const requestedItem = selectedNodeKey ? navigationItemByKey.get(selectedNodeKey) : undefined;
  const requestedFamily =
    requestedItem?.type === "preset"
      ? resolveModelProviderFamilySpecByProviderId(requestedItem.presetId)
      : null;
  const requestedSelection = requestedFamily ? connectionSelections[requestedFamily.id] : undefined;
  const navigationUnavailable =
    !modelProvidersLoading &&
    !familyConnectionSettingsLoading &&
    (familyConnectionSettingsFailed ||
      Boolean(
        requestedFamily &&
        requestedSelection &&
        requestedSelection.kind !== "start-plan" &&
        !selectableNavigationItems.some((item) =>
          connectionSelectionMatchesNavigationItem(requestedFamily.id, requestedSelection, item),
        ),
      ));

  const fallbackNodeKey = resolveFallbackModelProviderNodeKey({
    selectedNodeKey,
    selectableNavigationItems,
  });
  useEffect(() => {
    const hasSelectedNode = selectedNodeKey ? sideNavigationItemByKey.has(selectedNodeKey) : false;
    if (hasSelectedNode) {
      return;
    }

    if (selectedNodeKey !== fallbackNodeKey) {
      setSelectedNodeKey(fallbackNodeKey);
    }
  }, [
    fallbackNodeKey,
    selectedNavItem,
    selectedNodeKey,
    setSelectedNodeKey,
    sideNavigationItemByKey,
  ]);

  return {
    navigationGroups,
    navigationItems,
    selectedNavItem,
    navigationUnavailable,
  };
}

function shouldShowCodingPlanForProviderFamilyDomain(
  oauthProviderId: OAuthProviderId,
  providerFamilyDomain: ProviderFamilyDomain | null,
): boolean {
  if (!providerFamilyDomain) {
    return true;
  }
  return resolveProviderFamilyDomainFromOAuthProvider(oauthProviderId) === providerFamilyDomain;
}

function resolvePresetFamilyStatusProvider({
  presetId,
  provider,
  connectionModeItems,
  connectionSelections,
  modelProviders,
}: {
  presetId: PresetProviderSpec["id"];
  provider: ProviderSettingsFormProvider | null;
  connectionModeItems: ModelProviderNavGroup["items"];
  connectionSelections: ProviderFamilyConnectionSelectionSettings;
  modelProviders: ProviderSettingsFormProvider[];
}): ProviderSettingsFormProvider | null {
  const familySpec = resolveModelProviderFamilySpecByProviderId(presetId);
  if (!familySpec) {
    return provider;
  }
  const connectionItem = pickFamilyModeNavigationItem(
    connectionModeItems.filter((item) => item.type !== "codingPlanLoading"),
    familySpec.id,
    connectionSelections,
  );
  if (!connectionItem || !isPlanConnectionNavigationItem(connectionItem)) {
    return null;
  }
  // The menu Team item may be derived from the personal item, carrying a provider that is not a team execution identity.
  // You must return to the Settings View by the specific package ID, and cannot use menu rights or inherited providers to light up.
  return (
    modelProviders.find((candidate) => candidate.providerId === connectionItem.presetId) ?? null
  );
}

function resolveFallbackModelProviderNodeKey({
  selectedNodeKey,
  selectableNavigationItems,
}: {
  selectedNodeKey: string | null;
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
}): string | null {
  const initialConnectionItem = pickInitialConnectionNavigationItem(selectableNavigationItems);
  const initialSideNodeKey = initialConnectionItem
    ? resolveSideNavigationNodeKeyForConnectionItem(initialConnectionItem)
    : null;
  if (isFamilyPresetNodeKey(selectedNodeKey) && initialSideNodeKey) {
    // After the App OAuth login is successful, another set of preset entrances will be hidden by active provider.
    // When the currently selected item disappears, use the initialization priority to fall back to the corresponding family instead of putting the connection method back into the sidebar.
    return initialSideNodeKey;
  }

  // Initialization only occurs when there is no valid selection; if the current user selection is still valid, the upper effect will not call fallback to grab focus.
  return (
    initialSideNodeKey ??
    resolveSideNavigationNodeKeyForConnectionItem(selectableNavigationItems[0] ?? null)
  );
}

function resolveSelectedProviderFamilyConnectionItem({
  selectedNodeKey,
  navigationItemByKey,
  selectableNavigationItems,
  connectionSelections,
  pendingConnectionSelections,
  familyConnectionSettingsLoading,
  familyConnectionSettingsFailed,
  modelProvidersLoading,
}: {
  selectedNodeKey: string;
  navigationItemByKey: Map<
    string,
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
  connectionSelections: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections: ProviderFamilyConnectionSelectionSettings;
  familyConnectionSettingsLoading?: boolean;
  familyConnectionSettingsFailed?: boolean;
  modelProvidersLoading?: boolean;
}): Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null {
  const selectedItem = navigationItemByKey.get(selectedNodeKey) ?? null;
  if (!selectedItem) {
    return null;
  }
  if (selectedItem.type !== "preset") {
    return selectedItem;
  }
  const familySpec = resolveModelProviderFamilySpecByProviderId(selectedItem.presetId);
  if (!familySpec) {
    return selectedItem;
  }
  if (familyConnectionSettingsLoading) {
    // When opening Model Settings from an external portal, the settings cannot be set to the default oauth before being hydrated for the first time.
    // The connection method deduce Start Plan, otherwise the connection method on the right side will first flash to Start and then press the saved setting to correct the deviation.
    return null;
  }
  const mergedSelections = { ...connectionSelections, ...pendingConnectionSelections };
  const resolvedItem =
    !familyConnectionSettingsFailed &&
    pickFamilyModeNavigationItem(selectableNavigationItems, familySpec.id, mergedSelections);
  if (resolvedItem) {
    return resolvedItem;
  }
  if (modelProvidersLoading) return null;
  // Illegal/expired connections only affect the landing point of the current settings page, and null cannot be treated as permanent loading by the details page.
  // The Family preference is not written back and the session Selection is not changed; the user can reselect on this same Family page.
  return pickInitialConnectionNavigationItem(
    selectableNavigationItems.filter(
      (item) =>
        "presetId" in item &&
        resolveModelProviderFamilySpecByProviderId(item.presetId)?.id === familySpec.id,
    ),
  );
}

function resolveSideNavigationNodeKeyForConnectionItem(
  item: Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null,
): string | null {
  if (!item) {
    return null;
  }
  if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
    return item.key;
  }
  if (item.type === "codingPlan" && isStartPlanModelProviderId(item.presetId)) return item.key;
  const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
  if (!familySpec) {
    return item.key;
  }
  return createPresetProviderNodeKey(familySpec.startPlanProviderId);
}

function pickInitialConnectionNavigationItem(
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >,
): Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null {
  const planItems = selectableNavigationItems.filter(isPlanConnectionNavigationItem);
  const personalCodingPlanItem = planItems.find(
    (item) =>
      item.type === "codingPlan" &&
      !isStartPlanModelProviderId(item.presetId) &&
      item.status === "purchased",
  );
  if (personalCodingPlanItem) {
    return personalCodingPlanItem;
  }
  const teamPlanItem = planItems.find((item) => item.type === "teamPlan");
  if (teamPlanItem) {
    return teamPlanItem;
  }
  const personalCodingPlanFallback = planItems.find(
    (item) => item.type === "codingPlan" && !isStartPlanModelProviderId(item.presetId),
  );
  if (personalCodingPlanFallback) {
    return personalCodingPlanFallback;
  }
  if (planItems[0]) {
    return planItems[0];
  }
  return selectableNavigationItems.find((item) => item.type === "preset") ?? null;
}

function pickFamilyModeNavigationItem(
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >,
  familyId: "zai" | "bigmodel",
  connectionSelections: ProviderFamilyConnectionSelectionSettings,
): Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null {
  const selection = connectionSelections[familyId];
  if (!selection) return null;
  return (
    selectableNavigationItems.find((item) =>
      connectionSelectionMatchesNavigationItem(familyId, selection, item),
    ) ?? null
  );
}

export function connectionSelectionMatchesNavigationItem(
  family: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
  item: Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>,
): boolean {
  if (item.type === "custom") return false;
  const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId ?? "");
  if (familySpec?.id !== family) return false;
  if (selection.kind === "start-plan") {
    return false;
  }
  if (selection.kind === "individual-coding-plan") {
    return (
      item.type === "codingPlan" && item.presetId === familySpec.individualCodingPlanProviderId
    );
  }
  return (
    item.type === "teamPlan" &&
    item.presetId === familySpec.teamCodingPlanProviderId &&
    // Team connections are targeted by platform, organization, and project; subscription offerings change between benefit snapshots and pricing corrections.
    // Product updates of the same item cannot be misjudged as connection loss, otherwise empty options and error prompts will appear during initialization.
    item.organizationId === selection.organizationId &&
    item.projectId === selection.projectId
  );
}

function isPlanConnectionNavigationItem(
  item: Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>,
): item is Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" | "teamPlan" }> {
  return (
    (item.type === "codingPlan" && !isStartPlanModelProviderId(item.presetId)) ||
    item.type === "teamPlan"
  );
}

function isFamilyPresetNodeKey(nodeKey: string | null): boolean {
  return (
    nodeKey?.startsWith("coding-plan:") === true ||
    nodeKey?.startsWith("team:") === true ||
    nodeKey === `preset:${BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan}` ||
    nodeKey === `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`
  );
}
