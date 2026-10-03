import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  decodeProviderConfigFile,
  encodeProviderConfigFile,
  resolveZCodeBuiltinClientPlatform,
  resolveZCodeBuiltinCachePaths,
  resolveNodeProviderRuntimePaths,
  createNodeProviderRuntimePathEnv,
  materializeZCodeBuiltinProviderConfig,
  NodePersonalProviderConfigRepository,
  NodeModelSelectionConfigRepository,
  NodeZCodeBuiltinProviderConfigSource,
  NodeProviderConfigRuntime,
  classificationMatchesSharedProviderIds,
} from "../packages/rust/src/providerNode.ts";

const fixture = fs.readFileSync(
  "packages/rust/crates/zcode-provider-config/tests/_fixture_canonical_builtin.json",
  "utf8",
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-smoke-"));

// 1. Environment contract
assert.equal(ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV, "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE");
assert.equal(PERSONAL_PROVIDER_CONFIG_FILE_NAME, "provider_config.json");
assert.match(resolveZCodeBuiltinClientPlatform(), /^(linux|darwin|windows)-/);

// 2. Cache paths + runtime paths
const cache = resolveZCodeBuiltinCachePaths({
  environmentConfigRoot: dir,
  platform: resolveZCodeBuiltinClientPlatform(),
  appVersion: "1.0.0",
  zcodeEndpointOrigin: "https://api.z.ai/",
});
assert.ok(cache.activeFilePath.endsWith("zcode-builtin.json"));
const paths = resolveNodeProviderRuntimePaths({
  [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: "/a.json",
  [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/b.json",
});
assert.equal(paths?.personalFilePath, "/b.json");
assert.equal(resolveNodeProviderRuntimePaths({}), null);
assert.equal(
  createNodeProviderRuntimePathEnv({
    zcodeBuiltinFilePath: "/a.json",
    personalFilePath: "/b.json",
  })[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV],
  "/a.json",
);

// 3. Materialise the bundled release
const bundled = materializeZCodeBuiltinProviderConfig({
  environmentConfigRoot: dir,
  content: fixture,
});
assert.ok(fs.readFileSync(bundled, "utf8").endsWith("}\n"));

// 4. Codec round trip through hydration (domain objects in, document out)
const source = new NodeZCodeBuiltinProviderConfigSource({ bundledFilePath: bundled, watch: false });
const builtinSnapshot = await source.read();
assert.match(builtinSnapshot.revision, /^zcode-builtin:32:/);
assert.ok(typeof builtinSnapshot.providers.toJSON === "function", "hydrated domain object");
assert.ok(builtinSnapshot.providerTemplates, "templates hydrated");
const events: string[] = [];
source.onDidChange((r) => events.push(r));
source.dispose();

// 5. Personal repository: hydration + domain transform inside the lock
const personalPath = path.join(dir, PERSONAL_PROVIDER_CONFIG_FILE_NAME);
// The legacy import answers the same domain update the deleted TS importer
// held; the empty layer comes from the codec itself so no second parser is
// exercised here.
const emptyLayer = decodeProviderConfigFile({
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
});
const repo = new NodePersonalProviderConfigRepository({
  filePath: personalPath,
  importLegacy: async () => ({ ...emptyLayer, providerOrder: ["legacy-provider"] }),
});
const personal = await repo.read();
assert.deepEqual(personal.providers.toJSON(), [], "hydrated empty provider map");
assert.deepEqual(personal.providerOrder, ["legacy-provider"]);
assert.ok(/^[0-9a-f]{64}$/.test(personal.revision));
const updated = await repo.update((current) => ({
  ...current,
  providerOrder: [...(current.providerOrder ?? []), "second"],
}));
assert.deepEqual(updated.providerOrder, ["legacy-provider", "second"]);

// decode/encode through the domain round trip
const document = encodeProviderConfigFile(updated);
assert.equal(document.schemaVersion, 1);
assert.ok(document.config.providerConfigRules);
const back = decodeProviderConfigFile(JSON.parse(JSON.stringify(document)));
assert.deepEqual(back.providerOrder, updated.providerOrder);

// 6. Model selection default via the native transform
const selectionRepo = new NodeModelSelectionConfigRepository({ personalRepository: repo });
const saved = await selectionRepo.saveConfiguredDefault({ providerId: "p", modelId: "m" });
assert.equal(saved?.modelId, "m");
selectionRepo.dispose();
repo.dispose();

// 7. The runtime: builtin snapshot + personal through one owner + refresh routing
const runtime = new NodeProviderConfigRuntime({
  zcodeBuiltinFilePath: bundled,
  personalFilePath: path.join(dir, "runtime-" + PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  watch: false,
});
await runtime.start();
const runtimeBuiltin = await runtime.zcodeBuiltinSource.read();
assert.match(runtimeBuiltin.revision, /^zcode-builtin:32:/);
assert.equal(await runtime.refreshZCodeBuiltin({ force: true }), "skipped", "no remote edge");
assert.ok((await runtime.resolveZCodeBuiltinActiveFilePath()).endsWith("zcode-builtin.json"));
const configSnapshot = await runtime.configService.read();
assert.ok(configSnapshot.revision.includes("["), "composed revision shape");
runtime.dispose();
assert.equal(await runtime.refreshZCodeBuiltin(), "disposed");

// 8. Classification parity between the native mirror and @zcode/shared
assert.ok(classificationMatchesSharedProviderIds(), "native classification matches @zcode/shared");

fs.rmSync(dir, { recursive: true, force: true });
console.log("WRAPPER SMOKE OK");
