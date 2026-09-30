import { createHash } from "node:crypto";
import { join } from "node:path";

export function resolveZCodeBuiltinClientPlatform(): string {
  const target = process.platform === "win32" ? "windows" : process.platform;
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${target}-${arch}`;
}

export interface ZCodeBuiltinCachePathOptions {
  readonly environmentConfigRoot: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly zcodeEndpointOrigin: string;
}

export interface ZCodeBuiltinCachePaths {
  readonly activeFilePath: string;
  readonly controlFilePath: string;
}

/** Active/LKG are isolated per platform and app version; the path itself is the compatibility scope. */
export function resolveZCodeBuiltinCachePaths(
  options: ZCodeBuiltinCachePathOptions,
): ZCodeBuiltinCachePaths {
  const platform = normalizeSegment(options.platform, "platform");
  const appVersion = normalizeSegment(options.appVersion, "appVersion");
  const endpointKey = createZCodeBuiltinEndpointKey(options.zcodeEndpointOrigin);
  const directory = join(
    options.environmentConfigRoot,
    "runtime",
    "provider",
    platform,
    appVersion,
    endpointKey,
  );
  return {
    activeFilePath: join(directory, "zcode-builtin.json"),
    controlFilePath: join(directory, "zcode-builtin-refresh.json"),
  };
}

/** Normalizes the ZCode control-plane origin, then maps it to a safe, stable cache path segment with negligible collision risk. */
export function createZCodeBuiltinEndpointKey(zcodeEndpointOrigin: string): string {
  const normalized = normalizeZCodeBuiltinEndpointOrigin(zcodeEndpointOrigin);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `endpoint-${digest}`;
}

export function normalizeZCodeBuiltinEndpointOrigin(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("ZCode Built-in Endpoint Origin must not be empty");
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ZCode Built-in Endpoint Origin only supports HTTP(S)");
  }
  return url.origin;
}

function normalizeSegment(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === ".." || /[\\/]/u.test(normalized)) {
    throw new Error(`ZCode Built-in ${name} is not a valid path segment`);
  }
  return normalized;
}
