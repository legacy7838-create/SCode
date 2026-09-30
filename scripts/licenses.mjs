#!/usr/bin/env node
/* eslint-disable max-lines -- Integrated script for third-party license inventory/declaration/access control, with centralized maintenance of data tables and verification logic. */
// Three-party license inventory/declaration/access control integrated script
//
// Usage:
//   node scripts/licenses.mjs notices generate THIRD-PARTY-NOTICES.md (exact version, original copyright and license text)
//   node scripts/licenses.mjs check Manual access control: A package outside the allowlist or with unknown permissions appears, that is, exit code 1
//
// Data caliber:
// - Implementation manifest = recursive collection of all workspace node_modules, including nested versions and symbolic links.
// - Claim generation: third-party-npm.mjs collects real license files by exact versions of production dependencies.
// - prod determines the exact version of the lock file in the production graph.
// - Commercial/semi-open inspection applies to full implementation packages (prod+dev)
import { generateThirdPartyNotices } from "./generate-third-party-notices.mjs";
import { readVerifiedNotices } from "./third-party-notices.mjs";
import { readFile } from "node:fs/promises";
import {
  readWorkspaceProductionGraph,
  scanInstalledPackages,
  missingProductionPackages,
} from "./third-party-npm.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "notices";
if (command === "notices") {
  await generateThirdPartyNotices(ROOT);
  process.exit(0);
}

// Identification access control and declaration generation share the workspace graph and recursive scanning, and do not guess the production scope based on the package name.
const { required, projects } = await readWorkspaceProductionGraph(ROOT);
const ownNames = new Set(projects.map((project) => project.name));
const installed = new Map();
const MANUAL_LICENSE = {
  "exif-parser": "MIT", // In the package LICENSE.md
  khroma: "MIT", // license file in package
  semaphore: "MIT", // README License section in the package
  "css-value": "MIT", // Readme License section in the package
  "@fig/autocomplete-helpers": "MIT", // In the package LICENSE
};
function normLicense(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normLicense).join(" OR ");
  return value?.type?.trim() || "(missing)";
}
const scanned = await scanInstalledPackages(ROOT, projects);
missingProductionPackages(required, scanned);
for (const [key, { pkg }] of scanned) {
  if (ownNames.has(pkg.name)) continue;
  installed.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: normLicense(pkg.license ?? pkg.licenses ?? MANUAL_LICENSE[pkg.name]),
    isProd: required.has(key),
  });
}
// ---------- Classification ----------
const GREEN =
  /^(MIT|MIT-0|ISC|BSD-2-Clause|BSD-3-Clause|BSD-4-Clause|0BSD|Unlicense|Apache-2\.0|Zlib|WTFPL|Artistic-2\.0|BlueOak-1\.0\.0|CC0-1\.0|CC-BY-4\.0|CC-BY-3\.0|BSD|Python-2\.0)$/i;
function classify(raw) {
  const s = raw.replace(/[()]/g, " ").trim();
  if (s === "(missing)" || s === "missing" || s === "") return "missing";
  if (/^UNLICENSED|SEE LICEN[CS]E IN|UNKNOWN|N\/A$/i.test(s)) return "unresolved";
  const or = s
    .split(/\s+OR\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (or.length > 1 && or.some((x) => GREEN.test(x))) return "green";
  const and = s
    .split(/\s+AND\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (and.length > 1 && and.every((x) => GREEN.test(x))) return "green";
  const t = or[0] || and[0] || s;
  if (/\bAGPL/i.test(t)) return "red-agpl";
  if (/\bLGPL/i.test(t)) return "yellow-lgpl";
  if (/\bGPL/i.test(t)) return "red-gpl";
  if (/^(MPL|EPL|CDDL)/i.test(t)) return "yellow-weak";
  if (/^(BUSL|BSL|Elastic|SSPL|PolyForm|FSL|CAL-1)/i.test(t)) return "red-semiopen";
  if (/^CC-BY-NC/i.test(t)) return "red-nc";
  if (/^CC-BY-(ND|SA)/i.test(t)) return "yellow-cc";
  return GREEN.test(t) ? "green" : "review";
}
for (const r of installed.values()) r.bucket = classify(r.license);

// ---------- Build Tools License Tag Review (not Exemption from Binary Distribution Obligations) ----------
const WEAK_ALLOW = [
  [
    /^lightningcss/,
    "Currently only dependencies are built; when entering the production map, the MPL source code provision obligation needs to be rechecked",
  ],
];
function weakAllowReason(r) {
  if (r.isProd) return null;
  for (const [re, why] of WEAK_ALLOW) if (re.test(r.name)) return why;
  return null;
}

if (command === "check") {
  const bad = [];
  for (const r of installed.values()) {
    if (r.bucket === "green") continue;
    if (r.bucket.startsWith("yellow") && weakAllowReason(r)) continue;
    bad.push(r);
  }
  if (bad.length) {
    console.error(`✗ License check failed: ${bad.length} packages exceeded allowlist:`);
    for (const r of bad.sort((a, b) => a.name.localeCompare(b.name)))
      console.error(`  [${r.bucket}] ${r.name}@${r.version} → ${r.license}`);
    console.error(
      "\nDisposition: Replace the dependency, or register the manual review conclusion in WEAK_ALLOW of scripts/licenses.mjs.",
    );
    process.exit(1);
  }
  await readVerifiedNotices(ROOT, { requireComplete: process.argv.includes("--strict") });
  const reviewRequired =
    JSON.parse(await readFile(path.join(ROOT, "third-party/inventory.json"), "utf8"))
      .reviewRequired ?? [];
  if (reviewRequired.length)
    console.warn(
      `There are ${reviewRequired.length} items of materials to be completed/verified; run node scripts/licenses.mjs check --strict before publishing, and passing the basic check shall not be regarded as compliance completion.`,
    );
  const n = installed.size;
  console.log(
    `✓ License identification and declaration freshness check passed: ${n} actual installation packages (build dependency review ${[...installed.values()].filter((r) => r.bucket.startsWith("yellow")).length} items); for material restrictions, see third-party/README.md`,
  );
} else {
  console.error("Usage: node scripts/licenses.mjs [notices|check]");
  process.exit(2);
}
