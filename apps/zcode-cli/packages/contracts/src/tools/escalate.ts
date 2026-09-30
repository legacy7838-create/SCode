// ============================================================
// escalate Tool - actor escalates blocking issues to the master agent
// ============================================================
// Injects actor sessions completely isomorphically with `submit_result`
// (The port is registered when present, and is still filled in by core under `tools:"none"`), but the two settle different things:
// Submit settles **the result of this ask**, and escalate settles **a question and answer**.
//
// The output shape is deliberately "flat object with discriminant bits" rather than union: both are normal tool results (not errors),
// The model only reads a piece of text, and the discriminant bit `status` only serves logs and result projections.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const ESCALATE_TOOL_NAME = "escalate";

export const EscalateInputSchema = z
  .object({
    question: z
      .string()
      .min(1)
      .describe(
        "The single focused question that unblocks you. One question per call, answerable in a sentence.",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "What you already tried and where exactly you are stuck — the evidence the answerer needs.",
      ),
  })
  .strict();

export type EscalateInput = z.infer<typeof EscalateInputSchema>;

export const EscalateInputJsonSchema = toToolJsonSchema(EscalateInputSchema);

/**
 * The outcome of one escalation.
 *
 * - `answered`: `message` is the main agent's answer verbatim, and `qid` is the globally unique id of this Q&A.
 * - `refused`: `message` is the text stating the current situation and the next step (budget exhausted / no in-flight ask), and `reason` is the
 *   discriminator key. **This is not an error** — rendering "budget exhausted" as an error tool_result makes the model treat it as a retryable
 *   failure and bang on the same wall over and over, which is exactly the behaviour this feature exists to eliminate.
 */
export const EscalateOutputSchema = z
  .object({
    status: z.enum(["answered", "refused"]),
    message: z.string(),
    /** Only present for `answered`. */
    qid: z.string().optional(),
    /** Only present for `refused`. */
    reason: z.enum(["budget_exhausted", "no_active_ask"]).optional(),
  })
  .strict();

export type EscalateOutput = z.infer<typeof EscalateOutputSchema>;

export const EscalateOutputJsonSchema = toToolJsonSchema(EscalateOutputSchema);
