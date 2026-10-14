// Differential acceptance harness for the `zcode-diff-wasm` kernel (spec/native-boundary-line-diff.md §4).
//
// Proves the Rust kernel reproduces the JavaScript implementation this boundary replaced, for
// BOTH views:
//   S1  patch parity        — kernel `diff_patch` vs the oracle's `buildUnifiedDiffOracle`
//   S2  stat parity         — kernel `line_change_stat` vs the oracle's `computeLineChangeStatOracle`
//   S3  both views agree    — `diff_counts` derives from the same DP as `diff_patch`
//   S4  no fallback         — the Host facade throws (cold process) when the artifact is absent
//   S5  context limit       — the kernel clips context exactly like the JS prefix/suffix clip
//   S6  cap correctness     — over the old caps the kernel returns the TRUE LCS, not the oracle's
//                             degraded "everything changed"; byte-parity is impossible here by
//                             design, so S6 asserts correctness-and-better rather than identity
//
// S1/S2/S3/S5 run over a byte-parity corpus (inputs the removed JS handled without hitting its
// caps). S6 runs over the cap-crossing corpus, where the two are EXPECTED to differ.
//
// The oracle is `harness/legacy_js_diff.mts`, the removed JavaScript preserved verbatim.
//
// Run: node_modules/.bin/tsx packages/desktop/zcode-diff-wasm/harness/parity.mts
import { createRequire } from "node:module";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { buildUnifiedDiffOracle, computeLineChangeStatOracle } from "./legacy_js_diff.mts";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const crateDir = join(here, "..");
const gluePath = join(crateDir, "pkg/nodejs/zcode_diff.js");

let failed = 0;
let passed = 0;

function report(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  OK    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

if (!existsSync(gluePath)) {
  console.error(
    `[parity] kernel glue missing: ${gluePath}\n  run: node packages/desktop/scripts/prepare-zcode-diff-wasm.mjs`,
  );
  process.exit(1);
}

const kernel = require(gluePath);

// --------------------------------------------------------------------------------------------
// Corpus. Every case is a (before, after, label) triple. The cases are chosen to exercise the
// branches the JS had: created/deleted files, the `---` SQL-comment hazard, CRLF, multi-byte
// UTF-8, empty sides, no trailing newline, single-line files, and both sides of the old caps.
// --------------------------------------------------------------------------------------------

function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n");
}

interface Case {
  name: string;
  before: string;
  after: string;
}

const cases: Case[] = [
  { name: "identical", before: "a\nb\nc", after: "a\nb\nc" },
  { name: "create", before: "", after: "x\ny\nz" },
  { name: "delete", before: "x\ny\nz", after: "" },
  { name: "both-empty", before: "", after: "" },
  { name: "one-line-change", before: "a\nb\nc", after: "a\nB\nc" },
  { name: "prepend", before: "b\nc", after: "a\nb\nc" },
  { name: "append", before: "a\nb", after: "a\nb\nc" },
  { name: "no-trailing-newline", before: "a\nb", after: "a\nb\nc\nd" },
  {
    name: "trailing-newline",
    before: "a\nb\n",
    after: "a\nc\n",
  },
  { name: "crlf", before: "a\r\nb\r\nc", after: "a\r\nB\r\nc" },
  // The `---` hazard: deleting a SQL comment line must not be mistaken for a file header.
  { name: "sql-comment-delete", before: "-- comment\nSELECT 1", after: "SELECT 1" },
  { name: "non-ascii", before: "文件.txt\n第二行\n第三行", after: "文件.txt\n第三行\n第四行" },
  { name: "emoji", before: "a\n🚀 launch\nb", after: "a\n🎉 launch\nb" },
  // Anchor path: a distant change with unique anchors on both sides, no large table needed.
  {
    name: "distant-anchors",
    before: `${lines(40, "head")}\nUNIQUE_OLD\n${lines(40, "tail")}`,
    after: `${lines(40, "head")}\nUNIQUE_NEW\n${lines(40, "tail")}`,
  },
  // Just under the old patch cap (60_000 cells): a 240x240 middle = 57_600, previously LCS'd.
  {
    name: "just-under-old-patch-cap",
    before: `${lines(120, "a")}\nCHANGED\n${lines(119, "b")}`,
    after: `${lines(120, "a")}\nCHANGED2\n${lines(119, "b")}`,
  },
  // Reordered block: exercises the LCS traceback's tie-breaking on both sides.
  {
    name: "reordered-block",
    before: "a\nb\nc\nd\ne\nf",
    after: "a\nc\nb\nd\nf\ne",
  },
];

