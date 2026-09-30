/* eslint-disable max-lines -- Off-Peak credential resolution, the support matrix, and Request Auth share one set of contracts; scattering them makes the dual-credential / Team identity boundary harder to track. */
/* At Host dispatch time the per-request auth material is built from the current ticket; Provider/Model static facts come from Built-in Config. */
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveOffPeakProviderId,
  buildRuntimeZCodeApiUrl,
  type OffPeakCodingPlanKind,
  type OffPeakCodingPlanSupport,
  type OffPeakCodingPlanUnsupportedReason,
  type ZCodeAccountAccess,
} from "@zcode/shared";
import { isOffPeakMockEnabled, startOffPeakMockGateway } from "./offPeakMockGateway.js";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { AccountRequestCredentialUnavailableError } from "../model-provider/accountProviderRequestAuthService.js";
import type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";

/** Only for deterministic configuration errors; the host emits `permanent` from the type, and routing must never depend on error text. */
export class OffPeakPermanentDispatchError extends Error {
  readonly failureKind = "permanent" as const;

  constructor(message: string) {
    super(message);
    this.name = "OffPeakPermanentDispatchError";
  }
}

/** Typed error for dual-credential resolution failure (the UI can prompt for login / coding plan setup based on it). */
export class OffPeakCredentialsUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly missing: "jwt" | "codingPlanApiKey") {
    super(
      missing === "jwt"
        ? "off-peak requires zcode login (jwt missing)"
        : "off-peak requires a coding plan provider api key",
    );
    this.name = "OffPeakCredentialsUnavailableError";
  }
}

/** The current provider family / selected connection is not part of the Off-Peak support matrix. */
export class OffPeakCodingPlanUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly reason: OffPeakCodingPlanUnsupportedReason) {
    super(`off-peak selected coding plan unavailable: ${reason}`);
    this.name = "OffPeakCodingPlanUnavailableError";
  }
}

/** Typed error that halts instead of burning a ticket when the user's resident model or idle plan model is missing. */
export class OffPeakModelUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly scope: "idlePlan" | "workspaceUser") {
    super(
      scope === "idlePlan"
        ? "off-peak dispatch has no usable model (Built-in Provider models empty)"
        : "off-peak dispatch has no usable user workspace model",
    );
    this.name = "OffPeakModelUnavailableError";
  }
}

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ACTIVE_OAUTH_PROVIDER_KEY = "oauth:active_provider";

export interface OffPeakCredentialSnapshot {
  jwt: string;
  codingPlanApiKey: string;
  kind: OffPeakCodingPlanKind;
  providerFamily: "zai" | "bigmodel";
  providerId: string;
  /** BigModel Team organization/project identity; only when both exist is it allowed into request headers. */
  organizationId?: string;
  projectId?: string;
  /** Only for the in-process mock proxying the real selected Coding Plan upstream; it never crosses RPC or gets persisted. */
  providerBaseURL?: string;
}

interface OffPeakCredentialResolverDeps {
  credentialService: { load(key: string): Promise<string | null | undefined> };
  accountRequestAuthService: IAccountRequestAuthService;
  resolveAccountProvider(): Promise<{
    readonly providerId: string;
    readonly access: ZCodeAccountAccess;
    readonly baseURL?: string;
  } | null>;
  env?: NodeJS.ProcessEnv;
}

type SelectedOffPeakCodingPlan = Pick<
  OffPeakCredentialSnapshot,
  "kind" | "providerFamily" | "providerId" | "organizationId" | "projectId"
>;

function resolveSelectedOffPeakCodingPlan(
  provider: Awaited<ReturnType<OffPeakCredentialResolverDeps["resolveAccountProvider"]>>,
): SelectedOffPeakCodingPlan {
  if (!provider) {
    throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
  }
  const { access, providerId } = provider;
  if (access.planKind === "start-plan") {
    throw new OffPeakCodingPlanUnavailableError("start_plan_not_supported");
  }
  if (access.planKind === "individual-coding-plan") {
    return {
      kind: access.family === "zai" ? "zai-personal" : "bigmodel-personal",
      providerFamily: access.family,
      providerId,
    };
  }
  if (access.planKind !== "team-coding-plan") {
    throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
  }
  return {
    kind: access.family === "zai" ? "zai-team" : "bigmodel-team",
    providerFamily: access.family,
    providerId,
    organizationId: access.organizationId,
    projectId: access.projectId,
  };
}

function createOffPeakSelectionFingerprint(
  provider: Awaited<ReturnType<OffPeakCredentialResolverDeps["resolveAccountProvider"]>>,
): string {
  return JSON.stringify(provider ?? null);
}

