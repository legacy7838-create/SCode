// ============================================================
// Tool call → a "target" clue for people to see
// ============================================================
// `lastTool.target` of `node-progress` answers "where is it moving": file tools give the path, Bash gives the command header,
// Search class for pattern. It is not an input parameter - the input parameter can hold an entire patch, a section of base64, and a file text, and this
// The event will be read into the context by the main agent and drawn on the card by the GUI, so only a bounded scalar key is taken, and the rest are treated as "unrecognized".
//
// Press the key name instead of the tool name: the tool name will change. The name of the MCP tool is not in our hands at all, but `file_path` / `command`
// These key names are established conventions for the input parameters of this warehouse tool (read/edit/write/bash/glob/grep schema of contracts).
// If you don't recognize it, you will be absent - synthesizing an "(unknown)" placeholder string will only make the reader think that it is the real target.

import {
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
  type AskLastTool,
} from "@zcode/dynamic-workflow";

/**
 * Argument keys probed in priority order. The first **non-empty string** that hits is the target; the path family keeps the tail (only the file name tells them apart),
 * the others keep the head (only the beginning of a command, pattern or url tells them apart).
 */
const TARGET_KEYS: readonly { key: string; keep: "head" | "tail" }[] = [
  { key: "file_path", keep: "tail" },
  { key: "notebook_path", keep: "tail" },
  { key: "path", keep: "tail" },
  { key: "command", keep: "head" },
  { key: "pattern", keep: "head" },
  { key: "url", keep: "head" },
  { key: "query", keep: "head" },
];

/** The ellipsis marker (prefixed when keeping the tail): a reader has to be able to see that this clue was cut short. */
const ELLIPSIS = "…";

/** A narrow view of one tool call: name + arguments. Either can be absent (old events, calls with an empty name). */
interface ToolCallSummaryInput {
  toolName?: string;
  input?: unknown;
}

/**
 * Compresses one tool call into `lastTool`. An absent name means the whole entry is absent — a "most recent tool" without a name says nothing.
 */
export function summarizeToolCall(call: ToolCallSummaryInput): AskLastTool | undefined {
  const name = typeof call.toolName === "string" ? call.toolName.trim() : "";
  if (name.length === 0) return undefined;
  const target = deriveToolTarget(call.input);
  return {
    name: name.slice(0, LAST_TOOL_NAME_MAX_CHARS),
    ...(target === undefined ? {} : { target }),
  };
}

/** Pulls the target clue out of the arguments; absent when it is not an object, has no known key, or the key is not a non-empty string. */
function deriveToolTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const { key, keep } of TARGET_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    // For multi-line commands, only the first line is taken and continuous whitespace is suppressed: the command header is "what is running", and the entire heredoc is not.
    const flattened = value.split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
    if (flattened.length === 0) continue;
    return bound(flattened, keep);
  }
  return undefined;
}

/** Truncates to {@link LAST_TOOL_TARGET_MAX_CHARS}: the head is cut directly, the tail is prefixed with an ellipsis and then cut. */
function bound(text: string, keep: "head" | "tail"): string {
  if (text.length <= LAST_TOOL_TARGET_MAX_CHARS) return text;
  if (keep === "head") return text.slice(0, LAST_TOOL_TARGET_MAX_CHARS);
  return ELLIPSIS + text.slice(text.length - (LAST_TOOL_TARGET_MAX_CHARS - ELLIPSIS.length));
}
