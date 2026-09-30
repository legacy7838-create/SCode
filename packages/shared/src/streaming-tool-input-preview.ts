export interface ZCodeStreamingToolInputState {
  deltaCount?: number;
  lastPreviewAt?: number;
  lastPreviewRawInputLength?: number;
  rawInput: string;
}

export interface ZCodeStreamingToolInputPreview {
  complete: boolean;
  input: unknown;
  rawInput: string;
}

export type ZCodeStreamingToolInputPreviewMode = "active-live" | "background-summary";

export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_EAGER_DELTA_COUNT = 1;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS = 750;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH = 8 * 1024;
export const ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS = 1_000;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_TIME_BUDGET_MAX_RAW_INPUT =
  ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH;

const PARTIAL_JSON_STRING_FIELD_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_path",
  "targetPath",
  "filename",
  "file",
  "content",
  "new_string",
  "newString",
  "new_text",
  "newText",
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "command",
  "description",
  "title",
  "pattern",
  "replacement",
  // The body of ExitPlanMode is in the plan field. After incorporating it into the half-JSON preview, the schedule card matches
  // The side details can be updated starting from the first streaming chunk, instead of waiting for input_end to appear suddenly.
  "plan",
  // CreateWorkflow script and name: Streaming Draft
  // To scan out the site while the model is still writing scripts, half of the script must be previewed from the first chunk.
  "name",
  "script",
] as const;

export function appendZCodeStreamingToolInputDelta(
  state: ZCodeStreamingToolInputState | undefined,
  delta: string,
): ZCodeStreamingToolInputState {
  return {
    ...state,
    deltaCount: (state?.deltaCount ?? 0) + 1,
    rawInput: `${state?.rawInput ?? ""}${delta}`,
  };
}

export function buildZCodeStreamingToolInputPreview(
  rawInput: string,
  completeInput?: unknown,
): ZCodeStreamingToolInputPreview {
  if (completeInput !== undefined) {
    return {
      complete: true,
      input: completeInput,
      rawInput,
    };
  }

  const parsed = parseCompleteJson(rawInput);
  if (parsed.ok) {
    return {
      complete: true,
      input: parsed.value,
      rawInput,
    };
  }

  return {
    complete: false,
    input: readPartialJsonObjectPreview(rawInput) ?? {},
    rawInput,
  };
}

export function shouldMaterializeZCodeStreamingToolInputPreview(
  state: ZCodeStreamingToolInputState,
  options: {
    mode?: ZCodeStreamingToolInputPreviewMode;
    now?: number;
    toolName?: string;
  } = {},
): boolean {
  if (options.mode === "background-summary") {
    return false;
  }
  const deltaCount = state.deltaCount ?? 0;
  if (deltaCount <= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_EAGER_DELTA_COUNT) {
    return true;
  }
  const lastPreviewAt = state.lastPreviewAt ?? 0;
  if (isZCodeFileStreamingToolInputPreviewTool(options.toolName)) {
    // Performance fix: Half-JSON in Write/Edit will trigger full content recovery and row-level diff.
    // Large-byte chunks cannot bypass the one-second window, otherwise the faster the model outputs, the more frequently the UI will be updated.
    return (
      (options.now ?? Date.now()) - lastPreviewAt >=
      ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
    );
  }
  const lastPreviewRawInputLength = state.lastPreviewRawInputLength ?? 0;
  const rawGrowth = state.rawInput.length - lastPreviewRawInputLength;
  if (rawGrowth >= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH) {
    return true;
  }
  const intervalElapsed =
    (options.now ?? Date.now()) - lastPreviewAt >=
    ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS;
  if (!intervalElapsed) {
    return false;
  }
  // Performance fix: Large Write/Edit parameters are often pushed by the provider in slow chunks around 4KB.
  // If only based on time budget, the active task will still parse the accumulated JSON for each chunk; after exceeding the small input range, it will be controlled by raw growth.
  return state.rawInput.length <= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_TIME_BUDGET_MAX_RAW_INPUT;
}

export function isZCodeFileStreamingToolInputPreviewTool(toolName?: string): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return normalized === "write" || normalized === "edit";
}

export function markZCodeStreamingToolInputPreviewMaterialized(
  state: ZCodeStreamingToolInputState,
  now = Date.now(),
): void {
  state.lastPreviewAt = now;
  state.lastPreviewRawInputLength = state.rawInput.length;
}

function parseCompleteJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function readPartialJsonObjectPreview(rawInput: string): Record<string, string> | null {
  const preview: Record<string, string> = {};
  for (const key of PARTIAL_JSON_STRING_FIELD_KEYS) {
    const value = readPartialJsonStringField(rawInput, key);
    if (value !== undefined) {
      preview[key] = value;
    }
  }
  return Object.keys(preview).length > 0 ? preview : null;
}

function readPartialJsonStringField(rawInput: string, key: string): string | undefined {
  const match = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`).exec(rawInput);
  if (!match) {
    return undefined;
  }

  let encoded = "";
  let escaped = false;
  let closed = false;
  for (let index = match.index + match[0].length; index < rawInput.length; index += 1) {
    const char = rawInput[index] ?? "";
    if (escaped) {
      encoded += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      closed = true;
      break;
    }
    encoded += char;
  }
  if (escaped) {
    encoded += "\\";
  }

  return decodeJsonStringSegment(encoded, closed);
}

function decodeJsonStringSegment(encoded: string, closed: boolean): string {
  const normalized = closed ? encoded : trimDanglingJsonEscape(encoded);
  try {
    return JSON.parse(`"${normalized}"`) as string;
  } catch {
    return decodeJsonStringSegmentBestEffort(normalized);
  }
}

function trimDanglingJsonEscape(value: string): string {
  return value.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
}

function decodeJsonStringSegmentBestEffort(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
