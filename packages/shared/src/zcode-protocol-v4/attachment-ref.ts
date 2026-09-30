import { z } from "zod";

/** Carries only the reference to already-committed content plus display metadata; the content body itself never enters a command/topic frame. */
export const attachmentRefSchema = z
  .object({
    ref: z.string(),
    fileName: z.string(),
    mime: z.string(),
    bytes: z.number(),
    previewRef: z.string().optional(),
  })
  .strict();

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
