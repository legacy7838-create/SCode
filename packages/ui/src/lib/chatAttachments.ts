/* oxlint-disable eslint(max-lines) -- the collection, recovery, and serialization of Composer
 * attachments must share the same MIME/size boundaries.
 */
import { nanoid } from "nanoid";
import {
  VIDEO_INPUT_MAX_BYTES,
  type CreateTempTextAttachmentResult,
  type ZCodePromptAttachment,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@/lib/chatAttachmentErrors.js";
import {
  basenameFromPath,
  countClipboardTextLines,
  createClipboardTextAttachmentFilename,
  inferAttachmentMimeType,
  isTextLikeAttachment,
} from "@/lib/chatAttachmentMetadata.js";

export {
  MissingInlineImageContentError,
  MissingInlinePdfContentError,
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@/lib/chatAttachmentErrors.js";
export {
  countClipboardTextLines,
  formatAttachmentSize,
  shouldPreferSpreadsheetClipboardText,
} from "@/lib/chatAttachmentMetadata.js";

export const MAX_CHAT_ATTACHMENTS = 8;
const LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD = 15 * 1024;
const INLINE_IMAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const INLINE_VIDEO_ATTACHMENT_MAX_BYTES = Math.min(
  VIDEO_INPUT_MAX_BYTES,
  PROTOCOL_V4_LIMITS.attachmentMaxBytes,
);
const INLINE_TEXT_ATTACHMENT_MAX_CHARS = 64 * 1024;

export type ChatComposerAttachmentSourceKind = "clipboard-text";

export interface ChatComposerAttachment {
  id: string;
  file?: File;
  filename: string;
  sourceKind?: ChatComposerAttachmentSourceKind;
  lineCount?: number;
  charCount?: number;
  mimeType: string;
  sizeBytes: number;
  objectUrl?: string;
  localPath?: string;
}

const PDF_MIME_TYPE = "application/pdf";

function normalizeComposerMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized === PDF_MIME_TYPE ? PDF_MIME_TYPE : mimeType;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read attachment"));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read attachment"));
    };
    reader.readAsDataURL(file);
  });
}

export function createChatComposerAttachment(
  file: File,
  localPath?: string,
): ChatComposerAttachment {
  const mimeType = normalizeComposerMimeType(file.type || inferAttachmentMimeType(file.name));
  return {
    id: nanoid(),
    file,
    filename: file.name,
    localPath,
    mimeType,
    objectUrl: URL.createObjectURL(file),
    sizeBytes: file.size,
  };
}

export function createChatComposerPathAttachment(localPath: string): ChatComposerAttachment {
  const filename = basenameFromPath(localPath);
  return {
    id: nanoid(),
    filename,
    localPath,
    mimeType: inferAttachmentMimeType(filename),
    sizeBytes: 0,
  };
}

export function createClipboardTextPathComposerAttachment(
  text: string,
  attachment: CreateTempTextAttachmentResult,
): ChatComposerAttachment {
  return {
    id: nanoid(),
    filename: attachment.filename,
    localPath: attachment.localPath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    charCount: text.length,
    lineCount: countClipboardTextLines(text),
    sourceKind: "clipboard-text",
  };
}

export function shouldCreateClipboardTextAttachment(text: string): boolean {
  return text.length >= LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD;
}

export function createClipboardTextAttachmentFilenameForDate(now: Date = new Date()): string {
  return createClipboardTextAttachmentFilename(now);
}

export function revokeChatComposerAttachment(attachment: ChatComposerAttachment) {
  if (attachment.objectUrl) {
    URL.revokeObjectURL(attachment.objectUrl);
  }
}

