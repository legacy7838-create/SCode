// ZCode Protocol v4 - Data model draft (not frozen, schema finalization is subject to golden test).
// Discipline of this package: only put schema type + pure function, any runtime/IO/transmission logic is prohibited.
import { z } from "zod";
import { VIDEO_INPUT_MAX_BYTES } from "../zcode-media-policy.js";

/** V4 physical wire protocol version; projection snapshots keep using protocolVersion=1. */
export const V4_WIRE_PROTOCOL_VERSION = 3 as const;

/** V3 row target: the display row and the stable entity must be submitted as a pair and validated by the same authoritative projection. */
export const conversationRowTargetSchema = z
  .object({
    rowId: z.number().int().nonnegative(),
    entityId: z.string().trim().min(1),
  })
  .strict();
export type ConversationRowTarget = z.infer<typeof conversationRowTargetSchema>;

// Clock rules: Unix ms, always CLI clock; the client is prohibited from subtracting the local clock from the protocol Timestamp.
export const timestampSchema = z.number();
export type Timestamp = z.infer<typeof timestampSchema>;

// delivery profile: only exists in the parameter table of the CLI flush pipeline. Profile variables are prohibited from appearing in client code.
export const streamablePathSchema = z.enum(["text", "inputText", "output.text", "summaryText"]);
export type StreamablePath = z.infer<typeof streamablePathSchema>;

export interface DeliveryProfile {
  desktopOnlyRows: boolean;
  flushWindowMs: number;
  streamPaths: Record<StreamablePath, boolean>;
  streamOutputCapBytes: number;
  toolProgress: boolean;
}

export const DELIVERY_PROFILES = {
  continuous: {
    desktopOnlyRows: true,
    flushWindowMs: 30,
    streamPaths: {
      text: true,
      inputText: true,
      "output.text": true,
      summaryText: true,
    },
    streamOutputCapBytes: 262144,
    toolProgress: false,
  },
  replayable: {
    desktopOnlyRows: false,
    flushWindowMs: 150,
    streamPaths: {
      text: true,
      inputText: false,
      "output.text": false,
      summaryText: false,
    },
    streamOutputCapBytes: 0,
    toolProgress: true,
  },
} as const satisfies Record<string, DeliveryProfile>;

export type DeliveryProfileName = keyof typeof DELIVERY_PROFILES;

// Constants and limits (initial value, actual measured parameter adjustment).
export const PROTOCOL_V4_LIMITS = {
  maxFrameBytes: 1024 * 1024,
  logicalFrameAssemblyMaxBytes: 16 * 1024 * 1024,
  logicalFrameAssemblyMaxFragments: 1024,
  logicalFrameAssemblyMaxConcurrent: 32,
  logicalFrameAssemblyMaxStagedBytes: 32 * 1024 * 1024,
  logicalFrameAssemblyTimeoutMs: 30_000,
  transportEnvelopeIdMaxChars: 256,
  subscriberBufferMaxOps: 500,
  subscriberBufferMaxBytes: 1024 * 1024,
  eventRetentionPerSession: 2000,
  snapshotTailWindowRows: 60,
  rowsRangeMaxLimit: 200,
  toolOutputFinalHeadBytes: 32 * 1024,
  toolOutputFinalTailBytes: 32 * 1024,
  goalVerificationsRetained: 20,
  pendingCommandsDisplayMax: 32,
  commandPendingTtlMs: 24 * 60 * 60 * 1000,
  idempotencyTablePerSession: 512,
  conversationQueryTimeoutMs: 10_000,
  attachmentMaxBytes: 20 * 1024 * 1024,
  attachmentChunkMaxBytes: 512 * 1024,
  attachmentPreviewMaxBytes: VIDEO_INPUT_MAX_BYTES,
  // The metadata-only stat in the share selection phase reused attachmentPreviewMaxBytes
  // (30MiB) is used as the upper limit of totalBytes, so attachments exceeding this value will throw an error during schema verification.
  // The category "capacity exceeded" that should have been blocked for sure was instead downgraded to deferred and the content was silently lost.
  // stat does not move bytes, it only requires an upper bound that is large enough to express the actual file size.
  attachmentStatMaxBytes: 2 * 1024 * 1024 * 1024,
  attachmentPreviewMaxChunks: VIDEO_INPUT_MAX_BYTES / (512 * 1024),
  attachmentReadCacheMaxBytes: VIDEO_INPUT_MAX_BYTES,
  attachmentReadCacheTtlMs: 30_000,
  attachmentUploadMaxChunks: 64,
  attachmentUploadMaxConcurrent: 16,
  attachmentUploadMaxStagedBytes: 64 * 1024 * 1024,
  attachmentUploadTtlMs: 5 * 60_000,
  attachmentUnreferencedTtlMs: 24 * 60 * 60 * 1000,
} as const;
