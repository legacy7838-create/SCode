import { z } from "zod";

const OUTPUT_PREVIEW_MAX_CHARACTERS = 4096;
/** Bounded Bash output content shared by both ends; excludes replayable transport resume state. */
export const executionOutputPreviewSchema = z
  .object({
    text: z.string().max(OUTPUT_PREVIEW_MAX_CHARACTERS),
    fullText: z.string().max(OUTPUT_PREVIEW_MAX_CHARACTERS),
    totalLines: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    linesEstimated: z.boolean(),
  })
  .strict();
export type ExecutionOutputPreview = z.infer<typeof executionOutputPreviewSchema>;
