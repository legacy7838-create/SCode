import type { ZCodeRuntimeEnv } from "./runtimeEnv.js";

export type ZCodeEnv = "test" | "production";
/** Installer package identity: it determines the app name, app id, Electron data directory, and update strategy; it is a separate axis from the backend environment `ZCodeEnv`. */
export type ZCodeProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// define does not exist in non-build environments (such as mocha tested by e2e), use typeof check + fallback to avoid ReferenceError
declare const __ZCODE_ENV__: string;
declare const __ZCODE_PRODUCT_FLAVOR__: string;

export function normalizeZCodeEnv(value: string | undefined): ZCodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ZCODE_ENV = normalizeZCodeEnv(
  typeof __ZCODE_ENV__ !== "undefined" ? __ZCODE_ENV__ : undefined,
);

/**
 * The identity default follows the backend environment (test → preview, production → production).
 * Desktop builds explicitly inject preview via `ZCODE_PREVIEW_IDENTITY=1`, yielding a Preview build
 * that connects to the production backend; bundles without that define (web, CLI, tests) keep the
 * old single-axis semantics.
 */
export function normalizeZCodeProductFlavor(
  value: string | undefined,
  zcodeEnv: ZCodeEnv,
): ZCodeProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview") {
    return normalized;
  }
  return zcodeEnv === "production" ? "production" : "preview";
}

export const ZCODE_PRODUCT_FLAVOR = normalizeZCodeProductFlavor(
  typeof __ZCODE_PRODUCT_FLAVOR__ !== "undefined" ? __ZCODE_PRODUCT_FLAVOR__ : undefined,
  ZCODE_ENV,
);
export const ZCODE_APP_VERSION_ENV = "ZCODE_APP_VERSION" as const;
export const ZCODE_BUILD_COMMIT_ID_ENV = "ZCODE_BUILD_COMMIT_ID" as const;

// ── Runtime environment variables (not compiled and packaged, read from process.env at startup) ──
// Enable debugging mode, the value is the port number of inspect-brk, such as ZCODE_DEBUG=9230
export const RUNTIME_ZCODE_DEBUG =
  typeof process !== "undefined" ? process.env.ZCODE_DEBUG : undefined;

// Reason for recovery: Hard-coding false will cause the configured data warehouse/ARMS to idle forever.
// The function remains available; the actual network access is determined by the runtime endpoint check of each exit, and will not be reported if it is not configured.
export const ZCODE_TELEMETRY_ENABLED: boolean = true;

/** Data warehouse event reporting endpoint: supplied by a runtime environment variable, disabled when unset, and never baked into build artifacts. */
export const ZCODE_TELEMETRY_REPORT_ENDPOINT =
  typeof process !== "undefined" ? (process.env.ZCODE_TELEMETRY_REPORT_ENDPOINT ?? "") : "";

/** ARMS RUM ingestion endpoint: supplied by a runtime environment variable, disabled when unset, and never baked into build artifacts. */
export const ZCODE_ARMS_RUM_ENDPOINT =
  typeof process !== "undefined" ? (process.env.ZCODE_ARMS_RUM_ENDPOINT ?? "") : "";

/** Maps the local runtime state and the compile-time ZCODE_ENV to the reporting environment label recognized by the ARMS console */
export function mapZCodeEnvToArmsRumEnv(runtimeEnv: ZCodeRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && ZCODE_ENV === "production" ? "prod" : "local";
}
