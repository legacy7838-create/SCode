import {
  redactTelemetryText,
  type ArmsCustomEventPayload,
  type IPlatformService,
} from "@zcode/shared";
import { logger } from "@/logger.js";

/** ARMS custom event name: render-layer exceptions caught by a React error boundary */
const REACT_ERROR_ARMS_EVENT_NAME = "perf_react_error";
/** ARMS business group */
const REACT_ERROR_ARMS_GROUP = "react_error";

/**
 * Truncation limit for stack / componentStack. Why: React component stacks and error stacks can be
 * very long, and ARMS truncates or rejects over-long single fields, so truncating proactively to
 * this limit guarantees that the important head (the component that threw most recently) always
 * gets through.
 */
const REACT_ERROR_STACK_MAX_LEN = 4000;

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

let armsReporter: ArmsReporter | null = null;

/**
 * Inject the ARMS reporter.
 *
 * Note: it must be injected before createRoot in the renderer entry and cannot rely on Root's
 * effect. Because the root-level AppErrorBoundary exists precisely to catch render crashes of Root
 * itself — if the reporter were injected through a Root effect, then when Root crashes on its very
 * first frame the effect never runs and the root-level error is still lost.
 */
export function setReactErrorArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

/**
 * The reported copy must be redacted first: on desktop the render-layer stack and componentStack
 * carry `file:///Users/<username>/...` paths, and error.message may also carry workspace paths or
 * user content. It shares `redactTelemetryText` with the exception events ARMS collects
 * automatically; local logging and the fallback recovery keep using the original values. Truncation
 * still keeps the 4000 limit, guaranteeing that the component that threw most recently always gets
 * through.
 */
function redactStack(value: string): string {
  return redactTelemetryText(value, { maxLength: REACT_ERROR_STACK_MAX_LEN });
}

function buildReactErrorArmsPayload(params: {
  error: Error;
  componentStack: string;
  scope?: string;
}): ArmsCustomEventPayload {
  const errorStack = params.error.stack ? redactStack(params.error.stack) : undefined;
  const componentStack = params.componentStack ? redactStack(params.componentStack) : undefined;
  return {
    name: REACT_ERROR_ARMS_EVENT_NAME,
    group: REACT_ERROR_ARMS_GROUP,
    value: 1,
    properties: {
      error_name: params.error.name,
      error_message: redactTelemetryText(params.error.message),
      error_stack: errorStack || undefined,
      component_stack: componentStack || undefined,
      // The root-level boundary has no scope and is uniformly recorded as app; the scoped boundary uses its own scope to distinguish sidebar/chat/settings, etc.
      boundary_scope: params.scope ?? "app",
    },
  };
}

/**
 * Report the exceptions caught by React error boundaries to ARMS RUM.
 *
 * Background: a React error boundary intercepts render exceptions of its subtree and stops them
 * from bubbling to window.onerror, while the Browser RUM SDK collects automatically via
 * window.onerror / unhandledrejection, so errors caught by a boundary are entirely invisible to RUM
 * by default and can only be reached through local logs. This forwards them onto the same ARMS
 * custom event channel as perf_crash, closing that blind spot.
 */
export function reportReactErrorToArms(params: {
  error: Error;
  componentStack: string;
  scope?: string;
}): void {
  if (!armsReporter) {
    return;
  }

  try {
    const payload = buildReactErrorArmsPayload(params);
    void Promise.resolve(armsReporter.reportArmsCustomEvent(payload)).catch((error) => {
      // Reason: ARMS is an observation link, and the error boundary fallback recovery process must not be interrupted due to point burying failure.
      logger.warn("[react-error] ARMS custom event report failed", {
        scope: params.scope ?? "app",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[react-error] ARMS custom event report threw", {
      scope: params.scope ?? "app",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