/**
 * Resolves the Off-Peak dual credentials for the currently selected connection.
 *
 * The dispatch credentials must stay consistent with the Coding Plan selected in the UI, so ZAI/Team tasks never
 * misuse a personal BigModel key. The settings' family + selectedKey is the single source of selection truth; the
 * dynamic credentials are then resolved through the auth sources injected at the execution entry point.
 * A Team key keeps reusing the Account Request Auth org/project resolver and never falls back to a personal key on failure.
 */
export async function resolveOffPeakCredentials(
  deps: OffPeakCredentialResolverDeps,
  options: { allowMockCredentials?: boolean } = {},
): Promise<OffPeakCredentialSnapshot> {
  const env = deps.env ?? process.env;
  if (options.allowMockCredentials !== false && env["ZCODE_OFFPEAK_MOCK"] === "1") {
    if (env["ZCODE_OFFPEAK_MOCK_NO_PLAN"] === "1") {
      throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
    }
    // The mock gateway does not verify credentials; use deterministic metadata so that the UI and ticket/runtime still share the same support shape.
    return {
      jwt: "offpeak-mock-jwt",
      codingPlanApiKey: "offpeak-mock-key",
      kind: "bigmodel-personal",
      providerFamily: "bigmodel",
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    };
  }

  // settings may be switched during account provider resolution. If the fingerprints before and after are inconsistent, read it again, and splicing the two generations of credentials is prohibited.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const provider = await deps.resolveAccountProvider();
    const selection = resolveSelectedOffPeakCodingPlan(provider);
    const activeProvider =
      (await deps.credentialService.load(ACTIVE_OAUTH_PROVIDER_KEY))?.trim() ?? "";
    if (activeProvider !== selection.providerFamily) {
      // zcode JWT is a global image of the current App login identity; only verifying selectedKey will
      // ZAI JWT and BigModel key (or reverse) match the same request, and the server can only reject it when getting the number.
      throw new OffPeakCodingPlanUnavailableError("provider_identity_mismatch");
    }
    const jwt = (await deps.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
    if (!jwt) {
      throw new OffPeakCredentialsUnavailableError("jwt");
    }
    const [latestProvider, latestActiveProvider] = await Promise.all([
      deps.resolveAccountProvider(),
      deps.credentialService.load(ACTIVE_OAUTH_PROVIDER_KEY),
    ]);
    if (
      createOffPeakSelectionFingerprint(provider) !==
        createOffPeakSelectionFingerprint(latestProvider) ||
      activeProvider !== latestActiveProvider?.trim()
    ) {
      continue;
    }

    if (
      !provider ||
      provider.access.family !== selection.providerFamily ||
      (selection.kind.endsWith("-team")
        ? provider.access.planKind !== "team-coding-plan"
        : provider.access.planKind !== "individual-coding-plan")
    ) {
      throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
    }
    let codingPlanApiKey = "";
    try {
      const auth = await deps.accountRequestAuthService.resolveCurrent({
        providerId: selection.providerId,
        modelId: resolveOffPeakProviderId(selection.providerFamily),
        accountAccess: provider.access,
        reason: "off-peak",
      });
      codingPlanApiKey = auth.apiKey?.trim() ?? "";
    } catch (error) {
      if (error instanceof AccountRequestCredentialUnavailableError) {
        throw new OffPeakCredentialsUnavailableError("codingPlanApiKey");
      }
      throw error;
    }
    if (!codingPlanApiKey) {
      throw new OffPeakCredentialsUnavailableError("codingPlanApiKey");
    }
    return {
      ...selection,
      jwt,
      codingPlanApiKey,
      ...(provider.baseURL ? { providerBaseURL: provider.baseURL } : {}),
    };
  }

  throw new OffPeakCodingPlanUnavailableError("selection_changed");
}

/**
 * The BigModel Team organization/project must come from the same selected-connection resolution as the auth credentials.
 *
 * Off-Peak used to pass only the JWT and the Coding Plan key, so the server had no BigModel access key and could not
 * look up a Team Plan's organization/project. An older connection key may carry only projectId; in that case sending
 * a half identity header set is forbidden, so the server never validates against the wrong organization ownership.
 */
export function buildOffPeakPlanIdentityHeaders(
  credentials: OffPeakCredentialSnapshot,
): Record<string, string> {
  if (credentials.kind !== "bigmodel-team") {
    return {};
  }
  const organizationId = credentials.organizationId?.trim() ?? "";
  const projectId = credentials.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return {};
  }
  return {
    "bigmodel-organization": organizationId,
    "bigmodel-project": projectId,
  };
}

