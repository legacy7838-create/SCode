/* The structured identifier the official Server MCP emits when a tool call is blocked or fails.
 *
 * The server renders it as **the JSON text of the tool error content** (not `_meta`):
 * `{"error_code":"quota_exceeded","message":"...","request_id":"..."}`
 * See `ToolError.Error()` in zcode-server `internal/domain/servermcp/toolerror.go`.
 *
 * It lives in shared because three consumers in three different packages need it:
 * - `apps/zcode-cli/packages/core`: parses MCP results and carries the code into the tool result display;
 * - `packages/shared/src/zcode-protocol-v4/rows.ts`: the row schema validates that code;
 * - `packages/ui`: decides the copy and the action of the notice above the input box from the code.
 * All three must share one source, otherwise a newly added code is recognised on one side and
 * silently dropped on the other.
 */

/**
 * Codes the client uses to change interface behaviour.
 *
 * The server also has `internal_error`, **deliberately not listed here**: it is the catch-all
 * mask for "every other failure" (the details stay in the server logs only); users cannot fix
 * them on their own, so it should not raise a notice.
 */
export const OFFICIAL_MCP_TOOL_ERROR_CODES = ["quota_exceeded", "coding_plan_required"] as const;

export type OfficialMcpToolErrorCode = (typeof OFFICIAL_MCP_TOOL_ERROR_CODES)[number];

const OFFICIAL_MCP_TOOL_ERROR_CODE_SET = new Set<string>(OFFICIAL_MCP_TOOL_ERROR_CODES);

export interface OfficialMcpToolError {
  code: OfficialMcpToolErrorCode;
  /** Human-readable English copy supplied by the server; logs and troubleshooting only, UI copy goes through i18n. */
  message?: string;
  /** Server request id, so it can be reconciled against the backend logs. */
  requestId?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parses the structured identifier out of the tool error text.
 *
 * Strict parsing: it must be a JSON object whose `error_code` hits a known code, otherwise
 * undefined is returned. There is no text-matching fallback — that would let a single
 * reworded sentence on the server break it silently.
 */
export function parseOfficialMcpToolError(text: string): OfficialMcpToolError | undefined {
  const trimmed = text.trim();
  // First, quickly exclude most common error texts by the first character to avoid entering JSON.parse every time it fails.
  if (!trimmed.startsWith("{")) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;

  const record = payload as Record<string, unknown>;
  const code = readString(record.error_code);
  if (!code || !OFFICIAL_MCP_TOOL_ERROR_CODE_SET.has(code)) return undefined;

  const message = readString(record.message);
  const requestId = readString(record.request_id);
  return {
    code: code as OfficialMcpToolErrorCode,
    ...(message ? { message } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
