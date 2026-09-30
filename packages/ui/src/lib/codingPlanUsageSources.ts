import {
  BUILTIN_MODEL_PROVIDER_IDS,
  getModelProviderFamilySpec,
  resolveModelProviderFamilySpecByProviderId,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  resolveEnterpriseCodingPlanProductFamily,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import type {
  SidebarUsageCodingPlanProviderId,
  SidebarUsageCodingPlanSourceId,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { formatTeamPlanDisplayName } from "@/lib/teamPlanDisplayName.js";

export interface CodingPlanUsageSource {
  id: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  label: string;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

export function buildPersonalCodingPlanUsageSource({
  providerId,
  accountAccess,
  label,
}: {
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label?: string | null;
}): CodingPlanUsageSource {
  const normalizedLabel = label?.trim();
  return {
    id: providerId,
    providerId,
    accountAccess,
    label:
      normalizedLabel ||
      (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
        ? "Z.ai - Coding Plan"
        : "BigModel - Coding Plan"),
  };
}

type CurrentSidebarCodingPlanUsageSource =
  | {
      audience: "individual";
      providerId: SidebarUsageCodingPlanProviderId;
      sourceId: SidebarUsageCodingPlanSourceId;
      accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
      teamSource?: never;
    }
  | {
      audience: "team";
      // The original hard-bound bigmodelCodingPlan, the currentUsageSource of zai team plan
      // Unable to express zai providerId. Loose as SidebarUsageCodingPlanProviderId,
      // zai/bigmodel team are expressed according to the providerId parsed by their respective selectedKey.
      providerId: SidebarUsageCodingPlanProviderId;
      sourceId: SidebarUsageCodingPlanSourceId;
      teamSource: CodingPlanUsageSource;
    };

export function buildCodingPlanUsageSources({
  accountAccesses,
  subscribedTeamProducts,
}: {
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
}): CodingPlanUsageSource[] {
  return buildTeamCodingPlanUsageSources(subscribedTeamProducts, accountAccesses);
}

function buildTeamCodingPlanUsageSources(
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[],
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>,
): CodingPlanUsageSource[] {
  const seen = new Set<string>();
  return subscribedTeamProducts.flatMap((product) => {
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? null,
              organizationName: product.organizationName ?? null,
              projectId: product.projectId ?? null,
              projectName: product.projectName ?? null,
            },
          ];

    return projectContexts.flatMap((projectContext, index) => {
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectId = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectId) {
        return [];
      }
      const label = formatTeamUsageSourceLabel({
        product,
        organizationId,
        organizationName: projectContext.organizationName ?? product.organizationName,
        projectId,
        projectName: projectContext.projectName ?? product.projectName,
      });
      if (!label) {
        // Team Plan usage source only displays the organization name; if missing, a "BigModel - " blank source cannot be generated.
        return [];
      }
      const projectKey = projectId || String(index);
      // Original createBigModelTeamPlanConnectionKey + bigmodelCodingPlan providerId
      // Hard-coding bigmodel, the sourceId of zai team product uses the bigmodel prefix and providerId is also wrong.
      // Press product.family and use family-aware key + corresponding codingPlan providerId.
      const productFamily = resolveEnterpriseCodingPlanProductFamily(product);
      const baseAccess = accountAccesses[productFamily];
      if (baseAccess?.mode !== "team-coding-plan") {
        return [];
      }
      const codingPlanProviderId =
        getModelProviderFamilySpec(productFamily).teamCodingPlanProviderId;
      const sourceId = ["team", productFamily, product.productId, organizationId, projectKey]
        .map(encodeURIComponent)
        .join(":") as SidebarUsageCodingPlanSourceId;
      if (seen.has(sourceId)) {
        return [];
      }
      seen.add(sourceId);
      return [
        {
          id: sourceId,
          providerId: codingPlanProviderId,
          accountAccess: {
            type: "zhipu-account",
            family: productFamily,
            planKind: "team-coding-plan",
            productId: product.productId,
            organizationId,
            projectId,
          },
          label,
        },
      ];
    });
  });
}

export function resolveSidebarCurrentCodingPlanUsageSource({
  selections,
  selectedProviderId,
  accountAccesses,
  teamSources,
}: {
  selections?: ProviderFamilyConnectionSelectionSettings | null;
  selectedProviderId: string | null;
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>;
  teamSources: CodingPlanUsageSource[];
}): CurrentSidebarCodingPlanUsageSource | null {
  const family = selectedProviderId
    ? resolveModelProviderFamilySpecByProviderId(selectedProviderId)?.id
    : undefined;
  if (!family) return null;
  const selection = selections?.[family];
  if (selection?.kind === "team-coding-plan") {
    const teamSource = teamSources.find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.family === family &&
        source.accountAccess.productId === selection.productId &&
        source.accountAccess.organizationId === selection.organizationId &&
        source.accountAccess.projectId === selection.projectId,
    );
    return teamSource
      ? {
          audience: "team",
          providerId: teamSource.providerId,
          sourceId: teamSource.id,
          teamSource,
        }
      : null;
  }
  if (selection?.kind !== "individual-coding-plan") return null;
  const accountAccess = accountAccesses[family];
  if (!accountAccess || accountAccess.mode !== "individual-coding-plan") return null;
  const providerId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  return { audience: "individual", providerId, sourceId: providerId, accountAccess };
}

function formatTeamUsageSourceLabel({
  product,
  organizationId,
  organizationName,
  projectId,
  projectName,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
}): string | null {
  const teamPlanName = formatTeamPlanDisplayName({
    ...product,
    organizationId,
    organizationName,
    projectId,
    projectName,
  });
  if (!teamPlanName) {
    return null;
  }
  // The original hard-coded "BigModel - " prefix, zai team source shows that the brand is also misplaced.
  // Take the brand prefix by product.family and align it with codingPlanItem.providerName.
  const brandPrefix = `${getModelProviderFamilySpec(resolveEnterpriseCodingPlanProductFamily(product)).label} - `;
  return `${brandPrefix}${teamPlanName}`;
}
