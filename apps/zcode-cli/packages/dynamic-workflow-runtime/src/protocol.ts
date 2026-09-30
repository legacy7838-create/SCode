/**
 * The NDJSON wire protocol (Boundary A's transport encoding).
 *
 * The sandbox child process and the parent-side harness communicate over newline-delimited
 * JSON on stdio. This module is the **single source of truth**, describing the kind and
 * fields of every message; the child source (the inline string in child-source.ts) mirrors
 * these shapes by hand — it cannot import this module (it runs inlined into the entry file
 * via `toString()`), so both places have to change together. The parent side imports these
 * types directly, which keeps the bridging code strictly typed.
 *
 * Direction convention:
 *   child → parent: create-actor (fire-and-forget) / request (ask/world-read/publish-artifact,
 *                   needs a response) / event (log, report, declare-artifact) / complete
 *   parent → child: response (answers a request and carries the latest budget snapshot)
 *
 * Why create-actor does not use request/response: Boundary A requires `createActor` to return
 * a handle **synchronously**. The child cannot wait for a round-trip on behalf of a
 * synchronous return, so it synchronously builds a child-local handle (`local#N`) and fires a
 * create-actor off without waiting; the parent uses stdio's FIFO order to complete the
 * local→engine ActorId mapping before handling any ask that references that handle (the
 * parent's create-actor handling is purely synchronous).
 */

import type { ArtifactContentOp, ArtifactPresetOp, WorldReadOp } from "@zcode/dynamic-workflow";

// ————————————————————————————————————————————————————————————————
// Wrong structured line pattern
// ————————————————————————————————————————————————————————————————

/**
 * The shape of an error crossing the boundary. An ask rejection (WorkflowError) crosses as
 * this, and the child rebuilds inside the sandbox an Error carrying
 * `code`/`violations`/`finalText` so the script's try/catch can handle it structurally.
 * Model-side errors no longer cross: they are either retried inside the runtime or stop the
 * whole run, and the script never sees them.
 */
export interface WireError {
  name: string;
  message: string;
  code?: string;
  violations?: unknown[];
  finalText?: string;
  stack?: string;
}

// ————————————————————————————————————————————————————————————————
// child → parent
// ————————————————————————————————————————————————————————————————

/** Create an actor synchronously: fire-and-forget, with the parent establishing the local→ActorId mapping via FIFO before any subsequent ask. */
export interface CreateActorMessage {
  kind: "create-actor";
  localId: string;
  siteId: string;
  name?: string;
  persona?: unknown;
}

/**
 * A host call that needs a response: ask, world-read, or the **publication of a content
 * artifact**.
 *
 * The two families of artifact members diverge here: content members (`file`/`markdown`) are
 * effects, the script awaits them and has to be able to catch their rejections, so they travel
 * request/response; declared members are declarations, return void, and travel the event
 * channel below.
 */
export interface RequestMessage {
  kind: "request";
  id: string;
  type: "ask" | "world-read" | "publish-artifact";
  siteId: string;
  /** ask only: the child-local actor handle. */
  actor?: string;
  /** ask only: the instruction text. */
  instructions?: string;
  /** world-read only: op (the vocabulary is derived from the world-read registry, so adding a primitive does not change this file). */
  op?: WorldReadOp;
  /**
   * publish-artifact only: the op of a content member. It is **deliberately a separate field
   * from `op`** rather than widening `op` into a union of two vocabularies: after widening,
   * what the parent holds at dispatch time is a value that has to be narrowed again, and the
   * only basis for narrowing is `type` — which is exactly what the two fields each express on
   * their own. Two registries, two fields, nobody has to guess.
   */
  artifactOp?: ArtifactContentOp;
  /**
   * world-read only: the **positional argument array**. Lowering packs the arguments at the
   * script's call site verbatim and this layer passes them through as-is; arity and validation
   * both belong to the driver. A single `arg?: string` cannot carry the multi-argument and
   * zero-argument ops (`files.grep(pattern, glob?)`, `git.status()`).
   */
  args?: unknown[];
}

