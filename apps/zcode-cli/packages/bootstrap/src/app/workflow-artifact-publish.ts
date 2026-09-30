// ============================================================
// The execution side of product release (executeArtifactPublish of Boundary B)
// ============================================================
// ⚠ Terminology: The artifacts in this document always refer to the user interface
// Artifact** - the bytes delivered by the script to the user via `artifact.file` / `artifact.markdown`; not internal to the engine
// The top-level return value of that artifact (`RunSettlement.artifact`, `serializeWorkflowArtifact`, that is for
// **Model** to see). This document does not touch on the latter.
//
// Same division of labor as workflow-world-read.ts: driver ontology (workflow-driver.ts) does actor session and
// Turn arrangement, this half turns a `(op, id, path | content, opts)` into a real **byte copy**,
// And do not touch sessions, models and journals at all. Four things are here, and only here:
//   1. **Realize the shape verification of opts**. The engine only guarantees that `id` and payload are non-empty strings (runtime guardrails).
//      `opts` is the third actual parameter that is passed through the script as it is - "what does a title look like" belong to this side, discipline and
//      Same as `worldReadStringArgs`: fails loudly, never casts to `String(...)`.
//   2. **Path analysis and out-of-bounds determination**. The one where the parser reuses world-read (`resolveWithinWorkspace`),
//      Add another realpath check, see {@link resolveWorkspaceFile}.
//   3. **Enforcement of upper limit**. Constants are in pure packages (`ARTIFACT_CAPS`), implemented here because only this side can be read
//      Bytes; if the limit is exceeded, it will be **rejected and not truncated** (same house policy as world-read - a PDF that was quietly truncated)
//      is a bad deliverable, and a rejection of a named cap is a contract upon which the script can rewrite itself).
//   4. **Write tool-artifact store** and normalize the store’s receipt into `ArtifactVersionRecord`.
//
// Rejections are always structured `WorkflowError` (error code: ArtifactSourceMissing/
// ArtifactPathOutsideWorkspace/ArtifactTooLarge/ArtifactStoreUnavailable) because of the content member
// A `catchable` promise in a script - gating idiom `try { await artifact.file(…) } catch { … }`
// The premise is that these rejections get into the hands of the script.

import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  isFileSystemPortError,
  type FileSystemPort,
  type FileSystemReadBytesResult,
  type SessionId,
  type ToolArtifactStorePort,
  type ToolArtifactWriteResult,
} from "@zcode/contracts";
import {
  ARTIFACT_CAPS,
  ARTIFACT_ID_PATTERN,
  WorkflowError,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
} from "@zcode/dynamic-workflow";
import { resolveWithinWorkspace, toWorkspaceRelative } from "./workflow-world-read.js";

/** The ports and base directory that artifact publishing needs (a subset of the driver deps, same as {@link WorldReadDeps}). */
interface ArtifactPublishDeps {
  /** The filesystem port used to read the bytes of the file being published. */
  readonly fileSystemPort: FileSystemPort;
  /** The base directory for path resolution and relativization (the workspace root). */
  readonly cwd: string;
  /**
   * The landing spot for the bytes. **Optional**: a pure replay / fake assembly has no store.
   * When it is absent, the content members reject loudly with `ArtifactStoreUnavailable` -- not a silent downgrade to
   * "an empty artifact was published", and not a fallback to writing into the workspace.
   */
  readonly artifactStore?: ToolArtifactStorePort;
  /**
   * The session scope of the store write = the **parent session** of this run. It appears as a pair with `artifactStore`:
   * every store write is accounted per session (`zcode-artifact://<session>/<id>`), and without a session id there is
   * no record that can later be read back. Only when both are present is the publish capability considered assembled; missing either one means
   * `ArtifactStoreUnavailable` (a missing store means "this assembly has no storage", a missing id is a wiring mistake -- for the
   * script they are the same thing: this publish cannot happen, and it must be loud).
   */
  readonly parentSessionId?: SessionId;
}

/**
 * Performs one content artifact publish: validate the shape -> confirm the store is present -> get the bytes (read the file from disk / take the markdown body) ->
 * write to the store -> normalize into a persisted record.
 *
 * The order is not arbitrary: **shape first, store second, IO last**. Shape validation is the cheapest and independent of the assembly; when the store is absent a
 * disk read is work thrown away, and worse, it would cover the real cause with an `ArtifactSourceMissing`
 * ("this assembly has no storage at all").
 */
