import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Logger, SkillRoot } from "@zcode/contracts";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import { candidateBaseDirs } from "./bundled-plugins.js";

/**
 * The skill pack bundled inside the CLI (apps/zcode-cli/packages/bundled-skills).
 *
 * It is not a plugin: it is not in the official marketplace catalog, has no enable/disable switch, cannot be uninstalled, and never appears in the settings page or the `$` reference panel.
 * The tools of a product feature are registered by the runtime, and the matching skills ship with the CLI, so that uninstalling a plugin cannot leave a tool without usage instructions.
 *
 * All three run shapes resolve to the same skills directory:
 * - dev mode / Electron desktop: find `packages/bundled-skills` next to the entry point through the same candidate directories as official plugins, read in place, no copying.
 * - SEA binary: the assets are embedded under the `zcode-bundled-skills/` prefix and are unpacked by content hash on first launch into
 *   `<cli storage>/bundled-skills/<hash>/`; the directory name is the content identity, so repeated launches are idempotent and concurrent ones have a single winner.
 * - remote host: prepare-prebuilds stages the directory next to the remote zcode.cjs, the same route as the desktop.
 */

export const BUNDLED_SKILL_PACK_DIRECTORY_NAME = "bundled-skills";
export const BUNDLED_SKILL_PACK_SKILLS_DIRECTORY = "skills";
/** The gate shares one name with the skill pack: the constant lives in contracts (core's skill gate reads it too), it is only re-exported here. */
export { DYNAMIC_WORKFLOW_SKILL_NAME };

