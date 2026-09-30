import {
  BUILTIN_MODEL_PROVIDER_IDS,
  BUILTIN_PROVIDER_TEMPLATE_IDS,
} from "./model-provider-types.js";
import { normalizeOfficialGlmModelId } from "./official-glm-model-id.js";

// The site to which the Provider belongs cannot be guessed based on the name of the user-defined Provider; the binding identity of the Ticket cannot be changed at leisure.
export function migrateLegacyOfficialGlmModelId(providerId: string, modelId: string): string {
  return /^(?:builtin:(?:zai|bigmodel)(?:-start-plan|-coding-plan)?|account:(?:zai|bigmodel)-(?:start-plan|individual-coding-plan|team-coding-plan))$/.test(
    providerId,
  )
    ? normalizeOfficialGlmModelId(modelId)
    : modelId;
}

/**
 * For one-way upgrades of already-published legacy data only; not a runtime Provider alias or selection fallback.
 * Interpreting legacy Coding Plan against the current account would lose the original intent on offline/SSH migration.
 * The same-domain Individual is merely a deterministic migration landing point; the current-account correspondence is left to valid-selection resolution and must not be used to bind execution.
 * Migration does not check whether the model/tier is available; an ordinary unknown ID is not evidence of the legacy format.
 */
export function migrateLegacyModelProviderId(providerId: string): string | undefined {
  switch (providerId) {
    case "builtin:bigmodel":
      return BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel;
    case "builtin:zai":
      return BUILTIN_PROVIDER_TEMPLATE_IDS.zai;
    case "builtin:bigmodel-start-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
    case "builtin:zai-start-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan;
    case "builtin:bigmodel-coding-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    case "builtin:zai-coding-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    default:
      return providerId.startsWith("builtin:") ? undefined : providerId;
  }
}
