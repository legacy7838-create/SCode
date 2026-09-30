/* oxlint-disable eslint(max-lines) -- input attachment staging and preview artifact discovery share one immutable snapshot boundary. */
import { createHash } from "node:crypto";

import {
  buildConversationPreviewArtifactCandidates,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
  extractConversationPreviewFileReferences,
  type ConversationPreviewArtifactCandidate,
  type ConversationPreviewFileChange,
  type ConversationShareCapabilities,
} from "@zcode/shared";
import type {
  ArtifactRow,
  ConversationArtifactType,
  ConversationRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  readZCodeAttachmentFaultCode,
} from "@zcode/shared/zcode-protocol-v4";

import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type {
  ConversationShareFailureIssue,
  PublishTextConversationInput,
} from "./conversationShare.js";
import { ConversationShareServiceError } from "./conversationShare.js";
import type { ConversationShareArtifactSource } from "./conversationShareArtifactSource.js";
import type { ConversationSharePublicArtifact } from "./conversationSharePublicProjection.js";

interface MaterializedShareArtifact {
  sourceRef: string;
  canonicalPath: string;
  bytes: Uint8Array;
}

interface DiscoveredShareArtifact extends MaterializedShareArtifact {
  row: ArtifactRow;
}

interface ConversationShareArtifactSnapshot {
  rows: ConversationRow[];
  bytesBySourceRef: Map<string, Uint8Array>;
  additionalArtifacts: ConversationSharePublicArtifact[];
  issues: ConversationShareFailureIssue[];
  /** Non-blocking: For preview results that are skipped, publishing continues as usual. */
  warnings: ConversationShareFailureIssue[];
}

export interface ConversationSharePreviewPreflightSnapshot {
  revision: number;
  logEpoch: string;
  capabilitiesFingerprint: string;
  candidateFingerprint: string;
  visibleSourceRefs: readonly string[];
}

export function getConversationSharePreviewCandidateFingerprint(
  candidates: readonly ConversationPreviewArtifactCandidate[],
): string {
  return JSON.stringify(
    candidates.map((candidate) => ({
      sourceRef: candidate.sourceRef,
      displayName: candidate.displayName,
      previewKind: candidate.previewKind,
      artifactType: candidate.artifactType,
      mimeType: candidate.mimeType,
      productTurnId: candidate.productTurnId,
      requiresFileChanges: candidate.requiresFileChanges,
    })),
  );
}

function throwDiscoveryError(message: string): never {
  throw new ConversationShareServiceError("invalid_conversation", message);
}

function fileNameOf(path: string): string {
  return path.replace(/\\/gu, "/").split("/").at(-1) ?? path;
}

function extensionOf(path: string): string | null {
  const fileName = fileNameOf(path);
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : null;
}

function matchAllowedArtifact(
  capabilities: ConversationShareCapabilities,
  candidate: Pick<ConversationPreviewArtifactCandidate, "mimeType" | "previewKind" | "sourceRef">,
): { artifactType: ConversationArtifactType; mimeType: string } | null {
  // Video/audio are only preview card candidates; ConversationArtifactType has no media enumeration, even if the server
  // The capability list unexpectedly contains media types and cannot be put back into the uploadable manifest.
  if (candidate.previewKind === "video" || candidate.previewKind === "audio") {
    return null;
  }
  const extension = extensionOf(candidate.sourceRef);
  if (!extension) return null;
  const allowed = capabilities.allowed_artifacts.find(
    (allowedCandidate) =>
      allowedCandidate.extensions.some(
        (candidateExtension) => candidateExtension.replace(/^\./u, "").toLowerCase() === extension,
      ) &&
      allowedCandidate.mime_types.some(
        (candidateMimeType) => candidateMimeType.toLowerCase() === candidate.mimeType,
      ),
  );
  if (!allowed) return null;
  return { artifactType: allowed.type, mimeType: candidate.mimeType };
}

async function materializeRegisteredArtifacts(options: {
  workspacePath: string;
  maxArtifactBytes: number;
  artifacts: ConversationSharePublicArtifact[];
  artifactSource: ConversationShareArtifactSource;
}): Promise<MaterializedShareArtifact[]> {
  const materialized: MaterializedShareArtifact[] = [];
  for (const artifact of options.artifacts) {
    const { bytes, canonicalPath } = await options.artifactSource.read({
      workspacePath: options.workspacePath,
      ref: artifact.sourceRef,
      maxBytes: options.maxArtifactBytes,
    });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // Row is recorded when the tool completes, the user may modify the same path before publishing; the current byte must be rechecked,
    // Otherwise projection/manifest describes the old file and multipart uploads the new file.
    if (
      bytes.byteLength !== artifact.descriptor.size_bytes ||
      sha256 !== artifact.descriptor.sha256
    ) {
      throwDiscoveryError("Conversation artifact changed after it was registered");
    }
    materialized.push({ sourceRef: artifact.sourceRef, canonicalPath, bytes });
  }
  return materialized;
}

