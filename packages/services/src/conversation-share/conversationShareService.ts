/* oxlint-disable eslint(max-lines) -- Publishing, remote staging, safe polling and atomic import share one attempt lifecycle; splitting them would leave cleanup and progress state without a single owner. */
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import type {
  ConversationShareArtifactDescriptor,
  ConversationShareCapabilities,
  ConversationShareConfirmRequest,
  ConversationShareContinuation,
  ConversationShareRecord,
  Locale,
} from "@zcode/shared";
import {
  decodeConversationShareRows,
  buildConversationPreviewArtifactCandidates,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
  extractConversationPreviewFileReferences,
  type ConversationPreviewArtifactCandidate,
  localizeConversationShareUrl,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  readZCodeAttachmentFaultCode,
} from "@zcode/shared/zcode-protocol-v4";
import { Emitter } from "@zcode/rpc";

import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "#src/zcode-session/zcodeSession.js";
import { getConversationWorkspaceDir } from "#src/paths.js";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ConversationShareServiceError,
  sanitizeConversationShareIssues,
  type IConversationShareService,
  type PublishTextConversationInput,
  type ConversationSharePublishProgress,
  type ConversationShareImportProgress,
  type ConversationShareFailureIssue,
  type ConversationSharePreflightInput,
  type ConversationSharePreflightResult,
  type ConversationShareAllowedArtifact,
  type ConversationShareTurnPreflightResult,
  type ImportConversationShareInput,
  type ImportConversationShareResult,
  type ImportedConversationShare,
} from "./conversationShare.js";
import {
  ConversationShareClientError,
  type ConversationShareHttpClient,
} from "./conversationShareHttpClient.js";
import {
  buildConversationShareArtifactSnapshot,
  getConversationSharePreviewCandidateFingerprint,
  type ConversationSharePreviewPreflightSnapshot,
} from "./conversationShareArtifactDiscovery.js";
import {
  buildConversationShareConfirmRequest,
  sha256ConversationShareJson,
} from "./conversationShareIntegrity.js";
import { buildConversationSharePublicProjection } from "./conversationSharePublicProjection.js";
import type { ConversationShareArtifactSource } from "./conversationShareArtifactSource.js";
import { formatSharedContextV1 } from "./sharedContextFormatter.js";

const DEFAULT_CONFIRM_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CONFIRM_POLL_TIMEOUT_MS = 120_000;
// download cannot be a bare fetch (no AbortSignal/timeout): the import will stop at when the object storage connection hangs
// The downloading stage until undici defaults to ~300s, which is equivalent to a stuck experience. 120s covers large artifacts on slow downlinks.
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MISSING_ARTIFACT_ERRNOS = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
// The upper limit of the preflight snapshot: the maximum number of entries in the selected round can be written in a single share, and 200 is enough to cover a normal session.
// It also ensures that the permanent host will not grow indefinitely due to "always pre-checking and never publishing".
const PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES = 200;
// The concurrency upper limit of pre-check stat: there is almost no difference locally, and every stat is performed once under SSH/remote workspace
// Network round-trip, serial will make the "next step" stop at checking for a long time. The upper limit ensures that the remote host will not be overwhelmed.
const SHARE_PREFLIGHT_STAT_CONCURRENCY = 6;

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Bounded-concurrency map that keeps output in the same order as input.
 *
 * Every preflight stat is a network round trip under SSH/remote workspaces, so running them
 * serially would keep "Next" stuck in checking for a long time. The concurrency cap exists so
 * we do not overwhelm the remote host; results are written back by index, so the order in
 * which issues are produced stays deterministic (identical to a serial implementation).
 */
async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  limit: number,
  run: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (items.length === 0) return [];
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Result of a stat or the reason it failed; the concurrent phase only collects, classification still happens in the order-preserving second pass. */
type SettledResult<Value> = { ok: true; value: Value } | { ok: false; error: unknown };

async function settle<Value>(run: () => Promise<Value>): Promise<SettledResult<Value>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function isMissingArtifactReadError(error: unknown): boolean {
  return (
    error instanceof ConversationShareServiceError &&
    error.reasonCode === "artifact_read_failed" &&
    typeof error.diagnostics?.errno === "string" &&
    MISSING_ARTIFACT_ERRNOS.has(error.diagnostics.errno)
  );
}

function sanitizeFileSegment(value: string): string {
  const forbidden = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  return [...value.normalize("NFKC")]
    .map((character) =>
      character.codePointAt(0)! < 32 || forbidden.has(character) ? "-" : character,
    )
    .join("");
}

