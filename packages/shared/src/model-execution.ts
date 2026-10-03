import { z } from "zod";

/** Text and attachment sending share the same execution constraints; credentials belong to a single execution only and never enter Session configuration. */
export const modelExecutionSchema = z
  .object({
    selectionScope: z.literal("execution"),
    requestAuth: z
      .object({
        apiKey: z.string().min(1).optional(),
        headers: z.record(z.string().min(1), z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    subagents: z
      .object({
        foregroundModel: z.literal("submission"),
        background: z.literal("deny"),
      })
      .strict()
      .optional(),
  })
  .strict();
