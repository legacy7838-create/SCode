import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  ZCODE_VERSION,
  buildHelpAppConfigUrl,
  createHelpAppConfigReader,
  resolveHelpAppConfig,
  type Locale,
} from "@zcode/shared";
import localDefaultAppConfig from "../../../config/default.json" with { type: "json" };

interface ResolveWebCommunityUrlOptions {
  fetchImpl?: typeof fetch;
  localConfig?: unknown;
  endpointOrigin?: string;
}

const readHelpConfig = createHelpAppConfigReader({
  fetchImpl: (input, init) => fetch(input, init),
});

export async function resolveWebHelpConfig(options: ResolveWebCommunityUrlOptions = {}) {
  const env = import.meta.env;
  const endpoint =
    options.endpointOrigin ??
    (env?.VITE_ZCODE_BASE_URL?.trim() ||
      env?.VITE_ZCODE_ENDPOINT_ORIGIN?.trim() ||
      DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  // The server rejects platform=web; the browser omits the optional platform parameter to avoid pretending to be a desktop system.
  const url = buildHelpAppConfigUrl(endpoint, ZCODE_VERSION);
  let remote: unknown;
  try {
    remote = await (
      options.fetchImpl
        ? createHelpAppConfigReader({ fetchImpl: options.fetchImpl })
        : readHelpConfig
    )(url);
  } catch {
    // Preserves the built-in portal when the remote is unavailable and does not use the old CDN as a second remote configuration source.
  }
  return resolveHelpAppConfig(remote, options.localConfig ?? localDefaultAppConfig);
}

export async function resolveWebCommunityUrl(
  locale: Locale,
  options: ResolveWebCommunityUrlOptions = {},
): Promise<string | undefined> {
  return (await resolveWebHelpConfig(options)).community_urls?.[locale];
}
