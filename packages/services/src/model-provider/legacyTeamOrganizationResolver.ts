import {
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  type ApiClient,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import type { LegacyTeamConnection } from "#src/setting/legacyAccountConnectionSettings.js";
import type {
  RemoteCustomerInfo,
  RemoteEnvelope,
} from "#src/model-provider/accountProviderApiTypes.js";

/** Legacy-connection import only: reads OAuth user info, depends on no current Provider and requests no team key. Delete once the legacy version is retired. */
export function createLegacyTeamOrganizationResolver(dependencies: {
  apiClient: ApiClient;
  loadOAuthTokenSet: (
    family: ProviderFamilyDomain,
  ) => Promise<{ accessToken: string; zcodeJwtToken?: string | null } | null>;
}): (connection: LegacyTeamConnection) => Promise<string | null> {
  return async ({ family, projectId }) => {
    const tokens = await dependencies.loadOAuthTokenSet(family);
    const token = tokens?.accessToken.trim();
    if (!token || (family === "bigmodel" && token === tokens?.zcodeJwtToken)) return null;
    const origin =
      family === "zai"
        ? resolveZaiBusinessBaseUrl(process.env)
        : resolveBigModelApiOrigin(process.env);
    const response = await dependencies.apiClient.request(
      `${origin}/api/biz/customer/getCustomerInfo`,
      {
        method: "GET",
        timeoutMs: 15_000,
        // Both business domains use raw OAuth tokens; you cannot add Bearers or use model API keys.
        headers: { Authorization: token, "Content-Type": "application/json" },
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as RemoteEnvelope<RemoteCustomerInfo>;
    if (payload.code !== undefined && payload.code !== 0 && payload.code !== 200) return null;
    // Account switching makes the old query lose its authority and prevents organizations from being written to the new account even if the project ID happens to be the same.
    if ((await dependencies.loadOAuthTokenSet(family))?.accessToken.trim() !== token) return null;
    const organizations = new Set(
      (payload.data?.organizations ?? [])
        .filter((org) => org.projects?.some((project) => project.projectId?.trim() === projectId))
        .map((org) => org.organizationId?.trim())
        .filter((id): id is string => Boolean(id)),
    );
    return organizations.size === 1 ? [...organizations][0]! : null;
  };
}