export async function executeArtifactPublish(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
): Promise<ArtifactVersionRecord> {
  assertArtifactId(request);
  const opts = artifactPublishOptions(request);
  const store = requireArtifactStore(deps, request);
  const payload =
    request.op === "file"
      ? await readFilePayload(deps, request, opts)
      : markdownPayload(request);
  const written = await writePayload(store, request, payload);
  return {
    id: request.id,
    kind: request.op,
    version: request.version,
    ...(opts.title === undefined ? {} : { title: opts.title }),
    ...(opts.description === undefined ? {} : { description: opts.description }),
    // contentType takes the locally calculated one instead of the store receipt: extension table + `opts.contentType`
    // Overrides jointly determine the content type, and the UI does switch dispatch on this string; let the store normalize (it presses
    // File name pushback type) becomes authoritative, making the result of a dispatch dependent on the store implementation.
    contentType: payload.contentType,
    // bytes / uri Get the store's receipt: This is the one that actually falls into the store, and it is also the one that is read back in the future.
    bytes: written.bytes,
    uri: written.uri,
    ...(payload.kind === "binary" ? { sourcePath: payload.sourcePath } : {}),
    // The engine has no clock (pure core, replayable), so release times are filled in from this side. Release time is a required field.
    publishedAt: Date.now(),
  };
}

// ———————————————————————————————— Internal: Shape Verification ——————————————————————————————

/** The validated `opts` (the facade's `ArtifactOptions` / `ArtifactFileOptions`). */
interface ArtifactPublishOptions {
  title?: string;
  description?: string;
  /** Only `file` reads it: markdown is always `text/markdown`. */
  contentType?: string;
}

/**
 * A runtime guard on the artifact id. The compile-time literal diagnostics (the analyzer) are the front door, and the engine blocks once more for "must be a non-empty
 * string" -- validating the character set and the length again here is because **only this side uses the id as a key**: it goes into the store's
 * `toolCallId` and eventually becomes one segment of the on-disk file name. An illegal id that gets this far can only mean that something bypassed compilation,
 * so it uses `DriverError` rather than some `Artifact*` code, keeping those codes meaning only what each of them means.
 */
function assertArtifactId(request: ArtifactPublishRequest): void {
  const { id } = request;
  if (id.length > ARTIFACT_CAPS.maxIdLength || !ARTIFACT_ID_PATTERN.test(id)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: id '${id}' is not a valid artifact id. Use at most ` +
        `${ARTIFACT_CAPS.maxIdLength} characters from [A-Za-z0-9_.-].`,
    );
  }
}

/**
 * Takes out and validates the `opts` the script passed in. The three rules share their source with {@link worldRunArgs}:
 *   1. Absence is legal (`opts?`), but when present it must be an options object (not an array, not null).
 *   2. Recognized keys are validated one by one for type and cap, and are **never coerced** -- a title coerced by `String(undefined)` into
 *      `"undefined"` would show up on the card as an untraceable string instead of a fixable error.
 *   3. Unrecognized keys are silently ignored (the facade's type signature already stops them at compile time; erroring on them at runtime would only
 *      move a compile-time problem into the runtime). The `markdown` family therefore never reads `contentType` at all.
 */
function artifactPublishOptions(request: ArtifactPublishRequest): ArtifactPublishOptions {
  const raw = request.opts;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts must be an options object, got ${describeArg(raw)}. ` +
        `Pass an object or omit the argument.`,
    );
  }
  const bag = raw as { title?: unknown; description?: unknown; contentType?: unknown };
  const title = optionalText(request, "title", bag.title, ARTIFACT_CAPS.maxTitleLength);
  const description = optionalText(
    request,
    "description",
    bag.description,
    ARTIFACT_CAPS.maxDescriptionLength,
  );
  const contentType = request.op === "file" ? optionalContentType(request, bag.contentType) : undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

/** An optional bounded text option (title / description). The length is counted in characters (UTF-16 code units). */
function optionalText(
  request: ArtifactPublishRequest,
  name: string,
  value: unknown,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts.${name} must be a string, got ${describeArg(value)}.`,
    );
  }
  if (value.length > max) {
    // Reject rather than truncate: A title with the last half of the sentence chopped off is a bad deliverable that looks normal, whereas the card
    // Nowhere does it say "truncated here".
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.${request.op}: opts.${name} is ${value.length} characters, over the cap of ` +
        `${max}. Shorten it.`,
    );
  }
  return value;
}

