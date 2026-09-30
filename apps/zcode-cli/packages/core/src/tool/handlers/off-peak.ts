// ============================================================
// Off-Peak Tool Handlers
// ============================================================
// Alongside its cron.ts brethren. Key differences (don’t copy cron’s defense direction):
// - The deny boundary is the "idle time distribution round" (context.offPeakTurn), not the automation round——
//   cron automation automatically releases OffPeakCreate (scheduled idle time task).
// - Create joint judgment results: business failures such as quota (3103)/qualification (3101) are classified by the host and then maintained across protocols,
//   This translates to a stable CoreError, whereby the model relays actionable information to the user.

import {
  CoreErrorType,
  createCoreError,
  OffPeakCreateInputJsonSchema,
  OffPeakCreateInputSchema,
  OffPeakCreateOutputJsonSchema,
  OffPeakCreateOutputSchema,
  OffPeakListInputJsonSchema,
  OffPeakListInputSchema,
  OffPeakListOutputJsonSchema,
  OffPeakListOutputSchema,
  type OffPeakCreateInput,
  type OffPeakCreateOutcome,
  type OffPeakCreateOutput,
  type OffPeakListOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const OFF_PEAK_TOOL_TIMEOUT_MS = 30_000;
const OFF_PEAK_MODEL_BYTES = 32_000;

/**
 * The handler-level rejection for an off-peak dispatch turn (a second layer of defense beyond
 * the turn denylist). The provider denylist is only a visibility constraint; an anomalous
 * provider can still submit directly. The handler makes the final rejection using this turn's
 * facts as passed in by the executor. Note: it deliberately does not check automationTurn
 * (cron turns are allowed). SendMessage / Workflow reuse this function — they restart a
 * sub-agent outside this turn's modelExecution and land on the user's plan; on rejection,
 * give the model a recoverable alternative path to follow.
 */
export function assertNotOffPeakTurn(
  context: ToolExecutionContext,
  toolName: string,
  options?: { hint?: string; recoverable?: boolean },
): void {
  if (!context.offPeakTurn) return;
  const hint = options?.hint ? ` ${options.hint}` : "";
  throw createCoreError(
    CoreErrorType.PermissionDenied,
    `${toolName} is not allowed while running an idle-time task.${hint}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: options?.recoverable ?? false,
      retryable: false,
    },
  );
}

function assertOffPeakPort(
  context: ToolExecutionContext,
  toolName: "OffPeakCreate" | "OffPeakList",
): asserts context is ToolExecutionContext & {
  offPeakPort: NonNullable<ToolExecutionContext["offPeakPort"]>;
} {
  if (context.offPeakPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `OffPeakPort is not configured for ${toolName}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
    },
  );
}

/** Translate a business failure into a stable error the model can relay; the wording is driven by the category, and guessing from the message is forbidden. */
function throwOffPeakCreateFailure(
  context: ToolExecutionContext,
  outcome: Extract<OffPeakCreateOutcome, { ok: false }>,
): never {
  const detail = (() => {
    switch (outcome.errorCategory) {
      case "quota_3103":
        return "The idle-time task quota is used up for now. Tell the user the free quota is exhausted and they can retry later or review tasks in Automations.";
      case "eligibility_3101":
        return "The current account has no eligible Coding Plan connection for idle-time tasks. Tell the user to select a ZAI/BigModel Coding Plan connection first.";
      case "client_validation":
        if (outcome.errorCode === "model_not_allowed") {
          return "The requested model is not in the idle-time allowed model list. Omit the model field to use the default allowed model.";
        }
        if (outcome.errorCode === "session_bound") {
          return "This session already has a pending idle-time task. Tell the user to wait for it to finish or cancel it in Automations before creating another one here.";
        }
        if (outcome.errorCode === "offpeak_disabled") {
          return "Idle-time tasks are not enabled for this account right now. Tell the user the feature is unavailable; do not retry with different parameters.";
        }
        return "The idle-time task input was rejected by validation.";
      case "network":
        return "The idle-time ticket service is unreachable. Tell the user to retry later.";
      default:
        return "Creating the idle-time task failed. Tell the user to retry from the Automations page.";
    }
  })();
  throw createCoreError(CoreErrorType.ToolExecutionFailed, detail, {
    context: {
      toolCallId: context.toolCallId,
      toolName: "OffPeakCreate",
      failureStage: outcome.failureStage,
      errorCategory: outcome.errorCategory,
      errorCode: outcome.errorCode,
    },
    recoverable: false,
    retryable: false,
  });
}

const offPeakCreateHandler: ToolHandler = async (input, context) => {
  assertNotOffPeakTurn(context, "OffPeakCreate");
  const parsed = OffPeakCreateInputSchema.parse(input) as OffPeakCreateInput;
  assertOffPeakPort(context, "OffPeakCreate");

  const outcome = await context.offPeakPort.create(parsed, {
    // This session is the binding session of the idle task. When dispatching, resume the execution of this session (aligned with CronCreate targetTaskId).
    sessionId: context.sessionId,
  });
  if (!outcome.ok) {
    throwOffPeakCreateFailure(context, outcome);
  }
  return {
    task: outcome.task,
    message:
      typeof outcome.task.queuePosition === "number"
        ? `Created idle-time task ${outcome.task.offPeakTaskId} (#${outcome.task.queuePosition} in queue).`
        : `Created idle-time task ${outcome.task.offPeakTaskId}.`,
  } satisfies OffPeakCreateOutput;
};