/**
 * Builds the dynamic auth material for one off-peak execution. Static facts such as endpoint, model capabilities, and
 * reasoning come from Built-in Provider / Model Config and must never be pushed down with a single dispatch.
 */
export function buildOffPeakRequestAuth(params: {
  credentials: OffPeakCredentialSnapshot;
  ticketId: string;
}): { apiKey: string; headers: Record<string, string> } {
  return {
    // Anthropic-compatible clients will send x-api-key; servers still use Authorization and Plan Key to decide.
    apiKey: params.credentials.jwt,
    headers: {
      Authorization: `Bearer ${params.credentials.jwt}`,
      "X-Coding-Plan-Api-Key": params.credentials.codingPlanApiKey,
      "X-Off-Peak-Ticket-ID": params.ticketId,
      ...buildOffPeakPlanIdentityHeaders(params.credentials),
    },
  };
}

/** Redacted support snapshot visible to the renderer; raw credentials always stay in host/service memory. */
export async function resolveOffPeakCodingPlanSupport(
  deps: OffPeakCredentialResolverDeps,
): Promise<OffPeakCodingPlanSupport> {
  try {
    const snapshot = await resolveOffPeakCredentials(deps);
    return {
      supported: true,
      kind: snapshot.kind,
      providerFamily: snapshot.providerFamily,
      providerId: snapshot.providerId,
    };
  } catch (error) {
    if (error instanceof OffPeakCodingPlanUnavailableError) {
      return { supported: false, reason: error.reason };
    }
    if (error instanceof OffPeakCredentialsUnavailableError) {
      return {
        supported: false,
        reason: error.missing === "jwt" ? "jwt_missing" : "connection_unavailable",
      };
    }
    throw error;
  }
}

/**
 * Upstream resolution for the mock gateway: proxies the admitted messages to the user's coding plan anthropic-compatible
 * endpoint (real model, using the user's own key, development/demo only).
 */
export async function resolveOffPeakMockUpstream(deps: {
  credentialService: OffPeakCredentialResolverDeps["credentialService"];
  accountRequestAuthService: OffPeakCredentialResolverDeps["accountRequestAuthService"];
  resolveAccountProvider: OffPeakCredentialResolverDeps["resolveAccountProvider"];
  env?: NodeJS.ProcessEnv;
}): Promise<{ url: string; headers: Record<string, string> }> {
  const credentials = await resolveOffPeakCredentials(deps, {
    // The mock's own placeholder cannot be used to proxy the upstream; here it is forced to parse the real selected connection.
    allowMockCredentials: false,
  });
  if (!credentials.providerBaseURL) {
    throw new Error("off-peak mock upstream requires a selected coding plan provider endpoint");
  }
  return {
    url: `${credentials.providerBaseURL.replace(/\/$/, "")}/v1/messages`,
    headers: {
      "x-api-key": credentials.codingPlanApiKey,
      authorization: `Bearer ${credentials.codingPlanApiKey}`,
    },
  };
}

/**
 * Origin resolver (memoized): in mock mode it lazily starts the in-process gateway (fixed port; multiple instances
 * reuse one ticket state via EADDRINUSE), in real mode it points at the zcode API origin. It is safe for the node service
 * wiring side and the host dispatch side to each hold a resolver — whoever binds first owns the gateway, the other
 * reuses it externally.
 */
export function createOffPeakOriginResolver(deps: {
  logger: ServiceLogger;
  resolveUpstream: () => Promise<{ url: string; headers: Record<string, string> }>;
  env?: NodeJS.ProcessEnv;
}): { resolveOrigin: () => Promise<string>; close: () => Promise<void> } {
  const env = deps.env ?? process.env;
  let originPromise: Promise<string> | null = null;
  let closeGateway: (() => Promise<void>) | null = null;
  return {
    resolveOrigin: () => {
      if (!originPromise) {
        originPromise = (async () => {
          if (!isOffPeakMockEnabled(env)) {
            return new URL(buildRuntimeZCodeApiUrl(env, "/")).origin;
          }
          const gateway = await startOffPeakMockGateway({
            logger: deps.logger,
            resolveUpstream: deps.resolveUpstream,
          });
          if (!gateway.external) closeGateway = gateway.close;
          return gateway.origin;
        })().catch((error) => {
          originPromise = null; // Allow retry after failure (if the port is temporarily occupied)
          throw error;
        });
      }
      return originPromise;
    },
    close: async () => {
      const close = closeGateway;
      closeGateway = null;
      if (close) await close();
    },
  };
}
