import {
  buildRuntimeZCodeEndpointUrls,
  ZCODE_ENV,
  type RuntimeZCodeEndpointEnv,
} from "@zcode/shared";

interface RendererImportMetaEnv {
  VITE_ZCODE_BASE_URL?: string;
  VITE_ZCODE_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

function createRendererZCodeEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeZCodeEndpointEnv {
  return {
    ZCODE_ENV,
    // The zcode-plan placeholder provider on the UI side used to only look at ZCODE_ENV.
    // The base url injected by Vite is not consumed, causing the renderer and host/service to be inconsistent when customizing the test domain name.
    ZCODE_BASE_URL: env.VITE_ZCODE_BASE_URL,
    ZCODE_ENDPOINT_ORIGIN: env.VITE_ZCODE_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_ZCODE_ENDPOINT_URLS = buildRuntimeZCodeEndpointUrls(
  createRendererZCodeEndpointEnv(),
);
