import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// Skill bundles built with the CLI (apps/zcode-cli/packages/bundled-skills). It is not an official plug-in: it does not enter the market directory,
// There is no version identity, and it is decompressed to `<cli storage>/bundled-skills/<hash>/` according to the content hash at runtime.
// (bootstrap/src/app/bundled-skills.ts). The shape of the manifest here corresponds literally to the read over there.
export const seaBundledSkillAssetPrefix = "zcode-bundled-skills/";
export const seaBundledSkillManifestAssetKey = `${seaBundledSkillAssetPrefix}manifest.json`;
export const bundledSkillPackRootPath = join("packages", "bundled-skills");
export const bundledSkillPackSkillsDirectory = "skills";
// Aligned with bootstrap's BUNDLED_SKILL_PACK_REQUIRED_PATHS: any missing item aborts the SEA build,
// Do not ship a skill package with incomplete reference files into the official binary.
export const bundledSkillPackRequiredPaths = [
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/patterns.md",
  "skills/dynamic-workflows/examples.md",
];

export const collectSeaBundledSkillAssets = async ({ root, stagingDirectory }) => {
  const packRoot = resolve(root, bundledSkillPackRootPath);
  assertBundledSkillPack(packRoot);

  await rm(stagingDirectory, { force: true, recursive: true });

  const files = [];
  const assets = {};
  for await (const sourcePath of walkFiles(join(packRoot, bundledSkillPackSkillsDirectory))) {
    const relativePath = relative(packRoot, sourcePath);
    if (!shouldIncludeFile(relativePath)) continue;
    const bytes = await readFile(sourcePath);
    const sourceStats = await stat(sourcePath);
    const posixPath = toPosixPath(relativePath);
    assets[`${seaBundledSkillAssetPrefix}${posixPath}`] = sourcePath;
    files.push({
      mode: modeForFile(sourceStats.mode),
      path: posixPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    hash: createHash("sha256")
      .update(JSON.stringify(files.map(({ path, sha256, mode }) => [path, sha256, mode])))
      .digest("hex"),
    files,
    version: 1,
  };
  const manifestPath = resolve(stagingDirectory, "bundled-skills-manifest.json");
  await mkdir(stagingDirectory, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assets[seaBundledSkillManifestAssetKey] = manifestPath;

  return { assets, manifest };
};

function assertBundledSkillPack(packRoot) {
  if (!existsSync(join(packRoot, bundledSkillPackSkillsDirectory))) {
    throw new Error(`Missing bundled skill pack at ${packRoot}`);
  }
  for (const relativePath of bundledSkillPackRequiredPaths) {
    const assetPath = join(packRoot, ...relativePath.split("/"));
    if (!existsSync(assetPath)) {
      throw new Error(`Missing bundled skill pack required asset at ${assetPath}`);
    }
  }
}

async function* walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".turbo") continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile()) yield fullPath;
  }
}

const shouldIncludeFile = (relativePath) => !relativePath.split(sep).includes(".DS_Store");

const toPosixPath = (value) => value.split(sep).join("/");

const modeForFile = (sourceMode) => ((sourceMode & 0o111) !== 0 ? 0o755 : 0o644);
