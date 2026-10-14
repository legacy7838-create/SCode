// Host-side native binding loader for the Rust `zcode-diff-wasm` kernel.
//
// The Host computes line-change stats synchronously while building per-turn / task change summaries
// (`packages/services/src/session/taskChangeSummary.ts`). This module loads the kernel's **nodejs**
// wasm-bindgen glue and calls it synchronously.
//
// There is **no JavaScript fallback**: if the artifact is missing this module throws at load time,
// so a silently-degraded diff cannot ship (see `spec/native-boundary-line-diff.md` §1.1).
//
// Resolution order:
//   1. `process.env.ZCODE_DIFF_WASM_GLUE` (absolute path — packaged host).
//   2. otherwise `pkg/nodejs/zcode_diff.js` staged next to the crate in dev.
//
// Note this is the *Host* facade. The renderer has its own loader
// (`packages/ui/src/lib/diffWasm.ts`) over the `web` glue, because the Host's nodejs glue is
// CommonJS and cannot load in the Vite browser bundle. Both wrap the same Rust kernel.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The nodejs glue surface this Host path consumes. */
interface DiffKernel {
  line_change_stat(before: string, after: string): Uint32Array;
}

function resolveGluePath(): string {
  const fromEnv = process.env.ZCODE_DIFF_WASM_GLUE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`ZCODE_DIFF_WASM_GLUE points to a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  // packages/services/src/session/diffNative.ts → packages/desktop/zcode-diff-wasm/pkg/nodejs
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "../../../desktop/zcode-diff-wasm/pkg/nodejs/zcode_diff.js");
  if (!existsSync(candidate)) {
    throw new Error(
      `zcode-diff wasm glue not found at ${candidate}. Build it with: node packages/desktop/scripts/prepare-zcode-diff-wasm.mjs (or set ZCODE_DIFF_WASM_GLUE).`,
    );
  }
  return candidate;
}

let cached: DiffKernel | null = null;

/** Load (once, cached) the diff kernel. Throws clearly if it is missing — no fallback. */
function loadKernel(): DiffKernel {
  if (!cached) {
    const req = createRequire(import.meta.url);
    cached = req(resolveGluePath()) as DiffKernel;
  }
  return cached;
}

/**
 * Compute the line-change stat on the Host (kernel is the only implementation).
 *
 * Mirrors the removed `computeLineChangeStat`: the kernel's `logical-line` split drops a trailing
 * empty line, which is why this entry point differs from the patch's `diff_counts`.
 */
export function computeLineChangeStatNative(
  before: string | null,
  after: string,
): {
  added: number;
  removed: number;
} {
  const kernel = loadKernel();
  const counts = kernel.line_change_stat(before ?? "", after);
  return { added: counts[0] ?? 0, removed: counts[1] ?? 0 };
}
