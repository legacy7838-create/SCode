import {
  resolveTelemetryModelId,
  resolveTelemetryProviderScope,
  sanitizeTelemetryModelValue,
  type ArmsCustomEventPayload,
  type IPlatformService,
  type ZCodeTaskNetworkDebugStatus,
} from "@zcode/shared";
import { logger } from "@/logger.js";

const PLAN_USAGE_ARMS_GROUP = "plan_usage";
const PLAN_USAGE_ARMS_EVENT_REQUEST = "plan_request";
const PLAN_USAGE_ARMS_EVENT_TTFT = "plan_ttft";

type PlanUsageRequestStatus =
  | "accepted"
  | "queued"
  | "started"
  | "completed"
  | "failed"
  | "retry_scheduled"
  | "stream_stalled";

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

const reportedModelRequestEventKeys = new Set<string>();
const MAX_REPORTED_MODEL_REQUEST_EVENT_KEYS = 2_000;

function rememberModelRequestEventKey(eventKey: string): boolean {
  if (reportedModelRequestEventKeys.has(eventKey)) {
    return false;
  }
  reportedModelRequestEventKeys.add(eventKey);
  if (reportedModelRequestEventKeys.size > MAX_REPORTED_MODEL_REQUEST_EVENT_KEYS) {
    const oldest = reportedModelRequestEventKeys.values().next().value;
    if (typeof oldest === "string") {
      reportedModelRequestEventKeys.delete(oldest);
    }
  }
  return true;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}

function networkRequestStatus(
  statusType: ZCodeTaskNetworkDebugStatus["statusType"],
): PlanUsageRequestStatus {
  switch (statusType) {
    case "model_request_started":
      return "started";
    case "model_request_completed":
      return "completed";
    case "model_request_failed":
      return "failed";
    case "model_retry_scheduled":
      return "retry_scheduled";
    case "model_stream_stalled":
      return "stream_stalled";
  }
}

function omitUndefinedProperties(
  properties: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const compact: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) {
      compact[key] = value;
    }
  }
  return compact;
}

/** The existing backend when the real state does not have a provider id; must be distinguished from the "custom provider normalization value". */
const PLAN_USAGE_PROVIDER_ID_UNKNOWN = "unknown";

/**
 * Reported projection of provider/model.
 *
 * The id and model name of the custom provider are named by the user. Reporting them as they are will leak the private name and create a high cardinality, so it is inconsistent with
 * `chat_error_banner` shares the same whitelist: the built-in provider retains stable IDs, and the rest are normalized to `custom`.
 * Only the reported value is overwritten - whether the event is sent is still determined by the original `providerId` gate at the calling point, and the local log also retains the original value.
 *
 * `unknown` cannot be merged into `custom`: it expresses "the protocol event does not have a provider" and is part of the existing counting caliber.
 * The model name under this branch is determined according to its own whitelist, which not only retains the available dimensions, but also does not transparently transmit the custom model name.
 */
function providerTelemetryProjection(
  providerId: string,
  modelName: string | undefined,
): { provider_id: string; provider_scope: string; model_name: string | undefined } {
  if (providerId === PLAN_USAGE_PROVIDER_ID_UNKNOWN) {
    return {
      provider_id: PLAN_USAGE_PROVIDER_ID_UNKNOWN,
      provider_scope: PLAN_USAGE_PROVIDER_ID_UNKNOWN,
      model_name: sanitizeTelemetryModelValue(modelName) || undefined,
    };
  }
  const provider = resolveTelemetryProviderScope(providerId);
  const modelId = resolveTelemetryModelId(provider.providerScope, modelName);
  return {
    provider_id: provider.providerId,
    provider_scope: provider.providerScope,
    model_name: modelId || undefined,
  };
}

export function reportPlanUsageModelRequestStartedToArms(
  reporter: ArmsReporter | null | undefined,
  event: ZCodeTaskNetworkDebugStatus,
): void {
  if (!reporter) {
    return;
  }
  if (!rememberModelRequestEventKey(event.eventKey)) {
    return;
  }

  const providerId = event.providerId?.trim() || "unknown";
  const status = networkRequestStatus(event.statusType);
  const durationMs = nonNegativeInteger(event.durationMs);
  const payload: ArmsCustomEventPayload = {
    name: PLAN_USAGE_ARMS_EVENT_REQUEST,
    group: PLAN_USAGE_ARMS_GROUP,
    value: durationMs ?? 1,
    properties: omitUndefinedProperties({
      ask_mode: event.querySource?.trim() || undefined,
      ...providerTelemetryProjection(providerId, event.modelId?.trim()),
      request_status: status,
      request_id: event.requestId,
      task_id: event.taskId,
      input_id: event.inputId,
      query_id: event.queryId,
      event_key: event.eventKey,
      attempt: positiveInteger(event.attempt),
      next_attempt: positiveInteger(event.nextAttempt),
      max_attempts: positiveInteger(event.maxAttempts),
      status_code: nonNegativeInteger(event.statusCode),
      duration_ms: durationMs,
      delay_ms: nonNegativeInteger(event.delayMs),
      idle_ms: nonNegativeInteger(event.idleMs),
      timeout_ms: nonNegativeInteger(event.timeoutMs),
      retryable: event.retryable,
      reason: event.reason?.trim() || undefined,
      transport: event.transport?.trim() || undefined,
      provider_kind: event.providerKind?.trim() || undefined,
    }),
  };

  try {
    void Promise.resolve(reporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[plan-usage] ARMS report failed", {
        providerId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[plan-usage] ARMS report threw", {
      providerId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function reportPlanUsageTtftToArms(
  reporter: ArmsReporter | null | undefined,
  params: {
    providerId?: string | null;
    modelName?: string | null;
    askMode?: string | null;
    ttftMs: number;
  },
): void {
  if (!reporter || !Number.isFinite(params.ttftMs) || params.ttftMs < 0) {
    return;
  }

  const providerId = params.providerId?.trim();
  if (!providerId) {
    return;
  }

  const ttftMs = Math.max(0, Math.round(params.ttftMs));
  const payload: ArmsCustomEventPayload = {
    name: PLAN_USAGE_ARMS_EVENT_TTFT,
    group: PLAN_USAGE_ARMS_GROUP,
    value: ttftMs,
    properties: {
      ask_mode: params.askMode?.trim() || undefined,
      ...providerTelemetryProjection(providerId, params.modelName?.trim()),
      ttft_ms: ttftMs,
    },
  };

  try {
    void Promise.resolve(reporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[plan-usage] ARMS TTFT report failed", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[plan-usage] ARMS TTFT report threw", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
