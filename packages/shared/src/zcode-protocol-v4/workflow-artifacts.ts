// ============================================================
// Protocol vocabulary for user-facing artifacts
// ============================================================
// ⚠ Terminology:
// The artifact of this module is the output of the script published to the user through `artifact.*` - a file, a markdown,
// Or a preset board fed by the `report` stream. It is in the same directory as `workflow-artifact.ts` (singular)
// `serializeWorkflowArtifact` **not the same thing**: that artifact is the engine's internal response to the "script top-level return value"
// The name (`RunSettlement.artifact`) is for the **model** to see. There is only one s difference between the two file names. When reading the code, press
// This comment distinguishes, do not rely on the file name.
//
// This module only stores the schema + the parameters/result shapes of three v4 queries. **Summary** element on status key
// (`workflowRuns[].artifacts`) also lives here instead of workflow-runs.ts: it is shared with three queries
// The enumeration of `kind` and the pruning rule of "without spec, without bytes, without items" will cause two differences sooner or later.
//
// Hierarchical: Bytes are never entered into any schema (except `workflowRunArtifactRead` which is base64 one block at a time).
// The authority is in the journal - `workflowRuns.artifacts` is just a signal of "whether there has been any change".

import { z } from "zod";

import { PROTOCOL_V4_LIMITS } from "./core.js";

/**
 * Member kinds of a user-facing artifact, = the six members of the facade `artifact.*`.
 *
 * Two families: content members (`file` / `markdown`) have bytes and version history; preset
 * boards (`chart` / `table` / `metrics` / `board`) have no bytes — every one of their data
 * points is a tagged `report` journal row (a board is a projection of the journal).
 *
 * A closed-set enum. Adding a value is a **breaking** skew (older readers reject the whole
 * frame), the same tier as `workflowRuns[].status`.
 */
