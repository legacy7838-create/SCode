/*
 * Credential resolution and identity-header construction for the ZCode official Server MCP.
 *
 * This file is **logically equivalent but completely independent** of Off-Peak's offPeakRuntimeModel.ts:
 * it reuses none of its functions and changes none of its behavior. The reason is that the plan
 * thresholds, Team support scope, and credential channel expectations of the two will evolve
 * independently; a shared helper would turn any change on either side into one that requires
 * evaluating the impact on both.
 *
 * Three deliberate differences from Off-Peak:
 *   1. It explicitly produces Bigmodel-Target-Type (the Off-Peak side currently has no producer);
 *   2. There is no mock credential branch at all (the official MCP has no mock gateway; tests swap the source via dependency injection);
 *   3. Failure reasons use the official_* categories instead of reusing Off-Peak's reason strings.
 *
 * Credential channel: Coding Plan credentials go through `X-Bigmodel-Authorization` + the MaaS login
 * JWT, and `X-Coding-Plan-Api-Key` is no longer sent. The server marks the API key channel as
 * "legacy client compatibility only", and sending both headers at once is harmful — the JWT wins the
 * quota query, but the API key's ownership check still runs, so a single expired key can make the whole
 * request 403. Off-Peak still uses the API key channel, which is yet another reason for the
 * "logically equivalent but completely independent" split above.
 */
import {
  OFFICIAL_MCP_AUTH_HEADER_NAMES,
  getModelProviderFamilySpec,
  zcodeProviderAccountAccessSchema,
  type OfficialMcpAuthFailureReason,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("official-mcp");

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ACTIVE_OAUTH_PROVIDER_KEY = "oauth:active_provider";

/**
 * Credential key of the MaaS login JWT (`oauth:<provider>:access_token`, see oauth/repo/oauthCredentialRepo.ts).
 *
 * It must be selected precisely by provider family and **cross-family fallback is forbidden**: using ZAI's
 * business JWT to hit BigModel's Coding Plan only produces a request that is doomed to fail, and the
 * failure reason points to a misleading conclusion like "you have no plan". These few lines are logically
 * equivalent to but independent from the reset channel logic in bigmodelUsageQuotaProvider (see the file header).
 */
function maasJwtCredentialKey(providerFamily: "zai" | "bigmodel"): string {
  return `oauth:${getModelProviderFamilySpec(providerFamily).oauthProviderId}:access_token`;
}

/**
 * Computes the JWT's remaining validity (in seconds) purely for logging. It **takes part in no control
 * flow**; returns undefined when parsing fails.
 *
 * Why it exists: a MaaS JWT has no refresh path, and once it expires the server side shows up as an
 * upstream 401 on queryCodingPlan while the client receives copy like "Coding Plan required" — the real
 * cause and the message disagree. With this number available, the "mysterious 403" immediately reads as
 * "the token expired long ago". Only the number is logged, never the token itself.
 */
function readJwtExpiresInSeconds(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded: unknown = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const exp = (decoded as { exp?: unknown }).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
    return Math.round(exp - Date.now() / 1000);
  } catch {
    return undefined;
  }
}

/** Expiry bucket granularity (seconds) for credential-resolution info logs; no repeat entry within a bucket, see createCredentialResolvedLogKey. */
const CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS = 3600;

/**
 * Deduplication key for successful credential-resolution logs (exported only to make it unit-testable; no other consumer).
 *
 * Production logs keep the JWT expiry bucket, which helps tell an expired credential apart from an
 * unavailable plan, without recording the credential itself. The resolver only merges in-flight
 * requests and has no time-based cache; dedup is therefore bucketed per hour, so that every MCP call
 * does not produce an info log. A new entry is written when the credential expiry crosses into a new
 * bucket, becomes expired, or the plan type switches.
 */
function createCredentialResolvedLogKey(input: {
  providerFamily: "zai" | "bigmodel";
  planTargetType: string | null;
  maasJwtExpiresInSeconds: number | undefined;
}): string {
  const expires = input.maasJwtExpiresInSeconds;
  const expiryBucket =
    expires === undefined
      ? "unparsable"
      : expires <= 0
        ? "expired"
        : `t${Math.floor(expires / CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS)}`;
  return `${input.providerFamily}|${input.planTargetType ?? "none"}|${expiryBucket}`;
}

let lastCredentialResolvedLogKey: string | undefined;

interface OfficialMcpCredentialResolverDeps {
  accountRequestAuthService: {
    resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null>;
  };
  credentialService: { load(key: string): Promise<string | null | undefined> };
  modelSelectionService: {
    getView(): Promise<ModelSelectionView>;
  };
}

export type OfficialMcpPlanScope =
  | { targetType: "PERSONAL" }
  | { targetType: "TEAM"; organizationId: string; projectId: string };

