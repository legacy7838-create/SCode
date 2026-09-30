import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
  ZCODE_WORKSPACE_IDENTITY_ENV,
} from "@zcode/shared";

// Translate the HTTP proxy, No Proxy and custom CA on the settings page into environment variable patches for the agent sub-process.
// Agent is a child process and inherits the host process.env; here, the agent and certificate are injected when spawning, so "start the agent next time" will take effect.
//
// Proxy: Set the uppercase standard three-piece set to ensure that the settings page takes precedence over inherited shell variables of the same name (model registry by HTTPS_PROXY →
// HTTP_PROXY → ... matches uppercase first); additionally set ZCODE_HTTP_PROXY to allow the Bash tool subprocess to get the highest priority via subprocess-env.
//
// No Proxy: Only bypass rules explicitly filled in on the settings page are accepted. Additional setting ZCODE_NO_PROXY allows provider/http adapter
// The same set of rules can be reused without reading the user shell NO_PROXY.
//
// Custom certificate: Only accept PEM paths explicitly filled in on the settings page. Inject NODE_EXTRA_CA_CERTS to let the agent (including model provider request)
// Trust Node when it starts, and use ZCODE_AGENT_CA_CERT to complete the cross-runtime CA variables for adapter and tool subprocesses.

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  ZCODE_HTTP_PROXY_ENV_KEY,
] as const;
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy", ZCODE_NO_PROXY_ENV_KEY] as const;

function buildAgentProxyEnv(httpProxy: string | undefined): Record<string, string> {
  const normalized = normalizeProxyValue(httpProxy);
  if (!normalized) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    env[key] = normalized;
  }
  return env;
}

function buildAgentCaCertEnv(caCertPath: string | undefined): Record<string, string> {
  const trimmed = caCertPath?.trim();
  if (!trimmed) {
    return {};
  }
  return {
    // NODE_EXTRA_CA_CERTS must exist before the Node process is started; ZCODE_AGENT_CA_CERT is configured for runtime.
    // Provider fetch and tool sub-processes are used to avoid losing the certificate path explicitly injected by the app after cleaning the standard CA environment.
    NODE_EXTRA_CA_CERTS: trimmed,
    [ZCODE_AGENT_CA_CERT_ENV_KEY]: trimmed,
  };
}

function buildAgentNoProxyEnv(noProxy: string | undefined): Record<string, string> {
  const normalized = normalizeNoProxyValue(noProxy);
  if (!normalized) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const key of NO_PROXY_ENV_KEYS) {
    env[key] = normalized;
  }
  return env;
}

/**
 * The runtime env patch resolved once when spawning an agent: proxy + No Proxy + custom CA.
 * All of these values come only from explicit AppSettings configuration; the standard
 * proxy/certificate variables in the user's shell have already been sanitized upstream.
 */
export function buildAgentRuntimeEnv(input: {
  httpProxy: string | undefined;
  noProxy?: string | undefined;
  caCertPath?: string | undefined;
}): Record<string, string> {
  const proxyEnv = buildAgentProxyEnv(input.httpProxy);
  return {
    ...proxyEnv,
    ...buildAgentNoProxyEnv(input.noProxy),
    ...buildAgentCaCertEnv(input.caCertPath),
  };
}

/**
 * Hands the **authoritative ZCode API origin** already resolved by the host down to the agent child process.
 *
 * Both sides share the same implementation from `@zcode/shared` for the official MCP trust
 * decision, but the **inputs** used to diverge: the host used
 * `resolveRuntimeZCodeEndpointOrigin(env, { overrideOrigin: settings
 * .zcodeEndpointOrigin })` while the agent only had `resolveRuntimeZCodeEndpointOrigin(env)`,
 * and the settings override was never handed down to the child process. With `ZCODE_ENV=test`
 * and a custom endpoint configured in the settings page, the origins computed on the two sides
 * are necessarily different, so the official MCP of either origin is rejected fail-closed by one
 * of them — yet the logs look exactly like a mistyped plugin url. A single-source implementation
 * cannot rescue diverged inputs, so the inputs must be unified too.
 *
 * Why inject `ZCODE_BASE_URL` instead of just adding a parameter to the trust decision: the agent
 * side has 4 call sites for `resolveRuntimeZCodeEndpointOrigin` (trust decision, provider routing
 * source header, model-config, auth-login); they all read the same env, so injecting in one place
 * aligns all of them, while fixing only the trust decision would leave the other 3 diverged.
 *
 * Idempotence: what is passed in is the host's **already resolved** final value. The agent inherits
 * the host's process.env, so its env-derived result already equals the host's env-derived result,
 * and layering the override on top yields exactly this value; in production the host ignores the
 * override, so the injected value equals the env-derived value and behavior is unchanged.
 *
 * Timeliness: same semantics as the proxy/CA, i.e. read at spawn time so it takes effect on the
 * "next agent start". When settings change mid-session the host updates immediately while the
 * agent still holds the old value until it restarts and realigns; the inconsistency during that
 * window only ever fails closed, it never grants access.
 */
export function buildAgentEndpointOriginEnv(
  endpointOrigin: string | undefined,
): Record<string, string> {
  const trimmed = endpointOrigin?.trim();
  if (!trimmed) {
    return {};
  }
  // ZCODE_BASE_URL is the highest priority key for resolveRuntimeZCodeEndpointOrigin to read envBaseOrigin,
  // Therefore, it can also override the inherited ZCODE_ENDPOINT_ORIGIN.
  return { ZCODE_BASE_URL: trimmed };
}

/** Injects the remote workspace identity the Host already knows into the corresponding Agent; a local workspace keeps the path fallback. */
export function buildAgentWorkspaceIdentityEnv(
  workspaceIdentity: string | undefined,
): Record<string, string> {
  const trimmed = workspaceIdentity?.trim();
  return trimmed ? { [ZCODE_WORKSPACE_IDENTITY_ENV]: trimmed } : {};
}

function normalizeProxyValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  // The schemes (http://, socks5://, etc.) are retained as they are; the bare host:port is supplemented with http://.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function normalizeNoProxyValue(value: string | undefined): string | undefined {
  const tokens = value
    ?.split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens && tokens.length > 0 ? tokens.join(",") : undefined;
}
