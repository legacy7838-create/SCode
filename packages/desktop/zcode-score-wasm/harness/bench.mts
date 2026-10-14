// Before/after measurement for the `zcode-score-wasm` boundary (spec §4, scenario S7).
//
// Apples-to-apples by construction: both sides score the SAME packed index, produced once by the
// real `zcode-scan` addon, with the same queries and the same limit. The only difference is where
// the scoring runs — the JavaScript implementation this replaced, or the WASM kernel.
//
//   node_modules/.bin/tsx packages/desktop/zcode-score-wasm/harness/bench.mts
//
// Two costs are separated because they were separate problems:
//   index   build the searchable form once per workspace index
//   query   score + top-K, once per keystroke (the number that matters for typing latency)

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
} from "@zcode/shared/workspaceFileSearch";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  releaseWorkspaceScoreIndex,
  searchWorkspaceFilesByScore,
} from "../../../services/src/file/workspaceScoreNative.js";
import { buildHostFileSearchCandidates, searchHostFileCandidates } from "./legacy_js_path.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const require = createRequire(import.meta.url);
const scoreGlue = join(resolve(here, ".."), "pkg/nodejs/zcode_score.js");
const scanAddon = join(repoRoot, "packages/desktop/zcode-scan/zcode_scan.node");

const DEFAULT_IGNORE_RULES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "__pycache__/",
  "site-packages/",
  "venv/",
  "coverage/",
  "htmlcov/",
  "lcov-report/",
  "cmakefiles/",
  "cmake-build-*/",
  "bazel-*/",
  "pods/",
  "deriveddata/",
  "storybook-static/",
  "playwright-report/",
  "test-results/",
  "target/",
  ".turbo/",
].join("\n");

const QUERIES = ["r", "re", "rea", "read", "readme", "in", "ind", "index", "src", "s"];
const REPEATS = 5;

for (const path of [scoreGlue, scanAddon]) {
  if (!existsSync(path)) {
    throw new Error(`missing artifact ${path}; run the prepare scripts first`);
  }
}

const { scanWorkspaceFilesPacked } = require(scanAddon) as {
  scanWorkspaceFilesPacked(rootPath: string, ignoreRuleText: string, locale: string): string;
};
const packed = scanWorkspaceFilesPacked(
  repoRoot,
  DEFAULT_IGNORE_RULES,
  new Intl.Collator().resolvedOptions().locale,
);
const entries = unpackWorkspaceFileEntries(packed, repoRoot);
const limit = WORKSPACE_FILE_SEARCH_DISPLAY_CAP;

/** Median of `REPEATS` runs, in milliseconds. */
function measure(run: () => void): number {
  const samples: number[] = [];
  for (let at = 0; at < REPEATS; at += 1) {
    const started = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

console.log(
  `corpus: ${entries.length.toLocaleString()} rows, ${(packed.length / 1e6).toFixed(1)} MB packed`,
);
console.log(`limit:  ${limit}   queries: ${QUERIES.length} x ${REPEATS} repeats (median)\n`);

// --- index build: JS candidate materialization vs WASM arena build -----------------------
// The left column is the SHIPPED JS path, batching included, because that is what production ran.
const legacyIndexSamples: number[] = [];
let legacyCandidates: Awaited<ReturnType<typeof buildHostFileSearchCandidates>> = [];
for (let at = 0; at < 3; at += 1) {
  const started = process.hrtime.bigint();
  legacyCandidates = await buildHostFileSearchCandidates(packed, repoRoot);
  legacyIndexSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
}
legacyIndexSamples.sort((left, right) => left - right);
const jsIndexBuild = legacyIndexSamples[1] ?? 0;
releaseWorkspaceScoreIndex();
const wasmIndex = measure(() => {
  searchWorkspaceFilesByScore({ packed, rootPath: repoRoot, query: QUERIES[0]!, limit });
});

// --- per keystroke: score + top-K ---------------------------------------------------------
async function measureAsync(run: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let at = 0; at < REPEATS; at += 1) {
    const started = process.hrtime.bigint();
    await run();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

const legacyQuery = await measureAsync(async () => {
  for (const query of QUERIES) {
    await searchHostFileCandidates(legacyCandidates, query, limit);
  }
});

// The same scoring WITHOUT the batching: the honest floor for what JavaScript could have done.
// It is reported so the win is not overstated — the kernel is measured against this too.
const flatCandidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
const flatQuery = measure(() => {
  for (const query of QUERIES) {
    filterWorkspaceFileSearchCandidates(flatCandidates, query, { limit });
  }
});

const wasmQuery = measure(() => {
  for (const query of QUERIES) {
    searchWorkspaceFilesByScore({ packed, rootPath: repoRoot, query, limit });
  }
});

const row = (label: string, left: number, right: number) =>
  `| ${label.padEnd(34)} | ${left.toFixed(0).padStart(8)} ms | ${right.toFixed(0).padStart(8)} ms | ${(left / right).toFixed(2)}x |`;

console.log(
  `| ${"stage".padEnd(34)} | ${"JS shipped".padStart(8)} | ${"WASM".padStart(8)} | ${"speedup".padStart(7)} |`,
);
console.log(`| ${"-".repeat(34)} | ${"-".repeat(8)}: | ${"-".repeat(8)}: | ${"-".repeat(7)}: |`);
console.log(row("build searchable index (once)", jsIndexBuild, wasmIndex));
console.log(row(`score + top-K (${QUERIES.length} keystrokes)`, legacyQuery, wasmQuery));
console.log("");
console.log(
  `per keystroke: shipped JS ${(legacyQuery / QUERIES.length).toFixed(1)} ms -> WASM ${(wasmQuery / QUERIES.length).toFixed(1)} ms`,
);
console.log(
  `same JS scoring WITHOUT its batching (the floor JavaScript could reach): ${(flatQuery / QUERIES.length).toFixed(1)} ms/keystroke -> kernel is ${(flatQuery / wasmQuery).toFixed(2)}x of it`,
);
