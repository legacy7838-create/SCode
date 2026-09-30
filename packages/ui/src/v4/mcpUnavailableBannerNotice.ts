import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { OfficialMcpToolErrorCode } from "@zcode/shared";

/**
 * The fact that the official Server MCP was judged unavailable in this session (quota exhausted /
 * no Coding Plan).
 *
 * The fact comes from `display.unavailable` on the tool row — the CLI side only fills it for
 * official MCP results that are isError, so there is no need to re-check the source here.
 */
export interface McpUnavailableNotice {
  code: OfficialMcpToolErrorCode;
  serverName: string;
  toolName: string;
  /** Deduplicated: one call is announced only once, a new failing call announces again. */
  rowId: number;
}

function readMcpToolCallRow(row: ConversationRow): ToolCallRow | null {
  return row.kind === "toolCall" ? row : null;
}

/**
 * Takes the most recent official MCP tool call inside the window that carries the unavailable flag.
 *
 * Taking the "most recent" rather than the "first": within one session it may first hit the quota
 * and later, on another connection, hit the entitlement again, so the notice has to follow the most
 * recent fact. Note that rows is a window view — after scrolling far away the old flag leaves the
 * window and the notice disappears with it; a call that just happened is always inside the window,
 * which is an acceptable trade-off.
 */
export function resolveMcpUnavailableNotice(
  rows: readonly ConversationRow[] | undefined,
): McpUnavailableNotice | null {
  if (!rows || rows.length === 0) return null;
  const seenTools = new Set<string>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    const toolCallRow = readMcpToolCallRow(row);
    if (!toolCallRow) continue;
    const display = toolCallRow.display;
    if (display?.kind !== "mcp_tool") continue;
    const toolKey = `${display.serverName}\u0000${display.toolName}`;
    if (seenTools.has(toolKey)) continue;
    seenTools.add(toolKey);
    // Latest success facts for the same tool overwrite old failures; continue looking for failures from other tools that have not yet been successfully covered.
    if (!display.unavailable) continue;
    return {
      code: display.unavailable.code,
      rowId: toolCallRow.rowId,
      serverName: display.serverName,
      toolName: display.toolName,
    };
  }
  return null;
}
