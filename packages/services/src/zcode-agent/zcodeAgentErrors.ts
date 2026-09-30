// The original -32602 copy comes from the old Agent schema, and the UI cannot rely on volatile string recognition capabilities after cross-RPC.
// ChannelClient will retain error.code, so use the stable code driver settings page to stop status-only polling.
export const ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE =
  "ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED";

export class ZCodeAgentMcpStatusModeUnsupportedError extends Error {
  readonly code = ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE;

  constructor() {
    super("The connected ZCode Agent does not support MCP status-only refresh");
    this.name = "ZCodeAgentMcpStatusModeUnsupportedError";
  }
}

export function isZCodeAgentMcpStatusModeUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE;
}
