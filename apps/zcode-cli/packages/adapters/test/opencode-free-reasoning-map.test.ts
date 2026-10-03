import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadNative } from "@zcode/rust";

/** The differential corpus runs against the binary directly (spec §4). */
const engine = loadNative<{
  compileModelOptionMap(
    source: string,
    variable: string,
  ): { evaluate(input: string | number): unknown };
  applyOrderedJsonMergePatches(bodyJson: string, patchesJson: string): string;
}>("zcode-model-option-map");

function applyOrderedJsonMergePatches(
  body: Record<string, unknown>,
  patches: readonly { option: string; patch: unknown }[],
): Record<string, unknown> {
  return JSON.parse(
    engine.applyOrderedJsonMergePatches(JSON.stringify(body), JSON.stringify(patches)),
  ) as Record<string, unknown>;
}

const compileModelOptionMap = engine.compileModelOptionMap.bind(engine);

/**
 * The generic Anthropic rule maps `reasoningLevel: "disabled"` to `{"thinking": {"type":"disabled"}}`,
 * which the OpenCode gateway rejects with 400 invalid_request_error (verified live 2026-10-01).
 * 修复原因：OpenCode Free 网关不接受 `thinking:{type:"disabled"}` 请求体；
 * 修复方式：为该 Provider 增加覆盖规则，disabled 时直接删除 `thinking` 字段而不是写入 disabled 块。
 * The OpenCode override must therefore delete the field instead of writing a disabled block.
 */

const builtinConfig = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url)),
    "utf8",
  ),
) as {
  config: {
    modelConfigRules: {
      modelApiRules: {
        modelMatch: string;
        config: { optionSpecs: { reasoningLevel: { map: string } } };
      }[];
    };
  };
};

const overrideRule = builtinConfig.config.modelConfigRules.modelApiRules.find(
  (rule) => rule.modelMatch === "space-bunny-free",
);
assert.ok(overrideRule, "the OpenCode reasoning override must exist");

const program = compileModelOptionMap(
  overrideRule.config.optionSpecs.reasoningLevel.map,
  "reasoningLevel",
);

test("a disabled reasoning level never writes a thinking block", () => {
  const patched = applyOrderedJsonMergePatches({ messages: [], thinking: { type: "disabled" } }, [
    { option: "reasoningLevel", patch: program.evaluate("disabled") },
  ]);
  assert.equal("thinking" in patched, false, "the gateway rejects a disabled thinking block");
});

test("an enabled reasoning level keeps the accepted adaptive block", () => {
  const patched = applyOrderedJsonMergePatches({ messages: [] }, [
    { option: "reasoningLevel", patch: program.evaluate("enabled") },
  ]);
  // Merge patches build null-prototype objects; compare their JSON shape.
  assert.deepEqual(JSON.parse(JSON.stringify(patched.thinking)), { type: "adaptive" });
  assert.deepEqual(JSON.parse(JSON.stringify(patched.output_config)), { effort: "high" });
});
