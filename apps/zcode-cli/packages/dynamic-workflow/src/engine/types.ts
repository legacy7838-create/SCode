/**
 * The boundary types of the execution engine.
 *
 * This module is a vocabulary of pure types + structured errors + constants, and all three boundaries are contracted against it:
 * - Boundary A (host API): the sandbox script's facade shim calls {@link WorkflowHostApi}.
 * - Boundary B (driver port): the engine core (a deterministic state machine) drives {@link WorkflowDriver} downward,
 *   and the driver reports progress upward through {@link WorkflowReportSink}.
 * - Journal: {@link JournalStorePort} exposes run/actor/node/event records through repository-style methods,
 *   so the in-memory implementation and the native implementation both fall into place naturally (synchronous methods keep the core deterministic; the production journal is the `zcode-events` crate's `DwfJournal`, spec §14).
 */

import type {
  ArtifactContentOp,
  ArtifactOp,
  ArtifactPresetOp,
  WorldReadOp,
} from "../facade/registry.js";
import type { AskProgress, AskStats } from "./ask-observation-types.js";
import type { ActorSessionSeed } from "./imported-cache-types.js";

// ————————————————————————————————————————————————————————————————
// identity
// ————————————————————————————————————————————————————————————————

/**
 * The identity of one ask instance: site id × per-site execution ordinal.
 * The n-th `ask("ask#3", …)` call is instance `ask#3@n` (the ordinal starts at 1).
 */
export interface InstanceRef {
  siteId: string;
  ordinal: number;
}

/** The actor identity: creation site × ordinal (isomorphic to InstanceRef, but the semantics are those of an actor, not an ask). */
export interface ActorRef {
  siteId: string;
  ordinal: number;
}

/**
 * The opaque actor handle handed to the script. The script-side `Agent` is only a thin wrapper holding it.
 * The engine maps the ActorId back to an {@link ActorRef} internally; the format is invisible to the script, but it has to be stable and parseable.
 */
export type ActorId = string;

/** Renders an InstanceRef / ActorRef into the stable string `site@ordinal`, for logs and handles. */
export function refToString(ref: InstanceRef | ActorRef): string {
  return `${ref.siteId}@${ref.ordinal}`;
}

// ————————————————————————————————————————————————————————————————
// persona/ask message
// ————————————————————————————————————————————————————————————————

/**
 * The frozen actor persona, handed to {@link WorkflowDriver.createActorSession}.
 *
 * The persona is now nothing but identity (name + system prompt). The model tier (`model?: "main" | "lite"`)
 * and the tool tier (`tools?: "default" | "readonly" | "none"`) are both gone: the host has no lite model source, and
 * the tool tier only ever bought "the judge cannot modify files" — an ordinary subagent does not rely on a tier for that either, the ask text can say it plainly.
 * Subagents always run on the parent session's current model, with the full working toolset minus the interaction tools that hang or overstep.
 * Whether submit_result is registered is decided by the driver together with the site graph (an all-untyped actor does not register it),
 * and is not expressed here — keep the persona describing identity only.
 */
export interface PersonaSpec {
  name?: string;
  system?: string;
}

/**
 * The dispatch message of a single ask: instruction body + whether it is typed + the schema when typed (the shape is opaque to the core,
 * merely passed through to {@link ValidateFn} and to the driver's schema postscript). The schema is produced by the schema synthesis side;
 * the core never interprets its shape.
 */
export interface AskMessage {
  instructions: string;
  typed: boolean;
  schema?: unknown;
}

// ————————————————————————————————————————————————————————————————
// verification
// ————————————————————————————————————————————————————————————————

/**
 * One validation violation, designed to be readable by the model inside repair's tool_result: JSON path + expected + actual.
 * It shares one type with the schema submodule (each side declared its own during parallel development, unified into schema/types once it landed).
 */
export type { Violation } from "../schema/types.js";
import type { Violation } from "../schema/types.js";

/**
 * The injected validation function: `(schema, value) => violation list` (an empty list means it passed). The real validator is implemented in parallel
 * by another agent (src/schema/); the core depends on nothing but this minimal contract and never imports its implementation.
 */
export type ValidateFn = (schema: unknown, value: unknown) => Violation[];

/** The static spec of an ask site: whether it is typed and its schema. An untyped site has no schema. */
export interface AskSpec {
  typed: boolean;
  schema?: unknown;
}

// ————————————————————————————————————————————————————————————————
// Statistics/Budget
// ————————————————————————————————————————————————————————————————

/** The two reasons the import cache gets closed: a subagent's rewriting tool, and a live `world.run`. */
export type ImportCloseCause = "mutating-tool" | "world-run";

/**
 * The run-level capacity caps, fixed at submit time and stored in dwf_run. They hold the concurrency ceiling;
 * stopping a run is done through the cancel interface.
 *
 * The values **may change more than once during a run's lifetime**: a revision carrying only `max_concurrency` applies to a live run
 * ({@link WorkflowEngine.setMaxConcurrency}). The engine therefore replaces the caps it holds wholesale instead of mutating a field in place — the copies already recorded in
 * the `run-started` / `run-caps-changed` events must keep looking exactly as they did when they were recorded.
 */
export interface Caps {
  maxConcurrency: number;
}

// Structural details related to final states (ProviderStop details, run-level stall observations) live in run-terminal.ts, from here
// Re-export as-is: This file has been exported to 400 lines, and their consumers are still fetched from types by convention.
import type { ProviderStopDetails, RunStallInfo } from "./run-terminal.js";

export type { ProviderStopDetails, RunStallInfo };

// ————————————————————————————————————————————————————————————————
// Structured errors (errors are first-class)
// ————————————————————————————————————————————————————————————————

// The error code, serializable form and WorkflowError itself live in errors.ts, and can be exported from here as is (similar to the above
// run-terminal.ts for the same reason: this file has reached 400 lines, and consumers are fetched from types by convention).
import type { WorkflowError, WorkflowErrorJson } from "./errors.js";

