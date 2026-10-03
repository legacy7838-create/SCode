/**
 * Invariant-10 bench: the deleted TypeScript `model-option-map` against the
 * native `zcode-model-option-map` binding. Spec:
 * docs/specs/rust-native-model-option-map.md §3.3.
 *
 * The TS sources are recovered from git (`TS_REF`, default `HEAD` — they were
 * still present there at merge time), so the comparison stays reproducible
 * after the package is deleted:
 *
 *   TS_REF=<pre-deletion-ref> npx tsx packages/rust/scripts/bench-model-option-map.mts
 *
 * Three shapes are measured, because the binding shape is decided by this
 * table, not by taste:
 *
 *  - `ts-adapter`: exactly what the request path did before the port —
 *    `JSON.parse(bodyText)` + `apply(objects)` + `JSON.stringify(patched)`.
 *  - `ts-apply`: the object-only `apply` (lower bound of the TS interface).
 *  - `native-json`: `applyJson(bodyText, values)` — one string in, one out.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TS_REF = process.env.TS_REF ?? "HEAD";
const ROUNDS = 5;

// ---------------------------------------------------------------------------
// Recover the deleted TS implementation from git
// ---------------------------------------------------------------------------
const tsDir = mkdtempSync(join(tmpdir(), "mom-bench-ts-"));
for (const file of [
  "compiler",
  "evaluator",
  "merge-patch",
  "option-maps",
  "parser",
  "tokenizer",
  "types",
  "index",
]) {
  const source = execFileSync(
    "git",
    ["show", `${TS_REF}:packages/model-option-map/src/${file}.ts`],
    {
      encoding: "utf8",
    },
  );
  writeFileSync(join(tsDir, `${file}.ts`), source);
}

interface Maps {
  apply(body: Record<string, unknown>, values: Values): Record<string, unknown>;
  applyJson(bodyJson: string, values: Values): string;
}
interface Values {
  reasoningLevel: string;
  maxOutputTokens: number;
}
interface SpecMaps {
  reasoningLevel: { map: string };
  maxOutputTokens: { map: string };
}

const tsModule = (await import(pathToFileURL(join(tsDir, "index.ts")).href)) as {
  compileModelOptionMaps(specs: SpecMaps): {
    apply(body: Record<string, unknown>, values: Values): Record<string, unknown>;
  };
};
const nativeModule = (await import("../src/modelOptionMap.ts")) as {
  compileModelOptionMaps(specs: SpecMaps): Maps;
};

// ---------------------------------------------------------------------------
// Inputs: a realistic provider request body at two sizes
// ---------------------------------------------------------------------------
const specs: SpecMaps = {
  // Real rules from config/provider/zcode-builtin.json (the generic Anthropic
  // reasoning map and the standard maxOutputTokens map), so the measured work
  // is what production compiles and evaluates — not a toy expression.
  reasoningLevel: {
    map: `reasoningLevel == "disabled"
  ? {
      "thinking": {
        "type": "disabled"
      }
    }
  : {
      "thinking": {
        "type": "adaptive"
      },
      "output_config": {
        "effort": reasoningLevel == "enabled" ? "high" : reasoningLevel
      }
    }`,
  },
  maxOutputTokens: { map: "{ 'max_tokens': maxOutputTokens }" },
};

function bodyOf(size: number): string {
  const base = {
    model: "glm-5",
    messages: [] as { role: string; content: string }[],
    thinking: { type: "disabled" },
  };
  while (JSON.stringify(base).length < size) {
    base.messages.push({ role: "user", content: "x".repeat(128) });
  }
  return JSON.stringify(base);
}
const values: Values = { reasoningLevel: "enabled", maxOutputTokens: 8192 };

// ---------------------------------------------------------------------------
// Measure: median of ROUNDS rounds
// ---------------------------------------------------------------------------
function bench(
  label: string,
  iterations: { count: number; size: number },
  run: (body: string) => void,
): void {
  const body = bodyOf(iterations.size ?? 0);
  const rounds: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const started = performance.now();
    for (let i = 0; i < iterations.count; i += 1) run(body);
    rounds.push(performance.now() - started);
  }
  rounds.sort((a, b) => a - b);
  const median = rounds[2]!;
  const perCall = (median / iterations.count) * 1e6; // ns
  console.log(
    `${label.padEnd(28)} ${String(iterations.count).padStart(7)} iters  ` +
      `${median.toFixed(1).padStart(9)} ms total  ${perCall.toFixed(0).padStart(6)} ns/op`,
  );
}
const tsMaps = tsModule.compileModelOptionMaps(specs);
const nativeMaps = nativeModule.compileModelOptionMaps(specs);

for (const [size, count] of [
  [1_024, 100_000],
  [10_240, 30_000],
] as const) {
  console.log(`\nbody ≈ ${size} B`);
  const parsed: Record<string, unknown>[] = [];
  const bodyText = bodyOf(size);
  // Warm the parse cache paths outside the measured loop for the object reuse
  // lower bound; the adapter shape pays its parse inside the loop, as it did.
  for (let i = 0; i < 16; i += 1) parsed.push(JSON.parse(bodyText) as Record<string, unknown>);
  const reused = parsed[0]!;

  bench("ts-adapter parse+apply+stringify", { count, size }, (text) => {
    const parsedBody = JSON.parse(text) as Record<string, unknown>;
    const patched = tsMaps.apply(parsedBody, values);
    JSON.stringify(patched);
  });

  bench("ts-apply (objects)", { count, size }, () => {
    tsMaps.apply(reused, values);
  });

  bench("native-json applyJson", { count, size }, (text) => {
    nativeMaps.applyJson(text, values);
  });
}

// Compile cost: one per model — still worth recording, it sits on model
// creation and validation paths.
{
  const iterations = 2_000;
  for (const [label, compile] of [
    ["ts-compile", () => tsModule.compileModelOptionMaps(specs)],
    ["native-compile", () => nativeModule.compileModelOptionMaps(specs)],
  ] as const) {
    const started = performance.now();
    for (let i = 0; i < iterations; i += 1) compile();
    const per = ((performance.now() - started) / iterations) * 1e6;
    console.log(
      `${label.padEnd(28)} ${String(iterations).padStart(7)} compiles ${per.toFixed(0).padStart(6)} ns/compile`,
    );
  }
}

// Correctness spot check: both shapes must produce the same bytes.
{
  const a = JSON.stringify(
    tsMaps.apply(JSON.parse(bodyOf(1_024)) as Record<string, unknown>, values),
  );
  const b = nativeMaps.applyJson(bodyOf(1_024), values);
  if (a !== b) {
    console.error("\nPARITY FAIL: ts and native apply differ");
    process.exit(1);
  }
  console.log("\nparity: ts apply == native applyJson (byte-identical output)");
}

rmSync(tsDir, { recursive: true, force: true });
