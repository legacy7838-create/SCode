// WebAssembly scoring-kernel binding for the Rust `zcode-score-wasm` module.
//
// The desktop Host loads the compiled module lazily, exactly like `workspaceScanNative.ts`. There
// is **no JavaScript fallback**: if the artifact is missing this module throws rather than
// silently reverting to the per-candidate JS scan, which is ~10x slower on a 370k-candidate
// workspace and would fail with no signal (see `spec/native-boundary-fuzzy-score.md` §1.5).
//
// One packed index in, at most `limit` entries out. Candidates are never materialized in JS: that
// is the whole point of the boundary. The 370k rows stay in WASM linear memory, the per-keystroke
// answer comes back as at most `limit` row indices, and only those rows are decoded — through the
// SAME `unpackWorkspaceFileEntries` codec that produced the old results, so an entry's `name`,
// `path`, `relativePath` and `type` are byte-identical by construction rather than by a second
// implementation staying in sync.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";

/** Rust kernel surface (`#[wasm_bindgen]` exports of `zcode-score-wasm`). */
interface ScoreKernel {
  /** Build the scoring arena from the packed index; returns the row count. */
  init_index(packed: string, rootPath: string): number;
  /** Top-`limit` rows as packed `[row_index, score_lo, score_hi]` triples, best first. */
  top_k(query: string, limit: number): Uint32Array;
  /** Drop the arena, releasing linear memory. */
  release_index(): void;
}

interface SearchInput {
  /** Columnar packed index, byte-identical to what `zcode-scan` produced. */
  packed: string;
  /** Workspace root those entries were produced with; needed for the absolute-path surface. */
  rootPath: string;
  query: string;
  limit: number;
}

