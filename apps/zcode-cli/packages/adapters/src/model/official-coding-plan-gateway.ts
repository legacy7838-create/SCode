import { resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";
import type { EnvRecord } from "./model-execution.js";

/**
 * Model requests for the official Coding Plan are sent through the ZCode platform gateway.
 *
 * Z.ai / BigModel Coding Plan is ZCode's official subscription plan; model requests uniformly go to the ZCode platform gateway,
 * which performs the platform-side handling (plan entitlement checks and the like) and then forwards to the matching model service. The client does exactly one thing here:
 * swap the official model endpoint for the corresponding gateway endpoint, passing the request method, request body, auth headers and response through unchanged.
 *
 * It applies only to the official endpoints in the table below, matched exactly on protocol, host, port and path, so user-built providers and
 * third-party model services are unaffected. The gateway origin follows ZCODE_BASE_URL / ZCODE_ENDPOINT_ORIGIN,
 * defaulting to the production https://zcode.z.ai.
 */
export interface OfficialCodingPlanGatewayRoute {
  /** The official model endpoint (with path), https only. */
  readonly providerEndpoint: string;
  /** The matching gateway endpoint path, relative to the ZCode platform origin. */
  readonly gatewayPath: string;
}

export const OFFICIAL_CODING_PLAN_GATEWAY_ROUTES: readonly OfficialCodingPlanGatewayRoute[] = [
  {
    providerEndpoint: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    gatewayPath: "/api/v1/ultra/anthropic/v1/messages",
  },
  {
    providerEndpoint: "https://api.z.ai/api/anthropic/v1/messages",
    gatewayPath: "/api/v1/ultra-zai/anthropic/v1/messages",
  },
];

export interface OfficialCodingPlanGatewayDecision {
  /** Whether an official endpoint was matched and the request is sent through the gateway instead. */
  readonly viaGateway: boolean;
  /** The URL actually sent; identical to the input when nothing matched. */
  readonly url: string;
}

export type OfficialCodingPlanGatewayFetch = typeof globalThis.fetch;

const ROOT_PATH = "/";
const HOST_HEADER = "host";
const HTTPS_DEFAULT_PORT = "443";

const GATEWAY_PATH_BY_PROVIDER_ENDPOINT: ReadonlyMap<string, string> = new Map(
  OFFICIAL_CODING_PLAN_GATEWAY_ROUTES.map((route) => [
    endpointKey(new URL(route.providerEndpoint)),
    route.gatewayPath,
  ]),
);

export function resolveOfficialCodingPlanGatewayUrl(
  requestUrl: string,
  env: EnvRecord = process.env,
): OfficialCodingPlanGatewayDecision {
  const parsed = parseHttpsUrl(requestUrl);
  if (!parsed) {
    return { viaGateway: false, url: requestUrl };
  }
  const gatewayPath = GATEWAY_PATH_BY_PROVIDER_ENDPOINT.get(endpointKey(parsed));
  if (!gatewayPath) {
    return { viaGateway: false, url: requestUrl };
  }
  const gatewayUrl = new URL(gatewayPath, resolveRuntimeZCodeEndpointOrigin(env));
  gatewayUrl.search = parsed.search;
  return { viaGateway: true, url: gatewayUrl.href };
}

/**
 * Wraps the model provider's fetch: matched official endpoints go to the gateway endpoint, every other request is handed to the lower fetch unchanged.
 * It should sit before the user's HTTP proxy fetch, so httpProxy / noProxy rules are judged against the gateway address actually sent.
 */
export function createOfficialCodingPlanGatewayFetch(options: {
  env?: EnvRecord;
  fetch: OfficialCodingPlanGatewayFetch;
}): OfficialCodingPlanGatewayFetch {
  return async (input, init) => {
    const requestUrl = readRequestUrl(input);
    if (!requestUrl) {
      return await options.fetch(input, init);
    }
    const decision = resolveOfficialCodingPlanGatewayUrl(requestUrl, options.env);
    if (!decision.viaGateway) {
      return await options.fetch(input, init);
    }
    // The explicit Host header will point to the host of the official model endpoint, which will be recalculated by fetch based on the actual URL after being sent through the gateway.
    const gatewayInput = withUrl(input, decision.url);
    if (gatewayInput instanceof Request) {
      gatewayInput.headers.delete(HOST_HEADER);
    }
    return await options.fetch(gatewayInput, withoutHostHeader(init));
  };
}

function withoutHostHeader(
  init: Parameters<OfficialCodingPlanGatewayFetch>[1],
): Parameters<OfficialCodingPlanGatewayFetch>[1] {
  if (!init?.headers) {
    return init;
  }
  const headers = new Headers(init.headers);
  if (!headers.has(HOST_HEADER)) {
    return init;
  }
  headers.delete(HOST_HEADER);
  return { ...init, headers };
}

function readRequestUrl(input: Parameters<OfficialCodingPlanGatewayFetch>[0]): string | undefined {
  try {
    if (input instanceof Request) {
      return input.url;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return new URL(String(input)).href;
  } catch {
    return undefined;
  }
}

function withUrl(
  input: Parameters<OfficialCodingPlanGatewayFetch>[0],
  url: string,
): Parameters<OfficialCodingPlanGatewayFetch>[0] {
  if (input instanceof Request) {
    return new Request(url, input);
  }
  if (input instanceof URL) {
    return new URL(url);
  }
  return url;
}

function parseHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function endpointKey(url: URL): string {
  const effectivePort = url.port || HTTPS_DEFAULT_PORT;
  return `${url.protocol}//${url.hostname.toLowerCase()}:${effectivePort}${normalizedPath(url.pathname)}`;
}

function normalizedPath(pathname: string): string {
  if (pathname === ROOT_PATH) {
    return ROOT_PATH;
  }
  return pathname.replace(/\/+$/u, "") || ROOT_PATH;
}