const offPeakListHandler: ToolHandler = async (input, context) => {
  OffPeakListInputSchema.parse(input);
  assertOffPeakPort(context, "OffPeakList");

  const tasks = await context.offPeakPort.list();
  return { tasks } satisfies OffPeakListOutput;
};

function offPeakPermission(
  permission: string,
  reason: string,
  needsApproval: boolean,
): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: "medium" as const,
    sideEffectScope: "workspace" as const,
    needsApproval,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: needsApproval ? undefined : ["toolName"],
    denyPriority: "beforeAsk" as const,
  };
}

const offPeakResultBudget = {
  maxInlineBytes: OFF_PEAK_MODEL_BYTES,
  maxModelBytes: OFF_PEAK_MODEL_BYTES,
  strategy: "truncate" as const,
  preview: {
    maxBytes: OFF_PEAK_MODEL_BYTES,
    direction: "head" as const,
  },
};

const offPeakTimeout = {
  defaultMs: OFF_PEAK_TOOL_TIMEOUT_MS,
  maxMs: OFF_PEAK_TOOL_TIMEOUT_MS,
  allowCallOverride: false,
};

export const offPeakCreateToolEntry: ToolEntry = {
  capability: "Create an idle-time task queued for free off-peak execution",
  metadata: {
    name: "OffPeakCreate",
    description:
      "Create a one-off idle-time task in the current workspace: it takes a queue ticket immediately and later runs unattended in THIS session (with the full conversation history) when the server grants off-peak compute, at no plan-quota cost. There is no guaranteed start time. Unlike CronCreate (recurring or clock-scheduled work), use this for deferrable work the user wants done cheaply 'when compute is idle'. The prompt must describe the final work directly and must never ask the run to create, schedule, or configure another idle-time task or automation.",
    modelInstructions: [
      "Use this only when the user explicitly asks for idle-time/off-peak execution, or explicitly accepts deferring the work to the free idle-time queue.",
      "Choose CronCreate instead for anything time-scheduled or recurring ('every day at 9', 'in 10 minutes'). OffPeakCreate has no clock: the server decides when the task starts.",
      "The task later continues THIS conversation unattended with the full history available, so prompt may refer to context already established here; still state the expected deliverable explicitly because nobody will answer questions during the run.",
      "By default the task runs in full-automatic mode with the default allowed model at the highest reasoning level. Only set permissionMode/model/thoughtLevel when the user explicitly asks for confirmation-gated execution, a specific model, or a lower reasoning effort.",
      "Do not include workspace paths or identities in the input; the current session workspace is used.",
      "Keep title concise and task-descriptive without file paths.",
      "Creation consumes a limited free take-number quota. If creation fails with a quota error, relay the limit to the user instead of retrying.",
      "After a successful creation, reply with only a brief confirmation; the UI renders a task card with a link to the Automations page for edits.",
      "Never call OffPeakCreate from within an idle-time task run, and never write a prompt asking the run to create more idle-time tasks or automations.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: OFF_PEAK_TOOL_TIMEOUT_MS,
    maxOutputBytes: OFF_PEAK_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: offPeakCreateHandler,
  inputSchema: OffPeakCreateInputJsonSchema,
  outputSchema: OffPeakCreateOutputJsonSchema,
  runtimeInputSchema: OffPeakCreateInputSchema,
  runtimeOutputSchema: OffPeakCreateOutputSchema,
  permission: offPeakPermission(
    "offpeak.create",
    "OffPeakCreate queues an unattended idle-time task and consumes a free take-number quota",
    true,
  ),
  resultBudget: offPeakResultBudget,
  timeout: offPeakTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "OffPeakCreate was cancelled before the idle-time task was created",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const offPeakListToolEntry: ToolEntry = {
  capability: "List idle-time tasks for the current workspace",
  metadata: {
    name: "OffPeakList",
    description:
      "List idle-time tasks in the current workspace with status and queue position. Read-only.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: OFF_PEAK_TOOL_TIMEOUT_MS,
    maxOutputBytes: OFF_PEAK_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: offPeakListHandler,
  inputSchema: OffPeakListInputJsonSchema,
  outputSchema: OffPeakListOutputJsonSchema,
  runtimeInputSchema: OffPeakListInputSchema,
  runtimeOutputSchema: OffPeakListOutputSchema,
  permission: {
    permission: "offpeak.read",
    reason: "OffPeakList only reads idle-time tasks for this workspace",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: offPeakResultBudget,
  timeout: offPeakTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "OffPeakList was cancelled before idle-time tasks were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
