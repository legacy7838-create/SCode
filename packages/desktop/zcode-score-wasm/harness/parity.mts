// Differential parity harness for the `zcode-score-wasm` scoring boundary
// (spec/native-boundary-fuzzy-score.md §4).
//
// The unit under test is the FACADE (`packages/services/src/file/workspaceScoreNative.ts`) — the
// thing the product actually calls — and the oracle is the REAL JavaScript implementation in
// `@zcode/shared/workspaceFileSearch`. Not a hand-written expectation: the contract is "same answer
// as the code it replaces, only faster", so any expectation written here would just be a third
// thing to keep in sync.
//
//   node_modules/.bin/tsx packages/desktop/zcode-score-wasm/harness/parity.mts
//
// Scenarios (spec §4):
//   S1 score parity      every candidate's score, over the whole corpus — not only the top-K
//   S2 top-K sequence    the same (index) sequence as filterWorkspaceFileSearchCandidates
//   S3 entry parity      the WorkspaceFileEntry[] is deep-equal, field for field
//   S4 empty query       first `limit` rows in packed order
//   S5 zero JS fallback  artifact removed / bogus env -> throws; no path returns a JS answer

import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  filterWorkspaceFileSearchCandidates,
  getWorkspaceFileSearchCandidateScore,
  mapWorkspaceFileEntriesToSearchCandidates,
  WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
} from "@zcode/shared/workspaceFileSearch";
import {
  packWorkspaceFileEntries,
  unpackWorkspaceFileEntries,
} from "@zcode/shared/workspaceFileEntriesCodec";
import {
  releaseWorkspaceScoreIndex,
  searchWorkspaceFilesByScore,
} from "../../../services/src/file/workspaceScoreNative.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const crateDir = resolve(here, "..");
const scoreGlue = join(crateDir, "pkg/nodejs/zcode_score.js");
const scanAddon = join(repoRoot, "packages/desktop/zcode-scan/zcode_scan.node");
// The tsx CLI entry, invoked through `process.execPath`: `node_modules/.bin/tsx` is a shell
// wrapper, so passing it as a script argument would hand a shell script to node.
const tsx = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const require = createRequire(import.meta.url);

let failures = 0;

