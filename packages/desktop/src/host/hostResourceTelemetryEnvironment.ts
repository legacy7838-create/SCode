import { createHash } from "node:crypto";
import { buildRemoteEnvironmentKey, type RemoteTarget } from "@zcode/shared";

/** Remote environments of the same spec must not be merged; only a hash of the canonical environment identity is passed, so raw addresses never enter the telemetry side channel. */
export function resolveResourceTelemetryEnvironmentKey(target: RemoteTarget): string {
  return createHash("sha256").update(buildRemoteEnvironmentKey(target)).digest("hex");
}
