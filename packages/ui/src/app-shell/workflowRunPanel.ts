/**
 * The pure logic of the workflow run detail page: Cancel availability, result/failure panel
 * decisions, and event log line summaries.
 *
 * It is extracted into pure functions because these are the only "rules" on the detail page, and
 * every one of them can be covered by exhaustive unit tests without rendering a React Flow canvas.
 * The component is only responsible for mapping these results onto the DOM.
 */
import {
  readWorkflowRunStopReason,
  type WorkflowRunStopReason,
} from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunActor, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { workflowRunConcurrencyEventLine } from "@/app-shell/workflowRunThrottle.js";

/**
 * Cap on the fallback raw text for unknown event kinds: the event log never pours a whole journal
 * record into the DOM.
 */
const UNKNOWN_PAYLOAD_MAX_LENGTH = 200;

/**
 * Cancel is available only on `running`.
 *
 * Cancellation goes through the existing v4 `cancelBackgroundWork {workId: runId}` (one
 * implementation behind all three entry points, no second cancel RPC), and for an already finished
 * task it is a no-op anyway — the button is disabled in terminal states so that the UI never offers
 * a control that does nothing when clicked, not as a fallback. It is equally unavailable when the
 * run is absent (evicted by the 8-run cap, or not yet projected at cold start): in that case we
 * know nothing about whether it is still in flight.
 */
export function isWorkflowRunCancellable(run: WorkflowRunState | undefined): boolean {
  return run?.status === "running";
}

/**
 * Resume availability. **A single source of truth**: the projected run's `resumable` status bit —
 * computed by the CLI on the `run-settled` payload using the **same predicate** as the resume gate
 * (live and cold replay share one minting chain), so the UI never derives it itself from status +
 * failureCode (two predicates would drift: the button lights up but the command gets rejected).
 *
 * A missing projection (evicted by the 8-run cap) is never resumable: better to lose one button
 * than to offer a control whose command is guaranteed to be rejected.
 */
export function isWorkflowRunResumable(run: WorkflowRunState | undefined): boolean {
  return run?.resumable === true;
}

type WorkflowRunResultView =
  /** The run is not in the projection: there is no result to speak of. */
  | { kind: "absent" }
  /** pending / running: no result panel yet. */
  | { kind: "none" }
  /**
   * Completed. `preview` is **always absent** at this stage — script artifacts live only in
   * `RunSettlement.artifact`, neither on the `run-settled` event (it carries only status and error)
   * nor in the journal. The completed state can therefore only point at that background result turn
   * in the session, and never invent a result view. The schema keeps the field, and it is shown
   * as-is whenever it is actually filled in.
   */
  | { kind: "completed"; preview?: string }
  /**
   * errored / stopped. `message` is the pre-formatted raw text supplied by the projection (a plain
   * string in the schema); `stopReason` is present only when the state is stopped and the
   * projection carries that key.
   */
  | {
      kind: "error";
      status: "errored" | "stopped";
      stopReason?: WorkflowRunStopReason;
      message?: string;
    };

export function workflowRunResultView(run: WorkflowRunState | undefined): WorkflowRunResultView {
  if (!run) return { kind: "absent" };
  if (run.status === "errored" || run.status === "stopped") {
    const stopReason = readWorkflowRunStopReason(run);
    return {
      kind: "error",
      status: run.status,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(run.error ? { message: run.error } : {}),
    };
  }
  if (run.status === "completed") {
    return { kind: "completed", ...(run.resultPreview ? { preview: run.resultPreview } : {}) };
  }
  return { kind: "none" };
}

/** One input row of the event log (= one item in the v4 query result). */
export interface WorkflowRunEventItem {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
}

export interface WorkflowRunEventLine {
  sequence: number;
  type: string;
  /** The localized primary label. */
  label: string;
  /**
   * Identity and data (site instance, actor name, log body, raw error text); no localization
   * needed.
   */
  detail?: string;
  /**
   * Failure/cancellation tint; everything else is default (no new visual vocabulary beyond the
   * overlay view's four-value set).
   */
  tone: "default" | "failed";
  truncated?: boolean;
}

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `{siteId, ordinal}` → `site@ordinal` (same shape as the engine's refToString, so it can be
 * compared against the log).
 */
