// Before/after measurement for the `zcode-diff-wasm` boundary (spec/native-boundary-line-diff.md §4).
//
// Apples-to-apples by construction: both sides diff the SAME inputs, and the only difference is
// where the LCS runs — the JavaScript this replaced, or the WASM kernel.
//
//   node_modules/.bin/tsx packages/desktop/zcode-diff-wasm/harness/bench.mts
//
// Two views are measured separately because they are two different call sites with two different
// real-world frequencies:
//   patch  buildUnifiedDiff      — once per tool-edit preview render
//   stat   computeLineChangeStat — once per file per task/turn summary
//
// THE HEADLINE IS NOT A SINGLE RATIO. The old JavaScript had CAPS (60_000 cells for the patch,
// 400_000 for the stat) at which it STOPPED computing the true LCS and returned "everything
// changed". Past those caps JS is not slow-but-right, it is fast-because-wrong. So this bench
// separates the two regimes instead of averaging them into a misleading number:
//
//   regime A  under the caps   — both compute the true LCS; the ratio is a real speed comparison
//   regime B  over the caps    — JS returns a wrong answer, so "JS is faster" is meaningless; the
//                                kernel is correct at the cost of doing the work JS skipped
//
// A third table gives the kernel's absolute cost, so the win is never quoted without its raw price.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildUnifiedDiffOracle, computeLineChangeStatOracle } from "./legacy_js_diff.mts";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const gluePath = join(here, "..", "pkg/nodejs/zcode_diff.js");
if (!existsSync(gluePath)) {
  throw new Error(`missing kernel glue ${gluePath}; run the prepare script first`);
}
const kernel = require(gluePath);

const REPEATS = 25;

/** A before/after pair of `count` realistic source lines, every `changeEvery`-th one edited. */
function pair(count: number, changeEvery: number): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const line = `    const value_${index} = compute(${index}); ${"//".padEnd(60, "-")}`;
    before.push(line);
    after.push(
      index % changeEvery === 0
        ? `    const value_${index} = compute(${index} + 1); ${"//".padEnd(60, "-")}`
        : line,
    );
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

/** Median of `REPEATS` runs, in milliseconds, after a warmup so arena/JIT setup is not measured. */
function measure(run: () => void): number {
  run();
  const samples: number[] = [];
  for (let at = 0; at < REPEATS; at += 1) {
    const started = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

const fixed = (value: number): string => value.toFixed(2).padStart(8);

// Regime A: every case here trims to a middle whose product is under BOTH old caps, so the removed
// JS ran its true-LCS path. These ratios are honest.
const underCaps = [
  { name: "50 lines, 5 changed", ...pair(50, 10) },
  { name: "200 lines, 20 changed", ...pair(200, 10) },
  { name: "200 lines, 50 changed", ...pair(200, 4) },
];
// Regime B: the trimmed middle exceeds the old caps. Measured so the wall-clock price of being
// CORRECT is visible, and labelled so it cannot be read as a regression.
const overCaps = [
  { name: "800 lines, 200 changed", ...pair(800, 4) },
  { name: "2000 lines, 500 changed", ...pair(2000, 4) },
];

console.log(`repeats: ${REPEATS} (median, after one warmup)\n`);

console.log("### Regime A — under the old caps (both compute the true LCS; ratio is fair)\n");
console.log(
  `| ${"case".padEnd(24)} | ${"patch JS".padStart(8)} | ${"patch W".padStart(8)} | ${"ratio".padStart(6)} | ${"stat JS".padStart(8)} | ${"stat W".padStart(8)} | ${"ratio".padStart(6)} |`,
);
console.log(
  `| ${"-".repeat(24)} | ${"-".repeat(8)}: | ${"-".repeat(8)}: | ${"-".repeat(6)}: | ${"-".repeat(8)}: | ${"-".repeat(8)}: | ${"-".repeat(6)}: |`,
);
let ratioSum = 0;
let ratioCount = 0;
for (const testCase of underCaps) {
  const jsPatch = measure(() => buildUnifiedDiffOracle(testCase.before, testCase.after, "f.txt"));
  const wasmPatch = measure(() => kernel.diff_patch(testCase.before, testCase.after, "f.txt", -1));
  const jsStat = measure(() => computeLineChangeStatOracle(testCase.before, testCase.after));
  const wasmStat = measure(() => kernel.line_change_stat(testCase.before, testCase.after));
  ratioSum += jsPatch / wasmPatch + jsStat / wasmStat;
  ratioCount += 2;
  console.log(
    `| ${testCase.name.padEnd(24)} | ${fixed(jsPatch)} | ${fixed(wasmPatch)} | ${(jsPatch / wasmPatch).toFixed(2).padStart(6)} | ` +
      `${fixed(jsStat)} | ${fixed(wasmStat)} | ${(jsStat / wasmStat).toFixed(2).padStart(6)} |`,
  );
}
console.log(`\nmean speedup (regime A): ${(ratioSum / ratioCount).toFixed(2)}x\n`);

console.log("### Regime B — over the old caps (JS WRONG, so its column is not a baseline)\n");
console.log(
  `| ${"case".padEnd(24)} | ${"JS stat".padStart(14)} | ${"kernel stat".padStart(14)} | ${"JS patch".padStart(8)} | ${"WASM patch".padStart(10)} |`,
);
console.log(
  `| ${"-".repeat(24)} | ${"-".repeat(14)}: | ${"-".repeat(14)}: | ${"-".repeat(8)}: | ${"-".repeat(10)}: |`,
);
for (const testCase of overCaps) {
  const jsStat = computeLineChangeStatOracle(testCase.before, testCase.after) as {
    added: number;
    removed: number;
  };
  const wasmStat = kernel.line_change_stat(testCase.before, testCase.after);
  const jsPatch = measure(() => buildUnifiedDiffOracle(testCase.before, testCase.after, "f.txt"));
  const wasmPatch = measure(() => kernel.diff_patch(testCase.before, testCase.after, "f.txt", -1));
  console.log(
    `| ${testCase.name.padEnd(24)} | ${`${jsStat.added}/${jsStat.removed} WRONG`.padStart(14)} | ` +
      `${`${wasmStat[0]}/${wasmStat[1]} true`.padStart(14)} | ${fixed(jsPatch)} | ${fixed(wasmPatch).padStart(10)} |`,
  );
}
console.log(
  "\nOn these inputs the kernel is slower in wall-clock because it does the O(n*m) work JS skipped;",
);
console.log("the JS number is small only because JS returned the wrong answer early.\n");

console.log("### Kernel absolute cost (no JS column — a wrong answer has no baseline)\n");
console.log(`| ${"case".padEnd(24)} | ${"patch".padStart(8)} | ${"stat".padStart(8)} |`);
console.log(`| ${"-".repeat(24)} | ${"-".repeat(8)}: | ${"-".repeat(8)}: |`);
for (const testCase of [...underCaps, ...overCaps]) {
  const wasmPatch = measure(() => kernel.diff_patch(testCase.before, testCase.after, "f.txt", -1));
  const wasmStat = measure(() => kernel.line_change_stat(testCase.before, testCase.after));
  console.log(`| ${testCase.name.padEnd(24)} | ${fixed(wasmPatch)} | ${fixed(wasmStat)} |`);
}
console.log("");
