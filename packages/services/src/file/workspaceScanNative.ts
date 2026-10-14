// Node-API native binding loader for the Rust `zcode-scan` addon.
//
// The desktop host / services process loads the compiled addon lazily, exactly like
// `zcodeDb.ts`. There is **no JavaScript fallback**: if the addon is missing this module throws
// at load time so a silently-degraded workspace scan cannot ship (see
// `spec/native-boundary-workspace-scan.md` §1.1).
//
// Resolution order (mirrors `zcodeDb.ts`):
//   1. `process.env.ZCODE_SCAN_NATIVE` (absolute path — packaged host).
//   2. otherwise `zcode_scan.node` staged next to the crate in dev.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Rust addon surface consumed by the workspace file index path. */
interface ScanAddon {
  scanWorkspaceFilesPacked(rootPath: string, ignoreRuleText: string, locale: string): string;
}

function resolveNativePath(): string {
  const fromEnv = process.env.ZCODE_SCAN_NATIVE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`ZCODE_SCAN_NATIVE points to a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  // packages/services/src/file/workspaceScanNative.ts → packages/desktop/zcode-scan/zcode_scan.node
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "../../../desktop/zcode-scan/zcode_scan.node");
  if (!existsSync(candidate)) {
    throw new Error(
      `zcode-scan native addon not found at ${candidate}. Build it with: node packages/desktop/scripts/prepare-zcode-scan-native.mjs (or set ZCODE_SCAN_NATIVE).`,
    );
  }
  return candidate;
}

let cached: ScanAddon | null = null;

/** Load (once, cached) the Rust scan addon. Throws clearly if it is missing — no fallback. */
function loadAddon(): ScanAddon {
  if (!cached) {
    const req = createRequire(import.meta.url);
    cached = req(resolveNativePath()) as ScanAddon;
  }
  return cached;
}

// Collation parity helper. Node's bare `localeCompare` uses the runtime default locale, which
// differs per machine, so the resolved locale is memoized once and reused for every scan call.
// Rust receives this exact value (hardcoded `Strength::Tertiary` only depends on it).
let cachedLocale: string | null = null;

export function resolveWorkspaceScanLocale(): string {
  if (cachedLocale === null) {
    cachedLocale = new Intl.Collator().resolvedOptions().locale;
  }
  return cachedLocale;
}

/** Scan a workspace and return the columnar packed file index (addon is the only implementation). */
export function scanWorkspaceFilesPacked(input: {
  rootPath: string;
  ignoreRuleText: string;
  // 调用方传入已解析的 ICU locale；为空时回退到 memoized 的默认 locale，避免 locale 误猜。
  locale: string;
}): string {
  const addon = loadAddon();
  const locale =
    input.locale && input.locale.trim().length > 0 ? input.locale : resolveWorkspaceScanLocale();
  return addon.scanWorkspaceFilesPacked(input.rootPath, input.ignoreRuleText, locale);
}
