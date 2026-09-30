import {
  buildZCodeEndpointUrls,
  clientConfigReadOptionsSchema,
  parseClientConfigSnapshot,
  type ApiClient,
  type ClientConfigSnapshot,
} from "@zcode/shared";
import type { IClientConfigService } from "./clientConfig.js";

const CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

interface RequestContext {
  endpointOrigin: string;
  appVersion: string;
  platform: string;
}

interface CacheEntry {
  snapshot?: ClientConfigSnapshot;
  expiresAt: number;
  pending?: Promise<ClientConfigSnapshot>;
}

/** First release only exposes configuration; account gradual rollout must not be reused through this instance or its cache. */
export function createClientConfigService(dependencies: {
  apiClient: ApiClient;
  resolveRequestContext: () => RequestContext | Promise<RequestContext>;
}): IClientConfigService {
  const entries = new Map<string, CacheEntry>();

  async function fetchSnapshot(url: URL): Promise<ClientConfigSnapshot> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Public client config request timed out"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await dependencies.apiClient.request(url, {
            method: "GET",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Public client config HTTP ${response.status}`);
          // The endpoint in the setting may change between awaits; the response from the new address cannot be cached to the old address.
          if (response.url && response.url !== url.toString()) {
            throw new Error("Public client config request context changed");
          }
          return parseClientConfigSnapshot(await response.json());
        })(),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async getSnapshot(options = {}) {
      const { forceRefresh } = clientConfigReadOptionsSchema.parse(options);
      const context = await dependencies.resolveRequestContext();
      const url = new URL(
        "/api/v1/client/configs",
        buildZCodeEndpointUrls(context.endpointOrigin).origin,
      );
      url.searchParams.set("app_version", context.appVersion);
      url.searchParams.set("platform", context.platform);
      const key = url.toString();
      const entry = entries.get(key) ?? { expiresAt: 0 };
      entries.set(key, entry);
      if (!forceRefresh && entry.snapshot && entry.expiresAt > Date.now()) {
        return structuredClone(entry.snapshot);
      }
      if (!entry.pending) {
        entry.pending = fetchSnapshot(url)
          .then((snapshot) => {
            entry.snapshot = snapshot;
            entry.expiresAt = Date.now() + CACHE_TTL_MS;
            return snapshot;
          })
          .finally(() => {
            entry.pending = undefined;
          });
      }
      return structuredClone(await entry.pending);
    },
  };
}