async function discoverPreviewArtifacts(options: {
  zcodeAgentService: Pick<
    IZCodeAgentService,
    "conversationFileChangesV4" | "conversationAttachmentReadV4"
  >;
  artifactSource: ConversationShareArtifactSource;
  input: PublishTextConversationInput;
  selectedRows: ConversationRow[];
  capabilities: ConversationShareCapabilities;
  revision: number;
  logEpoch: string;
  existingCanonicalPaths: Set<string>;
  issues: ConversationShareFailureIssue[];
  warnings: ConversationShareFailureIssue[];
  turnOrdinalByProductTurnId?: ReadonlyMap<string, number>;
  preflightPreviewSnapshots?: ReadonlyMap<string, ConversationSharePreviewPreflightSnapshot>;
  currentCapabilitiesFingerprint?: string;
}): Promise<DiscoveredShareArtifact[]> {
  const headersByProductTurnId = new Map<string, TurnHeaderRow>();
  for (const row of options.selectedRows) {
    if (
      row.kind === "turnHeader" &&
      row.productTurnId &&
      (row.state === "completedSuccess" || row.state === "completedInterrupted")
    ) {
      headersByProductTurnId.set(row.productTurnId, row);
    }
  }
  const turnOrdinalByProductTurnId = new Map<string, number>(options.turnOrdinalByProductTurnId);
  for (const row of options.selectedRows) {
    if (
      row.kind !== "turnHeader" ||
      !row.productTurnId ||
      turnOrdinalByProductTurnId.has(row.productTurnId)
    ) {
      continue;
    }
    turnOrdinalByProductTurnId.set(row.productTurnId, turnOrdinalByProductTurnId.size + 1);
  }
  const assistantTextByProductTurnId = new Map<string, string[]>();
  for (const row of options.selectedRows) {
    if (row.kind !== "assistantText" || !row.productTurnId) continue;
    const texts = assistantTextByProductTurnId.get(row.productTurnId) ?? [];
    texts.push(row.text);
    assistantTextByProductTurnId.set(row.productTurnId, texts);
  }
  const discovered: DiscoveredShareArtifact[] = [];
  const maxSourceRowId = options.selectedRows.reduce(
    (maximum, row) => Math.max(maximum, row.rowId),
    0,
  );

  for (const [productTurnId, textParts] of assistantTextByProductTurnId) {
    const header = headersByProductTurnId.get(productTurnId);
    if (!header) continue;
    const assistantText = textParts.join("\n\n");
    const references = extractConversationPreviewFileReferences(
      assistantText,
      options.input.workspacePath,
    );
    const needsFileChanges = references.some(
      (reference) => reference.kind === "markdown" || reference.kind === "html",
    );
    let fileChanges: ConversationPreviewFileChange[] | undefined;
    if (needsFileChanges && header.fileChanges?.state !== "reverted") {
      if (!header.entityId || !header.productTurnId) {
        throwDiscoveryError("Conversation file changes are missing a stable turn identity");
      }
      let result: Awaited<ReturnType<IZCodeAgentService["conversationFileChangesV4"]>>;
      try {
        result = await options.zcodeAgentService.conversationFileChangesV4({
          workspacePath: options.input.workspacePath,
          ...(options.input.workspaceIdentity
            ? { workspaceIdentity: options.input.workspaceIdentity }
            : {}),
          ...(options.input.remoteSessionId
            ? { remoteSessionId: options.input.remoteSessionId }
            : {}),
          sessionId: options.input.sessionId,
          target: { rowId: header.rowId, entityId: header.entityId },
          baseRevision: options.revision,
          baseLogEpoch: options.logEpoch,
        });
      } catch (error) {
        // rows/range and fileChanges are two read-only RPCs; if the intermediate projection has been advanced, continue the release
        // Stitch together conversations and files from different revisions. Stale water levels must fail explicitly before prepare.
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("proto.staleRevision") || message.includes("proto.staleLogEpoch")) {
          throwDiscoveryError("Conversation changed while preparing share");
        }
        throw error;
      }
      fileChanges = result.items.map((item) => ({
        path: item.path,
        state: result.state === "reverted" ? "reverted" : "active",
      }));
    }

    const candidates = buildConversationPreviewArtifactCandidates({
      assistantText,
      productTurnId,
      workspacePath: options.input.workspacePath,
      fileChanges,
    });
    const preflightSnapshot = options.preflightPreviewSnapshots?.get(productTurnId);
    const preflightMatches =
      preflightSnapshot !== undefined &&
      preflightSnapshot.revision === options.revision &&
      preflightSnapshot.logEpoch === options.logEpoch &&
      preflightSnapshot.capabilitiesFingerprint === options.currentCapabilitiesFingerprint &&
      preflightSnapshot.candidateFingerprint ===
        getConversationSharePreviewCandidateFingerprint(candidates);
    const candidatesForPublish = preflightMatches
      ? candidates.filter((candidate) =>
          preflightSnapshot.visibleSourceRefs.includes(candidate.sourceRef),
        )
      : candidates;
    const visibleCandidates: ConversationPreviewArtifactCandidate[] = [];
    const previewCanonicalPaths = new Set<string>();
    const fallbackReadCache = new Map<string, { bytes: Uint8Array; canonicalPath: string }>();
    for (const candidate of candidatesForPublish) {
      // Consistent with the UI preview card: first stat determines whether the card still exists, and then determines the sharing ability.
      // When the re-confirmation fails during the publishing phase, a warning must be returned to avoid "sharing successfully" but quietly missing the card that is visible when selecting.
      const visibleCandidateSource = {
        workspacePath: options.input.workspacePath,
        ref: candidate.sourceRef,
      } as const;
      try {
        if (options.artifactSource.stat) {
          const stat = await options.artifactSource.stat(visibleCandidateSource);
          if (previewCanonicalPaths.has(stat.canonicalPath)) continue;
          previewCanonicalPaths.add(stat.canonicalPath);
        } else {
          // artifactSource.stat is an optional capability and not implemented by all test stubs or history runtimes.
          // By default, read is used for existence confirmation, maintaining backward compatibility: the discovery results can still be referenced from within the line.
          const materialized = await options.artifactSource.read({
            ...visibleCandidateSource,
            maxBytes: options.capabilities.max_artifact_bytes,
          });
          if (previewCanonicalPaths.has(materialized.canonicalPath)) continue;
          previewCanonicalPaths.add(materialized.canonicalPath);
          fallbackReadCache.set(candidate.sourceRef, materialized);
        }
      } catch (error) {
        if (
          error instanceof ConversationShareServiceError &&
          error.reasonCode === "artifact_read_failed"
        ) {
          options.warnings.push({
            code: "artifact_read_failed",
            scope: "artifact",
            rowId: header.rowId,
            turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
            artifactDisplayName: candidate.displayName,
            artifactType: candidate.artifactType,
            extension: candidate.displayName.split(".").at(-1)?.toLowerCase(),
            mimeType: candidate.mimeType,
            availability: error.diagnostics?.errno === "ENOENT" ? "not_found" : "unknown",
          });
          continue;
        }
        throw error;
      }
      if (visibleCandidates.length < CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT) {
        visibleCandidates.push(candidate);
      }
    }

    for (const candidate of visibleCandidates) {
      const match = matchAllowedArtifact(options.capabilities, candidate);
      if (!match) {
        // When the file type is not in capabilities, only the candidate is skipped and other messages are shared; the selection phase preflight and success status
        // By sharing this structured tip, you can no longer upgrade a single unsupported file to an entire release failure.
        options.warnings.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: candidate.displayName.split(".").at(-1)?.toLowerCase(),
          mimeType: candidate.mimeType,
          allowedFormats: options.capabilities.allowed_artifacts.flatMap((allowed) =>
            allowed.extensions.map(
              (extension) => `${allowed.type.toUpperCase()} (.${extension.replace(/^\./u, "")})`,
            ),
          ),
          allowedArtifacts: options.capabilities.allowed_artifacts.map((allowed) => ({
            type: allowed.type,
            extensions: allowed.extensions,
            mimeTypes: allowed.mime_types,
          })),
        });
        continue;
      }
      // stat still needs to be read after passing: the file may have been deleted or changed between the selection phase and the release phase.
      let materialized;
      const cached = fallbackReadCache.get(candidate.sourceRef);
      try {
        if (cached) {
          materialized = cached;
        } else {
          materialized = await options.artifactSource.read({
            workspacePath: options.input.workspacePath,
            ref: candidate.sourceRef,
            maxBytes: options.capabilities.max_artifact_bytes,
          });
        }
      } catch (error) {
        if (
          !(error instanceof ConversationShareServiceError) ||
          error.reasonCode !== "artifact_read_failed"
        ) {
          // limit_exceeded / unsafe_structure are still blocking: those are real constraints that need to be dealt with by the user.
          throw error;
        }
        options.warnings.push({
          code: "artifact_read_failed",
          scope: "artifact",
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: candidate.displayName.split(".").at(-1)?.toLowerCase(),
          mimeType: candidate.mimeType,
          availability: error.diagnostics?.errno === "ENOENT" ? "not_found" : "unknown",
        });
        continue;
      }
      if (options.existingCanonicalPaths.has(materialized.canonicalPath)) continue;
      options.existingCanonicalPaths.add(materialized.canonicalPath);
      const localKey = `preview:${productTurnId}:${candidate.sourceRef}`;
      discovered.push({
        sourceRef: candidate.sourceRef,
        canonicalPath: materialized.canonicalPath,
        bytes: materialized.bytes,
        row: {
          rowId: maxSourceRowId + discovered.length + 1,
          turnId: header.turnId,
          productTurnId: header.productTurnId,
          createdAt: header.endedAt ?? header.createdAt,
          createdAtSeq: header.createdAtSeq,
          kind: "artifact",
          artifactVersionId: localKey,
          logicalArtifactKey: localKey,
          displayName: candidate.displayName,
          artifactType: match.artifactType,
          mimeType: match.mimeType,
          sizeBytes: materialized.bytes.byteLength,
          sha256: createHash("sha256").update(materialized.bytes).digest("hex"),
          ref: candidate.sourceRef,
          state: "current",
        },
      });
    }
  }
  return discovered;
}

