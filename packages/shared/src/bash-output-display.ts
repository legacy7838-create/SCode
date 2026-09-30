import { z } from "zod";

// Bash raw files are not passed into the protocol; only bounded headers and true truncation/file-preserving facts are passed.
export const bashOutputDisplaySchema = z
  .object({
    kind: z.literal("bash_output"),
    output: z.string().max(150_000),
    truncated: z.boolean(),
    outputPath: z.string().min(1).max(32_768).optional(),
  })
  .strict();