function report(ok: boolean, label: string, detail = "") {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// --- corpus ------------------------------------------------------------------------------------
//
// An ASCII-lowercase corpus of tidy paths would pass even if case folding, trimming and the path
// separator were all wrong. Every case below is a divergence a naive port gets wrong, so they are
// carried on purpose rather than as decoration.

const FIXTURE_ROWS: WorkspaceFileEntry[] = [
  // Directories first, in packed order, because S4 depends on that precondition (see checkParity).
  { name: "packages", path: "/w/packages", relativePath: "packages", type: "directory" },
  { name: "src", path: "/w/src", relativePath: "src", type: "directory" },
  { name: "ui", path: "/w/packages/ui", relativePath: "packages/ui", type: "directory" },
  // Ordinary paths, deep and shallow, to exercise all four score tiers.
  { name: "README.md", path: "/w/README.md", relativePath: "README.md", type: "file" },
  { name: "main.rs", path: "/w/src/main.rs", relativePath: "src/main.rs", type: "file" },
  { name: "lib.rs", path: "/w/src/lib.rs", relativePath: "src/lib.rs", type: "file" },
  {
    name: "button.tsx",
    path: "/w/packages/ui/src/components/button.tsx",
    relativePath: "packages/ui/src/components/button.tsx",
    type: "file",
  },
  {
    name: "index.ts",
    path: "/w/packages/ui/src/index.ts",
    relativePath: "packages/ui/src/index.ts",
    type: "file",
  },
  {
    name: "fileService.ts",
    path: "/w/packages/services/src/file/fileService.ts",
    relativePath: "packages/services/src/file/fileService.ts",
    type: "file",
  },
  {
    name: "Cargo.toml",
    path: "/w/packages/desktop/zcode-score-wasm/Cargo.toml",
    relativePath: "packages/desktop/zcode-score-wasm/Cargo.toml",
    type: "file",
  },
  {
    name: "lib.rs",
    path: "/w/packages/desktop/zcode-score-wasm/src/lib.rs",
    relativePath: "packages/desktop/zcode-score-wasm/src/lib.rs",
    type: "file",
  },
  // Case folding: `toLowerCase` is Unicode, not ASCII `+32`.
  { name: "MiXeD.TxT", path: "/w/MiXeD.TxT", relativePath: "MiXeD.TxT", type: "file" },
  { name: "CAFÉ.TXT", path: "/w/CAFÉ.TXT", relativePath: "CAFÉ.TXT", type: "file" },
  { name: "ΣΤΙΓΜΑΣ.TXT", path: "/w/ΣΤΙΓΜΑΣ.TXT", relativePath: "ΣΤΙΓΜΑΣ.TXT", type: "file" },
  // Trimming: `mapWorkspaceFileEntriesToSearchCandidates` trims all three surfaces.
  { name: "  padded.txt", path: "/w/  padded.txt", relativePath: "  padded.txt", type: "file" },
  {
    name: "trailing.txt  ",
    path: "/w/trailing.txt  ",
    relativePath: "trailing.txt  ",
    type: "file",
  },
  { name: "  both.txt  ", path: "/w/  both.txt  ", relativePath: "  both.txt  ", type: "file" },
  { name: " nbsp.txt", path: "/w/ nbsp.txt", relativePath: " nbsp.txt", type: "file" },
  { name: "﻿bom.txt", path: "/w/﻿bom.txt", relativePath: "﻿bom.txt", type: "file" },
  // U+0085 NEL: Rust's `char::is_whitespace` trims it, JavaScript's `trim()` does NOT.
  { name: "nel.txt", path: "/w/nel.txt", relativePath: "nel.txt", type: "file" },
  // A trailing segment that is entirely whitespace: its name trims to "", which never scores.
  { name: "   ", path: "/w/dir/   ", relativePath: "dir/   ", type: "file" },
  {
    name: "nested.txt",
    path: "/w/spaced dir/nested.txt",
    relativePath: "spaced dir/nested.txt",
    type: "file",
  },
  // Separators and escapes the codec round-trips.
  { name: "we\\ird.txt", path: "/w/we\\ird.txt", relativePath: "we\\ird.txt", type: "file" },
  { name: "tab\there.txt", path: "/w/tab\there.txt", relativePath: "tab\there.txt", type: "file" },
  { name: "nl\nhere.txt", path: "/w/nl\nhere.txt", relativePath: "nl\nhere.txt", type: "file" },
  { name: "a-b_c.d.txt", path: "/w/a-b_c.d.txt", relativePath: "a-b_c.d.txt", type: "file" },
  { name: "123.txt", path: "/w/123.txt", relativePath: "123.txt", type: "file" },
  { name: "文件.txt", path: "/w/中文/文件.txt", relativePath: "中文/文件.txt", type: "file" },
];

const QUERIES = [
  "",
  "   ",
  "r",
  "re",
  "readme",
  "main",
  "src/main",
  "lib",
  "ui/src/index",
  "button",
  "fileservice",
  "cargo",
  "zcode-score-wasm",
  "mixed",
  "café",
  "στιγμα",
  "padded",
  "padded.txt",
  "nbsp",
  "bom",
  "nel",
  "a b c",
  "\\\\",
  "tab\there",
  "中文",
  "中文件",
  "123",
  "a-b_c",
  "x",
  "zzz-no-such-candidate",
  "/w/src",
  "w/src/main",
];

/**
 * The product's default ignore rules, minus nothing.
 *
 * The corpus scan MUST NOT run with an empty `ignoreRuleText`: that is the fail-open state, and it
 * walks `node_modules/` and `.git/`. On this checkout that is >200k rows, which turns the
 * JavaScript oracle (which still scores every candidate, by design) into a multi-minute run. The
 * default rules are the product's own, so the corpus is the ~6k real source paths a user searches.
 */
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

/** Real file list, packed by the `zcode-scan` addon exactly as the product packs it. */
function packCheckout(): string {
  if (!existsSync(scanAddon)) {
    throw new Error(
      `zcode-scan addon 缺失: ${scanAddon}。请先运行 node packages/desktop/scripts/prepare-zcode-scan-native.mjs`,
    );
  }
  // Collation does not affect parity: both sides score the SAME packed string in the SAME row
  // order, so any locale produces an equivalent test. The resolved locale is used only so the
  // corpus matches production bytes.
  const { scanWorkspaceFilesPacked } = require(scanAddon) as {
    scanWorkspaceFilesPacked(rootPath: string, ignoreRuleText: string, locale: string): string;
  };
  return scanWorkspaceFilesPacked(
    repoRoot,
    DEFAULT_IGNORE_RULES,
    new Intl.Collator().resolvedOptions().locale,
  );
}

/** Load the staged kernel exactly as the services facade does. */
function loadKernel(): ScoreKernel {
  if (!existsSync(scoreGlue)) {
    throw new Error(
      `zcode-score glue 缺失: ${scoreGlue}。请先运行 node packages/desktop/scripts/prepare-zcode-score-wasm.mjs`,
    );
  }
  return require(scoreGlue) as ScoreKernel;
}

/** Decode the packed `top_k` triples back into `{ index, score }` rows. */
function decodeTopK(hits: Uint32Array, limit: number) {
  const rows: { index: number; score: number }[] = [];
  for (let at = 0; at + 2 < hits.length && rows.length < limit; at += 3) {
    const low = hits[at + 1] ?? 0;
    const high = hits[at + 2] ?? 0;
    rows.push({ index: hits[at] ?? 0, score: high * 2 ** 32 + low });
  }
  return rows;
}

/**
 * S1 — every candidate's SCORE, over the whole corpus.
 *
 * Run against the kernel directly with an unbounded limit, because a facade call is capped at the
 * display limit (1000): on a 193k-row index most scoring rows are legitimately outside the top-K,
 * so a "present in the result" assertion would be wrong there. Comparing the complete
 * row -> score mapping is the check that actually pins the scoring function.
 */
function checkScoreParity(kernel: ScoreKernel, label: string, packed: string, rootPath: string) {
  const entries = unpackWorkspaceFileEntries(packed, rootPath);
  const candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
  kernel.init_index(packed, rootPath);

  /** Rust kernel surface; S1 talks to it directly, S2-S5 go through the facade. */
  interface ScoreKernel {
    init_index(packed: string, rootPath: string): number;
    top_k(query: string, limit: number): Uint32Array;
  }

  let failures = 0;
  let first = "";
  for (const query of QUERIES) {
    if (query.trim().length === 0) continue;
    const jsScores = new Map<number, number>();
    for (const [row, candidate] of candidates.entries()) {
      const score = getWorkspaceFileSearchCandidateScore(candidate, query);
      if (score !== null) jsScores.set(row, score);
    }
    const hits = decodeTopK(kernel.top_k(query, entries.length), entries.length);
    const kernelScores = new Map(hits.map((hit) => [hit.index, hit.score]));
    if (kernelScores.size !== jsScores.size) {
      failures += 1;
      first ||= `query=${JSON.stringify(query)} kernel=${kernelScores.size} js=${jsScores.size}`;
      continue;
    }
    for (const [row, score] of jsScores) {
      if (kernelScores.get(row) !== score) {
        failures += 1;
        first ||= `query=${JSON.stringify(query)} row=${row} rel=${JSON.stringify(entries[row]?.relativePath)} kernel=${String(kernelScores.get(row))} js=${score}`;
        break;
      }
    }
  }
  report(
    failures === 0,
    `${label} S1 score parity (all rows)`,
    first || `${QUERIES.length} queries x ${entries.length} rows`,
  );
}

/** S2/S3/S4 — the facade's answers, which is what the product actually consumes. */
function checkFacadeParity(label: string, packed: string, rootPath: string) {
  const entries = unpackWorkspaceFileEntries(packed, rootPath);
  const candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
  const rowOfCandidate = new Map(candidates.map((candidate, row) => [candidate, row]));
  const rowOfEntry = new Map(entries.map((entry, row) => [entry.relativePath, row]));
  const limit = WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  releaseWorkspaceScoreIndex();

  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let firstS2 = "";
  let firstS3 = "";
  let firstS4 = "";

  for (const query of QUERIES) {
    const actual = searchWorkspaceFilesByScore({ packed, rootPath, query, limit });

    if (query.trim().length === 0) {
      // S4 — the head of the index. `filterWorkspaceFileSearchCandidates` answers an empty query
      // with the default sort, which for a packed index is its own order (zcode-scan packs
      // directories first), so the two must agree row for row.
      const expected = filterWorkspaceFileSearchCandidates(candidates, query, { limit });
      const expectedRows = expected.map((candidate) => rowOfCandidate.get(candidate));
      const actualRows = actual.map((entry) => rowOfEntry.get(entry.relativePath));
      if (
        actualRows.length !== expectedRows.length ||
        actualRows.some((row, at) => row !== expectedRows[at])
      ) {
        s4 += 1;
        firstS4 ||= `query=${JSON.stringify(query)} kernel=${JSON.stringify(actualRows.slice(0, 4))} js=${JSON.stringify(expectedRows.slice(0, 4))}`;
      }
      continue;
    }

    const expected = filterWorkspaceFileSearchCandidates(candidates, query, { limit });
    const expectedRows = expected.map((candidate) => rowOfCandidate.get(candidate));
    const expectedEntries = expectedRows.map((row) =>
      row === undefined ? null : (entries[row] ?? null),
    );
    const actualRows = actual.map((entry) => rowOfEntry.get(entry.relativePath) ?? -1);

    // S2 — the same row sequence, element for element.
    if (
      actualRows.length !== expectedRows.length ||
      actualRows.some((row, at) => row !== expectedRows[at])
    ) {
      s2 += 1;
      firstS2 ||= `query=${JSON.stringify(query)} kernel=${actualRows.length} js=${expectedRows.length} ${firstDiff(actualRows, expectedRows)}`;
    }

    // S3 — same entries, field for field.
    if (JSON.stringify(actual) !== JSON.stringify(expectedEntries)) {
      s3 += 1;
      firstS3 ||= `query=${JSON.stringify(query)} kernel=${JSON.stringify(actual.slice(0, 2))} js=${JSON.stringify(expectedEntries.slice(0, 2))}`;
    }
  }

  report(s2 === 0, `${label} S2 top-K sequence parity`, firstS2 || `${QUERIES.length} queries`);
  report(s3 === 0, `${label} S3 entry parity`, firstS3 || `${QUERIES.length} queries`);
  report(s4 === 0, `${label} S4 empty-query head parity`, firstS4 || `${QUERIES.length} queries`);
}

function firstDiff(left: (number | undefined)[], right: (number | undefined)[]) {
  const at = left.findIndex((value, index) => value !== right[index]);
  return `at=${at} kernel=${String(left[at])} js=${String(right[at])}`;
}

// --- S5: zero JS fallback ---------------------------------------------------------------------

/**
 * S5 runs in a child process because the loader memoizes the kernel: a module-level require cache
 * would hide a second load, and the whole point of S5 is that a missing artifact fails loudly.
 */
function checkNoFallback() {
  const probe = join(here, "probe_no_fallback.mts");
  const run = (env: NodeJS.ProcessEnv) => {
    try {
      const stdout = execFileSync(process.execPath, [tsx, probe], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { threw: false, stdout };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return { threw: true, stdout: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  // 5a — artifact present: the facade answers.
  const healthy = run({});
  report(
    !healthy.threw && healthy.stdout.includes("READY"),
    "S5a artifact present -> answers",
    healthy.stdout.trim().split("\n").pop() ?? "",
  );

  // 5b — artifact removed: must THROW, never fall back to the JS scorer.
  const parked = `${scoreGlue}.parked`;
  renameSync(scoreGlue, parked);
  try {
    const missing = run({});
    report(
      missing.threw && /not found/.test(missing.stdout),
      "S5b artifact removed -> throws (no JS fallback)",
      missing.stdout.trim().split("\n").pop() ?? "",
    );
  } finally {
    renameSync(parked, scoreGlue);
  }

  // 5c — bogus env override: must THROW as well, not silently load something else.
  const bogus = run({ ZCODE_SCORE_WASM_GLUE: join(repoRoot, "no-such-kernel.js") });
  report(
    bogus.threw && /missing file/.test(bogus.stdout),
    "S5c bogus ZCODE_SCORE_WASM_GLUE -> throws",
    bogus.stdout.trim().split("\n").pop() ?? "",
  );

  // 5d — the artifact is back, proving 5b/5c did not corrupt the staging.
  const recovered = run({});
  report(
    !recovered.threw && recovered.stdout.includes("READY"),
    "S5d artifact restored -> answers again",
  );
}

// --- main ---------------------------------------------------------------------------------------

console.log(`parity harness — node ${process.version}`);
console.log("");
const kernel = loadKernel();

console.log("fixture corpus (case, trim, separator, escape traps):");
const fixturePacked = packWorkspaceFileEntries(FIXTURE_ROWS);
checkScoreParity(kernel, "fixture", fixturePacked, "/w");
checkFacadeParity("fixture", fixturePacked, "/w");
console.log("");
console.log("real corpus (this checkout, packed by the zcode-scan addon):");
const checkoutPacked = packCheckout();
console.log(`  ${checkoutPacked.split("\n").length} rows`);
checkScoreParity(kernel, "checkout", checkoutPacked, repoRoot);
checkFacadeParity("checkout", checkoutPacked, repoRoot);
console.log("");
console.log("S5 zero JS fallback:");
checkNoFallback();
console.log("");

if (failures > 0) {
  console.error(`PARITY: FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log("PARITY: OK");
