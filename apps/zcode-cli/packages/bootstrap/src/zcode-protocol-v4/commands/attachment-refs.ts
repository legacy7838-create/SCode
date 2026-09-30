// Attachment command surface: AttachmentRef (reference model) → protocol boundary mapping for core TurnAttachment.
//
// Two forms of ref (dual to the "local path/artifact URI" annotation of buildUserInputRow on the projection side):
// 1. URI ref (zcode-artifact://, etc. with scheme:/) - content reference stored through attachment chunk transaction:
//    - Image: content directly carries the URI, and core's attachment-artifacts parsing chain is used when the model is requested.
//      Read back the data URL (same shape as the product of externalizePromptAttachments, not decoded inline here,
//      Avoid enlarging the memory of large images at the command level).
//    - PDF: keep the URI and hand it over to the core's PDF resolver; other non-images: read back the artifact and press the old
//      decodeTextProtocolAttachment is semantically decoded into ≤64KiB text
//      Content (over limit/cannot be unlocked → only display meta-information is retained, no forged content).
// 2. Local path ref (desktop direct absolute path) - according to the old mapProtocolPromptAttachment
//    The localPath branch is mapped to a path reference, and the core has a read threshold and degradation policy.
import type { TurnAttachment } from "@zcode/core";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp } from "../../app/types.js";

const URI_REF_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const INLINE_TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;

function isUriAttachmentRef(ref: string): boolean {
  return URI_REF_PATTERN.test(ref);
}

function displayMetaOf(
  ref: AttachmentRef,
): Pick<TurnAttachment, "filename" | "mimeType" | "sizeBytes"> {
  return {
    filename: ref.fileName,
    mimeType: ref.mime,
    sizeBytes: ref.bytes,
  };
}

function isImageRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase().startsWith("image/") ?? false;
}

function isVideoRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase().startsWith("video/") ?? false;
}

function isPdfRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

/** data URL (data:<mime>;base64,<payload>) -> utf8 text; a non-base64 data URL returns the body unchanged. */
function decodeDataUrlText(content: string): string | undefined {
  if (!content.startsWith("data:")) return content;
  const commaIndex = content.indexOf(",");
  if (commaIndex === -1) return undefined;
  const header = content.slice(0, commaIndex);
  const payload = content.slice(commaIndex + 1);
  if (!header.includes(";base64")) return decodeURIComponent(payload);
  try {
    return Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

async function mapAttachmentRef(app: ZCodeApp, ref: AttachmentRef): Promise<TurnAttachment> {
  const displayMeta = displayMetaOf(ref);
  if (!isUriAttachmentRef(ref.ref)) {
    // Local path reference: File/image reading link handed to core (threshold and degradation are built-in).
    if (isVideoRef(ref)) {
      return { path: ref.ref, type: "video", ...displayMeta };
    }
    return {
      path: ref.ref,
      type: isImageRef(ref) ? "image" : isPdfRef(ref) ? "pdf" : "file",
      ...displayMeta,
    };
  }
  if (isImageRef(ref)) {
    // Image URI ref: content carries artifact URI, which is determined by resolveAttachmentDataUrl in the model request phase.
    // Read back (same shape as the externalizePromptAttachments product, naturally eliminating the need for secondary externalization).
    return { content: ref.ref, path: ref.fileName, type: "image", ...displayMeta };
  }
  if (isVideoRef(ref)) {
    // Video URI ref: isomorphic to the image - content carries artifact URI, and the data URL is read back in the model request phase.
    return { content: ref.ref, path: ref.fileName, type: "video", ...displayMeta };
  }
  if (isPdfRef(ref)) {
    // The PDF URI ref must retain the durable URI and hand it over to the core to read the data URL; it cannot be decoded as UTF-8 text.
    return { content: ref.ref, path: ref.fileName, type: "pdf", ...displayMeta };
  }
  // Non-image URI ref: Restore ≤64KiB text content according to old decodeTextProtocolAttachment semantics.
  if (ref.bytes > INLINE_TEXT_ATTACHMENT_MAX_BYTES) {
    return { type: "file", ...displayMeta };
  }
  try {
    const artifact = await app.readToolResultArtifact(ref.ref);
    const text = decodeDataUrlText(artifact.content);
    return text !== undefined
      ? { content: text, path: ref.fileName, type: "file", ...displayMeta }
      : { type: "file", ...displayMeta };
  } catch {
    // Reference failure (TTL recycling/write failure): retain the display meta-information and prevent the entire sending from failing.
    return { type: "file", ...displayMeta };
  }
}

/**
 * Shared by sendText/createSession/editUserQuery: an attachments reference array -> core
 * TurnAttachment[]. An empty array or absent -> undefined (sendInput semantics: no attachments
 * means no field).
 */
export async function mapAttachmentRefsToTurnAttachments(
  app: ZCodeApp,
  refs: readonly AttachmentRef[] | undefined,
): Promise<TurnAttachment[] | undefined> {
  if (!refs || refs.length === 0) return undefined;
  const mapped = await Promise.all(refs.map((ref) => mapAttachmentRef(app, ref)));
  return mapped.length > 0 ? mapped : undefined;
}
