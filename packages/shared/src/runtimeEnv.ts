export const ZCODE_RUNTIME_ENV_KEY = "ZCODE_RUNTIME_ENV";
export const ZCODE_HTTP_PROXY_ENV_KEY = "ZCODE_HTTP_PROXY";
export const ZCODE_NO_PROXY_ENV_KEY = "ZCODE_NO_PROXY";
/** Network configuration the Desktop Host hands over exactly once to a desktop-attached remote server. */
export const ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY =
  "ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY";
export const ZCODE_REMOTE_HTTP_PROXY_ENV_KEY = "ZCODE_REMOTE_HTTP_PROXY";
export const ZCODE_REMOTE_NO_PROXY_ENV_KEY = "ZCODE_REMOTE_NO_PROXY";
export const ZCODE_AGENT_CA_CERT_ENV_KEY = "ZCODE_AGENT_CA_CERT";
export const ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY = "ZCODE_TOOL_ENV_PASSTHROUGH_JSON";
/** Desktop Main passes the server-arbitrated single-feature rollout result to the Local/Remote Host. */
export const ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV = "ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED";
export const ZCODE_CUA_PRODUCT_HELPER_ENV_KEY = "ZCODE_CUA_PRODUCT_HELPER";
export const ZCODE_CUA_BROKER_SOCKET_ENV_KEY = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
/** Shared node_repl host marker; unlike the broker bearer values it is not a secret. */
export const ZCODE_CUA_NODE_REPL_HOST_ENV_KEY = "ZCODE_CUA_NODE_REPL_HOST";
// One-knob local-development bundle. Setting ZCODE_CUA_DEV_MODE implies the internal feature
// flag (below) plus the local-helper relaxations wired in packages/services (unsigned/
// unauthenticated local helper, dev install variant, "Dev.app" naming). It exists so a developer
// can launch the full local CUA loop with a single env var instead of the historical four-var
// incantation. These switches only take effect in unpackaged local builds; the official desktop/Helper bundle will be turned off at compile time and
// The main→host boundary is deleted and cannot be used for runtime override of signed release.
export const ZCODE_CUA_DEV_MODE_ENV_KEY = "ZCODE_CUA_DEV_MODE";

export type ZCodeRuntimeEnv = "development" | "production" | "test";

type EnvRecord = Record<string, string | undefined>;

export function isCuaDevModeRequested(env: EnvRecord = process.env): boolean {
  const explicit = env[ZCODE_CUA_DEV_MODE_ENV_KEY]?.trim().toLowerCase();
  return explicit === "1" || explicit === "true" || explicit === "on";
}

export function isZCodeCuaInternalFeatureEnabled(env: EnvRecord = process.env): boolean {
  // CUA is now packaged into the official version by default (plugin staged + Helper enabled), and the explicit env flag is no longer required.
  // DEV_MODE is still implied (development one-click), PRODUCT_HELPER=0/off/false can be turned off explicitly.
  if (isCuaDevModeRequested(env)) return true;
  const explicit = env[ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "off") return false;
  return true;
}

const SANITIZED_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  // CUA broker socket is the connection material that should only be given to the target zcode-cua MCP server (by desktop/CLI in
  // Directly inject its env when parsing the server). It must not be leaked to other MCP servers/Bash/tools along with the agent global env.
  // Child process - otherwise a malicious MCP in the same agent or a command triggered by prompt-injection can directly drive
  // Authorized Helper (confused-deputy). Here, the env of all child processes is uniformly eliminated; the orientation of zcode-cua server
  // env injection is spread after buildMcpStdioEnv, so it is still available (see adapters/mcp StdioClientTransport).
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  // Legacy bearer token: The current broker is in identity mode (socket + authority, no password, see
  // captureZCodeCuaBrokerCredentials), this process will no longer generate or consume it. Still removed because the user machine
  // There may be older versions of Helper installed - those versions recognize the bearer token, once this variable is leaked to others with the agent global env
  // MCP server / Bash child process, the same confused-deputy is established again. Eliminating an unused key costs zero.
  "ZCODE_CUA_PERMISSION_BROKER_TOKEN",
  "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "ZCODE_CUA_PLUGIN_AUTHORITY",
  // Agent OTLP Endpoint/Auth/Identity only belongs to CLI telemetry bootstrap and cannot be leaked to
  // Bash, MCP, or model tool subprocess. Before sanitize, the private map of this process will be captured for the Agent to start boundary reading.
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_EXPORTER_OTLP_COMPRESSION",
  "ZCODE_MODEL_TELEMETRY_ENABLED",
  "ZCODE_TELEMETRY_DEVICE_MID",
  // Historical identity variables are no longer supported, but must still be removed from all child process environments to prevent old configurations from
  // Or the hash can be forged and leaked to Host, Bash and MCP.
  "ZCODE_TELEMETRY_USER_ID",
  "ZCODE_TELEMETRY_USER_ID_HASH",
  "ZCODE_TELEMETRY_USER_SUBJECT_ID",
  "ZCODE_TELEMETRY_IDENTITY_STATE",
  "ZCODE_TELEMETRY_RUNTIME_SURFACE",
  "ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION",
] as const;

const NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  // CUA broker credentials must not be restored to the Bash/tool ​​child process via tool-env-passthrough (otherwise this would bypass the culling above).
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "ZCODE_CUA_PLUGIN_AUTHORITY",
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
] as const;

const SANITIZED_PACKAGE_MANAGER_ENV_PATTERN =
  /^(npm_config|yarn|pnpm)_(http_proxy|https_proxy|proxy|all_proxy|no_proxy|cafile|ca)$/i;

export function normalizeZCodeRuntimeEnv(value: string | undefined): ZCodeRuntimeEnv | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "development" || normalized === "production" || normalized === "test") {
    return normalized;
  }
  return undefined;
}

export function resolveZCodeRuntimeEnv(
  env: Record<string, string | undefined>,
  fallback: ZCodeRuntimeEnv = "production",
): ZCodeRuntimeEnv {
  return normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]) ?? fallback;
}

// Exported so services/node.ts can inject the Helper's plugin authority into the agent spawn env
// (mirrors feat; the agent-side plugin host verifies the broker authority via this env var).
export const ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY = "ZCODE_CUA_PLUGIN_AUTHORITY";

interface CapturedCuaBrokerCredentials {
  socket: string;
  pluginAuthority: string;
  refreshMarker?: string;
}

let capturedCuaBrokerCredentials: Readonly<CapturedCuaBrokerCredentials> | undefined;
const capturedZCodeAgentTelemetryEnv: Record<string, string> = {};

// The CUA broker socket will be removed from the child process env by the above sanitize (confused-deputy protection - cannot let
// Other MCP server/Bash/tool child processes directly drive the authorized Helper). But the CLI entry is in bootstrap
// Before parsing the `zcode-cua` server in the global ~/.zcode/cli/config.json, the process.env will be sanitized first, resulting in
// Credentials cannot be read during directional injection → Global zcode-cua falls back to `--backend auto`, allowing Python/uvx to become the TCC subject
// (fail-open, violating "Python/uvx must never become the implicit permission owner"). Therefore, before eliminating
// Credentials are captured into the private storage of this process and are only exposed to the bootstrap direction via getCapturedZCodeCuaBrokerCredentials()
// Inject the path and never write back any child process env.
function captureZCodeCuaBrokerCredentials(env: Record<string, string | undefined>): void {
  const socket = env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY]?.trim();
  const pluginAuthority = env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim();
  const refreshMarker = env["ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER"]?.trim();
  // The connection has no password: socket + authority (config-provenance random number) appear in the same batch to form a valid credential group;
  // A half group indicates that the upstream injection is incomplete or rotating.
  if (socket && pluginAuthority) {
    capturedCuaBrokerCredentials = Object.freeze({
      socket,
      pluginAuthority,
      ...(refreshMarker ? { refreshMarker } : {}),
    });
    return;
  }
  if (socket || pluginAuthority) {
    // The discovery of half a set of credentials indicates that the upstream injection is incomplete or is being rotated; the old snapshot is cleared and fail-closed, and the other half cannot be reused.
    capturedCuaBrokerCredentials = undefined;
  }
}

