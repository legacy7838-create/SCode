// Structured error codes for attachment reading/detection (classification basis for share preflight and release).
//
// Share preflight used `error.message` to distinguish "attachment does not exist/is not authorized/other".
// Once the RPC layer wraps, localizes or replaces the message (for example, a ZodError is thrown if the schema validation fails), the classification becomes invalid immediately.
// And downgrade the deterministic problem to a deferred. Warehouse discipline (AGENTS.md "Do not rely on error text to make process judgments")
// Stable error codes are required, and this module is the single source of the contract.
//
// Transmission path: Error thrown by CLI side has `code` field, `toProtocolError` will convert string code
// Transparently transmitted to JSON-RPC `error.data.code`; the client uses readZCodeAttachmentFaultCode when reading back.

export const ZCODE_ATTACHMENT_FAULT_CODES = {
  /** The host does not implement the stat capability. */
  statUnsupported: "fault.attachment.statUnsupported",
  /** The host does not implement the read capability. */
  readUnsupported: "fault.attachment.readUnsupported",
  /** The path the ref points to exists but is not a regular file. */
  statNotFile: "fault.attachment.statNotFile",
  /** The target row/ref of share stat is not in the current session projection, so authorization is refused. */
  shareStatNotAuthorized: "fault.attachment.shareStatNotAuthorized",
  /** The target row/ref of share read is not in the current session projection, so authorization is refused. */
  shareReadNotAuthorized: "fault.attachment.shareReadNotAuthorized",
  /** The connection share stat arrived on is not trusted. */
  shareStatConnectionUntrusted: "fault.attachment.shareStatConnectionUntrusted",
  /** The connection share read arrived on is not trusted. */
  shareReadConnectionUntrusted: "fault.attachment.shareReadConnectionUntrusted",
  /** The attachment has vanished from disk (a deterministic miss such as ENOENT). */
  shareStatNotFound: "fault.attachment.shareStatNotFound",
  /** The attachment's real size exceeds the upper bound the stat protocol can express. */
  shareStatTooLarge: "fault.attachment.shareStatTooLarge",
  /** The attachment's byte count exceeds the preview/read channel limit, so it cannot be carried. */
  previewTooLarge: "fault.attachment.previewTooLarge",
  /** The read result is not a previewable media type. */
  previewNotMedia: "fault.attachment.previewNotMedia",
} as const;

export type ZCodeAttachmentFaultCode =
  (typeof ZCODE_ATTACHMENT_FAULT_CODES)[keyof typeof ZCODE_ATTACHMENT_FAULT_CODES];

const KNOWN_FAULT_CODES = new Set<string>(Object.values(ZCODE_ATTACHMENT_FAULT_CODES));

export function isZCodeAttachmentFaultCode(value: unknown): value is ZCodeAttachmentFaultCode {
  return typeof value === "string" && KNOWN_FAULT_CODES.has(value);
}

/**
 * An attachment error carrying a stable fault code. `code` is a string; `toProtocolError` puts it
 * into JSON-RPC `error.data.code`, so both in-process and cross-process callers can classify by code.
 */
export class ZCodeAttachmentFaultError extends Error {
  readonly code: ZCodeAttachmentFaultCode;

  constructor(code: ZCodeAttachmentFaultCode, options?: { cause?: unknown; message?: string }) {
    // By default, message is the fault code itself, and text matching on older versions of clients can still hit.
    super(
      options?.message ?? code,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ZCodeAttachmentFaultError";
    this.code = code;
  }
}

/**
 * Reads the attachment fault code out of any error:
 * - a ZCodeAttachmentFaultError / Error carrying `code` thrown in-process;
 * - an `error.data.code` handed back across JSON-RPC;
 * - a compatibility fallback for older CLI versions that only have the message text (see the comment below).
 */
export function readZCodeAttachmentFaultCode(error: unknown): ZCodeAttachmentFaultCode | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; data?: unknown };
  if (isZCodeAttachmentFaultCode(candidate.code)) return candidate.code;
  if (candidate.data && typeof candidate.data === "object") {
    const data = candidate.data as { code?: unknown };
    if (isZCodeAttachmentFaultCode(data.code)) return data.code;
  }
  // Compatibility: The desktop may connect to the old zcode-cli that does not yet have structured code. Only in the message "whole equals"
  // When a certain fault code is hit, no fuzzy matching is performed to avoid misjudgment of any packaged text as a definite classification.
  if (error instanceof Error && isZCodeAttachmentFaultCode(error.message)) return error.message;
  return undefined;
}
