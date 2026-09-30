/* eslint-disable max-lines -- Settings and the input box share the connection-method visibility
 * rules; keeping them in one place avoids the Start/Coding/Team/API conditions drifting apart.
 */
import type {
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelection,
  ProviderFamilyConnectionSelectionSettings,
  UsageEntitlementSubscriptionDetail,
  UsageQuotaLimit,
} from "@zcode/shared";
import {
  getModelProviderFamilySpec,
  isIndividualCodingPlanModelProviderId,
  isStartPlanModelProviderId,
  MODEL_PROVIDER_FAMILY_SPECS,
  resolveModelProviderFamilySpecByProviderId,
} from "@zcode/shared";
import { resolveMcpQuotaLimit } from "@/lib/codingPlanQuotaPresentation.js";
import { resolveUsageEntitlementOutcome } from "@/lib/codingPlanProvider.js";
import { formatTeamPlanDisplayName } from "@/lib/teamPlanDisplayName.js";
import {
  resolveEnterpriseCodingPlanProductFamily,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import {
  type CodingPlanEntitlementState,
  type CodingPlanStatus,
  type ModelProviderNavGroup,
} from "@/settings/model-provider-section/constants.js";

type TeamPlanNavItem = Extract<ModelProviderNavGroup["items"][number], { type: "teamPlan" }>;

function createTeamPlanNavigationKey(
  family: ProviderFamilyDomain,
  input: { productId: string; organizationId: string; projectId: string },
): string {
  return ["team", family, input.productId, input.organizationId, input.projectId]
    .map(encodeURIComponent)
    .join(":");
}

interface ResolvedCodingPlanEntitlementState {
  statusLabelId?: string;
  status: CodingPlanStatus;
  planLevel: string | null;
  currentProductId: string | null;
  subscriptionBillingCycle: string | null;
  subscriptionRenewTime: string | null;
  subscriptionExpireTime: string | null;
  subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
  quotaLimits: UsageQuotaLimit[];
  /**
   * The official Server MCP quota (the total quota pushed down by the server). It is not in
   * quota.limits[] and is only filled in on branches that have a package snapshot; other branches
   * leave it at the default (equivalent to showing nothing), so that a dozen early-return branches
   * do not all have to change.
   */
  mcpQuotaLimit?: UsageQuotaLimit | null;
}

export function resolveCodingPlanEntitlementState({
  providerId,
  accountEntitled,
  accountAvailability,
  accountUnavailableReason,
  entitlement,
  modelProvidersLoading,
}: {
  providerId: string;
  /** Whether the current account explicitly holds the product entitlement for that Provider. */
  accountEntitled: boolean;
  accountAvailability?: import("@zcode/provider").AccountProviderState["availability"];
  accountUnavailableReason?: import("@zcode/provider").AccountProviderState["unavailableReason"];
  entitlement?: CodingPlanEntitlementState;
  modelProvidersLoading: boolean;
}): ResolvedCodingPlanEntitlementState {
  // Start verification failure is unknown, reading/retrying is still allowed, and it cannot fall back to not logged in.
  const canInspect =
    accountEntitled ||
    accountAvailability === "pending" ||
    (isStartPlanModelProviderId(providerId) && accountAvailability === "unknown");
  if (!canInspect && modelProvidersLoading) {
    return {
      // When the new Host starts, the first View of the Account Overlay may be later than the old one.
      // Provider snapshot. This window must keep checking, cannot read old keys, and cannot determine disconnection in advance.
      status: "checking",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }
  if (!canInspect) {
    // entitled=false does not mean "not connected". Account Overlay only publishes after provider-refactor
    // entitled Boolean value, "Logged in and the server clearly answered that there is no personal package" and "Not connected" are combined and rendered into
    // "Not connected + connect button" (not determined as "not activated" by no_plan of the equity snapshot), and is not available provider
    // Equity queries will no longer be initiated, and the UI cannot restore the reasons on its own and can only rely on the reasons distributed along with the State.
    // After Start is established, it is also displayed by reason; Team Plan continues to be assembled from team equity snapshots.
    // The reason is only true when availability === "unavailable", unknown means it cannot be determined in this round.
    if (
      accountAvailability === "unavailable" &&
      (isIndividualCodingPlanModelProviderId(providerId) || isStartPlanModelProviderId(providerId))
    ) {
      if (accountUnavailableReason === "not-entitled") {
        return {
          // The server clearly does not have a personal package: this is "not activated", not a connection failure.
          status: "notPurchased",
          ...(isStartPlanModelProviderId(providerId) && entitlement?.snapshot?.startPlanExpired
            ? { statusLabelId: "settings.modelProvider.startPlan.status.expired" }
            : {}),
          planLevel: null,
          currentProductId: null,
          subscriptionBillingCycle: null,
          subscriptionRenewTime: null,
          subscriptionExpireTime: null,
          quotaLimits: [],
        };
      }
      if (accountUnavailableReason === "credential-failed") {
        return {
          // Invalid credentials are a failure to synchronize rights, not non-purchases; the entrance remains available for retry/re-login.
          status: "unavailable",
          planLevel: null,
          currentProductId: null,
          subscriptionBillingCycle: null,
          subscriptionRenewTime: null,
          subscriptionExpireTime: null,
          quotaLimits: [],
        };
      }
    }
    return {
      // The package connection is an Account Overlay fact and cannot be read by the Renderer.
      // API Key facts. After the new Host explicitly passes false, the old Key must no longer light up the connection state.
      status:
        isStartPlanModelProviderId(providerId) && accountAvailability === "unknown"
          ? "unavailable"
          : "disconnected",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  const snapshot = entitlement?.snapshot ?? null;
  if (entitlement?.loading && !snapshot?.subscription) {
    return {
      // refresh will retain the last round of snapshot; checking will be displayed only when there is no valid subscription.
      status: "checking",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  if (!snapshot && entitlement?.error) {
    return {
      // The loading state must be exited when the equity request fails.
      status: "unavailable",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  const currentSubscription = snapshot?.subscription?.details[0] ?? null;
  const subscriptionDetails = snapshot?.subscription?.details ?? [];
  const currentProductId = currentSubscription?.productId ?? null;
  const planLevel =
    currentSubscription?.productName ?? snapshot?.quota?.level ?? currentProductId ?? null;
  const subscriptionBillingCycle = currentSubscription?.billingCycle ?? null;
  const subscriptionRenewTime = currentSubscription?.renewTime ?? null;
  const subscriptionExpireTime = currentSubscription?.expireTime ?? null;

  if (currentSubscription) {
    return {
      // The real package status of Z.AI/BigModel comes from subscription/list.
      status: "purchased",
      ...(entitlement?.error
        ? { statusLabelId: "settings.modelProvider.codingPlan.status.unavailable" }
        : {}),
      planLevel,
      currentProductId,
      subscriptionBillingCycle,
      subscriptionRenewTime,
      subscriptionExpireTime,
      subscriptionDetails,
      quotaLimits: snapshot?.quota?.limits ?? [],
      mcpQuotaLimit: resolveMcpQuotaLimit(snapshot),
    };
  }

  const entitlementOutcome = resolveUsageEntitlementOutcome(snapshot);
  if (entitlementOutcome === "inactive") {
    return {
      status: "notPurchased",
      ...(isStartPlanModelProviderId(providerId) && snapshot?.startPlanExpired
        ? { statusLabelId: "settings.modelProvider.startPlan.status.expired" }
        : {}),
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  if (entitlementOutcome === "unknown") {
    return {
      // In the past, unknown snapshots that were not no_plan were classified as "not purchased" and let entitlement
      // It is an ultra vires decision to decide whether the Account is disconnected. When the account is connected, unknown evidence can only be displayed and is temporarily unavailable.
      status: "unavailable",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  return {
    status: "purchased",
    ...(entitlement?.error
      ? { statusLabelId: "settings.modelProvider.codingPlan.status.unavailable" }
      : {}),
    planLevel,
    currentProductId,
    subscriptionBillingCycle,
    subscriptionRenewTime,
    subscriptionExpireTime,
    subscriptionDetails,
    quotaLimits: snapshot?.quota?.limits ?? [],
    mcpQuotaLimit: resolveMcpQuotaLimit(snapshot),
  };
}

export function buildVisibleFamilyConnectionItems({
  items,
  codingPlanEntitlements = {},
  subscribedTeamProducts,
  connectionSelections,
  teamPlanSelections,
  showPurchasedTeamPlanFallback,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  codingPlanEntitlements?: Partial<Record<string, CodingPlanEntitlementState>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
  showPurchasedTeamPlanFallback: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  teamPlanSelections?: Partial<
    Record<
      ProviderFamilyDomain,
      Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>
    >
  >;
}): ModelProviderNavGroup["items"] {
  return appendSubscribedTeamPlanItems({
    items: filterStartPlanItemsByEntitlement({
      items,
      codingPlanEntitlements,
      subscribedTeamProducts,
      connectionSelections,
    }),
    codingPlanEntitlements,
    teamPlanSelections,
    showPurchasedTeamPlanFallback,
    subscribedTeamProducts,
  });
}

function filterStartPlanItemsByEntitlement({
  items,
  codingPlanEntitlements,
  subscribedTeamProducts,
  connectionSelections,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
}): Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>> {
  // The original variable name hasBigModelTeamPlan implies that it only serves bigmodel, but the logic
  // (entitlement or subscribedTeamProducts) itself is family independent.
  // Rename to a neutral name and remove the familySpec.id === "bigmodel" guard below the filter,
  // Allow zai family to filter the Start Plan entry based on team plan.
  const hasAnyTeamPlan =
    hasEntitlementTeamPlan(codingPlanEntitlements) || subscribedTeamProducts.length > 0;
  return items.filter((item) => {
    if (!isStartPlanModelProviderId(item.presetId)) {
      return true;
    }
    const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
    if (!familySpec) {
      return false;
    }
    const codingItem = items.find(
      (candidate) => candidate.presetId === familySpec.individualCodingPlanProviderId,
    );
    const hasStartPlanEntitlement = item.status === "purchased";
    const isSelectedStartPlan = connectionSelections?.[familySpec.id]?.kind === "start-plan";
    const shouldPreserveUnresolvedSelection =
      isSelectedStartPlan && (item.status === "checking" || item.status === "unavailable");
    const loggedIn =
      item.accountEntitled === true ||
      codingItem?.accountEntitled === true ||
      isResolvedEntitlementStatus(item.status) ||
      isResolvedEntitlementStatus(codingItem?.status ?? "disconnected") ||
      hasAnyTeamPlan;

    if (!loggedIn) {
      // When not logged in, the trial package is only used as a guide to the details page, not as a connection method.
      return false;
    }

    // Start Plan is an independent connection; individual/team Coding interests are no longer involved in visibility judgment.
    // The user's selected options are retained during the query or when they are temporarily unavailable. They will be hidden only if they clearly have no rights.
    return hasStartPlanEntitlement || shouldPreserveUnresolvedSelection;
  });
}

/**
 * Looks up the Coding Plan nav item of the corresponding family by family. The original
 * appendSubscribedTeamPlanItems hardcoded a lookup of bigmodelCodingPlan, so zai team plan items
 * had no matching display baseline. After zai/bigmodel are made symmetric, a team item's display
 * fields such as providerName and provider should be inherited from its own family's
 * codingPlanItem.
 */
function resolveCodingPlanItemForFamily(
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>,
  family: ProviderFamilyDomain,
): Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }> | undefined {
  const codingPlanProviderId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  return items.find((item) => item.presetId === codingPlanProviderId);
}

function appendSubscribedTeamPlanItems({
  items,
  codingPlanEntitlements,
  teamPlanSelections,
  showPurchasedTeamPlanFallback,
  subscribedTeamProducts,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  teamPlanSelections?: Partial<
    Record<
      ProviderFamilyDomain,
      Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>
    >
  >;
  showPurchasedTeamPlanFallback: boolean;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
}): ModelProviderNavGroup["items"] {
  // The original implementation first uses items.find(bigmodelCodingPlan), and directly returns items if they do not exist.
  // When the settings page only displays zai family (providerFamilyDomain === "zai"), in codingPlanItems
  // Without bigmodelCodingPlan, this guard will short-circuit appendSubscribedTeamPlanItems as a whole.
  // zai teamPlan item is never generated → pickFamilyModeNavigationItem cannot find saved team item
  // → selectedNavItem=null → The right Plan Card is always stuck in "Loading".
  // Symmetry: Remove the hard-coded front guard of bigmodel and the three builders of entitlement/fallback/product
  // The corresponding codingPlanItem is parsed by family. If it does not exist, the family will be skipped.

  // The two builders entitlement + fallback originally only called bigmodelCodingPlanItem.
  // zai's entitlement snapshot and fallback selectedKey never generate team items (broken).
  // Traverse the two families, each using the corresponding codingPlanItem to derive entitlement team items + fallback.
  const entitlementTeamItems: TeamPlanNavItem[] = MODEL_PROVIDER_FAMILY_SPECS.flatMap(
    ({ id: family }) => {
      const codingPlanItem = resolveCodingPlanItemForFamily(items, family);
      if (!codingPlanItem) {
        return [];
      }
      return buildEntitlementTeamPlanItems(codingPlanItem, codingPlanEntitlements, family);
    },
  );
  const fallbackTeamItems: TeamPlanNavItem[] = MODEL_PROVIDER_FAMILY_SPECS.flatMap(
    ({ id: family }) => {
      const selection = teamPlanSelections?.[family];
      const codingPlanItem = resolveCodingPlanItemForFamily(items, family);
      return selection && codingPlanItem
        ? buildSelectedTeamPlanFallbackItems({
            codingPlanItem,
            selection,
            showPurchasedTeamPlanFallback,
            family,
          })
        : [];
    },
  );
  if (
    entitlementTeamItems.length === 0 &&
    fallbackTeamItems.length === 0 &&
    subscribedTeamProducts.length === 0
  ) {
    return items;
  }

  const seenTeamKeys = new Set<string>();
  const productTeamItems: TeamPlanNavItem[] = subscribedTeamProducts.flatMap((product) => {
    // According to product.family, find the codingPlanItem corresponding to the family as the display baseline of the team item.
    // The default bigmodel is backward compatible with old data without family tags.
    const productFamily = resolveEnterpriseCodingPlanProductFamily(product);
    const codingPlanItemForProduct = resolveCodingPlanItemForFamily(items, productFamily);
    if (!codingPlanItemForProduct) {
      return [];
    }
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? null,
              organizationName: product.organizationName ?? null,
              projectId: product.projectId ?? null,
              projectName: product.projectName ?? null,
              apiKeyStatus: product.apiKeyStatus,
              apiKeyUnavailableReason: product.apiKeyUnavailableReason,
              apiKeyUnavailableMessage: product.apiKeyUnavailableMessage,
            },
          ];

    return projectContexts.flatMap((projectContext) => {
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectKey = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectKey) {
        return [];
      }
      // The deduplication key must contain the family dimension, otherwise zai/bigmodel with the same productId+org+project will overwrite each other.
      const teamKey = `${productFamily}:${product.productId}:${organizationId}:${projectKey}`;
      if (seenTeamKeys.has(teamKey)) {
        return [];
      }
      seenTeamKeys.add(teamKey);
      const teamPlanName = resolveTeamPlanDisplayName({
        ...product,
        organizationName: projectContext.organizationName ?? product.organizationName,
        projectName: projectContext.projectName ?? product.projectName,
      });
      if (!teamPlanName) {
        // Only the organization name is allowed in the visible copy of Team Plan; if it is missing, blank connection items cannot be rendered.
        return [];
      }
      const teamProjectApiKeyUnavailable = projectContext.apiKeyStatus === "unavailable";
      const teamQuotaUnavailable = isTeamPlanQuotaUnavailable({
        codingPlanEntitlements,
        family: productFamily,
        organizationId,
        projectId: projectKey,
      });
      const teamPlanUnavailable = teamProjectApiKeyUnavailable || teamQuotaUnavailable;
      const availabilityReason = teamProjectApiKeyUnavailable
        ? ("credential-unavailable" as const)
        : teamQuotaUnavailable
          ? ("not-allocated" as const)
          : undefined;
      return [
        {
          ...codingPlanItemForProduct,
          // The display key is generated by family and complete team project, and the request authentication identity is not reused.
          key: createTeamPlanNavigationKey(productFamily, {
            productId: product.productId,
            organizationId,
            projectId: projectKey,
          }),
          presetId: getModelProviderFamilySpec(productFamily).teamCodingPlanProviderId,
          type: "teamPlan" as const,
          label: `${codingPlanItemForProduct.providerName} - ${teamPlanName}`,
          teamPlanName,
          organizationId,
          projectId: projectKey,
          // The Team Plan status card should use the same team display name as the connection method.
          // Directly displaying productName/tier will return "Standard Edition/Advanced Edition" in the Chinese environment and lose the project or organization name.
          planLevel: teamPlanName,
          inactivePlanTitle: teamPlanName,
          currentProductId: product.productId,
          // Team Plan reuses the Coding Plan provider corresponding to the family, but the management entrance must enter the team package page;
          // Continuing to inherit the personal/overview of the personal Coding Plan will take the user to the wrong plan context.
          purchaseUrl: getModelProviderFamilySpec(productFamily).teamCodingPlanManageUrl,
          // The existence of the Team Plan entrance and the copyability of the project API key cannot prove that the team plan is valid.
          // Validity must be determined by the team quota snapshot to avoid continuing to display the enabled status of the personal package.
          status: teamPlanUnavailable ? ("unavailable" as const) : ("purchased" as const),
          // Project Key being unavailable and Team quota being unassigned are different facts.
          // "Team package not allocated" is displayed only when the server clearly does not have a team quota.
          statusLabelId:
            availabilityReason === "not-allocated"
              ? "settings.modelProvider.codingPlan.status.teamUnavailable"
              : undefined,
          availabilityReason,
          statusMessage: teamProjectApiKeyUnavailable
            ? (projectContext.apiKeyUnavailableMessage?.trim() ?? null)
            : null,
          subscriptionBillingCycle: null,
          subscriptionRenewTime: null,
          subscriptionExpireTime: null,
          // When the Team Plan project does not have the zcode-team-api-key available, it cannot continue to be regarded as the enabled connection method.
          // The server will return apiKeyStatus by organization/project; the UI needs to be clearly marked as unavailable in the connection item and status card.
          statusActive: !teamPlanUnavailable,
        },
      ];
    });
  });

  const productTeamItemsByProjectKey = new Map(
    productTeamItems.map((item) => [resolveTeamPlanProjectKey(item), item] as const),
  );
  const correctedEntitlementTeamItems = entitlementTeamItems.map(
    (item) => productTeamItemsByProjectKey.get(resolveTeamPlanProjectKey(item)) ?? item,
  );
  const correctedFallbackTeamItems = fallbackTeamItems.map(
    (item) => productTeamItemsByProjectKey.get(resolveTeamPlanProjectKey(item)) ?? item,
  );
  const correctedProjectKeys = new Set(
    correctedEntitlementTeamItems.map(resolveTeamPlanProjectKey),
  );
  const correctedFallbackProjectKeys = new Set(
    correctedFallbackTeamItems.map(resolveTeamPlanProjectKey),
  );
  const teamItems: ModelProviderNavGroup["items"] = [
    ...correctedEntitlementTeamItems,
    ...correctedFallbackTeamItems.filter(
      (item) => !correctedProjectKeys.has(resolveTeamPlanProjectKey(item)),
    ),
    ...productTeamItems.filter(
      (item) =>
        !correctedProjectKeys.has(resolveTeamPlanProjectKey(item)) &&
        !correctedFallbackProjectKeys.has(resolveTeamPlanProjectKey(item)),
    ),
  ];

  if (teamItems.length === 0) {
    return items;
  }

  // The original method hardcodes items.findIndex(bigmodelCodingPlanItem.key) as the insertion point,
  // If bigmodelCodingPlanItem does not exist in the zai-only view, it will throw (.key access undefined).
  // Instead, find the corresponding codingPlanItem according to the family to which the first team item belongs as the insertion anchor point;
  // If it is not found, it is appended to the end (same semantics as the original fallback).
  const firstTeamFamily = resolveModelProviderFamilySpecByProviderId(
    (teamItems[0] as TeamPlanNavItem | undefined)?.presetId ?? "",
  )?.id;
  const anchorCodingPlanItem = firstTeamFamily
    ? resolveCodingPlanItemForFamily(items, firstTeamFamily)
    : undefined;
  const codingPlanIndex = anchorCodingPlanItem
    ? items.findIndex((item) => item.key === anchorCodingPlanItem.key)
    : -1;
  if (codingPlanIndex < 0) {
    return [...items, ...teamItems];
  }
  return [
    ...items.slice(0, codingPlanIndex + 1),
    ...teamItems,
    ...items.slice(codingPlanIndex + 1),
  ];
}

function resolveTeamPlanDisplayName(product: EnterpriseCodingPlanProductDisplay): string | null {
  return formatTeamPlanDisplayName(product);
}

function hasEntitlementTeamPlan(
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>,
): boolean {
  return Object.values(codingPlanEntitlements).some(
    (entitlement) =>
      entitlement?.snapshot?.context?.scope === "team" &&
      Boolean(entitlement.snapshot.context.organizationId?.trim()) &&
      Boolean(entitlement.snapshot.context.projectId?.trim()),
  );
}

function buildEntitlementTeamPlanItems(
  codingPlanItem: Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>,
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>,
  family: ProviderFamilyDomain,
): TeamPlanNavItem[] {
  // The original hardcoded read bigmodelCodingPlan bucket + bigmodel team key.
  // After zai/bigmodel is symmetrized, read the corresponding codingPlan bucket by family and generate the corresponding prefix team key.
  const familySpec = getModelProviderFamilySpec(family);
  const codingPlanProviderId = familySpec.teamCodingPlanProviderId;
  const entitlement = codingPlanEntitlements[codingPlanProviderId];
  if (!entitlement) {
    return [];
  }
  const snapshot = entitlement.snapshot ?? null;
  if (snapshot?.context?.scope !== "team") {
    return [];
  }
  const organizationId = snapshot.context.organizationId?.trim() ?? "";
  const projectId = snapshot.context.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return [];
  }
  const currentSubscription = snapshot.subscription?.details[0] ?? null;
  const productId =
    snapshot.context.productId?.trim() ||
    currentSubscription?.productId?.trim() ||
    codingPlanItem.currentProductId?.trim() ||
    "current";
  const teamPlanName =
    snapshot.context.displayName?.trim() ||
    currentSubscription?.productName?.trim() ||
    codingPlanItem.planLevel?.trim() ||
    "Team";
  return [
    {
      ...codingPlanItem,
      key: createTeamPlanNavigationKey(family, {
        productId,
        organizationId,
        projectId,
      }),
      presetId: codingPlanProviderId,
      type: "teamPlan" as const,
      label: `${codingPlanItem.providerName} - ${teamPlanName}`,
      teamPlanName,
      organizationId,
      projectId,
      status: "purchased" as const,
      // The Team Plan connection item first uses entitlement snapshot as the main data source.
      // enterprise pricing/customerInfo is only responsible for subsequent correction of the name and product fields, and cannot allow the connection method to return to the Coding Plan.
      planLevel: teamPlanName,
      currentProductId: productId,
      purchaseUrl: familySpec.teamCodingPlanManageUrl,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      statusActive: true,
    },
  ];
}

function buildSelectedTeamPlanFallbackItems({
  codingPlanItem,
  selection,
  showPurchasedTeamPlanFallback,
  family,
}: {
  codingPlanItem: Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>;
  selection: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
  showPurchasedTeamPlanFallback: boolean;
  family: ProviderFamilyDomain;
}): TeamPlanNavItem[] {
  if (!showPurchasedTeamPlanFallback) {
    return [];
  }
  const teamPlanName = codingPlanItem.planLevel?.trim() || "Team";
  const familySpec = getModelProviderFamilySpec(family);
  const teamProviderId = familySpec.teamCodingPlanProviderId;
  return [
    {
      ...codingPlanItem,
      key: createTeamPlanNavigationKey(family, {
        productId: selection.productId,
        organizationId: selection.organizationId,
        projectId: selection.projectId,
      }),
      presetId: teamProviderId,
      type: "teamPlan" as const,
      label: `${codingPlanItem.providerName} - ${teamPlanName}`,
      teamPlanName,
      organizationId: selection.organizationId,
      projectId: selection.projectId,
      status: "purchased" as const,
      // enterprise pricing may not have returned subscribed team projects yet,
      // But shared settings have saved Team Plan selectedKey. The settings page needs to display the same connection method first.
      // Avoid brief break with Team Plan selection in input box/registry.
      planLevel: teamPlanName,
      currentProductId: selection.productId,
      purchaseUrl: familySpec.teamCodingPlanManageUrl,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      statusActive: true,
    },
  ];
}

function isTeamPlanQuotaUnavailable({
  codingPlanEntitlements,
  family,
  organizationId,
  projectId,
}: {
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  family: ProviderFamilyDomain;
  organizationId: string;
  projectId: string;
}): boolean {
  const codingPlanProviderId = getModelProviderFamilySpec(family).teamCodingPlanProviderId;
  const entitlement = codingPlanEntitlements[codingPlanProviderId];
  // Loading/error both indicate that the quota fact has not yet been determined, and it cannot be assumed that there is no quota for the time being.
  // As the server clearly returns "Team package is not allocated". The details page will still actively refresh this link.
  if (!entitlement || entitlement.loading || entitlement.error) {
    return false;
  }
  const snapshot = entitlement.snapshot ?? null;
  if (snapshot?.context?.scope !== "team") {
    return false;
  }
  if (
    snapshot.context.organizationId?.trim() !== organizationId ||
    snapshot.context.projectId?.trim() !== projectId
  ) {
    return false;
  }
  return !snapshot.quota;
}

function resolveTeamPlanProjectKey(item: TeamPlanNavItem): string {
  const organizationId = item.organizationId?.trim() || "";
  const projectId = item.projectId?.trim() || "";
  if (organizationId && projectId) {
    return `${organizationId}:${projectId}`;
  }
  return item.key;
}

function isResolvedEntitlementStatus(status: CodingPlanStatus): boolean {
  return status !== "checking" && status !== "disconnected";
}
