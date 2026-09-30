import { isApiKeyAccess } from "@zcode/provider";
import type {
  ConfigValidationIssue,
  AccountProviderState,
  ModelConfigObject,
  ProviderConfigObject,
  ProviderSettingsProviderView,
} from "@zcode/provider";

/** The Provider state the settings page uses within one editing session. */
export interface ProviderSettingsFormProvider extends Pick<
  ProviderSettingsProviderView,
  "providerName" | "templateId"
> {
  providerId: string;
  /**
   * A patch that renames only when explicitly done in this session; other edits must not
   * materialize the inherited name into a personal config.
   */
  providerNameUpdate?: string | null;
  /**
   * An outer patch for enable/disable toggled only explicitly in this session; ordinary field edits
   * do not copy the inherited enable state.
   */
  enabledUpdate?: boolean;
  enabled: boolean;
  /** The state the registry derives from the current Official, Personal, and Account Facts. */
  executable: boolean;
  accountState?: AccountProviderState;
  issues?: readonly ConfigValidationIssue[];
  hasPersonalConfig: boolean;
  /** The renderer only mutates and submits this single sparse Personal Overlay. */
  personalConfig: ProviderConfigObject;
  /**
   * The read-only inherited baseline and the immediate form display values; not persisted directly.
   */
  config: ProviderConfigObject;
  models: ProviderSettingsFormModel[];
}

/** The Model state the settings page uses within one editing session. */
export interface ProviderSettingsFormModel {
  kind: "candidate";
  modelId: string;
  builtin: boolean;
  /**
   * The resolved Built-in Rule before the Personal Rule is layered on, used by the editor to
   * express inheritance and sparse overrides.
   */
  inheritedConfig?: ModelConfigObject;
  personalConfig: ModelConfigObject;
  /**
   * Absent or true means following the Built-in recommended config; false means pinning the
   * personal config.
   */
  useRecommendedConfig?: boolean;
  config: ModelConfigObject;
  hasPersonalConfig: boolean;
  executable: boolean;
  selectable: boolean;
  issues?: readonly ConfigValidationIssue[];
}

export function getProviderFormLabel(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "providerName">,
): string {
  return provider.providerName?.trim() || provider.providerId;
}

export function getProviderFormApiKey(
  provider: Pick<ProviderSettingsFormProvider, "config">,
): string {
  return isApiKeyAccess(provider.config.access) ? (provider.config.access.apiKey ?? "") : "";
}

export function getProviderFormApiKeyManagementUrl(
  provider: Pick<ProviderSettingsFormProvider, "config">,
): string | undefined {
  return isApiKeyAccess(provider.config.access)
    ? (provider.config.access.apiKeyManagementUrl ?? undefined)
    : undefined;
}
