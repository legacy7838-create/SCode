/* Shared constants and types for ZCode official Server MCP auth.
   They live in shared because the header set has two consumers in different packages:
   - the `packages/services` side produces the identity headers;
   - the `apps/zcode-cli/packages/adapters` side (Plugin parser + MCP adapter) intercepts the reserved headers.
   Both sides must share one source, otherwise a newly added identity header would slip past the
   blocklist, leaving a hole where a static header could override the credentials. */

/** The only legal value of `auth.type` in `.mcp.json`; case-sensitive, no aliases accepted. */
export const ZCODE_OFFICIAL_MCP_AUTH_TYPE = "zcode_official" as const;

/** The only legal provider in phase one. A future short-lived Token should add a new provider value rather than change the meaning of this one. */
export const ZCODE_OFFICIAL_MCP_AUTH_PROVIDER_JWT_TOKEN = "jwt_token" as const;

/**
 * Official MCP uses two independent sets of credentials: user identity and plan identity.
 * codingPlanAuthorization must carry the MaaS login JWT; a Coding Plan business API key
 * cannot stand in for it. The server validates its association with the current user via
 * the customer_id inside the JWT.
 */
export const OFFICIAL_MCP_AUTH_HEADER_NAMES = {
  authorization: "Authorization",
  codingPlanAuthorization: "X-Bigmodel-Authorization",
  targetType: "Bigmodel-Target-Type",
  organization: "Bigmodel-Organization",
  project: "Bigmodel-Project",
} as const;

/**
 * The key under which the stdio official MCP identity headers travel on every outbound request
 * and on the `params._meta` of notifications.
 *
 * This is a **cross-language protocol constant** shared with plugin processes — the Plugin side
 * (such as a plugin's Python server) reads the same string. Renaming it breaks every published
 * plugin, which amounts to a protocol-level breaking change. The namespace prefix stays
 * `com.zcode/`, consistent with the existing `com.zcode/request-context`.
 */
export const OFFICIAL_MCP_AUTH_META_KEY = "com.zcode/official-mcp-auth" as const;

/**
 * Reserved headers forbidden in static Plugin `headers` (lowercased, compared case-insensitively).
 *
 * Identity headers: keep the Plugin's static config from forging or overriding credentials.
 * Protocol headers (mcp-session-id / mcp-protocol-version): when the SDK assembles request
 * headers, `requestInit.headers` takes priority over the protocol headers, so static config
 * could override the session id — hence they are forbidden too.
 *
 * `x-coding-plan-api-key` is no longer sent by the client (it switched to the MaaS JWT channel),
 * but it **must stay in the blocklist**: that server-side channel is still live
 * (`credential := cmp.Or(Authorization, APIKey)`), and lifting the ban would let a Plugin carry
 * its own Coding Plan credential as a static header and impersonate the official endpoint. It is
 * listed explicitly instead of derived from the header-name table precisely because the table no
 * longer contains it.
 */
export const OFFICIAL_MCP_RESERVED_HEADER_NAMES: readonly string[] = [
  ...Object.values(OFFICIAL_MCP_AUTH_HEADER_NAMES).map((name) => name.toLowerCase()),
  "x-coding-plan-api-key",
  "mcp-session-id",
  "mcp-protocol-version",
];

const RESERVED_HEADER_SET = new Set(OFFICIAL_MCP_RESERVED_HEADER_NAMES);

/** Whether it is a reserved header, compared case-insensitively. */
export function isOfficialMcpReservedHeaderName(name: string): boolean {
  return RESERVED_HEADER_SET.has(name.trim().toLowerCase());
}

/** Returns the reserved headers hit in a static header record (lowercased, deduplicated, stably sorted); an empty array when nothing matches. */
export function findOfficialMcpReservedHeaders(
  headers: Record<string, string> | undefined,
): string[] {
  if (!headers) return [];
  const hits = new Set<string>();
  for (const name of Object.keys(headers)) {
    const normalized = name.trim().toLowerCase();
    if (RESERVED_HEADER_SET.has(normalized)) hits.add(normalized);
  }
  return [...hits].sort();
}

