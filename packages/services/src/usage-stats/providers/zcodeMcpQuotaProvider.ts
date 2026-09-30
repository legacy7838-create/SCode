/* Reading the call quota of the ZCode official Server MCP (`GET /api/v1/mcp/usage`).
 *
 * This single file carries every detail of that endpoint: the path, envelope parsing, and total
 * quota mapping. **Authentication is not implemented here** — the identity headers must be the
 * same set of 5 headers used by the server MCP endpoints, and the only producer is
 * buildOfficialMcpAuthHeaders in `official-mcp/officialMcpCredentials.ts`.
 * This file only receives an injected credential resolver; it never assembles, patches, or
 * re-prefixes headers itself, otherwise its reading semantics would diverge from the server's
 * WithCodingPlan path.
 */
import { z } from "zod";
import {
  MCP_USAGE_QUOTA_LIMIT_TYPE,
  buildRuntimeZCodeApiUrl,
  type ApiClient,
  type UsageMcpQuotaScope,
  type UsageMcpQuotaSnapshot,
  type UsageQuotaLimit,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  buildOfficialMcpAuthHeaders,
  type OfficialMcpCredentialOutcome,
} from "#src/official-mcp/officialMcpCredentials.js";

const MCP_USAGE_PATH = "/api/v1/mcp/usage";
const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("usage-stats");

/**
 * Injected official MCP credential source.
 *
 * What is injected is the **credential resolution**, not the resolveHeaders of
 * createOfficialMcpAuthHeadersResolver: the attribution check needs snapshot.providerFamily, and the
 * identity headers carry no family information (only target-type / organization / project). The headers
 * are still built by the shared buildOfficialMcpAuthHeaders, keeping a single source.
 */
export interface OfficialMcpCredentialSource {
  resolve(): Promise<OfficialMcpCredentialOutcome>;
}

const mcpUsageTotalSchema = z.object({
  used: z.number().finite(),
  limit: z.number().finite(),
  remaining: z.number().finite(),
});

const mcpUsageDataSchema = z.object({
  server_time: z.number().finite(),
  next_refresh_at: z.number().finite().optional(),
  level: z.string().optional(),
  /**
   * The total quota as aggregated by the server.
   *
   * Deliberately optional rather than required: if it were required, a missing field would fall into the
   * generic "the structure is not what we expected" warning, mixed in with "the whole thing is broken".
   * A dedicated branch can log a "response is missing total_usage", recognizable at a glance when the
   * API changes again — this line exists precisely because of the last incident: the server switched its
   * response from a `buckets` array to total_usage, client schema validation failed, and since mcpQuota
   * is an optional data plane (silent degradation on failure) the symptom was the quota bar vanishing
   * without a sound.
   */
  total_usage: mcpUsageTotalSchema.optional(),
});

const mcpUsageEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: mcpUsageDataSchema.optional().nullable(),
});

/** Connection attribution of this entitlement query, used to compare against the credential attribution. */
interface McpQuotaRequestScope {
  providerFamily: "zai" | "bigmodel";
  organizationId?: string | null;
  projectId?: string | null;
}

/**
 * Whether the credential attribution matches this entitlement query.
 *
 * Credentials come from the connection currently selected in settings, while entitlements are queried
 * per provider tab in the panel. A user holding both Z.ai and BigModel Coding Plan (or personal + Team)
 * would otherwise see MCP quota that does not belong to them under the other tab.
 */
function matchesMcpQuotaScope(scope: UsageMcpQuotaScope, request: McpQuotaRequestScope): boolean {
  if (scope.providerFamily !== request.providerFamily) {
    return false;
  }
  const requestOrganizationId = request.organizationId?.trim() ?? "";
  const requestProjectId = request.projectId?.trim() ?? "";
  const requestIsTeam = Boolean(requestOrganizationId && requestProjectId);
  if (!requestIsTeam) {
    return scope.targetType === "PERSONAL";
  }
  if (scope.targetType !== "TEAM") return false;
  return (
    (scope.organizationId?.trim() ?? "") === requestOrganizationId &&
    (scope.projectId?.trim() ?? "") === requestProjectId
  );
}

