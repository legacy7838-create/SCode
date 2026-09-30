export interface E2ETestBridgeEnvironment {
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
  ZCODE_E2E_RUN_ID?: string;
}

/**
 * The E2E capability in Main/preload must match both the dedicated build flag and a real runner run id.
 * ZCODE_ENV=test is only the product environment and must not be used to widen what the renderer can read.
 */
export function shouldEnableE2ETestBridge(env: E2ETestBridgeEnvironment): boolean {
  return env.VITE_ZCODE_E2E_STORE_BRIDGE === "1" && Boolean(env.ZCODE_E2E_RUN_ID?.trim());
}
