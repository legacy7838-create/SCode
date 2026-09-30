import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dirname, "..");
export const noticesFileName = "THIRD-PARTY-NOTICES.md";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function readThirdPartyNotices(root = repositoryRoot) {
  // Development and build only consume existing declarations; input freshness is handled by explicit license checks, avoiding build blocks from skill modifications.
  return readFile(resolve(root, noticesFileName));
}

export async function readVerifiedNotices(root = repositoryRoot, { requireComplete = false } = {}) {
  const manifest = JSON.parse(await readFile(resolve(root, "third-party/inventory.json"), "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported third-party inventory");
  const bytes = await readThirdPartyNotices(root);
  if (hash(bytes) !== manifest.noticesSha256)
    throw new Error("Third-party notices changed; regenerate the inventory");
  for (const [file, expected] of Object.entries(manifest.inputs)) {
    // Workspace text allows CRLF from Windows checkout; original licenses and distribution declarations are separately verified with byte-level hashes.
    if (hash((await readFile(resolve(root, file), "utf8")).replaceAll("\r\n", "\n")) !== expected) {
      throw new Error(`Third-party input changed: ${file}. Run node scripts/licenses.mjs notices`);
    }
  }
  if (requireComplete && !Array.isArray(manifest.reviewRequired))
    throw new Error("Missing material review inventory; regenerate third-party notices");
  if (requireComplete && manifest.reviewRequired.length) {
    throw new Error(
      `Unresolved third-party material obligations:\n${manifest.reviewRequired.map((item) => `${item.id}: ${item.reason}`).join("\n")}`,
    );
  }
  return bytes;
}

export async function stageThirdPartyNotices(directory, root = repositoryRoot) {
  const bytes = await readThirdPartyNotices(root);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, noticesFileName), bytes);
}

export async function readNodeNotices(version, root = repositoryRoot) {
  const normalized = version.replace(/^v/u, "");
  const sources = JSON.parse(
    await readFile(resolve(root, "third-party/runtime/sources.json"), "utf8"),
  );
  const source = sources.node.find((item) => item.version === normalized);
  if (!source) throw new Error(`Missing Node ${normalized} license provenance`);
  const bytes = await readFile(resolve(root, source.file));
  return { source, bytes };
}

export async function stageNodeNotices(directory, version, root = repositoryRoot) {
  const { source, bytes } = await readNodeNotices(version, root);
  await mkdir(directory, { recursive: true });
  // Fix: must also refresh declarations when reusing binary cache; copying only bin/node loses embedded library terms.
  await writeFile(resolve(directory, "LICENSE.node.txt"), bytes);
  await writeFile(resolve(directory, "NODE-SOURCES.json"), `${JSON.stringify(source, null, 2)}\n`);
  return resolve(directory, "LICENSE.node.txt");
}

export async function stageElectronNotices(extractedRoot, resources, version) {
  const directory = resolve(resources, "licenses/electron");
  const records = [];
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
    let bytes;
    try {
      bytes = await readFile(resolve(extractedRoot, name));
    } catch (error) {
      if (name !== "LICENSE" || error.code !== "ENOENT") throw error;
      bytes = await readFile(resolve(extractedRoot, "LICENSE.electron.txt"));
    }
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, name), bytes);
    records.push({ file: name, sha256: hash(bytes) });
  }
  // Fix: use the actual target platform's extracted materials, to avoid cross-compilation mistakenly using the host Electron's license set.
  await writeFile(
    resolve(directory, "SOURCES.json"),
    `${JSON.stringify({ version, origin: "electron-builder target distribution", records }, null, 2)}\n`,
  );
}

export async function readNativeSearchNotices(root = repositoryRoot, { verify = false } = {}) {
  const inventoryPath = resolve(root, "third-party/native-search/sources.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  // Native materials are explicitly verified at generation time; cache preparation, build, and packaging do not treat stale registration as a gate.
  if (verify) {
    for (const [file, expected] of Object.entries(inventory.inputs)) {
      if (hash(await readFile(resolve(root, file))) !== expected)
        throw new Error(`Native license versions changed: ${file}`);
    }
  }
  const records = new Map();
  for (const component of inventory.components) {
    for (const notice of component.notices) {
      const bytes = await readFile(resolve(root, notice.file));
      const sha256 = hash(bytes);
      if (verify && sha256 !== notice.sha256)
        throw new Error(`Changed native notice: ${notice.file}`);
      const record = records.get(sha256) ?? { bytes, components: new Set() };
      record.components.add(`${component.id} ${component.version ?? ""}`.trim());
      records.set(sha256, record);
    }
  }
  const parts = [
    "NATIVE SEARCH THIRD-PARTY NOTICES\n",
    inventory.scope,
    "Ripgrep is available under MIT or Unlicense. Zstd uses its BSD alternative. GCC runtime portions use GPL-3.0 with the GCC Runtime Library Exception 3.1. These component licenses do not relicense the application.",
    "Exact archive checksums, source URLs and notice hashes are recorded in SOURCES.json beside this file.",
  ];
  for (const record of records.values()) {
    parts.push(
      `\n===== ${[...record.components].join("; ")} =====\n`,
      record.bytes.toString("utf8"),
    );
  }
  return { inventory, bytes: Buffer.from(`${parts.join("\n\n")}\n`) };
}

export async function stageNativeSearchNotices(
  plan,
  root = repositoryRoot,
  { builtFromSource = false } = {},
) {
  const { inventory, bytes } = await readNativeSearchNotices(root);
  for (const artifact of plan.artifacts) {
    const directory = dirname(artifact.binaryPath);
    // Rewrite notices even on cache hits, to avoid old binary caches continuing to lack copyright materials.
    await writeFile(resolve(directory, "THIRD-PARTY-NOTICES.txt"), bytes);
    await writeFile(
      resolve(directory, "SOURCES.json"),
      JSON.stringify(
        {
          ...inventory,
          archiveChecksumScope:
            "The archives list records repository binary inputs. Repackaged outputs containing these notices have different archive checksums; the binary below identifies this distribution.",
          binary: {
            toolId: artifact.toolId,
            version: artifact.version,
            sha256: hash(await readFile(artifact.binaryPath)),
            origin: builtFromSource ? "source-build" : "repository-archive",
            ...(!builtFromSource ? { sourceArchiveSha256: artifact.archiveSha256 } : {}),
          },
        },
        null,
        2,
      ) + "\n",
    );
  }
}

export function thirdPartyNoticesVitePlugin(root = repositoryRoot) {
  let base = "/";
  return {
    name: "zcode-third-party-notices",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: noticesFileName,
        source: await readThirdPartyNotices(root),
      });
    },
    transformIndexHtml: {
      order: "post",
      handler: () => [
        {
          tag: "link",
          attrs: {
            rel: "license",
            href: `${base}${noticesFileName}`,
          },
          injectTo: "head",
        },
      ],
    },
  };
}
