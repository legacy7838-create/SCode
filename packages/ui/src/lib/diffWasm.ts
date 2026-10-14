/**
 * Renderer facade for the line-diff WASM kernel (`packages/desktop/zcode-diff-wasm`).
 *
 * The diff is computed **synchronously during React render** (`ToolCallBlocks`'s `useMemo` ->
 * `buildToolDisplayModel` -> `buildUnifiedDiff`), so the kernel must be callable without awaiting.
 * A napi addon cannot load in this Vite browser bundle, and every RPC method is async, so the only
 * synchronous boundary available is WASM compiled up front.
 *
 * See `spec/native-boundary-line-diff.md`.
 *
 * # Zero JavaScript fallback
 *
 * The kernel is the only diff implementation. If the artifact is missing, or `prepareDiffKernel`
 * has not run, {@link diffPatch} / {@link lineChangeStat} **throw** — they never recompute the diff
 * in JavaScript. The caller (renderer bootstrap) awaits `prepareDiffKernel` before first render; a
 * missed await is a loud error, not a silent slow path.
 */
import initKernel, { diff_patch, initSync, line_change_stat } from "@zcode-diff-wasm-web";

/** `[added, removed]`, matching the shape both JS call sites already used. */
interface LineChangeStat {
  added: number;
  removed: number;
}

let prepared = false;
let preparePromise: Promise<void> | null = null;

/**
 * Compile and instantiate the kernel once.
 *
 * `wasmUrl` is the bundled `?url` asset for `zcode_diff_web_bg.wasm`. The fetch + compile happen
 * here; every later {@link diffPatch} call is synchronous. Idempotent: repeat calls share one
 * promise.
 *
 * Throws if the bytes cannot be fetched or compiled — there is no JS fallback to degrade to.
 */
export function prepareDiffKernel(wasmUrl: string): Promise<void> {
  if (prepared) {
    return Promise.resolve();
  }
  if (preparePromise) {
    return preparePromise;
  }

  preparePromise = (async () => {
    let bytes: ArrayBuffer;
    try {
      const response = await fetch(wasmUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      bytes = await response.arrayBuffer();
    } catch (error) {
      throw new Error(
        `zcode-diff wasm payload could not be fetched from ${wasmUrl}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Build it with: node packages/desktop/scripts/prepare-zcode-diff-wasm.mjs`,
      );
    }

    // `initSync` performs `new WebAssembly.Module(bytes)` + `new WebAssembly.Instance(...)`, which
    // is synchronous and is the whole reason the render-time call can stay sync. `initKernel` (the
    // async default) is imported only so its presence is checked — using it would reintroduce an
    // await at the first diff.
    if (typeof initSync !== "function" || typeof initKernel !== "function") {
      throw new Error(
        "zcode-diff wasm glue is missing initSync/diff_patch — rebuild with " +
          "node packages/desktop/scripts/prepare-zcode-diff-wasm.mjs",
      );
    }
    initSync({ module: bytes });
    prepared = true;
  })();

  return preparePromise;
}

function assertPrepared(): void {
  if (!prepared) {
    throw new Error(
      "zcode-diff kernel is not prepared. The renderer bootstrap must await " +
        "prepareDiffKernel(diffWasmUrl) before any diff is computed. There is no JavaScript " +
        "fallback.",
    );
  }
}

/**
 * Build the unified diff (mirrors the removed `buildUnifiedDiff`), WITHOUT context trimming.
 *
 * The caller applies `trimPatchContext` for the context-limited form; that is a string hunk
 * post-processor, not an LCS, so it stays in TypeScript.
 */
export function diffPatch(
  before: string,
  after: string,
  fileLabel: string,
  contextLines: number,
): string {
  assertPrepared();
  return diff_patch(before, after, fileLabel, contextLines);
}

/**
 * Standalone `{added, removed}` (mirrors the removed `computeLineChangeStat`), using that
 * function's logical-line split (a trailing empty line is dropped, unlike {@link diffPatch}).
 *
 * `before` may be `null` (a created file), matching the removed signature; the kernel receives `""`.
 */
export function lineChangeStat(before: string | null, after: string): LineChangeStat {
  assertPrepared();
  const counts = line_change_stat(before ?? "", after);
  return { added: counts[0] ?? 0, removed: counts[1] ?? 0 };
}