export const workflowRunArtifactKindSchema = z.enum([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);
export type WorkflowRunArtifactKind = z.infer<typeof workflowRunArtifactKindSchema>;

/** Display upper bounds for artifact fields. The numbers are the contract — the engine-side caps of the same name live in `ARTIFACT_CAPS`. */
export const WORKFLOW_ARTIFACT_LIMITS = {
  maxIdLength: 64,
  maxTitleLength: 120,
  maxDescriptionLength: 500,
  /** ≤ 16 versions per id (`ARTIFACT_CAPS.maxVersionsPerArtifact`). */
  maxVersions: 16,
  /** Upper bound on entries in one page of `workflowRunArtifactData`; `limit` is clamped on the gateway side. */
  maxItemsPerPage: 500,
  /** Default entries per page (what the gateway uses when the caller passes no limit). */
  defaultItemsPerPage: 200,
} as const;

/**
 * The **metadata** of one artifact version (a zod mirror of `ArtifactVersionRecord` on the
 * journal's `dwf_node.result_json`). The bytes are not here — `uri` points into the
 * tool-artifact store, and fetching the bytes goes through `workflowRunArtifactRead`.
 *
 * `publishedAt` is **required**: the driver always writes `Date.now()` on every record (the
 * engine has no clock of its own, so the pure-package TS type is still optional). Making it
 * required here makes "a version with no moment" fail red at the protocol boundary, instead of
 * handing the UI's version stepper an undefined to sort with.
 */
export const workflowRunArtifactVersionSchema = z
  .object({
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    description: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxDescriptionLength).optional(),
    contentType: z.string().min(1).max(128).optional(),
    /** Size in bytes of this version in the store (content members only). */
    bytes: z.number().int().nonnegative().optional(),
    /** The store's `zcode-artifact://…`; **for the CLI side only** — neither the model nor the renderer can read it. */
    uri: z.string().min(1).max(512).optional(),
    /** Original path relative to the workspace (`file` only) — the card's locates the file by it. */
    sourcePath: z.string().min(1).max(1024).optional(),
    /** The spec of a preset board (canonical). Its shape is interpreted by each of the UI's four renderers; the protocol does not restate it. */
    spec: z.unknown().optional(),
    /** Publication moment (epoch milliseconds). */
    publishedAt: z.number().int().nonnegative(),
    /** This version is the run's deliverable; the engine stamps it, and it sticks per id. */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifactVersion = z.infer<typeof workflowRunArtifactVersionSchema>;

/**
 * **All** versions of one artifact plus the count of the tagged reports fed to it. The element
 * of the `workflowRunArtifacts` query, and the durable way to read it for cold recovery and the
 * hub detail view.
 *
 * The top-level `title` / `description` / `contentType` / `sourcePath` / `spec` take the values
 * of the **latest version**: a reader who only cares about "what is it now" need not walk
 * `versions` themselves. Same shape as contracts' `DynamicWorkflowRunArtifact` (there a TS
 * mirror, here the wire-level validation).
 */
export const workflowRunArtifactSchema = z
  .object({
    id: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: workflowRunArtifactKindSchema,
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    description: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxDescriptionLength).optional(),
    contentType: z.string().min(1).max(128).optional(),
    sourcePath: z.string().min(1).max(1024).optional(),
    spec: z.unknown().optional(),
    /** Latest version number (= the version of the last entry in `versions`). */
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    /** Ascending by version. Failed publications are **not** here: a failed row claims no id / kind / version. */
    versions: z.array(workflowRunArtifactVersionSchema).max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    /** Number of `report` entries tagged with this id (the data volume of a preset board; always 0 for content artifacts). */
    itemCount: z.number().int().nonnegative(),
    /** The run's deliverable (at most one); the listing is led by it. */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifact = z.infer<typeof workflowRunArtifactSchema>;

/**
 * An element of `workflowRuns[].artifacts`: **metadata of the latest version only**.
 *
 * Deliberately without `versions` / `spec` / `sourcePath` / `uri`, and certainly without bytes
 * or entries: this is a hot state key, and its readers only need to know "which artifacts
 * exist, which version is current, has anything changed". To actually look at the content, the
 * two queries (`workflowRunArtifacts` for the full metadata, `workflowRunArtifactData` for the
 * board entries, `workflowRunArtifactRead` for the bytes) pull it on demand — the authority
 * always stays in the journal.
 *
 * `itemCount`'s job here is as a **refresh signal**: when a board hook sees it change, it
 * re-fetches incrementally with `afterSequence`. Putting the raw values of the tagged reports
 * into the snapshot would let the worst case of 256 × 32KB push the state frame to 2MB.
 */
export const workflowRunArtifactSummarySchema = z
  .object({
    id: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: workflowRunArtifactKindSchema,
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    contentType: z.string().min(1).max(128).optional(),
    bytes: z.number().int().nonnegative().optional(),
    itemCount: z.number().int().nonnegative().optional(),
    /** The run's deliverable (at most one). The UI uses it to order artifacts and pick a form; absent means it is not one. */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifactSummary = z.infer<typeof workflowRunArtifactSummarySchema>;

// ── v4 query ①: workflowRunArtifacts (product list)──
// Same family as workflowRunEvents: read-only, stateless, timeout retransmission safe, deliberately not v4 command.
// Also **without** atSeq / atLogEpoch: the journal is read, it has nothing to do with the conversation log, and there is no staleness to prevent
// (For the complete argument, see the comment after the workflowRunEvents result schema in transport.ts).
// The new method is naturally biased towards safety - the old desktop wouldn't call it at all.
export const v4ConversationWorkflowRunArtifactsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactsParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactsParamsSchema
>;

export const v4ConversationWorkflowRunArtifactsResultSchema = z
  .object({
    /** In first-seen order (= the ordinal of the first artifact row with that id in the journal). */
    artifacts: z.array(workflowRunArtifactSchema),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactsResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactsResultSchema
>;

// ── v4 query ②: workflowRunArtifactData (the data acquisition side of the preset Kanban board)──
// Deliberately **not reusing** workflowRunEvents: Then you have to go through the entire journal to filter out an entry with an id.
// cursor = journal sequence (same cursor semantics as event log, `afterSequence` is strictly greater than).
export const v4ConversationWorkflowRunArtifactDataParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    artifactId: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    /** Only returns entries whose sequence is strictly greater than this value; by default, from the beginning. */
    afterSequence: z.number().int().nonnegative().optional(),
    /** Default 200, clamped to [1, 500] — both are enforced on the gateway side (the storage layer must not invent page sizes, nor clamp again). */
    limit: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactDataParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactDataParamsSchema
>;

export const v4ConversationWorkflowRunArtifactDataResultSchema = z
  .object({
    items: z.array(
      z
        .object({
          /** Journal sequence — sent back as `afterSequence` it becomes the next page's cursor. */
          sequence: z.number().int().nonnegative(),
          /** The report site that produced this entry (e.g. `report#1`). */
          siteId: z.string().min(1).max(64),
          ordinal: z.number().int().nonnegative(),
          /**
           * The raw entry value, **not preview-serialized**: a board's pure functions read it by
           * field path (`ChartSpec.x.field` shaped like "timing.after"), and a pretty JSON text
           * would make that impossible. A single entry is already bounded twice on the wire by
           * `REPORT_CAPS.maxItemSerializedBytes` (32KB) and by the event payload bound, so no
           * extra bound is stacked on here.
           */
          item: z.unknown(),
        })
        .strict(),
    ),
    /** This page filled the limit and more entries remain behind it (the gateway fetches one extra to decide). */
    hasMore: z.boolean(),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactDataResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactDataResultSchema
>;

// ── v4 query ③: workflowRunArtifactRead (bytes of content product)──
// **Verbatim `v4AttachmentRead*`**: ≤ 512 KiB chunk (PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
// The same constant (no additional casting), host→CLI's existing proof of ≤ 1 MiB per request is therefore carried over as is.
//
// Deliberately not reusing attachmentRead itself: it is authorized by the user row of the conversation, and the product does not hang on any messages
// OK. The authorization chain is on the CLI side: sessionId must be the parentSessionId of the run ∧
// (artifactId, version) There is a completed row in the journal ⇒ Then take the uri on the row and go to the store to read it.
// Any id passed by the renderer **never** directly becomes a path - the same discipline as attachmentRead.
export const v4ConversationWorkflowRunArtifactReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    artifactId: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactReadParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactReadParamsSchema
>;

export const v4ConversationWorkflowRunArtifactReadResultSchema = z
  .object({
    /** base64 (without the data: prefix); ≤ attachmentChunkMaxBytes once decoded. */
    dataBase64: z.string(),
    /**
     * The contentType of that version, taken from the journal record (the driver derives it from
     * the extension table, and `opts.contentType` can override it) — that is the **exact match**
     * contract the UI dispatches renderers on. Deliberately unlike attachmentRead, mediaType is
     * not pinned to image/video/pdf: the legal artifact types are exactly the driver's 17-entry
     * extension table plus `application/octet-stream`, and pinning would make markdown and office
     * files entirely unreadable.
     */
    mediaType: z.string().min(1).max(128),
    /** Total bytes of that version (≤ ARTIFACT_CAPS.maxFileBytes = attachmentMaxBytes). */
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    /** Offset of the next chunk; null when this chunk reached the end. */
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "workflow artifact read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4ConversationWorkflowRunArtifactReadResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactReadResultSchema
>;

/**
 * The decoded byte length of a base64 string; invalid input returns null.
 *
 * Identical to the private helper of the same name in transport.ts rather than exporting that
 * one: that file does not export it, and importing it would create a cycle — transport.ts →
 * snapshot.ts → workflow-runs.ts → this module. Copying ten lines of pure arithmetic is cheaper
 * than opening a new public module for it — if the two ever drift, the superRefine tests on both
 * sides go red.
 */
function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