export async function serializeChatComposerAttachment(
  attachment: ChatComposerAttachment,
): Promise<ZCodePromptAttachment> {
  const mimeType = normalizeComposerMimeType(
    attachment.mimeType || inferAttachmentMimeType(attachment.filename),
  );
  if (mimeType.startsWith("image/")) {
    if (!attachment.localPath && attachment.sizeBytes > INLINE_IMAGE_ATTACHMENT_MAX_BYTES) {
      // This is the underlying serialization boundary, and user-visible Chinese copy cannot be directly spelled out;
      // Throw structured errors and hand them to the UI layer to format according to the current locale to prevent the English environment from being mixed into Chinese.
      throw new OversizedInlineImageAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: INLINE_IMAGE_ATTACHMENT_MAX_BYTES,
        sizeBytes: attachment.sizeBytes,
      });
    }

    if (
      attachment.localPath &&
      (!attachment.file || attachment.sizeBytes > INLINE_IMAGE_ATTACHMENT_MAX_BYTES)
    ) {
      // If a large image is converted to base64 in the renderer, the memory and RPC payload will be enlarged at the same time.
      // When there is a real local path, the image reading link is handed over to the agent. It already has thresholds such as 20MiB and a degradation policy.
      return {
        kind: "image",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }

    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "image",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
      sizeBytes: attachment.sizeBytes,
    };
  }

  // video: Desktop localPath zero copy; Web inline respects V4's existing transport upper limit before base64 encoding.
  if (mimeType.startsWith("video/")) {
    if (attachment.localPath) {
      return {
        kind: "video",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }
    // When the Web did not have localPath, it was released according to the global video product upper limit. After completing the base64 encoding of the entire file
    // It was rejected by the V4 20MiB upload boundary, which wastes memory and can only display naked protocol errors.
    if (attachment.sizeBytes > INLINE_VIDEO_ATTACHMENT_MAX_BYTES) {
      throw new OversizedInlineVideoAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: INLINE_VIDEO_ATTACHMENT_MAX_BYTES,
        sizeBytes: attachment.sizeBytes,
      });
    }
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "video",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  if (mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE) {
    if (attachment.localPath) {
      return {
        kind: "pdf",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }
    if (attachment.sizeBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
      throw new OversizedInlinePdfAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        sizeBytes: attachment.sizeBytes,
      });
    }
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "pdf",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  if (attachment.localPath) {
    // Ordinary files used to be read into base64 by the renderer and then entered into session/send.
    // It both occupies memory and bypasses the agent-side file reading threshold. When the real path already exists on the desktop, only the path reference is passed.
    return {
      kind: "file",
      filename: attachment.filename,
      localPath: attachment.localPath,
      mimeType,
      ...(attachment.sourceKind === "clipboard-text" ? { sourceKind: "clipboard-text" } : {}),
      sizeBytes: attachment.sizeBytes,
    };
  }

  const textContent =
    attachment.file && isTextLikeAttachment(attachment)
      ? await readAttachmentText(attachment.file)
      : undefined;
  return {
    kind: "file",
    filename: attachment.filename,
    mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(textContent !== undefined ? { textContent } : {}),
  };
}

async function readAttachmentBase64(attachment: ChatComposerAttachment): Promise<string> {
  if (!attachment.file) {
    throw new Error("Attachment has no readable content");
  }
  const dataUrl = await readFileAsDataUrl(attachment.file);
  const base64MarkerIndex = dataUrl.indexOf(",");
  if (base64MarkerIndex === -1) {
    throw new Error("Attachment data is malformed");
  }
  return dataUrl.slice(base64MarkerIndex + 1);
}

export function isImageChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

export function isVideoChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.startsWith("video/");
}

export function isPdfChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE;
}

/**
 * Images and videos belong to the same media group: the input box and the message stream both
 * render them uniformly as media cards.
 */
export function isMediaChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return isImageChatComposerAttachment(attachment) || isVideoChatComposerAttachment(attachment);
}

async function readAttachmentText(file: File): Promise<string> {
  const text = await file.text();
  return text.length > INLINE_TEXT_ATTACHMENT_MAX_CHARS
    ? `${text.slice(0, INLINE_TEXT_ATTACHMENT_MAX_CHARS)}\n\n[content truncated]`
    : text;
}
