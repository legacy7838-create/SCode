// ============================================================
// AgentRuntime-backed WorkflowDriver: purely auxiliary
// ============================================================
// workflow-driver.ts reaches the upper limit of oxlint max-lines (400 lines), and combines pure functions that do not touch the driver state with
// constants (deferred, actor session id casting, upgrade budget and qid fragments, nudge/schema endnotes, rulings and statistics
// Mapping, turn failure and normalization) are split into this file; the public side (mintActorSessionId) is still exported from workflow-driver.ts.

import {
  CoreErrorType,
  createSessionId,
  type SessionId,
  type SubmitVerdict as ContractsSubmitVerdict,
  type SubmitViolation,
} from "@zcode/contracts";
import type { TurnResult } from "@zcode/core";
import {
  refToString,
  WorkflowError,
  type ActorRef,
  type AskStats,
  type InstanceRef,
  type PersonaSpec,
  type Violation,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import type { ActorToolCounts } from "./workflow-driver-tool-activity.js";
import type { Deferred, SessionState } from "./workflow-driver-types.js";

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Actor session id: run-scoped + charset-safe.
 *
 * The old scheme `createSessionId("wf-actor-" + refToString(actor))` had two defects: it carried no runId, so
 * the same site x ordinal actor in two concurrent runs collided onto one id; and it carried `#`/`@` (refToString has the shape
 * `actor#1@1`), while session ids end up in URLs, file paths and logs.
 */
/**
 * Actor session id: run-scoped and charset-safe.
 *
 * **The export is deliberate**: the progress projection has to carry the session id on the `actor-created` event (Boundary C does not carry it),
 * and "compute the session id from (runId, actorRef)" must have exactly one implementation -- computing it in both places means that one day they disagree,
 * which shows up as the detail page opening a session that does not exist. The run service calls this very function (tests pin that both sides agree).
 */
export function mintActorSessionId(runId: string, actor: ActorRef): SessionId {
  return createSessionId(
    `dwf-${sanitizeIdSegment(runId)}-${sanitizeIdSegment(refToString(actor))}`,
  );
}

/**
 * Folds an arbitrary string into `[A-Za-z0-9.\-_]`, where `_` only ever appears as escape output.
 *
 * **Two steps, and the order is the contract**: first escape the literal `_` into `__`, then map every character outside `[A-Za-z0-9.-]` to a single `_`.
 * Reversing the order breaks the escape (the `_` produced by the second step would be flipped again by the first). The `_` produced by the first step is
 * the identity under the second step's mapping, so the two steps compose safely.
 *
 * Why the escaping step is needed: without it both `my_actor#1` and `my#actor#1` fold into `my_actor_1` -- a real collision.
 * A plain allowlist is collision-free only under the premise that `_` never appears in the site id vocabulary, and that vocabulary is owned by the analyzer,
 * not by this file. Escaping swaps "keep some shape by borrowing someone else's vocabulary" for a property provable locally.
 *
 * The residual (smaller) assumption: two **different** special characters still both map to `_`, so a hypothetical `a#b` and `a@b` would collide.
 * In today's and any foreseeable site ids, special characters appear at fixed positions (`actor#N@M`, site-specialized `kind#N/M`), so no such isomorphic-but-distinct
 * pair exists; eliminating it would mean giving every special character its own encoding.
 */
function sanitizeIdSegment(value: string): string {
  return value.replace(/_/g, "__").replace(/[^A-Za-z0-9.-]/g, "_");
}

/**
 * The cap on escalations within one ask (a sibling of the nudge budget).
 *
 * Past the cap it is **not an error but a discipline**: the 4th call gets an ordinary result telling it to proceed on its own best judgement.
 * An escalation writes no dwf_node row (waiting is not work), so this count is the only bound.
 */
export const MAX_ESCALATIONS_PER_ASK = 3;

/** The tool result wording handed back to the model when the budget runs out (an ordinary result, not an error). */
export const ESCALATION_BUDGET_EXHAUSTED =
  `Escalation budget exhausted: at most ${MAX_ESCALATIONS_PER_ASK} escalations per task. ` +
  "Do not call escalate again. Proceed on your best judgement with the information you have, " +
  "and state in your final result the assumptions you relied on and the doubts that remain.";

/** Beyond the actor session id segment, the candidate sequence for the qid segment (short to long, the last one being the full runId). */
export function questionIdFragments(runId: string): string[] {
  // The `dwfrun-` prefix is ​​the same for every run. Leaving it in will only make the qid longer without increasing the recognition.
  const body = runId.startsWith("dwfrun-") ? runId.slice("dwfrun-".length) : runId;
  const full = sanitizeIdSegment(body);
  const candidates = [full.slice(0, 8), full.slice(0, 16), full];
  // The three candidates on the short runId will degenerate into the same string; deduplication is only to avoid unnecessary repeated table lookups.
  return [...new Set(candidates)];
}

/**
 * The actor's **effective name**: taken straight from `persona.name`; absent or an empty string means anonymous.
 *
 * There is no need to re-run normalization here -- the persona the driver receives is already the product of the engine's `normalizePersona`
 * (the scheduler passes `actor.persona` through into `createActorSession` unchanged), so `spec.name` is exactly the one effective name
 * the engine recognizes: the name on the `actor-created` event, the cache identity key on amend-resume,
 * and the key DuplicateActorName lookups use are all of it.
 *
 * **Deliberately not trimmed**, the opposite of {@link normalizeEscalationContext}: the engine's anonymity criterion is
 * `name !== undefined && name !== ""` (createActor in engine.ts), and an actor called `"  "` is
 * **named** as far as the engine is concerned and occupies the cache identity key. Trimming it to anonymous here would make one and the same actor give two answers
 * on the question "does it have a name" -- and that is exactly what the escalation record uses to identify the asker. Follow the engine.
 */
export function effectiveActorName(persona: PersonaSpec): string | undefined {
  const name = persona.name;
  return name === undefined || name === "" ? undefined : name;
}

/** The optional context of `escalate`: blank counts as absent (models often pass an empty string, and inside an event it would only be noise). */
export function normalizeEscalationContext(context: string | undefined): string | undefined {
  const trimmed = context?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** The nudge prompt that pushes the model to submit when a turn ends without a submit. */
export const NUDGE_PROMPT =
  "You ended your turn without submitting a result. Call the submit_result tool now with a payload conforming to the required schema.";

/**
 * The schema epilogue of a typed ask: appended to the instruction body, telling the model to hand in a schema-conforming result with submit_result.
 * The format (this comment is the contract): a divider + one sentence requiring the tool call + a JSON Schema indented by 2 spaces + one sentence constraining the result.
 * The wording deliberately avoids "exactly once" -- during a repair turn the model will legitimately call submit_result several times.
 */
export function schemaEpilogue(schema: unknown): string {
  const rendered = schema === undefined ? "(any JSON value)" : JSON.stringify(schema, null, 2);
  return [
    "",
    "",
    "---",
    "When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must be a JSON value conforming to this JSON Schema:",
    "",
    rendered,
    "",
    "Pass the conforming JSON as the `result` argument — do not wrap it or add commentary.",
  ].join("\n");
}

/**
 * The typed ask epilogue for a mono subagent: the schema is already in the tool declaration, so all that is left is one sentence saying to call the tool once done. Same format skeleton as {@link schemaEpilogue}
 * (two blank lines + a divider), and the GUI collapses epilogues by boundary index rather than by text, so it is unaffected.
 */
export const TYPED_TOOL_EPILOGUE = [
  "",
  "",
  "---",
  "When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must match the tool's declared schema — pass the conforming JSON directly, do not wrap it or add commentary.",
].join("\n");

/** Engine Violation -> contracts SubmitViolation (structurally isomorphic, 1:1). */
export function mapViolations(violations: readonly Violation[]): SubmitViolation[] {
  return violations.map((v) => ({ path: v.path, expected: v.expected, got: v.got }));
}

/** Synthesizes a binary rejection (used by the driver for local interception, without going through the engine). */
export function rejectWith(message: string): ContractsSubmitVerdict {
  return {
    accept: false,
    violations: [{ path: "$", expected: message, got: "submit_result call" }],
  };
}

/**
 * Derives AskStats from a TurnResult plus observations of the tool activity surface. tokens is the only field the engine hard-depends on (it is what debits the budget); turns and the two
 * tool counts are recorded in the journal, where `toolCalls === 0` makes this ask a **pure** ask that can still hit after the import cache closes, and `worldToolCalls`
 * is the bookkeeping for "it has seen or touched the outside world" -- protocol tools (`submit_result` / `escalate`) do not count, otherwise every typed ask
 * would stop being pure the moment it handed in a result.
 *
 * The counts used to be taken by counting `ToolCallStarted` in `result.events`, but TurnResult's event array
 * contains no tool events -- all 2097 ask rows in the production journal have `toolCalls` of 0, including subagents that plainly wrote files. If the pure-ask
 * determination rested on that 0, every cache entry would count as pure and hit as usual after the gate closes, letting through exactly the class of entries the gate exists to stop. The counts are therefore
 * taken by the driver's tool activity surface from the **session event stream** (the one place tool calls actually show up), accumulated per ask and passed in.
 */
function statsFromTurn(result: TurnResult, toolCounts: ActorToolCounts): AskStats {
  const usage = result.usage;
  return {
    tokens: usage?.totalTokens ?? 0,
    toolCalls: toolCounts.toolCalls,
    turns: usage?.modelRequestCount ?? 1,
    worldToolCalls: toolCounts.worldToolCalls,
  };
}

/** Decides whether a reject from executeTurn is a "user/engine cancellation" (a normal ending, not a driver failure). */
export function isTurnCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === CoreErrorType.TurnCancelled
  );
}