function resolveGluePath(): string {
  const fromEnv = process.env.ZCODE_SCORE_WASM_GLUE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`ZCODE_SCORE_WASM_GLUE points to a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  // packages/services/src/file/workspaceScoreNative.ts → packages/desktop/zcode-score-wasm/pkg/nodejs
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "../../../desktop/zcode-score-wasm/pkg/nodejs/zcode_score.js");
  if (!existsSync(candidate)) {
    throw new Error(
      `zcode-score wasm glue not found at ${candidate}. Build it with: node packages/desktop/scripts/prepare-zcode-score-wasm.mjs (or set ZCODE_SCORE_WASM_GLUE).`,
    );
  }
  return candidate;
}

let kernel: ScoreKernel | null = null;

/** Load (once, cached) the WASM scoring kernel. Throws clearly if it is missing — no fallback. */
function loadKernel(): ScoreKernel {
  if (!kernel) {
    const req = createRequire(import.meta.url);
    kernel = req(resolveGluePath()) as ScoreKernel;
  }
  return kernel;
}

/**
 * Which packed index the arena currently holds.
 *
 * The arena lives in WASM linear memory and is addressed by row index alone, so the facade owns the
 * binding between "these row indices" and "this packed string". Without it a stale arena would
 * silently answer a fresh index's query with the previous workspace's rows.
 *
 * `packed` is compared by identity: the service hands back the same string instance from its cache,
 * so this is a pointer compare, not a 25MB content scan.
 */
let staged: {
  packed: string;
  rootPath: string;
  lineStarts: Uint32Array;
  firstFileRow: number;
} | null = null;

/**
 * Byte offset of every entry row in `packed`, plus where the file rows begin.
 *
 * A row is a line with a TAB in it, which is the same rule `unpackWorkspaceFileEntries` and the
 * kernel's `init_index` apply — the three agree on what a row is, so row `i` means the same thing
 * on all three sides. Built with `indexOf` over the whole string rather than per-line slicing: at
 * 193k rows the difference is 193k throwaway substrings.
 *
 * `firstFileRow` exists because the empty-query answer is NOT the packed order. `zcode-scan` packs
 * directories before files (`compare_rows`), while the historical default sort
 * (`getDefaultWorkspaceFileSearchPriority`) ranks `file = 0` BELOW `directory = 1` and therefore
 * lists files first. Both orderings are stable, so the answer is the packed index rotated by one
 * block boundary rather than a sort: find the boundary once, then emit `[files..., dirs...]`.
 */
function buildLineStarts(packed: string): { lineStarts: Uint32Array; firstFileRow: number } {
  const starts: number[] = [];
  let firstFileRow = -1;
  let cursor = 0;
  while (cursor < packed.length) {
    const newline = packed.indexOf("\n", cursor);
    const end = newline < 0 ? packed.length : newline;
    const tab = packed.indexOf("\t", cursor);
    if (tab !== -1 && tab < end) {
      // Mirror `init_index`: the row is a directory only when its type column is exactly
      // "directory", anything else is a file.
      const isDirectory = tab - cursor === 9 && packed.startsWith("directory", cursor);
      if (!isDirectory && firstFileRow === -1) {
        firstFileRow = starts.length;
      }
      starts.push(cursor);
    }
    cursor = end + 1;
  }
  return { lineStarts: Uint32Array.from(starts), firstFileRow };
}

/** Re-index only when the packed string or the root changed. */
function ensureArena(packed: string, rootPath: string) {
  if (staged !== null && staged.packed === packed && staged.rootPath === rootPath) {
    return staged;
  }
  const rows = loadKernel().init_index(packed, rootPath);
  const { lineStarts, firstFileRow } = buildLineStarts(packed);
  if (lineStarts.length !== rows) {
    throw new Error(
      `zcode-score row count disagrees with the packed index: kernel=${rows} codec=${lineStarts.length}`,
    );
  }
  staged = { packed, rootPath, lineStarts, firstFileRow };
  return staged;
}

/** Decode one row through the shared codec, so the entry shape has a single implementation. */
function decodeRow(packed: string, rootPath: string, row: number, lineStarts: Uint32Array) {
  const start = lineStarts[row];
  if (start === undefined) return null;
  const nextStart = lineStarts[row + 1];
  const end = nextStart === undefined ? packed.length : nextStart - 1;
  return unpackWorkspaceFileEntries(packed.slice(start, end), rootPath)[0] ?? null;
}

/**
 * Top-`limit` workspace entries for `query`, scored in WASM.
 *
 * Behavior is identical to the JS `searchHostFileCandidates` it replaces:
 * - a non-empty query returns the same entries in the same order (`spec` §4 S2/S3);
 * - an **empty query** returns the historical default order — files first, then directories, each
 *   group in packed order — trimmed to `limit`. See `buildLineStarts` for why that is a block
 *   rotation rather than the packed order.
 *
 * Synchronous by design: the per-keystroke work is one WASM call plus at most `limit` decodes. The
 * old path yielded to the event loop every 2048 candidates because it was walking 193k JS objects;
 * there is nothing left to yield for.
 */
export function searchWorkspaceFilesByScore(input: SearchInput): WorkspaceFileEntry[] {
  const limit = Math.min(Math.max(0, Math.trunc(input.limit)), Number.MAX_SAFE_INTEGER);
  if (limit === 0) return [];
  const { lineStarts, firstFileRow } = ensureArena(input.packed, input.rootPath);
  const rowCount = lineStarts.length;

  // An empty (or whitespace-only) query has no scoring to do: the answer is the head of the index
  // in default order.
  if (input.query.trim().length === 0) {
    const boundary = firstFileRow < 0 ? rowCount : firstFileRow;
    const head: WorkspaceFileEntry[] = [];
    for (let at = 0; at < rowCount && head.length < limit; at += 1) {
      // Rotate the two blocks: files (packed rows from `boundary`) then directories.
      const row = at < rowCount - boundary ? at + boundary : at - (rowCount - boundary);
      const entry = decodeRow(input.packed, input.rootPath, row, lineStarts);
      if (entry !== null) head.push(entry);
    }
    return head;
  }

  const hits = loadKernel().top_k(input.query, limit);
  const entries: WorkspaceFileEntry[] = [];
  // `hits` is `[row, score_lo, score_hi]` triples; the scores are not part of the answer the
  // renderer consumes, so only the rows are read back.
  for (let at = 0; at + 2 < hits.length; at += 3) {
    const entry = decodeRow(input.packed, input.rootPath, hits[at] ?? 0, lineStarts);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** Drop the arena and the row table. Exposed for tests and for workspace teardown. */
export function releaseWorkspaceScoreIndex(): void {
  if (kernel !== null) kernel.release_index();
  staged = null;
}