async function readInputAttachment(options: {
  zcodeAgentService: Pick<IZCodeAgentService, "conversationAttachmentReadV4">;
  input: PublishTextConversationInput;
  row: Extract<ConversationRow, { kind: "userInput" }>;
  attachmentIndex: number;
  maxBytes: number;
}): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const attachment = options.row.attachments?.[options.attachmentIndex];
  if (!attachment || !options.row.entityId) {
    throw new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation input attachment is missing a stable row identity",
    );
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let totalBytes: number | undefined;
  let mediaType = attachment.mime;
  while (true) {
    const result = await options.zcodeAgentService.conversationAttachmentReadV4({
      workspacePath: options.input.workspacePath,
      ...(options.input.workspaceIdentity
        ? { workspaceIdentity: options.input.workspaceIdentity }
        : {}),
      ...(options.input.remoteSessionId ? { remoteSessionId: options.input.remoteSessionId } : {}),
      sessionId: options.input.sessionId,
      ref: attachment.ref,
      target: { rowId: options.row.rowId, entityId: options.row.entityId },
      attachmentIndex: options.attachmentIndex,
      offset,
      limit: Math.min(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes, options.maxBytes),
    });
    const bytes = new Uint8Array(Buffer.from(result.dataBase64, "base64"));
    totalBytes ??= result.totalBytes;
    mediaType = result.mediaType || mediaType;
    if (totalBytes > options.maxBytes || (bytes.byteLength === 0 && result.nextOffset !== null)) {
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation input attachment exceeds the byte limit",
      );
    }
    chunks.push(bytes);
    offset += bytes.byteLength;
    if (result.nextOffset === null) break;
    if (result.nextOffset !== offset || result.nextOffset > totalBytes) {
      throw new ConversationShareServiceError(
        "invalid_conversation",
        "Conversation input attachment returned invalid read progress",
      );
    }
  }
  const output = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  if (
    totalBytes !== output.byteLength ||
    (attachment.bytes > 0 && attachment.bytes !== output.byteLength)
  ) {
    throw new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation input attachment changed before sharing",
    );
  }
  if (output.byteLength === 0) {
    throw new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation input attachment is empty",
    );
  }
  return { bytes: output, mediaType };
}