/** Normalizes any (non-model-layer) turn failure into a node-level WorkflowError (DriverError), preserving the original cause. */
export function toWorkflowError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WorkflowError("DriverError", `Subagent turn failed: ${message}`, { cause: error });
}

// —————————— Model-side failed containment: Constant vs. Pure Auxiliary ——————————

/** The upper bound on the provider's raw text inside a ProviderStop detail (both the notification and the journal carry it, so it cannot be unbounded). */
export const PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS = 2000;

/** The continuation prompt for a transient re-drive (the same mechanism as the nudge: a fresh turn on the same persistent runtime). */
export const TRANSIENT_CONTINUE_PROMPT =
  "The previous model request failed transiently and was abandoned; continue from where you left off.";

const TRANSIENT_BACKOFF_BASE_MS = 2_000;
const TRANSIENT_BACKOFF_MAX_MS = 60_000;

/** The very same curve in the runner: starts at 2s and doubles up to a 60s ceiling, times jitter in [0.5, 1]. */
export function transientBackoffMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(TRANSIENT_BACKOFF_MAX_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(raw * (0.5 + 0.5 * random()));
}

/** Retry-After on an adapter error (`context.retryAfterMs`, within one cause layer), read structurally. */
export function readRetryAfterMs(error: unknown): number | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    const context = (candidate as { context?: { retryAfterMs?: unknown } } | undefined)?.context;
    const value = context?.retryAfterMs;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** How a subagent is addressed in notification text: the name if it has one, otherwise `site@ordinal`. */
export function subagentLabel(state: Pick<SessionState, "actor" | "actorName">): string {
  return state.actorName ?? refToString(state.actor);
}

export const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

/**
 * The two facts one turn resolution reports back to the engine, and the order is load-bearing:
 *   1. `askProgress` -> `node-progress`: which round this ask is on, how many tool calls it has made, what it touched most recently;
 *   2. `askStats` -> `usage-updated`: how many tokens this round cost (reported once for accept / text / nudge alike).
 * Progress comes first, so whoever reads the new usage has already read the progress that earned it. Keeping the two in one function is precisely so that
 * this order has one place you can point at, instead of two lines scattered across call sites.
 */
export function reportTurnObservations(
  sink: WorkflowReportSink,
  state: SessionState,
  instance: InstanceRef,
  result: TurnResult,
): void {
  sink.askProgress(instance, state.modelActivity.noteTurnResolved());
  sink.askStats(instance, statsFromTurn(result, state.modelActivity.toolCounts()));
}
