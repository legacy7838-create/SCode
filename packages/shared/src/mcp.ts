/**
 * MCP (Model Context Protocol) types for ZCode
 * Based on the original Tauri implementation
 */

import type { SettingsDirectoryLocation } from "./settings-source.js";
import type { McpServerFailureKind } from "./zcode-protocol/index.js";

// CUA official plugin identity constant (port since feat; UI settings panel + bootstrap reuse to avoid literal drift).
export const ZCODE_CUA_OFFICIAL_PLUGIN_ID = "computer-use@zcode-plugins-official";
// CUA server identity string (port from feat mcp.ts): server key = model visible tool prefix segment (deliberately without zcode-);
// namespace name = official plugin runtime namespace plugin:<pluginId>:<serverKey>.
export const ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME = "plugin:computer-use:computer-use";
// Plug-in identity env key: resolver (adapters/src/plugins/mcp.ts) authoritatively writes loaded.id, manifest/user env cannot be overwritten.
// bootstrap + cli/plugin-host-command.ts reuses this constant to identify the official zcode-cua plugin server to avoid literal drift.
export const ZCODE_PLUGIN_ID_ENV_KEY = "ZCODE_PLUGIN_ID";

export type McpSource = "mcp" | "zcodeagentmcp";
export type CliMcpSource = Exclude<McpSource, "mcp">;
export type McpScope = "common" | "user" | "workspace";
export type McpFileFormat = "json";

// Single MCP server configuration
export interface McpServerConfig {
  type?: string; // Supports stdio, http, sse, streamableHttp, etc.
  url?: string; // HTTP/SSE server URL
  command?: string; // stdio server command
  args?: string[]; // stdio server arguments
  env?: Record<string, string>; // stdio server environment variables
  headers?: Record<string, string>; // HTTP/SSE server request headers
  http_headers?: Record<string, string>; // Compatible with old configuration fields, the historical BigModel MCP configuration will write the authentication header here
  oauth?: McpOAuthConfig; // HTTP/SSE OAuth machine credentials configuration
  // Linear specific fields
  apiKey?: string;
  projectId?: string;
  issueType?: string;
  // Figma specific fields
  personalAccessToken?: string;
  fileId?: string;
  nodeId?: string;
  // Sentry specific fields
  organizationName?: string;
  projectName?: string;
  dsn?: string;
  // Context7 specific fields
  apiEndpoint?: string;
  [key: string]: any;
}

export type McpServerStatus = "connected" | "disconnected" | "error" | "connecting" | "unknown";

export interface CliMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
  projects: Record<string, Record<string, McpServerConfig>>;
}

export interface SaveCliMcpToUserDirectoryRequest {
  action: "upsert" | "delete" | "set-enabled";
  source: CliMcpSource;
  name: string;
  config?: McpServerConfig;
  enabled?: boolean;
  projectPath?: string;
  location?: SettingsDirectoryLocation;
}

export interface NativeMcpFileReference {
  format: McpFileFormat;
  filePath: string;
}

export interface NativeMcpServerRecord {
  source: McpSource;
  scope: McpScope;
  name: string;
  config: McpServerConfig;
  enabled?: boolean;
  projectPath?: string;
  location?: SettingsDirectoryLocation;
  file?: NativeMcpFileReference;
}

export interface LoadCliMcpFromUserDirectoryRequest {
  workspacePath?: string;
}

export interface LoadCliMcpFromUserDirectoryResult {
  servers: NativeMcpServerRecord[];
}

export interface MigrateLegacyCommonMcpRequest {
  legacyStorageDir?: string;
}

export interface MigrateLegacyCommonMcpResult {
  servers: Record<string, McpServerConfig>;
  sourcePath?: string;
  /** Total number of MCP configs found in the legacy data */
  totalCount: number;
  /** Number successfully imported */
  importedCount: number;
  /** Number skipped because they already existed */
  skippedCount: number;
}

export interface McpConfig {
  mcp: {
    mcpServers: Record<string, McpServerConfig>;
  };
  zcodeagentmcp: CliMcpConfig;
}

