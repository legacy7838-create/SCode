// ============================================================
// Dynamic Workflow Run Port - Submit/observe/cancel boundaries of dwf engine run
// ============================================================

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "./dynamic-workflow-run-roster.port.js";
import type {
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
} from "./dynamic-workflow-run-retune.port.js";
import type {
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
} from "./dynamic-workflow-run-workspace.port.js";
import type { DynamicWorkflowRunProgressPayload } from "../events/session.events.js";
import type { ModelSelection } from "../model/model.js";
import type { SessionId, ToolCallId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { WorkflowTaskSnapshot } from "./workflow.port.js";

/**
 * The submit request of one workflow run. The script text is the authoritative input (compilation, the site table, schema composition and lowering are all derived
 * from it), so only the script and the execution context are passed here and no compilation product at all — the "compile once" step happens
 * on the port implementation side (the run service), and callers should have no concept of compilation products.
 */
export interface DynamicWorkflowRunSubmitRequest {
  /** The source of the workflow script. Persisted byte for byte (dwf_run.script_text); resume presupposes its hash. */
  scriptText: string;
  /** The working directory of the run (the cwd of the sandbox child process, the root of world-read). */
  cwd: string;
  /**
   * The display name of the run (the optional `input.name` of `CreateWorkflow`). It lands in `dwf_run.name` and serves as the label of the enumeration surfaces.
   * Purely display metadata: it takes part neither in execution nor in resume validation; absence means no name was given (the read side falls back to the script's first line).
   */
  name?: string;
  /**
   * The actual arguments of this run (the declarative parameters of the saved workflow, already validated against the declaration and backfilled with defaults by the tool side).
   *
   * Unlike `name`, this is **not** display metadata: it lands in `dwf_run.args_json` and is injected into the sandbox as the script-readable
   * `args` global, and is part of the run's identity — resume replays exactly this saved copy and never accepts a new one. An inline script
   * has no arguments, and an absent field means `{}`.
   */
  args?: Record<string, unknown>;
  /** The session that started this run; engine events are projected back onto that session. */
  parentSessionId?: SessionId | string;
  /** The CreateWorkflow tool call that started this run (the join key from the tool card to the detail page). */
  toolCallId?: ToolCallId | string;
  /**
   * The inputId of the turn that started the run: a sub-agent's `agent_step` is filed under this message. Only a direct hub launch fills it (the UUID v7 minted by
   * `startSavedWorkflowRun`, shared with the controlOnly launch turn); the chat path leaves it absent, and the run service
   * resolves it from the active turn of the parent runtime.
   */
  launchInputId?: string;
  /**
   * The phase table declared by the script (the named phases of the causal graph, in declaration order, ≤ 32 × 128; `createWorkflowPhaseNames`). The engine records it
   * together with the anchor in `run-launched`, and the sessions-index projection uses it to draw the ahead-of-stations on the sidebar mini track. Purely display metadata: it takes part neither in execution
   * nor in resume validation; absent when the script carries no `phase()` marker.
   */
  phaseNames?: string[];
  /**
   * This run's own concurrency ceiling: the number of asks in flight at the same time, landing in `dwf_run.caps_max_concurrency` and reused as-is by resume. **Absence means the ceiling** (the
   * machine-derived value of `resolveWorkflowConcurrencyCeiling`); when given it is clamped to
   * `[1, ceiling]` — it can only lower concurrency, never raise it. The tool layer has already clamped once in
   * `resolveInput` (the confirmation window has to show the value that actually takes effect); clamping again here is the port's own contract.
   */
  maxConcurrency?: number;
  /**
   * The model this run's sub-agents run on. It is the source of the canonical form recorded in the journal event
   * `run-launched` and reused by resume; **absence means inherit the model of the starting session**.
   *
   * What is taken is a structured {@link ModelSelection} rather than a string: the tool layer has **already** resolved the name the user said through the model catalog
   * once (if it could not be resolved it already fell back before the confirmation window), and the port should not do name matching a second time — that would give "where the resolution happens"
   * two answers. The main agent itself is unaffected: it always stays on the session model.
   */
  subagentModel?: ModelSelection;
  /**
   * The absolute path of the file this run's script **comes from**. It takes exactly the same route as {@link subagentModel}: recorded once with `run-launched`, never read by the engine,
   * zero SQL (there is no such column on `dwf_run`), and both read surfaces read it back from the event.
   *
   * ⚠ Unrelated to the artifacts' `sourcePath` in this file: that is where the artifact landed on disk, whereas this is the **script**'s home.
   *
   * Absence means this run has no editable script file (a project whose draft could not be written, a run started before the upgrade), so the model surface
   * falls back to the old "fix the script and submit it inline again". Purely model-surface metadata: neither desktop nor TUI ever displays it.
   */
  scriptPath?: string;
  /**
   * A "running alongside" table **positionally aligned** with {@link DynamicWorkflowRunSubmitRequest.phaseNames}
   * (`createWorkflowPhaseAlongside`): `phaseAlongside[i]` holds the **indices** of the other phases still running when `phaseNames[i]` is entered (the indices land in that same `phaseNames` table).
   * The sidebar mini track uses this to draw the two parallel stations as
   * a double segment.
   *
   * The same posture as `phaseNames`: purely display metadata, persisted with the anchor into `run-launched`, not read by the engine; when no phases run in parallel
   * the whole field is absent (absence means "this track is a straight line").
   */
  phaseAlongside?: number[][];
  trace: TraceContext;
}

export interface DynamicWorkflowRunSubmitOptions {
  signal?: AbortSignal;
}

/**
 * The result of submit. On success there is only a runId: it is at the same time the backgroundTaskId and the workId of cancelBackgroundWork
 * (runId ≡ taskId ≡ workId), so the three paths need no identity mapping tables of their own. A brand-new run has nothing that could be rejected:
 * wiring failures (corrupt compilation products, unusable journal) are still thrown.
 */
export type DynamicWorkflowRunSubmitResult = { ok: true; runId: string };

/**
 * The request of {@link DynamicWorkflowRunPort.amend}.
 *
 * A revision is a **supersede**: it mints a **new run** with the new script and imports from the predecessor's journal the "settled prefix of asks per named actor"
 * together with the world nodes as a cache. The predecessor **may still be in flight** — that is exactly why this method exists: the service first stops
 * it, waits for it to settle, then imports, then starts, completing all of it in one call, so the model no longer needs TaskStop + polling + resubmission as three steps. Fully orthogonal to
 * `scriptText`: a revision run re-declares the script; the actual arguments (only present for a saved source) do not travel across a revision.
 */
export interface DynamicWorkflowRunAmendRequest {
  scriptText: string;
  cwd: string;
  /** The predecessor run being revised. In any state. */
  predecessorRunId: string;
  /** The display name of the new run; when absent, the service keeps the predecessor's name. */
  name?: string;
  parentSessionId?: SessionId | string;
  /** The AmendWorkflow tool call that started this revision (the new run's tool card → detail page join key). */
  toolCallId?: ToolCallId | string;
  /** The declared phase table of the **new script**; the semantics are the same as {@link DynamicWorkflowRunSubmitRequest.phaseNames}. */
  phaseNames?: string[];
  /**
   * The new run's concurrency ceiling; the semantics are the same as {@link DynamicWorkflowRunSubmitRequest.maxConcurrency} (absence means the ceiling).
   * "Omitted means keep the predecessor's, `null` means clear it" is a **tool-surface** tri-state, normalized in the `resolveInput` of `AmendWorkflow`
   * into either a number or absence here — the confirmation window has to show the value carried over, so that rule can only live ahead of the handler.
   */
  maxConcurrency?: number;
  /**
   * The new run's sub-agent model; the semantics are the same as {@link DynamicWorkflowRunSubmitRequest.subagentModel} (absence means
   * inheriting the session model). "Omitted means keep the predecessor's, `null` means clear it" is a **tool-surface** tri-state, normalized in the `resolveInput` of `AmendWorkflow`,
   * together with one fresh resolution, into either a selection or absence here.
   */
  subagentModel?: ModelSelection;
  /**
   * The absolute path of the file the **new script** comes from; the semantics are the same as {@link DynamicWorkflowRunSubmitRequest.scriptPath}.
   *
   * Unlike the concurrency ceiling and the sub-agent model, it has **no tri-state**: a revision always records the file
   * *this* revision's script came from (a `path` submission is that file, an inline submission is the draft just written) and never inherits the predecessor's — the predecessor's path points at the
   * **old script**, and recording it on the new run would send the model off to edit a file that is no longer running.
   */
  scriptPath?: string;
  /**
   * The "running alongside" table of the **new script**; the semantics are the same as {@link DynamicWorkflowRunSubmitRequest.phaseAlongside}
   * (the indices land on this request's `phaseNames`, not on the predecessor's table).
   */
  phaseAlongside?: number[][];
  /**
   * The actual arguments the new run inherits from the predecessor's persisted `dwf_run.args_json`. Absence means the revision carries no arguments (the contract of the tool path is unchanged).
   * Only the GUI's "configure" passes it: what it re-runs is the predecessor's own script, and that script reads exactly the arguments that were present when the predecessor started; not inheriting them would re-run a saved workflow
   * that was started from the hub with arguments, using an empty `args`.
   */
  inheritArgs?: true;
  trace: TraceContext;
}

/**
 * The structured reason an amend was rejected. The two are **two different next steps** for the model (pick another run id / abandon the revision and do one
 * brand-new run), so they have to be distinguishable. The actionable wording lives in the tool layer; the port only carries the discriminant key.
 *
 * There is no "predecessor still in flight" case: an in-flight predecessor is stopped rather than rejected (the old `not_amendable` and the
 * race of "stop, then poll until stopped, then resubmit" that followed it are thereby gone).
 *
 * **Rejection means zero side effects**: the precheck runs to completion *before* the predecessor is stopped, so a rejection leaves no dwf_run row, no registry entry, and the
 * predecessor still running as before.
 */
export type DynamicWorkflowRunAmendRefusalReason =
  /** This predecessor run is not in the journal. */
  | "run_not_found"
  /** The predecessor has settled asks that lack message-boundary accounting, so truncating the imported transcript is out of the question (rejected wholesale, no degraded fallback). */
  | "missing_boundaries";

export type DynamicWorkflowRunAmendResult =
  | {
      ok: true;
      runId: string;
      /** The predecessor was in flight and was stopped by this revision (= predecessorRunId); absent when the predecessor settled long ago. */
      supersededRunId?: string;
    }
  | { ok: false; reason: DynamicWorkflowRunAmendRefusalReason };

/**
 * The initiator of the cancellation. `user` / `model` are the initiators of the two stop entry points; `{ superseded }` is what the amend path
 * passes when it stops an in-flight predecessor: the new run's id lands in the predecessor's settlement bag together with the reason (`supersededBy`).
 */
export type DynamicWorkflowRunCancelInitiator = "user" | "model" | { superseded: string };

/**
 * The run snapshot: it keeps the shape of {@link WorkflowTaskSnapshot} (the background task tracker and the notification pipeline read it that way) and only widens
 * `output` — the artifact of a workflow run is the script's top-level return value, whose shape the script decides, and not the output type of the legacy
 * `Workflow` tool. The legacy port itself is not widened (the two workflow mechanisms do not share a port).
 *
 * `reports` are the incremental artifacts handed over **as-is** by the script's `report(item)`, in report order, coming from the journal's
 * `kind = "report"` node rows — the persistent home of these entries (`workflowRuns.reports` is only a bounded
 * memory-only display surface). The completion notification delivers them unconditionally across the completed / failed / cancelled states:
 * a run that died on its 12th ask still finished the work of 11 asks, and salvaging exactly that is the reason `report` exists.
 */
export type DynamicWorkflowRunSnapshot = Omit<WorkflowTaskSnapshot, "output"> & {
  output?: unknown;
  /**
   * The true terminal word of the run. The base class's `status` is the background task
   * tracker's general vocabulary (`stopped` folds into `cancelled`, `errored` folds into `failed`), and the notification and tool wording
   * have to tell the truth, so they must read these two fields; `stopReason` is only present when `runStatus === "stopped"`.
   */
  runStatus?: DynamicWorkflowRunLifecycleStatus;
  stopReason?: DynamicWorkflowRunStopReason;
  /** The session that started this run (the journal's parent_session_id; taken from it when a registry entry is present). */
  parentSessionId?: string;
  /** Which run this run was revised from; absent when it is not a revision. */
  resumedFrom?: string;
  /** Which revision stopped and superseded this run; absent when it was not superseded. */
  supersededBy?: string;
  /**
   * This run's own concurrency ceiling (`dwf_run.caps_max_concurrency`), **present only when it is below the current ceiling**:
   * a run running at the ceiling has nothing to say ("absent when there is none", the same rule as `reports`). The
   * `resolveInput` of `AmendWorkflow` uses it to decide what to carry over when omitting `max_concurrency`.
   */
  maxConcurrency?: number;
  /**
   * The sub-agent model of this run (the one on the journal event `run-launched`), in the canonical form
   * `providerId/modelId[$reasoningLevel]`, **present only when it was set**: a run inheriting the session model has nothing to say
   * ("absent when there is none", the same rule as `maxConcurrency`). It is a string here rather than
   * {@link ModelSelection}: the read surface only uses it to display and to fill it back verbatim, and nobody takes a value off the field.
   */
  subagentModel?: string;
  /**
   * The script file of this run (absolute path, the one on the journal event `run-launched`). **Present only when this run recorded a file**.
   *
   * The terminal-state notification uses it to swap "fix the script and submit it inline again" for "edit that file in place, then amend with
   * `path`", so it must be readable from the snapshot; the user-facing surface never displays it (unlike `subagentModel`, which does reach desktop's run panel).
   */
  scriptPath?: string;
  /** The structured failure (the same source as {@link DynamicWorkflowRunDetail.error}); the base class's `error` is its message. */
  failure?: DynamicWorkflowRunError;
  /**
   * The **active** duration of this run and its lineage, in milliseconds: every generation of this run plus every generation of each predecessor, with the gaps between generations not counted. The completion card's "time" cell reports
   * exactly this.
   *
   * The same rule as `reports` / `artifacts`: **present only in a terminal state** (`getTask` is polled repeatedly, while the only consumer is the terminal-state
   * notification), and absent entirely when the journal has nothing to say — not 0. Absence means the read side falls back to `completedAt − startedAt`:
   * that is the one generation as the very process that settled it saw it, a more conservative but never inflated answer.
   */
  activeDurationMs?: number;
  reports?: readonly unknown[];
  /**
   * The escalation questions parked on this run right now, waiting for the main agent's answer.
   *
   * **Projected from the in-memory registry, not replayed from the journal**: the journal has both the `escalation-raised` and the
   * `escalation-resolved` event kinds, but "who still owes an answer now" is a live in-process fact — a replayed unpaired raise would
   * only lie after the process has died (the parked deferred vanished with the process, and resume makes the actor
   * ask again with a new qid).
   *
   * This is the **query fallback** after a notification has been dropped (stale branch generation / shutdown drop): the main agent can
   * rediscover the pending questions at any time through the existing observation surface. The whole field is absent at zero entries (no empty array is sent).
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * The **user-facing** artifacts published by this run, in first-appearance order, coming from
   * the journal's `kind = "artifact"` rows — the persistent home of the version history (`workflowRuns.artifacts` only carries the metadata of the latest version). The same
   * rule as `reports`: **read only in a terminal state** (`getTask` is polled repeatedly, while the consumers of the artifact rows
   * are the terminal-state notification and GetWorkflowRun); the whole field is absent when there are none.
   *
   * ⚠ Terminology: an artifact here is an output the script publishes to the user through `artifact.*`, and is unrelated to this type's `output` (the script's top-level return value,
   * called `RunSettlement.artifact` inside the engine).
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
};

/**
 * One version of a user-facing artifact (a JSON mirror of `ArtifactVersionRecord` on the journal's
 * `dwf_node.result_json`). **Deliberately re-declared here** rather than imported from @zcode/dynamic-workflow: the port carries only
 * the JSON shape (the same argument as {@link DynamicWorkflowRunLifecycleStatus}).
 *
 * A content artifact (`file` / `markdown`) fills `contentType` / `bytes` / `uri` / `sourcePath`; a preset dashboard
 * (`chart` / `table` / `metrics` / `board`) fills `spec`. The bytes are never here — `uri` points at the
 * tool-artifact store.
 */
export interface DynamicWorkflowRunArtifactVersion {
  version: number;
  title?: string;
  description?: string;
  contentType?: string;
  bytes?: number;
  uri?: string;
  sourcePath?: string;
  spec?: unknown;
  /** The moment of publication (epoch milliseconds). Always written by the driver. */
  publishedAt: number;
  /** This version belongs to the run's deliverable. */
  primary?: true;
}

/** The member kind of a user-facing artifact (the six members of the facade's `artifact.*`). */
export type DynamicWorkflowRunArtifactKind =
  | "file"
  | "markdown"
  | "chart"
  | "table"
  | "metrics"
  | "board";

/**
 * A user-facing artifact: all the versions under the id (ascending by version number) + the count of the tagged reports fed to it. The values of
 * `title` / `description` / `contentType` / `sourcePath` / `spec` are taken from the **latest version**, so that a reader who only cares
 * about "what is it now" does not have to dig through the versions itself.
 */
export interface DynamicWorkflowRunArtifact {
  id: string;
  kind: DynamicWorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  sourcePath?: string;
  spec?: unknown;
  /** The latest version number (= the version of the last entry of versions). */
  version: number;
  versions: readonly DynamicWorkflowRunArtifactVersion[];
  /** The number of `report` entries tagged with this id (the data volume of a preset dashboard; always 0 for content artifacts). */
  itemCount: number;
  /** The run's deliverable (at most one). The `artifacts` manifest is led by it, the rest follow in first-publication order. */
  primary?: true;
}

/** One `report` entry fed to a preset artifact, located by journal sequence (the fetching surface of dashboards). */
export interface DynamicWorkflowRunArtifactItem {
  sequence: number;
  siteId: string;
  ordinal: number;
  item: unknown;
}

/** The paging bag of {@link DynamicWorkflowRunPort.listArtifactItems} (cursor = journal sequence, strictly greater). */
export interface DynamicWorkflowRunArtifactItemPage {
  afterSequence?: number;
  /** Required; the caller may pass "limit + 1" to probe hasMore, the implementation must not clamp again. */
  limit: number;
}

/** The return of {@link DynamicWorkflowRunPort.readArtifact}: all the bytes of one version. */
export interface DynamicWorkflowRunArtifactBytes {
  bytes: Uint8Array;
  contentType: string;
}

/** A parked escalation question. Its fields share their source with the `escalation-raised` event, plus the moment the question was asked. */
export interface DynamicWorkflowRunPendingQuestion {
  /** The globally unique question id (of the form `dwfq-<runId fragment>-<seq>`); `resolveQuestion` recognizes only it. */
  qid: string;
  /** The actor asking, in `refToString` form (such as `actor#1@1`). Always present, and uniquely located within the run. */
  actor: string;
  /**
   * The human-readable name of this actor (the `"poet"` of `agent("poet")` in the script).
   *
   * **An anonymous actor leaves this field absent, and no fallback label is synthesized here**: the fallback is a rendering decision, and the notification surface and the sidebar each
   * have their own fitting wording (one has to read as a sentence, the other has to fit into a column). Synthesizing an "actor#1@1" as a name here would only rob both
   * consumers of the fact that this actor has no name at all.
   */
  actorName?: string;
  question: string;
  /** The context the actor added (`escalate`'s optional `context`). */
  context?: string;
  /** The moment the question was asked (epoch ms). The main agent uses it to judge "how long has this question already been waiting". */
  askedAt: number;
}

/**
 * The structured reason {@link DynamicWorkflowRunPort.resolveQuestion} was rejected. The three are **three different
 * next steps** for the model, so they have to be distinguishable: fetch the right id from the snapshot / do nothing at all / this run no longer needs an answer.
 */
export type DynamicWorkflowResolveQuestionRefusalReason =
  /** This qid is not in the registry: it was mistyped, or it is a stale id from a process that has died (parked entries are not persisted). */
  | "unknown_question"
  /** This question has already been answered, and the actor moved on long ago with that answer. */
  | "already_resolved"
  /** The run / ask the qid belongs to is no longer in flight (cancelled, failed or already finished), so nobody is waiting for this answer. */
  | "run_not_in_flight";

/**
 * The structured result of `resolveQuestion`. Failure goes through reason rather than throw, the same
 * argument as {@link DynamicWorkflowRunSubmitResult}: all three reasons are business branches the caller can anticipate.
 *
 * `message` is written on the implementation side (stating the situation and the next step) rather than left for the tool layer to assemble: the discriminant key and the
 * wording are maintained separately, the two will eventually say different things, and the reader here is the model — what it reads is its next step.
 */
export type DynamicWorkflowResolveQuestionResult =
  | { ok: true; qid: string }
  | { ok: false; reason: DynamicWorkflowResolveQuestionRefusalReason; message: string };

export interface DynamicWorkflowRunWaitOptions {
  signal?: AbortSignal;
}

/** The paging parameters of the event log; cursor = journal sequence (allocated monotonically by appendEvent). */
export interface DynamicWorkflowRunEventPage {
  /** Only events whose sequence is strictly greater than that value; by default, reads from the beginning. */
  afterSequence?: number;
  limit?: number;
}

/**
 * The **protocol form** of one run event: sequence + event kind + JSON payload.
 *
 * Deliberately not reusing the engine's `RunEvent`: that is the domain package's (@zcode/dynamic-workflow) vocabulary, and importing it
 * into contracts would make every layer that holds the port depend at compile time on the engine's internal types. The port carries only the
 * JSON shape, `type` is an opaque string, and `payload` is interpreted on demand by the reading end.
 */
export interface DynamicWorkflowRunEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  /** The payload has been trimmed by {@link boundDynamicWorkflowRunEventPayload} (the raw facts are still in the journal). */
  truncated?: boolean;
}

/**
 * The bounds of a run event payload. **Every payload on the protocol boundary is bounded**, and the engine's events have two naturally
 * unbounded fields: the `persona.system` of `actor-created` (an entire system prompt) and the `finalText` of a
 * node-level error (an entire turn of model output). They should not be let through on a "it is probably not that long" basis.
 *
 * The bounds are **structural** (string length / array length / key count / depth) rather than a total byte count: a structural bound can be applied field by field in place,
 * without serializing first and falling back, and it does not lose all the other fields because of one huge field.
 */
export const DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS = {
  maxStringLength: 2_048,
  maxArrayItems: 32,
  maxKeys: 32,
  maxDepth: 6,
} as const;

/**
 * Trims one run event's payload to within {@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS},
 * and along the way normalizes it into a **JSON-serializable** shape.
 *
 * Two consumers share this single serialization:
 *   1. the event page returned by `listEvents` (the event log of the detail page);
 *   2. the `dynamic_workflow_run_progress` session event appended to the parent session (→ the `workflowRuns` projection).
 *
 * The normalization is not optional incidental work but a requirement: every non-finite number (`Infinity` / `NaN`) becomes `null` through `JSON.stringify` —
 * which would mean "the same payload is not equal before and after being persisted". Rather than have every reading end face that inconsistency on its own,
 * it is folded into `null` once here, so that the return value satisfies the structural identity `JSON.parse(JSON.stringify(x)) === x`.
 */
export function boundDynamicWorkflowRunEventPayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  truncated: boolean;
} {
  let truncated = false;
  const markTruncated = (): void => {
    truncated = true;
  };
  const bounded = boundJsonValue(payload, 0, markTruncated);
  return {
    payload: isJsonRecord(bounded) ? bounded : {},
    truncated,
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive trimming. Returning `undefined` means the value cannot be carried (the caller omits it from the object/array). */
function boundJsonValue(value: unknown, depth: number, markTruncated: () => void): unknown {
  const limits = DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS;

  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    // Infinity / NaN are not legal JSON numbers; collapse to null instead of letting JSON.stringify do the work secretly.
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    if (value.length <= limits.maxStringLength) return value;
    markTruncated();
    return truncateSurrogateSafe(value, limits.maxStringLength);
  }
  if (typeof value !== "object") {
    // undefined / function / symbol / bigint: Omitted (bigint is not JSON serializable).
    return undefined;
  }

  if (depth >= limits.maxDepth) {
    markTruncated();
    return undefined;
  }

  if (Array.isArray(value)) {
    const items =
      value.length > limits.maxArrayItems ? value.slice(0, limits.maxArrayItems) : value;
    if (items.length < value.length) markTruncated();
    const out: unknown[] = [];
    for (const item of items) {
      const boundedItem = boundJsonValue(item, depth + 1, markTruncated);
      // Holes in the array change the subscript semantics, so unbearable elements are null rather than skipped.
      out.push(boundedItem === undefined ? null : boundedItem);
    }
    return out;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const kept = entries.length > limits.maxKeys ? entries.slice(0, limits.maxKeys) : entries;
  if (kept.length < entries.length) markTruncated();
  const out: Record<string, unknown> = {};
  for (const [key, item] of kept) {
    const boundedItem = boundJsonValue(item, depth + 1, markTruncated);
    if (boundedItem !== undefined) out[key] = boundedItem;
  }
  return out;
}

/**
 * Truncation by UTF-16 code units, but it never leaves a lone surrogate behind — that is neither valid text nor something downstream JSON codecs
 * accept on some runtimes. When the cut lands in the middle of a surrogate pair, it is better to drop one code unit.
 */
function truncateSurrogateSafe(value: string, maxLength: number): string {
  const cut = value.slice(0, maxLength);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}

/**
 * Any script value in a workflow run (the artifact returned at the top level, the entries of `report(item)`) → the text shown to the model or the reader. The implementation has moved into
 * `@zcode/shared/zcode-protocol-v4` along with the shared workflowRuns reducer (workflow-artifact.ts; the rules and their provenance are in the
 * comments over there): the reduction of `reports[].preview` became a fourth consumer once it moved down to shared, and the
 * dependency direction is contracts → shared, so the function had to move with it. A re-export is kept here,
 * so that the three existing consumers (the completion notification, TaskOutput's resultText, the v4 projection) need not change a single line.
 */
export { serializeWorkflowArtifact } from "@zcode/shared/zcode-protocol-v4";

/**
 * The narrow port of a workflow run. Side by side with legacy {@link import("./workflow.port.js").WorkflowPort} rather than
 * merged: the latter serves the `Workflow` tool and the legacy `workflow_*` table, and sharing one port would recouple right at the interface layer the
 * boundary of "independent of the existing workflow mechanism".
 *
 * Cancellation has no dedicated RPC: the button on the detail page and the stop of the background panel share the existing v4 `cancelBackgroundWork`
 * command, which lands on {@link cancel} here (runId ≡ workId).
 */
export interface DynamicWorkflowRunPort {
  /** Compiles once and starts the engine; returns the runId (i.e. the backgroundTaskId). */
  submit(
    request: DynamicWorkflowRunSubmitRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunSubmitResult>;
  /**
   * Revises a run: precheck the predecessor → mint a new id → if the predecessor is in flight, cancel it with `{ superseded: newRunId }` and wait for it to settle
   * → import the cache from the predecessor → start the new run (see {@link DynamicWorkflowRunAmendRequest}). A rejected precheck is a
   * structured failure and **nothing has been touched**. Old hosts may not have this method (an optional member): the tool layer normalizes by capability probe into
   * "this session does not support revisions".
   */
  amend?(
    request: DynamicWorkflowRunAmendRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunAmendResult>;
  /**
   * The ceiling for a run's own concurrency ceiling (`max(1, min(16, availableParallelism() − 2))`, one value per process). Synchronous, without side effects.
   *
   * Two readers in the tool layer: the `resolveInput` of `CreateWorkflow` / `AmendWorkflow` clamps the model's
   * `max_concurrency` below it (what the confirmation window shows must be the value that will take effect), and `GetWorkflowRun` uses it to decide
   * whether a run's ceiling is worth mentioning. **Optional member** (consumers probe it with `typeof`): a port stub need not be carried along for it,
   * and when it is absent the tool layer does not clamp and passes the value through as-is (the port implementation clamps once more itself).
   */
  concurrencyCeiling?(): number;
  /**
   * Change in place the concurrency ceiling of an **in-flight** run itself: the same runId, no successor minted, no supersede, no cache import, not one in-flight ask lost.
   *
   * Side by side with {@link amend} rather than merged: a revision swaps the **script**, at the price of stopping the predecessor, minting a new run and replaying from the cache;
   * whereas "just slow this one run down a bit" should not have to pay that bill. Two callers (the handler of `AmendWorkflow` and the GUI's
   * `amendWorkflowRunSettings`) read the same answer, so "what counts as a retune" has exactly one definition.
   *
   * Three things happen inside one synchronous slice or none of them happens: swapping the engine's caps (which the scheduler now reads), writing
   * `dwf_run.caps_max_concurrency` (so that resume continues under the new ceiling), and recording one `run-caps-changed`.
   * The service also moves its own in-memory ceiling along, so that the snapshot, the detail and `GetWorkflowRun` report the new value immediately.
   *
   * **Optional member** (consumers probe it with `typeof`), for the same reason as {@link resume}: a port stub need not have the whole control plane carried along for one call, and
   * "the port is absent" and "the method is absent" are the same business fact for the caller — falling back to a real revision.
   */
  retuneConcurrency?(
    request: DynamicWorkflowRunRetuneRequest,
  ): Promise<DynamicWorkflowRunRetuneResult>;
  getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined>;
  waitForTask(
    taskId: string,
    options?: DynamicWorkflowRunWaitOptions,
  ): Promise<DynamicWorkflowRunSnapshot | undefined>;
  /**
   * Stops a run: aborts the in-flight asks and kills the child processes, and the run settles as `stopped(initiator)`. `initiator`
   * defaults to `user`; when the main agent stops it via TaskStop, `model` is passed (the reason is persisted from then on and no longer lives only inside the background task registry); the amend path passes `{ superseded: newRunId }`.
   * An unknown runId returns false.
   */
  cancel(runId: string, initiator?: DynamicWorkflowRunCancelInitiator): Promise<boolean>;
  /** Pages through the event log by cursor; an out-of-range cursor returns an empty page rather than an error. */
  listEvents(
    runId: string,
    options: DynamicWorkflowRunEventPage,
  ): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * Enumerates runs by project (cwd), the most recently updated first. Serves the `ListWorkflowRuns` tool.
   *
   * **Optional member**, following the precedent set before {@link cancel} (consumers probe it with `typeof`): an implementation only provides it when the journal
   * carries the introspection queries, and the existing port stubs need not be carried along for a read-only enumeration surface either. Consumers give
   * "the port is absent" and "the method is absent" the same business failure — for the model these are the same thing (this session has no such capability).
   */
  listRuns?(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult>;
  /**
   * The detail of a single run (progress summary + artifacts / failure). Serves the `GetWorkflowRun` tool. An unknown runId returns
   * `undefined` (consumers normalize it to `run_not_found`), and there are **no wait/block semantics** — waiting is the
   * job of {@link waitForTask}, this is an instant snapshot. Optional member for the same reason as {@link listRuns}.
   */
  getRunDetail?(runId: string): Promise<DynamicWorkflowRunDetail | undefined>;
  /**
   * The original script text of the run archive (`dwf_run.script_text`, the very bytes resume replays), byte for byte, without any processing.
   * `AmendWorkflow` reads it in two places: filling the predecessor's script back into the
   * arguments when the script is omitted, and the `script_unchanged` precheck of a `path` amendment —
   * and that has to compare bytes rather than hashes, because what the tool side reads is the file content, not a compilation product. The GUI's "configure" takes the same read path.
   *
   * A read surface of its own rather than a field of {@link DynamicWorkflowRunSnapshot}: the snapshot is polled repeatedly by the background tracker, while the
   * script is by far the largest string on the port (the same reason as {@link DynamicWorkflowRunSummary.label}). Both an unknown run
   * and "the record has no script" (a run from before that field was persisted) return `undefined` — the same fact for the caller: there is no script
   * to carry over. Read-only, and it does not care whether the service has shut down. **Optional member** (consumers probe it with `typeof`), for the same reason as {@link listRuns}:
   * when it is absent, an amendment that omits the script fails on the spot, while the `script_unchanged` precheck is skipped (it is a net, not a door).
   */
  getScript?(runId: string): Promise<string | undefined>;
  /**
   * Resumes a run that was cancelled / interrupted by process death: rerun it under the same runId (the engine takes the resume branch, a journal
   * hit short-circuits and the unfinished nodes are dispatched again). The gate is on the implementation side: only a run that is `cancelled` or `failed` with the failure encoded
   * as `Interrupted` is resumable.
   *
   * **Optional member**, following the cancel precedent from before {@link listEvents} (consumers probe it with `typeof`):
   * a port stub need not be carried along for the resume surface either; for a consumer, "the port is absent" and "the method is absent" are the same business failure.
   */
  resume?(runId: string): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * Enumerates the run summaries under **this service's parent session** (most recently updated first, journal-backed). The UI's after-restart discovery surface:
   * the `workflowRuns` projection does not survive across processes, and the tool card join and the availability of the Resume button can only be restored from here.
   * Deliberately no parentSessionId parameter — the service instance is constructed per parent session in the first place (per-app), and letting a caller pass an arbitrary
   * session would open a cross-session read hole. Optional member for the same reason as {@link resume}.
   */
  listRunsForSession?(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * Cold replay: replay from the journal, as progress event payloads, the runs under **this service's parent session** that this
   * process has not run — exactly the **same kind** of payload and the same minting chain as what `onRunEvent` hands over while live; cold materialization
   * feeds them to the same reducer as in-memory events, so the `workflowRuns` projection is byte for byte identical before and after a restart.
   *
   *   - The bound is the same as the projection's eviction (the 8 most recently updated ones), with the oldest run first;
   *   - `excludeRunIds`: runs the caller already has events for in memory (run / running in this process) are not replayed;
   *   - A row that is terminal but whose event stream has no `run-settled` (a row rewritten by orphan convergence after process death) gets one
   *     appended **in-memory** synthetic settle payload (carrying the row's status / failure / resumable), which is never written into the journal.
   *
   * Optional member for the same reason as {@link listRunsForSession}: an in-memory journal has no enumeration surface,
   * so there is nothing to restore.
   */
  replayProgressForSession?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * Answers a blocking question that an actor escalated. Serves the
   * `ResolveWorkflowQuestion` tool.
   *
   * Only one opaque token is taken instead of a `(runId, qid)` pair: a qid is globally unique (across runs), and with several runs in flight, making the model
   * pair them itself is a breeding ground for mismatches. The answer becomes the tool result of that actor's `escalate` call as-is,
   * and the actor's turn continues right after; the run's state never moves (an escalation is a slow tool call inside an ask,
   * not a run lifecycle event).
   *
   * **Optional member**, following the precedent of {@link resume} (consumers probe it with `typeof`): a port stub need not be carried along for an
   * answering surface either; for a consumer, "the port is absent" and "the method is absent" are the same business failure.
   */
  resolveQuestion?(qid: string, answer: string): Promise<DynamicWorkflowResolveQuestionResult>;
  /**
   * The manifest of this run's user-facing artifacts (the journal `kind = "artifact"` rows grouped by id, ascending by version). The durable read for the UI's cold recovery and the hub's detail page.
   * An unknown runId returns `undefined`. **Optional member**, for the same reason as {@link listRuns} (provided only when the journal
   * carries the artifact read surface; consumers probe it with `typeof`).
   */
  listArtifacts?(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * The `report` entries fed to a preset artifact, paged in ascending journal sequence (the fetching surface of dashboards).
   * An out-of-range cursor returns an empty page rather than an error. Optional member, for the same reason as {@link listArtifacts}.
   */
  listArtifactItems?(
    runId: string,
    artifactId: string,
    page: DynamicWorkflowRunArtifactItemPage,
  ): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  /**
   * Reads the bytes of one artifact version: **first** confirm in the journal that a `completed` row exists for
   * `(runId, artifactId, version)`, then fetch through the tool-artifact store by the `uri` on that row — no id passed in by the caller ever becomes
   * a path directly. No such version / not a content artifact /
   * store absent → `undefined`. Chunking belongs to the gateway (v4 `workflowRunArtifactRead`, ≤ 512 KiB per chunk).
   * Optional member, for the same reason as {@link listArtifacts}.
   */
  readArtifact?(
    runId: string,
    artifactId: string,
    version: number,
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * The workspace transcript of this run: the journal's
   * `kind ∈ {world-read, world-run}` rows in the order they were persisted, **without their bodies**.
   *
   * The authorization chain is the same one as {@link readArtifact}: the run must belong to this service's parent session, otherwise `undefined`
   * (the same answer as "no such run" — an unauthorized caller is not told which half of its guess was right). Bodies may contain workspace file
   * content, so the manifest does not let other sessions through either. Optional member, for the same reason as {@link listArtifacts}.
   */
  listWorkspaceNodes?(
    runId: string,
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  /**
   * The body of one workspace node, shape-preservingly bounded by `maxBytes`. The authorization chain is the same as {@link listWorkspaceNodes};
   * no such node / not a world row / not your run → `undefined`. Optional member, for the same reason as {@link listArtifacts}.
   */
  readWorkspaceNodeResult?(
    runId: string,
    siteId: string,
    ordinal: number,
    query: DynamicWorkflowRunWorkspaceNodeResultQuery,
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
}

// ————————————————————————————————————————————————————————————————
// run introspection (the access side of ListWorkflowRuns/GetWorkflowRun)
// ————————————————————————————————————————————————————————————————

/**
 * The lifecycle status of the run. Its literals are the same set as the journal's `dwf_run.status`, but it is **deliberately re-declared
 * here** rather than imported from @zcode/dynamic-workflow: the port carries only the JSON shape, and once the engine's vocabulary enters
 * contracts, every layer that holds the port depends at compile time on the engine's internal types (the same argument as the `type` of
 * {@link DynamicWorkflowRunEvent}).
 *
 * Deliberately different from the status of {@link DynamicWorkflowRunSnapshot}: the latter is the background task tracker's vocabulary
 * and folds `pending` into `running`. The introspection surface has to keep `pending` — "submitted, the engine has not created the row yet" is a
 * distinction a model can understand and that carries meaning.
 */
export type DynamicWorkflowRunLifecycleStatus =
  | "completed"
  | "errored"
  | "pending"
  | "running"
  | "stopped";

/**
 * The reason behind `stopped`: `user` user cancellation / `model` the main agent's
 * TaskStop / `provider` a deterministic model-side error / `interrupted` the holding process died or the sandbox broke / `superseded`
 * stopped and superseded by an AmendWorkflow. The first four are resumable, `superseded` is not (its successor is the live one);
 * `errored` (a script error) is not either. The literals are the same set as the engine's `RunStopReason`, deliberately re-declared here.
 */
export type DynamicWorkflowRunStopReason =
  | "user"
  | "model"
  | "provider"
  | "interrupted"
  | "superseded";

/** The query bag of {@link DynamicWorkflowRunPort.listRuns}. */
export interface DynamicWorkflowRunListQuery {
  /**
   * The project key, **required**. The literal matches `dwf_run.cwd` by equality (the write side stores it as-is, the read side queries it as-is).
   * The port does not guess a default cwd for the caller: the tool surface always queries `context.workingDirectory`, and the model has no right to scan the store across projects.
   */
  cwd: string;
  /** The cap on the number of returned entries, **required**. The clamping policy belongs to the tool surface ([1, 50]); the port does no unbounded enumeration. */
  limit: number;
  /** An optional subset of statuses. The default means no filtering; an empty array means "matches no status" (returns an empty list). */
  statuses?: readonly DynamicWorkflowRunLifecycleStatus[];
}

/**
 * The cross-section **shared** by list and detail. Labels, ownership annotation and timestamps must be field-for-field identical on the two read
 * surfaces — the same run showing a different name or a different owner in the list and in the detail is precisely the kind of
 * inconsistency that is hardest to catch with a test and that most directly damages trust.
 */
export interface DynamicWorkflowRunSummary {
  runId: string;
  /**
   * The display label. **Already cooked**: the implementation side (the run service) derives it in the order name → the script's first line → runId, and
   * consumers just display it. The reason the raw ingredients (name / scriptText) are not handed out for the tool layer to assemble itself: that fallback
   * chain is a read-time heuristic, and two tools assembling it once each would drift apart, while scriptText is the largest string
   * on the port (a list surface should never move 50 scripts across the boundary just to get a first line).
   */
  label: string;
  /** The source of the label: `"name"` = a name given by the user; `"script"` = derived at read time from the script (with runId as the fallback). */
  labelSource: "name" | "script";
  status: DynamicWorkflowRunLifecycleStatus;
  /** Present only when `status === "stopped"`. */
  stopReason?: DynamicWorkflowRunStopReason;
  /** Which run this run was revised from (`dwf_run.resumed_from`); absent when it is not a revision. */
  resumedFrom?: string;
  /** Which revision stopped and superseded this run (the settlement bag of `stopped(superseded)`); absent when it was not superseded. */
  supersededBy?: string;
  /** Whether this session is the originator of this run (the journal's parent_session_id matches, or it is in this session's registry). */
  ownedByThisSession: boolean;
  /**
   * "This session cannot prove that it is still alive": the journal is non-terminal ∧ it is not this session's ∧ it is not in this session's registry. It may be a dead process's
   * leftover, or it may be a run in flight from a sibling session of the same process — so this is an **annotation rather than a rewrite of the status**, and a read surface never
   * buries someone else (the right to run orphan convergence belongs solely to the construction moment of the owning session). Present only when it is true.
   */
  possiblyInterrupted?: boolean;
  /** The journal's `time_created` / `time_updated` (epoch ms). */
  createdAt: number;
  updatedAt: number;
}

/** An entry of the list: the shared cross-section + usage. Deliberately light — no actors, no node counts, no artifact previews. */
export interface DynamicWorkflowRunListItem extends DynamicWorkflowRunSummary {
  /** Read straight from `dwf_run.spent_tokens` (the sole authority for run-level token usage). */
  spentTokens: number;
}

/**
 * The return of `listRuns`. Deliberately an object rather than a bare array: page-level fields (such as {@link truncated}) are purely additive
 * changes, whereas a bare array can only change its shape wholesale.
 */
export interface DynamicWorkflowRunListResult {
  runs: DynamicWorkflowRunListItem[];
  /**
   * This project has more runs that did not make it into this page. **Present only when it is true**.
   *
   * The criterion is "fetch one row more" (the implementation queries by `limit + 1` and then falls back), not `length === limit`: the latter
   * misfires when the count is exactly the limit, and a misfire sends the model chasing a page of history that does not exist. The same convention
   * has already been used once for the event paging of the v4 gateway (`hasMore`).
   */
  truncated?: boolean;
}

/**
 * The run's progress and usage (an observation surface, with no cap at all). `nodesObserved`
 * is the **number of the persisted node rows** (the sum of the three states) and never pretends to be the "total step count": a dynamic workflow has
 * no static total, and `queued` only exists in the event phase and is never persisted.
 */
export interface DynamicWorkflowRunUsage {
  spentTokens: number;
  nodesObserved: number;
  nodesRunning: number;
  nodesCompleted: number;
  nodesFailed: number;
}

/** One actor station instance. `persona` is deliberately absent: an entire system prompt is a field naturally unbounded on the port. */
export interface DynamicWorkflowRunActor {
  siteId: string;
  ordinal: number;
  name?: string;
}

/** One `log()` narrative. */
export interface DynamicWorkflowRunLogEntry {
  sequence: number;
  /** Already bounded by the port's string cap ({@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS}). */
  message: string;
  /**
   * The moment this event landed in the journal (`dwf_event.time_created`). The sequence locates, the moment answers "how long ago" —
   * all three field groups of the situation snapshot measure age with that very ruler, and the narrative tail has no reason to use another one. **Absent on old
   * journals that have no such column**, and the read side gives no age because of it, never falling back to a read-time `Date.now()`.
   */
  at?: number;
}

/** The structured failure. `code` is the stable discriminant key — the model must be able to tell "the process died" apart from "the script really failed". */
export interface DynamicWorkflowRunError {
  code: string;
  message: string;
  /** Present only when `code === "ProviderStop"` (a JSON mirror of the engine's `ProviderStopDetails`). */
  providerStop?: DynamicWorkflowRunProviderStop;
}

/** The structured detail of a `ProviderStop` (a mirror of the engine's `ProviderStopDetails`; the port carries only the JSON shape). */
export interface DynamicWorkflowRunProviderStop {
  kind: "auth" | "not_configured" | "model_unavailable" | "invalid_request" | "quota" | "other";
  reason: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  providerCode?: string;
  subagent?: string;
  subagentName?: string;
  phase?: string;
  rawMessage?: string;
  resetAt?: number;
}

// The type of situation section (stage/subagent/health) lives in dynamic-workflow-run-roster.port.ts (ditto),
// Export here as it is to keep the import path of `@zcode/contracts` unchanged.
export type * from "./dynamic-workflow-run-roster.port.js";

// The three types of retune (in-place changes to the concurrency upper bound of run) live in dynamic-workflow-run-retune.port.ts,
// Export the same as above.
export type * from "./dynamic-workflow-run-retune.port.js";

// The six types of workspace transcript live in dynamic-workflow-run-workspace.port.ts, and then export them as above.
export type * from "./dynamic-workflow-run-workspace.port.js";

/** The detail of a single run: the shared cross-section + progress + the situation cross-section + the artifacts / failure branching on the terminal state. */
export interface DynamicWorkflowRunDetail extends DynamicWorkflowRunSummary {
  usage: DynamicWorkflowRunUsage;
  /**
   * This run's own concurrency ceiling, with the same semantics as {@link DynamicWorkflowRunSnapshot.maxConcurrency}: present only when it is below the current
   * ceiling. Deliberately kept out of {@link DynamicWorkflowRunSummary} — a list row should not be widened for a rarely set field.
   */
  maxConcurrency?: number;
  /**
   * The sub-agent model of this run, with the same semantics as {@link DynamicWorkflowRunSnapshot.subagentModel}: present only when it
   * was set. For the same reason as `maxConcurrency` it is kept out of {@link DynamicWorkflowRunSummary} — a list row should not be
   * widened for a rarely set field.
   */
  subagentModel?: string;
  /**
   * The script file of this run, with the same semantics as {@link DynamicWorkflowRunSnapshot.scriptPath}: present only when a file was
   * recorded. `GetWorkflowRun` uses it to word the next step inside `<amendable>` as "edit this file in place".
   */
  scriptPath?: string;
  actors: DynamicWorkflowRunActor[];
  /** The tail of the `log()` events, in chronological order (sequence ascending). An empty array when there are no log events. */
  logTail: DynamicWorkflowRunLogEntry[];
  /**
   * The phase table: the declared phases in declaration order, followed by the ones that
   * were entered but never declared
   *
   * **The whole field is absent when the script declared no phases and none was ever entered** — such a run has no phases at all, and emitting an empty array reads like "the phase table is empty", which is a different statement.
   */
  phases?: DynamicWorkflowRunPhaseView[];
  /**
   * The roster of the sub-agents, in the order of the actor rows (= the minting order). **Always present**, and a run with not a single actor is an empty
   * array: unlike `phases`, "how many sub-agents does this run have" is always a question that has an answer, and 0 is that answer.
   *
   * Deliberately not merged with the `actors` next to it: `actors` is a constant identity table (siteId / ordinal / name), which consumers already join
   * against; every entry here is a **read-time snapshot**, and reading the same run a second later already gives a different answer.
   */
  subagents: DynamicWorkflowRunSubagentView[];
  /** Whether the run as a whole is still moving (see {@link DynamicWorkflowRunHealth}). Always present. */
  health: DynamicWorkflowRunHealth;
  /**
   * The top-level return value of the script, **as-is** (not serialized). Present only for a completed run; an `undefined` artifact
   * means the whole field is absent.
   *
   * Why it is not serialized here: the model-facing text projection already has a single implementation (core's
   * `serializeWorkflowArtifact`, shared by the completion notification and TaskOutput). If the port did it a second time, there
   * would be "the artifact of the same run looks different in the notification and in this tool" — exactly the loss category
   * that the sharing exists to exclude. So the serialization stays in core and the port only carries the raw value to the boundary.
   */
  result?: unknown;
  /** Always present for errored; for stopped only for provider / interrupted. The code is passed through as-is, not folded. */
  error?: DynamicWorkflowRunError;
  /**
   * The escalation questions parked on this run right now, waiting for the main agent's answer.
   *
   * **The same source and the same projection** as {@link DynamicWorkflowRunSnapshot.pendingQuestions} (both read the in-process
   * escalation parking table, both omit the whole field at zero entries), only the read surface differs: the snapshot serves the background task tracker, while this field serves
   * `GetWorkflowRun` — and the latter is the **only discovery surface on the model side**. This link is not optional icing: escalation notifications
   * have two known drop paths (stale branch generation / shutdown), the query is the fallback for those two paths, and the `unknown_question` wording of `resolveQuestion` explicitly
   * sends the model here to find the qid. Without it, both of those promises would point at a tool that returns nothing at all.
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * The user-facing artifacts of this run (attached in any state; journal-backed, the same source as {@link DynamicWorkflowRunSnapshot.artifacts}).
   * `GetWorkflowRun` uses this to tell the model "these have already been presented to the user as cards, just refer to them by title".
   * The whole field is absent when there are none.
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
}

/** The structured failure reason of {@link DynamicWorkflowRunPort.resume}. */
export type DynamicWorkflowRunResumeErrorReason =
  /** This run is not in the journal. */
  | "not_found"
  /** The run is not in the resumable set (completed or errored; only stopped is resumable). */
  | "not_resumable"
  /** The run was stopped and superseded by an AmendWorkflow: the live one is the successor, and replaying it means doing the same thing twice. */
  | "superseded"
  /** A run under the same runId is in flight within this process. */
  | "already_running"
  /** The record lacks scriptText (a run from before that field was persisted), so there is no script to rerun. */
  | "script_missing"
  /** The recorded scriptHash disagrees with the one recomputed from scriptText (the record itself was rewritten by an outside force). */
  | "script_mismatch"
  /**
   * The recorded scriptText no longer type-checks under the **current** facade (an old run from before the facade refactor). Replaying it verbatim
   * would only fail; the way out is to rewrite the script for the current facade and then go through AmendWorkflow. `message` carries bounded diagnostics.
   */
  | "compile_failed";

/**
 * The structured result of resume. Failure goes through reason rather than throw: all five reasons are business branches the caller can
 * anticipate (flow control branches on the error code rather than on the error text, house rule), and throw is reserved for genuine wiring failures.
 */
export type DynamicWorkflowRunResumeResult =
  | { ok: true; runId: string; toolCallId?: string }
  | { ok: false; reason: DynamicWorkflowRunResumeErrorReason; message?: string };

/**
 * The run summary of {@link DynamicWorkflowRunPort.listRunsForSession}. Its literals are the same set as the journal's
 * `dwf_run.status`, but they are **deliberately re-declared here**: the port carries only the JSON shape, and once the engine's vocabulary
 * enters contracts, every layer that holds the port depends at compile time on the engine's internal types.
 */
export interface DynamicWorkflowRunSessionSummary {
  runId: string;
  /** The id of the CreateWorkflow tool call that started the run (the join key from the tool card → detail page / Resume); absent for old runs. */
  toolCallId?: string;
  /**
   * The display label, derived on the server at read time (`name` → the script's first line → runId, see the
   * `resolveDynamicWorkflowRunLabel` in bootstrap). It is optional for **skew safety**: an old server does not send this key, and
   * the read side just falls back to runId — one label missing from a list is degradation, not an error.
   *
   * It is centralized on the server for the same reason as `resumable`: with each of the two assembling the fallback once, the same run
   * would show a different name in `/dwf list` and on the tool card.
   */
  label?: string;
  /**
   * The last update time (epoch milliseconds, coming from the journal's `dwf_run.time_updated`). Optional for the same reason:
   * absent on old servers, and the read side shows no time column. List ordering is still the storage layer's responsibility (most recently updated
   * first), and this field is for display only — the read side must not re-sort by it, or it will drift from the server's tie-break.
   */
  updatedAt?: number;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  /** Present only when `status === "stopped"`. */
  stopReason?: DynamicWorkflowRunStopReason;
  /** Which run this run was revised from; absent when it is not a revision. */
  resumedFrom?: string;
  /** Which revision stopped and superseded this run; absent when it was not superseded. */
  supersededBy?: string;
  /** The structured failure code of errored / stopped(provider|interrupted) (`ProviderStop` / `Interrupted` ...). */
  failureCode?: string;
  failureMessage?: string;
  /**
   * Whether it is resumable. **Computed on the server by the very predicate of the resume gate**: if the UI re-derived it
   * itself from status+failureCode, the two predicates would disagree one day — a lit button with a rejected command.
   */
  resumable: boolean;
}
