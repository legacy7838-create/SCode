/**
 * End-to-end check that TypeScript reaches the Rust MCP legacy migration, and that the deleted
 * `packages/desktop/src/main/mcpUserDirectory/legacy.ts` is really gone rather than shadowed.
 *
 * The fixtures are written here rather than checked in as blobs, because the point is to prove the
 * *decoding layers* survive the napi boundary: `store.json` is a JSON object whose
 * `"mcp-storage"` value is itself a JSON **string** (so two decodes), and the LevelDB files hold
 * Latin-1 bytes with the config embedded in a LevelDB record.
 *
 * Usage (from the repo root):
 *   ZCODE_NATIVE_DIR="$PWD/packages/rust" node_modules/.bin/tsx scripts/verify-mcp-config-native.mts
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { migrateLegacyCommonMcp } from "../packages/rust/src/mcpConfig.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const root = mkdtempSync(join(tmpdir(), "zcode-mcp-config-e2e-"));
const appData = join(root, "AppData", "Roaming");
const localAppData = join(root, "AppData", "Local");

// The environment is redirected for the whole run, not per-case. On Linux neither `APPDATA` nor
// `LOCALAPPDATA` is set, so without this the native call derives candidates under the real
// `$HOME` and never sees the fixtures — the first version of this script had exactly that bug
// and reported four phantom failures.
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalAppData = process.env.APPDATA;
process.env.LOCALAPPDATA = localAppData;
process.env.APPDATA = appData;

/** `store.json`: the `mcp-storage` value is a JSON *string*, so it needs two decodes. */
function writeStoreJson(): string {
  const storePath = join(appData, "ai.z.zcode", "store.json");
  mkdirSync(dirname(storePath), { recursive: true });
  const inner = {
    state: {
      config: { mcp: { mcpServers: { fs: { command: "npx", args: ["-y", "mcp-fs"] } } } },
    },
  };
  writeFileSync(
    storePath,
    JSON.stringify({ "mcp-storage": JSON.stringify(inner) }),
    "utf-8",
  );
  return storePath;
}

/** A LevelDB directory: the config is embedded in Latin-1 bytes under an `mcp-config` key. */
function writeLevelDb(): string {
  const levelDb = join(localAppData, "ai.z.work", "EBWebView", "Default", "Local Storage", "leveldb");
  mkdirSync(levelDb, { recursive: true });
  const payload = Buffer.from(
    JSON.stringify({ mcp: { mcpServers: { git: { command: "uvx", args: ["mcp-git"] } } } }),
    "utf-8",
  );
  // Prefix noise, then the key, then the JSON — the scanner finds the key and balances from the
  // first `{` after it.
  const prefix = Buffer.from([0x00, 0x01, 0x9a, 0x2f, 0xff, 0x7f]);
  writeFileSync(join(levelDb, "000003.log"), Buffer.concat([prefix, Buffer.from("mcp-config"), payload]));
  // A decoy that must be read first (the numeric-`localeCompare` sort puts the higher name first)
  // and must not win, because its servers are not records.
  writeFileSync(
    join(levelDb, "000009.ldb"),
    Buffer.concat([prefix, Buffer.from("mcp-config"), Buffer.from('{"mcp":{"mcpServers":{}}}')]),
  );
  return levelDb;
}

// 1. store.json — the first candidate, and the first hit.
const storePath = writeStoreJson();
writeLevelDb();
const fromStore = await migrateLegacyCommonMcp();
check(
  "store.json wins over the LevelDB candidates",
  fromStore.sourcePath === storePath,
  fromStore.sourcePath,
);
check("the double-encoded mcp-storage is decoded", fromStore.servers.fs?.command === "npx");
check(
  "the counts are the server count",
  fromStore.totalCount === 1 && fromStore.importedCount === 0 && fromStore.skippedCount === 0,
  `total=${fromStore.totalCount} imported=${fromStore.importedCount} skipped=${fromStore.skippedCount}`,
);

