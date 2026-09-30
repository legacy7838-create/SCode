/**
 * `@zcode/rust/mcp-config` — typed wrapper over the `zcode-mcp-config` binary.
 *
 * Spec: docs/specs/rust-native-mcp-config.md §18.
 *
 * This wrapper is why `packages/desktop/src/main/mcpUserDirectory/legacy.ts` is deleted rather
 * than disabled. The algorithm — the brace scanner, the double-encoded `store.json`, the
 * Latin-1 mining of LevelDB `.ldb`/`.log` files — has lived in Rust since the crate was written;
 * what was missing was `require()`-ability, so Node kept its own copy and the two could drift.
 *
 * There is **no JavaScript fallback** (docs/specs/rust-native-ports.md invariant 1). If the binary
 * is missing, `loadNative` throws. A migration that quietly finds nothing and a migration that
 * never ran look identical to the user, so failing loudly is the only honest option.
 */
import { homedir } from "node:os";

import { loadNative } from "./loader.js";

/**
 * Mirrors `McpServerConfig` from `@zcode/shared`.
 *
 * Declared here rather than imported because `packages/rust` holds **zero npm dependencies** on
 * purpose — it is a native surface, and a type-only import would still couple the two build
 * graphs. `taskIndex.ts` does the same. The agreement between this and the shared declaration is
 * checked by `scripts/verify-mcp-config-native.mts`, which asserts the field names on the wire.
 */
export type McpServerConfig = Record<string, unknown>;

/** Mirrors `MigrateLegacyCommonMcpRequest` from `@zcode/shared`. */
export interface MigrateLegacyCommonMcpRequest {
  /** An explicit directory to search first; it wins over the derived candidates. */
  legacyStorageDir?: string;
}

/** Mirrors `MigrateLegacyCommonMcpResult` from `@zcode/shared`. */
export interface MigrateLegacyCommonMcpResult {
  servers: Record<string, McpServerConfig>;
  /**
   * Omitted entirely when nothing was found — the original returns no key at all, and emitting
   * `""` would claim a hit at the empty path.
   */
  sourcePath?: string;
  /** Total number of MCP configs found in the legacy data. */
  totalCount: number;
  /** Number successfully imported. Always 0: finding them is all this call does. */
  importedCount: number;
  /** Number skipped because they already existed. Always 0, for the same reason. */
  skippedCount: number;
}

interface NativeMcpConfigModule {
  /**
   * `Task`-backed, so it is a `Promise` on the JavaScript side: the native call walks a
   * directory tree and reads every `.ldb`/`.log` file in it, which must not happen on the
   * Electron main thread.
   */
  migrateLegacyCommonMcp(requestJson: string): Promise<string>;
}

let cached: NativeMcpConfigModule | null = null;

function module(): NativeMcpConfigModule {
  cached ??= loadNative<NativeMcpConfigModule>("zcode-mcp-config");
  return cached;
}

/**
 * Finds MCP server configs left behind by older installs.
 *
 * The four environment inputs are passed as **data** rather than read inside the crate, which is
 * what keeps `migrate_legacy_common_mcp` a pure function. That is the original's
 * `process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")`, reproduced at the boundary:
 *
 * - `??` falls through only on `null`/`undefined`, so an **empty but present** `LOCALAPPDATA` is
 *   used as-is and yields relative candidate paths. It is not treated as absent. Changing this
 *   would search a different place on a misconfigured machine and silently migrate nothing.
 * - `os.homedir()` is only consulted when the variable is absent.
 *
 * "Nothing found" resolves to an empty result rather than rejecting: most machines have no
 * legacy MCP data, and that is not a failure.
 */
export async function migrateLegacyCommonMcp(
  request?: MigrateLegacyCommonMcpRequest,
): Promise<MigrateLegacyCommonMcpResult> {
  const raw = await module().migrateLegacyCommonMcp(
    JSON.stringify({
      legacyStorageDir: request?.legacyStorageDir ?? null,
      localAppData: process.env.LOCALAPPDATA ?? null,
      appData: process.env.APPDATA ?? null,
      home: homedir(),
    }),
  );
  return JSON.parse(raw) as MigrateLegacyCommonMcpResult;
}

/** Every export, for callers that want a single namespace object. */
export const nativeMcpConfig = {
  migrateLegacyCommonMcp,
};