export { WorkflowError } from "./errors.js";
export type { WorkflowErrorCode, WorkflowErrorJson, WorkflowErrorMismatch } from "./errors.js";

// ————————————————————————————————————————————————————————————————
// Boundary A: host API (sandbox script call)
// ————————————————————————————————————————————————————————————————

/**
 * A world read operation (read-only, journalable). The vocabulary is derived from the world-read registry — adding a primitive means adding a line to
 * `facade/registry.ts`, and nothing needs to change here (see the container-key note at the top of that module).
 */
export type { WorldReadOp };

/**
 * The op of a user-facing artifact (the vocabulary is derived from the artifact registry, see `facade/registry.ts`).
 * `ArtifactContentOp` goes through {@link WorkflowHostApi.publishArtifact} (an effect, via the driver),
 * `ArtifactPresetOp` goes through {@link WorkflowHostApi.declareArtifact} (a declaration, not via the driver).
 */
export type { ArtifactContentOp, ArtifactOp, ArtifactPresetOp };

/**
 * The artifact reference handed to the script (the facade's `ArtifactRef`): id + the version number minted by this publication.
 * The promise of a content member is fulfilled by it.
 */
export interface ArtifactRef {
  id: string;
  version: number;
}

/**
 * The persisted shape of one artifact version (the shape of `dwf_node.result_json`; there is a zod mirror on the shared side).
 *
 * Content members and preset members share one shape, each filling only its own half: a content member has `bytes`/`uri`/`sourcePath`,
 * a preset member has `spec`. The bytes **never** enter the journal — `uri` points at the tool-artifact store, that is where the bytes live.
 */
export interface ArtifactVersionRecord {
  id: string;
  kind: ArtifactOp;
  /** Starting at 1. A preset declaration is always 1 (a declaration has no versions, it happens only once). */
  version: number;
  title?: string;
  description?: string;
  /** The MIME type of a content member (from the extension table or `opts.contentType`). */
  contentType?: string;
  /** The byte count of a content member. */
  bytes?: number;
  /** The `zcode-artifact://…` returned by the store (a content member). */
  uri?: string;
  /** The original path relative to the workspace (only `file` has one, used for provenance and "show in workspace"). */
  sourcePath?: string;
  /** The spec of a preset member (the normalized shape; the engine compares duplicate declarations by canonicalJson). */
  spec?: unknown;
  /** The moment of publication (epoch milliseconds). Written by the driver / the host — the engine has no clock. */
  publishedAt?: number;
  /**
   * This id is a deliverable of this run. It is stamped by the **engine**,
   * not the driver: it sticks per id — once a version carries it, every later version carries it too, whether or not `primary` is written again at publish time.
   */
  primary?: true;
}

/**
 * The driver's request to execute one content artifact publication (Boundary B).
 *
 * `version` is computed by the **engine** before dispatch (the number of journal rows for that id already completed + 1) and passed down,
 * rather than let the driver count them itself: the driver should not know the shape of the journal, while the store's `toolCallId` has to carry it
 * (one set of bytes per version). `path` / `content` — one or the other, as determined by `op`; argument validation belongs to the driver.
 */
export interface ArtifactPublishRequest {
  runId: string;
  siteId: string;
  ordinal: number;
  op: ArtifactContentOp;
  id: string;
  version: number;
  /** `file`: a workspace-relative path. */
  path?: string;
  /** `markdown`: the body. */
  content?: string;
  /** The `opts` given by the script (passed through verbatim, shape validation belongs to the driver). */
  opts?: unknown;
}

/**
 * host API: the surface that the facade shim of a lowered script calls across the sandbox boundary. Everything is serializable and async.
 * `createActor` synchronously returns an opaque handle; session creation happens lazily at the first live dispatch.
 *
 * `worldRead` carries a **positional argument array**, not a per-op bespoke payload object: `files.grep(pattern, glob?)`
 * and `git.diff(base?, path?)` take several arguments while `git.status()` takes none, which a single string signature cannot cover; and a payload object
 * would move the "branch per op" into lowering — precisely the one place that should need zero changes for a new primitive. Lowering only passes things through verbatim,
 * while each op's arity and validation belong to the driver (it is the side that knows what a base ref looks like).
 */
export interface WorkflowHostApi {
  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId;
  ask(siteId: string, actor: ActorId, instructions: string): Promise<unknown>;
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown>;
  /**
   * Publishes one intermediate result. **Fire-and-forget (synchronous signature, no return value) yet it has a site and must be journaled** — this combination
   * is the whole design of report, and both halves are forced: a script publishes a finding and there is nothing to await; while the
   * run panel and the completion notification must not show the same finding twice after a resume, so it has to be journaled.
   *
   * No driver round trip: the engine writes the node in the core and emits the event (or silently skips it on a replay hit), and that is all.
   */
  report(siteId: string, item: unknown, artifactId?: string): void;
  /**
   * Control flow passed a `phase("…")` marker. Synchronous, no return value, no driver round trip, **no journal row**:
   * the engine only emits one `phase-entered` event and is done. `name` is extracted by lowering from the literal and trimmed at both ends.
   */
  enterPhase(name: string): void;
  /**
   * Publishes a **content artifact** (`artifact.file` / `artifact.markdown`). An effect: via the driver the bytes are copied into the
   * store, one journal row is written, the {@link ArtifactRef} is fulfilled on success and **rejected catchably** on failure.
   *
   * By the same rule as `worldRead`: `args` are the positional arguments of the script call site (`[id, path, opts]`), lowering packages them verbatim,
   * and this layer only pulls out the id it needs itself (the cap and the version number need it), passing the rest through to the driver.
   */
  publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef>;
  /**
   * Declares a **preset artifact** (`artifact.chart` / `table` / `metrics` / `board`). Synchronous, no return value,
   * **not via the driver**: a declaration has nothing to wait for, so the engine validates the spec, writes the node and emits the event in the core and is done.
   *
   * Failure (illegal spec / same id with a different spec / over the cap) always failRuns — a void return has no rejection channel, the very same
   * argument as for `report`.
   */
  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void;
  log(message: string): void;
}

