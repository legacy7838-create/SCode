// The zcode-diff WASM kernel's `web` glue is a build artifact staged by
// `packages/desktop/scripts/prepare-zcode-diff-wasm.mjs` into a gitignored `pkg/` tree. The
// renderer resolves it through the `@zcode-diff-wasm-web` vite alias, but TypeScript cannot type a
// file that is absent on a clean checkout, so its shape is declared here instead.
//
// The declared surface is deliberately the minimum the facade uses. `initSync` is synchronous and
// is the reason the render-time diff can stay synchronous; `initKernel` is the async default export
// and is imported only so a glue missing `initSync` can be rejected loudly.
declare module "@zcode-diff-wasm-web" {
  export function initSync(module: { module: BufferSource | WebAssembly.Module }): unknown;
  export function diff_patch(
    before: string,
    after: string,
    fileLabel: string,
    contextLines: number,
  ): string;
  export function diff_counts(
    before: string,
    after: string,
    fileLabel: string,
    contextLines: number,
  ): Uint32Array;
  export function line_change_stat(before: string, after: string): Uint32Array;
  export function max_diff_cells(): number;
  export default function initKernel(module?: unknown): Promise<unknown>;
}
