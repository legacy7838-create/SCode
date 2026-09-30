import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { collectNpmNotices, hashBytes } from "./third-party-npm.mjs";
import {
  noticesFileName,
  readNativeSearchNotices,
  repositoryRoot,
} from "./third-party-notices.mjs";

export async function generateThirdPartyNotices(root = repositoryRoot) {
  const inputs = {};
  const readInput = async (file) => {
    const bytes = await readFile(join(root, file));
    inputs[file] = hashBytes(bytes.toString("utf8").replaceAll("\r\n", "\n"));
    return bytes;
  };
  const readJson = async (file) => JSON.parse(await readInput(file));
  const overrides = await readJson("third-party/npm-overrides.json");
  const copied = await readJson("third-party/copied-components.json");
  const embedded = await readJson("third-party/embedded-components.json");
  const runtimes = await readJson("third-party/runtime/sources.json");
  for (const runtime of runtimes.node) {
    if (hashBytes(await readInput(runtime.file)) !== runtime.sha256)
      throw new Error(`Changed Node ${runtime.version} license`);
  }
  const pkg = await readJson("package.json");
  await readInput("pnpm-lock.yaml");
  await readInput("pnpm-workspace.yaml");
  await readInput("third-party/native-search/sources.json");
  const { packages, notInstalled, workspaceManifests } = await collectNpmNotices(root, overrides);
  // Fix: Recursive scanning will treat the deletable cache of bundled-agents/mock-cdn as source code input, and the reconstruction will fail immediately.
  // Workspace boundaries are resolved by pnpm, and the same collection of projects is used for dependency graphs and manifest freshness checks.
  for (const file of workspaceManifests) await readInput(file);
  const currentPackages = new Set(
    [...packages, ...notInstalled].map((item) => `${item.name}@${item.version}`),
  );
  for (const item of overrides) {
    if (!currentPackages.has(item.package))
      throw new Error(`Stale npm notice override: ${item.package}`);
  }
  const textRecords = new Map();
  function addText(bytes, owner, origin) {
    const sha256 = hashBytes(bytes);
    const record = textRecords.get(sha256) ?? { bytes, references: [] };
    record.references.push({ owner, origin });
    textRecords.set(sha256, record);
    return sha256;
  }
  for (const record of overrides) if (record.file) await readInput(record.file);
  const packageInventory = packages.map(({ notices, ...item }) => ({
    ...item,
    notices: notices.map(({ member, bytes }) => ({
      member,
      sha256: addText(bytes, `${item.name}@${item.version}`, member),
    })),
  }));
  async function copiedFiles(file, files) {
    if ((await stat(join(root, file))).isDirectory()) {
      for (const child of (await readdir(join(root, file))).sort())
        await copiedFiles(`${file}/${child}`, files);
    } else {
      const bytes = await readInput(file);
      files.push({ file, sha256: hashBytes(bytes) });
    }
  }
  const copiedInventory = [];
  for (const record of copied) {
    if (record.file) {
      const bytes = await readInput(record.file);
      if (hashBytes(bytes) !== record.sha256)
        throw new Error(`Changed copied-source license: ${record.id}`);
      addText(bytes, record.id, record.source);
    } else if (!record.reviewRequired) {
      throw new Error(`Missing copied-source license or review: ${record.id}`);
    }
    const files = [];
    for (const file of record.roots) await copiedFiles(file, files);
    for (const file of record.modifiedFiles ?? []) {
      // Fix: Centralized NOTICE does not replace in-file modification declarations in Apache 4(b), nor does regeneration erase this obligation.
      if (!files.some((entry) => entry.file === file))
        throw new Error(`Modified source outside copied roots: ${file}`);
      if (!(await readFile(join(root, file), "utf8")).includes("Modified by ZCode:"))
        throw new Error(`Missing file-local modification notice: ${file}`);
    }
    copiedInventory.push({ ...record, files });
  }
  for (const component of embedded) {
    if (!packages.some((item) => `${item.name}@${item.version}` === component.parentPackage))
      throw new Error(`Stale embedded component: ${component.parentPackage}`);
    for (const evidence of component.buildEvidence ?? []) {
      if (hashBytes(await readInput(evidence.file)) !== evidence.sha256)
        throw new Error(`Changed embedded build provenance: ${component.id}`);
    }
    for (const notice of component.notices) {
      const bytes = await readInput(notice.file);
      if (hashBytes(bytes) !== notice.sha256)
        throw new Error(`Changed embedded notice: ${component.id}`);
      addText(
        bytes,
        `${notice.component ?? component.id} (inside ${component.parentPackage})`,
        notice.source,
      );
    }
  }
  // The LICENSE of upstream AI Elements is a short version of the authorization header, and the full text of Apache 2.0 must also be provided with the package.
  addText(
    await readInput("scripts/license-texts/Apache-2.0.txt"),
    "Apache-2.0 licensed components",
    "Apache License, Version 2.0",
  );
  const patches = [];
  for (const [name, file] of Object.entries(pkg.pnpm?.patchedDependencies ?? {})) {
    patches.push({ package: name, file, sha256: hashBytes(await readInput(file)) });
  }
  const native = await readNativeSearchNotices(root, { verify: true });
  for (const file of Object.keys(native.inventory.inputs)) await readInput(file);
  for (const component of native.inventory.components) {
    for (const notice of component.notices) await readInput(notice.file);
  }
  const sections = [
    "# Third-party notices",
    "Generated by `node scripts/licenses.mjs notices` from the current workspace production dependency graph, copied source/assets and native search tools. This is a conservative union across distributions; not every listed component is included on every platform. Versions, source references and hashes are recorded in `third-party/inventory.json` and `third-party/native-search/sources.json` in the source repository.",
    "Original copyright, license and NOTICE text is retained below. Identical text is shared by the components listed above it. Package metadata license identifiers are descriptive; they do not replace the original terms. Copyright holders are never inferred from npm author fields.",
    "## npm packages",
    ...packageInventory.map(
      (item) =>
        `- ${item.name}@${item.version} — ${typeof item.license === "string" ? item.license : JSON.stringify(item.license)}${item.acceptedMissingNotice ? `; ${item.acceptedMissingNotice}` : ""}`,
    ),
    "## Source evidence limitations",
    "Some publishers provide only a license identifier or a short README license section instead of a complete LICENSE file. For the following packages the supplied material explicitly identifies publisher metadata and standard terms; it is not represented as an original upstream LICENSE file. Any available README copyright notice is retained:",
    ...overrides
      .filter((item) => item.evidenceKind)
      .map((item) => `- ${item.package}: ${item.source}`),
    "The original import revisions of copied components are not recorded in the current checkout. Pinned license references below do not establish the original copy revision. They cover upstream-derived portions only; local adaptations do not change the upstream terms.",
    "## Copied source and assets",
    ...copied.map(
      (item) =>
        `- ${item.id} (${item.license ?? "not established"}): ${item.roots.join(", ")}. License reference: ${item.source ?? "not established"}. Original import revision: ${item.importRevision ?? "not recorded"}.${item.reviewRequired ? ` Review required: ${item.reviewRequired}` : ""}`,
    ),
    "Fig autocomplete source carries the repository's MIT license; the generated registry records npm @withfig/autocomplete@2.692.3 metadata as ISC. The original source MIT notice is retained below.",
    "## Embedded native and WASM components",
    ...embedded.map(
      (item) =>
        `- ${item.id} inside ${item.parentPackage}; upstream revision ${item.revision}; source: ${item.source}. ${item.reviewRequired ?? ""}`,
    ),
    "Electron/Chromium target-specific notices are shipped separately under Resources/licenses/electron. Distributions containing an independent Node runtime also include its exact-version LICENSE.node.txt; SEA includes that text in --licenses output.",
    "## Modified npm packages",
    ...patches.map(
      (item) =>
        `- ${item.package}: modified by ZCode; the changes are recorded in ${item.file} in the source repository.`,
    ),
    "## License and NOTICE texts",
  ];
  for (const [sha256, record] of textRecords) {
    sections.push(
      `### Notice ${sha256}`,
      ...record.references.map(({ owner, origin }) => `- ${owner}: ${origin}`),
      "",
      "````text\n" + record.bytes.toString("utf8") + "\n````",
    );
  }
  sections.push("## Native search tools", "````text\n" + native.bytes.toString("utf8") + "\n````");
  const bytes = Buffer.from(`${sections.join("\n\n")}\n`);
  const inventory = {
    schemaVersion: 1,
    inputHashEncoding:
      "UTF-8 with CRLF normalized to LF; notice and source snapshot hashes remain byte-exact",
    scope:
      "Production dependency union across current workspace projects, copied source/assets and native tools; not a per-installer SBOM or a certification of all licensing obligations.",
    noticesSha256: hashBytes(bytes),
    inputs: Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b, "en"))),
    packages: packageInventory,
    notInstalled,
    copied: copiedInventory,
    patches,
    exceptions: overrides.filter((item) => item.acceptedMissingNotice || item.evidenceKind),
    embedded,
    runtimes,
    reviewRequired: [
      // Fix: The gap for copying source code was previously only written in README, and strict access control cannot block it after regenerating the list.
      ...copied
        .filter((item) => item.reviewRequired)
        .map((item) => ({ id: item.id, reason: item.reviewRequired })),
      ...overrides
        .filter((item) => item.acceptedMissingNotice || item.evidenceKind)
        .map((item) => ({
          id: item.package,
          reason:
            "Original version-specific publisher copyright/license material remains incomplete.",
        })),
      ...embedded
        .filter((item) => item.reviewRequired)
        .map((item) => ({ id: item.id, reason: item.reviewRequired })),
      ...native.inventory.components
        .filter((item) => !item.notices.length)
        .map((item) => ({
          id: `${item.id}@${item.version}`,
          reason: "No original notice snapshot for this recorded native component.",
        })),
    ],
  };
  await writeFile(join(root, noticesFileName), bytes);
  await writeFile(
    join(root, "third-party/inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  console.log(
    `${relative(root, join(root, noticesFileName))}: ${packages.length} package versions, ${copied.length} copied components, ${native.inventory.archives.length} native archives, ${bytes.length} bytes`,
  );
}
