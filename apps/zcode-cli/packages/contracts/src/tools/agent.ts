// ============================================================
// Agent Tool - Subagent orchestration tool
// ============================================================
// Supports configuration-based subagents and asynchronous startup.

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import type { ModelUsage } from "../model/index.js";
import { toToolJsonSchema } from "./json-schema.js";

export const AgentType = {
  GeneralPurpose: "general-purpose",
  Explore: "Explore",
} as const;

export type AgentType = string;

export const AgentInputSchema = z.object({
  description: z.string().describe("A short (3-5 word) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .optional()
    .describe("The type of specialized agent to use for this task"),
  // The subagent model is determined by Settings / Markdown profile; if the call level
  // The model is exposed to the parent model, and historical tool calls will continue to generate old overrides and overwrite the current configuration.
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Set to true to run this agent in the background. You will be notified when it completes.",
    ),
});

export type AgentInput = z.infer<typeof AgentInputSchema>;

export const AgentInputJsonSchema = toToolJsonSchema(AgentInputSchema);

export interface AgentTextContentBlock {
  type: "text";
  text: string;
}

export interface AgentCompletedOutput {
  status: "completed";
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  content: AgentTextContentBlock[];
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
  /**
   * Structured result of a yield-enabled subagent. Absent for legacy agents,
   * whose parent-facing output stays byte-identical.
   */
  structured?: AgentStructuredResult;
}

export interface AgentBackgroundedOutput {
  status: "async_launched";
  isAsync: true;
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  childSessionId: string;
  backgroundTaskId: string;
  outputFile: string;
  canReadOutputFile: boolean;
}

export type AgentOutput = AgentCompletedOutput | AgentBackgroundedOutput;

export const AgentTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

/**
 * Structured result of a yield-enabled subagent.
 * `ok:false` means the child violated its outputSchema (or never yielded); the
 * failure is reported to the parent instead of being downgraded to raw text.
 */
export const AgentStructuredResultSchema = z
  .object({
    ok: z.boolean(),
    data: z.unknown().optional(),
    warnings: z.array(z.string()).optional(),
    issues: z.array(z.string()).optional(),
  })
  .strict();
export type AgentStructuredResult = z.infer<typeof AgentStructuredResultSchema>;

export const AgentCompletedOutputSchema = z
  .object({
    status: z.literal("completed"),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    content: z.array(AgentTextContentBlockSchema),
    totalToolUseCount: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
    usage: z.record(z.unknown()).optional(),
    /** Absent for legacy (non-yield) agents; their output stays byte-identical. */
    structured: AgentStructuredResultSchema.optional(),
  })
  .strict();

export const AgentBackgroundedOutputSchema = z
  .object({
    status: z.literal("async_launched"),
    isAsync: z.literal(true),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    childSessionId: z.string(),
    backgroundTaskId: z.string(),
    outputFile: z.string(),
    canReadOutputFile: z.boolean(),
  })
  .strict();

export const AgentOutputSchema = z.union([
  AgentCompletedOutputSchema,
  AgentBackgroundedOutputSchema,
]);

export const AgentOutputJsonSchema = toToolJsonSchema(AgentOutputSchema);

export interface AgentToolCall {
  id: ToolCallId;
  name: "Agent";
  input: AgentInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface AgentToolResult {
  toolCallId: ToolCallId;
  output: AgentOutput;
  traceId: TraceId;
  durationMs: number;
}

export const AgentErrorCode = {
  SUBAGENT_UNAVAILABLE: "agent_subagent_unavailable",
  BACKGROUND_UNAVAILABLE: "agent_background_unavailable",
  UNKNOWN_AGENT_TYPE: "agent_unknown_type",
  CHILD_RUNTIME_FAILED: "agent_child_runtime_failed",
} as const;

export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];
