import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  ZAI_PROVIDER_ID,
  collectTelemetryRendererContext,
  isZaiCodingPlanProviderId,
  sanitizeTelemetryEventDetail,
  type BuiltinModelProviderId,
  type IPlatformService,
} from "@zcode/shared";
import { logger } from "@/logger.js";

export function resolveProviderTelemetryLabel(providerId: string): string {
  if (providerId === ZAI_PROVIDER_ID || isZaiCodingPlanProviderId(providerId)) {
    return "z.ai";
  }

  if (
    providerId === BIGMODEL_PROVIDER_ID ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  ) {
    return "bigmodel";
  }

  return providerId;
}

export function resolvePresetModelProviderTelemetryLabel(presetId: BuiltinModelProviderId): string {
  return resolveProviderTelemetryLabel(presetId);
}

type ReportTelemetryPlatform = Pick<IPlatformService, "reportTelemetryEvent">;

export async function reportAppTelemetryEvent(
  platform: ReportTelemetryPlatform,
  payload: {
    elementName: string;
    eventRegion: string;
    eventType: string;
    eventText?: string;
    eventExtraDetail: Record<string, string>;
    userId?: string;
    talkId?: string;
    messageId?: string;
  },
  scope: string,
): Promise<void> {
  try {
    const reportPayload = {
      context: collectTelemetryRendererContext(),
      ...payload,
      eventExtraDetail: sanitizeTelemetryEventDetail(payload.elementName, payload.eventExtraDetail),
    };

    // Why this fix: sanitizing only in Core would let the original pass through IPC/local logs first; here only the sanitized copy is recorded.
    // The step is the same scale as the message, debug output uses debug level and leaves no on-disk info copy.
    if (payload.elementName === "message_completion" || payload.elementName === "agent_step") {
      logger.debug(`[${scope}] ${payload.elementName} payload:`, reportPayload);
    }

    await platform.reportTelemetryEvent(reportPayload);
  } catch {
    // Ultimate failures are recorded as redacted warnings by TelemetryCore in Desktop Main; the UI only keeps business isolation,
    // avoiding duplicate records of the same failure or raw IPC errors reaching production logs.
  }
}