/** Valid values of the server-side `Bigmodel-Target-Type` (aligned with CodingPlanTargetType in zcode-server). */
export type OfficialMcpTargetType = "PERSONAL" | "TEAM";

/**
 * Port/protocol-level failure classifications (the two that "send no request at all").
 * Network-level failures (401/403/3xx) are classified by the MCP adapter itself after it
 * receives a response; they never go through this enum.
 */
export const OFFICIAL_MCP_AUTH_FAILURE_REASONS = [
  "official_auth_unavailable",
  "official_auth_plan_required",
] as const;

export type OfficialMcpAuthFailureReason = (typeof OFFICIAL_MCP_AUTH_FAILURE_REASONS)[number];

export const OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS = [
  ...OFFICIAL_MCP_AUTH_FAILURE_REASONS,
  "official_mcp_origin_untrusted",
] as const;

export type OfficialMcpAuthPortFailureReason =
  (typeof OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS)[number];

/** The MCP adapter's complete failure classification, including network-level results. Used only for record status and logging. */
export type OfficialMcpAuthFailureKind =
  | OfficialMcpAuthFailureReason
  | "official_mcp_origin_untrusted"
  | "official_auth_rejected"
  | "official_auth_forbidden"
  | "official_auth_redirect_blocked";

// ──Official MCP trust judgment──
// Put it in shared instead of CLI bootstrap because there are two consumers and they belong to mutually invisible packages:
//   - apps/zcode-cli/packages/adapters: local verification before request is sent;
//   - packages/services (host): secondary verification of identity authority boundaries (only relies on @zcode/shared,
//     Unable to import CLI side packages).
// Single source is a hard requirement: bifurcation at two locations will allow one side to allow it and the other side to reject it.

/**
 * Normalizes the origin: it must be https, carry no username/password, and the URL itself must
 * already be in origin form. URLs with credentials are rejected because the origin of
 * `https://user:pass@a.example` is `https://a.example`, so comparing origins alone would pass it.
 */