/**
 * Fire-and-forget events, discriminated by `type`. None of the three needs a response, but
 * their **durability differs**: losing a `log` only loses a line of chatter, whereas losing a
 * `report` loses a finding (the parent journals it), so the event channel's FIFO order is
 * load-bearing for report — what the parent journals is exactly what arrived.
 *
 * `declare-artifact` shares this channel with report, and **must**: a tagged report is only
 * legal once its declaration has already reached the parent (otherwise the engine fails the
 * whole run with `ArtifactUndeclared`). In the script the declaration comes first and the
 * report after, and the same FIFO guarantees the parent sees them in that order too. Turning
 * the declaration into an answered request would not improve that — it would only add a
 * wait out of thin air for a facade member that returns void synchronously.
 */
export type EventMessage =
  | LogEventMessage
  | ReportEventMessage
  | DeclareArtifactEventMessage
  | PhaseEnteredEventMessage;

/**
 * Control flow passed through a `phase("…")` marker. It travels the event channel: the script
 * never awaits it; it has no site and lands in no journal, and the parent only has the
 * engine emit a `phase-entered`. Arrival order is load-bearing here too — "enter B first,
 * then dispatch the ask inside B" is what lights up the timeline.
 */
export interface PhaseEnteredEventMessage {
  kind: "event";
  type: "phase-entered";
  /** The author's own wording, with the two ends trimmed by lowering. */
  name: string;
}

/** A progress message: no site, not journaled. */
export interface LogEventMessage {
  kind: "event";
  type: "log";
  message: string;
}

/**
 * One intermediate result. It travels the event channel instead of request/response because
 * the script never awaits it, but unlike `log` the parent journals it as a `dwf_node` row
 * keyed by `siteId` × ordinal.
 */
export interface ReportEventMessage {
  kind: "event";
  type: "report";
  siteId: string;
  item: unknown;
  /**
   * The artifact tag (`report(item, "perf")`): which declared artifact this item also feeds.
   * Absent means no tag (JSON.stringify drops an undefined key entirely, so on the wire it
   * really is "no such key").
   */
  artifactId?: string;
}

/**
 * One **declaration of a declared artifact** (`artifact.chart` and friends). It travels the
 * event channel instead of request/response because the facade member returns void
 * synchronously — the script never awaits it. The parent journals a `dwf_node` row by
 * `siteId` × ordinal (except for idempotent duplicate declarations), so this message's
 * arrival order is load-bearing too (see {@link EventMessage}).
 */
export interface DeclareArtifactEventMessage {
  kind: "event";
  type: "declare-artifact";
  siteId: string;
  op: ArtifactPresetOp;
  /** The positional argument array (`[id, spec]`), packed verbatim by lowering and passed through as-is. */
  args: unknown[];
}

/** Script execution finished: a top-level artifact or a thrown error. */
export interface CompleteMessage {
  kind: "complete";
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

/** Every child → parent message. */
export type ChildMessage = CreateActorMessage | RequestMessage | EventMessage | CompleteMessage;

// ————————————————————————————————————————————————————————————————
// parent → child
// ————————————————————————————————————————————————————————————————

/** The response to one request. */
export interface ResponseMessage {
  kind: "response";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

/** Every parent → child message. */
export type ParentMessage = ResponseMessage;

/**
 * The child process's initial payload. Embedded as a JSON literal in the entry file
 * (`renderChildEntry` in child-source.ts), no longer via argv / base64: the Windows command
 * line limit is 32,767 characters.
 */
export interface ChildPayload {
  /** The async function body of the lowered script (the only free identifier is `__host`). */
  lowered: string;
  /**
   * This run's arguments, injected into the sandbox as the **frozen** `args` global (lowering
   * rewrites the script's reads of `args` into `__host.args`).
   *
   * They cross the boundary once at spawn and are never updated afterwards — the arguments are
   * a constant for the whole lifetime of the run. Absence is read as `{}`: both inline runs
   * and old journal rows go this way, so `args.x` in a script is always a legal property read
   * rather than a crash.
   */
  args?: Record<string, unknown>;
  /**
   * The heap ceiling (MB). It **only takes effect on the argsPrefix (SEA self-re-exec) path**:
   * `--max-old-space-size` cannot be passed there, so when the entry file does not see the flag
   * in `execArgv` it applies it best-effort via `v8.setFlagsFromString`. On the default path a
   * real Node flag does the work and the entry file skips this field when it sees the flag.
   * The effect is not guaranteed (V8 may ignore a flag already consumed during startup); this
   * is recorded as a SEA limitation.
   */
  maxOldSpaceSizeMb?: number;
}