async function discoverInputAttachments(options: {
  zcodeAgentService: Pick<IZCodeAgentService, "conversationAttachmentReadV4">;
  input: PublishTextConversationInput;
  selectedRows: ConversationRow[];
  capabilities: ConversationShareCapabilities;
  warnings: ConversationShareFailureIssue[];
  turnOrdinalByProductTurnId?: ReadonlyMap<string, number>;
}): Promise<{
  rows: ConversationRow[];
  artifacts: ConversationSharePublicArtifact[];
  bytesBySourceRef: Map<string, Uint8Array>;
}> {
  const rows = options.selectedRows.map((row) =>
    row.kind === "userInput"
      ? { ...row, attachments: row.attachments?.map((attachment) => ({ ...attachment })) }
      : row,
  );
  const artifacts: ConversationSharePublicArtifact[] = [];
  const bytesBySourceRef = new Map<string, Uint8Array>();
  let artifactIndex = 0;
  for (const row of rows) {
    if (row.kind !== "userInput" || !row.attachments || row.attachments.length === 0) continue;
    const nextAttachments = [];
    for (const [attachmentIndex, attachment] of row.attachments.entries()) {
      const extension = extensionOf(attachment.fileName) ?? "txt";
      const mimeType = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() || "text/plain";
      const allowed = options.capabilities.allowed_artifacts.find(
        (candidate) =>
          candidate.extensions.some(
            (value) => value.replace(/^\./u, "").toLowerCase() === extension,
          ) && candidate.mime_types.some((value) => value.toLowerCase() === mimeType),
      );
      const turnOrdinal = row.productTurnId
        ? options.turnOrdinalByProductTurnId?.get(row.productTurnId)
        : undefined;
      if (!allowed) {
        options.warnings.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          rowId: row.rowId,
          ...(turnOrdinal === undefined ? {} : { turnOrdinal }),
          artifactDisplayName: attachment.fileName,
          artifactType: extension === "txt" ? "text" : extension,
          extension,
          mimeType,
          allowedArtifacts: options.capabilities.allowed_artifacts.map((candidate) => ({
            type: candidate.type,
            extensions: candidate.extensions,
            mimeTypes: candidate.mime_types,
          })),
        });
        continue;
      }
      try {
        const materialized = await readInputAttachment({
          zcodeAgentService: options.zcodeAgentService,
          input: options.input,
          row,
          attachmentIndex,
          maxBytes: options.capabilities.max_artifact_bytes,
        });
        const sourceRef = `input:${row.rowId}:${attachmentIndex}`;
        const artifactId = `share-input-artifact-${++artifactIndex}`;
        const ref = `zcode-artifact://share/${artifactId}`;
        const sha256 = createHash("sha256").update(materialized.bytes).digest("hex");
        artifacts.push({
          sourceRef,
          descriptor: {
            artifact_id: artifactId,
            logical_artifact_key: `share-input-key-${artifactIndex}`,
            producer_product_turn_id: row.productTurnId ?? row.turnId,
            artifact_version: 1,
            state: "current",
            ref,
            artifact_type: allowed.type,
            display_name: attachment.fileName,
            extension,
            mime_type: mimeType,
            size_bytes: materialized.bytes.byteLength,
            sha256,
          },
        });
        bytesBySourceRef.set(sourceRef, materialized.bytes);
        nextAttachments.push({
          ...attachment,
          ref,
          previewRef: ref,
          bytes: materialized.bytes.byteLength,
        });
      } catch (error) {
        const faultCode = readZCodeAttachmentFaultCode(error);
        if (
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized ||
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted
        ) {
          throw new ConversationShareServiceError(
            "artifact_protocol_not_ready",
            "Conversation input attachment is not authorized",
            { reasonCode: "artifact_protocol_not_ready" },
          );
        }
        if (
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge ||
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge
        ) {
          // Capacity exceeding the limit is determined to be blocked and cannot be downgraded to an "attachment unavailable" warning and then released silently——
          // In this way, the recipient cannot get the attachment, and the sharer cannot see the error category (see preflight category with the same name).
          throw new ConversationShareServiceError(
            "limit_exceeded",
            "Conversation input attachment exceeds the artifact size limit",
            {
              reasonCode: "artifact_size_limit",
              issues: [
                {
                  code: "artifact_size_limit",
                  scope: "artifact",
                  rowId: row.rowId,
                  ...(turnOrdinal === undefined ? {} : { turnOrdinal }),
                  ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
                  artifactDisplayName: attachment.fileName,
                  artifactType: allowed.type,
                  extension,
                  mimeType,
                  limit: options.capabilities.max_artifact_bytes,
                },
              ],
            },
          );
        }
        options.warnings.push({
          code: "input_attachment_unavailable",
          scope: "artifact",
          rowId: row.rowId,
          ...(turnOrdinal === undefined ? {} : { turnOrdinal }),
          ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
          artifactDisplayName: attachment.fileName,
          artifactType: allowed.type,
          extension,
          mimeType,
          availability:
            faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound ||
            faultCode === ZCODE_ATTACHMENT_FAULT_CODES.statNotFile ||
            (error instanceof ConversationShareServiceError &&
              error.diagnostics?.errno === "ENOENT")
              ? "not_found"
              : "unknown",
        });
      }
    }
    if (nextAttachments.length > 0) {
      row.attachments = nextAttachments;
    } else {
      delete row.attachments;
    }
  }
  return { rows, artifacts, bytesBySourceRef };
}

