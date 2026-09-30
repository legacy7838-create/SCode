// v4 ToolCallRow → Old ToolCallBlocks input form (TaskChatToolCallTreeNode) adaptation.
// Pure functions: ToolCallBlock and its renderers (execute/read/edit/...) eat the old ZCode Agent
// TaskChatToolCall form; v4 row is self-contained, fields can be mapped one by one, and there is no need to look at other rows.
import { buildZCodeStreamingToolInputPreview } from "@zcode/shared";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { normalizeWrappedErrorText } from "@/lib/toolError.js";

// v4 status → old ChatToolCall.status (input vocabulary for mapToolStatus:
// pending/in_progress/completed/failed/stopped).
// pendingApproval is regarded as pending: the input in the approval has been determined and is displayed as pending execution.
const STATUS_MAP: Record<ToolCallRow["status"], string> = {
  inputStreaming: "pending",
  pendingApproval: "pending",
  running: "in_progress",
  success: "completed",
  error: "failed",
  cancelled: "stopped",
};

interface ResolvedToolInputPreview {
  input: unknown;
  inputPreviewComplete?: boolean;
  streamingRawInputLength?: number;
}

function isEmptyPlainRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** When input is absent, use v4 inputText to restore the full or streaming half tool parameter preview. */
function resolveToolInputPreview(row: ToolCallRow): ResolvedToolInputPreview {
  if (row.input !== undefined) {
    return {
      input: row.input,
      inputPreviewComplete: true,
      ...(row.inputText.length > 0 ? { streamingRawInputLength: row.inputText.length } : {}),
    };
  }
  if (!row.inputText) {
    return { input: undefined };
  }
  const preview = buildZCodeStreamingToolInputPreview(row.inputText);
  return {
    input: isEmptyPlainRecord(preview.input) ? undefined : preview.input,
    inputPreviewComplete: preview.complete,
    streamingRawInputLength: row.inputText.length,
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveV4ToolErrorText(row: ToolCallRow): string | undefined {
  if (row.status !== "error") {
    return undefined;
  }

  const directMessage = readNonEmptyString(row.error?.message);
  if (directMessage) {
    return directMessage;
  }

  const outputText = readNonEmptyString(row.output?.text);
  if (outputText) {
    return normalizeWrappedErrorText(outputText);
  }

  return readNonEmptyString(row.error?.code);
}

export function toolCallRowToLegacyNode(row: ToolCallRow): TaskChatToolCallTreeNode {
  const legacyStatus = STATUS_MAP[row.status];
  const errorText = resolveV4ToolErrorText(row);
  const inputPreview = resolveToolInputPreview(row);
  // Structured display facts like CUA are in output.display; the top-level display is just the old Node REPL image pass.
  // Prioritize reading canonical output while retaining compatible paths for old snapshots and Browser tail screenshots.
  const display = row.output?.display ?? row.display;
  // CUA v1 history display saves input repeatedly; tool call line already holds unique input, discards old copy when bridging.
  const legacyDisplay =
    display?.kind === "cua" ? (({ input: _legacyInput, ...rest }) => rest)(display) : display;
  return {
    toolCall: {
      toolId: row.toolCallId,
      toolName: row.toolName,
      // kind is compatible with the old aggregation classification: there is no old ZCode Agent snapshot form under v4, and the fixed tool name is used directly.
      kind: row.toolName,
      input: inputPreview.input,
      status: legacyStatus,
      output: row.output?.text,
      // V4 ToolCallRow does not have legacy taskNotification raw; background Agent
      // The final state summary only falls on output. Agent renderer reads content to display activity results, so in
      // Agent/Task lines are explicitly bridged to avoid failure details being projected but still showing an empty card.
      ...((row.toolName === "Agent" || row.toolName === "Task") && row.output?.text
        ? { content: row.output.text }
        : {}),
      // v4 row is a self-contained projection. Some providers only insert the tool failure text into the output.
      // Failure to compensate for legacy errors will prevent ToolOutput from seeing the cause of failure, leaving only an empty failed summary.
      error: errorText,
      raw: {
        error: row.error,
        rawOutput: row.output?.text,
        outputPreview: row.outputPreview,
        outputTruncated: row.output?.truncated,
        status: legacyStatus,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        v4Status: row.status,
        ...(row.cuaApp ? { cuaApp: row.cuaApp } : {}),
        ...(legacyDisplay ? { display: legacyDisplay } : {}),
        inputPreviewComplete: inputPreview.inputPreviewComplete,
        streamingRawInputLength: inputPreview.streamingRawInputLength,
      },
      startedAt: typeof row.startedAt === "number" ? row.startedAt : undefined,
    },
    // subagent does not embed child rows; v4 tool rows do not have subtrees, and nested tools do not work in the old form.
    // Expressed by independent row (subagent/toolCall).
    childToolCalls: [],
  };
}