// Corpus B — inputs that cross the OLD caps, where the removed JavaScript deliberately degraded
// (patch cap 60_000 cells, stat cap 400_000). Byte-parity is IMPOSSIBLE here by design: the oracle
// answered with a fallback and the kernel answers with the true LCS. These are covered by S6, which
// asserts the kernel is correct-and-better rather than identical.
//
// `over-old-caps` shares half its lines, so the true answer is 400/400 and the old path's
// "everything changed" (800/800) is unambiguously wrong. The trimmed middle is 800*800 = 640_000
// cells, over both old caps but well under MAX_DIFF_CELLS = 4_000_000.
const OVER_OLD_CAPS_LINES = 800;
const overOldCapsBefore: string[] = [];
const overOldCapsAfter: string[] = [];
for (let index = 0; index < OVER_OLD_CAPS_LINES; index += 1) {
  overOldCapsBefore.push(`line ${index}`);
  overOldCapsAfter.push(index % 2 === 0 ? `changed ${index}` : `line ${index}`);
}
const capCases: Case[] = [
  {
    name: "over-old-caps",
    before: overOldCapsBefore.join("\n"),
    after: overOldCapsAfter.join("\n"),
  },
];
const capExpected = { removed: OVER_OLD_CAPS_LINES / 2, added: OVER_OLD_CAPS_LINES / 2 };