function refText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { siteId, ordinal } = value;
  if (typeof siteId !== "string" || siteId.length === 0) return undefined;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
}

/**
 * A non-empty string, otherwise undefined (joinDetail drops the whole part instead of leaving a
 * dangling empty separator).
 */
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.message === "string" && value.message.length > 0 ? value.message : undefined;
}

function joinDetail(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A **short summary** of a report entry in the event log (not the full preview the Results section
 * shows).
 *
 * It is deliberately collapsed to a single line right here: the event log is monospaced with one
 * entry per line, and multi-line JSON would stretch the log into a second artifact view. The full
 * form (string as-is / object as pretty JSON) is computed on the CLI side and placed on
 * `workflowRuns.reports[].preview`, and that is the one the Results section renders.
 */
function reportItemSummary(item: unknown): string | undefined {
  if (item === undefined) return undefined;
  if (typeof item === "string") {
    return item.length > 0 ? truncate(item, UNKNOWN_PAYLOAD_MAX_LENGTH) : undefined;
  }
  try {
    const serialized = JSON.stringify(item);
    return serialized === undefined ? undefined : truncate(serialized, UNKNOWN_PAYLOAD_MAX_LENGTH);
  } catch {
    // The payload has been standardized on the CLI side into a JSON-serializable form; if you don't get here, you can't log a whole page.
    return undefined;
  }
}

/**
 * Fallback for unknown kinds: type + truncated JSON. It neither crashes nor pretends to recognize
 * it.
 */
function unknownDetail(payload: Record<string, unknown>): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    // The payload has been standardized on the CLI side into a JSON serializable form; if you don't get here, you can't let a line of logs hang up the panel.
    return undefined;
  }
  if (serialized === undefined || serialized === "{}") return undefined;
  return truncate(serialized, UNKNOWN_PAYLOAD_MAX_LENGTH);
}

const EVENT_KEY_PREFIX = "chat.toolCall.workflow.run.event.";

/**
 * Engine event → one readable line.
 *
 * The vocabulary follows the kinds the **engine actually emits**: run-started / actor-created /
 * node-queued / node-dispatched / node-repairing / node-nudged / node-settled / usage-updated / log
 * / import-cache-closed / report / escalation-raised / escalation-resolved / run-settled, plus the
 * adaptive-concurrency node-waiting / node-executing / concurrency-changed (the default branch
 * hands off to the sibling module first). The last two are emitted by the driver at the boundary of
 * executing an ask (the engine core is unaware of escalation), but they ride exactly the same two
 * rails, so they belong here with the rest of the family. `payload` is the rest of the event object
 * with `type` removed (the run service's mapping contract), so the field names read here are the
 * engine's own field names, with no second reshaping.
 *
 * Every branch reads the shape defensively: the payload has already been bounded, so deep fields
 * may have been trimmed away, and one event that cannot be read must never take down the whole
 * event log.
 */
