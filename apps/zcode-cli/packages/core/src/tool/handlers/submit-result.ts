// ============================================================
// submit_result Tool Handler
// ============================================================
// The workflow actor (sub-AgentRuntime) uses it to submit the structured final result of this ask. handler hands the result to
// The injected WorkflowSubmitPort blocks waiting for engine decision:
//   - accept → returns successful output; the executor will hang the turnControl on the successful result to terminate this turn.
//   - reject → returns the list of violations as a ToolHandlerFailure; it becomes an error tool_result,
//     Without turnControl, the loop continues and the model retries within the same session - this is the repair channel.
// The specific per-ask schema is not included in the tool declaration, but is distributed with the epilogue of the ask command (frozen-tool cache
// Invariant); this handler only performs general transfer, and schema verification is completed by the engine on the port side.

import {
  CoreErrorType,
  SUBMIT_RESULT_TOOL_NAME,
  SubmitResultInputJsonSchema,
  SubmitResultInputSchema,
  SubmitResultOutputJsonSchema,
  SubmitResultOutputSchema,
  createCoreError,
  typedSubmitResultInputSchema,
  type JsonSchema,
  type SubmitResultInput,
  type SubmitResultOutput,
  type SubmitViolation,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";

const MAX_SUBMIT_RESULT_MODEL_BYTES = 16_000;

// The violation list of reject is normalized by this errorCode and falls into the code field of error tool_result.
const SUBMIT_RESULT_REJECTED_ERROR_CODE = 1;

const submitResultHandler: ToolHandler = async (input, context) => {
  const parsed = SubmitResultInputSchema.parse(input) as SubmitResultInput;

  // Gate: workflow actor session is injected into workflowSubmitPort. Not judged by runtimeScope——workflow
  // The actor is taskType "workflow_child" and its runtimeScope is currently "main"; the presence or absence of the port is
  // Correct criterion independent of taskType.
  if (!context.workflowSubmitPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Workflow submit port is not configured for submit_result",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: SUBMIT_RESULT_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const verdict = await context.workflowSubmitPort.respond({
    toolCallId: context.toolCallId,
    result: parsed.result,
    trace: resolveToolTraceContext(context),
  });

  if (verdict.accept) {
    return { status: "accepted" } satisfies SubmitResultOutput;
  }

  // Reject: Return as ToolHandlerFailure, call-runner will convert it into error tool_result,
  // Violation list survives as modelContent; do not hang turnControl, loop continues → model is repaired within the session and retried.
  return submitResultRejection(verdict.violations);
};

/**
 * The tool entry of submit_result. Without a schema = the generic declaration (`result` is arbitrary JSON, the
 * per-ask schema goes in the ask's trailing note); with a schema = the typed declaration of a dwf mono subagent
 * (`result` is that actor's only ask-result schema, frozen for that actor and unchanged across asks, so it does not
 * break the cache prefix), and it is marked with `strict` eligibility so the Anthropic adapter constrains it
 * natively. The two differ only in the provider-visible declaration and description: handler,
 * permissions, concurrency group, termination semantics and budget are byte-for-byte identical —
 * the engine-side validation is the same for both, and the typed declaration merely lets the provider see (and,
 * where supported, enforce) that shape too.
 */
export function createSubmitResultToolEntry(resultSchema?: JsonSchema): ToolEntry {
  const typed = resultSchema !== undefined;
  return {
    capability: "Submit the structured terminal result for a workflow subagent's ask",
    metadata: {
      name: SUBMIT_RESULT_TOOL_NAME,
      description: typed
        ? "Submit the structured result for the current ask. The `result` argument must match this tool's schema."
        : "Submit the structured result for the current ask. The required JSON shape is described in the ask instructions.",
      readOnly: false,
      destructive: false,
      // Payload properties: declare concurrentSafe:false, the scheduler will put it into an independent serial group. Such a valid submission
      // (Success means requesting to terminate the turn) When executed, sibling tools scheduled later than it will receive the existing synthesized ToolCancelled.
      // Finish before its predecessor - Termination semantics require no new mechanism.
      concurrentSafe: false,
      // Final state tool: A valid submission (engine accept) is successful and must end the actor's turn. Use declarative
      // The metadata expresses the intrinsic ability, and the executor's general withTerminalToolTurnStop is hung on the successful result accordingly.
      // turnControl, there is no need to hardcode the tool name when executing the click, and there is no need to add a stop signal channel on the handler side.
      stopTurnOnSuccess: true,
      maxOutputBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      sideEffectScope: "session",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: submitResultHandler,
    formatModelContent: formatSubmitResultModelContent,
    inputSchema: typed ? typedSubmitResultInputSchema(resultSchema) : SubmitResultInputJsonSchema,
    ...(typed ? { strict: true } : {}),
    outputSchema: SubmitResultOutputJsonSchema,
    // Runtime zod verifies that both are identical (result is arbitrary JSON): the per-ask shape is verified by the engine on the port side and fixable violations are given.
    runtimeInputSchema: SubmitResultInputSchema,
    runtimeOutputSchema: SubmitResultOutputSchema,
    permission: {
      permission: "workflow.submitResult",
      reason: "submit_result delivers the subagent's terminal result to the workflow engine",
      riskLevel: "low",
      sideEffectScope: "session",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      maxModelBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      strategy: "truncate",
      preview: {
        maxBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
        direction: "head",
      },
    },
    // Engine arbitration may take arbitrarily long; using kind:"none" does not set a wall clock timeout, and cancellation is handled by aborting the tool call (abort).
    timeout: {
      kind: "none",
    },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "submit_result was cancelled before the engine returned a verdict",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

/** The entry of the generic declaration (the one in the built-in tool table). */
export const submitResultToolEntry: ToolEntry = createSubmitResultToolEntry();

function submitResultRejection(violations: readonly SubmitViolation[]): ToolHandlerFailure {
  return {
    result: false,
    errorCode: SUBMIT_RESULT_REJECTED_ERROR_CODE,
    message: formatSubmitViolations(violations),
  };
}

// The violation format is consistent with the dynamic-workflow synthesis side: one line per line, `<path>: expected <expected>, got <got>`,
// It is convenient to compare and repair the model one by one.
function formatSubmitViolations(violations: readonly SubmitViolation[]): string {
  const header = "The submitted result does not match the required schema:";
  if (violations.length === 0) {
    return `${header}\n(no details provided)`;
  }
  const lines = violations.map(
    (violation) => `${violation.path}: expected ${violation.expected}, got ${violation.got}`,
  );
  return [header, ...lines].join("\n");
}

function formatSubmitResultModelContent(output: unknown): string {
  const parsed = SubmitResultOutputSchema.safeParse(output);
  if (!parsed.success) return "submit_result returned an invalid result.";
  return "The result was accepted.";
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