// --------------------------------------------------------------------------------------------
// S1 — patch parity (no context limit).
// --------------------------------------------------------------------------------------------
console.log("S1 patch parity (no context limit):");
for (const testCase of cases) {
  const expected = buildUnifiedDiffOracle(testCase.before, testCase.after, "f.txt");
  const actual = kernel.diff_patch(testCase.before, testCase.after, "f.txt", -1);
  report(
    actual === expected,
    testCase.name,
    actual === expected
      ? ""
      : `\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
  );
}

// --------------------------------------------------------------------------------------------
// S2 — stat parity, on the byte-parity corpus (inputs under the old stat cap).
// --------------------------------------------------------------------------------------------
console.log("\nS2 stat parity (logical-line split):");
for (const testCase of cases) {
  const expected = computeLineChangeStatOracle(testCase.before, testCase.after) as {
    added: number;
    removed: number;
  };
  const actualCounts = kernel.line_change_stat(testCase.before, testCase.after);
  const actual = { added: actualCounts[0], removed: actualCounts[1] };

  const same = expected.added === actual.added && expected.removed === actual.removed;
  report(
    same,
    testCase.name,
    same ? "" : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
  );
}

// --------------------------------------------------------------------------------------------
// S3 — the two kernel views agree (same DP).
// --------------------------------------------------------------------------------------------
console.log("\nS3 both kernel views agree:");
for (const testCase of cases) {
  const counts = kernel.diff_counts(testCase.before, testCase.after, "f.txt", -1);
  const patch = kernel.diff_patch(testCase.before, testCase.after, "f.txt", -1);
  // Recount the body directly from the patch as an independent check. The body is everything after
  // the `@@` hunk header: the `--- a/f` / `+++ b/f` file headers ALSO start with `-`/`+`, so
  // counting the whole patch would double-count them (and miscount created/deleted `/dev/null`).
  const body = patch.slice(patch.indexOf("@@"));
  const bodyLines = body.split("\n").filter((line: string) => /^[+\- ]/.test(line));
  const added = bodyLines.filter((line: string) => line.startsWith("+")).length;
  const removed = bodyLines.filter((line: string) => line.startsWith("-")).length;
  const ok = counts[0] === added && counts[1] === removed;
  report(
    ok,
    testCase.name,
    ok ? "" : `counts=[${counts[0]},${counts[1]}] body=[${added},${removed}]`,
  );
}

// --------------------------------------------------------------------------------------------
// S5 — context clipping matches the JS prefix/suffix clip.
// --------------------------------------------------------------------------------------------
console.log("\nS5 context limit clipping:");
for (const contextLines of [0, 1, 3]) {
  for (const testCase of cases) {
    const expected = buildUnifiedDiffOracle(testCase.before, testCase.after, "f.txt", {
      contextLines,
    });
    const actual = kernel.diff_patch(testCase.before, testCase.after, "f.txt", contextLines);
    const ok = actual === expected;
    report(
      ok,
      `${testCase.name} ctx=${contextLines}`,
      ok
        ? ""
        : `\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}

// --------------------------------------------------------------------------------------------
// S6 — cap-crossing correctness: over the old caps the kernel must be CORRECT (not merely
// different). The oracle degraded to "everything changed"; the kernel must return the true LCS.
// --------------------------------------------------------------------------------------------
console.log("\nS6 over-old-caps correctness:");
for (const testCase of capCases) {
  const oracle = computeLineChangeStatOracle(testCase.before, testCase.after) as {
    added: number;
    removed: number;
  };
  const kernelCounts = kernel.line_change_stat(testCase.before, testCase.after);
  // The old path degraded to "the trimmed middle is all changed" — its totals are the trimmed
  // lengths, NOT the raw line counts (the shared suffix/prefix still survives the trim). Reproduce
  // the trim so the degraded check is exact rather than approximate.
  const beforeLines = testCase.before.split("\n");
  const afterLines = testCase.after.split("\n");
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let beforeTail = beforeLines.length - 1;
  let afterTail = afterLines.length - 1;
  while (
    beforeTail >= prefix &&
    afterTail >= prefix &&
    beforeLines[beforeTail] === afterLines[afterTail]
  ) {
    beforeTail -= 1;
    afterTail -= 1;
  }
  const degradedAdded = Math.max(0, afterTail - prefix + 1);
  const degradedRemoved = Math.max(0, beforeTail - prefix + 1);
  const oracleDegraded = oracle.added === degradedAdded && oracle.removed === degradedRemoved;
  report(
    oracleDegraded,
    `${testCase.name}: oracle degraded to all-changed`,
    oracleDegraded
      ? ""
      : `oracle=${JSON.stringify(oracle)} degraded=[${degradedAdded},${degradedRemoved}]`,
  );
  // The kernel must return the TRUE LCS, which is strictly better than the degraded answer.
  const kernelCorrect =
    kernelCounts[0] === capExpected.added && kernelCounts[1] === capExpected.removed;
  report(
    kernelCorrect,
    `${testCase.name}: kernel returns the true LCS`,
    `kernel=[${kernelCounts[0]},${kernelCounts[1]}] expected=[${capExpected.added},${capExpected.removed}]`,
  );
  // The patch view derives from the same DP, so its own count must equal the true LCS too.
  const patchCounts = kernel.diff_counts(testCase.before, testCase.after, "f.txt", -1);
  const patchCorrect =
    patchCounts[0] === capExpected.added && patchCounts[1] === capExpected.removed;
  report(
    patchCorrect,
    `${testCase.name}: patch view agrees`,
    `patch=[${patchCounts[0]},${patchCounts[1]}]`,
  );
}

// --------------------------------------------------------------------------------------------
// S4 — no fallback. Both directions, each in a FRESH process (the facade caches the loaded glue,
// so a warm process would keep answering after the artifact is parked and hide the bug).
// --------------------------------------------------------------------------------------------
console.log("\nS4 zero JS fallback (cold process):");
const probe = join(here, "probe_no_fallback.mts");
const tsx = join(process.cwd(), "node_modules/.bin/tsx");
function runProbe(): { status: number | null; output: string } {
  const result = spawnSync(tsx, [probe], { cwd: process.cwd(), encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

// Positive control: with the artifact present the same probe must SUCCEED. Without this, a probe
// that threw unconditionally would pass the negative check below and prove nothing.
const control = runProbe();
report(
  control.status === 0 && /READY/.test(control.output),
  "artifact present -> probe succeeds",
  control.status === 0 ? "" : `status=${control.status} output=${control.output.trim()}`,
);

const parked = `${gluePath}.parked`;
let restoreNeeded = false;
try {
  renameSync(gluePath, parked);
  restoreNeeded = true;
  const absent = runProbe();
  const ok = absent.status !== 0 && !/READY/.test(absent.output);
  report(
    ok,
    "artifact absent -> cold process throws",
    ok ? "" : `status=${absent.status} output=${absent.output.trim()}`,
  );
} finally {
  if (restoreNeeded) {
    renameSync(parked, gluePath);
  }
}

const restored = kernel.line_change_stat("a\nb", "a\nc");
report(
  restored.length === 2 && restored[0] === 1 && restored[1] === 1,
  "artifact restored -> answers again",
);

console.log(`\nPARITY: ${failed === 0 ? "OK" : "FAILED"} — ${passed} OK, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
