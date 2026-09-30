import { getCapturedZCodeAgentTelemetryEnv } from "@zcode/shared";
import {
  prepareModelTelemetryEnv,
  shutdownPreparedModelTelemetry,
  type PrepareModelTelemetryOptions,
} from "@zcode/telemetry";

/**
 * Called by the official CLI's async entry point before the synchronous App is created; it only puts the prepared
 * device MID back into the business env, while private configuration such as the OTLP Header stays in the in-process
 * captured area and never enters the Tool/MCP subprocess environment.
 */
export async function prepareZCodeTelemetryEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: PrepareModelTelemetryOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const prepared = await prepareModelTelemetryEnv({
    ...getCapturedZCodeAgentTelemetryEnv(),
    ...env,
  }, {
    ...options,
    productVersion: options.productVersion ?? env.ZCODE_APP_VERSION,
  });
  const deviceMid = prepared.ZCODE_TELEMETRY_DEVICE_MID;
  return deviceMid ? { ...env, ZCODE_TELEMETRY_DEVICE_MID: deviceMid } : env;
}

/**
 * Closes the Telemetry Owner held by the current process, symmetrically with prepareZCodeTelemetryEnv.
 * A single App/Session is only allowed to flush; only the outermost executable entry point may call this function.
 */
export async function shutdownZCodeTelemetry(): Promise<void> {
  await shutdownPreparedModelTelemetry();
}
