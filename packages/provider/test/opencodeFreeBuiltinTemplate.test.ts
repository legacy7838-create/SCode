import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
} from "../src/config/schema.js";
import { ApiKeyAccessConfig } from "../src/config/provider-config.js";
import { providerTemplateConfigRuleSchema } from "../src/config/rule-data-schema.js";

/**
 * The built-in Provider config is the single source of truth for the OpenCode Free provider; this
 * suite pins the parts that would silently break the anonymous lane if they drifted.
 */

const builtinConfigUrl = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);
const builtinConfig = JSON.parse(readFileSync(fileURLToPath(builtinConfigUrl), "utf8")) as {
  config: {
    providerConfigRules: unknown;
    modelConfigRules: {
      modelApiRules: { modelMatch: string; apiTypeMatch?: string }[];
    };
  };
};

const providerRules = parseZCodeBuiltinProviderConfigRules(
  builtinConfig.config.providerConfigRules,
);
const templates = providerRules.providerTemplates.entries().map(([, template]) => template);
const opencodeFreeTemplate = providerRules.providerTemplates.get("opencode-free");

test("the built-in provider and model rules parse", () => {
  assert.ok(templates.length > 0, "builtin templates must load");
  assert.doesNotThrow(() =>
    parseZCodeBuiltinModelConfigRules(builtinConfig.config.modelConfigRules),
  );
});

test("opencode-free pins the anonymous credential and hides the key input", () => {
  assert.ok(opencodeFreeTemplate, "opencode-free template must exist");
  const config = opencodeFreeTemplate.config.toJSON();

  assert.equal(config.access?.type, "api-key");
  assert.equal(config.access?.apiKey, "public", "the anonymous lane marker must stay hardcoded");
  assert.equal(
    config.access?.apiKeyEditable,
    false,
    "the settings UI must not offer an API-key input for this provider",
  );
  assert.equal(config.api?.type, "anthropic-messages");
  assert.equal(config.api?.baseUrl, "https://opencode.ai/zen/v1");

  const headers = config.api?.headers ?? {};
  assert.match(headers["User-Agent"] ?? "", /^opencode\/(\d+)\.(\d+)/, "gate-compatible UA");
  assert.equal(headers["x-opencode-client"], "desktop");
  assert.equal(headers["x-opencode-project"], "global");

  assert.deepEqual(
    config.builtinModelIds,
    ["space-bunny-free"],
    "only models verified anonymously reachable may ship",
  );
});

test("no template may ship a credential other than the public lane marker", () => {
  const declared = templates.filter(
    (template) => template.config.toJSON().access?.apiKey !== undefined,
  );
  assert.deepEqual(
    declared.map((template) => template.templateId),
    ["opencode-free", "opencode-free-chat"],
  );
});

test("opencode-free-chat pins the same credential on the OpenAI chat lane", () => {
  const chatTemplate = providerRules.providerTemplates.get("opencode-free-chat");
  assert.ok(chatTemplate, "opencode-free-chat template must exist");
  const config = chatTemplate.config.toJSON();

  assert.equal(config.access?.type, "api-key");
  assert.equal(config.access?.apiKey, "public");
  assert.equal(config.access?.apiKeyEditable, false);
  assert.equal(config.api?.type, "openai-chat-completions");
  assert.equal(config.api?.baseUrl, "https://opencode.ai/zen/v1");
  // The identity headers are shared by both lanes; drift in one would break the upstream gate.
  assert.deepEqual(config.api?.headers, opencodeFreeTemplate.config.toJSON().api?.headers);

  // Every model here verified anonymous 200 on the chat lane (2026-10-02 probes); Console-backed
  // ids (jev/muse-spark/deepseek/ling) are deliberately absent because they fail anonymously.
  assert.deepEqual(
    [...(config.builtinModelIds ?? [])],
    [
      "big-pickle",
      "space-bunny-free",
      "fledge-alpha-free",
      "mimo-v2.5-free",
      "mimo-v2.6-flash-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
      "longcat-2.5-preview-free",
    ],
  );
});

test("the template schema rejects an arbitrary credential", () => {
  assert.throws(() =>
    providerTemplateConfigRuleSchema.parse({
      templateId: "leaky",
      templateNameMap: { "en-US": "Leaky" },
      config: { access: { type: "api-key", apiKey: "sk-real-key" } },
    }),
  );
  assert.doesNotThrow(() =>
    providerTemplateConfigRuleSchema.parse({
      templateId: "opencode-free",
      templateNameMap: { "en-US": "OpenCode Free" },
      config: { access: { type: "api-key", apiKey: "public", apiKeyEditable: false } },
    }),
  );
});

test("the OpenCode reasoning override wins over the generic Anthropic rule", () => {
  const rules = builtinConfig.config.modelConfigRules.modelApiRules;
  const genericIndex = rules.findIndex(
    (rule) => rule.modelMatch === ".*" && rule.apiTypeMatch === "anthropic-messages",
  );
  const overrideIndex = rules.findIndex(
    (rule) => rule.modelMatch === "space-bunny-free" && rule.apiTypeMatch === "anthropic-messages",
  );
  assert.ok(genericIndex >= 0, "the generic Anthropic rule must exist");
  assert.ok(overrideIndex >= 0, "the OpenCode override must exist");
  // Rules overlay in array order, so a rule before the generic one would be overwritten by it.
  assert.ok(
    overrideIndex > genericIndex,
    "the override must be appended after the generic rule to win",
  );
});

test("an empty personal overlay keeps the template's pinned credential", () => {
  const templateAccess = new ApiKeyAccessConfig({
    type: "api-key",
    apiKey: "public",
    apiKeyEditable: false,
  });
  // A Provider created from a Template stores no access fields of its own, so the built-in pin must
  // survive resolution — otherwise the card would render an empty, unusable key field again.
  const resolved = templateAccess.overlay(new ApiKeyAccessConfig());
  assert.equal(resolved.apiKey, "public");
  assert.equal(resolved.apiKeyEditable, false);
});
