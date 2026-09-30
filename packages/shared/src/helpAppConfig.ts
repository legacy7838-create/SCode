import { z } from "zod";
import { buildZCodeEndpointUrls } from "./zcodeEndpoint.js";
import { getCommunityUrlFromConfigs, getFeedbackUrlFromConfig } from "./remoteAppConfig.js";

const helpConfigSchema = z.object({
  community_urls: z
    .object({
      "en-US": z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  feedback_url: z.string().optional().catch(undefined),
  feedback_use_external_form: z.boolean().optional().catch(undefined),
});
const envelopeSchema = z.object({
  code: z.literal(0),
  data: z.object({ configs: z.object({ feedbackUrl: helpConfigSchema }) }),
});
export type HelpAppConfig = z.infer<typeof helpConfigSchema>;

export function buildHelpAppConfigUrl(
  endpoint: string,
  version: string,
  platform?: string,
): string {
  const url = new URL("/api/v1/client/configs", buildZCodeEndpointUrls(endpoint).origin);
  url.searchParams.set("app_version", version);
  if (platform) url.searchParams.set("platform", platform);
  return url.toString();
}

export function resolveHelpAppConfig(remote: unknown, local: unknown): HelpAppConfig {
  const remoteConfig = helpConfigSchema.safeParse(remote).data;
  const localConfig = helpConfigSchema.safeParse(local).data;
  return {
    community_urls: {
      "en-US": getCommunityUrlFromConfigs(remoteConfig, localConfig, "en-US"),
    },
    feedback_url: getFeedbackUrlFromConfig(remoteConfig) ?? getFeedbackUrlFromConfig(localConfig),
    // false is explicitly configured on the remote end and cannot fall back to local true after truthy judgment.
    feedback_use_external_form:
      remoteConfig?.feedback_use_external_form ?? localConfig?.feedback_use_external_form ?? false,
  };
}

/** The public help config is memory-cached only; it never shares the user-authenticated rollout response. */
export function createHelpAppConfigReader(options: {
  fetchImpl: typeof fetch;
  now?: () => number;
}) {
  const entries = new Map<
    string,
    { expiresAt: number; value?: HelpAppConfig; pending?: Promise<HelpAppConfig> }
  >();
  const now = options.now ?? Date.now;
  return async (url: string, headers?: RequestInit["headers"]): Promise<HelpAppConfig> => {
    for (const [key, entry] of entries) {
      if (!entry.pending && entry.expiresAt <= now()) entries.delete(key);
    }
    const cached = entries.get(url);
    if (cached?.pending) return cached.pending;
    if (cached?.value && cached.expiresAt > now()) return cached.value;
    const entry: { expiresAt: number; value?: HelpAppConfig; pending?: Promise<HelpAppConfig> } = {
      expiresAt: 0,
    };
    entries.set(url, entry);
    entry.pending = (async () => {
      const response = await options.fetchImpl(url, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Help config HTTP ${response.status}`);
      const value = envelopeSchema.parse(await response.json()).data.configs.feedbackUrl;
      entry.value = value;
      entry.expiresAt = now() + 60 * 60 * 1000;
      return value;
    })();
    try {
      return await entry.pending;
    } catch (error) {
      entries.delete(url);
      throw error;
    } finally {
      entry.pending = undefined;
    }
  };
}