function insertDiscoveredArtifacts(
  selectedRows: ConversationRow[],
  artifacts: DiscoveredShareArtifact[],
): ConversationRow[] {
  if (artifacts.length === 0) return selectedRows;
  const artifactsByProductTurnId = new Map<string, ArtifactRow[]>();
  for (const artifact of artifacts) {
    const productTurnId = artifact.row.productTurnId ?? "";
    const productTurnArtifacts = artifactsByProductTurnId.get(productTurnId);
    if (productTurnArtifacts) productTurnArtifacts.push(artifact.row);
    else artifactsByProductTurnId.set(productTurnId, [artifact.row]);
  }
  const lastRowIndexByProductTurnId = new Map<string, number>();
  selectedRows.forEach((row, index) => {
    if (row.productTurnId) lastRowIndexByProductTurnId.set(row.productTurnId, index);
  });
  return selectedRows.flatMap((row, index) => {
    if (!row.productTurnId || lastRowIndexByProductTurnId.get(row.productTurnId) !== index) {
      return [row];
    }
    return [row, ...(artifactsByProductTurnId.get(row.productTurnId) ?? [])];
  });
}

export async function buildConversationShareArtifactSnapshot(options: {
  zcodeAgentService: Pick<
    IZCodeAgentService,
    "conversationFileChangesV4" | "conversationAttachmentReadV4"
  >;
  artifactSource: ConversationShareArtifactSource;
  input: PublishTextConversationInput;
  selectedRows: ConversationRow[];
  registeredArtifacts: ConversationSharePublicArtifact[];
  capabilities: ConversationShareCapabilities;
  revision: number;
  logEpoch: string;
  turnOrdinalByProductTurnId?: ReadonlyMap<string, number>;
  preflightPreviewSnapshots?: ReadonlyMap<string, ConversationSharePreviewPreflightSnapshot>;
  currentCapabilitiesFingerprint?: string;
}): Promise<ConversationShareArtifactSnapshot> {
  const issues: ConversationShareFailureIssue[] = [];
  const warnings: ConversationShareFailureIssue[] = [];
  const inputAttachments = await discoverInputAttachments({
    zcodeAgentService: options.zcodeAgentService,
    input: options.input,
    selectedRows: options.selectedRows,
    capabilities: options.capabilities,
    warnings,
    turnOrdinalByProductTurnId: options.turnOrdinalByProductTurnId,
  });
  const selectedRows = inputAttachments.rows;
  const registered = await materializeRegisteredArtifacts({
    workspacePath: options.input.workspacePath,
    maxArtifactBytes: options.capabilities.max_artifact_bytes,
    artifacts: options.registeredArtifacts,
    artifactSource: options.artifactSource,
  });
  const discovered = await discoverPreviewArtifacts({
    ...options,
    selectedRows,
    issues,
    warnings,
    existingCanonicalPaths: new Set(registered.map((artifact) => artifact.canonicalPath)),
    turnOrdinalByProductTurnId: options.turnOrdinalByProductTurnId,
    preflightPreviewSnapshots: options.preflightPreviewSnapshots,
    currentCapabilitiesFingerprint: options.currentCapabilitiesFingerprint,
  });
  return {
    rows: insertDiscoveredArtifacts(selectedRows, discovered),
    bytesBySourceRef: new Map(
      [
        ...registered,
        ...discovered,
        ...[...inputAttachments.bytesBySourceRef.entries()].map(([sourceRef, bytes]) => ({
          sourceRef,
          bytes,
          canonicalPath: sourceRef,
        })),
      ].map((artifact) => [artifact.sourceRef, artifact.bytes]),
    ),
    additionalArtifacts: inputAttachments.artifacts,
    issues,
    warnings,
  };
}
