import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { ZCODE_AGENT_RUNTIME } from "@zcode/shared";

const packagedResourcesPath =
  typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
    ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    : null;

function resolveExistingPath(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolvePlatformScopedBundledAgentRoots(moduleDir?: string): Array<string | null> {
  const platformKey = `${process.platform}-${process.arch}`;
  return [
    resolvePath(process.cwd(), "bundled-agents", platformKey),
    // The bundles live at `<repo>/packages/bundled-agents/<platform>` now. Three of these
    // candidates used to route through `packages/desktop`, which Electron's removal deleted,
    // and one of them (`../../desktop`) pointed at `packages/services/desktop` — a path that
    // never existed. What remains is the repo-root entry, the `packages/` entry, and the
    // module-relative walk up to `packages/`.
    resolvePath(process.cwd(), "packages", "bundled-agents", platformKey),
    // dev:web starts with `pnpm --filter @zcode/server dev`, so cwd is packages/server and a
    // cwd-relative candidate misses the repo root. Resolve from this module as well, so both
    // layouts find the same directory.
    moduleDir ? resolvePath(moduleDir, "..", "..", "..", "bundled-agents", platformKey) : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "bundled-agents", platformKey) : null,
  ];
}

function resolveLegacyBundledResourceRoots(moduleDir?: string): Array<string | null> {
  return [
    resolvePath(process.cwd(), "bundled-resources"),
    resolvePath(process.cwd(), "packages", "bundled-resources"),
    moduleDir ? resolvePath(moduleDir, "..", "..", "..", "bundled-resources") : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "bundled-resources") : null,
  ];
}

export function findZCodeAgentRuntimeBinary(): string | null {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];
  const envPath = process.env[runtime.binaryEnvVar];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // import.meta.dirname is undefined in the packaged CJS bundle (zcode-server.cjs),
  // Passing it directly to resolvePath will report "paths[0]" argument must be of type string.
  // Null value protection is implemented here, and the corresponding candidate path is constructed only when import.meta.dirname exists.
  const moduleDir: string | undefined = import.meta.dirname;
  const platformScopedRoots = resolvePlatformScopedBundledAgentRoots(moduleDir);
  const legacyRoots = resolveLegacyBundledResourceRoots(moduleDir);

  const candidates = [
    packagedResourcesPath ? resolvePath(packagedResourcesPath, ...resourceSegments) : null,
    resolvePath(homedir(), ".zcode", "server", "agents", ...resourceSegments),
    ...platformScopedRoots.map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
    ...legacyRoots.map((root) => (root ? resolvePath(root, ...resourceSegments) : null)),
  ];
  return resolveExistingPath(candidates);
}

/**
 * Locates the agent's JS bundle (resources/glm/zcode.cjs).
 * The bundle is executed by a Node runtime shipped alongside it; no Electron Node runtime exists
 * any more (the Electron app and its packaging were deleted wholesale). The candidate directories
 * are exactly parallel to findZCodeAgentRuntimeBinary, only the entry point is the platform-independent
 * nodeBundleEntryFile. GLM_BINARY_PATH is not consulted — that env var points at a native binary, which
 * is a different thing.
 */
export function findZCodeAgentRuntimeNodeBundle(): string | null {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveNodeBundleSegments();
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];

  // Consistent with findZCodeAgentRuntimeBinary, import.meta.dirname in the packaged CJS bundle is undefined.
  // Here, after performing null value protection, candidate paths in the warehouse are constructed.
  const moduleDir: string | undefined = import.meta.dirname;
  const platformScopedRoots = resolvePlatformScopedBundledAgentRoots(moduleDir);
  const legacyRoots = resolveLegacyBundledResourceRoots(moduleDir);

  const candidates = [
    packagedResourcesPath ? resolvePath(packagedResourcesPath, ...resourceSegments) : null,
    resolvePath(homedir(), ".zcode", "server", "agents", ...resourceSegments),
    ...platformScopedRoots.map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
    ...legacyRoots.map((root) => (root ? resolvePath(root, ...resourceSegments) : null)),
  ];
  return resolveExistingPath(candidates);
}
