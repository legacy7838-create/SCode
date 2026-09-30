import type { ApiClient } from "@zcode/shared";
import {
  buildRuntimeZCodeEndpointUrls,
  normalizeOfficialGlmModelId,
  ZCODE_VERSION,
} from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";

const REQUEST_TIMEOUT_MS = 15_000;
const ZAI_START_PLAN_BALANCE_URL = buildRuntimeZCodeEndpointUrls(
  process.env,
).zcodePlanBillingBalanceUrl;

export interface ZaiStartPlanPlan {
  // user_plan_id identifies the user plan instance; the quota reminder uses it to associate the entitlement cycle type of the same instance.
  user_plan_id?: string;
  plan_id?: string;
  name?: string;
  status?: string;
  starts_at?: number | string | null;
  ends_at?: number | string | null;
  entitlements?: Array<{
    entitlement_id?: string | null;
    show_name?: string | null;
    period?: string | null;
    effective_at?: number | string | null;
  }>;
}

export interface ZaiStartPlanBalanceEnvelope {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: {
    server_time?: number;
    plans?: ZaiStartPlanPlan[];
    balances?: Array<{
      bucket_id?: string;
      user_plan_id?: string;
      plan_id?: string;
      entitlement_id?: string;
      show_name?: string;
      meter?: string;
      unit_type?: string;
      capabilities?: string[];
      total_units?: number | string | null;
      used_units?: number | string | null;
      reserved_units?: number | string | null;
      remaining_units?: number | string | null;
      available_units?: number | string | null;
      period_start?: number | string | null;
      period_end?: number | string | null;
      expires_at?: number | string | null;
    }>;
  };
}

const inflightBalanceRequests = new WeakMap<
  ApiClient,
  Map<string, Promise<ZaiStartPlanBalanceEnvelope>>
>();

export function buildZaiStartPlanBalanceUrl(): string {
  const url = new URL(ZAI_START_PLAN_BALANCE_URL);
  // The Start Plan balance interface determines capabilities based on the real app_version;
  // The development environment cannot be fixed to 3.0.0, otherwise local verification will bypass the backend policy of the current App version.
  url.searchParams.set("app_version", ZCODE_VERSION);
  return url.toString();
}

export async function fetchZaiStartPlanBalanceEnvelope(
  apiClient: ApiClient,
  authorization: string,
  invalidateCache = false,
): Promise<ZaiStartPlanBalanceEnvelope> {
  const requestKey = JSON.stringify({
    authorization: authorization.trim(),
    url: buildZaiStartPlanBalanceUrl(),
  });

  let requests = inflightBalanceRequests.get(apiClient);
  if (!requests) {
    requests = new Map();
    inflightBalanceRequests.set(apiClient, requests);
  }

  if (invalidateCache) requests.delete(requestKey);
  const inflight = requests.get(requestKey);
  if (inflight) {
    return inflight;
  }

  const url = buildZaiStartPlanBalanceUrl();
  const startedAt = Date.now();
  let responseTime: number | undefined;
  const observedApi: ApiClient = {
    request: async (input, init) => {
      const response = await apiClient.request(input, init);
      const date = Date.parse(response.headers.get("date") ?? "");
      if (Number.isFinite(date)) responseTime = date / 1000;
      return response;
    },
  };
  const request = readApiJson<ZaiStartPlanBalanceEnvelope>(observedApi, url, {
    method: "GET",
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: authorization,
    },
  })
    .then((payload) => normalizeStartPlanExpiry(payload, responseTime))
    .finally(() => {
      // The account verification is completed first, and the usage query arrives later: the same response is retained until 1 second after initiation.
      // Failures are also retained to avoid repeated requests immediately after 429; old requests must not delete new records created after the failure.
      const evict = () => {
        if (requests?.get(requestKey) !== request) return;
        requests.delete(requestKey);
        if (requests.size === 0) inflightBalanceRequests.delete(apiClient);
      };
      const remainingMs = 1000 - (Date.now() - startedAt);
      if (remainingMs > 0) setTimeout(evict, remainingMs);
      else evict();
    });

  requests.set(requestKey, request);
  return request;
}

export function resolveZaiStartPlanBalanceModelIds(payload: ZaiStartPlanBalanceEnvelope): string[] {
  const seen = new Set<string>();
  const modelIds: string[] = [];

  for (const balance of payload.data?.balances ?? []) {
    const fromCapabilities = (balance.capabilities ?? [])
      .map((capability) => {
        const normalized = capability.trim();
        return normalized.toLowerCase().startsWith("model:")
          ? normalized.slice("model:".length).trim()
          : "";
      })
      .filter(Boolean);
    const candidates = fromCapabilities.length > 0 ? fromCapabilities : [balance.show_name ?? ""];
    for (const candidate of candidates) {
      const modelId = normalizeOfficialGlmModelId(candidate.trim());
      const key = modelId.toLowerCase();
      if (!modelId || seen.has(key)) {
        continue;
      }
      seen.add(key);
      modelIds.push(modelId);
    }
  }

  return modelIds;
}

/** HTTP Date is paired with this response to avoid using old JSON time to allow expired active records to continue to provide benefits. */
function normalizeStartPlanExpiry(
  payload: ZaiStartPlanBalanceEnvelope,
  responseTime?: number,
): ZaiStartPlanBalanceEnvelope {
  if (!payload.data) return payload;
  const serverTime = payload.data.server_time;
  const now =
    responseTime ??
    (typeof serverTime === "number" && Number.isFinite(serverTime) && serverTime >= 0
      ? serverTime
      : Date.now() / 1000);
  const plans = (payload.data.plans ?? []).map((plan) => {
    const end = Number(plan.ends_at);
    return plan.status?.trim().toLowerCase() === "active" &&
      Number.isFinite(end) &&
      end > 0 &&
      end <= now
      ? { ...plan, status: "expired" }
      : plan;
  });
  const balances = payload.data.balances?.filter((balance) => {
    const owners = plans.filter((plan) =>
      balance.user_plan_id && plan.user_plan_id
        ? plan.user_plan_id === balance.user_plan_id
        : plan.plan_id === balance.plan_id,
    );
    // Unowned buckets will continue to be processed by the existing diagnosis, and the balance of another valid instance of the same product cannot be deleted by mistake.
    return !owners.length || owners.some((plan) => plan.status?.trim().toLowerCase() !== "expired");
  });
  return { ...payload, data: { ...payload.data, plans, balances } };
}