function uniqueImportedFileName(
  displayName: string,
  artifactId: string,
  usedNames: Set<string>,
): string {
  const base =
    sanitizeFileSegment(basename(displayName.replace(/\\/gu, "/")))
      .replace(/^[. ]+|[. ]+$/gu, "")
      .slice(0, 180) || "artifact";
  let candidate = base;
  if (usedNames.has(candidate.toLowerCase())) {
    const dot = base.lastIndexOf(".");
    const suffix = artifactId.replace(/[^A-Za-z0-9]/gu, "").slice(-8) || "artifact";
    candidate = dot > 0 ? `${base.slice(0, dot)}-${suffix}${base.slice(dot)}` : `${base}-${suffix}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

interface ConversationShareServiceOptions {
  zcodeAgentService: ConversationShareAgentService;
  client: ConversationShareHttpClient;
  artifactSource: ConversationShareArtifactSource;
  confirmPollIntervalMs?: number;
  confirmPollTimeoutMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  zcodeSessionService?: Pick<IZCodeSessionService, "createSession" | "listSessions">;
  download?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** Timeout for a single artifact download (including reading the body); 120s by default. */
  downloadTimeoutMs?: number;
  conversationWorkspaceRoot?: string;
  /** Canonical share page root address, injected only by the Desktop Host. */
  shareWebUrl?: string;
  logger?: ServiceLogger;
}

type ConversationShareAgentService = Pick<
  IZCodeAgentService,
  | "conversationRowsRangeV4"
  | "conversationFileChangesV4"
  | "conversationAttachmentReadV4"
  | "conversationAttachmentStatV4"
>;

/** Symbol methods cannot be called by a string-command ProxyChannel; this exists only for Desktop Host attachment wiring. */
export const conversationShareConnectionScopeFactory = Symbol(
  "conversationShareConnectionScopeFactory",
);

const CONNECTION_UNAVAILABLE_ERRORS = new Set([
  "fault.conversation.rowsRangeConnectionUntrusted",
  "fault.connection.handshakeRequired",
  "fault.connection.closed",
]);

function normalizeConversationShareConnectionError(error: unknown): unknown {
  if (error instanceof Error && CONNECTION_UNAVAILABLE_ERRORS.has(error.message)) {
    return new ConversationShareServiceError(
      "connection_unavailable",
      "Conversation share connection is not ready",
    );
  }
  return error;
}

function workspaceKeyOf(path: string | undefined, identity: string | undefined): string {
  return identity?.trim() || path?.trim() || "__default_conversation_workspace__";
}

function importDedupeKey(shareCode: string, workspaceKey: string): string {
  return `${shareCode}\u0000${workspaceKey}`;
}

function previewPreflightKey(
  input: Pick<
    PublishTextConversationInput | ConversationSharePreflightInput,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
  >,
  productTurnId: string,
): string {
  return [
    workspaceKeyOf(input.workspacePath, input.workspaceIdentity),
    input.remoteSessionId ?? "",
    input.sessionId,
    productTurnId,
  ].join("\u0000");
}

/**
 * Title prefix for an imported session. The services layer has no intl, so only a minimal
 * mapping lives here; the prefix is fixed at import time and persisted as session.title
 * (titleSource: "custom"), and switching UI language afterwards does not rewrite it.
 */
const IMPORTED_SHARE_TITLE_PREFIX: Readonly<Record<Locale, string>> = {
  "en-US": "From Share: ",
};

function formatImportedShareSessionTitle(shareTitle: string, locale: Locale | undefined): string {
  return `${IMPORTED_SHARE_TITLE_PREFIX[locale ?? "en-US"]}${shareTitle.trim()}`;
}

function localizePublishedShare(
  share: ConversationShareRecord,
  locale: Locale | undefined,
): ConversationShareRecord {
  if (!locale) return share;
  const shareUrl = localizeConversationShareUrl(share.share_url);
  return shareUrl === share.share_url ? share : { ...share, share_url: shareUrl };
}

/** Format version of the read-only copy produced by this client; evolves independently from the wire schema_version. */
const IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION = 1;

/**
 * Shape of the read-only copy written to disk; it comes from disk and must be validated
 * before rendering.
 *
 * Both formatVersion and rows are deliberately lenient: when a user downgrades after having
 * imported a session on a newer version, the read-only block should still show up as much as
 * possible (unrecognized rows are skipped plus a soft notice at the top) instead of silently
 * disappearing entirely and making users think the content was lost.
 */
const importedConversationShareFileSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    shareId: z.string().trim().min(1),
    contextId: z.string().trim().min(1),
    title: z.string(),
    rows: z.array(z.unknown()),
    artifacts: z.array(
      z.object({
        artifactId: z.string().trim().min(1),
        displayName: z.string(),
        mimeType: z.string().optional(),
        workspaceRelativePath: z.string().optional(),
      }),
    ),
  })
  .strip();

interface ConversationRowsRead {
  rows: ConversationRow[];
  revision: number;
  logEpoch: string;
}

function turnOrdinalByProductTurn(rows: readonly ConversationRow[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId || result.has(row.productTurnId)) continue;
    result.set(row.productTurnId, result.size + 1);
  }
  return result;
}

function rowTurnOrdinal(row: ConversationRow, ordinals: Map<string, number>): number | undefined {
  return row.productTurnId ? ordinals.get(row.productTurnId) : undefined;
}

function hasUnsafeShareString(value: unknown): boolean {
  if (typeof value === "string") return /^(?:data|file):/iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsafeShareString);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === "ref" ? false : hasUnsafeShareString(entry),
  );
}

function hasUnsupportedArtifactReference(value: unknown): boolean {
  if (typeof value === "string") return /^zcode-artifact:\/\//iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsupportedArtifactReference);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === "ref" ? false : hasUnsupportedArtifactReference(entry),
  );
}

/**
 * Silently removes finalized internal structures the V1 public projection cannot carry:
 * non-publishable fields or whole rows are dropped while the rest of the turn is kept, so
 * publishing is no longer blocked outright and internal rendering structures are not exposed
 * as user-facing errors.
 *
 * Only "finalized but not carryable" content is downgraded; in-flight turns/rows/tools/
 * subagents are still blocked by collectShareStructureIssues — that content is not finalized
 * yet, and skipping it would mean sharing a half-finished result.
 */
function sanitizeUnsupportedShareStructures(rows: readonly ConversationRow[]): ConversationRow[] {
  const sanitized: ConversationRow[] = [];
  for (const row of rows) {
    if (row.kind === "toolCall" && row.display?.kind === "node_repl_images") {
      // The embedded image is in base64 of display.images. Deleting display will remove all image bytes.
      const { display: _display, ...rest } = row;
      // These images cannot be closed in the public projection, but do not require user processing; they are silently removed to avoid internal
      // The renderer structure falsely reported that "a file was skipped".
      sanitized.push(rest);
      continue;
    }
    if (row.kind === "timelineMarker") {
      // The running marker remains, allowing collectShareStructureIssues to block as usual - the content is not yet finalized.
      // Blocked releases will not enter the projection, leaving this marker without side effects.
      const markerRunning =
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running");
      if (markerRunning) {
        sanitized.push(row);
        continue;
      }
      if (
        row.marker.type === "forkNotice" ||
        row.marker.type === "forkCreated" ||
        row.marker.type === "checkpointRestored"
      ) {
        // The branch/rollback marker only carries the local session relationship, and the public page is not rendered; it cannot be removed directly and cannot be
        // Internal timeline structure counts as "file skipped" or bothers users.
        continue;
      }
      // The remaining markers are peeled off silently without disturbing the sharer:
      // - compact (context is compressed) pure runtime accounting, no value to read-only readers; and its lane is
      //   assistantWork, staying at the end of the flow will push out the "final text" collapse anchor, allowing the entire process to expand by default.
      //   (assistantHistoryDefaultOpen of conversationTurnWorkSegments.ts) - This is the main reason why it has to go.
      // - goalVerify / goalSet / retryNotice are not rendered on the shared page, and they only occupy the max_rows quota.
      // - modelChange can only display a generalized "model has been switched", which has low information content and exposes internal model-changing behavior.
      continue;
    }
    if (row.kind === "toolCall" && row.toolName === "EnterPlanMode") {
      // EnterPlanMode is only the internal mode switching boundary, and the rendering layer (isVisibleAssistantWorkRow) is originally filtered out.
      // But it will still enter the payload max_rows / max_payload_bytes quota and never be displayed.
      continue;
    }
    sanitized.push(row);
  }
  return sanitized;
}

function sanitizeUnsupportedShareArtifacts(
  rows: readonly ConversationRow[],
  capabilities: ConversationShareCapabilities,
  ordinalRows: readonly ConversationRow[],
): { rows: ConversationRow[]; warnings: ConversationShareFailureIssue[] } {
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const warnings: ConversationShareFailureIssue[] = [];
  const retained = rows.filter((row) => {
    if (row.kind !== "artifact") return true;
    const extension = fileExtension(row.displayName);
    const mimeType = normalizedMimeType(row.mimeType);
    const allowed = capabilities.allowed_artifacts.find(
      (candidate) =>
        candidate.type === row.artifactType &&
        candidate.extensions.some(
          (value) => value.replace(/^\./u, "").toLowerCase() === extension,
        ) &&
        candidate.mime_types.some((value) => value.toLowerCase() === mimeType),
    );
    if (allowed) return true;
    warnings.push({
      code: "artifact_type_not_allowed",
      scope: "artifact",
      rowId: row.rowId,
      ...(row.productTurnId && ordinals.has(row.productTurnId)
        ? { turnOrdinal: ordinals.get(row.productTurnId) }
        : {}),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
      artifactDisplayName: row.displayName,
      artifactType: row.artifactType,
      ...(extension ? { extension } : {}),
      mimeType,
      allowedFormats: allowedFormatLabels(capabilities),
      allowedArtifacts: allowedArtifactSummaries(capabilities),
    });
    return false;
  });
  return { rows: retained, warnings };
}

function collectShareStructureIssues(
  rows: readonly ConversationRow[],
  ordinalRows: readonly ConversationRow[] = rows,
): ConversationShareFailureIssue[] {
  const issues: ConversationShareFailureIssue[] = [];
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const add = (row: ConversationRow, code: ConversationShareFailureIssue["code"]) => {
    issues.push({
      code,
      scope: code === "missing_product_turn" ? "conversation" : "turn",
      ...(row.rowId === undefined ? {} : { rowId: row.rowId }),
      ...(rowTurnOrdinal(row, ordinals) === undefined
        ? {}
        : { turnOrdinal: rowTurnOrdinal(row, ordinals) }),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
    });
  };
  for (const row of rows) {
    if (!row.productTurnId) add(row, "missing_product_turn");
    if (row.kind === "turnHeader" && row.state === "running") add(row, "running_turn");
    if ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") {
      add(row, "streaming_row");
    }
    if (
      row.kind === "toolCall" &&
      (row.status === "inputStreaming" ||
        row.status === "pendingApproval" ||
        row.status === "running")
    ) {
      add(row, "active_tool_call");
    }
    if (row.kind === "subagent" && row.status === "running") add(row, "active_subagent");
    if (row.kind === "timelineMarker") {
      // Only "running" timeline operations are still blocked; fork/checkpoint/compact summaryRef has been
      // sanitizeUnsupportedShareStructures downgraded to skipped.
      if (
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")
      ) {
        add(row, "unsupported_timeline");
      }
    }
    if (hasUnsafeShareString(row)) add(row, "unsafe_url");
    if (hasUnsupportedArtifactReference(row)) add(row, "artifact_protocol_not_ready");
  }
  return issues;
}

function allowedFormatLabels(capabilities: ConversationShareCapabilities): string[] {
  return capabilities.allowed_artifacts.flatMap((allowed) =>
    allowed.extensions.map(
      (extension) => `${allowed.type.toUpperCase()} (.${extension.replace(/^\./u, "")})`,
    ),
  );
}

function allowedArtifactSummaries(
  capabilities: ConversationShareCapabilities,
): ConversationShareAllowedArtifact[] {
  return capabilities.allowed_artifacts.map((allowed) => ({
    type: allowed.type,
    extensions: [...allowed.extensions],
    mimeTypes: [...allowed.mime_types],
  }));
}

function capabilitiesFingerprint(capabilities: ConversationShareCapabilities): string {
  return createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
}

function fileExtension(fileName: string): string | undefined {
  const baseName = fileName.replace(/\\/gu, "/").split("/").at(-1) ?? fileName;
  const dot = baseName.lastIndexOf(".");
  return dot > 0 && dot < baseName.length - 1 ? baseName.slice(dot + 1).toLowerCase() : undefined;
}

function normalizedMimeType(mime: string): string {
  return mime.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function attachmentDisplayName(fileName: string): string {
  return basename(fileName.replace(/\\/gu, "/")) || "attachment";
}

function allowedArtifactFor(
  capabilities: ConversationShareCapabilities,
  extension: string | undefined,
  mimeType: string,
) {
  if (!extension) return undefined;
  return capabilities.allowed_artifacts.find(
    (allowed) =>
      allowed.extensions.some((value) => value.replace(/^\./u, "").toLowerCase() === extension) &&
      allowed.mime_types.some((value) => value.toLowerCase() === mimeType),
  );
}

/**
 * Attachment error classification uniformly goes through the stable protocol-side fault codes
 * (see attachment-faults.ts).
 *
 * Classifying by `error.message` regex is not allowed: it breaks as soon as the RPC wrapper or
 * schema validation changes — the ZodError of an oversized attachment used to be misjudged as
 * "unknown" there and downgraded to deferred, silently dropping content. A single errno text
 * fallback is kept only for when the fault code is absent, covering older zcode-cli builds that
 * do not carry structured codes yet.
 */
function isDefiniteMissingAttachment(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.statNotFile
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|not found|not_found|statNotFile|is_directory/iu.test(message);
}

function isAttachmentAuthorizationError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /shareStatNotAuthorized|shareReadNotAuthorized|connectionUntrusted/iu.test(message);
}

/** Attachment size exceeds what the protocol/channel can carry: it must already surface as a definite block at the selection stage. */
function isAttachmentTooLargeError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  return (
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge ||
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge
  );
}

function buildTurnPreflightResults(
  productTurnIds: readonly string[],
  turnOrdinalByProductTurnId: ReadonlyMap<string, number>,
  blockingIssues: readonly ConversationShareFailureIssue[],
  skippableWarnings: readonly ConversationShareFailureIssue[],
  deferredIssues: readonly ConversationShareFailureIssue[],
): ConversationShareTurnPreflightResult[] {
  return productTurnIds.map((productTurnId) => {
    const turnOrdinal = turnOrdinalByProductTurnId.get(productTurnId);
    const forTurn = (issues: readonly ConversationShareFailureIssue[]) =>
      issues.filter(
        (issue) =>
          issue.turnOrdinal === turnOrdinal ||
          (issue.turnOrdinal === undefined &&
            issue.rowId === undefined &&
            issue.artifactDisplayName === undefined &&
            (issue.scope === "conversation" || issue.scope === "transport")),
      );
    return {
      productTurnId,
      blockingIssues: forTurn(blockingIssues),
      skippableWarnings: forTurn(skippableWarnings),
      deferredIssues: forTurn(deferredIssues),
    };
  });
}

function removeIndependentArtifactRows(rows: readonly ConversationRow[]): ConversationRow[] {
  // Sharing candidates are only user input attachments and the final visible Assistant preview card; historical artifact row
  // If there is no corresponding preview card, it will no longer enter the public projection as the third independent discovery source.
  return rows.filter((row) => row.kind !== "artifact");
}

function throwServiceError(
  kind: ConstructorParameters<typeof ConversationShareServiceError>[0],
  message: string,
): never {
  throw new ConversationShareServiceError(kind, message);
}

function selectRows(
  rows: ConversationRow[],
  selection: PublishTextConversationInput["selection"],
): { rows: ConversationRow[]; productTurnIds: string[] } {
  let selectedProductTurnIds: Set<string>;
  if (selection.kind === "all") {
    selectedProductTurnIds = new Set(
      rows
        .filter((row) => row.kind === "turnHeader")
        .map((row) => row.productTurnId)
        .filter((value): value is string => value !== undefined),
    );
  } else if (selection.kind === "productTurns") {
    if (selection.productTurnIds.length === 0) {
      throwServiceError("invalid_selection", "At least one product turn must be selected");
    }
    selectedProductTurnIds = new Set(selection.productTurnIds);
  } else {
    if (selection.rowIds.length === 0) {
      throwServiceError("invalid_selection", "At least one conversation row must be selected");
    }
    const rowsById = new Map(rows.map((row) => [row.rowId, row]));
    selectedProductTurnIds = new Set<string>();
    for (const rowId of new Set(selection.rowIds)) {
      const row = rowsById.get(rowId);
      if (!row?.productTurnId) {
        throwServiceError("invalid_selection", "A selected row no longer exists");
      }
      selectedProductTurnIds.add(row.productTurnId);
    }
  }

  const orderedProductTurnIds: string[] = [];
  const headerCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId) continue;
    headerCounts.set(row.productTurnId, (headerCounts.get(row.productTurnId) ?? 0) + 1);
    if (selectedProductTurnIds.has(row.productTurnId)) {
      orderedProductTurnIds.push(row.productTurnId);
    }
  }
  if (
    orderedProductTurnIds.length === 0 ||
    orderedProductTurnIds.length !== selectedProductTurnIds.size ||
    orderedProductTurnIds.some((productTurnId) => headerCounts.get(productTurnId) !== 1)
  ) {
    throwServiceError("invalid_selection", "Selected product turns are incomplete or ambiguous");
  }

  const selectedTurnIds = new Set(
    rows
      .filter(
        (row) =>
          row.kind === "turnHeader" &&
          row.productTurnId !== undefined &&
          selectedProductTurnIds.has(row.productTurnId),
      )
      .map((row) => row.turnId),
  );

  return {
    productTurnIds: orderedProductTurnIds,
    // The old projection may be missing productTurnId; as long as the turnId falls in the selected round, it must be retained so that the verification can be explicitly rejected.
    // You cannot publish an incomplete session after silently dropping lines during filtering.
    rows: rows.filter(
      (row) =>
        (row.productTurnId !== undefined && selectedProductTurnIds.has(row.productTurnId)) ||
        (row.productTurnId === undefined && selectedTurnIds.has(row.turnId)),
    ),
  };
}

export class ConversationShareService implements IConversationShareService {
  private readonly zcodeAgentService: ConversationShareAgentService;
  private readonly client: ConversationShareHttpClient;
  private readonly artifactSource: ConversationShareArtifactSource;
  private readonly confirmPollIntervalMs: number;
  private readonly confirmPollTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly progressEmitters = new Map<string, Emitter<ConversationSharePublishProgress>>();
  private readonly importProgressEmitters = new Map<
    string,
    Emitter<ConversationShareImportProgress>
  >();
  private readonly zcodeSessionService?: Pick<
    IZCodeSessionService,
    "createSession" | "listSessions"
  >;
  private readonly download: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  private readonly downloadTimeoutMs: number;
  private readonly conversationWorkspaceRoot: string;
  private readonly shareWebUrl: string;
  private readonly importIndexPath: string;
  private readonly logger: ServiceLogger;
  private readonly publishPhases = new Map<string, ConversationSharePublishProgress["phase"]>();
  // The selection phase shares the "final visible card" boundary with the publish phase; publish will still re-stat/read, but not
  // Include candidates that have been hidden by the UI due to missingness during the selection phase.
  //
  // Life cycle: desktop host is a permanent process. This table originally only deleted a single entry when the stat was not settled.
  // It will increase monotonically with the time of use. There are now two recycling processes: publishing the final state and cleaning it according to the session prefix;
  // And the FIFO upper limit during set (covering the path where users give up sharing midway and never publish).
  private readonly previewPreflightSnapshots = new Map<
    string,
    ConversationSharePreviewPreflightSnapshot
  >();
  private readonly completedImports = new Map<string, ImportConversationShareResult>();
  private readonly completedImportsByWorkspace = new Map<string, ImportConversationShareResult>();
  private readonly inFlightImports = new Map<string, Promise<ImportConversationShareResult>>();
  private readonly inFlightImportsByWorkspace = new Map<
    string,
    Promise<ImportConversationShareResult>
  >();
  private completedImportsLoaded!: Promise<void>;
  private importIndexWriteChain: Promise<void> = Promise.resolve();

  constructor(options: ConversationShareServiceOptions) {
    this.zcodeAgentService = options.zcodeAgentService;
    this.client = options.client;
    this.artifactSource = options.artifactSource;
    this.confirmPollIntervalMs = options.confirmPollIntervalMs ?? DEFAULT_CONFIRM_POLL_INTERVAL_MS;
    this.confirmPollTimeoutMs = options.confirmPollTimeoutMs ?? DEFAULT_CONFIRM_POLL_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? wait;
    this.zcodeSessionService = options.zcodeSessionService;
    this.download = options.download ?? ((url, init) => fetch(url, { signal: init?.signal }));
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    this.conversationWorkspaceRoot =
      options.conversationWorkspaceRoot ?? getConversationWorkspaceDir();
    // The production site https://zcode.z.ai/cn/share was written down thoroughly, so the test environment (API base) was
    // After the configured ZCode origin) is imported, the backlink still points to the production site, and the dotted dividing line opens the sharing of another environment.
    // Use the same environment parser as the API base instead (buildRuntimeZCodeApiUrl also uses it) to ensure the same environment.
    // Priority unchanged: explicit option > ZCODE_CONVERSATION_SHARE_WEB_URL > deduced by environment.
    this.shareWebUrl = (
      options.shareWebUrl ??
      process.env.ZCODE_CONVERSATION_SHARE_WEB_URL ??
      `${resolveRuntimeZCodeEndpointOrigin(process.env)}/cn/share`
    ).replace(/\/+$/u, "");
    this.importIndexPath = join(this.conversationWorkspaceRoot, ".zcode-share-imports.json");
    this.logger = options.logger ?? createServiceLogger("conversation-share");
    this.completedImportsLoaded = this.loadCompletedImportIndex();
    if (this.zcodeSessionService) {
      void this.cleanupAbandonedImports().catch(() => undefined);
    }
  }

  getCapabilities() {
    return this.client.getCapabilities();
  }

  /** Writes a preflight snapshot and, once the cap is exceeded, evicts the oldest entries in insertion order (Map preserves insertion order). */
  private setPreviewPreflightSnapshot(
    key: string,
    snapshot: ConversationSharePreviewPreflightSnapshot,
  ): void {
    // When rewriting the same key, delete it first and then insert it, so that it returns to the end of the insertion order. Elimination is the real "most recently updated" key.
    this.previewPreflightSnapshots.delete(key);
    this.previewPreflightSnapshots.set(key, snapshot);
    while (this.previewPreflightSnapshots.size > PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES) {
      const oldestKey = this.previewPreflightSnapshots.keys().next().value;
      if (oldestKey === undefined) break;
      this.previewPreflightSnapshots.delete(oldestKey);
    }
  }

  /** Reclaims all preflight snapshots of that workspace+session once sharing finishes. */
  private clearPreviewPreflightSnapshots(
    input: Pick<
      PublishTextConversationInput | ConversationSharePreflightInput,
      "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
    >,
  ): void {
    const prefix = previewPreflightKey(input, "");
    for (const key of this.previewPreflightSnapshots.keys()) {
      if (key.startsWith(prefix)) this.previewPreflightSnapshots.delete(key);
    }
  }

  async preflight(
    input: ConversationSharePreflightInput,
  ): Promise<ConversationSharePreflightResult> {
    try {
      return await this.preflightWithAgent(input, this.zcodeAgentService);
    } catch (error) {
      throw normalizeConversationShareConnectionError(error);
    }
  }

  private async preflightWithAgent(
    input: ConversationSharePreflightInput,
    agentService: ConversationShareAgentService,
  ): Promise<ConversationSharePreflightResult> {
    const capabilities = await this.client.getCapabilities();
    const supportedArtifactTypes = allowedArtifactSummaries(capabilities);
    const conversation = await this.loadAllRows(input, agentService);
    const blockingIssues: ConversationShareFailureIssue[] = [];
    const skippableWarnings: ConversationShareFailureIssue[] = [];
    const deferredIssues: ConversationShareFailureIssue[] = [];

    let selected: { rows: ConversationRow[]; productTurnIds: string[] };
    try {
      selected = selectRows(conversation.rows, input.selection);
    } catch (error) {
      if (error instanceof ConversationShareServiceError) {
        blockingIssues.push({
          code: "invalid_selection",
          scope: "conversation",
        });
      } else {
        throw error;
      }
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues,
        skippableWarnings,
        deferredIssues,
        supportedArtifactTypes,
        turnResults: [],
      };
    }

    const structureSanitized = sanitizeUnsupportedShareStructures(selected.rows);
    const artifactSanitized = sanitizeUnsupportedShareArtifacts(
      removeIndependentArtifactRows(structureSanitized),
      capabilities,
      conversation.rows,
    );
    const selectedRows = artifactSanitized.rows;
    skippableWarnings.push(...artifactSanitized.warnings);
    blockingIssues.push(...collectShareStructureIssues(selectedRows, conversation.rows));
    let hasShareableContent = selectedRows.some((row) => {
      if (row.kind === "turnHeader" || row.kind === "timelineMarker") return false;
      if (row.kind === "assistantText" || row.kind === "reasoning")
        return row.text.trim().length > 0;
      if (row.kind === "userInput") return row.text.trim().length > 0;
      if (row.kind === "toolCall") {
        return Boolean(
          row.inputText?.trim() || row.output?.text?.trim() || row.error?.message?.trim(),
        );
      }
      return true;
    });

    const turnOrdinalByProductTurnId = turnOrdinalByProductTurn(conversation.rows);
    // First collect the attachments that require stat, then run them in bounded parallel, and finally sort them in the original order.
    // The purpose of splitting it into two rounds is to obtain the benefits of remote concurrency while making the order of issue generation consistent with serial implementation.
    const attachmentChecks: {
      row: Extract<ConversationRow, { kind: "userInput" }> & {
        entityId: string;
      };
      attachmentIndex: number;
      attachment: NonNullable<
        Extract<ConversationRow, { kind: "userInput" }>["attachments"]
      >[number];
      allowed: ReturnType<typeof allowedArtifactFor>;
      baseIssue: Omit<ConversationShareFailureIssue, "code">;
    }[] = [];
    for (const row of selectedRows) {
      if (row.kind !== "userInput" || !row.attachments) continue;
      for (const [attachmentIndex, attachment] of row.attachments.entries()) {
        const extension = fileExtension(attachment.fileName);
        const mimeType = normalizedMimeType(attachment.mime);
        const allowed = allowedArtifactFor(capabilities, extension, mimeType);
        const baseIssue = {
          scope: "artifact" as const,
          rowId: row.rowId,
          ...(row.productTurnId && turnOrdinalByProductTurnId.has(row.productTurnId)
            ? { turnOrdinal: turnOrdinalByProductTurnId.get(row.productTurnId) }
            : {}),
          ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
          artifactDisplayName: attachmentDisplayName(attachment.fileName),
          ...(extension ? { extension } : {}),
          mimeType,
          ...(allowed ? { artifactType: allowed.type } : { artifactType: extension ?? "unknown" }),
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Partial<ConversationShareFailureIssue>;
        if (!row.entityId) {
          blockingIssues.push({
            code: "input_attachment",
            scope: "artifact",
            rowId: row.rowId,
            ...(baseIssue.turnOrdinal === undefined ? {} : { turnOrdinal: baseIssue.turnOrdinal }),
            ...(baseIssue.productTurnId === undefined
              ? {}
              : { productTurnId: baseIssue.productTurnId }),
            artifactDisplayName: attachmentDisplayName(attachment.fileName),
          });
          continue;
        }
        attachmentChecks.push({
          row: { ...row, entityId: row.entityId },
          attachmentIndex,
          attachment,
          allowed,
          baseIssue,
        });
      }
    }
    const attachmentStats = await mapWithConcurrency(
      attachmentChecks,
      SHARE_PREFLIGHT_STAT_CONCURRENCY,
      (check) =>
        settle(() =>
          agentService.conversationAttachmentStatV4({
            workspacePath: input.workspacePath,
            ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            sessionId: input.sessionId,
            target: { rowId: check.row.rowId, entityId: check.row.entityId },
            attachmentIndex: check.attachmentIndex,
            ref: check.attachment.ref,
          }),
        ),
    );
    for (const [checkIndex, check] of attachmentChecks.entries()) {
      const { row, attachment, allowed, baseIssue } = check;
      const settled = attachmentStats[checkIndex]!;
      if (settled.ok) {
        const stat = settled.value;
        if (!allowed) {
          // Even if the type is not supported, the selection phase existence check must be completed first; only existing attachments are displayed.
          // artifact_type_not_allowed, to avoid falsely reporting cleaned attachments as capability issues.
          //
          // Type determination must precede volume determination: unsupported types will not be uploaded at all, and their size
          // It’s not about sharing. In turn, "Format not supported (can be skipped)" will be upgraded to "Volume exceeds limit (blocked)".
          // Users are stuck with errors that even a single compression can't fix.
          skippableWarnings.push({
            code: "artifact_type_not_allowed",
            ...baseIssue,
          });
        } else if (stat.totalBytes > capabilities.max_artifact_bytes) {
          blockingIssues.push({
            code: "artifact_size_limit",
            ...baseIssue,
            actual: stat.totalBytes,
            limit: capabilities.max_artifact_bytes,
          });
        } else if (attachment.bytes > 0 && stat.totalBytes !== attachment.bytes) {
          skippableWarnings.push({
            code: "artifact_changed",
            ...baseIssue,
            availability: "changed",
          });
        } else {
          hasShareableContent = true;
        }
      } else {
        const error = settled.error;
        if (isAttachmentAuthorizationError(error)) {
          blockingIssues.push({
            code: "artifact_protocol_not_ready",
            scope: "artifact",
            rowId: row.rowId,
            ...(baseIssue.turnOrdinal === undefined ? {} : { turnOrdinal: baseIssue.turnOrdinal }),
            ...(baseIssue.productTurnId === undefined
              ? {}
              : { productTurnId: baseIssue.productTurnId }),
            artifactDisplayName: attachmentDisplayName(attachment.fileName),
          });
        } else if (isAttachmentTooLargeError(error)) {
          // When the attachment is so large that it cannot even be expressed in stat, it is still blocked by the "known capacity exceeded".
          // Never downgrade to a deferred - that will cause the release to silently drop the attachment.
          blockingIssues.push({
            code: "artifact_size_limit",
            ...baseIssue,
            limit: capabilities.max_artifact_bytes,
          });
        } else if (isDefiniteMissingAttachment(error)) {
          skippableWarnings.push({
            code: "input_attachment_unavailable",
            ...baseIssue,
            availability: "not_found",
          });
        } else {
          hasShareableContent = true;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...baseIssue,
            availability: "unknown",
          });
        }
      }
    }

    if (!hasShareableContent) {
      blockingIssues.push({
        code: "no_shareable_content",
        scope: "conversation",
      });
    }

    if (blockingIssues.length > 0) {
      const sanitizedBlockingIssues = sanitizeConversationShareIssues(blockingIssues);
      const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
      const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues: sanitizedBlockingIssues.issues,
        skippableWarnings: sanitizedWarnings.issues,
        deferredIssues: sanitizedDeferred.issues,
        supportedArtifactTypes,
        turnResults: buildTurnPreflightResults(
          selected.productTurnIds,
          turnOrdinalByProductTurnId,
          sanitizedBlockingIssues.issues,
          sanitizedWarnings.issues,
          sanitizedDeferred.issues,
        ),
      };
    }

    const registeredProjection = buildConversationSharePublicProjection({
      rows: selectedRows,
      selectedProductTurnIds: selected.productTurnIds,
    });
    const manifestIssues = this.collectArtifactManifestIssues(
      capabilities,
      registeredProjection.artifacts,
    );
    blockingIssues.push(
      ...manifestIssues.filter((issue) => issue.code !== "artifact_type_not_allowed"),
    );
    skippableWarnings.push(
      ...manifestIssues.filter((issue) => issue.code === "artifact_type_not_allowed"),
    );

    const headersByProductTurnId = new Map<
      string,
      Extract<ConversationRow, { kind: "turnHeader" }>
    >();
    const assistantTextByProductTurnId = new Map<string, string[]>();
    for (const row of selectedRows) {
      if (row.kind === "turnHeader" && row.productTurnId) {
        headersByProductTurnId.set(row.productTurnId, row);
      }
      if (row.kind === "assistantText" && row.productTurnId) {
        const texts = assistantTextByProductTurnId.get(row.productTurnId) ?? [];
        texts.push(row.text);
        assistantTextByProductTurnId.set(row.productTurnId, texts);
      }
    }

    for (const [productTurnId, textParts] of assistantTextByProductTurnId) {
      const header = headersByProductTurnId.get(productTurnId);
      if (!header) continue;
      const assistantText = textParts.join("\n\n");
      const references = extractConversationPreviewFileReferences(
        assistantText,
        input.workspacePath,
      );
      const needsFileChanges = references.some(
        (reference) => reference.kind === "markdown" || reference.kind === "html",
      );
      let fileChanges: Array<{ path: string; state: "active" | "reverted" }> | undefined;
      if (needsFileChanges && header.fileChanges?.state !== "reverted") {
        if (!header.entityId) {
          deferredIssues.push({
            code: "artifact_read_failed",
            scope: "artifact",
            rowId: header.rowId,
            turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
            productTurnId,
            availability: "unknown",
          });
          continue;
        }
        const result = await agentService.conversationFileChangesV4({
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          sessionId: input.sessionId,
          target: { rowId: header.rowId, entityId: header.entityId },
          baseRevision: conversation.revision,
          baseLogEpoch: conversation.logEpoch,
        });
        fileChanges = result.items.map((item) => ({
          path: item.path,
          state: result.state === "reverted" ? ("reverted" as const) : ("active" as const),
        }));
      }

      const candidates = buildConversationPreviewArtifactCandidates({
        assistantText,
        productTurnId,
        workspacePath: input.workspacePath,
        fileChanges,
      });
      const visibleCandidates: ConversationPreviewArtifactCandidate[] = [];
      const previewCanonicalPaths = new Set<string>();
      let previewStatSettled = this.artifactSource.stat !== undefined;
      // stat is initiated concurrently, and the judgment is still performed in the original order of candidates: deduplication and the upper limit of visible cards both depend on the order.
      // Each stat is a round trip in the remote workspace.
      const artifactSourceStat = this.artifactSource.stat;
      const candidateStats = artifactSourceStat
        ? await mapWithConcurrency(candidates, SHARE_PREFLIGHT_STAT_CONCURRENCY, (candidate) =>
            settle(() =>
              artifactSourceStat({
                workspacePath: input.workspacePath,
                ref: candidate.sourceRef,
              }),
            ),
          )
        : [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const issue = {
          scope: "artifact" as const,
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: fileExtension(candidate.displayName),
          mimeType: candidate.mimeType,
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Omit<ConversationShareFailureIssue, "code">;

        // First check all paths within the candidate limit, and then get the same visible card limit for the UI from the existing paths.
        // In this way, the existence check of subsequent candidates will not be missed just because the first few files exist.
        const settled = candidateStats[candidateIndex];
        if (!settled) {
          previewStatSettled = false;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...issue,
            availability: "unknown",
          });
          continue;
        }
        if (settled.ok) {
          if (previewCanonicalPaths.has(settled.value.canonicalPath)) continue;
          previewCanonicalPaths.add(settled.value.canonicalPath);
        } else {
          if (isMissingArtifactReadError(settled.error)) {
            // When the Assistant preview file no longer exists, the UI will not display this card, so no Share warning will be generated.
            continue;
          }
          previewStatSettled = false;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...issue,
            availability: "unknown",
          });
          continue;
        }
        if (visibleCandidates.length < CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT) {
          visibleCandidates.push(candidate);
        }
      }

      for (const candidate of visibleCandidates) {
        const issue = {
          scope: "artifact" as const,
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: fileExtension(candidate.displayName),
          mimeType: candidate.mimeType,
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Omit<ConversationShareFailureIssue, "code">;
        const allowed =
          candidate.previewKind === "video" || candidate.previewKind === "audio"
            ? undefined
            : allowedArtifactFor(
                capabilities,
                fileExtension(candidate.displayName),
                candidate.mimeType,
              );
        if (!allowed) {
          skippableWarnings.push({ code: "artifact_type_not_allowed", ...issue });
        }
      }
      const snapshotKey = previewPreflightKey(input, productTurnId);
      if (previewStatSettled) {
        this.setPreviewPreflightSnapshot(snapshotKey, {
          revision: conversation.revision,
          logEpoch: conversation.logEpoch,
          capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
          candidateFingerprint: getConversationSharePreviewCandidateFingerprint(candidates),
          visibleSourceRefs: visibleCandidates.map((candidate) => candidate.sourceRef),
        });
      } else {
        this.previewPreflightSnapshots.delete(snapshotKey);
      }
    }

    const sanitizedBlockingIssues = sanitizeConversationShareIssues(blockingIssues);
    const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
    const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
    return {
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
      blockingIssues: sanitizedBlockingIssues.issues,
      skippableWarnings: sanitizedWarnings.issues,
      deferredIssues: sanitizedDeferred.issues,
      supportedArtifactTypes,
      turnResults: buildTurnPreflightResults(
        selected.productTurnIds,
        turnOrdinalByProductTurnId,
        sanitizedBlockingIssues.issues,
        sanitizedWarnings.issues,
        sanitizedDeferred.issues,
      ),
    };
  }

  getPreview(shareCode: string) {
    return this.client.getPreview(shareCode);
  }

  getContinuation(input: { shareCode: string; clientRequestId: string }) {
    return this.client.getContinuation(input.shareCode, {
      schema_version: 1,
      client_request_id: input.clientRequestId,
    });
  }

  /** Internal Host attachment facade: reuses the same business service, only replacing the trusted Agent scope of the V4 Rows/File queries. */
  [conversationShareConnectionScopeFactory](
    agentService: ConversationShareAgentService,
  ): IConversationShareService {
    return {
      getCapabilities: () => this.getCapabilities(),
      preflight: async (input) => {
        try {
          return await this.preflightWithAgent(input, agentService);
        } catch (error) {
          throw normalizeConversationShareConnectionError(error);
        }
      },
      publish: (input, operationId) => this.publishWithAgent(input, operationId, agentService),
      onDynamicPublishProgress: (operationId) => this.onDynamicPublishProgress(operationId),
      importShare: (input, operationId) => this.importShare(input, operationId),
      onDynamicImportProgress: (operationId) => this.onDynamicImportProgress(operationId),
      getImportedConversation: (input) => this.getImportedConversation(input),
      getPreview: (shareCode) => this.getPreview(shareCode),
      getContinuation: (input) => this.getContinuation(input),
    };
  }

  onDynamicPublishProgress(operationId: string) {
    return this.getProgressEmitter(operationId).event;
  }

  onDynamicImportProgress(operationId: string) {
    return this.getImportProgressEmitter(operationId).event;
  }

  /**
   * Downloads the bytes of a single artifact: a per-request timeout (including reading the
   * body) plus a Content-Length pre-check.
   *
   * The download fallback must not be a bare fetch (no AbortSignal), and the size/SHA-256
   * checks cannot run only after arrayBuffer() — a hung connection would leave the import
   * stuck in the downloading phase forever (undici falls back at ~300s, which feels like a
   * freeze), and tampered storage could make the client read an oversized payload fully into
   * memory before discovering the mismatch. A timeout is treated as a network failure; when the
   * declared Content-Length exceeds the manifest's size_bytes, integrity is declared failed
   * and the connection aborted before the body is read — integrity checks placed after an
   * unbounded download guarantee correctness but do not protect client resources.
   */
  private async downloadArtifactBytes(
    artifact: ConversationShareContinuation["artifacts"][number],
  ): Promise<{ bytes: Uint8Array; responseMimeType?: string }> {
    const artifactIssue = (
      code: ConversationShareFailureIssue["code"],
      extra?: { actual?: number; limit?: number },
    ): ConversationShareFailureIssue => ({
      code,
      scope: "artifact",
      artifactDisplayName: artifact.display_name,
      artifactType: artifact.artifact_type,
      extension: artifact.extension,
      mimeType: artifact.mime_type,
      phase: "downloading",
      ...(extra?.actual === undefined ? {} : { actual: extra.actual }),
      ...(extra?.limit === undefined ? {} : { limit: extra.limit }),
    });
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    try {
      const response = await this.download(artifact.download_url, { signal: controller.signal });
      if (!response.ok) {
        throw new ConversationShareServiceError(
          "network",
          "Conversation artifact download failed",
          { issues: [artifactIssue("unknown")] },
        );
      }
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > artifact.size_bytes) {
        // The body has been determined not to pass the verification: interrupt the connection first and then throw an error, and do not read the oversized response into the memory.
        controller.abort();
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact integrity check failed",
          {
            issues: [
              artifactIssue("artifact_changed", {
                actual: declaredBytes,
                limit: artifact.size_bytes,
              }),
            ],
          },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const responseMimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      return { bytes, responseMimeType };
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ConversationShareServiceError)) {
        throw new ConversationShareServiceError(
          "network",
          "Conversation artifact download timed out",
          {
            issues: [artifactIssue("unknown")],
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(abortTimer);
    }
  }

  async importShare(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    await this.completedImportsLoaded;
    const workspaceKey = workspaceKeyOf(input.targetWorkspacePath, input.targetWorkspaceIdentity);
    const workspaceKeyedShare = importDedupeKey(input.shareCode, workspaceKey);
    const key = `${workspaceKeyedShare}\u0000${input.clientRequestId}`;
    const completed =
      this.completedImports.get(key) ?? this.completedImportsByWorkspace.get(workspaceKeyedShare);
    if (completed) {
      this.logger.info(undefined, "conversation share import reused", {
        operationId,
        phase: "complete",
      });
      return { ...completed, reused: true };
    }
    const inFlight =
      this.inFlightImports.get(key) ?? this.inFlightImportsByWorkspace.get(workspaceKeyedShare);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.importShareInternal(input, operationId)
      .then((result) => {
        this.completedImports.set(key, result);
        this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
        return this.persistCompletedImportIndex()
          .catch(() => undefined)
          .then(() => result);
      })
      .finally(() => {
        this.inFlightImports.delete(key);
      });
    this.inFlightImports.set(key, promise);
    this.inFlightImportsByWorkspace.set(workspaceKeyedShare, promise);
    void promise.then(
      () => {
        if (this.inFlightImportsByWorkspace.get(workspaceKeyedShare) === promise) {
          this.inFlightImportsByWorkspace.delete(workspaceKeyedShare);
        }
      },
      () => {
        if (this.inFlightImportsByWorkspace.get(workspaceKeyedShare) === promise) {
          this.inFlightImportsByWorkspace.delete(workspaceKeyedShare);
        }
      },
    );
    return promise;
  }

  private async importShareInternal(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    if (!this.zcodeSessionService) {
      throwServiceError("feature_disabled", "Conversation share import is unavailable");
    }
    // Both digests have been reviewed in ConversationShareHttpClient.getContinuation against the value sent as-is from the server.
    // You cannot recalculate the parsed product here: zod strips off unknown fields by default, so adding an optional field on the publishing side will make
    // All old clients calculated different hashes and misreported purely additive evolutions as "shared file verification failed".
    const continuation = await this.getContinuation(input);

    const remoteTarget =
      input.targetWorkspaceKind === "remote" || Boolean(input.targetWorkspaceIdentity);
    const workspacePath =
      input.targetWorkspacePath && !remoteTarget
        ? input.targetWorkspacePath
        : this.conversationWorkspaceRoot;
    const workspaceIdentity =
      input.targetWorkspaceIdentity && !remoteTarget ? input.targetWorkspaceIdentity : undefined;
    const shareRoot = join(workspacePath, ".zcode-share");
    const importRoot = join(shareRoot, sanitizeFileSegment(continuation.share.share_id));
    const markerPath = join(importRoot, ".zcode-share-import.json");
    const stagingPath = join(importRoot, ".share-import-staging");
    const finalArtifactsPath = join(importRoot, "shared-artifacts");
    const conversationPath = join(importRoot, "shared-conversation.json");
    const importId = randomUUID();
    const contextId = `shared-context-${randomUUID()}`;
    const sessionId = `share-import-${randomUUID()}`;
    // This URL will take a persistent provenance and sharedContextImport snapshot, and
    // sharedContextImportV2StateSchema only accepts the canonical /cn/share/<code>; durable records should not be
    // Store values that change with the interface language (if the user switches languages later, the wrong value will be saved). Localization is only done at presentation time.
    const shareUrl = `${this.shareWebUrl}/${encodeURIComponent(input.shareCode)}`;
    await mkdir(shareRoot, { recursive: true });
    try {
      const existingMarker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (
        existingMarker.shareCode === input.shareCode &&
        typeof existingMarker.sessionId === "string" &&
        existingMarker.sessionId.startsWith("share-import-")
      ) {
        const sessions = await this.zcodeSessionService.listSessions({ workspacePath, limit: 100 });
        const existingSession = sessions.find(
          (item) => item.sessionId === existingMarker.sessionId,
        );
        if (
          existingSession &&
          typeof existingMarker.contextId === "string" &&
          typeof existingMarker.shareUrl === "string"
        ) {
          return {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            sessionId: existingSession.sessionId,
            contextId: existingMarker.contextId,
            shareUrl: existingMarker.shareUrl,
            title: existingSession.title,
            reused: true,
          };
        }
        await rm(importRoot, { recursive: true, force: true });
      }
    } catch {
      // Continue creation when there is no marker or the marker is incomplete; directories other than this share will not be deleted.
    }
    // The semantics is "whether importRoot is still allowed to be deleted when it fails", not "I created it": once the session is submitted
    // It must be disarmed (see below after createSession).
    let importRootCleanupArmed = false;
    try {
      await mkdir(importRoot);
      importRootCleanupArmed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throwServiceError("unknown", "Conversation share import is already in progress");
      }
      throw error;
    }
    try {
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "preparing",
          createdAt: this.now(),
        }),
        "utf8",
      );
    } catch (error) {
      await rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await mkdir(stagingPath);
      const installedArtifacts: Array<{
        artifactId: string;
        workspaceRelativePath: string;
        displayName: string;
        mimeType: string;
        sha256: string;
      }> = [];
      const usedNames = new Set<string>();
      let completedArtifacts = 0;
      this.reportImportProgress(operationId, "downloading", 0, continuation.artifacts.length);
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "downloading",
          createdAt: this.now(),
        }),
        "utf8",
      );
      for (const artifact of continuation.artifacts) {
        const { bytes, responseMimeType } = await this.downloadArtifactBytes(artifact);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== artifact.size_bytes || sha256 !== artifact.sha256) {
          throw new ConversationShareServiceError(
            "invalid_contract",
            "Conversation artifact integrity check failed",
            {
              issues: [
                {
                  code: "artifact_changed",
                  scope: "artifact",
                  artifactDisplayName: artifact.display_name,
                  artifactType: artifact.artifact_type,
                  extension: artifact.extension,
                  mimeType: artifact.mime_type,
                  actual: bytes.byteLength,
                  limit: artifact.size_bytes,
                  phase: "downloading",
                },
              ],
            },
          );
        }
        // If the content-type is inconsistent, invalid_contract cannot be directly determined, otherwise the .md import will fail——
        // Object storage/CDN labels downloads according to their own rules (.md is often labeled text/plain or
        // application/octet-stream), regardless of the mime_type when published.
        //
        // The bytes up to this line have passed size + SHA-256 verification, and the manifest itself is covered by artifact_set_sha256,
        // So artifact.mime_type is the authoritative value, and the response header does not provide any additional integrity guarantee——
        // Using it as an access control will only cause false rejections. This is downgraded to recording and no longer blocked.
        if (
          responseMimeType &&
          responseMimeType.toLowerCase() !== artifact.mime_type.toLowerCase()
        ) {
          this.logger.info(undefined, "conversation share artifact content-type differs", {
            artifactType: artifact.artifact_type,
            extension: artifact.extension,
            expectedMimeType: artifact.mime_type,
            responseMimeType,
          });
        }
        const fileName = uniqueImportedFileName(
          artifact.display_name,
          artifact.artifact_id,
          usedNames,
        );
        await writeFile(join(stagingPath, fileName), bytes);
        installedArtifacts.push({
          artifactId: artifact.artifact_id,
          workspaceRelativePath: `.zcode-share/${sanitizeFileSegment(continuation.share.share_id)}/shared-artifacts/${fileName}`,
          displayName: artifact.display_name,
          mimeType: artifact.mime_type,
          sha256: artifact.sha256,
        });
        completedArtifacts += 1;
        this.reportImportProgress(
          operationId,
          "downloading",
          completedArtifacts,
          continuation.artifacts.length,
        );
      }
      this.reportImportProgress(
        operationId,
        "installing",
        completedArtifacts,
        continuation.artifacts.length,
      );
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "installing",
          createdAt: this.now(),
        }),
        "utf8",
      );
      await rename(stagingPath, finalArtifactsPath);
      // Read-only blocks must be able to be opened permanently offline: the share may have expired or not yet been online, and the source cannot be returned during rendering.
      // Therefore, the public rows and the result object metadata are placed in the importRoot and deleted together with the failure cleanup.
      //
      // Write rawRows instead of parsing the product: rows and fields that are not recognized by the local end are still saved, and users can see them after upgrading.
      // It will not be permanently erased because the version on the day of import is older.
      await writeFile(
        conversationPath,
        JSON.stringify({
          formatVersion: IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION,
          shareId: continuation.share.share_id,
          contextId,
          title: continuation.share.title,
          rows: continuation.rawRows,
          artifacts: continuation.artifacts.map((artifact) => ({
            artifactId: artifact.artifact_id,
            displayName: artifact.display_name,
            mimeType: artifact.mime_type,
            workspaceRelativePath: installedArtifacts.find(
              (installed) => installed.artifactId === artifact.artifact_id,
            )?.workspaceRelativePath,
          })),
        }),
        "utf8",
      );
      const context = formatSharedContextV1({
        share: { shareId: continuation.share.share_id, title: continuation.share.title },
        rows: continuation.rows,
        installedArtifacts,
      });
      if (context.unsupportedKinds.length > 0) {
        // Shared_context on the model side is missing content: import is not blocked, but traces must be left.
        this.logger.info(undefined, "shared context skipped row kinds this build cannot format", {
          kinds: context.unsupportedKinds,
        });
      }
      this.reportImportProgress(
        operationId,
        "committing",
        completedArtifacts,
        continuation.artifacts.length,
      );
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "committing",
          createdAt: this.now(),
        }),
        "utf8",
      );
      const snapshot = await this.zcodeSessionService.createSession({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessionId,
        persistence: "immediate",
        importedHistory: {
          source: "sharedContext",
          // Prefix the session title to make the imported session easily identifiable in the task list.
          // Note that sharedContextImport.title is not read anywhere on the UI side (read only contextId/status/shareUrl),
          // So the prefix doesn't pollute the display; the CLI already writes session.title directly with importedHistory.title.
          title: formatImportedShareSessionTitle(continuation.share.title, input.locale),
          markdown: context.markdown,
          provenance: {
            shareId: continuation.share.share_id,
            contextId,
            shareUrl,
            status: "pending",
            projectionSha256: continuation.integrity.projection_sha256,
            artifactSetSha256: continuation.integrity.artifact_set_sha256,
            formatterVersion: 1,
            markdownSha256: context.markdownSha256,
            installedArtifacts: installedArtifacts.map((artifact) => ({
              artifactId: artifact.artifactId,
              workspaceRelativePath: artifact.workspaceRelativePath,
            })),
          },
        },
      });
      // The session has been submitted and its provenance refers to the one installed in importRoot
      // artifacts. Once an error is thrown during marker cleaning or progress reporting, the old catch will be rm -rf importRoot.
      // The user then gets a session that references the missing file. The failure radius must end before createSession,
      // Therefore, we should immediately disarm the cleanup here; markers are pure trace files, and the import should not fail if they cannot be deleted.
      importRootCleanupArmed = false;
      await rm(markerPath, { force: true }).catch(() => undefined);
      this.reportImportProgress(
        operationId,
        "complete",
        completedArtifacts,
        continuation.artifacts.length,
      );
      return {
        workspacePath,
        workspaceIdentity,
        sessionId: snapshot.session.sessionId,
        contextId,
        shareUrl,
        title: continuation.share.title,
        reused: false,
        ...(remoteTarget
          ? { fallbackReason: "remote_workspace" as const }
          : input.targetWorkspacePath
            ? {}
            : { fallbackReason: "default_workspace" as const }),
      };
    } catch (error) {
      // After the import is changed to fall into the existing workspace, deleting the workspace root directory will damage the user project;
      // Failed cleanup can only touch this import-owned subdirectory.
      if (importRootCleanupArmed) {
        await rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Looks up the public rows written to disk on import by contextId.
   *
   * Directory names use share_id rather than contextId (the two are not equivalent), so it
   * scans every importRoot under .zcode-share/ and compares the contextId inside each file —
   * no extra index is maintained, and historical imports are still readable.
   * The content comes from disk and therefore crosses a storage boundary, so it must pass
   * the schema before reaching the rendering layer.
   */
  async getImportedConversation(input: {
    workspacePath: string;
    contextId: string;
  }): Promise<ImportedConversationShare | null> {
    const shareRoot = join(input.workspacePath, ".zcode-share");
    let entries: Dirent[];
    try {
      entries = await readdir(shareRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await readFile(join(shareRoot, entry.name, "shared-conversation.json"), "utf8"),
        );
      } catch {
        continue;
      }
      const validated = importedConversationShareFileSchema.safeParse(parsed);
      if (!validated.success || validated.data.contextId !== input.contextId) continue;
      const decoded = decodeConversationShareRows(validated.data.rows);
      // When the formatVersion is newer than the current version (the user reverts to the old version after importing the new version), unrecognizable lines will still be included.
      // unsupportedRowCount, let the UI issue a soft prompt - the content cannot be silently deleted.
      const unsupportedRowCount =
        decoded.unsupportedCount +
        (validated.data.formatVersion > IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION ? 1 : 0);
      if (unsupportedRowCount > 0) {
        this.logger.info(
          undefined,
          "imported conversation share has content this build can't read",
          {
            formatVersion: validated.data.formatVersion,
            kinds: decoded.unsupportedKinds,
            droppedCount: decoded.unsupportedCount,
            keptCount: decoded.rows.length,
          },
        );
      }
      return {
        shareId: validated.data.shareId,
        contextId: validated.data.contextId,
        title: validated.data.title,
        rows: decoded.rows,
        artifacts: validated.data.artifacts,
        unsupportedRowCount,
      };
    }
    return null;
  }

  private async loadCompletedImportIndex(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.importIndexPath, "utf8"));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object") return;
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Partial<ImportConversationShareResult>;
      if (
        typeof record.workspacePath !== "string" ||
        typeof record.sessionId !== "string" ||
        typeof record.title !== "string" ||
        typeof record.contextId !== "string" ||
        typeof record.shareUrl !== "string"
      ) {
        continue;
      }
      try {
        if (!(await stat(record.workspacePath)).isDirectory()) continue;
      } catch {
        continue;
      }
      const keyParts = key.split("\u0000");
      const shareCode = keyParts[0]!;
      const workspaceKey =
        keyParts[1] ?? workspaceKeyOf(record.workspacePath, record.workspaceIdentity);
      const workspaceKeyedShare = importDedupeKey(shareCode, workspaceKey);
      const result: ImportConversationShareResult = {
        workspacePath: record.workspacePath,
        ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
        sessionId: record.sessionId,
        contextId: record.contextId,
        shareUrl: record.shareUrl,
        title: record.title,
        reused: true,
      };
      this.completedImports.set(key, result);
      this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
    }
  }

  private async writeCompletedImportIndexOnce(): Promise<void> {
    const data = Object.fromEntries(this.completedImports.entries());
    const temporaryPath = `${this.importIndexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(data), "utf8");
      await rename(temporaryPath, this.importIndexPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private persistCompletedImportIndex(): Promise<void> {
    // The chain originally did not catch, and after the first write failed, importIndexWriteChain was permanently rejected.
    // After that, every persist becomes a silent no-op (the call point is also swallowed by .catch(() => undefined)).
    // Once the index is lost, there is no recovery source (the marker has been deleted when successful), and importing the same share again will hit mkdir EEXIST.
    // And it will always report "already in progress". Correction: The stored chain is always resolved and is only used for serialization;
    // The return value remains observable, allowing the caller to decide whether to swallow this failure.
    const run = this.importIndexWriteChain
      .catch(() => undefined)
      .then(() => this.writeCompletedImportIndexOnce());
    this.importIndexWriteChain = run.catch(() => undefined);
    return run;
  }

  async publish(input: PublishTextConversationInput, operationId: string) {
    return this.publishWithAgent(input, operationId, this.zcodeAgentService);
  }

  private async publishWithAgent(
    input: PublishTextConversationInput,
    operationId: string,
    agentService: ConversationShareAgentService,
  ) {
    this.logger.info(undefined, "conversation share publish started", {
      operationId,
      accessMode: input.accessMode,
      selectionKind: input.selection.kind,
      remoteWorkspace: Boolean(input.workspaceIdentity || input.remoteSessionId),
    });
    try {
      const result = await this.publishInternal(input, operationId, agentService);
      this.logger.info(undefined, "conversation share publish completed", {
        operationId,
        phase: "complete",
      });
      // Once the release is successful, this sharing ends. The preflight snapshot of this session no longer has consumers: it will be recycled immediately.
      // Otherwise, a long-lived desktop host will accumulate workspace+session+turn entries indefinitely.
      this.clearPreviewPreflightSnapshots(input);
      return result;
    } catch (rawError) {
      const error = normalizeConversationShareConnectionError(rawError);
      const record =
        error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
      this.logger.warn(undefined, "conversation share publish failed", {
        operationId,
        phase: this.publishPhases.get(operationId) ?? "collecting",
        kind: typeof record?.kind === "string" ? record.kind : "unknown",
        ...(typeof record?.reasonCode === "string" ? { reasonCode: record.reasonCode } : {}),
        ...(record?.diagnostics && typeof record.diagnostics === "object"
          ? { diagnostics: record.diagnostics }
          : {}),
        ...(typeof record?.status === "number" ? { status: record.status } : {}),
        ...(typeof record?.code === "number" ? { code: record.code } : {}),
        ...(typeof record?.requestId === "string" ? { requestId: record.requestId } : {}),
        errorName:
          typeof record?.name === "string"
            ? record.name
            : error instanceof Error
              ? error.name
              : "UnknownError",
      });
      throw error;
    } finally {
      this.publishPhases.delete(operationId);
    }
  }

  private async publishInternal(
    input: PublishTextConversationInput,
    operationId?: string,
    agentService: ConversationShareAgentService = this.zcodeAgentService,
  ): Promise<ConversationShareRecord> {
    const report = (
      phase: ConversationSharePublishProgress["phase"],
      completedArtifacts = 0,
      totalArtifacts = 0,
      warnings?: {
        issues: readonly ConversationShareFailureIssue[];
        issueCount: number;
        omittedIssueCount: number;
      },
    ) => {
      if (!operationId) return;
      this.publishPhases.set(operationId, phase);
      this.logger.info(undefined, "conversation share publish phase changed", {
        operationId,
        phase,
        completedArtifacts,
        totalArtifacts,
        ...(warnings ? { warningCount: warnings.issueCount } : {}),
      });
      this.getProgressEmitter(operationId).fire({
        operationId,
        phase,
        completedArtifacts,
        totalArtifacts,
        ...(warnings
          ? { warnings: warnings.issues, omittedWarningCount: warnings.omittedIssueCount }
          : {}),
      });
    };
    report("collecting");
    if (!input.title.trim() || !input.clientRequestId.trim()) {
      throwServiceError("invalid_contract", "Share title and request identity are required");
    }
    if (!Number.isSafeInteger(input.disclosureAcceptedAt) || input.disclosureAcceptedAt <= 0) {
      throwServiceError("disclosure_required", "Explicit disclosure confirmation is required");
    }
    if (input.selection.kind === "rowAnchors" && input.selection.rowIds.length === 0) {
      throwServiceError("invalid_selection", "At least one conversation row must be selected");
    }

    const capabilities = await this.client.getCapabilities();
    if (!capabilities.access_modes.includes(input.accessMode)) {
      throwServiceError("feature_disabled", "Requested share access mode is unavailable");
    }

    const conversation = await this.loadAllRows(input, agentService);
    const selected = selectRows(conversation.rows, input.selection);
    // Finalized structures that cannot be publicly hosted are downgraded first: delete fields or lose entire lines, and replace them with non-blocking prompts.
    // All subsequent projections and product discoveries are based on these sanitized rows.
    const structureSanitized = sanitizeUnsupportedShareStructures(selected.rows);
    const artifactSanitized = sanitizeUnsupportedShareArtifacts(
      removeIndependentArtifactRows(structureSanitized),
      capabilities,
      conversation.rows,
    );
    const selectedRows = artifactSanitized.rows;
    const publishWarnings: ConversationShareFailureIssue[] = [...artifactSanitized.warnings];
    // Public projection cannot exit directly when encountering the first unsupported structure. Users must know which rounds need to be canceled;
    // First complete the structural pre-inspection of the entire selected content, return to the desensitized issues and let the UI give actionable suggestions one by one.
    const structureIssues = collectShareStructureIssues(selectedRows, conversation.rows);
    if (structureIssues.length > 0) {
      const structureKind = structureIssues.some(
        (issue) => issue.code === "artifact_protocol_not_ready",
      )
        ? "artifact_protocol_not_ready"
        : structureIssues.some((issue) => issue.code === "unsafe_url")
          ? "unsafe_structure"
          : "invalid_conversation";
      throw new ConversationShareServiceError(
        structureKind,
        "Selected conversation contains unsupported structure",
        { issues: structureIssues },
      );
    }
    // The local running projection contains subagent details and write state ID, and the backend V1 will reject with 3205;
    // An independent public projection must be generated before confirm, and the selected local rows cannot be sent directly.
    const registeredProjection = buildConversationSharePublicProjection({
      rows: selectedRows,
      selectedProductTurnIds: selected.productTurnIds,
    });
    this.validateArtifactManifest(capabilities, registeredProjection.artifacts);
    const preflightPreviewSnapshots = new Map<string, ConversationSharePreviewPreflightSnapshot>();
    for (const productTurnId of selected.productTurnIds) {
      const snapshot = this.previewPreflightSnapshots.get(
        previewPreflightKey(input, productTurnId),
      );
      if (snapshot) preflightPreviewSnapshots.set(productTurnId, snapshot);
    }
    const artifactSnapshot = await buildConversationShareArtifactSnapshot({
      zcodeAgentService: agentService,
      artifactSource: this.artifactSource,
      input,
      selectedRows,
      registeredArtifacts: registeredProjection.artifacts,
      capabilities,
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      turnOrdinalByProductTurnId: turnOrdinalByProductTurn(conversation.rows),
      preflightPreviewSnapshots,
      currentCapabilitiesFingerprint: capabilitiesFingerprint(capabilities),
    });
    if (artifactSnapshot.issues.length > 0) {
      throw new ConversationShareServiceError(
        "artifact_not_allowed",
        "Conversation result artifacts are not allowed by server capabilities",
        { issues: artifactSnapshot.issues },
      );
    }
    if (artifactSnapshot.warnings.length > 0) {
      publishWarnings.push(...artifactSnapshot.warnings);
    }
    if (publishWarnings.length > 0) {
      // Non-blocking: When the file referenced in the text or the user input attachment cannot be materialized, publishing will continue as usual, but the sharer must
      // Know which real files are not in the link; internal marker/inline images have been silently removed from the front.
      report("collecting", 0, 0, sanitizeConversationShareIssues(publishWarnings));
    }
    const publicProjection = buildConversationSharePublicProjection({
      rows: artifactSnapshot.rows,
      selectedProductTurnIds: selected.productTurnIds,
      additionalArtifacts: artifactSnapshot.additionalArtifacts,
    });
    this.validateArtifactManifest(capabilities, publicProjection.artifacts);
    if (publicProjection.rows.length > capabilities.max_rows) {
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation contains too many rows to share",
        {
          issues: [
            {
              code: "rows_limit",
              scope: "conversation",
              actual: publicProjection.rows.length,
              limit: capabilities.max_rows,
            },
          ],
        },
      );
    }

    const confirmRequest = buildConversationShareConfirmRequest({
      selected_product_turn_ids: publicProjection.selectedProductTurnIds,
      projection: { rows: publicProjection.rows },
      artifacts: publicProjection.artifacts.map((artifact) => artifact.descriptor),
      disclosure_confirmation: {
        version: 1,
        accepted_at: input.disclosureAcceptedAt,
        acknowledged_no_secret_detection: true,
      },
    });
    if (
      Buffer.byteLength(JSON.stringify(confirmRequest), "utf8") > capabilities.max_payload_bytes
    ) {
      const actualBytes = Buffer.byteLength(JSON.stringify(confirmRequest), "utf8");
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation share payload is too large",
        {
          issues: [
            {
              code: "payload_size_limit",
              scope: "conversation",
              actual: actualBytes,
              limit: capabilities.max_payload_bytes,
            },
          ],
        },
      );
    }

    const payloadSha256 = sha256ConversationShareJson(confirmRequest);
    const preparation = await this.client.createPreparation({
      client_request_id: input.clientRequestId,
      title: input.title.trim(),
      schema_version: 1,
      access_mode: input.accessMode,
      payload_sha256: payloadSha256,
      artifact_count: publicProjection.artifacts.length,
    });
    if (preparation.status === "confirmed") {
      report("complete", publicProjection.artifacts.length, publicProjection.artifacts.length);
      return localizePublishedShare(preparation.share, input.locale);
    }
    report("uploading", 0, publicProjection.artifacts.length);
    let uploadedArtifacts = 0;
    for (const artifact of publicProjection.artifacts) {
      const bytes = artifactSnapshot.bytesBySourceRef.get(artifact.sourceRef);
      if (!bytes) {
        throwServiceError(
          "invalid_conversation",
          "Conversation artifact bytes are missing from the publication snapshot",
        );
      }
      const upload = await this.client.uploadArtifact(
        preparation.preparation_id,
        artifact.descriptor,
        new Blob([Uint8Array.from(bytes).buffer], {
          type: artifact.descriptor.mime_type,
        }),
      );
      if (
        upload.artifact_id !== artifact.descriptor.artifact_id ||
        upload.size_bytes !== artifact.descriptor.size_bytes ||
        upload.sha256 !== artifact.descriptor.sha256
      ) {
        throw new ConversationShareServiceError(
          "upload_incomplete",
          "Conversation artifact upload acknowledgement does not match the manifest",
          {
            issues: [
              {
                code: "upload_incomplete",
                scope: "artifact",
                artifactDisplayName: artifact.descriptor.display_name,
                artifactType: artifact.descriptor.artifact_type,
                extension: artifact.descriptor.extension,
                mimeType: artifact.descriptor.mime_type,
                actual: upload.size_bytes,
                limit: artifact.descriptor.size_bytes,
              },
            ],
          },
        );
      }
      uploadedArtifacts += 1;
      report("uploading", uploadedArtifacts, publicProjection.artifacts.length);
    }
    report("checking", uploadedArtifacts, publicProjection.artifacts.length);
    const share = await this.confirmUntilReady(preparation.preparation_id, confirmRequest);
    report("complete", uploadedArtifacts, publicProjection.artifacts.length);
    // The server currently does not accept the locale and can only rewrite the delivered links to the site corresponding to the interface language;
    // localizeConversationShareUrl only recognizes known share path shapes, leaving other shapes as is.
    return localizePublishedShare(share, input.locale);
  }

  private getProgressEmitter(operationId: string): Emitter<ConversationSharePublishProgress> {
    const existing = this.progressEmitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<ConversationSharePublishProgress>({
      onDidRemoveLastListener: () => {
        this.progressEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.progressEmitters.set(operationId, emitter);
    return emitter;
  }

  private getImportProgressEmitter(operationId: string): Emitter<ConversationShareImportProgress> {
    const existing = this.importProgressEmitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<ConversationShareImportProgress>({
      onDidRemoveLastListener: () => {
        this.importProgressEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.importProgressEmitters.set(operationId, emitter);
    return emitter;
  }

  private reportImportProgress(
    operationId: string,
    phase: ConversationShareImportProgress["phase"],
    completedArtifacts: number,
    totalArtifacts: number,
  ) {
    this.getImportProgressEmitter(operationId).fire({
      operationId,
      phase,
      completedArtifacts,
      totalArtifacts,
    });
  }

  private async cleanupAbandonedImports(): Promise<void> {
    if (!this.zcodeSessionService) return;
    await this.completedImportsLoaded;
    // Only scan import-owned subdirectories of the default conversation workspace; markers of other workspaces
    // Handled in the next import request with target to avoid boot-time enumeration and touching the user project directory.
    const shareRoot = join(this.conversationWorkspaceRoot, ".zcode-share");
    const imports = await readdir(shareRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of imports) {
      if (!entry.isDirectory()) continue;
      const importRoot = join(shareRoot, entry.name);
      const markerPath = join(importRoot, ".zcode-share-import.json");
      let marker: {
        sessionId?: unknown;
        shareCode?: unknown;
        clientRequestId?: unknown;
        workspaceKey?: unknown;
        contextId?: unknown;
        shareUrl?: unknown;
      };
      try {
        marker = JSON.parse(await readFile(markerPath, "utf8")) as typeof marker;
      } catch {
        continue;
      }
      if (typeof marker.sessionId !== "string" || !marker.sessionId.startsWith("share-import-"))
        continue;
      try {
        const sessions = await this.zcodeSessionService.listSessions({
          workspacePath: this.conversationWorkspaceRoot,
          limit: 100,
        });
        const session = sessions.find((item) => item.sessionId === marker.sessionId);
        if (session) {
          if (
            typeof marker.shareCode === "string" &&
            typeof marker.clientRequestId === "string" &&
            typeof marker.contextId === "string" &&
            typeof marker.shareUrl === "string"
          ) {
            const workspaceKeyedShare = importDedupeKey(
              marker.shareCode,
              typeof marker.workspaceKey === "string"
                ? marker.workspaceKey
                : this.conversationWorkspaceRoot,
            );
            const result: ImportConversationShareResult = {
              workspacePath: this.conversationWorkspaceRoot,
              sessionId: session.sessionId,
              contextId: marker.contextId,
              shareUrl: marker.shareUrl,
              title: session.title,
              reused: true,
            };
            this.completedImports.set(
              `${workspaceKeyedShare}\u0000${marker.clientRequestId}`,
              result,
            );
            this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
            await this.persistCompletedImportIndex().catch(() => undefined);
          }
          await rm(markerPath, { force: true });
        } else {
          // Only delete this importRoot with legal markers and no matching session.
          await rm(importRoot, { recursive: true, force: true });
        }
      } catch {
        // ImportRoot is retained when the session status cannot be proven, and temporary errors are prohibited from being upgraded to data deletion.
      }
    }
  }

  private collectArtifactManifestIssues(
    capabilities: ConversationShareCapabilities,
    artifacts: Array<{
      sourceRef: string;
      descriptor: ConversationShareArtifactDescriptor;
    }>,
  ): ConversationShareFailureIssue[] {
    const artifactIds = new Set<string>();
    const issues: ConversationShareFailureIssue[] = [];
    if (artifacts.length > capabilities.max_artifact_count) {
      issues.push({
        code: "artifact_count_limit",
        scope: "conversation",
        actual: artifacts.length,
        limit: capabilities.max_artifact_count,
      });
    }
    let declaredTotalBytes = 0;
    for (const { descriptor } of artifacts) {
      if (artifactIds.has(descriptor.artifact_id)) {
        issues.push({
          code: "artifact_manifest",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
        });
        continue;
      }
      artifactIds.add(descriptor.artifact_id);
      declaredTotalBytes += descriptor.size_bytes;
      if (descriptor.size_bytes > capabilities.max_artifact_bytes) {
        issues.push({
          code: "artifact_size_limit",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          extension: descriptor.extension,
          mimeType: descriptor.mime_type,
          actual: descriptor.size_bytes,
          limit: capabilities.max_artifact_bytes,
        });
      }
      const allowed = capabilities.allowed_artifacts.some(
        (candidate) =>
          candidate.type === descriptor.artifact_type &&
          candidate.extensions.some(
            (extension) => extension.replace(/^\./u, "").toLowerCase() === descriptor.extension,
          ) &&
          candidate.mime_types.some(
            (mimeType) => mimeType.toLowerCase() === descriptor.mime_type.toLowerCase(),
          ),
      );
      if (!allowed) {
        issues.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          extension: descriptor.extension,
          mimeType: descriptor.mime_type,
          allowedFormats: allowedFormatLabels(capabilities),
          allowedArtifacts: allowedArtifactSummaries(capabilities),
        });
      }
    }
    if (declaredTotalBytes > capabilities.max_total_artifact_bytes) {
      issues.push({
        code: "artifact_total_size_limit",
        scope: "conversation",
        actual: declaredTotalBytes,
        limit: capabilities.max_total_artifact_bytes,
      });
    }
    return issues;
  }

  private validateArtifactManifest(
    capabilities: ConversationShareCapabilities,
    artifacts: Array<{
      sourceRef: string;
      descriptor: ConversationShareArtifactDescriptor;
    }>,
  ): void {
    const issues = this.collectArtifactManifestIssues(capabilities, artifacts);
    if (issues.length > 0) {
      const hasTypeIssue = issues.some((issue) => issue.code === "artifact_type_not_allowed");
      throw new ConversationShareServiceError(
        hasTypeIssue ? "artifact_not_allowed" : "limit_exceeded",
        "Conversation artifacts cannot be shared",
        { issues },
      );
    }
  }

  private async confirmUntilReady(
    preparationId: string,
    request: ConversationShareConfirmRequest,
  ): Promise<ConversationShareRecord> {
    let deadline: number | undefined;
    let lastRequestId: string | undefined;
    let lastStatus: number | undefined;
    let lastCode: number | undefined;
    while (true) {
      try {
        return await this.client.confirm(preparationId, request);
      } catch (error) {
        if (
          !(error instanceof ConversationShareClientError) ||
          error.kind !== "safety_check_pending"
        ) {
          throw error;
        }
        lastRequestId = error.requestId ?? lastRequestId;
        lastStatus = error.status ?? lastStatus;
        lastCode = error.code ?? lastCode;

        // 3215 is a non-final state of the backend security check, and the same preparation/DTO must be retried serially;
        // It cannot be prepared again, nor can it wait indefinitely.
        const currentTime = this.now();
        deadline ??= currentTime + this.confirmPollTimeoutMs;
        const remainingMs = deadline - currentTime;
        if (remainingMs <= 0) {
          throw new ConversationShareServiceError(
            "safety_check_timeout",
            "Conversation share safety check timed out",
            {
              ...(lastRequestId === undefined ? {} : { requestId: lastRequestId }),
              ...(lastStatus === undefined ? {} : { status: lastStatus }),
              ...(lastCode === undefined ? {} : { code: lastCode }),
            },
          );
        }
        const requestedDelayMs = error.retryAfterMs ?? this.confirmPollIntervalMs;
        await this.sleep(Math.min(requestedDelayMs, remainingMs));
        if (this.now() >= deadline) {
          throw new ConversationShareServiceError(
            "safety_check_timeout",
            "Conversation share safety check timed out",
            {
              ...(lastRequestId === undefined ? {} : { requestId: lastRequestId }),
              ...(lastStatus === undefined ? {} : { status: lastStatus }),
              ...(lastCode === undefined ? {} : { code: lastCode }),
            },
          );
        }
      }
    }
  }

  private async loadAllRows(
    input: Pick<
      PublishTextConversationInput,
      "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
    >,
    agentService: ConversationShareAgentService,
  ): Promise<ConversationRowsRead> {
    const pages: ConversationRow[][] = [];
    let beforeRowId: number | undefined;
    let logEpoch: string | undefined;
    let revision: number | undefined;

    while (true) {
      const result = await agentService.conversationRowsRangeV4({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
        sessionId: input.sessionId,
        ...(beforeRowId === undefined ? {} : { beforeRowId }),
        limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
      });
      if (
        (logEpoch !== undefined && result.atLogEpoch !== logEpoch) ||
        (revision !== undefined && result.atRevision !== revision)
      ) {
        throwServiceError("invalid_conversation", "Conversation changed while preparing share");
      }
      logEpoch = result.atLogEpoch;
      revision = result.atRevision;
      pages.unshift(result.rows);
      if (!result.hasMore) break;
      const firstRowId = result.rows[0]?.rowId;
      if (firstRowId === undefined || firstRowId === beforeRowId) {
        throwServiceError("invalid_contract", "Conversation row pagination did not advance");
      }
      beforeRowId = firstRowId;
    }

    const rows = pages.flat();
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const current = rows[index]!;
      if (previous.rowId >= current.rowId) {
        throwServiceError("invalid_contract", "Conversation rows are not globally ordered");
      }
    }
    if (logEpoch === undefined || revision === undefined) {
      throwServiceError("invalid_contract", "Conversation rows are missing a read watermark");
    }
    return { rows, revision, logEpoch };
  }
}