export function workflowRunEventLines(
  events: readonly WorkflowRunEventItem[],
  formatMessage: FormatMessage,
): WorkflowRunEventLine[] {
  return events.map((event) => {
    const { payload } = event;
    const base = {
      sequence: event.sequence,
      type: event.type,
      ...(event.truncated ? { truncated: event.truncated as true } : {}),
    };
    const key = (suffix: string) => ({ id: `${EVENT_KEY_PREFIX}${suffix}` });

    switch (event.type) {
      case "run-started":
        // caps does not go into this line: concurrency is not actionable information.
        return { ...base, label: formatMessage(key("runStarted")), tone: "default" };

      case "actor-created": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        return {
          ...base,
          label: formatMessage(key("actorCreated")),
          ...(joinDetail(name, refText(payload.actor)) === undefined
            ? {}
            : { detail: joinDetail(name, refText(payload.actor))! }),
          tone: "default",
        };
      }

      case "node-queued": {
        const kind = typeof payload.kind === "string" ? payload.kind : undefined;
        const detail = joinDetail(refText(payload.instance), kind);
        return {
          ...base,
          label: formatMessage(key("nodeQueued")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-dispatched":
      case "node-nudged": {
        const detail = refText(payload.instance);
        return {
          ...base,
          label: formatMessage(key(event.type === "node-nudged" ? "nodeNudged" : "nodeDispatched")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-repairing": {
        const attempt = typeof payload.attempt === "number" ? String(payload.attempt) : "?";
        const detail = refText(payload.instance);
        return {
          ...base,
          label: formatMessage(key("nodeRepairing"), { attempt }),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-settled": {
        const outcome =
          payload.outcome === "ok" ||
          payload.outcome === "failed" ||
          payload.outcome === "cancelled"
            ? payload.outcome
            : undefined;
        const outcomeLabel = outcome
          ? formatMessage({ id: `chat.toolCall.workflow.run.outcome.${outcome}` })
          : "";
        const detail = joinDetail(refText(payload.instance), errorMessage(payload.error));
        return {
          ...base,
          label: formatMessage(key(payload.cached === true ? "nodeSettledCached" : "nodeSettled"), {
            outcome: outcomeLabel,
          }),
          ...(detail === undefined ? {} : { detail }),
          // The semantics of failed and canceled in journal are different, but this line only needs "this step failed".
          tone: outcome === "failed" || outcome === "cancelled" ? "failed" : "default",
        };
      }

      case "usage-updated": {
        // The event directly carries the total amount spent; the authoritative value is on the usage line of the status header.
        const spentTokens =
          typeof payload.spentTokens === "number" ? payload.spentTokens : undefined;
        return {
          ...base,
          label: formatMessage(key("usageUpdated")),
          ...(spentTokens === undefined
            ? {}
            : { detail: `${spentTokens.toLocaleString()} tokens` }),
          tone: "default",
        };
      }

      case "log": {
        const message = typeof payload.message === "string" ? payload.message : undefined;
        return {
          ...base,
          label: formatMessage(key("log")),
          ...(message === undefined ? {} : { detail: message }),
          tone: "default",
        };
      }

      /**
       * Control flow passed a `phase("…")` marker: give the name and which entry this is (replay
       * export still uses this formatter).
       */
      case "import-cache-closed": {
        // amend-resume's import cache is closed: whoever writes the first entry closes the door.
        // detail = subagent name (if applicable) + instance; the door closed by world.run has no name, only instances.
        const actorName = typeof payload.actorName === "string" ? payload.actorName : undefined;
        const detail = joinDetail(actorName, refText(payload.instance));
        return {
          ...base,
          label: formatMessage(key("importCacheClosed")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "phase-entered": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        const ordinal = typeof payload.ordinal === "number" ? payload.ordinal : 1;
        return {
          ...base,
          label: formatMessage(key("phaseEntered")),
          ...(name === undefined ? {} : { detail: ordinal >= 2 ? `${name} · ${ordinal}` : name }),
          tone: "default",
        };
      }

      /**
       * report and log are both fire-and-forget, but a report **carries site identity**
       * (`report#N@k` goes into the journal), so this line includes the instance. The body of the
       * entry has its own home (the full preview in the Results section); here it only gets a short
       * summary — the event log's job is "what the engine emitted, and when", not to be a second
       * artifact view.
       */
      case "report": {
        const detail = joinDetail(refText(payload.instance), reportItemSummary(payload.item));
        return {
          ...base,
          label: formatMessage(key("report")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      /**
       * Escalation Q&A: the actor hits a real blocker, escalates the question to the main agent,
       * and parks inside its own ask until the answer arrives; once the main agent answers by qid
       * it resumes in place.
       *
       * Both lines lead with the **qid**, even though the protagonist of the raised line is "who
       * asked what": the qid is the only correlation key between these two events, and in the log
       * they are usually dozens of lines apart (the waiting is the entire point of the feature).
       * Without it, an "already answered" line gives no way to tell which of the questions above it
       * answers.
       *
       * The body is truncated following the existing habit of the detail column (the same cap as
       * the report summary): the event log holds one entry per line, and the full question body has
       * its own home — the "pending questions" section above.
       */
      case "escalation-raised": {
        const question = typeof payload.question === "string" ? payload.question : undefined;
        // Return site instance when actor name is absent (anonymous actor): This line would rather say `actor#1@1` than not say who it is.
        const actorName = typeof payload.actorName === "string" ? payload.actorName : undefined;
        const detail = joinDetail(
          nonEmptyText(payload.qid),
          actorName ?? refText(payload.actor),
          question === undefined ? undefined : truncate(question, UNKNOWN_PAYLOAD_MAX_LENGTH),
        );
        return {
          ...base,
          label: formatMessage(key("escalationRaised")),
          ...(detail === undefined ? {} : { detail }),
          // The upgrade is not a failure: the actor did not error, it is waiting for an answer. Coloring is reserved for the rows that really didn't work out.
          tone: "default",
        };
      }

      case "escalation-resolved": {
        const answer = typeof payload.answer === "string" ? payload.answer : undefined;
        const detail = joinDetail(
          nonEmptyText(payload.qid),
          answer === undefined ? undefined : truncate(answer, UNKNOWN_PAYLOAD_MAX_LENGTH),
        );
        return {
          ...base,
          label: formatMessage(key("escalationResolved")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "run-settled": {
        const status =
          typeof payload.status === "string" && payload.status.length > 0
            ? payload.status
            : undefined;
        const statusLabel = status
          ? formatMessage({ id: `chat.toolCall.workflow.run.status.${status}` })
          : "";
        const detail = errorMessage(payload.error);
        return {
          ...base,
          label: formatMessage(key("runSettled"), { status: statusLabel }),
          ...(detail === undefined ? {} : { detail }),
          tone: status === "errored" || status === "stopped" ? "failed" : "default",
        };
      }

      default: {
        // Four concurrent events (node-waiting / node-executing / concurrency-changed / run-caps-changed)
        // Lives in the same family as workflowRunThrottle.ts (max-lines gate).
        const concurrencyLine = workflowRunConcurrencyEventLine(event, formatMessage);
        if (concurrencyLine !== undefined) return concurrencyLine;
        // For example `compaction` reserved by the engine for long context compression (v1 never emits). When it appears in the future,
        // This must still give an informative line, not a blank line.
        const detail = unknownDetail(payload);
        return {
          ...base,
          label: formatMessage(key("unknown"), { type: event.type }),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }
    }
  });
}

// ── Transcript entry: step card → actor instance──

/**
 * An openable actor instance.
 *
 * `siteId` + `ordinal` are the identity (the journal's key), `name` is display only; `sessionId` is
 * the id of the real persisted session, and the only thing the nested read-only SessionPane needs.
 *
 * `sessionId` **may be absent** (optional in the schema): a progress event can land before the
 * actor session is persisted, an old run may never have had one at all, and a slot that has not
 * started never has one. An instance with an absent session still opens a tab — a tab's identity is
 * (runId, siteId, ordinal), the session id is only the subscription target that travels along with
 * it, and when it is absent the tab shows a "not started yet" placeholder.
 */
export interface WorkflowActorInstance {
  siteId: string;
  ordinal: number;
  name?: string;
  sessionId?: string;
  status: WorkflowRunActor["status"];
}

// ──actor does not activate the door──

/**
 * The three situations an actor transcript tab can be in, relative to whether the session already
 * exists.
 *
 * `unknown` is not an error branch but the **most common long-lived state**: the tab is
 * deliberately not GC'd, so it outlives the 8-run projection eviction.
 */
type WorkflowActorStartState = "notStarted" | "started" | "unknown";

/**
 * What an actor transcript tab hands to the gate: the slot plus the session id known at open time
 * (may be absent).
 */
interface WorkflowActorSlotRef {
  runId: string;
  siteId: string;
  ordinal: number;
  actorSessionId?: string;
}

/**
 * The gate's verdict: the situation + the session id to subscribe to (absent = nothing to subscribe
 * to, so the panel can only show a placeholder).
 */
interface WorkflowActorGate {
  state: WorkflowActorStartState;
  sessionId?: string;
}

/**
 * Slot → whether that actor has already started, and which session to subscribe to.
 *
 * Actor sessions are **lazily created**: the engine only calls `createActorSession` when the first
 * ask is dispatched, so before that point subscribing to this session necessarily fails with
 * `fault.subscribe.sessionNotFound`, and after a projection store failure the panel sits at `error`
 * waiting for a manual retry — a dead panel. This selector is that gate.
 *
 * The decision is race-free: `createActorSession` has already `await`ed the session row being
 * persisted before the first dispatch (the ordering in `workflow-driver.ts` is pinned by tests), so
 * **seeing dispatched in the projection ⇒ the session row exists ⇒ the subscription is guaranteed
 * to hit**. Conversely `queued` does not count as started: the persistence-order guarantee hangs
 * off the pre-dispatch point, and a node in the queue is no evidence that a session exists.
 *
 * The lookup is by **(runId, siteId, ordinal)**: a tab can be opened before the actor appears (the
 * not-started pill), and there is then no session id to look up. Among the three values, the
 * boundary between `unknown` and `notStarted` is still the one that matters:
 *
 * - actor not in the projection, tab **has** a session id → `unknown`, **never block**. When a run
 *   is evicted by the 8-run cap and the projection is empty after a cold restore, subscribing
 *   directly is the only route to the transcript; blocking it would shut off the only persistent
 *   view of an already finished run.
 * - actor not in the projection, tab **has no** session id → `notStarted`: there is nothing to
 *   subscribe to, so the placeholder is honest (the script has not reached `agent()` yet; and if
 *   the run was evicted, this slot indeed never started).
 * - actor present, and not a single non-`queued` node → `notStarted`; otherwise `started`, with the
 *   subscription target taken from the projection's session id, falling back to the one the tab was
 *   opened with. The gate reads the live projection, so it heals itself as soon as the first node
 *   is dispatched.
 *
 * The recorded exception: a resumed run that hits a settled short-circuit emits `node-settled`
 * directly without going through `ensureSession`, so that actor session may genuinely not exist.
 * Settled opens the gate, the subscription fails, and it falls back to the existing error+retry
 * panel — which really is a "the session does not exist" case, so the existing fallback is the
 * correct answer.
 */
export function workflowActorStartState(
  runs: readonly WorkflowRunState[] | undefined,
  slot: WorkflowActorSlotRef,
): WorkflowActorGate {
  const run = runs?.find((candidate) => candidate.runId === slot.runId);
  const actor = run?.actors.find(
    (candidate) => candidate.siteId === slot.siteId && candidate.ordinal === slot.ordinal,
  );
  const sessionId = actor?.sessionId ?? slot.actorSessionId;
  const withSession = sessionId === undefined ? {} : { sessionId };
  if (run === undefined || actor === undefined) {
    return { state: sessionId === undefined ? "notStarted" : "unknown", ...withSession };
  }
  // Attribution is compared by `siteId` + `ordinal` (journal key): if the serial number is wrong, it is another instance, and
  // Both fields of the world-read node are absent, so the door is never opened to anyone.
  const started = run.nodes.some(
    (node) =>
      node.actorSiteId === actor.siteId &&
      node.actorOrdinal === actor.ordinal &&
      // `queued` is the only phase that does not prove the existence of a session. Take the complement instead of enumerating dispatched/repairing/
      // nudged/settled is to allow new phases to be opened in the future by default - not blocking the same orientation as `unknown`.
      node.phase !== "queued",
  );
  return { state: started ? "started" : "notStarted", ...withSession };
}
