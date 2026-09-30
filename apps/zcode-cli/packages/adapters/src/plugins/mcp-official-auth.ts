/*
 * Strict parsing of `auth: { type: "zcode_official" }` in a plugin `.mcp.json`, plus provenance generation.
 *
 * Its own file rather than staying in mcp.ts: the official auth parsing rules cover both the http and stdio transports,
 * and are not coupled to template variable parsing or to transport field parsing -- putting them together would only keep mcp.ts bloating (it has already hit the max-lines limit).
 */
import type { McpOfficialProvenance, ZCodeOfficialMcpAuthConfig } from "@zcode/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strictly parse `auth`. An absent declaration returns undefined (the plain MCP path); a declared but structurally invalid one always throws,
 * with no lenient degradation -- degrading would silently ship a configuration that "looks like official auth is configured but actually issues anonymous requests".
 */
export function parseZCodeOfficialAuth(
  value: unknown,
  mcpKey: string,
): ZCodeOfficialMcpAuthConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`MCP server ${mcpKey}: auth must be an object`);
  }
  // Exact value matching is case-sensitive; aliases such as zcode-official and zcode_official_auth are rejected.
  if (value.type !== "zcode_official") {
    throw new Error(`MCP server ${mcpKey}: unsupported auth type: ${String(value.type)}`);
  }
  if (value.provider !== "jwt_token") {
    throw new Error(`MCP server ${mcpKey}: unsupported auth provider: ${String(value.provider)}`);
  }
  return { type: "zcode_official", provider: "jwt_token" };
}

/**
 * Host-generated runtime provenance. An `official` field written in `.mcp.json` is overwritten by it too --
 * an official identity must not be self-declared by the party under review.
 */
export function buildOfficialProvenance(identity: {
  mcpKey: string;
  pluginId: string;
}): McpOfficialProvenance {
  return { mcpKey: identity.mcpKey, pluginId: identity.pluginId, source: "plugin" };
}