/**
 * Maps the server's aggregated total quota into an equivalent UsageQuotaLimit, directly reusing the
 * existing quota bar / quota card display logic.
 *
 * percentage keeps the semantics of the quota endpoint (**used** share); the display side inverts it to
 * remaining everywhere.
 */
function buildMcpQuotaAggregateLimit(params: {
  totalUsage: { used: number; limit: number; remaining: number };
  nextResetTime?: number;
}): UsageQuotaLimit | null {
  const limit = Math.max(0, params.totalUsage.limit);
  if (limit <= 0) {
    // Do not render an empty 0% bar when there is no available quota.
    return null;
  }
  // The server-side remaining is already clamped to 0; here we clamp the upper bound again: abnormal data (remaining > limit) would calculate a negative
  // used percentage, which would cause the display side to exceed 100% after inversion.
  const remaining = Math.min(Math.max(0, params.totalUsage.remaining), limit);
  const used = Math.max(0, params.totalUsage.used);

  const usedPercentage = Math.max(0, Math.min(100, 100 - (remaining / limit) * 100));
  return {
    type: MCP_USAGE_QUOTA_LIMIT_TYPE,
    currentValue: used,
    usage: used,
    remaining,
    percentage: usedPercentage,
    ...(params.nextResetTime === undefined ? {} : { nextResetTime: params.nextResetTime }),
    // usageDetails is left empty: this field is rendered as a model name in StatusCards, and the quota dimension is not suitable for that display path.
    usageDetails: [],
  };
}

function readScopeFromCredentialSnapshot(
  snapshot: Extract<OfficialMcpCredentialOutcome, { ok: true }>["snapshot"],
): UsageMcpQuotaScope | null {
  const scope = snapshot.planScope;
  if (!scope) return null;
  return scope.targetType === "TEAM"
    ? {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        providerFamily: snapshot.providerFamily,
        targetType: "TEAM",
      }
    : { providerFamily: snapshot.providerFamily, targetType: "PERSONAL" };
}

function readRequestId(headers: Headers): string | null {
  return headers.get("x-request-id")?.trim() || null;
}

/** Response body truncation length. A normal response is only a hundred or two bytes; truncation only guards against error pages (such as gateway HTML). */
const MAX_LOGGED_BODY_CHARS = 512;

/**
 * The response body can go into the logs verbatim: the data of this endpoint contains only server_time /
 * next_refresh_at / level / total_usage, all non-sensitive counters, and **no credentials whatsoever**.
 * Conversely, not logging it is the direct reason this incident took so long to diagnose — the server
 * changed a field name, the client only reported "the structure is not what we expected", and there was
 * no way to see what was actually received.
 */
function truncateForLog(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_LOGGED_BODY_CHARS
    ? `${trimmed.slice(0, MAX_LOGGED_BODY_CHARS)}…(${trimmed.length} chars)`
    : trimmed;
}

/**
 * Reads the MCP quota once. Optional data plane: any failure returns null and only logs a warn,
 * and never affects the success and degradation semantics of the entitlement snapshot itself.
 */
