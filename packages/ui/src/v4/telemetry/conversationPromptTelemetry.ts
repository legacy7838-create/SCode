import { ZCODE_AGENT_PROVIDER, type PlanIdentitySnapshot, type ZCodeProvider } from "@zcode/shared";
import { buildPromptTelemetryExtraDetail } from "@/lib/messageTelemetry.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import {
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "@/lib/providerTelemetryIdentity.js";

function resolveLegacyConversationModelValue(params: {
  configProvider?: string | null;
  modelName?: string | null;
}): string | null | undefined {
  const configProvider = params.configProvider?.trim();
  const modelName = params.modelName?.trim();
  if (!configProvider || !modelName || configProvider === ZCODE_AGENT_PROVIDER) {
    return params.modelName;
  }
  // Reason for repair: V4 config separates provider/model and saves it. If you report the model directly, the old UI will be lost.
  // `custom:<provider>:<model>` dimension causes the same model to fall into two sets of data bins in the old and new versions.
  return encodeCustomModelValue(legacyTelemetryProviderId(configProvider), modelName);
}

export function resolveLegacyRuntimeModelValue(params: {
  configProvider?: string | null;
  modelName?: string | null;
}): string | null | undefined {
  const configProvider = params.configProvider?.trim();
  const modelName = params.modelName?.trim();
  if (!configProvider || !modelName || configProvider === ZCODE_AGENT_PROVIDER) {
    return params.modelName;
  }
  if (modelName.startsWith(`${configProvider}/`)) return legacyTelemetryModelValue(modelName);
  return `${legacyTelemetryProviderId(configProvider)}/${modelName}`;
}

/** V4 config.provider is the actual model provider id; agentProvider denotes the ZCode runtime. */
export function buildV4ConversationPromptTelemetryExtraDetail(params: {
  agentProvider?: ZCodeProvider;
  configProvider?: string | null;
  modelName?: string | null;
  askMode?: string | null;
  providerBaseURL?: string | null;
  planIdentitySnapshot?: PlanIdentitySnapshot | null;
}): Record<string, string> {
  const agentProvider = params.agentProvider ?? ZCODE_AGENT_PROVIDER;
  const base = buildPromptTelemetryExtraDetail({
    askMode: params.askMode,
    modelName: resolveLegacyConversationModelValue(params),
    provider: agentProvider,
    providerBaseURL: params.providerBaseURL,
    planIdentitySnapshot: params.planIdentitySnapshot,
  });
  return {
    ...base,
    message_source: "chat",
    task_trigger: "",
    model_provider: legacyTelemetryProviderId(
      params.configProvider?.trim() || base.model_provider || "",
    ),
    // agent represents the ZCode runtime and cannot be replaced by the model provider id.
    agent: agentProvider,
  };
}
