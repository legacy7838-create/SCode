type AccountProviderCredentialScope = {
  readonly providerId: string;
  readonly accountIdentity: string;
} & (
  | { readonly planKind: "start-plan" | "individual-coding-plan" }
  | {
      readonly planKind: "team-coding-plan";
      readonly productId: string;
      readonly organizationId: string;
      readonly projectId: string;
    }
);

/**
 * The private physical key in the Credential Store.
 *
 * The legacy account identifier doubled as both the Config identity and the credential cache key,
 * which let the account identity spread into Provider, Protocol and UI. The physical key now lives
 * only at the Services credential boundary that owns the account identity.
 */
export function accountProviderCredentialKey(input: AccountProviderCredentialScope): string {
  const providerId = required(input.providerId, "Provider ID");
  const accountIdentity = required(input.accountIdentity, "Account Identity");
  const scope =
    input.planKind === "team-coding-plan"
      ? [
          "team",
          providerId,
          required(input.productId, "Team Product ID"),
          required(input.organizationId, "Team Organization ID"),
          required(input.projectId, "Team Project ID"),
        ]
          .map(encodeURIComponent)
          .join(":")
      : `${input.planKind === "start-plan" ? "start-plan" : "coding-plan"}:${providerId}`;
  return `account-provider:${scope}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Account Provider is missing ${label}`);
  return normalized;
}