export interface ZCodeMcpServer {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  changed?: boolean;
  status?: McpServerStatus;
  lastConnected?: Date;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  toolCount?: number;
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
  source: McpSource;
  projectPath?: string;
  scope: McpScope;
  location?: SettingsDirectoryLocation;
  file?: NativeMcpFileReference;
}

export interface McpServerListItem {
  id: string;
  name: string;
  enabled: boolean;
  status: McpServerStatus;
  hasConfig: boolean;
  error?: string;
  toolCount?: number;
  source: McpSource;
  projectPath?: string;
  scope: McpScope;
  file?: NativeMcpFileReference;
}

export interface McpTestResult {
  success: boolean;
  error?: string;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: any;
  }>;
  serverInfo?: {
    name: string;
    version: string;
  };
  response_time?: number;
}

export type ZCodeAgentMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
      isolation?: "session" | "workspace";
      protocolVersion?: "legacy" | "auto" | "2026-07-28";
      timeoutMs?: number;
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      isolation?: "session" | "workspace";
      protocolVersion?: "legacy" | "auto" | "2026-07-28";
      headers: Array<{ name: string; value: string }>;
      oauth?: McpOAuthConfig;
      timeoutMs?: number;
    };

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

export function getMcpServerRequestHeaders(
  config: McpServerConfig,
): Record<string, string> | undefined {
  return config.headers ?? config.http_headers;
}

// Single source of truth identified by zcode-cua MCP server. desktop product broker resolver (@zcode/services
// The two injection entrances, mcpBrokerInjection) and CLI bootstrap (mcp-config of apps/zcode-cli), must be used
// Completely consistent determination; otherwise the same MCP configuration behaves differently at different entrances, which may miss the injection into the product broker, causing
// Python/uvx itself holds macOS TCC permissions (violating the fail-closed boundary). Changing this means changing two links at the same time.
function zcodeCuaArgLeaf(value: string): string {
  // First remove the trailing path separator and then take the leaf: `.../zcode-cua/`. If you split directly, you will get an empty string of leaves → missing judgment → fail-open.
  return (
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? value
  );
}

// Whether a single candidate string is the package specification of zcode-cua. PyPI treats `_`/`-` as equivalent, so first normalize the underscores to dashes (zcode_cua →
// zcode-cua); covers uv/npm’s `@version`, pip’s `==version`, extras `[...]`, git’s `.git`/`.git@`,
// And `python -m zcode_cua.server` such dotted submodule (`zcode-cua.<submodule>`). fail-closed boundary rather
// There will be no misjudgment or misjudgment of `zcode-cua-proxy` (short horizontal continuation, not `.`/`@`/`[`/`==` boundary).
function matchesZCodeCuaSpec(candidate: string): boolean {
  const c = candidate.replace(/_/g, "-");
  return (
    c === "zcode-cua" ||
    c.startsWith("zcode-cua[") ||
    c.startsWith("zcode-cua@") ||
    c.startsWith("zcode-cua==") ||
    // The `.` branch also covers python submodules such as `zcode-cua.git` / `zcode-cua.git@v1` and `zcode-cua.server`.
    c.startsWith("zcode-cua.")
  );
}

/**
 * Whether an MCP server's `command` points at zcode-cua. Uses the same package spec matching
 * as `args` (and also compares the path leaf), covering `command: "zcode-cua"`,
 * `/opt/bin/zcode-cua`, and forms that pass the package spec directly as the command
 * (e.g. `zcode-cua@1.2.3`). On a fail-closed boundary, over-matching is preferable to missing a match.
 */
export function isZCodeCuaMcpCommand(command: string): boolean {
  return matchesZCodeCuaSpec(command) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(command));
}

/**
 * Whether a single arg is a zcode-cua package spec. Covers `zcode-cua`, `zcode-cua[macos]`,
 * `zcode-cua@1.2.3`, `zcode-cua==1.2.3`, `zcode_cua`, as well as git / local path forms
 * (`.../zcode-cua`, `zcode-cua.git`, `git+https://.../zcode-cua.git@v1`). It also compares both the
 * raw value and the path leaf, covering `--from <path>` and `--from <git-url>`.
 */
export function isZCodeCuaMcpPackageArg(value: string): boolean {
  return matchesZCodeCuaSpec(value) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(value));
}

