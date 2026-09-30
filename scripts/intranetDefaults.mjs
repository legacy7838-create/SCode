import { loadEndpointEnv } from "./load-endpoint-env.mjs";
const endpointEnv = await loadEndpointEnv();
export const DEFAULT_INTRANET_MACHINE_HOST = "";
export function resolveIntranetMachineHost(env = { ...endpointEnv, ...process.env }) {
  // The address of the self-built mirror machine is uniformly read from INTRANET_MACHINE_HOST to avoid multiple hard-coded missed changes.
  return env.INTRANET_MACHINE_HOST?.trim() || DEFAULT_INTRANET_MACHINE_HOST;
}

export const INTRANET_MACHINE_HOST = resolveIntranetMachineHost();
export const INTRANET_ASSET_SERVICE_PORT = 12345;
export const INTRANET_ASSET_BASE_URL = INTRANET_MACHINE_HOST
  ? `http://${INTRANET_MACHINE_HOST}:${INTRANET_ASSET_SERVICE_PORT}/zcode`
  : "";
export const INTRANET_DEPS_BASE_URL = INTRANET_ASSET_BASE_URL
  ? `${INTRANET_ASSET_BASE_URL}/deps`
  : "";

export function resolveIntranetDepsBaseUrl(env = process.env) {
  env = { ...endpointEnv, ...env };
  const depsBaseUrl = env.ZCODE_DEPS_BASE_URL?.trim();
  if (depsBaseUrl) {
    return depsBaseUrl.replace(/\/+$/, "");
  }

  const host = resolveIntranetMachineHost(env);
  if (!host)
    throw new Error(
      "Configure ZCODE_DEPS_BASE_URL or INTRANET_MACHINE_HOST in .env before downloading internal dependencies",
    );
  return `http://${host}:${INTRANET_ASSET_SERVICE_PORT}/zcode/deps`;
}
