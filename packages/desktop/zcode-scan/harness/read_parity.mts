// TS-vs-Rust golden parity harness for the workspace file index.
//
// Acceptance gate A1/A2/A3 from spec/native-boundary-workspace-scan.md: the Rust `zcode-scan` addon
// must emit a packed index BYTE-IDENTICAL to the retired JavaScript walk for the same workspace,
// rule set, and locale. This runs BOTH implementations against the same real tree and diffs the
// output — a differential gate, not a set of hand-written unit tests.
//
// Run from the repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-scan/harness/read_parity.mts [root] [rulesFile]
// Optional env: ZCODE_SCAN_SKIP_LOCALES=1 to run only the default-locale case.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { referenceScan } from "./reference_scan.mts";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const addon = require(join(here, "..", "zcode_scan.node"));

const root = process.argv[2] ?? process.cwd();
const rulesFile = process.argv[3] ?? join(root, ".zcodeignore");
const rules = existsSync(rulesFile) ? readFileSync(rulesFile, "utf8") : "";
const defaultLocale = new Intl.Collator().resolvedOptions().locale;

interface Section {
  locale: string;
  reference: string;
  rust: string;
  referenceMs: number;
  rustMs: number;
  rows: number;
}

function firstDivergence(left: string, right: string): string | null {
  if (left === right) return null;
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  for (let index = 0; index < Math.max(leftLines.length, rightLines.length); index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      const context = (lines: string[]) =>
        JSON.stringify(lines.slice(Math.max(0, index - 2), index + 3));
      return [
        `row ${index} of ${leftLines.length}`,
        `  reference: ${context(leftLines)}`,
        `  rust     : ${context(rightLines)}`,
      ].join("\n");
    }
  }
  return "strings differ only in trailing content";
}

async function compare(locale: string): Promise<Section> {
  const reference = await referenceScan(root, rules, locale);
  const startedAt = performance.now();
  const rust = addon.scanWorkspaceFilesPacked(root, rules, locale);
  return {
    locale,
    reference: reference.packed,
    rust,
    referenceMs: reference.elapsedMs,
    rustMs: performance.now() - startedAt,
    rows: reference.packed === "" ? 0 : reference.packed.split("\n").length,
  };
}

let failures = 0;
const results: Section[] = [await compare(defaultLocale)];

// A2: ordering must not depend on the host locale. Both sides collate with the locale passed in,
// so these must agree with each other AND with the default-locale run for an ASCII path corpus.
if (process.env.ZCODE_SCAN_SKIP_LOCALES !== "1") {
  for (const locale of ["und", "en", "de", "ja"]) {
    if (locale !== defaultLocale) results.push(await compare(locale));
  }
}

console.log(`root      : ${root}`);
console.log(`rules     : ${rulesFile}${existsSync(rulesFile) ? "" : " (absent)"}`);
console.log(
  `node      : ${process.version}  ICU ${process.versions.icu}  default locale ${defaultLocale}\n`,
);

console.log("| locale | rows | reference (ms) | rust (ms) | speedup | parity |");
console.log("| --- | ---: | ---: | ---: | ---: | --- |");
for (const result of results) {
  const divergence = firstDivergence(result.reference, result.rust);
  if (divergence !== null) failures += 1;
  const speedup = result.referenceMs / Math.max(result.rustMs, 0.001);
  console.log(
    `| ${result.locale} | ${result.rows} | ${result.referenceMs.toFixed(1)} | ` +
      `${result.rustMs.toFixed(1)} | ${speedup.toFixed(2)}x | ${divergence === null ? "OK" : "DIFF"} |`,
  );
  if (divergence !== null) console.log(`  ${divergence}`);
}

console.log("");
if (failures > 0) {
  console.error(`GOLDEN SCAN PARITY: FAILED (${failures}/${results.length} runs diverged)`);
  process.exit(1);
}
const totalRows = results[0]?.rows ?? 0;
if (totalRows === 0) {
  console.error(
    "GOLDEN SCAN PARITY: FAILED — the reference produced 0 rows, so this proves nothing",
  );
  process.exit(1);
}
console.log(
  `GOLDEN SCAN PARITY: OK — ${totalRows} rows byte-identical across ${results.length} locale run(s)`,
);
