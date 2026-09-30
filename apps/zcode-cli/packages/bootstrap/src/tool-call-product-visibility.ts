const EMPTY_TOOL_NAME_PLACEHOLDER = "empty_tool_name";

/**
 * Empty-tool-name recovery serves only the model continuation and should not materialize as a user-visible
 * tool row.
 * The fixed placeholder string can also be a legitimate tool name coming from a registry / MCP / alias, so it
 * cannot by itself justify hiding.
 * live only recognizes the original empty name; cold/legacy additionally require the placeholder name and the
 * persisted original-name metadata to be present together.
 */
export function shouldHideInvalidToolCallFromProduct(
  toolName: unknown,
  metadata?: Record<string, unknown>,
): boolean {
  if (typeof toolName !== "string") return false;
  if (toolName.trim().length === 0) return true;

  const providerToolName = metadata?.providerToolName;
  return (
    toolName === EMPTY_TOOL_NAME_PLACEHOLDER &&
    providerToolName !== undefined &&
    typeof providerToolName === "string" &&
    providerToolName.trim().length === 0
  );
}