function normalizeHttpsOrigin(candidate: string): string | undefined {
  try {
    const url = new URL(candidate);
    if (url.username !== "" || url.password !== "") return undefined;
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function normalizeLoopbackOrigin(candidate: string): string | undefined {
  try {
    const url = new URL(candidate);
    if (url.username !== "" || url.password !== "") return undefined;
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return url.protocol === "http:" && loopback ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export const OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV = "ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS";

/** The real workspace identity the Host injects at spawn time; used only for isolation/auditing, never for file execution. */
export const ZCODE_WORKSPACE_IDENTITY_ENV = "ZCODE_WORKSPACE_IDENTITY";

/** A safe logging summary of the identity headers: only header names, Team pairing, and TargetType — never any values. */
export function summarizeOfficialMcpIdentityHeaders(
  headers: Record<string, string>,
): Record<string, unknown> {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const organization = lower.has("bigmodel-organization");
  const project = lower.has("bigmodel-project");
  return {
    identityHeaderNames: [...lower.keys()].sort(),
    identityOrganizationPresent: organization,
    identityProjectPresent: project,
    identityTeamPaired: organization === project,
    ...(lower.get("bigmodel-target-type")
      ? { identityTargetType: lower.get("bigmodel-target-type") }
      : {}),
  };
}

export interface OfficialMcpTrustResult {
  trusted: boolean;
  /** A readable reason on rejection, for logging only, not for flow routing. */
  detail: "ok" | "invalid_input" | "origin_mismatch" | "zcode_origin_unresolved";
}

export interface IsOfficialMcpOriginTrustedInput {
  /** The raw value of the local self-test switch (usually from env); it only opens up http loopback. */
  devTrustedOriginsRaw?: string | undefined;
  origin: string;
  /**
   * Declares the plugin id of this MCP. It takes **no part in the trust decision** and only serves
   * as the ownership identifier for logging and credential resolution. It is kept as an input so
   * that logs can answer "which plugin is asking for credentials".
   */
  pluginId: string;
  /** The current ZCode API origin, resolved by each caller under its own rules and passed in. */
  zcodeApiOrigin: string | undefined;
}

/**
 * Validates the credential target of an official MCP: it requires an HTTPS origin equal to the
 * runtime ZCode API origin, with no username/password in the URL. The dev config only allows the
 * explicitly listed HTTP loopback origins.
 *
 * pluginId is used for ownership and logging, not as an authorization filter; any loaded plugin
 * may request official auth. Destination validation does not replace per-endpoint user permission,
 * plan, and quota checks, nor does it provide per-plugin authorization confirmation. A plugin
 * using stdio auth holds credentials and should be managed as trusted executable code.
 */
export function isOfficialMcpOriginTrusted(
  input: IsOfficialMcpOriginTrustedInput,
): OfficialMcpTrustResult {
  const origin = input.origin.trim();
  if (!origin) {
    return { detail: "invalid_input", trusted: false };
  }

  // Local self-test switch: only accepts http loopback, so credentials cannot be directed to the remote end.
  // You must first confirm that the target origin itself is a loopback: otherwise normalize will get undefined on both sides.
  // `undefined === undefined` will cause the switch to release any origin (including https remote sites).
  const loopbackOrigin = normalizeLoopbackOrigin(origin);
  if (loopbackOrigin) {
    for (const candidate of parseDevTrustedOrigins(input.devTrustedOriginsRaw)) {
      if (normalizeLoopbackOrigin(candidate) === loopbackOrigin) {
        return { detail: "ok", trusted: true };
      }
    }
  }

  const expected = input.zcodeApiOrigin ? normalizeHttpsOrigin(input.zcodeApiOrigin) : undefined;
  if (!expected) return { detail: "zcode_origin_unresolved", trusted: false };
  if (normalizeHttpsOrigin(origin) !== expected) {
    return { detail: "origin_mismatch", trusted: false };
  }
  return { detail: "ok", trusted: true };
}

/**
 * The local self-test switch, holding comma-separated loopback origins such as `http://127.0.0.1:3999`.
 * It only takes effect for http loopback: the worst case is sending your own JWT to a local
 * process, and any local program could already read that same credential, so it widens the trust
 * surface by nothing. When unset, the behavior is exactly as if the switch did not exist.
 */
function parseDevTrustedOrigins(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The trust decider. It keeps the `isTrusted` DI shape unchanged so the adapter and the host can
 * share one implementation. It is async so the host can resolve the origin through the settings
 * override (same rules as off-peak tasks), avoiding a split where off-peak tasks connect fine but
 * the official MCP cannot connect at all.
 */
export interface OfficialMcpTrustedOriginRegistry {
  isTrusted(input: {
    mcpKey: string;
    origin: string;
    pluginId: string;
  }): Promise<OfficialMcpTrustResult>;
}

export interface CreateOfficialMcpTrustedOriginRegistryOptions {
  /** The raw value of the local self-test switch (comma-separated loopback origins), usually from env. */
  devTrustedOriginsRaw?: string | undefined;
  /** Resolver for the current ZCode API origin; both sides must use equivalent rules, otherwise one side allows what the other rejects. */
  resolveZCodeApiOrigin: () => string | undefined | Promise<string | undefined>;
}

export function createOfficialMcpTrustedOriginRegistry(
  options: CreateOfficialMcpTrustedOriginRegistryOptions,
): OfficialMcpTrustedOriginRegistry {
  return {
    async isTrusted({ origin, pluginId }) {
      let zcodeApiOrigin: string | undefined;
      try {
        zcodeApiOrigin = await options.resolveZCodeApiOrigin();
      } catch {
        // If the parsing fails, it will be treated as untrustworthy and will never be released just because the origin cannot be obtained.
        return { detail: "zcode_origin_unresolved", trusted: false };
      }
      return isOfficialMcpOriginTrusted({
        devTrustedOriginsRaw: options.devTrustedOriginsRaw,
        origin,
        pluginId,
        zcodeApiOrigin,
      });
    },
  };
}