function captureZCodeAgentTelemetryEnv(env: Record<string, string | undefined>): void {
  Object.assign(capturedZCodeAgentTelemetryEnv, readZCodeAgentTelemetryEnv(env));
}

/**
 * Extracts only the configuration used by the Agent telemetry bootstrap. After the generic env sanitization,
 * the host may pass this set of values to host/Agent in a targeted way; it must not be merged into the tool
 * env of Bash/MCP.
 */
export function readZCodeAgentTelemetryEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const telemetryEnv: Record<string, string> = {};
  for (const key of SANITIZED_RUNTIME_ENV_KEYS) {
    if (!isZCodeAgentTelemetryEnvKey(key)) continue;
    const value = env[key]?.trim();
    if (value) telemetryEnv[key] = value;
  }
  return telemetryEnv;
}

export function getCapturedZCodeAgentTelemetryEnv(): Record<string, string> {
  return { ...capturedZCodeAgentTelemetryEnv };
}

export function getCapturedZCodeCuaBrokerCredentials(): {
  socket: string | undefined;
  pluginAuthority: string | undefined;
  refreshMarker?: string;
} {
  return capturedCuaBrokerCredentials
    ? { ...capturedCuaBrokerCredentials }
    : { socket: undefined, pluginAuthority: undefined };
}

// Reset in-process capture state for testing only.
export function resetCapturedZCodeCuaBrokerCredentialsForTest(): void {
  capturedCuaBrokerCredentials = undefined;
}

export function resetCapturedZCodeAgentTelemetryEnvForTest(): void {
  for (const key of Object.keys(capturedZCodeAgentTelemetryEnv)) {
    delete capturedZCodeAgentTelemetryEnv[key];
  }
}

export function sanitizeZCodeRuntimeEnv<T extends Record<string, string | undefined>>(
  env: T,
): Record<string, string> {
  captureZCodeCuaBrokerCredentials(env);
  captureZCodeAgentTelemetryEnv(env);
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || shouldSanitizeZCodeRuntimeEnvKey(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function buildZCodeToolEnvPassthroughEnv(env: EnvRecord): Record<string, string> {
  const captured = readZCodeToolEnvPassthroughEnv(env);

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !shouldCaptureZCodeToolEnvPassthroughKey(key)) {
      continue;
    }
    captured[key] = value;
  }

  return stringifyZCodeToolEnvPassthroughEnv(captured);
}

export function readZCodeToolEnvPassthroughEnv(env: EnvRecord): Record<string, string> {
  const raw = env[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY];
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const captured: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        shouldCaptureZCodeToolEnvPassthroughKey(key)
      ) {
        captured[key] = value;
      }
    }
    return captured;
  } catch {
    return {};
  }
}

export function sanitizeZCodeRuntimeEnvInPlace(env: Record<string, string | undefined>): void {
  captureZCodeCuaBrokerCredentials(env);
  captureZCodeAgentTelemetryEnv(env);
  for (const key of Object.keys(env)) {
    if (shouldSanitizeZCodeRuntimeEnvKey(key)) {
      delete env[key];
    }
  }
}

function isZCodeAgentTelemetryEnvKey(key: string): boolean {
  return (
    key.startsWith("OTEL_") ||
    key.startsWith("ZCODE_TELEMETRY_") ||
    key === "ZCODE_MODEL_TELEMETRY_ENABLED"
  );
}

export function shouldSanitizeZCodeRuntimeEnvKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return (
    SANITIZED_RUNTIME_ENV_KEYS.some((candidate) => candidate === upperKey) ||
    SANITIZED_PACKAGE_MANAGER_ENV_PATTERN.test(key)
  );
}

export function shouldCaptureZCodeToolEnvPassthroughKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  if (isZCodeAgentTelemetryEnvKey(upperKey)) {
    return false;
  }
  if (NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS.some((candidate) => candidate === upperKey)) {
    return false;
  }
  return shouldSanitizeZCodeRuntimeEnvKey(key);
}

function stringifyZCodeToolEnvPassthroughEnv(
  captured: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(captured).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return {};
  }
  return {
    [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify(Object.fromEntries(entries)),
  };
}
