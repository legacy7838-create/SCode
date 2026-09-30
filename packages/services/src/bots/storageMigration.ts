import {
  decodeCustomModelValue,
  migrateLegacyModelProviderId,
  migrateLegacyOfficialGlmModelId,
  modelSelectionSchema,
  ZCODE_AGENT_PROVIDER,
  type ModelSelection,
} from "@zcode/shared";
import { normalizeBotCurrentOptions, normalizeBotDraftOptions } from "./config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only called if the v3 file does not exist; not a compatible reader for the current Bot Options. */
function migrateSelection(options: Record<string, unknown>): ModelSelection | undefined {
  if (Object.hasOwn(options, "modelSelection")) {
    // Bug root cause: the old thoughtLevel has overwritten the saved new level; reading back the old field is prohibited when the new field exists.
    const parsed = modelSelectionSchema.safeParse(options.modelSelection);
    if (!parsed.success) return undefined;
    const selection = parsed.data;
    if (!selection.providerId.startsWith("builtin:")) return selection;
    const providerId = migrateLegacyModelProviderId(selection.providerId);
    return providerId
      ? {
          ...selection,
          providerId,
          modelId: migrateLegacyOfficialGlmModelId(selection.providerId, selection.modelId),
        }
      : undefined;
  }
  const value = typeof options.model === "string" ? options.model.trim() : "";
  const custom = decodeCustomModelValue(value);
  const separator = value.indexOf("/");
  const oldProviderId =
    custom?.providerId ?? (separator > 0 ? value.slice(0, separator) : undefined);
  const modelId = custom?.modelName ?? (separator > 0 ? value.slice(separator + 1) : undefined);
  if (!oldProviderId || !modelId) return undefined;
  const providerId = migrateLegacyModelProviderId(oldProviderId);
  // Only explicit identities are accepted, no more unique matching of other providers by model name, and no interpretation of naked model names as Agent Providers.
  // Bug root cause: When the candidate was empty, the clear old selection was permanently written to v3; migration only moved the intention and could not check the current availability.
  if (!providerId) return undefined;
  const reasoningLevel =
    typeof options.thoughtLevel === "string" ? options.thoughtLevel.trim() : "";
  return {
    providerId,
    modelId: migrateLegacyOfficialGlmModelId(oldProviderId, modelId),
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

export function importLegacyBotConfig(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.bots)) return value;
  return {
    ...value,
    version: 3,
    bots: value.bots.map((bot) => {
      if (!isRecord(bot)) return bot;
      const options = isRecord(bot.currentOptions) ? bot.currentOptions : {};
      return {
        ...bot,
        currentOptions: normalizeBotCurrentOptions({
          ...options,
          modelSelection: migrateSelection(options),
        }),
      };
    }),
  };
}

export function importLegacyBotState(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.bots)) return value;
  const bots = Object.entries(value.bots).map(([id, state]) => {
    if (!isRecord(state) || !isRecord(state.draftOptions)) return [id, state];
    const options = state.draftOptions;
    return [
      id,
      {
        ...state,
        draftOptions: normalizeBotDraftOptions({
          provider: ZCODE_AGENT_PROVIDER,
          modelSelection: migrateSelection(options),
          ...(typeof options.mode === "string" ? { mode: options.mode } : {}),
        }),
      },
    ];
  });
  return { ...value, version: 3, bots: Object.fromEntries(bots) };
}
