// ============================================================
// Yield tool: the child-side structured-result writer
// ============================================================
//
// State owner: the retry counter lives in this tool instance, which is created
// per spawned subagent (see runtime/methods/subagent.ts). The tool is
// registered only into yield-enabled child runtimes, so a parent session never
// sees this tool in its own tool list.
//
// Retry semantics (matches the omp contract): a schema violation is a *retryable*
// error thrown back to the model, which is ZCode's existing "tell the model to
// fix it" mechanism. After MAX_SCHEMA_RETRIES consecutive violations the tool
// accepts with an override instead of looping forever: the contract must not be
// able to wedge a subagent run, and the override is surfaced to the parent as
// SUBAGENT_YIELD_SCHEMA_OVERRIDDEN rather than being hidden.

import type { JsonSchema } from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolMetadata } from "../types.js";
import { validateJsonSchemaValue } from "../json-schema.js";
import {
  SUBAGENT_WARNING_SCHEMA_OVERRIDDEN,
  mergeYieldData,
} from "../../subagent/finalize-yield.js";

export const YIELD_TOOL_NAME = "Yield";
const MAX_SCHEMA_RETRIES = 3;

/**
 * Ceiling on the yields one subagent run may accumulate. A child that yields
 * hundreds of times gets its later items dropped rather than growing the
 * parent's memory, and its parent-facing JSON, without bound.
 */
export const MAX_CHILD_YIELD_ITEMS = 64;

/**
 * Prompt segment appended to yield-enabled subagents only. It states the
 * contract without restating the schema (the schema is already enforced by the
 * tool and echoed back on every rejection).
 */
export const YIELD_AGENT_PROMPT = [
  "## Structured result",
  "",
  "Your result for this task must be reported with the Yield tool.",
  "",
  "- Call Yield once at the end with `data` matching your required output schema.",
  "- Call it again to append to array-typed sections while you keep working.",
  "- A rejected payload comes back with the schema errors; fix it and call Yield again.",
  "- Do not write the structured result as prose: prose is not read by your caller.",
].join("\n");

interface YieldToolInput {
  /** The structured payload. Must satisfy the agent profile's outputSchema. */
  readonly data: unknown;
  /** Optional human-readable note; not part of the contract payload. */
  readonly note?: string;
}

const YieldToolInputJsonSchema = {
  type: "object",
  properties: {
    data: { type: "object", description: "Structured result matching the required output schema." },
    note: { type: "string", description: "Optional short note about this yield." },
  },
  required: ["data"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const YIELD_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    overridden: { type: "boolean" },
    warning: { type: "string" },
    issues: { type: "array", items: { type: "string" } },
  },
  required: ["success", "overridden"],
  additionalProperties: false,
} as const;

const MAX_YIELD_MODEL_BYTES = 2_000;

const YIELD_TOOL_METADATA: ToolMetadata = {
  name: YIELD_TOOL_NAME,
  description: [
    "Report your structured result for this task.",
    "Call this exactly once at the end, with `data` matching the required output schema.",
    "Call it again to append to array-typed sections while the task is still running.",
    "Do not write the result as prose text: this tool is the only channel that carries it back.",
  ].join(" "),
  readOnly: false,
  // Yielding is not a side effect: it only records the child's own result.
  // Without this, plan-enabled children are denied on every call
  // (permission `mode.plan.nonReadOnly`) and the contract can never be
  // satisfied there. Same reason respond-to-coordinator.ts sets it.
  allowedInPlanMode: true,
  destructive: false,
  concurrentSafe: false,
  timeoutMs: 10_000,
  sideEffectScope: "session",
  riskLevel: "low",
  needsApproval: false,
};

interface YieldCollector {
  /** Called once per accepted yield, in call order. */
  readonly record: (item: { data: unknown; attempts: number }) => void;
}

interface YieldToolDeps {
  readonly schema: JsonSchema | undefined;
  readonly collector: YieldCollector;
}

/**
 * Build the per-subagent Yield tool. The returned handler closes over the retry
 * counter, so two concurrent subagents never share retry state.
 */
export function createYieldTool(deps: YieldToolDeps): ToolEntry {
  let consecutiveSchemaFailures = 0;
  // Sections accumulate across calls, so required keys may arrive in a later
  // call. Validation therefore runs against the CUMULATIVE payload, not the
  // single call's fragment — this is the same merge finalizeSubagentYield uses.
  let merged: Record<string, unknown> = {};

  const handler: ToolHandler = async (input) => {
    const { data } = (input ?? {}) as YieldToolInput;

    const candidate = mergeYieldData([merged, data]);
    const validation = validateJsonSchemaValue(candidate, deps.schema);
    if (!validation.valid) {
      consecutiveSchemaFailures += 1;
      if (consecutiveSchemaFailures <= MAX_SCHEMA_RETRIES) {
        // Retryable: the model sees the issues and can fix its payload.
        throw new Error(
          `Yield rejected: ${validation.errors.join("; ")}. ` +
            `Fix the payload to match the schema and call ${YIELD_TOOL_NAME} again ` +
            `(${consecutiveSchemaFailures}/${MAX_SCHEMA_RETRIES}).`,
        );
      }
      // Budget exhausted: accept with an override so the run can still finish.
      // finalizeSubagentYield re-validates the merged data and reports the
      // failure loudly if it is still wrong.
      //
      // The counter resets here on purpose. Leaving it spent would force-accept
      // every LATER yield for the rest of the run with zero feedback to the
      // model, which silently kills the correction channel exactly when the
      // child is still trying to get it right.
      consecutiveSchemaFailures = 0;
      // Deliberately NOT merged into the validation accumulator. An override
      // means this payload is already known-bad; folding it in would poison the
      // cumulative check (with `additionalProperties:false` one bad key makes
      // every LATER, correct yield fail too) and would kill the correction
      // channel for the rest of the run. The finalizer still re-validates
      // everything recorded, so nothing is laundered by this.
      deps.collector.record({
        data,
        attempts: MAX_SCHEMA_RETRIES,
      });
      return {
        success: true,
        overridden: true,
        warning: SUBAGENT_WARNING_SCHEMA_OVERRIDDEN,
        issues: validation.errors,
      };
    }

    // A valid payload resets the budget: the model fixed it.
    consecutiveSchemaFailures = 0;
    merged = mergeYieldData([candidate]) as Record<string, unknown>;
    deps.collector.record({ data, attempts: 0 });
    return { success: true, overridden: false };
  };

  return {
    capability: "Report a structured result matching the agent's output schema",
    metadata: YIELD_TOOL_METADATA,
    handler,
    inputSchema: YieldToolInputJsonSchema,
    outputSchema: YIELD_TOOL_OUTPUT_SCHEMA,
    permission: {
      permission: "agent.yield.report",
      reason: "Yield records the subagent's structured result",
      riskLevel: "low",
      sideEffectScope: "session",
      needsApproval: false,
      patternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: MAX_YIELD_MODEL_BYTES,
      maxModelBytes: MAX_YIELD_MODEL_BYTES,
      strategy: "truncate",
      preview: { maxBytes: MAX_YIELD_MODEL_BYTES, direction: "head" },
    },
    timeout: { defaultMs: 10_000, maxMs: 10_000, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "Yield was cancelled before the structured result was recorded",
    },
    trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
  };
}
