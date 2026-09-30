import {
  BIGMODEL_PROVIDER_ID,
  buildBigModelApiUrl,
  buildBigModelCodingPlanPersonalManageUrl,
  BUILTIN_MODEL_PROVIDER_IDS,
  createUuid,
  type OAuthProviderId,
  ZCODE_ENV,
  ZAI_PROVIDER_ID,
  type BuiltinModelProviderId,
  type UsageQuotaLimit,
  type UsageEntitlementSubscriptionDetail,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";

export function generateId(): string {
  return createUuid();
}

export const PRESET_SUBSCRIPTION_TIMEOUT_MS = 2 * 60 * 1000;
export const BIGMODEL_REGISTRATION_URL = buildBigModelApiUrl({ ZCODE_ENV }, "/login");
const BIGMODEL_CODING_PLAN_PERSONAL_MANAGE_URL = buildBigModelCodingPlanPersonalManageUrl({
  ZCODE_ENV,
});

export interface PresetProviderSpec {
  id: BuiltinModelProviderId;
  displayName: string;
  oauthProviderId?: OAuthProviderId;
}

export const PRESET_PROVIDER_SPECS: PresetProviderSpec[] = [
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    displayName: "Z.ai",
    oauthProviderId: ZAI_PROVIDER_ID,
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    displayName: "BigModel",
    oauthProviderId: BIGMODEL_PROVIDER_ID,
  },
];

export const PRESET_PROVIDER_SPEC_BY_ID = new Map<BuiltinModelProviderId, PresetProviderSpec>(
  PRESET_PROVIDER_SPECS.map((item) => [item.id, item]),
);

export type CodingPlanProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;

export type CodingPlanStatus =
  | "disconnected"
  | "checking"
  | "notPurchased"
  | "purchased"
  | "unavailable"
  | "unsupported";

export type TeamPlanAvailabilityReason = "not-allocated" | "expired" | "credential-unavailable";

interface CodingPlanProviderSpec {
  id: CodingPlanProviderId;
  oauthProviderId: OAuthProviderId;
  label: string;
  providerName: string;
  purchaseUrl?: string;
}

export const CODING_PLAN_PROVIDER_SPECS: CodingPlanProviderSpec[] = [
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    oauthProviderId: ZAI_PROVIDER_ID,
    label: "Z.ai - Coding Plan",
    providerName: "Z.ai",
    purchaseUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    oauthProviderId: ZAI_PROVIDER_ID,
    label: "Z.ai - Coding Plan",
    providerName: "Z.ai",
    purchaseUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    label: "BigModel - Coding Plan",
    providerName: "BigModel",
    purchaseUrl: BIGMODEL_CODING_PLAN_PERSONAL_MANAGE_URL,
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    label: "BigModel- Coding Plan",
    providerName: "BigModel",
    purchaseUrl: BIGMODEL_CODING_PLAN_PERSONAL_MANAGE_URL,
  },
];

export interface CodingPlanEntitlementState {
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

export function resolveModelProviderDisplayName(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "config">,
): string {
  if (
    provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  ) {
    return "Z.ai - Coding Plan";
  }

  if (provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
    return "Start Plan";
  }

  if (provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan) {
    return "Start Plan";
  }

  return getProviderFormLabel(provider);
}

export type ModelProviderNavItem =
  | {
      key: string;
      type: "preset";
      /** The brand portal icon is independent of its historical Start navigation identity. */
      logo?: ProviderSettingsFormProvider["config"]["logo"];
      /** The account group dots only display the public execution results of the current specific connection. */
      statusProvider?: ProviderSettingsFormProvider | null;
      presetId: BuiltinModelProviderId;
      label: string;
      provider: ProviderSettingsFormProvider | null;
      displayName: string;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "codingPlan";
      presetId: CodingPlanProviderId;
      oauthProviderId: OAuthProviderId;
      label: string;
      providerName: string;
      provider: ProviderSettingsFormProvider | null;
      /** Account Overlay Whether this Provider is enabled. */
      accountEntitled?: boolean;
      status: CodingPlanStatus;
      planLevel?: string | null;
      currentProductId?: string | null;
      subscriptionBillingCycle?: string | null;
      subscriptionRenewTime?: string | null;
      subscriptionExpireTime?: string | null;
      subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
      quotaLimits?: UsageQuotaLimit[];
      /** Official Server MCP quota (total quota issued by the server). Not in quota.limits[], it is transmitted to the quota card separately. */
      mcpQuotaLimit?: UsageQuotaLimit | null;
      purchaseUrl?: string;
      /** Equity inquiry clearly requires re-login; the copywriter does not participate in the operation branch determination. */
      accountLoginRequired?: boolean;
      statusLabelId?: string;
      statusMessage?: string | null;
      inactivePlanTitle?: string | null;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "teamPlan";
      presetId: CodingPlanProviderId;
      oauthProviderId: OAuthProviderId;
      label: string;
      providerName: string;
      teamPlanName: string;
      organizationId?: string | null;
      projectId?: string | null;
      provider: ProviderSettingsFormProvider | null;
      /** Account Overlay Whether this Provider is enabled. */
      accountEntitled?: boolean;
      status: CodingPlanStatus;
      planLevel?: string | null;
      currentProductId?: string | null;
      subscriptionBillingCycle?: string | null;
      subscriptionRenewTime?: string | null;
      subscriptionExpireTime?: string | null;
      subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
      quotaLimits?: UsageQuotaLimit[];
      /** Official Server MCP quota (total quota issued by the server). Not in quota.limits[], it is transmitted to the quota card separately. */
      mcpQuotaLimit?: UsageQuotaLimit | null;
      purchaseUrl?: string;
      statusLabelId?: string;
      statusMessage?: string | null;
      /** Business reason for Team status. Interactions can no longer be deduced from i18n copy. */
      availabilityReason?: TeamPlanAvailabilityReason;
      inactivePlanTitle?: string | null;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "codingPlanLoading";
      label: string;
      providerName: string;
      oauthProviderId?: OAuthProviderId;
    }
  | {
      key: string;
      type: "custom";
      label: string;
      provider: ProviderSettingsFormProvider;
      statusActive: boolean;
    };

export type ModelProviderNavGroupId = "preset" | "custom";

export interface ModelProviderNavGroup {
  id: ModelProviderNavGroupId;
  title: string;
  items: ModelProviderNavItem[];
}
