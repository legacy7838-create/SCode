/** Verification section: result-budget-live. See docs/specs/subagent-rust-port.md. */
import { fitContentWithSuffix, fitStringToBytes } from "../../packages/rust/src/subagentResultBudget.ts";
import { readGolden } from "./harness.js";
import { check } from "./harness.js";

export function run(): void {
  // The byte budget governs how much of a tool result the model sees. The JavaScript original
  // clips at CODE-POINT boundaries, so the corpus is mostly Unicode: emoji (surrogate pairs in
  // JS), CJK (3 bytes), combining marks, ZWJ sequences.
  const golden = readGolden<Record<string, string>>(
    "apps/zcode-cli/packages/core/testdata/agent-profiles/result-budget-golden.json",
  );
  const values: Record<string, string> = {
    ascii: "abcdefghij",
    emoji: "👋🏽👋🏽👋🏽👋🏽",
    cjk: "日本語テキスト日本語テキスト日本語テキスト",
    combining: "éééééé",
    zwj_family: "👨‍👩‍👧👨‍👩‍👧",
    mixed: "start 👋🏽 日本語テキスト é end",
    empty: "",
    single_ascii: "x",
    long_ascii: "a".repeat(500),
  };
  let mismatches = 0;
  for (const [key, expected] of Object.entries(golden)) {
    const parts = key.split("/");
    let actual: string;
    if (parts[0] === "fit") {
      actual = fitStringToBytes(values[parts[1]]!, Number(parts[2]), parts[3] as "head" | "tail");
    } else if (parts[1] === "longer_than_budget") {
      actual = fitContentWithSuffix("content", 4, "0123456789", "head");
    } else {
      actual = fitContentWithSuffix(values[parts[1]]!, Number(parts[2]), "\n\n[truncated]", parts[3] as "head" | "tail");
    }
    if (actual !== expected) {
      mismatches += 1;
      check(`budget golden ${key}`, false);
    }
  }
  check(`all ${Object.keys(golden).length} byte-budget golden cases reproduce`, mismatches === 0);

  const emoji = "👋🏽";
  check("budget is never exceeded", fitStringToBytes(emoji, 5, "head").length <= 5);
  check("head keeps the leading code point whole", fitStringToBytes(emoji, 4, "head") === "👋");
  check("tail keeps the trailing code point whole", fitStringToBytes(emoji, 4, "tail") === "🏽");
  check("no code point is split", fitStringToBytes(emoji, 7, "head") === "👋");
  check("the truncation notice survives a tiny budget",
    fitContentWithSuffix("content", 13, "\n\n[truncated]", "head").endsWith("[truncated]"));
  check("a zero budget yields empty", fitStringToBytes("anything", 0, "head") === "");
  check("CJK clips on a 3-byte boundary", fitStringToBytes("日本", 4, "head") === "日");
}