/**
 * The override value for `opts.contentType`. The requirement is a **parameter-free** bare MIME (`type/subtype`): the consumer of this
 * string is an exact dispatch in the UI (`text/markdown` goes to the markdown card, `application/pdf` goes to the pdf card), so a
 * `text/markdown; charset=utf-8` misses that branch entirely, which shows up as "the type was set and it still fell into the download card".
 */
function optionalContentType(request: ArtifactPublishRequest, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType must be a string, got ${describeArg(value)}.`,
    );
  }
  if (!CONTENT_TYPE_PATTERN.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType '${value}' is not a bare MIME type such as ` +
        `'application/pdf'. Drop any parameters ('; charset=...'); the viewer dispatches on ` +
        `the exact string.`,
    );
  }
  return value;
}

// ———————————————————————————————— Internal: get bytes ——————————————————————————————

/** One piece of content to be written into the store. `file` goes through a binary write, `markdown` through a text write. */
type ArtifactPayload =
  | {
      readonly kind: "binary";
      readonly bytes: Uint8Array;
      readonly contentType: string;
      /** The extension of the on-disk file name (the store infers the type from the file name when reading it back, so it has to stay faithful). */
      readonly extension?: string;
      /** The original workspace-relative path (provenance + "show in workspace"). */
      readonly sourcePath: string;
    }
  | { readonly kind: "text"; readonly text: string; readonly contentType: "text/markdown" };

/** `artifact.file(id, path, opts)`: resolve the path -> read the bytes (cap+1 probe) -> determine the contentType. */
async function readFilePayload(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
  opts: ArtifactPublishOptions,
): Promise<ArtifactPayload> {
  const given = request.path;
  if (typeof given !== "string" || given === "") {
    // The engine has verified that the payload is a string; an empty string can only come from a wiring error.
    throw new WorkflowError(
      "DriverError",
      `artifact.file: path must be a non-empty string, got ${describeArg(given)}. Pass the ` +
        `workspace-relative path the subagent wrote.`,
    );
  }
  const { real, relative } = await resolveWorkspaceFile(deps, given);
  const bytes = await readCappedBytes(deps, given, real);
  const extension = fileExtension(real);
  return {
    kind: "binary",
    bytes,
    contentType:
      opts.contentType ??
      (extension === undefined ? undefined : EXTENSION_CONTENT_TYPES[extension]) ??
      // Not listed in the extension table = no guessing (no magic bytes sniffing). The UI accordingly gives "Download / in the workspace
      // Display the card instead of rendering something it can't read.
      "application/octet-stream",
    ...(extension === undefined ? {} : { extension }),
    sourcePath: relative,
  };
}

/**
 * Resolves the **workspace-relative** path the script passed in into a readable real path, and judges out-of-bounds twice.
 *
 * The first judgment is lexical ({@link resolveWithinWorkspace}, the same criterion as `files.read`); the second happens after
 * realpath -- **a symlink is judged out of bounds by its resolved real path**. The world-read
 * side deliberately does only the lexical check (the bytes it reads are the values the script itself sees, so whether they are out of bounds is the script's own business),
 * and this side cannot copy that: publishing copies the bytes **into a durable store and puts them in front of the user**, and a single symlink could turn
 * `~/.ssh/id_rsa` into a card. This re-check is where that invariant lands on the write side.
 *
 * `cwd` itself also has to be realpath'ed: on macOS `/tmp` is a symlink to `/private/tmp`, and without normalizing it every file inside the workspace
 * would be judged out of bounds.
 */
