// Attachment command surface (UI side): ZCodePromptAttachment (composer serialization product) → AttachmentRef
// (v4 sendText/createSession attachments reference model).
//
// Dispatch rules (mapping dual to CLI attachment-refs.ts):
// - localPath (desktop mainstream: native picker / drag and drop getPathForFile / long paste temporary file /
//   oversized large image path downgrade) → ref directly carries the absolute path, zero upload;
// - dataBase64 (paste inline images such as screenshots) → high-level put (internal begin/chunk/commit) → artifact ref;
// - textContent (text without path, web fallback) → put after encoding;
// - None of the three (meta-information-only) → discard and alert (no content to send, no forged references).
import type { ZCodePromptAttachment } from "@zcode/shared";
import type {
  AttachmentRef,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

export type AttachmentPutFn = (
  params: V4AttachmentPutParams,
  options?: AttachmentUploadOptions,
) => Promise<V4AttachmentPutResult>;

function encodeTextToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ByteLength(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.floor((dataBase64.length * 3) / 4) - padding;
}

/**
 * A single attachment → AttachmentRef (via a chunk transaction when an upload is needed). Returning
 * null = nothing to send (discarded).
 */
export async function uploadComposerAttachment(
  put: AttachmentPutFn,
  sessionId: string,
  attachment: ZCodePromptAttachment,
  options?: AttachmentUploadOptions,
): Promise<AttachmentRef | null> {
  const fileName = attachment.filename;
  const mime = attachment.mimeType;
  // The audio variant has no sizeBytes field; uniform reads are narrowed.
  const sizeBytes =
    "sizeBytes" in attachment && typeof attachment.sizeBytes === "number"
      ? attachment.sizeBytes
      : undefined;
  if (attachment.localPath) {
    return {
      ref: attachment.localPath,
      fileName,
      mime,
      bytes: sizeBytes ?? 0,
    };
  }
  const dataBase64 =
    "dataBase64" in attachment && attachment.dataBase64
      ? attachment.dataBase64
      : "textContent" in attachment && attachment.textContent !== undefined
        ? encodeTextToBase64(attachment.textContent)
        : null;
  if (dataBase64 === null) {
    logger.warn(
      `[v4-composer] attachment has no content to send (no localPath/dataBase64/textContent), dropped: ${fileName}`,
    );
    return null;
  }
  const { ref } = await put({ sessionId, fileName, mime, dataBase64 }, options);
  return {
    ref,
    fileName,
    mime,
    bytes: sizeBytes ?? base64ByteLength(dataBase64),
  };
}
