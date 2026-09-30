import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type SessionEvent,
} from "@zcode/contracts";
import { createDenyPermissionBroker } from "@zcode/core";
import type { GlobalOptions } from "@zcode/shared-types";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import { readRuntimeFunction } from "./runtime-event-subscriber.js";

/**
 * The CreateWorkflow approval bypass under headless (`-p`).
 *
 * Why it is needed: headless never constructs a permissionBroker, so core falls back to
 * `createDenyPermissionBroker()` (`core/src/runtime/agent-runtime.ts`,
 * `core/src/tool/executor/impl.ts`), while CreateWorkflow's `alwaysAsk` gate has to pass through the broker in
 * every mode (`yolo` cannot skip it either; the alwaysAsk branch of `core/src/permission/service.ts` sits before
 * the mode branch). Combined, that means dwf under `-p` is **necessarily denied immediately**, with the error text
 * "No permission client configured for CreateWorkflow" — not suspended, not timed out.
 *
 * The bypass lets through CreateWorkflow alone, by tool name, and **delegates every other tool to that same deny
 * broker**: reusing rather than re-writing its denial semantics makes "the other tools keep today's semantics" a
 * structural fact instead of a coincidence (text drift cannot happen, because there is only one copy).
 *
 * This is not a permission bypass, only a gate bypass:
 * core stays untouched, the PermissionRequest hook still answers ahead of the broker (the `??` short-circuit in
 * `permission-flow.ts`), permission events are emitted as usual, and actors inside a run still inherit the
 * session's permission profile.
 */
export const createHeadlessPermissionBroker = (): NonNullable<
  ZCodeAppOptions["permissionBroker"]
> => {
  const denyBroker = createDenyPermissionBroker();
  return {
    requestPermission: async (request, options) => {
      // AmendWorkflow and CreateWorkflow have the same door and the same exception.
      if (
        request.toolName !== CREATE_WORKFLOW_TOOL_NAME &&
        request.toolName !== AMEND_WORKFLOW_TOOL_NAME
      ) {
        return await denyBroker.requestPermission(request, options);
      }
      return {
        decision: "allow",
        reason: `Headless CLI auto-approves ${request.toolName}: no interactive gate exists in -p mode.`,
        resolvedAt: new Date(),
      };
    },
  };
};

/**
 * The `type` of a dwf progress line in stream-json.
 *
 * Deliberately **not** part of `zcodeSessionEventTypeSchema` (`shared/src/zcode-protocol/index.ts`): that is a closed
 * `z.enum` feeding the discriminated union of `zcodeSessionEventSchema`, so adding a value amounts to making the
 * v3 app-server declare on the type level an event it never emits. stream-json is a CLI-private output format and is
 * not bound by the protocol's strict schema.
 */
const WORKFLOW_RUN_PROGRESS_STREAM_TYPE = "workflow.run.progress";

/**
 * A shape-fixed dwf progress NDJSON line. The envelope fields line up verbatim with `mapSessionEvent` (the same set of keys, the same
 * `String()`/`getTime()` normalization), so a line reader does not need a second set of envelope interpretation rules
 * for this one kind of line; `payload` is the contracts' bounded payload **as-is**, with no field names reshaped.
 */
interface WorkflowRunProgressStreamLine {
  type: typeof WORKFLOW_RUN_PROGRESS_STREAM_TYPE;
  eventId: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  traceId: string;
  payload: DynamicWorkflowRunProgressPayload;
}

/** Is this session event dwf progress? stream-json and the stderr progress share this one discriminator. */
const isDynamicWorkflowRunProgressEvent = (event: SessionEvent): boolean =>
  event.type === SessionEventType.DynamicWorkflowRunProgress;

const progressPayloadOf = (event: SessionEvent): DynamicWorkflowRunProgressPayload =>
  event.payload as DynamicWorkflowRunProgressPayload;

/**
 * A dwf progress event -> a shape-fixed NDJSON line.
 *
 * Replaces today's raw leak: the default of `mapSessionEventType` lands this type on the catch-all
 * `session.updated` (`session-mapper.ts`), so a stream-json consumer receives a line sharing its name with
 * "something about the session changed" yet carrying run-internal payload — impossible to tell apart, and impossible
 * to subscribe to on its own.
 *
 * Note that a dwf event is **out-of-turn** (`turnId` is always absent), so the envelope carries no
 * `turnId`: writing a key that is always undefined would only make readers think it sometimes has a value.
 */