export async function fetchMcpQuotaSnapshot(params: {
  apiClient: ApiClient;
  credentialSource: OfficialMcpCredentialSource;
  env: NodeJS.ProcessEnv;
  requestScope: McpQuotaRequestScope;
}): Promise<UsageMcpQuotaSnapshot | null> {
  let outcome: OfficialMcpCredentialOutcome;
  try {
    outcome = await params.credentialSource.resolve();
  } catch (error) {
    log.warn(undefined, "failed to read official MCP quota credentials, skipping this quota", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!outcome.ok) {
    // official_auth_plan_required (no Coding Plan / Start Plan / API Key mode) and
    // official_auth_unavailable (not logged in, missing credentials, selection state race) both do not send requests.
    log.info(undefined, "official MCP quota is unavailable, skipping the request", {
      reason: outcome.reason,
    });
    return null;
  }

  const scope = readScopeFromCredentialSnapshot(outcome.snapshot);
  if (!scope) {
    log.info(
      undefined,
      "official MCP quota has no exactly attributable plan scope, skipping the request",
      {
        credentialFamily: outcome.snapshot.providerFamily,
      },
    );
    return null;
  }
  if (!matchesMcpQuotaScope(scope, params.requestScope)) {
    log.info(
      undefined,
      "official MCP quota attribution does not match this query, skipping the request",
      {
        credentialFamily: scope.providerFamily,
        credentialTargetType: scope.targetType ?? null,
        requestFamily: params.requestScope.providerFamily,
        requestOrganizationId: params.requestScope.organizationId ?? null,
        requestProjectId: params.requestScope.projectId ?? null,
      },
    );
    return null;
  }

  const url = buildRuntimeZCodeApiUrl(params.env, MCP_USAGE_PATH);
  const headers = buildOfficialMcpAuthHeaders(outcome.snapshot);
  let payload: unknown;
  let requestId: string | null = null;
  let body = "";
  // Log one info entry each for request and response (not debug): the minimum level for production builds is Info, so only logging debug means that when problems occur
  // nothing is visible. This interface is triggered by entitlement TTL caching, with a magnitude of single digits per session, not constituting log bloat.
  // Only log header **names**, never values—they contain JWT and Coding Plan credentials.
  log.info(undefined, "official MCP quota request", {
    credentialFamily: scope.providerFamily,
    credentialTargetType: scope.targetType ?? null,
    headerNames: Object.keys(headers).sort(),
    method: "GET",
    timeoutMs: REQUEST_TIMEOUT_MS,
    url,
  });
  const startedAt = Date.now();
  try {
    const response = await params.apiClient.request(url, {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      // Identity headers use the shared construction result as-is: 5 headers, none modified, none added, no prefix changes.
      headers,
    });
    requestId = readRequestId(response.headers);
    const text = await response.text();
    body = truncateForLog(text);
    log.info(undefined, "official MCP quota response", {
      body,
      durationMs: Date.now() - startedAt,
      status: response.status,
      url,
      "x-request-id": requestId,
    });
    if (!response.ok) {
      log.warn(undefined, "official MCP quota request failed", {
        body,
        status: response.status,
        url,
        "x-request-id": requestId,
      });
      return null;
    }
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    log.warn(undefined, "official MCP quota request errored", {
      body,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      url,
      "x-request-id": requestId,
    });
    return null;
  }

  const envelope = mcpUsageEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    // Include the response body and zod issue path: when only reporting "structure does not match expectations", it is impossible to tell which field the server actually changed.
    log.warn(undefined, "official MCP quota response does not match the expected shape", {
      body,
      issues: envelope.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`,
      ),
      url,
      "x-request-id": requestId,
    });
    return null;
  }
  if (envelope.data.code !== 0 || !envelope.data.data) {
    // Business failures (such as 1000 usage storage failure) only clear that quota and do not throw.
    log.warn(undefined, "official MCP quota request returned a business failure", {
      code: envelope.data.code,
      msg: envelope.data.msg ?? null,
      "x-request-id": requestId,
    });
    return null;
  }

  const data = envelope.data.data;
  if (!data.total_usage) {
    // Logged separately from "structure does not match expectations": this specifically refers to the interface changing the name/position of the total quota field.
    log.warn(undefined, "official MCP quota response is missing total_usage", {
      body,
      url,
      "x-request-id": requestId,
    });
    return null;
  }
  const aggregate = buildMcpQuotaAggregateLimit({
    totalUsage: data.total_usage,
    // The interface uses Unix seconds; the client-side nextResetTime is milliseconds throughout the entire chain.
    ...(data.next_refresh_at === undefined ? {} : { nextResetTime: data.next_refresh_at * 1000 }),
  });
  if (!aggregate) {
    return null;
  }

  return {
    aggregate,
    level: data.level?.trim() || null,
    scope,
    serverTime: data.server_time * 1000,
  };
}
