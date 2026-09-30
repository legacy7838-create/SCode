import type { ArmsCustomEventPayload, IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";

// Composer sends the ARMS outlet of the funnel buried point.
// This group of events only goes to ARMS, not /event/report; the reporter is installed by Root.tsx according to isDesktop.
// Web/Mobile remote control cannot get the reporter, and the entire group is silent.

const SEND_FUNNEL_ARMS_GROUP = "send_funnel";

const SEND_FUNNEL_EVENT_INPUT_FOCUS = "send_input_focus";
const SEND_FUNNEL_EVENT_SEND_CLICK = "send_click";
const SEND_FUNNEL_EVENT_SEND_RESULT = "send_result";

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

/** Reason code for how a send settled. */
export type SendFunnelReasonCode =
  | "attachment_not_ready"
  | "blocked"
  | "rejected"
  | "stale"
  | "failed"
  | "render_timeout"
  | "transport_error"
  | "provider_not_ready"
  | "composer_error";

let armsReporter: ArmsReporter | null = null;

export function setSendFunnelArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

// Reason: ARMS is an observation link, and the main sending link must not be interrupted due to point burying failure.
function emit(payload: ArmsCustomEventPayload): void {
  if (!armsReporter) {
    return;
  }
  try {
    void Promise.resolve(armsReporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[send-funnel] ARMS report failed", { name: payload.name, error });
    });
  } catch (error) {
    logger.warn("[send-funnel] ARMS report threw", { name: payload.name, error });
  }
}

/**
 * Session state / draft state, used to tell the "sent inside an existing session" and "first send
 * of a new task" funnels apart.
 */
function composerScopeOf(sessionId: string | null | undefined): "session" | "draft" {
  return sessionId ? "session" : "draft";
}

/**
 * An empty sessionId / commandId does not report the corresponding property, so no empty-string
 * dimension shows up on the ARMS side.
 */
function optionalId(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

/**
 * Clicking the input box (only genuine user focus; programmatic autofocus is intercepted on the
 * composer side).
 */
export function reportSendFunnelInputFocus(params: {
  sessionId: string | null;
  focusTime: number;
}): void {
  emit({
    name: SEND_FUNNEL_EVENT_INPUT_FOCUS,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: 1,
    properties: {
      focus_time: params.focusTime,
      composer_scope: composerScopeOf(params.sessionId),
      talk_id: optionalId(params.sessionId),
    },
  });
}

/** Clicking send / pressing Enter submits and passes the send gate. */
export function reportSendFunnelSendClick(params: {
  sessionId: string | null;
  sendClickId: string;
  sendTime: number;
  trigger: "button" | "shortcut";
  extraDetail: Record<string, string>;
}): void {
  emit({
    name: SEND_FUNNEL_EVENT_SEND_CLICK,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: 1,
    properties: {
      ...params.extraDetail,
      send_click_id: params.sendClickId,
      input_send_time: params.sendTime,
      send_trigger: params.trigger,
      composer_scope: composerScopeOf(params.sessionId),
      talk_id: optionalId(params.sessionId),
    },
  });
}

/**
 * A send settling (shared by success and failure). The value is send_cost_ms, so ARMS can compute
 * avg/p50/p95/p99 for this event directly and slice it by status / reason_code.
 *
 * costMs is the **end-to-end** duration: clicking send → the user message appearing in the
 * conversation history. ackCostMs separately isolates the "clicking send → receiving the ACK"
 * segment; the difference between the two is the "return trip + rendering" duration.
 */
export function reportSendFunnelSendResult(params: {
  sessionId: string | null;
  commandId?: string;
  sendClickId: string;
  status: "success" | "fail";
  ackStatus?: string;
  reasonCode?: SendFunnelReasonCode;
  costMs: number;
  ackCostMs?: number;
  queueConfirmed: boolean;
  extraDetail: Record<string, string>;
}): void {
  const costMs = Math.max(0, Math.round(params.costMs));
  const ackCostMs =
    params.ackCostMs === undefined ? undefined : Math.max(0, Math.round(params.ackCostMs));
  emit({
    name: SEND_FUNNEL_EVENT_SEND_RESULT,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: costMs,
    properties: {
      ...params.extraDetail,
      send_click_id: params.sendClickId,
      status: params.status,
      reason_code: params.reasonCode,
      ack_status: params.ackStatus,
      send_cost_ms: costMs,
      ack_cost_ms: ackCostMs,
      send_queue_confirmed: params.queueConfirmed,
      talk_id: optionalId(params.sessionId),
      message_id: optionalId(params.commandId),
    },
  });
}