export function convertToZCodeAgentMcpServer(
  name: string,
  config: McpServerConfig,
): ZCodeAgentMcpServer | null {
  let inferredType = config.type;
  if (!inferredType) {
    if (config.command) inferredType = "stdio";
    else if (config.url) inferredType = "http";
  }

  const isStdio = inferredType === "stdio";
  if (isStdio && config.command) {
    // On Windows, agents usually use shell: true to start child processes.
    // "cmd /c npx ..." will be double wrapped into "cmd.exe /c cmd /c npx ..." causing the connection to fail.
    // Here, remove the wrapping of cmd /c and use the internal command directly.
    let command = config.command;
    let args = config.args || [];
    // Automatically detect the platform: Node.js uses process.platform, and browsers use navigator.platform.
    const isWin32 =
      (typeof process !== "undefined" && process.platform === "win32") ||
      (typeof navigator !== "undefined" && /win/i.test(navigator.platform));
    if (isWin32) {
      const lowerCmd = command.toLowerCase();
      const unwrappedCommand = args[1];
      if ((lowerCmd === "cmd" || lowerCmd === "cmd.exe") && args[0] === "/c" && unwrappedCommand) {
        // Under noUncheckedIndexedAccess, args[1] is still string | undefined even after being judged by length.
        // Explicitly obtain the value first and judge it to be empty, which not only meets the narrowing of the type, but also avoids passing empty commands to ZCode Agent.
        command = unwrappedCommand;
        args = args.slice(2);
      }
    }
    return {
      name,
      command,
      args,
      env: config.env
        ? Object.entries(config.env).map(([key, value]) => ({
            name: key,
            value,
          }))
        : [],
      // The MCP setting page will write timeoutMs into config; when session/create uses protocol DTO
      // Only positive integers can be transparently transmitted, otherwise the strict protocol schema will change the existing illegal configuration from "ignored" to "creation failed".
      ...(isValidMcpTimeoutMs(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
      ...(isMcpIsolation(config.isolation) ? { isolation: config.isolation } : {}),
      ...(isMcpProtocolVersion(config.protocolVersion)
        ? { protocolVersion: config.protocolVersion }
        : {}),
    };
  } else if (config.url && inferredType) {
    const normalizedType: "http" | "sse" = inferredType === "sse" ? "sse" : "http";
    const headers = getMcpServerRequestHeaders(config);
    return {
      name,
      type: normalizedType,
      url: config.url,
      headers: headers
        ? Object.entries(headers).map(([key, value]) => ({
            name: key,
            value,
          }))
        : [],
      ...(isValidMcpOAuthConfig(config.oauth) ? { oauth: config.oauth } : {}),
      // HTTP/SSE MCP needs to retain the timeout configuration like stdio to avoid losing fields in the real session after the UI is saved.
      ...(isValidMcpTimeoutMs(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
      ...(isMcpIsolation(config.isolation) ? { isolation: config.isolation } : {}),
      ...(isMcpProtocolVersion(config.protocolVersion)
        ? { protocolVersion: config.protocolVersion }
        : {}),
    };
  }
  return null;
}

function isValidMcpTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isMcpIsolation(value: unknown): value is "session" | "workspace" {
  return value === "session" || value === "workspace";
}

function isMcpProtocolVersion(value: unknown): value is "legacy" | "auto" | "2026-07-28" {
  return value === "legacy" || value === "auto" || value === "2026-07-28";
}

function isValidMcpOAuthConfig(value: unknown): value is McpOAuthConfig {
  if (!isRecord(value)) return false;
  if (
    value.type === "client_credentials" &&
    typeof value.clientId === "string" &&
    value.clientId.trim().length > 0 &&
    typeof value.clientSecret === "string" &&
    value.clientSecret.trim().length > 0
  ) {
    return (
      (value.clientName === undefined || typeof value.clientName === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  if (value.type === "authorization_code") {
    return (
      (value.clientId === undefined || typeof value.clientId === "string") &&
      (value.clientSecret === undefined || typeof value.clientSecret === "string") &&
      (value.clientName === undefined || typeof value.clientName === "string") &&
      (value.redirectPath === undefined || typeof value.redirectPath === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