export type OfficialMcpWireScope = OfficialMcpPlanScope | null;

/** Credential snapshot taken after a successful resolution. Lives only in the host/service process memory, and may cross RPC only after redaction. */
export interface OfficialMcpCredentialSnapshot {
  jwt: string;
  /**
   * The MaaS login JWT verbatim (the raw `oauth:<family>:access_token` value, **without the Bearer prefix**).
   * The prefix is added in buildOfficialMcpAuthHeaders, consistent with the existing convention on the reset / usage channels.
   */
  codingPlanAuthorization?: string;
  providerFamily: "zai" | "bigmodel";
  /** Product/quota ownership of the currently selected connection; null when a malformed legacy Team key cannot be attributed precisely. */
  planScope: OfficialMcpPlanScope | null;
  /** The identity-header scope actually sent to the Server MCP; consistently null for ZAI Team and Off-Peak. */
  wireScope: OfficialMcpWireScope;
}

export type OfficialMcpCredentialOutcome =
  | { ok: true; snapshot: OfficialMcpCredentialSnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

type SelectedPlan = {
  providerFamily: "zai" | "bigmodel";
  providerId: string;
  planScope: OfficialMcpPlanScope | null;
  wireScope: OfficialMcpWireScope;
};

type SelectedProvider = {
  providerId: string;
  access: ZCodeProviderAccountAccess;
};

function fail(reason: OfficialMcpAuthFailureReason): {
  ok: false;
  reason: OfficialMcpAuthFailureReason;
} {
  return { ok: false, reason };
}

/**
 * Determines the currently enabled Coding Plan Provider from the Registry; the dynamic plan and Team scope
 * are then resolved by the account service. Reading or faking the current Team scope from the static
 * Provider Config is forbidden.
 */
function resolveSelectedProvider(
  registry: ModelSelectionView,
): { ok: true; provider: SelectedProvider } | { ok: false; reason: OfficialMcpAuthFailureReason } {
  const candidates = registry.providers.flatMap((provider) => {
    const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    return parsed.success &&
      (parsed.data.mode === "individual-coding-plan" || parsed.data.mode === "team-coding-plan")
      ? [{ providerId: provider.providerId, access: parsed.data }]
      : [];
  });
  if (candidates.length !== 1) {
    return fail("official_auth_plan_required");
  }
  return { ok: true, provider: candidates[0]! };
}

function resolveSelectedPlan(
  selectedProvider: SelectedProvider,
  access: ZCodeAccountAccess | null,
): { ok: true; plan: SelectedPlan } | { ok: false; reason: OfficialMcpAuthFailureReason } {
  if (
    !access ||
    access.family !== selectedProvider.access.accountType ||
    (selectedProvider.access.mode === "team-coding-plan"
      ? access.planKind !== "team-coding-plan"
      : access.planKind !== "individual-coding-plan")
  ) {
    return fail("official_auth_plan_required");
  }
  const { providerId } = selectedProvider;
  const providerFamily = access.family;
  if (access.planKind === "team-coding-plan") {
    const teamScope: OfficialMcpPlanScope = {
      organizationId: access.organizationId,
      projectId: access.projectId,
      targetType: "TEAM",
    };
    return {
      ok: true,
      plan: {
        providerFamily,
        providerId,
        planScope: teamScope,
        wireScope: providerFamily === "bigmodel" ? teamScope : null,
      },
    };
  }
  return {
    ok: true,
    plan: {
      providerFamily,
      providerId,
      planScope: { targetType: "PERSONAL" },
      wireScope: { targetType: "PERSONAL" },
    },
  };
}

/** Non-secret selection fingerprint, compared before and after resolution to keep the two generations of credentials from being mixed into one request. */
function createSelectionFingerprint(registry: ModelSelectionView): string {
  return JSON.stringify({ revision: registry.revision, providers: registry.providers });
}

type OfficialMcpIdentitySnapshot = {
  activeProvider: "zai" | "bigmodel";
  jwt: string;
  registry: ModelSelectionView;
  selectionFingerprint: string;
};

async function readIdentitySnapshot(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<
  | { ok: true; snapshot: OfficialMcpIdentitySnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason }
> {
  const [registry, activeProviderValue, jwtValue] = await Promise.all([
    deps.modelSelectionService.getView(),
    deps.credentialService.load(ACTIVE_OAUTH_PROVIDER_KEY),
    deps.credentialService.load(ZCODE_JWT_TOKEN_KEY),
  ]);
  const activeProvider = activeProviderValue?.trim();
  const jwt = jwtValue?.trim() ?? "";
  if ((activeProvider !== "zai" && activeProvider !== "bigmodel") || !jwt) {
    return fail("official_auth_unavailable");
  }
  return {
    ok: true,
    snapshot: {
      activeProvider,
      jwt,
      registry,
      selectionFingerprint: createSelectionFingerprint(registry),
    },
  };
}

function isSameIdentitySnapshot(
  before: OfficialMcpIdentitySnapshot,
  after: OfficialMcpIdentitySnapshot,
): boolean {
  return (
    before.activeProvider === after.activeProvider &&
    before.jwt === after.jwt &&
    before.selectionFingerprint === after.selectionFingerprint
  );
}

function identityOnlyOutcome(identity: OfficialMcpIdentitySnapshot): OfficialMcpCredentialOutcome {
  log.debug("official mcp identity-only credentials resolved", {
    providerFamily: identity.activeProvider,
    reason: "official_auth_plan_required",
  });
  return {
    ok: true,
    snapshot: {
      jwt: identity.jwt,
      planScope: null,
      providerFamily: identity.activeProvider,
      wireScope: null,
    },
  };
}

/**
 * Resolves the official MCP credentials of the currently selected connection.
 *
 * Race protection: the Registry, the dynamic Account Access, the active provider, the zcode JWT, and
 * the MaaS JWT may all change while resolution is in progress. Here each is read once before and once
 * after and compared; any mismatch restarts the whole round, and two generations of credentials are
 * never spliced together — that covers both "the zcode JWT comes from ZAI while the MaaS JWT comes
 * from BigModel" (cross-family mixing) and "old JWT + new JWT" (token rotation within one family).
 * If two rounds are still unstable it returns unavailable.
 */
export async function resolveOfficialMcpCredentials(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<OfficialMcpCredentialOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const identity = await readIdentitySnapshot(deps);
    if (!identity.ok) {
      if (attempt === 0) continue;
      return identity;
    }
    const selectedProvider = resolveSelectedProvider(identity.snapshot.registry);
    if (!selectedProvider.ok) {
      const latestIdentity = await readIdentitySnapshot(deps);
      if (
        !latestIdentity.ok ||
        !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot)
      ) {
        continue;
      }
      return identityOnlyOutcome(identity.snapshot);
    }
    const accountAccess = await deps.accountRequestAuthService.resolveAccessCurrent(
      selectedProvider.provider.access,
    );
    const selected = resolveSelectedPlan(selectedProvider.provider, accountAccess);
    if (!selected.ok) return selected;

    // The zcode JWT is a global login identity mirror; only validating selectedKey would concatenate the ZAI JWT and BigModel key into the same request.
    if (identity.snapshot.activeProvider !== selected.plan.providerFamily) {
      return fail("official_auth_unavailable");
    }

    const maasJwtKey = maasJwtCredentialKey(selected.plan.providerFamily);
    const codingPlanAuthorization = (await deps.credentialService.load(maasJwtKey))?.trim() ?? "";
    if (!codingPlanAuthorization) {
      // Classified as unavailable rather than plan_required: this is an incomplete login state (re-login required),
      // not "no plan". Both provider adapters strictly require writing this token during login,
      // so the normal path will not hit this; it mainly appears in old login states migrated from history.
      log.warn("official mcp maas jwt missing", {
        providerFamily: selected.plan.providerFamily,
        reason: "official_auth_unavailable",
      });
      return fail("official_auth_unavailable");
    }

    const [latestIdentity, latestMaasJwt] = await Promise.all([
      readIdentitySnapshot(deps),
      deps.credentialService.load(maasJwtKey),
    ]);
    const latestSelectedProvider = latestIdentity.ok
      ? resolveSelectedProvider(latestIdentity.snapshot.registry)
      : latestIdentity;
    const latestAccountAccess = latestSelectedProvider.ok
      ? await deps.accountRequestAuthService.resolveAccessCurrent(
          latestSelectedProvider.provider.access,
        )
      : null;
    if (
      !latestIdentity.ok ||
      !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot) ||
      !latestSelectedProvider.ok ||
      JSON.stringify(accountAccess) !== JSON.stringify(latestAccountAccess) ||
      codingPlanAuthorization !== (latestMaasJwt?.trim() ?? "")
    ) {
      continue;
    }

    // The provider entry only serves as a threshold for "this Coding Plan connection indeed exists". The business key itself is no longer a credential
    // (already switched to the MaaS JWT channel), so it no longer requires a value—otherwise the transient state of the business key being refreshed
    // would judge an otherwise successful call as "no plan". The real "no plan" is blocked by the two thresholds above:
    // API Key mode and selecting a Start Plan connection, neither of which depends on the business key.
    const provider = identity.snapshot.registry.providers.find(
      (candidate) => candidate.providerId === selected.plan.providerId,
    );
    if (!provider) return fail("official_auth_plan_required");

    // info rather than debug: production builds do not persist debug logs, and the MaaS JWT remaining validity is a key troubleshooting clue
    // (see the description in createCredentialResolvedLogKey). Only log the remaining seconds, never the token itself.
    // Only log when the deduplication key crosses buckets, avoiding log volume of the same order of magnitude as official MCP request count.
    const maasJwtExpiresInSeconds = readJwtExpiresInSeconds(codingPlanAuthorization);
    const logKey = createCredentialResolvedLogKey({
      providerFamily: selected.plan.providerFamily,
      planTargetType: selected.plan.planScope?.targetType ?? null,
      maasJwtExpiresInSeconds,
    });
    if (logKey !== lastCredentialResolvedLogKey) {
      lastCredentialResolvedLogKey = logKey;
      log.info("official mcp credentials resolved", {
        maasJwtExpiresInSeconds,
        providerFamily: selected.plan.providerFamily,
        planTargetType: selected.plan.planScope?.targetType ?? null,
        wireTargetType: selected.plan.wireScope?.targetType ?? null,
      });
    }

    return {
      ok: true,
      snapshot: {
        codingPlanAuthorization,
        jwt: identity.snapshot.jwt,
        planScope: selected.plan.planScope,
        providerFamily: selected.plan.providerFamily,
        wireScope: selected.plan.wireScope,
      },
    };
  }

  return fail("official_auth_unavailable");
}