async function resolveWorkspaceFile(
  deps: ArtifactPublishDeps,
  given: string,
): Promise<{ real: string; relative: string }> {
  const resolved = resolveWithinWorkspace(deps.cwd, given);
  if (resolved === undefined) throw outsideWorkspace(given);
  // The source uses the path given by the script (after normalization), not realpath: the "display in workspace" on the card requires
  // Point back to the location that the user recognizes, not the landing point of the soft link.
  const relative = toWorkspaceRelative(deps.cwd, resolved);

  let realCwd: string;
  let real: string;
  try {
    realCwd = await realpath(deps.cwd);
  } catch (cause) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: cannot resolve the workspace root '${deps.cwd}': ${errorText(cause)}`,
      { cause },
    );
  }
  try {
    real = await realpath(resolved);
  } catch (cause) {
    // ENOENT (including a certain section in the middle does not exist) go here: the path does not exist and "pointing to a soft link target that does not exist" are the same thing.
    throw sourceMissing(given, cause);
  }
  if (resolveWithinWorkspace(realCwd, real) === undefined) throw outsideWorkspace(given);
  return { real, relative };
}

/**
 * Reads the bytes with a **cap+1 probe**: the port's `maxBytes` means "over it is `too_large`, no truncation", so by reading cap+1
 * "exactly cap bytes" (let through) and "over cap" (rejected) become distinguishable, and at worst only one extra byte is read.
 * The same idiom as in `files.grep` / `git.diff`.
 */
async function readCappedBytes(
  deps: ArtifactPublishDeps,
  given: string,
  path: string,
): Promise<Uint8Array> {
  const cap = ARTIFACT_CAPS.maxFileBytes;
  let result: FileSystemReadBytesResult;
  try {
    result = await deps.fileSystemPort.readBinaryFile({ path, maxBytes: cap + 1 });
  } catch (cause) {
    if (isFileSystemPortError(cause)) {
      if (cause.code === "too_large") throw tooLarge(given, cap);
      // not_found / is_directory / not_file are all "there is no ordinary file to publish here".
      if (cause.code === "not_found" || cause.code === "is_directory" || cause.code === "not_file") {
        throw sourceMissing(given, cause);
      }
    }
    throw new WorkflowError(
      "DriverError",
      `artifact.file: failed to read '${given}': ${errorText(cause)}`,
      { cause },
    );
  }
  if (result.content.byteLength > cap) throw tooLarge(given, cap);
  return result.content;
}

/** `artifact.markdown(id, content, opts)`: the body is measured in UTF-8 bytes and rejected when over the limit. */
function markdownPayload(request: ArtifactPublishRequest): ArtifactPayload {
  const content = request.content;
  if (typeof content !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.markdown: content must be a string, got ${describeArg(content)}.`,
    );
  }
  const bytes = Buffer.byteLength(content, "utf8");
  const cap = ARTIFACT_CAPS.maxMarkdownBytes;
  if (bytes > cap) {
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.markdown: content is ${bytes} bytes, over the cap of ${cap} bytes. Shorten ` +
        `it, or write the long content to a workspace file and publish it with artifact.file.`,
    );
  }
  return { kind: "text", text: content, contentType: "text/markdown" };
}

// —————————————————————————————— Internal: write store ————————————————————————————

/** A publish landing spot that is confirmed usable: the store itself + the session scope (see {@link ArtifactPublishDeps}). */
interface ArtifactStoreTarget {
  readonly store: ToolArtifactStorePort;
  readonly sessionId: SessionId;
}

/**
 * Confirms that this publish has a landing spot, otherwise `ArtifactStoreUnavailable`. **Probed per op**: a file needs a binary write
 * (`writeToolResultBinaryArtifact` is an optional method on the port), while markdown only needs a text write. A store with only a text
 * write can therefore publish markdown but not files -- and "cannot publish" is a named rejection, not shoving a PDF through the text
 * channel as UTF-8 (which would silently destroy the bytes).
 */
function requireArtifactStore(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
): ArtifactStoreTarget {
  const store = deps.artifactStore;
  if (store === undefined) {
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.${request.op}: cannot publish "${request.id}" because this assembly has no ` +
        `artifact store.`,
    );
  }
  if (request.op === "file" && store.writeToolResultBinaryArtifact === undefined) {
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.file: cannot publish "${request.id}" because this assembly's artifact store ` +
        `does not support binary writes.`,
    );
  }
  const sessionId = deps.parentSessionId;
  if (sessionId === undefined || sessionId === "") {
    // The presence of the store but the absence of the session id can only be a wiring error (both come in and out of the production assembly at the same time). Still reporting the same
    // Code: It's the same thing with scripts - there's no landing point for this release.
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.${request.op}: cannot publish "${request.id}" because the artifact store has ` +
        `no session scope (parent session id not wired).`,
    );
  }
  return { store, sessionId };
}

/**
 * Writes into the store. The four arguments are constrained as follows:
 *   - `retention: "project"` -- artifacts must outlive the session (the hub reads artifacts out of run history across sessions).
 *   - `toolName: "CreateWorkflow"` -- the owning tool of a publish is the very tool call that started this run.
 *   - `toolCallId: `${runId}:${siteId}@${ordinal}`` -- one copy of the bytes per version, and (run, site, ordinal)
 *     uniquely identifies exactly one publish (the version number is computed by the engine before dispatch, so a rerun of the same version = the same ordinal).
 *   - `sessionId` = the parent session.
 */
async function writePayload(
  target: ArtifactStoreTarget,
  request: ArtifactPublishRequest,
  payload: ArtifactPayload,
): Promise<ToolArtifactWriteResult> {
  const common = {
    sessionId: target.sessionId,
    toolCallId: `${request.runId}:${request.siteId}@${request.ordinal}`,
    toolName: ARTIFACT_TOOL_NAME,
    retention: "project" as const,
  };
  try {
    if (payload.kind === "text") {
      return await target.store.writeToolResultArtifact({
        ...common,
        content: payload.text,
        contentType: payload.contentType,
      });
    }
    // The existence of binary writes has been detected in requireArtifactStore (op === "file" branch).
    const writeBinary = target.store.writeToolResultBinaryArtifact;
    if (writeBinary === undefined) {
      throw new WorkflowError(
        "ArtifactStoreUnavailable",
        `artifact.file: cannot publish "${request.id}" because this assembly's artifact store ` +
          `does not support binary writes.`,
      );
    }
    return await writeBinary.call(target.store, {
      ...common,
      content: payload.bytes,
      contentType: payload.contentType,
      // The extension is given to the store along with the bytes: when it reads it back, it pushes back the type according to the file name on the disk. Losing the extension is equivalent to losing a copy of the file.
      // .xlsx is read as application/octet-stream.
      ...(payload.extension === undefined ? {} : { extension: payload.extension }),
    });
  } catch (cause) {
    if (cause instanceof WorkflowError) throw cause;
    // A write failure (disk full, permissions, store's own error) is a **specific** failure, not the same as "no store"
    // The same thing, so ArtifactStoreUnavailable is not reused: bring the reason text and let the journal
    // failure_json can tell why.
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: writing "${request.id}" v${request.version} to the artifact ` +
        `store failed: ${errorText(cause)}`,
      { cause },
    );
  }
}

// ———————————————————————————————— Pure support ————————————————————————————

/** The owning tool name of the artifact in the store: a publish is the artifact of that `CreateWorkflow` call. */
const ARTIFACT_TOOL_NAME = "CreateWorkflow";

/**
 * Extension -> MIME. Anything outside the table becomes `application/octet-stream`:
 * **no content sniffing** (magic bytes would introduce a second criterion, and two criteria will eventually give two answers).
 *
 * Why not reuse core's `inferAttachmentMimeFromPath`: that table serves **model input attachments**, and its
 * fallback is `text/plain` (feeding anything text-like to the model is the behavior it wants). The consumer here is the UI's
 * dispatch, so the fallback has to be "I don't recognize it, give it the download card" -- the correct value of the same fallback is exactly opposite in the two places.
 */
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** A bare MIME (`type/subtype`, no parameters). See the reasoning in {@link optionalContentType}. */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/**
 * The extension of the file name (lowercase, without the dot). Only `[a-z0-9]+` is accepted: `archive.tar.gz` yields `gz`,
 * while `Makefile`, `.gitignore` (a leading dot with no suffix) and `report.v2 final` all have no extension.
 */
function fileExtension(path: string): string | undefined {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : undefined;
}

function outsideWorkspace(given: string): WorkflowError {
  return new WorkflowError(
    "ArtifactPathOutsideWorkspace",
    `artifact.file: path '${given}' resolves outside the workspace (symlinks are judged by ` +
      `their real path). Only files inside the workspace can be published.`,
  );
}

function sourceMissing(given: string, cause: unknown): WorkflowError {
  return new WorkflowError(
    "ArtifactSourceMissing",
    `artifact.file: '${given}' does not exist or is not a regular file. Confirm the subagent ` +
      `actually wrote it before publishing.`,
    { cause },
  );
}

function tooLarge(given: string, cap: number): WorkflowError {
  return new WorkflowError(
    "ArtifactTooLarge",
    `artifact.file: '${given}' is over the cap of ${cap} bytes. Publish a smaller artifact ` +
      `(a summary, a slice, or a compressed version).`,
  );
}

/** A short description of the shape of the actual arguments (only for error messages; the full content is never echoed back). */
function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** A single line of text for anything thrown (for error messages). */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