// 2. LevelDB, with no store.json present — the latin1 mining path.
const cleanRoot = mkdtempSync(join(tmpdir(), "zcode-mcp-config-e2e-b-"));
const cleanLocalAppData = join(cleanRoot, "AppData", "Local");
const cleanLevelDb = join(
  cleanLocalAppData,
  "ai.z.work",
  "EBWebView",
  "Default",
  "Local Storage",
  "leveldb",
);
mkdirSync(cleanLevelDb, { recursive: true });
const gitPayload = Buffer.from(
  JSON.stringify({ mcp: { mcpServers: { git: { command: "uvx", args: ["mcp-git"] } } } }),
  "utf-8",
);
writeFileSync(
  join(cleanLevelDb, "000003.log"),
  Buffer.concat([Buffer.from([0x00, 0x01, 0x9a]), Buffer.from("mcp-config"), gitPayload]),
);

process.env.LOCALAPPDATA = cleanLocalAppData;
process.env.APPDATA = join(cleanRoot, "AppData", "Roaming");
try {
  const fromLevelDb = await migrateLegacyCommonMcp();
  check(
    "LevelDB is mined when store.json is absent",
    fromLevelDb.sourcePath.endsWith("000003.log"),
    fromLevelDb.sourcePath,
  );
  check("the latin1 payload is decoded", fromLevelDb.servers.git?.command === "uvx");

  // 3. An explicit path wins over every derived candidate.
  //
  // The dispatch is by **suffix**: a candidate whose path ends in `store.json` is read as a store
  // file, anything else is treated as a LevelDB directory. So an explicit *directory* must be
  // populated with `.ldb`/`.log` files to yield a hit — passing a directory that only holds
  // `store.json` silently finds nothing and falls through, which is the original's behaviour and
  // the reason this asserts on the LevelDB form.
  const explicitRoot = mkdtempSync(join(tmpdir(), "zcode-mcp-config-e2e-c-"));
  writeFileSync(
    join(explicitRoot, "000007.log"),
    Buffer.concat([
      Buffer.from("mcp-config"),
      Buffer.from(
        JSON.stringify({ mcp: { mcpServers: { explicit: { command: "yes" } } } }),
      ),
    ]),
  );
  const explicit = await migrateLegacyCommonMcp({ legacyStorageDir: explicitRoot });
  check(
    "an explicit legacyStorageDir wins over the derived candidates",
    explicit.servers.explicit?.command === "yes",
    explicit.sourcePath,
  );

  // 3b. The suffix dispatch, both ways.
  const storeOnly = mkdtempSync(join(tmpdir(), "zcode-mcp-config-e2e-d-"));
  const storeFile = join(storeOnly, "store.json");
  writeFileSync(
    storeFile,
    JSON.stringify({
      "mcp-storage": JSON.stringify({
        state: { config: { mcp: { mcpServers: { explicit: { command: "from-store" } } } } },
      }),
    }),
    "utf-8",
  );
  const viaStoreFile = await migrateLegacyCommonMcp({ legacyStorageDir: storeFile });
  check(
    "an explicit path ending in store.json is read as a store file",
    viaStoreFile.servers.explicit?.command === "from-store",
    viaStoreFile.sourcePath,
  );

  // 4. Nothing anywhere — the empty result, which must not be an error.
  //
  // The environment has to point at a **fresh empty root**, not just at a missing directory: an
  // absent `legacyStorageDir` only removes the first candidate, and the derived LevelDB
  // candidates under `LOCALAPPDATA` would still be searched and would still hit.
  const barrenRoot = mkdtempSync(join(tmpdir(), "zcode-mcp-config-e2e-e-"));
  const barrenLocalAppData = join(barrenRoot, "AppData", "Local");
  const barrenAppData = join(barrenRoot, "AppData", "Roaming");
  process.env.LOCALAPPDATA = barrenLocalAppData;
  process.env.APPDATA = barrenAppData;
  const empty = await migrateLegacyCommonMcp();
  check(
    "nothing found is an empty result, not a rejection",
    Object.keys(empty.servers).length === 0 &&
      empty.totalCount === 0 &&
      empty.sourcePath === undefined,
    `sourcePath=${String(empty.sourcePath)}`,
  );
} finally {
  process.env.LOCALAPPDATA = originalLocalAppData;
  process.env.APPDATA = originalAppData;
}

// 5. The invariant this whole change exists for: no JavaScript implementation is left.
const legacyPath = join(
  process.cwd(),
  "packages/desktop/src/main/mcpUserDirectory/legacy.ts",
);
check("legacy.ts is deleted, not disabled", !existsSync(legacyPath), legacyPath);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
