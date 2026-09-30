// ============================================================
// Common aspects of Workflow run introspection tools (ListWorkflowRuns/GetWorkflowRun)
// ============================================================
//
// Three things must be shared verbatim, so they are written here instead of in both handlers:
//
//   1. **Business failure due to absence of capability**. "Port is absent" (journal is not available → run service is not constructed at all) and
//      "The port is present but the method is absent" (journal without introspection query) is the same thing for models: this session does not have this capability.
//      Two tools, two criteria, and a paragraph of copy.
//   2. **Failure code**. The type of `ToolHandlerFailure.errorCode` is number (executor side
//      `isToolHandlerFailure` is closed by number), so there are two stable discrimination keys
//      (`workflow_introspection_unavailable` / `run_not_found`) falls on the prefix of message——
//      It is the only discriminant bit that the model and log can read.
//   3. **Asynchronous guidance copywriting**. Both tool descriptions must clearly state that "the run of this session will automatically send a notification of the product."
//      Copywriting bifurcation is equivalent to giving the model two sets of default behaviors.

import { escapeXml } from "../../runtime-task/notification.js";
import type { ToolHandlerFailure } from "../types.js";

/**
 * Business failure codes. The numbers themselves do not reach the model (the executor projects them as `code: "1"`); the discriminator key is in the message prefix.
 * The two codes must differ: an absent capability and an unknown run are two things the model has to handle separately.
 */
const WORKFLOW_RUN_INTROSPECTION_ERROR_CODE = {
  INTROSPECTION_UNAVAILABLE: 1,
  RUN_NOT_FOUND: 2,
} as const;

/**
 * "This session has no workflow introspection capability". It **never** silently returns an empty list: that would let the model conflate "this project has never run
 * a workflow" with "this session cannot read workflows" (the very same reasoning behind CreateWorkflow's visible degradation).
 */
export function workflowIntrospectionUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: WORKFLOW_RUN_INTROSPECTION_ERROR_CODE.INTROSPECTION_UNAVAILABLE,
    message:
      "workflow_introspection_unavailable: this session cannot read workflow runs — workflow execution is not available here, so no run history is reachable. This is a capability gap, not an empty project.",
  };
}

export function workflowRunNotFoundFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: WORKFLOW_RUN_INTROSPECTION_ERROR_CODE.RUN_NOT_FOUND,
    message: `run_not_found: no workflow run with ID ${runId} exists for this project. Use ListWorkflowRuns to see the runs that do.`,
  };
}

/**
 * The async guidance shared by the two tool descriptions.
 *
 * Polling is not disabled — when the user explicitly asks to watch an in-flight run, it is still the right action; only the default is set here.
 */
export const WORKFLOW_RUN_INTROSPECTION_STEERING = [
  "Runs this session starts settle on their own: you receive a completion notification carrying the final output. Do NOT poll this tool while waiting for one — continue with other work.",
  "Reach for it when: (a) the user asks how a workflow is going, (b) you want to review this project's earlier runs, including ones other sessions started, (c) a completion notification was truncated and you need the run's full record by ID.",
].join("\n");

/**
 * epoch ms → ISO 8601 (UTC). In the structured output a timestamp is epoch ms (the journal's verbatim fact), while the model-facing side gets
 * ISO: that is the form in which it can read off "how long ago" directly, instead of doing mental arithmetic on a string of 13 digits.
 *
 * A bad value (NaN / out of range) falls back to the raw number instead of throwing — one timestamp must not fail the entire tool result.
 */
export function formatWorkflowRunTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return String(epochMs);
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return String(epochMs);
  }
}

/** The duration ladder. Defined in one place and shared by the summary and the formatter — two separate implementations would diverge at some tuning round. */
const DURATION_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

function padTwo(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * milliseconds → a human-readable duration (`40s` / `5m 10s` / `2h 15m` / `3d 2h`).
 *
 * Only two levels are kept: a reader wants the order of magnitude, not the precision, and "1h 02m 03s" would send him off counting digits. Minutes and seconds are zero-padded
 * (they are both base-60 subunits, and without padding `1m 5s` and `1m 50s` are hard to tell apart at a glance); hours below a day are not.
 * Non-finite and negative values (a clock jumping backwards) collapse to 0; one timestamp must never turn the entire tool result into NaN.
 */
export function formatWorkflowRunDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (total < DURATION_MS.minute) return `${Math.floor(total / DURATION_MS.second)}s`;
  if (total < DURATION_MS.hour) {
    const minutes = Math.floor(total / DURATION_MS.minute);
    const seconds = Math.floor((total % DURATION_MS.minute) / DURATION_MS.second);
    return `${minutes}m ${padTwo(seconds)}s`;
  }
  if (total < DURATION_MS.day) {
    const hours = Math.floor(total / DURATION_MS.hour);
    const minutes = Math.floor((total % DURATION_MS.hour) / DURATION_MS.minute);
    return `${hours}h ${padTwo(minutes)}m`;
  }
  const days = Math.floor(total / DURATION_MS.day);
  const hours = Math.floor((total % DURATION_MS.day) / DURATION_MS.hour);
  return `${days}d ${hours}h`;
}

/**
 * "How long ago". When `at` is absent or not a finite number, `undefined` is returned — the read side then **omits the age entirely**
 * instead of rendering a 0 or an "unknown": an old journal with no timestamp genuinely cannot state an age, and that is a fact.
 */
export function formatRelativeAge(now: number, at: number | undefined): string | undefined {
  if (at === undefined || !Number.isFinite(at) || !Number.isFinite(now)) return undefined;
  return `${formatWorkflowRunDuration(now - at)} ago`;
}

/** Formats the ISO instant and the relative age; when the age is unknowable, only the ISO instant is shown. */
export function formatWorkflowRunInstant(now: number, at: number): string {
  const age = formatRelativeAge(now, at);
  const iso = formatWorkflowRunTimestamp(at);
  return age === undefined ? iso : `${iso} (${age})`;
}

/**
 * Thousands separators. The result of `toLocaleString` depends on the host's ICU data, and every character on the model-facing side has to be pinnable verbatim
 * by a test, so the commas are inserted here by hand.
 */
export function formatWorkflowRunCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.trunc(Math.abs(value)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/**
 * An XML-ish attribute. Whitespace in the value is folded to a single space before escaping: a newline inside an attribute would break the "one run per line" layout,
 * and label is free text (a name the user chose or the first line of the script).
 */
export function workflowRunAttribute(name: string, value: string | number | boolean): string {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : String(value);
  return `${name}="${escapeXml(text)}"`;
}

/**
 * The escaping **reuses** the one from the notification projection of runtime-task (notification.ts): both are the same kind of
 * XML-ish model-facing projection, and a second hand-copied escaping table would only diverge at some adjustment round.
 */
export { escapeXml as escapeWorkflowRunText };
