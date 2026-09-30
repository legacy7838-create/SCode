/**
 * SEA native runtime: make the compiled `@zcode/rust` `.node` binaries loadable from
 * inside a single-file `zcode` binary.
 *
 * Why this exists. A `.node` cannot be `require()`-d straight out of a SEA blob: the blob
 * is reached through `sea.getRawAsset()`, not the filesystem, and a napi addon needs a
 * real path. The desktop surface solves this at build time by staging a `native/`
 * directory next to the agent bundle (`docs/specs/rust-native-packaging.md` D2); a SEA
 * binary has no such directory, so the same approach used by every other native asset in
 * this CLI applies — read the raw asset, verify it, write it to a content-addressed cache
 * directory, and swap that directory in atomically. See `sea-playwright-runtime.ts`,
 * which this mirrors.
 *
 * NO JS FALLBACK (docs/specs/rust-native-ports.md invariant 1). In a SEA binary this either
 * extracts a verified payload and points `ZCODE_NATIVE_DIR` at it, or it throws. There is no
 * `try { native } catch { js }` branch, no degraded mode, and no environment switch that
 * changes which implementation runs. Outside SEA the function is a no-op, because the
 * `node_modules/@zcode/rust` route already resolves the same binaries there (spec §1.5a) —
 * that is a platform binding, not a fallback.
 *
 * The manifest (file list + every sha256 + the content-addressed cache key) is produced by
 * `zcode-packaging sea-assets`, so the Rust tool owns the payload decision; this module
 * only moves the bytes it named.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";

declare const __CLI_VERSION__: string;

type SeaModule = typeof import("node:sea");

interface SeaNativeFile {
  key: string;
  name: string;
  bytes: number;
  sha256: string;
}

interface SeaNativeManifest {
  version: 1;
  target: string;
  suffix: string;
  cacheKey: string;
  files: SeaNativeFile[];
}

/** Must match `plan::SEA_NATIVE_ASSET_PREFIX` in zcode-packaging. */
const ASSET_PREFIX = "native/";
/** Must match `plan::SEA_MANIFEST_ASSET_KEY` in zcode-packaging. */
const MANIFEST_ASSET_KEY = "native-manifest.json";
const MARKER_FILE = "native-manifest.json";

/**
 * Extracts the native payload when running inside a SEA binary, and points
 * `ZCODE_NATIVE_DIR` at it so the synchronous `loadNative()` in `@zcode/rust` resolves on
 * its first call.
 *
 * Returns the cache directory, or `undefined` when not running under SEA. Throws on a
 * hash mismatch or an unusable manifest — never falls back.
 */
export async function installSeaNativeRuntime(): Promise<string | undefined> {
  const sea = await import("node:sea");
  if (!sea.isSea()) return undefined;

  const manifest = readManifest(sea);
  const cacheDirectory = join(
    cacheBaseDirectory(),
    __CLI_VERSION__,
    manifest.target,
    manifest.cacheKey,
  );
  const markerPath = join(cacheDirectory, MARKER_FILE);

  if (!(await isCacheCurrent(markerPath, manifest))) {
    await extractNativePayload(sea, manifest, cacheDirectory, markerPath);
  }

  // `loadNative()` checks this first (loader.ts candidate 1). It is a path override, not
  // an implementation switch: the bytes and the loader are identical either way.
  process.env.ZCODE_NATIVE_DIR = cacheDirectory;
  return cacheDirectory;
}

function readManifest(sea: SeaModule): SeaNativeManifest {
  const parsed = JSON.parse(sea.getAsset(MANIFEST_ASSET_KEY, "utf8")) as SeaNativeManifest;
  if (
    parsed.version !== 1 ||
    typeof parsed.target !== "string" ||
    typeof parsed.cacheKey !== "string" ||
    !Array.isArray(parsed.files) ||
    parsed.files.length === 0
  ) {
    // A SEA binary with no native payload is a broken build, not a reason to run without
    // the binaries: `loadNative()` would throw on the first call anyway, only later and
    // with a worse message.
    throw new Error("Invalid SEA native runtime manifest");
  }
  return parsed;
}

function cacheBaseDirectory(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "zcode");
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA;
    if (!base) throw new Error("LOCALAPPDATA is not set; cannot locate the native cache");
    return join(base, "zcode", "Cache");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg ? join(xdg, "zcode") : join(homedir(), ".cache", "zcode");
}

async function extractNativePayload(
  sea: SeaModule,
  manifest: SeaNativeManifest,
  cacheDirectory: string,
  markerPath: string,
): Promise<void> {
  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporaryDirectory, { force: true, recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });

  try {
    for (const file of manifest.files) {
      assertSafeRuntimeName(file.name);
      const bytes = Buffer.from(sea.getRawAsset(file.key));
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== file.sha256) {
        throw new Error(`SEA native asset hash mismatch for ${file.name}`);
      }
      await writeFile(join(temporaryDirectory, file.name), bytes);
    }

    await writeFile(join(temporaryDirectory, MARKER_FILE), JSON.stringify(manifest, null, 2));
    await mkdir(join(cacheDirectory, ".."), { recursive: true });
    await rm(cacheDirectory, { force: true, recursive: true });
    // Atomic swap: a concurrent process either sees the old complete directory or the new
    // one, never a half-written payload.
    await rename(temporaryDirectory, cacheDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw error;
  }
  // The marker is written inside the temp directory, so its presence is implied by the
  // rename; this read keeps the parameter meaningful and asserts the swap landed.
  if (!existsSync(markerPath)) {
    throw new Error(`SEA native cache marker missing after install: ${markerPath}`);
  }
}

async function isCacheCurrent(markerPath: string, expected: SeaNativeManifest): Promise<boolean> {
  if (!existsSync(markerPath)) return false;
  try {
    const current = JSON.parse(await readFile(markerPath, "utf8")) as SeaNativeManifest;
    // The cache key already covers the file list and every content hash, so comparing it
    // is sufficient; target is compared as a second guard against a mis-keyed cache.
    return current.cacheKey === expected.cacheKey && current.target === expected.target;
  } catch {
    return false;
  }
}

/**
 * A manifest file name must be a bare `.node` file name.
 *
 * The manifest is embedded in the binary, so a hostile name cannot be introduced without
 * editing the build — but it still has to be constrained, because a `../` here would let a
 * tampered blob write outside the cache directory. Mirrors `assertSafeRuntimePath` in
 * `sea-playwright-runtime.ts:108-117`.
 */
function assertSafeRuntimeName(name: string): void {
  const normalized = normalize(name);
  if (
    normalized !== name ||
    normalized.includes(sep) ||
    normalized.startsWith("..") ||
    !name.endsWith(".node") ||
    !name.startsWith("zcode-")
  ) {
    throw new Error(`Invalid SEA native asset name: ${name}`);
  }
}