/**
 * Builds the identity headers for this request from the credential snapshot.
 * Team identity is sent as an atomic pair: if either organization or project is missing, neither is sent.
 */
export function buildOfficialMcpAuthHeaders(
  snapshot: OfficialMcpCredentialSnapshot,
): Record<string, string> {
  const headers: Record<string, string> = {
    [OFFICIAL_MCP_AUTH_HEADER_NAMES.authorization]: `Bearer ${snapshot.jwt}`,
  };
  if (snapshot.codingPlanAuthorization) {
    // The server does CutPrefix("Bearer ") and also accepts bare tokens; here we send the Bearer form per the MCP interface documentation.
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.codingPlanAuthorization] =
      `Bearer ${snapshot.codingPlanAuthorization}`;
  }
  const scope = snapshot.wireScope;
  if (scope) {
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.targetType] = scope.targetType;
    if (scope.targetType === "TEAM") {
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.organization] = scope.organizationId;
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.project] = scope.projectId;
    }
  }
  return headers;
}

/** Request context passed through by the host handler; it takes no part in credential selection. */
interface OfficialMcpAuthHeadersRequestContext {
  mcpKey: string;
  pluginId: string;
  targetOrigin: string;
  workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
}

type OfficialMcpAuthHeadersOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * Identity-header resolution entry point, with in-flight deduplication.
 *
 * It merges **concurrent** requests only: while a resolution is in flight, later callers reuse the same
 * Promise; it is dropped as soon as it settles, and the next request resolves fully again. There is no
 * time-based caching at all, so there is no window in which an already-replaced credential is read.
 * The scope is host-global — credentials are global state, and bucketing them per plugin/mcpKey/workspace
 * would only weaken deduplication without adding isolation.
 */
