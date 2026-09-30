import { downloadZCodeBuiltinRelease, type ZCodeBuiltinRelease } from "@zcode/provider-node";
import type { ApiClient } from "@zcode/shared";

interface FetchZCodeBuiltinRemoteReleaseOptions {
  readonly apiClient: ApiClient;
  readonly endpointOrigin: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly signal?: AbortSignal;
}

/** Services only inject the existing network wiring; the URL, budget and Release validation are implemented exclusively by provider-node. */
export async function fetchZCodeBuiltinRemoteRelease(
  options: FetchZCodeBuiltinRemoteReleaseOptions,
): Promise<ZCodeBuiltinRelease | null> {
  return downloadZCodeBuiltinRelease({
    endpointOrigin: options.endpointOrigin,
    appVersion: options.appVersion,
    platform: options.platform,
    signal: options.signal,
    request: (url, init) => options.apiClient.request(url, init),
  });
}
