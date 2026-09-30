import { redactTelemetryText, redactTelemetryUrl } from "@zcode/shared";

/**
 * ARMS SDK automatically collects the desensitization closure before the event leaves the machine.
 *
 * The SDK collector determines which fields to collect. Its original content may include user interface text (click), local path and stack
 * (exception) and the full URL (api/resource). `appARMSBootstrap.beforeReport` is the only method that can be used before reporting
 * Rewrite the location of the entire batch of events, so the rules are concentrated here and not scattered among various collector configurations.
 *
 * Desensitize and only rewrite and report
 * Copy: Network aggregation has completed ingest before this function, and local logs, error displays, and crash archives continue to use the original values.
 */

/** The upper limit of exception message: consistent with the normalized 2000-character limit of the console in the dependency patch. */
const EXCEPTION_MESSAGE_MAX_LENGTH = 2_000;

/** The upper limit of stack / snapshots: ensure that the most recent error frame must be uploaded, and at the same time, the entire text will not be sent to ARMS. */
const EXCEPTION_STACK_MAX_LENGTH = 4_000;

/**
 * The click name of Browser SDK is in the form of `click on <type-><tag>: <first 20 characters of innerText>...`.
 * Only retained up to tag; `: ` is followed by the element text, which in ZCode may be the session title, file name or message body.
 */
const CLICK_NAME_PATTERN = /^(click on [a-z0-9-]+)(?::[\s\S]*)?$/iu;

/** Names that do not conform to the expected form are not transparently transmitted as they are and degenerate into fixed buckets, keeping events countable but without content. */
const CLICK_NAME_FALLBACK = "click";

function isClickEvent(event: Record<string, unknown>): boolean {
  return event.event_type === "click" || event.type === "click";
}

function isExceptionEvent(event: Record<string, unknown>): boolean {
  return event.event_type === "exception";
}

function isNativeDumpEvent(event: Record<string, unknown>): boolean {
  // The native dump is parsed by the crash collector, and its binary_images/threads are already structured forensic data.
  // And filterAndEnrichNativeCrashEvents relies on binary_images to determine the product binary and cannot be rewritten here.
  return event.type === "crash" && event.source === "crashReporter";
}

function isResourceEvent(event: Record<string, unknown>): boolean {
  const eventType = String(event.event_type ?? "").toLowerCase();
  return eventType === "api" || eventType === "resource" || eventType.includes("resource");
}

function redactTextField(event: Record<string, unknown>, key: string, maxLength: number): void {
  const value = event[key];
  if (typeof value !== "string" || !value) {
    return;
  }
  event[key] = redactTelemetryText(value, { maxLength });
}

function redactUrlField(event: Record<string, unknown>, key: string): void {
  const value = event[key];
  if (typeof value !== "string" || !value) {
    return;
  }
  event[key] = redactTelemetryUrl(value);
}

function redactClickEvent(event: Record<string, unknown>): void {
  const name = event.name;
  event.name =
    typeof name === "string"
      ? (CLICK_NAME_PATTERN.exec(name)?.[1] ?? CLICK_NAME_FALLBACK)
      : CLICK_NAME_FALLBACK;
  // The href/src of snapshots may be a local file path, and the id/className has no incremental value for diagnosis.
  delete event.snapshots;
}

function redactExceptionEvent(event: Record<string, unknown>): void {
  if (isNativeDumpEvent(event)) {
    return;
  }
  redactTextField(event, "message", EXCEPTION_MESSAGE_MAX_LENGTH);
  redactTextField(event, "stack", EXCEPTION_STACK_MAX_LENGTH);
  // Reason for repair: jsError collector writes ErrorEvent.filename into file; the Windows installation version script is located in
  // C:\Users\<username>\AppData\..., processed according to the same rules as stack, structured fields such as line / column are unchanged.
  redactTextField(event, "file", EXCEPTION_MESSAGE_MAX_LENGTH);
  redactTextField(event, "snapshots", EXCEPTION_STACK_MAX_LENGTH);
}

function redactResourceEvent(event: Record<string, unknown>): void {
  redactUrlField(event, "url");
  redactUrlField(event, "name");
  redactTextField(event, "message", EXCEPTION_MESSAGE_MAX_LENGTH);
}

/**
 * Redacts a whole batch of SDK auto-collected events in place and returns that same batch so it can be chained inside `beforeReport`.
 *
 * Only the three auto-collected event kinds are handled: click / exception / api-resource. Custom events (`perf_*` and friends) are redacted where they are
 * constructed and are not rewritten a second time here, because two rule sets handling the same field would leave it unreadable.
 */
export function redactArmsEventBatch(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    if (isClickEvent(event)) {
      redactClickEvent(event);
      continue;
    }
    if (isExceptionEvent(event)) {
      redactExceptionEvent(event);
      continue;
    }
    if (isResourceEvent(event)) {
      redactResourceEvent(event);
    }
  }
  return events;
}
