/**
 * Single loader for compiled Rust napi binaries.
 *
 * INVARIANT (spec: docs/specs/rust-native-ports.md): there is NO JavaScript
 * fallback anywhere in this package. If a native binary cannot be loaded, the
 * only correct behavior is a loud, actionable error — never a degraded path.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_PLATFORM_SUFFIXES } from "./native-targets.generated.js";

/**
 * Absolute path of the module that hosts this loader, resolved lazily.
 *
 * esbuild compiles the CJS bundles (the CLI/Agent `zcode.cjs`, the TUI bundle) with `import.meta`
 * replaced by an empty object, so `import.meta.url` is `undefined` there and both `createRequire`
 * and `fileURLToPath` throw. A CJS bundle always has a real `__filename`, so prefer it and fall back
 * to `import.meta.url` only for genuine ESM output (desktop main/host/scheduler, the tsc build).
 * The lookup is deferred on purpose: importing this module must never throw on its own, and the
 * failure must stay attached to the `loadNative()` call that actually needs the binary.
 */
function hostModulePath(): string {
  return typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
}

/** `require` scoped to this module, used only to resolve the package directory and the binary. */
function hostRequire(): NodeRequire {
  return createRequire(hostModulePath());
}

/**
 * Maps the current process to a napi-style platform suffix.
 *
 * The table is generated from the packaging tool's Rust source of truth
 * (`packages/rust/crates/zcode-packaging/src/target.rs`), so it cannot drift from
 * `scripts/build-native.sh` or from the staged payload. This function used to spell out
 * the same six rows itself; `cargo test -p zcode-packaging` now fails if that switch
 * comes back (spec P4, docs/specs/rust-native-packaging.md).
 */
export function nativePlatformTarget(): string {
  const key = `${process.platform}-${process.arch}` as keyof typeof NATIVE_PLATFORM_SUFFIXES;
  const suffix = NATIVE_PLATFORM_SUFFIXES[key];
  if (!suffix) {
    throw new Error(`[zcode-rust] unsupported platform ${key} for native binaries`);
  }
  return suffix;
}

function candidatePaths(fileName: string): string[] {
  const here = dirname(hostModulePath());
  const candidates: (string | null)[] = [
    process.env.ZCODE_NATIVE_DIR ? join(process.env.ZCODE_NATIVE_DIR, fileName) : null,
    // dev / node_modules layout: packages/rust/<name>.<target>.node next to src/
    join(here, "..", fileName),
    // staged layout (desktop agent bundle / SEA extraction): native/ next to the entry
    join(here, "..", "native", fileName),
    (() => {
      try {
        return join(dirname(hostRequire().resolve("@zcode/rust/package.json")), fileName);
      } catch {
        return null;
      }
    })(),
  ];
  return candidates.filter((c): c is string => c !== null);
}

/**
 * Loads a compiled napi binary by crate name (e.g. "zcode-image").
 * Throws when the binary is missing or fails to load. Never falls back to JS.
 */
export function loadNative<T>(binaryName: string): T {
  const fileName = `${binaryName}.${nativePlatformTarget()}.node`;
  const candidates = candidatePaths(fileName);
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `[zcode-rust] native binary ${fileName} not found. Searched: ${candidates.join(", ")}. ` +
        `Build it with \`pnpm --filter @zcode/rust build:native\`. ` +
        `This package has no JavaScript fallback by design.`,
    );
  }
  try {
    return hostRequire()(found) as T;
  } catch (cause) {
    throw new Error(`[zcode-rust] failed to load native binary ${found}: ${String(cause)}`, { cause });
  }
}
