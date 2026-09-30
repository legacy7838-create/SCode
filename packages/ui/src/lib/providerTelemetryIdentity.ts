import { decodeCustomModelValue, encodeCustomModelValue } from "@zcode/shared";

// Provider reconstruction splits the execution identity, but old reports are still based on the original bucket statistics; it is only used in event construction, and reflow of business configuration is prohibited.
// Team connections from old staging 790884b1ce also use builtin:* original Coding Plan identities.
const legacyProviderIds: Readonly<Record<string, string>> = Object.freeze({
  "zai-api": "builtin:zai",
  "bigmodel-api": "builtin:bigmodel",
  "account:zai-individual-coding-plan": "builtin:zai-coding-plan",
  "account:zai-team-coding-plan": "builtin:zai-coding-plan",
  "account:bigmodel-individual-coding-plan": "builtin:bigmodel-coding-plan",
  "account:bigmodel-team-coding-plan": "builtin:bigmodel-coding-plan",
  "account:zai-start-plan": "builtin:zai-start-plan",
  "account:bigmodel-start-plan": "builtin:bigmodel-start-plan",
  "account:zai-offpeak-idle-plan": "offpeak-idle-plan",
  "account:bigmodel-offpeak-idle-plan": "offpeak-idle-plan",
});

export function legacyTelemetryProviderId(providerId: string): string {
  return Object.hasOwn(legacyProviderIds, providerId) ? legacyProviderIds[providerId]! : providerId;
}

/**
 * Only known Provider prefixes are replaced; plain model IDs, unknown identities and in-model
 * encodings are left as-is.
 */
export function legacyTelemetryModelValue(value: string): string {
  const custom = decodeCustomModelValue(value);
  if (custom) {
    const providerId = legacyTelemetryProviderId(custom.providerId);
    return providerId === custom.providerId
      ? value
      : encodeCustomModelValue(providerId, custom.modelName);
  }
  const slash = value.indexOf("/");
  if (slash < 1) return value;
  const providerId = value.slice(0, slash);
  return legacyTelemetryProviderId(providerId) + value.slice(slash);
}

/**
 * Conversation events are projected only after attribution completes, leaving the original
 * request/child/seed facts untouched.
 */
export function legacyTelemetryModelFields(detail: Record<string, string>): Record<string, string> {
  return {
    ...detail,
    ...(detail.model_provider !== undefined
      ? { model_provider: legacyTelemetryProviderId(detail.model_provider) }
      : {}),
    ...(detail.model_name !== undefined
      ? { model_name: legacyTelemetryModelValue(detail.model_name) }
      : {}),
  };
}
