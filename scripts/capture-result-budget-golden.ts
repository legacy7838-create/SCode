/**
 * PHASE 4 oracle: the tool-result byte budget.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 4).
 *
 * `fitStringToBytes` decides how much of a tool result reaches the model. It is a pure
 * UTF-8 BYTE budget over CODE POINTS (`Array.from`, not UTF-16 units) with a binary search for
 * the largest fitting prefix/suffix — which is exactly the kind of thing that silently diverges
 * between a JavaScript and a Rust implementation. The corpus is therefore mostly Unicode.
 *
 * Run: pnpm exec tsx scripts/capture-result-budget-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import {
  fitContentWithSuffix,
  fitStringToBytes,
} from "../apps/zcode-cli/packages/core/src/tool/executor/result-content-projection.js";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

const EMOJI = "👋🏽";            // surrogate pair + modifier: 4 code points, 11 UTF-8 bytes
const CJK = "日本語テキスト";       // 3 bytes per code point
const COMBINING = "é";          // decomposed: 2 code points
const FAMILY = "👨‍👩‍👧";           // ZWJ sequence: 5 code points, 25 bytes

const VALUES: [string, string][] = [
  ["ascii", "abcdefghij"],
  ["emoji", EMOJI.repeat(4)],
  ["cjk", CJK.repeat(3)],
  ["combining", COMBINING.repeat(6)],
  ["zwj_family", FAMILY.repeat(2)],
  ["mixed", `start ${EMOJI} ${CJK} ${COMBINING} end`],
  ["empty", ""],
  ["single_ascii", "x"],
  ["long_ascii", "a".repeat(500)],
];

const results: Record<string, unknown> = {};

// fitStringToBytes across byte budgets, both directions.
for (const [name, value] of VALUES) {
  for (const maxBytes of [0, 1, 2, 3, 4, 5, 8, 11, 16, 32, 64, 1000]) {
    for (const direction of ["head", "tail"] as const) {
      results[`fit/${name}/${maxBytes}/${direction}`] = fitStringToBytes(value, maxBytes, direction);
    }
  }
}

// fitContentWithSuffix: the suffix is always taken from the head and reserved first.
for (const [name, value] of VALUES) {
  for (const maxBytes of [0, 4, 12, 40, 200]) {
    for (const direction of ["head", "tail"] as const) {
      results[`suffix/${name}/${maxBytes}/${direction}`] = fitContentWithSuffix(
        value,
        maxBytes,
        "\n\n[truncated]",
        direction,
      );
    }
  }
}

// A suffix longer than the whole budget collapses to the budgeted suffix alone.
results["suffix/longer_than_budget"] = fitContentWithSuffix("content", 4, "0123456789", "head");

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/result-budget-golden.json`, JSON.stringify(results, null, 2) + "\n");
console.log(`captured ${Object.keys(results).length} budget cases`);
let truncated = 0;
for (const value of Object.values(results)) if (typeof value === "string" && value.length < 10) truncated += 1;
console.log(`  ${truncated} of them came back short (a real truncation happened)`);