export function createOfficialMcpAuthHeadersResolver(deps: OfficialMcpCredentialResolverDeps): {
  resolveHeaders(
    request?: OfficialMcpAuthHeadersRequestContext,
  ): Promise<OfficialMcpAuthHeadersOutcome>;
} {
  let pending: Promise<OfficialMcpAuthHeadersOutcome> | null = null;

  return {
    // request is only for contract alignment (the host handler has already completed trusted validation before this, see zcodeAgentService);
    // credentials are host global state and are **not** bucketed by plugin/mcpKey/workspace—bucketing would only weaken in-flight
    // deduplication without increasing isolation. The parameter is retained so that future audit needs do not require interface changes.
    resolveHeaders(_request?: OfficialMcpAuthHeadersRequestContext) {
      if (pending) return pending;
      const inFlight = (async (): Promise<OfficialMcpAuthHeadersOutcome> => {
        const outcome = await resolveOfficialMcpCredentials(deps);
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        return { ok: true, headers: buildOfficialMcpAuthHeaders(outcome.snapshot) };
      })();
      pending = inFlight;
      // Use then with dual handlers rather than finally: finally would derive an equally rejecting promise,
      // and the caller only awaits inFlight; that derived promise would become an unhandled rejection.
      // Parsing errors must also clear the slot, otherwise subsequent requests would permanently reuse the failed Promise.
      const clear = (): void => {
        if (pending === inFlight) pending = null;
      };
      inFlight.then(clear, clear);
      return inFlight;
    },
  };
}