/** Every file in the pack is a required asset: losing any one of them rejects the whole pack, rather than installing a skill whose file references are missing. */
export const BUNDLED_SKILL_PACK_REQUIRED_PATHS = [
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/SKILL.md`,
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/patterns.md`,
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/examples.md`,
] as const;

/** Shaped like official-plugin-definitions' rootCandidates, covering the monorepo src/dist, cli/dist and desktop resources/glm layouts. */
const BUNDLED_SKILL_PACK_ROOT_CANDIDATES = [
  `packages/${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../../../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
] as const;

export const SEA_BUNDLED_SKILL_ASSET_PREFIX = "zcode-bundled-skills/";
const SEA_BUNDLED_SKILL_MANIFEST_ASSET_KEY = `${SEA_BUNDLED_SKILL_ASSET_PREFIX}manifest.json`;
const SEED_MARKER_FILE = ".zcode-bundled-skills-seed.json";

/**
 * Ordered after every plugin root (the adapters plugin roots start at FIRST_PLUGIN_PRIORITY and count up): for same-named skills the first one in discovery order wins,
 * so a same-named skill in the user/project/plugin should always beat the bundled pack.
 */
const BUNDLED_SKILL_ROOT_PRIORITY = 1_000_000;

interface SeaBundledSkillManifest {
  files: Array<{ mode?: number; path: string; sha256: string }>;
  hash: string;
  version: 1;
}

type SeaModule = typeof import("node:sea");

export interface ResolveBundledSkillRootsOptions {
  /** `getCliStorageRoot(storage.dir)`; only SEA unpacking needs it. */
  cliStorageRoot: string;
  logger?: Logger;
}

export async function resolveBundledSkillRoots(
  options: ResolveBundledSkillRootsOptions,
): Promise<SkillRoot[]> {
  const packRoot =
    (await materializeSeaBundledSkillPack(options)) ??
    (await resolveFilesystemBundledSkillPackRoot());
  if (!packRoot) {
    // The absence of built-in skill packages will cause scripting to be rejected by the skill gate; recording diagnostics makes it easier to locate incomplete distribution assets.
    options.logger?.warn("Bundled skill pack unavailable", {
      module: "bootstrap.bundled_skills",
      requiredPaths: [...BUNDLED_SKILL_PACK_REQUIRED_PATHS],
    });
    return [];
  }
  return [
    {
      path: join(packRoot, BUNDLED_SKILL_PACK_SKILLS_DIRECTORY),
      priority: BUNDLED_SKILL_ROOT_PRIORITY,
      scope: "system",
      source: "bundled",
    },
  ];
}

export async function findMissingBundledSkillPackPaths(packRoot: string): Promise<string[]> {
  const present = await Promise.all(
    BUNDLED_SKILL_PACK_REQUIRED_PATHS.map((requiredPath) =>
      pathExists(join(packRoot, ...requiredPath.split("/"))),
    ),
  );
  return BUNDLED_SKILL_PACK_REQUIRED_PATHS.filter((_, index) => !present[index]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveFilesystemBundledSkillPackRoot(): Promise<string | undefined> {
  for (const baseDir of candidateBaseDirs()) {
    for (const relativePath of BUNDLED_SKILL_PACK_ROOT_CANDIDATES) {
      const packRoot = resolve(baseDir, relativePath);
      if (
        (await pathExists(join(packRoot, BUNDLED_SKILL_PACK_SKILLS_DIRECTORY))) &&
        (await findMissingBundledSkillPackPaths(packRoot)).length === 0
      ) {
        return packRoot;
      }
    }
  }
  return undefined;
}

async function materializeSeaBundledSkillPack(
  options: ResolveBundledSkillRootsOptions,
): Promise<string | undefined> {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;
  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;

  const packsRoot = join(options.cliStorageRoot, BUNDLED_SKILL_PACK_DIRECTORY_NAME);
  const targetRoot = join(packsRoot, manifest.hash);
  if (await isSeedComplete(targetRoot, manifest.hash)) return targetRoot;

  // The directory name is the content hash: write to the unique temporary directory and then rename. If the rename fails and the target is complete, the concurrent winner comes first.
  // Direct reuse; otherwise, fall back to any complete old package (skills will still be available if the disk is dropped during the upgrade).
  const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(temporaryRoot, { recursive: true });
    for (const file of manifest.files) {
      const bytes = Buffer.from(sea.getRawAsset(`${SEA_BUNDLED_SKILL_ASSET_PREFIX}${file.path}`));
      if (hashBytes(bytes) !== file.sha256) {
        throw new Error(`Bundled skill asset hash mismatch: ${file.path}`);
      }
      const outputPath = join(temporaryRoot, ...file.path.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes, { mode: file.mode ?? 0o644 });
    }
    await writeFile(
      join(temporaryRoot, SEED_MARKER_FILE),
      JSON.stringify({ hash: manifest.hash, version: 1 }, null, 2),
    );
    await mkdir(packsRoot, { recursive: true });
    await rename(temporaryRoot, targetRoot);
    return targetRoot;
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    if (await isSeedComplete(targetRoot, manifest.hash)) return targetRoot;
    const fallbackRoot = await findUsableSeededPack(packsRoot);
    options.logger?.warn("Bundled skill pack seed degraded", {
      error: error instanceof Error ? error.message : String(error),
      fallbackRoot,
      module: "bootstrap.bundled_skills",
      targetRoot,
    });
    return fallbackRoot;
  }
}

async function isSeedComplete(targetRoot: string, expectedHash: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(targetRoot, SEED_MARKER_FILE), "utf8")) as {
      hash?: unknown;
    };
    if (marker.hash !== expectedHash) return false;
  } catch {
    return false;
  }
  return (await findMissingBundledSkillPackPaths(targetRoot)).length === 0;
}

async function findUsableSeededPack(packsRoot: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(packsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes(".tmp-")) continue;
    const packRoot = join(packsRoot, entry.name);
    try {
      const marker = JSON.parse(await readFile(join(packRoot, SEED_MARKER_FILE), "utf8")) as {
        hash?: unknown;
      };
      if (typeof marker.hash === "string" && (await isSeedComplete(packRoot, marker.hash))) {
        return packRoot;
      }
    } catch {
      // Corrupted old caches do not participate in downgrades and continue to look for complete skill packs.
    }
  }
  return undefined;
}

function readSeaManifest(sea: SeaModule): SeaBundledSkillManifest | undefined {
  try {
    const manifest = JSON.parse(
      sea.getAsset(SEA_BUNDLED_SKILL_MANIFEST_ASSET_KEY, "utf8"),
    ) as SeaBundledSkillManifest;
    return manifest.version === 1 &&
      typeof manifest.hash === "string" &&
      Array.isArray(manifest.files)
      ? manifest
      : undefined;
  } catch {
    return undefined;
  }
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
