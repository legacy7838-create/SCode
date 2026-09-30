/**
 * The adaptive-concurrency observation surface for the dwf run detail page: the
 * concurrency/cooldown readouts in the run header, plus the event-log rows for the four
 * `node-waiting` / `node-executing` / `concurrency-changed` / `run-caps-changed` events. The
 * subagent badge is **not** here: it is a single word with three states and is rendered straight
 * from the protocol's actor state.
 *
 * It shares the event types with workflowRunPanel.ts and additionally records locally the moment
 * each state was **first received**. The protocol only carries relative amounts (`cooldownMs` — the
 * engine has no clock), so the deadline can only be derived by the UI from "the moment this state
 * was first seen". Registration is by object identity (WeakMap): the reducer keeps the same object
 * reference for an unchanged `concurrency`, and a replacement by a new event is a new object and
 * gets registered again. It is not in the protocol because it is a local observation, not an engine
 * fact.
 */
import type { WorkflowRunConcurrency } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunEventItem, WorkflowRunEventLine } from "./workflowRunPanel.js";

const MS_PER_SECOND = 1_000;
const I18N_PREFIX = "chat.toolCall.workflow.run.";
const EVENT_KEY_PREFIX = `${I18N_PREFIX}event.`;

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/**
 * Throttling reason → i18n key for the short label (reason is an open string; only the known kinds
 * are mapped here and everything else falls into "transient error"; a completely unrecognized value
 * is shown as-is — not knowing it is no reason to hide it).
 */
const REASON_LABEL_KEY: Readonly<Record<string, string>> = {
  rate_limited: "throttle.reason.rateLimited",
  provider_overloaded: "throttle.reason.overloaded",
  offpeak_queued: "throttle.reason.offpeak",
  server_error: "throttle.reason.transient",
  network_error: "throttle.reason.transient",
  timeout: "throttle.reason.transient",
  stream_idle_timeout: "throttle.reason.transient",
  stale_connection: "throttle.reason.transient",
  proxy_error: "throttle.reason.transient",
};

export function throttleReasonLabel(reason: string, formatMessage: FormatMessage): string {
  const key = REASON_LABEL_KEY[reason];
  return key === undefined ? reason : formatMessage({ id: `${I18N_PREFIX}${key}` });
}

// ──Register the time of receipt──

const concurrencyReceivedAt = new WeakMap<WorkflowRunConcurrency, number>();

function stamp<T extends object>(registry: WeakMap<T, number>, subject: T, now: number): number {
  const seen = registry.get(subject);
  if (seen !== undefined) return seen;
  registry.set(subject, now);
  return now;
}

// ── run head ──

interface WorkflowRunConcurrencyView {
  /**
   * That number on the chip: the **actual** concurrency `min(cap, limit)` — the smaller of the
   * shared bucket's cap and this run's own limit. What the user sees is how many subagents this run
   * can really have in flight right now; which of the two limits is the binding one is not a
   * question this readout has to answer.
   */
  cap: number;
  ceiling: number;
  /** Cooldown deadline (epoch ms); absent when there is no cooldown or it has already expired. */
  cooldownUntil?: number;
}

/**
 * The concurrency readout in the run header. Present only when the **actual concurrency is below
 * the ceiling**: a run running at the ceiling has nothing to report. The cooldown deadline is
 * derived from the receive time plus `cooldownMs` and is absent once expired — the UI does not show
 * a time that has already passed.
 */
export function workflowRunConcurrencyView(
  concurrency: WorkflowRunConcurrency | undefined,
  now: number,
): WorkflowRunConcurrencyView | undefined {
  if (concurrency === undefined) return undefined;
  const effective = Math.min(concurrency.cap, concurrency.limit ?? concurrency.cap);
  if (effective >= concurrency.ceiling) return undefined;
  const view: WorkflowRunConcurrencyView = { cap: effective, ceiling: concurrency.ceiling };
  if (concurrency.cooldownMs !== undefined) {
    const until = stamp(concurrencyReceivedAt, concurrency, now) + concurrency.cooldownMs;
    if (until > now) view.cooldownUntil = until;
  }
  return view;
}

// ──Event log──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { siteId, ordinal } = value;
  if (typeof siteId !== "string" || siteId.length === 0) return undefined;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
}

/**
 * Readout of the engine caps (`{ maxConcurrency }`); when it cannot be read it shows "?", the same
 * fallback as previous/next.
 */
function capsMaxConcurrency(value: unknown): string {
  if (!isRecord(value)) return "?";
  return typeof value.maxConcurrency === "number" ? String(value.maxConcurrency) : "?";
}

/**
 * The four concurrency events (node-waiting / node-executing / concurrency-changed /
 * run-caps-changed) → event-log rows; every other kind returns undefined (handing back to the main
 * table's default fallback). The same discipline as the other branches of workflowRunEventLines:
 * payloads are read defensively, so a single unreadable event can never take down the whole page.
 * All default tone: waiting is not a failure, and neither is a cap change — the first three are the
 * runtime adjusting itself, the last one is the user adjusting it.
 */
export function workflowRunConcurrencyEventLine(
  event: WorkflowRunEventItem,
  formatMessage: FormatMessage,
): WorkflowRunEventLine | undefined {
  const { payload } = event;
  const base = {
    sequence: event.sequence,
    type: event.type,
    ...(event.truncated ? { truncated: event.truncated as true } : {}),
    tone: "default" as const,
  };
  const withDetail = (label: string, detail: string | undefined): WorkflowRunEventLine => ({
    ...base,
    label,
    ...(detail === undefined ? {} : { detail }),
  });
  switch (event.type) {
    // node-waiting: cause=slot is queuing in front of the gate, there is nothing else to say; cause=backoff is with runner
    // Backoff reason and duration - The logo does not show these details, the event log is the only place for them.
    case "node-waiting": {
      if (payload.cause !== "backoff") {
        return withDetail(
          formatMessage({ id: `${EVENT_KEY_PREFIX}nodeWaitingSlot` }),
          refText(payload.instance),
        );
      }
      const reason =
        typeof payload.reason === "string"
          ? throttleReasonLabel(payload.reason, formatMessage)
          : "?";
      const seconds =
        typeof payload.delayMs === "number"
          ? String(Math.ceil(payload.delayMs / MS_PER_SECOND))
          : "?";
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}nodeWaitingBackoff` }, { reason, seconds }),
        refText(payload.instance),
      );
    }
    case "node-executing":
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}nodeExecuting` }),
        refText(payload.instance),
      );
    case "concurrency-changed": {
      const previous = typeof payload.previous === "number" ? String(payload.previous) : "?";
      const next = typeof payload.next === "number" ? String(payload.next) : "?";
      const key =
        typeof payload.key === "string" && payload.key.length > 0 ? payload.key : undefined;
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}concurrencyChanged` }, { previous, next }),
        key,
      );
    }
    // run-caps-changed: The user changed the caps of his own run while running (it takes effect locally and does not start another run).
    // It is divided into two lines as the above one: `concurrency-changed` means that the manager is pressing the shared bucket (provider key thing), this one is
    // User's decision. There is no detail - it does not belong to any provider key, nor to any instance.
    case "run-caps-changed":
      return withDetail(
        formatMessage(
          { id: `${EVENT_KEY_PREFIX}runCapsChanged` },
          {
            previous: capsMaxConcurrency(payload.previous),
            next: capsMaxConcurrency(payload.caps),
          },
        ),
        undefined,
      );
    default:
      return undefined;
  }
}