// ————————————————————————————————————————————————————————————————
// Boundary B: driver port
// ————————————————————————————————————————————————————————————————

/** An opaque reference to an actor session (on the production side a zcode session id). */
export interface SessionRef {
  readonly id: string;
}

/** The core's verdict on one submit attempt, handed down to the driver via respondToSubmit. */
export type SubmitVerdict =
  | { kind: "accept" }
  | { kind: "reject"; violations: Violation[] }
  | { kind: "nudge" };

/**
 * The downward port: the side effects the core asks the driver to execute. The core is a pure deterministic state machine; the side effects and the progress reports live in the driver.
 * journal and emit hang off the driver: the core makes its
 * journal decisions through `driver.journal` and does the Boundary C fan-out through `driver.emit`.
 */
export interface WorkflowDriver {
  /**
   * Mints an actor session. `seed` **is present only when that actor consumed ≥1 imported ask entry**
   * (the transcript truncation of amend-resume, see {@link ActorSessionSeed}): before returning, the driver must copy the first `messageCount` messages of the source session
   * into the newly minted session, and this step has to be **idempotent** — skip it when the target session already has content,
   * which is the case of a resume after a crash re-attaching the same session id (the session id is minted by the driver purely deterministically from (runId, actorRef)).
   *
   * The parameter is optional: an existing driver implementation may simply leave out one formal parameter and still be legal TypeScript, and a driver with no seeding semantics (a fake,
   * a pure replay test) can ignore it outright.
   */
  createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef>;
  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void;
  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void;
  cancelAsk(instance: InstanceRef): void;
  /**
   * Executes one world read. `args` are the **positional arguments** of the script call site, packaged verbatim by lowering with no checking at all;
   * each op's arity and argument validation belong to the driver (see {@link WorkflowHostApi.worldRead}).
   */
  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown>;
  /**
   * Publishes the bytes of a content artifact: validate the argument shapes,
   * resolve the workspace-relative path (reject when out of bounds), read the bytes (probe with cap+1, reject rather than truncate when over the cap), determine the
   * contentType from the extension, write the tool-artifact store, and return the persisted record.
   *
   * **Optional**: a pure replay / fake wiring has neither a store nor a filesystem. When absent, the engine rejects the node with
   * `ArtifactStoreUnavailable` — one loud, named failure, not a silent degradation (preset members are
   * unaffected, they never go through the driver to begin with).
   */
  executeArtifactPublish?(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord>;
  journal: JournalStorePort;
  emit(event: RunEvent): void;
  /**
   * Resource release after a run is settled: the engine calls it exactly once, after recording `run-settled` on the three terminal paths (complete / cancel / fail).
   * The production driver runs here, for every actor runtime, the same close chain that the app runs when closing a session
   * (the runtime's `closeBrowserSession`: beginShutdown + node_repl session release + browser session close)
   * and empties the session table; in-flight asks have by now already been aborted by cancelAsk. Optional: a fake / pure replay wiring has nothing to
   * release.
   */
  dispose?(): void;
}

/**
 * An in-flight ask's model request is **waiting**:
 * - `cause: "slot"`: the next request is queued in front of the process-level admission gate (the driver's `tryAdmit` missed); no other fields.
 * - `cause: "backoff"`: the runner has already scheduled a retry (`model_retry_scheduled`), carrying reason / attempt / delayMs / retryAfterMs.
 *   `reason` is a value of contracts' `ModelRetryReason` (`rate_limited` / `provider_overloaded` / `server_error` /
 *   `network_error` / `timeout` / `stream_idle_timeout` / `stale_connection` / `offpeak_queued` …),
 *   an open string because the pure package does not import contracts. `delayMs` is relative: the engine has no clock.
 */
export interface AskWaitInfo {
  cause: "slot" | "backoff";
  reason?: string;
  attempt?: number;
  delayMs?: number;
  retryAfterMs?: number;
}

/** Why a process-level concurrency cap changed. */
export type ConcurrencyChangeReason =
  | "rate_limited"
  | "provider_overloaded"
  | "offpeak_queued"
  | "recovered"
  | "idle_reset";

/**
 * The governor's cap adjustment for some provider key, fanned out to every run that has an ask in flight or waiting on that key
 * (duplicating a process-level fact per run is acceptable redundancy — the journal can then explain "why this run was slow").
 */
export interface ConcurrencyChange {
  /** Provider key (`${providerId}/${modelId}`). */
  key: string;
  previous: number;
  next: number;
  reason: ConcurrencyChangeReason;
  lastGood?: number;
  lastBad?: number;
  /** Rate limiting with Retry-After: the relative duration for which new dispatches are frozen. */
  cooldownMs?: number;
}

/**
 * The upward surface: the driver reports session progress back into the core. The core implements this interface (on the production side the driver holds a reference to it;
 * in phase-one tests the test itself plays the "model" and calls these methods).
 */
export interface WorkflowReportSink {
  /** One submit attempt; after the core validates it, the verdict comes back via respondToSubmit. */
  askSubmitAttempted(instance: InstanceRef, payload: unknown): void;
  /** A turn ended without submitting: the core decides on a nudge, or settles the untyped ask from finalText. */
  askTurnEnded(instance: InstanceRef, finalText: string): void;
  /**
   * A progress observation made while resolving one turn: the engine only
   * `record()`s it as `node-progress` and makes no decision from it. **It must come before the askStats call of that same turn**
   * — the ordering of the two events is a contract of the read surfaces. Calls arriving after the run has settled are ignored.
   */
  askProgress(instance: InstanceRef, progress: AskProgress): void;
  /** Usage accounting: accumulate the run usage and broadcast usage/instance updates. */
  askStats(instance: InstanceRef, stats: AskStats): void;
  /** An unrecoverable error on the driver side, settling that ask as failed. */
  askFailed(instance: InstanceRef, error: WorkflowError): void;
  /**
   * A deterministic model-side error: it does **not** settle the
   * node, but stops the whole run with `stopped(provider)` (in-flight asks are all aborted, same as on cancel).
   * `error.code` has to be a `ProviderStop`. Calls arriving after the run has settled are ignored.
   */
  stopRun(error: WorkflowError): void;
  /** A run-level stall observation: the engine only `record()`s it. */
  runStalled(info: RunStallInfo): void;
  /**
   * Three pure observations: the engine only `record()`s them and makes no decision at all.
   * Calls arriving after the run / the node has settled are ignored.
   */
  /** The next model request of this ask is waiting: the process-level admission gate (slot) or runner backoff (backoff). */
  askWaiting(instance: InstanceRef, info: AskWaitInfo): void;
  /** A model request of this ask really went out (`model_request_started`, and it was not in executing before entering). */
  askExecuting(instance: InstanceRef): void;
  /**
   * The subagent of this ask is **about to** execute a tool that rewrites the workspace:
   * the engine closes the import cache on that basis. This is the one and only driver observation the engine makes a decision on — the cached answer speaks about the predecessor world,
   * and after the first write that world no longer exists. It is reported before the tool acts (after PreToolUse, before the handler),
   * so the gate closes before the first byte hits disk. Calls arriving after the run / the node has settled are ignored.
   */
  askMutating(instance: InstanceRef): void;
  /** The process-level governor adjusted the cap of the provider key this run belongs to. */
  concurrencyChanged(change: ConcurrencyChange): void;
}

// ————————————————————————————————————————————————————————————————
// Boundary C: run event
// ————————————————————————————————————————————————————————————————

/**
 * Node kind: ask, world-read, world-run or report (the last three have no actor and no actorSeq).
 * `world-run` is the journaled command execution of world.run — the mechanism is exactly isomorphic to world-read, and giving it a kind of its own
 * is to keep the audit surface honest (an effect should not masquerade as a read).
 * `report` has a journal row but is a node in neither graph — it emits progress, not ordering.
 * `artifact` is one publication or one declaration of a **user-facing artifact**, and like
 * `report` it has a row but no node: a deliverable is not a step anyone can wait for. ⚠ Unrelated to `RunSettlement.artifact`
 * (the top-level return value).
 */
export type NodeKind = "ask" | "world-read" | "world-run" | "report" | "artifact";

/**
 * The **bounded** input of a world-read / world-run node (`dwf_node.input_json`). `args` is kept verbatim by position,
 * but once serialized it exceeds {@link WORLD_READ_INPUT_MAX_BYTES} it is truncated item by item to a string preview and `truncated` is set
 * — the audit surface would rather honestly say "it was truncated" than stuff a whole 200 KB `node -e` code string into
 * a frequently read table.
 */
export interface WorldReadInput {
  op: string;
  args: unknown[];
  truncated?: true;
}

/** The byte cap on a serialized `WorldReadInput` (4 KB). */
export const WORLD_READ_INPUT_MAX_BYTES = 4096;

/** The semantic result of a node settlement. A replay hit is distinguished by the `cached` flag on the event and is not folded in here. */
export type NodeOutcome = "ok" | "failed" | "cancelled";

/**
 * The run lifecycle status. Three terminal states:
 * - `completed`: the script returned;
 * - `errored`: the script's fault (the script threw, the engine contract was violated) — not resumable, only amendable through `resume_from`;
 * - `stopped`: the run was stopped (`RunStopReason`), **always resumable**.
 *
 * The physical column `dwf_run.status` is still the old five values (`failed` / `cancelled`) and is not migrated: this is the **logical** vocabulary,
 * and the mapping between old and new lives only in the SQLite repository's codecs (adapters `dwf-journal-codecs.ts`).
 */
export type RunStatus = "pending" | "running" | "completed" | "errored" | "stopped";

/**
 * Why a run stopped: `user` (the user cancelled) / `model` (the main agent's TaskStop) / `provider` (a deterministic model-side
 * error, see `ProviderStop`) / `interrupted` (the holding process died, sandbox crash / timeout / protocol corruption — on the host side,
 * a rerun will very likely just work) / `superseded` (stopped and replaced by an AmendWorkflow, the successor id in `supersededBy`;
 * **not resumable** — the one alive is the successor).
 */
export type RunStopReason = "user" | "model" | "provider" | "interrupted" | "superseded";

/**
 * The run event vocabulary (Boundary C). Every state transition worth observing emits an event.
 * `compaction` is reserved for long-context compaction — v1 never emits it, it is a mere placeholder so it can be added later non-destructively.
 */
export type RunEvent =
  | { type: "run-started"; runId: string; caps: Caps }
  /**
   * The turn that started the run: `inputId` is the inputId of the turn in the parent session
   * that started this run (the hub starts directly with a minted UUID v7). **Recorded only once, in the lifetime when the run was created**, right after the first
   * `run-started`; it is not emitted again when a resume emits `run-started` — so the subagent steps of the same run always hang under the same
   * message. Zero SQL: the anchor lives in a journal event, not in a dwf_run column (deliberately not migrated).
   * `phaseNames` is the phase table declared by the script (in declaration order), filled in by the submitter from the causal graph; the sidebar mini-track draws the
   * upcoming sites from it. Also recorded only once,
   * so a cold replay rebuilds it for free; absent when the script has no `phase()` marker.
   * `subagentModel` is which model this run's subagents run on, in the canonical form `providerId/modelId[$reasoningLevel]`. It is host metadata of the same kind as the anchor and the phase table: the engine **never reads it**,
   * it is recorded only once, in the lifetime when the run was created, along with this event; on resume and on both read surfaces the host reads back the same string from the event header
   * (subagent sessions pick a model by "this field > resume pin > parent session model", bootstrap's
   * workflow-actor-model.ts). Also zero SQL — not a `dwf_run` column. Absent means the subagents run on the session model.
   * `phaseAlongside` is **positionally aligned** with `phaseNames`: `phaseAlongside[i]` is the index of the other phases still running on the strand when entering `phaseNames[i]`
   * (the index falls in that same `phaseNames`). The sidebar uses it to draw two parallel sites as
   * two line segments; absent when no phases run in parallel, and absent means "this track is a straight line".
   * `scriptPath` is **which file** this run's script **came from** (an absolute path). Rule by rule the same as `subagentModel`: the engine never reads it, it is recorded only once in the lifetime when the run was created,
   * zero SQL, and the host reads back the same string from the event header on both read surfaces. Absent means this run has no editable script
   * file (a project whose draft could not be written, a run started before this feature), so the model surface falls back to the old talk of inlining and resubmitting.
   */
  | {
      type: "run-launched";
      inputId: string;
      toolCallId?: string;
      parentSessionId?: string;
      phaseNames?: string[];
      subagentModel?: string;
      scriptPath?: string;
      phaseAlongside?: number[][];
    }
  /**
   * `phaseName` records the phase name designated by the most recent `enterPhase` at the moment the instance was born.
   * It appears **only on birth events** — an actor's `actor-created`,
   * a node's `node-queued`, and, on a cache hit (replay / amend-resume), the
   * `node-settled { cached: true }` that stands in for queued; no other `node-*` event carries it, and the reducer propagates it forward following the precedent of `actorSiteId`.
   * An instance born before the marker omits the key entirely.
   *
   * It is **not** the current phase at the moment this event is emitted: a node-queued may be deferred by a hold rule until after the next marker,
   * while the birth moment lies in the previous phase.
   */
  | {
      type: "actor-created";
      actor: ActorRef;
      name?: string;
      persona?: PersonaSpec;
      phaseName?: string;
    }
  | {
      type: "node-queued";
      instance: InstanceRef;
      kind: NodeKind;
      actor?: ActorRef;
      actorSeq?: number;
      phaseName?: string;
      /**
       * The **first** {@link INSTRUCTIONS_HEAD_MAX_CHARS} characters of the author's instructions (trimmed at both ends, with no ellipsis),
       * present only on ask nodes. The only answer to "what is this subagent doing" on the event track: the full instructions live only in
       * `dwf_node.input_json`, and the read surfaces (run detail, GetWorkflowRun) do not read that table for a one-line excerpt.
       *
       * What is taken is the instruction text as of **admission time**, that is, the copy from before the engine postscript was appended — the postscript is the engine's words, not the author's.
       */
      instructionsHead?: string;
    }
  /**
   * Dispatch: the driver is told to start. This one for an ask **repeats its own birth facts** — `kind` / `actor` /
   * `phaseName` / `instructionsHead` are word for word identical to that instance's `node-queued`, while `actorName` /
   * `actorPhaseName` are the `name` / `phaseName` that its subagent carried on its own `actor-created`.
   *
   * Why repeat facts that have already been emitted: the read surface's table is **bounded**, and "important" happens at the moment of dispatch, not at the
   * moment of queueing. A run with 2000 agents emits all its
   * `actor-created` / `node-queued` within the first few seconds, the table fills up with the first 1024 queued entries with not one of them settled,
   * and from then on not a single **actually running** instance makes it into the table. Carrying the birth facts makes this event a self-sufficient birth:
   * the read surface can use it to pull the instance and its subagent into the table together, without going back to look for that long-rejected queued.
   *
   * Both phase names are **birth stamps**, not the current phase at the moment this event is emitted: a queued ask can be stuck behind the concurrency ceiling
   * while the script has long since moved into a later phase (the stamping lives in engine-phase-stamp.ts, which reads the table written at the minting point).
   * A world-read dispatch carries none of these keys: it is emitted right after its own `node-queued` and has no subagent either.
   */
  | {
      type: "node-dispatched";
      instance: InstanceRef;
      kind?: NodeKind;
      actor?: ActorRef;
      actorName?: string;
      actorPhaseName?: string;
      phaseName?: string;
      instructionsHead?: string;
    }
  | { type: "node-repairing"; instance: InstanceRef; attempt: number; violations: Violation[] }
  | { type: "node-nudged"; instance: InstanceRef }
  /**
   * The three observation events of adaptive concurrency. Of the same family as escalation:
   * the engine core makes no decision from them, they are merely facts observed by the driver / the governor, recorded by the engine's `record()` into the
   * journal and fanned out. `node-waiting` ⇄ `node-executing` is a self-loop after dispatched and before settled
   * (which makes `executing` an **observable** phase), and does not change the node's journal record
   * (no dwf_node write).
   */
  | ({ type: "node-waiting"; instance: InstanceRef } & AskWaitInfo)
  | { type: "node-executing"; instance: InstanceRef }
  | ({ type: "concurrency-changed" } & ConcurrencyChange)
  /**
   * This run's **own** concurrency ceiling was changed in place: a revision carrying only `max_concurrency` applies to a live run, with the same
   * runId, no successor minted, and not one in-flight ask lost.
   *
   * It belongs to a **different boundary** than the adjacent `concurrency-changed`, do not conflate the two: that one is the governor's observation of the process-level shared cap
   * (the unit is a model request, the engine only records), whereas this one is the ceiling on this run's in-flight asks, and is the result of a **command**
   * — swapping the caps, writing `dwf_run.caps_max_concurrency` and emitting this event all happen in one synchronous step, so the three always agree.
   * `previous` is the copy from before the change: the read surface has to say "8 → 2", which cannot be derived from a single caps value.
   */
  | { type: "run-caps-changed"; runId: string; caps: Caps; previous: Caps }
  | {
      type: "node-settled";
      instance: InstanceRef;
      outcome: NodeOutcome;
      cached?: boolean;
      error?: WorkflowErrorJson;
      /** Present only when `cached: true`: a node that hit the cache has no queued, so this is its birth event. */
      phaseName?: string;
    }
  /**
   * The progress of one ask while resolving a turn.
   * Of the same family as the escalation / concurrency observations: **the engine core does not interpret it**, it only `record()`s it — it changes no scheduling
   * decision, it does not enter inputHash, and replay does not compare it. The order of the two events of the same turn is load-bearing:
   * this one precedes `usage-updated`, so anyone who reads the new usage has necessarily already read the progress that earned it.
   */
  | ({ type: "node-progress"; instance: InstanceRef } & AskProgress)
  /** A run-level token usage update: it directly carries the total spent so far (the journal's spent_tokens is written in step, the two are always equal). */
  | { type: "usage-updated"; spentTokens: number }
  | { type: "log"; message: string }
  /**
   * The amend-resume import cache has been closed: some live subagent is about to
   * rewrite the workspace (`cause: "mutating-tool"`, with `actorName` its effective name), or a `world.run` is being executed live
   * (`cause: "world-run"`). At most one per run; after the revised run crashes, a resume restores "the gate is closed" from it — this is the
   * **only** source of truth for the closing, and it is no longer inferred from "an ask was live". A non-revision run has no cache to close, so nothing is emitted.
   */
  | {
      type: "import-cache-closed";
      instance: InstanceRef;
      cause: ImportCloseCause;
      actorName?: string;
    }
  /**
   * Control flow passed a `phase("…")` marker. **No site, no journal row, no driver round trip** — a marker is not a unit of work, it is merely
   * one tick of "how far did it get". `name` is the author's own word (trimmed at both ends, the same key the analyzer uses when minting phase ids);
   * `ordinal` counts by name and is **emitted on every evaluation**: re-entering the same name is +1, and the analyzer does read precisely the second marker of a name as a
   * back edge. On resume the script re-runs and emits the prefix once more (there are no journal rows to deduplicate against), which consumers are immune to by reducing monotonically.
   */
  | { type: "phase-entered"; name: string; ordinal: number }
  /**
   * A published intermediate result, exactly once per **non-skipped** report call (a replay hit is silently skipped and
   * not re-emitted). It travels exactly the same route as every other run event (progress aggregate → bounded session event → projection reducer),
   * ending up in the Results section of the run panel.
   *
   * When `artifactId` is present, this item also fed that preset artifact (`report(item, "perf")`) — the projection increments that
   * artifact's `itemCount` by it, and the board hook treats the count change as the signal to fetch incrementally.
   */
  | { type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }
  /**
   * A new version of a **user-facing artifact** is in place: one event per successful publication of a content member, and one per preset
   * declaration that actually lands (an idempotent no-op emits nothing). By the same rule as report — a replay hit is not re-emitted, a cold recovery reads it from the journal.
   *
   * The success path emits **only this one** event, and no node lifecycle events at all (node-queued / dispatched / settled).
   * The same argument as for `report`: an artifact is a deliverable, not a step anyone can wait for, and in both graphs it is not a node.
   */
  | { type: "artifact-published"; instance: InstanceRef; artifact: ArtifactVersionRecord }
  /**
   * A content artifact publication failed (the node is journaled as `failed`, and the script side gets a catchable rejection).
   *
   * **Deliberately not reusing `node-settled{failed}`**: the readers of that event would reduce it into `nodes[]` and require the site to have
   * a corresponding node in the graph, whereas artifact sites belong to **no graph at all** — a node-settled landing on such a site shows up
   * in the run panel as an unexplainable "unknown node", and the layer reports an unrecognized site id. A failed publication therefore
   * needs an event of its own: it carries what it takes to render a failure card (id / kind / structured error) without impersonating a unit of
   * work. A replay hit on a failure record is **not re-emitted** (same as report / artifact-published).
   */
  | {
      type: "artifact-failed";
      instance: InstanceRef;
      id: string;
      op: ArtifactContentOp;
      error: WorkflowErrorJson;
    }
  | { type: "compaction"; actor: ActorRef }
  /**
   * An actor escalated a blocking question to the main agent and parked in its own ask waiting for the answer.
   *
   * **The engine core never emits these two events** — the driver emits them at the boundary of executing the ask (on the same level as the repair /
   * nudge rounds), and the zero-I/O state machine is unaware of escalations. They still live in this vocabulary because they travel the
   * exact same two tracks as every other run event (the journal's dwf_event + the live fan-out of driver.emit), and the shape of
   * those two tracks is defined by `RunEvent`. An escalation **writes no dwf_node row** (waiting is not work).
   */
  | {
      type: "escalation-raised";
      qid: string;
      actor: ActorRef;
      /**
       * The **effective name** of an actor (= `spec.name` after `normalizePersona`, that is, the one on the `actor-created`
       * event and the one amend-resume uses as the cache identity key). An anonymous actor has none,
       * and no fallback label is synthesized — each consumer decides for itself how to render "unnamed".
       */
      actorName?: string;
      question: string;
      context?: string;
      /**
       * The moment the question was asked (epoch milliseconds). **Required**: the first question a reader has to answer is always "how long has this question been waiting",
       * and there is no other clock available on the event track — `dwf_event.time_created` exists only on the durable track, the live track
       * (driver.emit → progress sink → sidebar) cannot get it, and letting the UI fall back to "the local moment the event arrived" would
       * show every question as just-asked while a cold start replays the entire history.
       *
       * The **same instant** as the snapshot's `pendingQuestions[].askedAt` (the driver reads `Date.now()` only once and
       * shares it between the event and the parked record), so the waiting time on the two read surfaces is always consistent.
       */
      askedAt: number;
    }
  | { type: "escalation-resolved"; qid: string; answer: string }
  /** A run-level stall observation (see {@link RunStallInfo}); calls arriving after the run has settled are ignored. */
  | ({ type: "run-stalled" } & RunStallInfo)
  /**
   * `stopReason` is present only when `status === "stopped"`; `error` is always present in `errored`, and in
   * `stopped` only for `provider` (`ProviderStop`) and `interrupted` (`Interrupted`).
   */
  | {
      type: "run-settled";
      status: RunStatus;
      stopReason?: RunStopReason;
      /** Present when `stopReason === "superseded"`: the new run minted by the revision that stopped this run. */
      supersededBy?: string;
      error?: WorkflowErrorJson;
    };

// ————————————————————————————————————————————————————————————————
// Journal storage port + record
// ————————————————————————————————————————————————————————————————

/** The dwf_run record (the core hard-depends only on caps/status/failure; the rest is reserved for the phase-two reshaping). */
export interface RunRecord {
  runId: string;
  parentSessionId?: string;
  cwd?: string;
  /**
   * A human-given run name (CreateWorkflow's optional `input.name`). Pure display metadata: the engine never reads it,
   * it is only persisted by createRun together with scriptText / cwd, for the host's enumeration surface to use as a label — otherwise listing across sessions
   * would yield nothing but a bare runId. Absent means no name was given (the read side falls back to the script's first line and does not write it back).
   */
  name?: string;
  /**
   * The id of the CreateWorkflow tool call that started this run. Pure host metadata: the engine never reads it, it is only persisted by createRun
   * together with scriptText / cwd. It is the only correlation anchor that survives a restart — the `workflowRuns` projection does not
   * live across processes, so both the tool card join and resume's notification anchor can only be recovered from here.
   */
  toolCallId?: string;
  scriptText?: string;
  scriptHash?: string;
  /**
   * The actual arguments of this run (the declarative parameters of the saved workflow, validated and backfilled with defaults).
   *
   * A part of the run **identity** on a par with `scriptText`, not display metadata: a resume replays the arguments stored here
   * and never accepts new ones — changing the arguments means a different run, which deserves its own confirmation dialog. Absent (NULL on old rows)
   * is read as `{}` and is not backfilled (invariants 6/7).
   */
  args?: Record<string, unknown>;
  /**
   * The lineage pointer of amend-resume: which predecessor run this run revises. Host metadata, the engine never reads it, it is only persisted by createRun together with the remaining
   * metadata. A revision is a **supersede** — a new runId, a new script, zero touches to the predecessor row — so the only connection
   * between the two sides is this pointer: both resume rebuilding the import cache (`port.resume` sees it present and rebuilds the ImportedCache) and
   * the UI's "continued from run X" recover it from here. Absent means this run is not a revision (the vast majority of runs).
   */
  resumedFrom?: string;
  caps: Caps;
  /** Cumulative token usage (an observation surface, not a control surface). */
  spentTokens: number;
  status: RunStatus;
  /** Present when `status === "stopped"` (absent when decoding an old row ⇒ `user`, see the repository codecs). */
  stopReason?: RunStopReason;
  /** Present when `stopReason === "superseded"`: the successor run that replaces this run (it and that run's `resumedFrom` are the two ends of the same edge). */
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  /** The top-level return value of the script. Present only for completed runs (an `undefined` product means the whole field is absent). */
  result?: unknown;
}

/** The dwf_actor record, unique(runId, siteId, ordinal). */
export interface ActorRecord {
  runId: string;
  siteId: string;
  ordinal: number;
  name?: string;
  persona?: PersonaSpec;
  sessionId?: string;
  /**
   * Which model the actor actually ran on (`providerId/modelId`), written by the driver side.
   *
   * Why it is not folded into `persona`: the persona is the frozen identity the engine writes synchronously at createActor, while the model is a host
   * fact (the parent session's choice **at that moment**), which the engine cannot see. Split into two fields, identity and host fact each get one author,
   * and whoever writes one is responsible for it.
   *
   * Why it is persisted: the run's cost becomes auditable that way, and a resume can re-attach to the **same** model — even if the parent session switches its
   * main model between two runs, the second half of the same run does not quietly switch models (pin, see bootstrap's
   * workflow-actor-model.ts).
   *
   * Like `sessionId` it belongs to the set of "driver-owned fields": the engine's putActor only carries the existing value across verbatim
   * (see createActor in engine.ts and ensureSession in scheduler.ts) and never produces one itself.
   */
  resolvedModel?: string;
}

/**
 * The persisted status of a node. A node is persisted as `running` at **admission time** (carrying actorSeq and inputHash),
 * and updated to completed/failed when it settles. A node that crashes while executing therefore leaves a `running` record in the journal,
 * and on resume it is dispatched live again at the recorded actorSeq position (rather than being short-circuited as a finished result).
 *
 * **report nodes are the one exception to this "two writes" rule**: they are written only once and land as `completed` — there is no driver call
 * between admission and settlement, so there is nothing that could fail in between.
 */
export type NodeRecordStatus = "running" | "completed" | "failed";

/**
 * The dwf_node record. unique(runId, siteId, ordinal); for ask there is additionally
 * unique(runId, actorSiteId, actorOrdinal, actorSeq). The actor* fields and actorSeq of world-read and report are
 * all empty; report rows additionally satisfy: a single write, status always `completed`, `result` is the reported item,
 * and `inputHash` covers that item (compared defensively on a replay hit).
 */
export interface NodeRecord {
  runId: string;
  siteId: string;
  ordinal: number;
  kind: NodeKind;
  actorSiteId?: string;
  actorOrdinal?: number;
  actorSeq?: number;
  inputHash: string;
  status: NodeRecordStatus;
  result?: unknown;
  error?: WorkflowErrorJson;
  stats?: AskStats;
  /**
   * The id of a **user-facing artifact** (the `dwf_node.artifact_id` column). Two kinds of row carry it: rows with `kind: "artifact"`
   * (the artifact they published/declared), and tagged rows with `kind: "report"` (which preset this item fed).
   * The latter is exactly where the invariant "a board is a projection of the journal" lands — every point of a board is one row
   * `kind = report ∧ artifact_id = ?`. All other rows leave it empty.
   */
  artifactId?: string;
  /**
   * **world-read / world-run nodes only**: the op this site
   * actually executed and its arguments, **bounded** ({@link WorldReadInput}). `inputHash` only answers "is it the same input",
   * it cannot answer "what was the input" — and the workspace transcript has to say *what ran*, not merely *something ran*.
   * Written at admission (in the same putNode as `inputHash`) and carried over verbatim by the settlement upsert; rows from before 0030 and
   * ask / report / artifact rows always leave it absent.
   */
  input?: WorldReadInput;
  /**
   * **ask nodes only**: once that ask's full exchange (including the repair / nudge rounds and the closing messages after submit) is over,
   * the length of that actor session's message log — a count offset, not a range of message ids.
   *
   * A driver-owned backfill field (in the same family as the `stats` backfill, likewise persisted by reading, changing and writing via getNode + putNode); the engine
   * does not produce it. Storing a count rather than an id range is because the key property of a count is **invariance under prefix copying**: copying the first N
   * messages of the source session into a new session changes every message id but not the count, so the boundary value of the copied ask stays
   * valid as-is in the new session. This is precisely the foundation of amend-resume's full-fidelity transcript truncation (and of chained revisions).
   */
  messageBoundary?: number;
}

/** A persisted event, whose sequence is assigned monotonically by appendEvent. */
export interface StoredEvent {
  sequence: number;
  event: RunEvent;
  /**
   * The moment the storage layer appended this event (epoch milliseconds). The only clock for every "how long ago" in the event log:
   * the age of a log row, when the subagent last acted, how long the run has been stalled — all can only be computed from it.
   * Letting a reader fall back to a fresh `Date.now()` is wrong — that would label a whole week-old history in one cold replay as "just now".
   *
   * Optional in the type so that the test doubles implementing the port keep compiling; both **real** implementations (SQLite's `time_created`
   * column and the in-memory implementation's append timestamp) must fill it in, and a contract test pins this one down.
   */
  timeCreated?: number;
}

/**
 * Event pagination parameters (cursor = journal sequence). The run detail page on the app side pulls the event log incrementally on that basis:
 * returning everything at once would mean reading the whole journal into memory on every page turn.
 */
export interface ListEventsOptions {
  /** Returns only the events whose sequence is **strictly greater** than that value. The cursor is "the last sequence already read", not an offset. */
  afterSequence?: number;
  /** The maximum number of entries returned per page; unlimited by default. */
  limit?: number;
}

/**
 * The persisted payload that accompanies a run settlement. It exists for the sake of **a single write**: writing the terminal status and the artifact in two UPDATEs
 * means a crash in between produces a `completed` run whose artifact is unrecoverable. An absent key means "do not touch that column"
 * (the engine's `running` write and the historical rows from before that column existed both rely on this semantics).
 */
export interface RunSettlementRecord {
  /** Written together with `status === "stopped"`; not carried by the other statuses. */
  stopReason?: RunStopReason;
  /** Written in the same single write as `stopReason === "superseded"` (the stopped envelope is rewritten as a whole; splitting it into two writes would lose it). */
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  result?: unknown;
}

/**
 * The journal storage port: repository-style, synchronous methods, with no SQL leaking out. The in-memory implementation is in journal-memory.ts;
 * the SQLite implementation shares this port with the in-memory one. The old test entry point has been cleaned up along with Vitest, so that the production build never depends on an undeclared test framework.
 */
export interface JournalStorePort {
  createRun(record: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void;
  /**
   * Persists the cumulative token usage on its own (a high-frequency small write apart from the run settlement). An unknown runId must throw;
   * it never touches status / failure — the usage update and the run settlement are two independent write paths.
   */
  updateRunUsage(runId: string, spentTokens: number): void;
  /**
   * Persists this run's concurrency ceiling on its own (`dwf_run.caps_max_concurrency`). An unknown runId must throw;
   * it **touches only that column** — status, usage and the settlement bag are all out of scope for this write, in the same family as {@link updateRunUsage}.
   *
   * It is the **second writer** of that column (the first is {@link createRun}): a revision carrying only `max_concurrency`
   * applies in place to a live run, while a resume reuses the caps in the row — not persisting them means what is recovered is still the old ceiling.
   */
  updateRunCaps(runId: string, caps: Caps): void;

  putActor(record: ActorRecord): void;
  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined;
  listActors(runId: string): ActorRecord[];

  putNode(record: NodeRecord): void;
  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined;
  listNodes(runId: string): NodeRecord[];

  appendEvent(runId: string, event: RunEvent): StoredEvent;
  /**
   * Lists the events in ascending sequence order. `opts` absent means everything (the historical shape); with a cursor / limit it must
   * filter in the storage layer and must not fetch everything and slice afterwards — the whole point of pagination is not reading the entire journal into memory.
   * An unknown runId and an out-of-range cursor both return an empty array (no throw): in the race window between the projection and the journal,
   * a client coming back with a cursor that does not exist yet is normal timing.
   */
  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[];
}

// The driver's observation vocabulary (usage + progress) for ask lives in ask-observation-types.ts (ditto), exported here to maintain reference paths.
export {
  INSTRUCTIONS_HEAD_MAX_CHARS,
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
} from "./ask-observation-types.js";
export type { AskLastTool, AskProgress, AskStats } from "./ask-observation-types.js";

// ————————————————————————————————————————————————————————————————
// Import cache (amend-resume)
// ————————————————————————————————————————————————————————————————

// The data structure of the imported cache lives in imported-cache-types.ts (this file is removed after reaching the max-lines limit), and the export is exported here to maintain the reference path.
export type {
  ActorSessionSeed,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedInFlightAsk,
  ImportedRunCache,
  ImportedWorldEntry,
} from "./imported-cache-types.js";

// ————————————————————————————————————————————————————————————————
// Strategy constants (part of this contract)
// ————————————————————————————————————————————————————————————————

/** The cap on the number of in-node repairs (retries after a rejection): 3. */
export const REPAIR_ATTEMPTS = 3;

/** The cap on the number of nudges when a turn ends without submitting: 1. */
export const NUDGE_ATTEMPTS = 1;