const mapWorkflowRunProgressStreamLine = (event: SessionEvent): WorkflowRunProgressStreamLine => ({
  type: WORKFLOW_RUN_PROGRESS_STREAM_TYPE,
  eventId: String(event.id),
  sessionId: String(event.sessionId),
  seq: event.sequenceNumber,
  timestamp: event.timestamp.getTime(),
  traceId: String(event.traceId),
  payload: progressPayloadOf(event),
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const instanceLabel = (payload: Record<string, unknown>): string | undefined => {
  const instance = asRecord(payload.instance);
  const siteId = instance.siteId;
  if (typeof siteId !== "string") return undefined;
  const ordinal = instance.ordinal;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
};

/**
 * The **state-transition** face of the engine event kinds (the `text` mode's stderr tells only these plus `log`).
 *
 * The vocabulary comes from the contract comment on `toProtocolEvent` (`bootstrap/src/app/dynamic-workflow-run-launch.ts`):
 * run-started / actor-created / node-queued / node-dispatched / node-repairing /
 * node-nudged / node-settled / usage-updated / log / run-settled.
 * `usage-updated` and `actor-created` are deliberately not printed: the former is a pure count, the latter is not
 * a transition.
 */
const describeProgress = (payload: DynamicWorkflowRunProgressPayload): string | undefined => {
  const inner = asRecord(payload.payload);
  switch (payload.eventType) {
    case "run-started":
      return "started";
    case "run-settled": {
      // Final state vocabulary completed / errored / stopped;
      // stopped with reason: `stopped/provider: …`.
      const rawStatus = typeof inner.status === "string" ? inner.status : "settled";
      const status =
        typeof inner.stopReason === "string" ? `${rawStatus}/${inner.stopReason}` : rawStatus;
      const error = asRecord(inner.error).message;
      return typeof error === "string" ? `${status}: ${error}` : status;
    }
    case "log":
      return typeof inner.message === "string" ? `log: ${inner.message}` : undefined;
    case "node-queued":
    case "node-dispatched":
    case "node-repairing":
    case "node-nudged": {
      const label = instanceLabel(inner);
      return label ? `${payload.eventType.slice("node-".length)} ${label}` : undefined;
    }
    case "node-settled": {
      const label = instanceLabel(inner);
      const outcome = typeof inner.outcome === "string" ? inner.outcome : "settled";
      return label ? `settled ${label} (${outcome})` : undefined;
    }
    default:
      return undefined;
  }
};

/**
 * Whether a transition belongs to the **always-print** face. The start and the settlement of a run are the two
 * endpoints of this progress stream, and no throttling may swallow them — otherwise the `text` mode could print not a
 * single word for the entire wait and then suddenly print the final answer. `log` is emitted explicitly by the
 * script author (the `log()` facade) and is equally un-throttled: its frequency is the script's to decide, and the
 * author wrote it in order to be seen.
 */
const isUnthrottledProgress = (eventType: string): boolean =>
  eventType === "run-started" || eventType === "run-settled" || eventType === "log";

interface WorkflowProgressReporterInput {
  /** Progress goes to stderr only — stdout belongs to the result (the `text` mode prints brief progress on stderr). */
  write: (line: string) => void;
  /** Injected clock, so that throttling can be exhausted by sleep-free unit tests. */
  now?: () => number;
  /** The minimum interval between node phase transitions; `log` and the run endpoints are not bound by it. */
  throttleMs?: number;
}

/** The default throttling interval between node phase transitions. A 100-node run produces roughly 5x100 events. */
const DEFAULT_WORKFLOW_PROGRESS_THROTTLE_MS = 400;

/**
 * The stderr progress printer under `--output-format text`.
 * It recognizes dwf progress events only and ignores every other session event outright (no side effects on return).
 */
const createWorkflowProgressReporter = (
  input: WorkflowProgressReporterInput,
): ((event: SessionEvent) => void) => {
  const now = input.now ?? Date.now;
  const throttleMs = input.throttleMs ?? DEFAULT_WORKFLOW_PROGRESS_THROTTLE_MS;
  let lastThrottledAt: number | undefined;
  return (event) => {
    if (!isDynamicWorkflowRunProgressEvent(event)) return;
    const payload = progressPayloadOf(event);
    const description = describeProgress(payload);
    if (description === undefined) return;
    if (!isUnthrottledProgress(payload.eventType)) {
      const at = now();
      if (lastThrottledAt !== undefined && at - lastThrottledAt < throttleMs) return;
      lastThrottledAt = at;
    }
    input.write(`workflow ${payload.runId}: ${description}\n`);
  };
};

interface HeadlessWriteStream {
  write: (chunk: string) => unknown;
}

interface HeadlessSessionObserverInput {
  options: Pick<GlobalOptions, "json" | "outputFormat">;
  stderr: HeadlessWriteStream;
  stdout: HeadlessWriteStream;
  /** Needed by `--output-format stream-json` only; when absent, no NDJSON is written. */
  mapSessionEvent?: (event: SessionEvent) => unknown;
}

interface HeadlessSessionObserver {
  /** The one and only session event consumer. It is installed on **one** sink — two sinks each writing once means duplicate lines. */
  observe: (event: SessionEvent) => void;
  /**
   * Has any dwf activity been observed? This is the **narrow trigger** predicate for "wait for settlement": a run with
   * no dwf activity never enters the wait even once, and behaves byte for byte as it did before the change.
   */
  hasWorkflowActivity: () => boolean;
  /**
   * Starts recording turn text. It must be called **synchronously** after `submitPrompt` returns: nothing can slip in
   * between that moment and the first await, so the first event of a notification-driven turn cannot be missed.
   * `excludeTurnId` is the id of the first turn — its text is already given by `submitPrompt`'s return value, so
   * should its `turn_complete` arrive late, this id blocks the double count.
   */
  beginWaitPhase: (excludeTurnId?: string) => void;
  /** The text of every completed turn during the wait, in arrival order. */
  waitPhaseTurnResponses: () => readonly string[];
}

/**
 * The headless session event observer: it gathers "what the output format says to do" and "what the wait needs to know" in one place.
 *
 * How the three formats divide the work:
 *   stream-json -> one NDJSON line per event on stdout, with dwf progress going through the shape-fixed line; stderr does not repeat it.
 *   text        -> dwf progress only, and only on stderr (stdout belongs to the result).
 *   json        -> writes no event at all (the contract is "exactly one object").
 *
 * All three formats **must** observe events — even json prints not a single character, the wait still relies on the dwf trigger
 * predicate and on the turn text recorded here. So this function always returns an observer and no longer returns undefined.
 */
export const createHeadlessSessionObserver = (
  input: HeadlessSessionObserverInput,
): HeadlessSessionObserver => {
  const { mapSessionEvent, options, stderr, stdout } = input;
  const writeStreamEvent = mapSessionEvent
    ? (event: SessionEvent) => {
        // One event per line, written as it happens. Deliberately not formatJson:
        // that pretty-prints with an indent, which would spread a single event
        // over several lines and break every line-oriented reader downstream.
        //
        // The dwf progress goes through the stereotype line: the default of mapSessionEvent will make it catch-all
        // `session.updated` (session-mapper.ts), readers can neither distinguish nor
        // Just subscribe to it.
        const line = isDynamicWorkflowRunProgressEvent(event)
          ? mapWorkflowRunProgressStreamLine(event)
          : mapSessionEvent(event);
        stdout.write(`${JSON.stringify(line)}\n`);
      }
    : undefined;
  const reportProgress =
    mapSessionEvent === undefined && wantsWorkflowProgress(options)
      ? createWorkflowProgressReporter({ write: (line) => void stderr.write(line) })
      : undefined;

  let workflowActivity = false;
  let waiting = false;
  let excludedTurnId: string | undefined;
  const turnResponses: string[] = [];

  return {
    hasWorkflowActivity: () => workflowActivity,
    beginWaitPhase: (excludeTurnId) => {
      waiting = true;
      excludedTurnId = excludeTurnId;
    },
    waitPhaseTurnResponses: () => turnResponses,
    observe: (event) => {
      writeStreamEvent?.(event);
      reportProgress?.(event);
      if (isWorkflowActivityEvent(event)) workflowActivity = true;
      if (!waiting || event.type !== SessionEventType.TurnComplete) return;
      // The text of the first turn comes from the return value of submitPrompt; its turn_complete will be counted twice if it is late.
      if (event.turnId !== undefined && String(event.turnId) === excludedTurnId) return;
      const response = (event.payload as { response?: unknown }).response;
      if (typeof response === "string" && response.trim().length > 0) turnResponses.push(response);
    },
  };
};

/**
 * Does this event prove that this process has dwf activity?
 *
 * Two predicates instead of one: the progress event is the most direct evidence, but its append is asynchronous and could
 * in theory reach the sink only after the turn has already ended. `BackgroundTaskStarted`, by contrast, is emitted
 * synchronously when the tool executor registers a background task, so it **necessarily** lands inside the turn that
 * started it — earlier and harder evidence. Both are accepted; triggering needs only one of them.
 */
const isWorkflowActivityEvent = (event: SessionEvent): boolean => {
  if (isDynamicWorkflowRunProgressEvent(event)) return true;
  return (
    event.type === SessionEventType.BackgroundTaskStarted &&
    (event.payload as { taskKind?: unknown }).taskKind === "workflow"
  );
};

/** The two authoritative busy facts of the runtime. A narrow interface instead of the whole AgentRuntime — the wait only reads these two booleans. */
interface HeadlessWorkflowRuntimeFacts {
  hasActiveOrQueuedTurnWork: () => boolean;
  hasRunningBackgroundTasks: () => boolean;
}

/** The polling interval. The waiting period is on the order of minutes, so the overhead at this granularity is negligible, while it is what determines how responsive the exit is. */
const HEADLESS_WORKFLOW_POLL_INTERVAL_MS = 100;

/**
 * Waits for an in-flight workflow run to settle **plus for the completion-notification-driven turn to finish running**.
 *
 * Why polling these two booleans is enough (there is no race window, and that is the key argument of this mechanism): between a background
 * task reaching a terminal state (`updateRuntimeBackgroundTask` in `background-tasks.ts`) and the notification
 * command being enqueued (`runtime-command-queue.ts`, via `maybeEnqueueBackgroundTaskNotification` ->
 * `enqueueBackgroundTaskNotification` -> `enqueueRuntimeCommand`) there is **no await at all**,
 * and `drainRuntimeCommandQueue` also sets `runtimeCommandDrainActive` to true before its first await.
 * So "the task is no longer running" and "turn work is already pending" flip inside the same synchronous block, and a
 * poller can never land in between.
 *
 * The predicate is deliberately **broader than dwf**: concurrent background Bash/subagent tasks are waited for too. Their
 * notification turns are interleaved with the workflow's on the same queue, so waiting for them separately is
 * meaningless. The narrow half is the **trigger** (`hasWorkflowActivity`), so a run with no dwf activity is
 * entirely unaffected.
 *
 * No timeout and no env escape hatch: the controls are Cancel and Ctrl-C, the latter recording the run as
 * `stopped(interrupted)` through the existing orphan convergence (failure code `Interrupted`, resumable). Once the signal
 * aborts it returns immediately and never swallows the signal.
 */
export const waitForHeadlessWorkflowSettle = async (input: {
  intervalMs?: number;
  runtime: HeadlessWorkflowRuntimeFacts;
  signal: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> => {
  const intervalMs = input.intervalMs ?? HEADLESS_WORKFLOW_POLL_INTERVAL_MS;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (!input.signal.aborted) {
    if (!input.runtime.hasRunningBackgroundTasks() && !input.runtime.hasActiveOrQueuedTurnWork()) {
      return;
    }
    await sleep(intervalMs);
  }
};

/**
 * Can this app's runtime supply the busy facts?
 *
 * For the reason the values are read dynamically, see `readRuntimeFunction` in `runtime-event-subscriber.ts` (the same
 * `RunDependencies.createZCodeApp` injection-point boundary).
 *
 * **No silent degradation**: without the busy facts it does not enter the wait — the honest answer "this host does
 * not have that capability", rather than pretending it waited.
 */
export const readHeadlessRuntimeFacts = (
  runtime: unknown,
): HeadlessWorkflowRuntimeFacts | undefined => {
  const turnWork = readRuntimeFunction(runtime, "hasActiveOrQueuedTurnWork");
  const backgroundTasks = readRuntimeFunction(runtime, "hasRunningBackgroundTasks");
  if (!turnWork || !backgroundTasks) return undefined;
  return {
    hasActiveOrQueuedTurnWork: () => turnWork.call(runtime) === true,
    hasRunningBackgroundTasks: () => backgroundTasks.call(runtime) === true,
  };
};

/**
 * Should this run print workflow progress on stderr?
 *
 * Only `text` has that slot: the contract of `json` is exactly one object, and `stream-json` has already shape-fixed
 * every progress event into a line on stdout. The default (no --output-format, no --json) is text, so it prints too.
 */
const wantsWorkflowProgress = (options: Pick<GlobalOptions, "json" | "outputFormat">): boolean =>
  options.outputFormat === undefined ? !options.json : options.outputFormat === "text";
