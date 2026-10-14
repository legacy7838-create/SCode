# Native Boundary Specification: `zcode-score-wasm` Fuzzy Scoring Kernel

## Overview

`packages/shared/src/workspaceFileSearch.ts` scores workspace file candidates for the `@` mention
picker. It is the measured hot path: after `zcode-scan` removed the walk, **scoring is what is left**.

The measured starting state, on this checkout with the product's own default ignore rules
(**193,667 rows / 20.2 MB packed**; a real monorepo with dependencies unignored is larger):

| cost                                                                       | measured                                                                                  | owner today     |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------- |
| `unpackWorkspaceFileEntries` + `mapWorkspaceFileEntriesToSearchCandidates` | 248 ms, once per index, then cached in `WorkspaceFileIndex.candidates` as 193k JS objects | JS, Host thread |
| scoring, per keystroke                                                     | 89 ms (`searchHostFileCandidates`)                                                        | JS              |
| the same scoring without its batching                                      | 62 ms — the floor JavaScript could reach                                                  | JS              |

This slice moves **scoring and top-K** into Rust compiled to WebAssembly. It does **not** change
what the user sees: the top-K list, its order, and the returned `WorkspaceFileEntry[]` are
byte-identical to the JavaScript implementation. That equivalence is the whole product rule
(§1.1) and it is asserted by a differential harness (§4), never by a hand-written expectation.

**Measured result** (`harness/bench.mts`, median of 5, same corpus/queries/limit):

| stage                                   | JS shipped |   WASM |   speedup |
| --------------------------------------- | ---------: | -----: | --------: |
| build searchable index (once per index) |     248 ms |   9 ms |   **29x** |
| score + top-K (10 keystrokes)           |     891 ms | 770 ms | **1.16x** |

Both numbers are reported, including the unflattering one: against the _unbatched_ JavaScript
scorer (62 ms/keystroke) the kernel is **0.81x** — slower. It wins against the code that actually
shipped, whose 2048-row re-scoring loop cost it 89 ms, and it wins decisively on the index build
and on resident memory (193k JS objects are no longer materialized at all). Quoting only the
shipped number would overstate the win, so the benchmark prints both. Closing the remaining gap
needs a SIMD `memchr` (`simd128`), which is explicitly NOT done here — see §7.

### Why WASM and not a napi addon

The renderer scores in a Web Worker (`packages/ui/src/workspace-file-search/`), where a Node-API
addon cannot be loaded at all. A WASM module is the only artifact both the Node Host and a browser
worker can execute, so one kernel serves both and the two implementations cannot drift.

`zcode-scan`/`zcode-db` are napi because they are Host-only and need synchronous FS/SQLite.
Scoring needs neither, and needs to run in two runtimes.

## 1. Product rules

### 1.1 Exact equivalence, not "close enough"

For every query and every candidate index, the kernel's score equals
`getWorkspaceFileSearchCandidateScore`, and the returned top-K **sequence** (index and order) equals
`filterWorkspaceFileSearchCandidates`. A faster wrong answer is a regression: the `@` picker
re-ordering itself between builds is a visible bug.

Consequences that are load-bearing, not incidental:

- **Four score terms, not two.** The JavaScript original scores four surfaces:

  ```text
  keywordScore = min(relativePathScore + 300, pathScore + 300)
  bestScore    = min(nameScore, relativePathScore + 25, keywordScore)
  ```

  An earlier revision of the kernel implemented only `name` and `relativePath + 25`, silently
  dropping the `+300` keyword tier — the branch that makes a query spanning directory segments score
  at all. The differential harness catches this as a wrong top-100 for most queries.

- **Four surfaces, not two.** The absolute `path` surface is scored too. It is not reconstructible
  from `relativePath` alone, so `init_index` takes the workspace root and rebuilds it per candidate
  into a reusable scratch buffer rather than storing a third copy of every candidate.

### 1.2 The ICU tie-break is dead and stays dead

The JavaScript comparator's third level (`name.localeCompare`) executes **0** times: `index` comes
from a single `entries()` traversal and is therefore unique within one pass, so reaching level three
requires equal score **and** equal index. Measured on 370k candidates × 3 queries.

The kernel therefore orders by `(score, index)` — a plain integer total order — and needs no locale,
no collator, and no `wasm32` ICU payload. This is a deliberate non-port of dead code; see
`packages/shared/src/workspaceFileSearch.ts:compareScoredWorkspaceFileSearchCandidates` for the
JS-side note that says the same thing.

### 1.3 Lowercasing and trimming are the kernel's job

The JavaScript candidate precomputes `lowercaseName`, `lowercaseRelativePath` and `lowercasePath`
precisely so the scoring loop never lowercases per keystroke. The kernel stores every row
**lowercased and trimmed** at `init_index` time, once per workspace index.

Both operations must be Unicode-exact or the kernel silently reorders non-ASCII paths (§1.4).

### 1.4 The normalization traps (each one was a real divergence)

Every row below is a bug the differential harness actually caught, not a hypothetical. A kernel
that gets any of them wrong silently reorders the @ picker.

| trap                    | JavaScript                                         | the wrong answer                                                               | what the kernel does                                                                                       |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **UTF-16 offsets**      | `indexOf`/`length` are UTF-16 code-unit quantities | byte offsets: `文件.txt` vs `x` scores `108`, JS says `104`                    | arena is UTF-8 **bytes** (cheap to scan); a non-ASCII row projects each matched offset through `utf16_len` |
| **case folding**        | `toLowerCase` (full Unicode)                       | ASCII `+32` leaves `CAFÉ.txt` unfolded                                         | `str::to_lowercase` per row, at index time                                                                 |
| **`U+0085` NEL**        | **not** trimmed by `trim()`                        | Rust's `char::is_whitespace` trims it                                          | excluded explicitly                                                                                        |
| **`U+FEFF` ZWNBSP**     | trimmed by `trim()`                                | not whitespace in Rust                                                         | included explicitly                                                                                        |
| **subsequence step**    | `searchStart = foundIndex + 1` (one code unit)     | one **byte**, landing inside a multi-byte char: `中文件` scored `237` vs `233` | step the matched character's UTF-8 width                                                                   |
| **path separator**      | `\` when the root contains one, else `/`           | always `/`                                                                     | derived from `root_path`, and the relative path is rewritten to match                                      |
| **all-whitespace name** | name trims to `""`, which never scores             | a bogus non-empty name                                                         | name offset clamps to the row end, giving an empty slice — no sentinel                                     |
| **empty query order**   | files first, then directories                      | packed order                                                                   | see §1.7                                                                                                   |

`U+0085`/`U+FEFF` are the reason trimming is not `str::trim`: JS trims
`WhiteSpace ∪ LineTerminator`; Rust's `char::is_whitespace` is the Unicode `White_Space` property,
which differs in **both** directions. `js_trim_bounds` in `src/lib.rs` implements the exact JS set.

The one divergence that is **not** fixable: the original can match starting _inside_ a surrogate
pair (its `searchStart = foundIndex + 1` lands between the two units of an astral character), and
UTF-8 has no interior character position, so that position does not exist in the kernel. It is
reachable only by a query containing an astral character.

### 1.7 The empty query is NOT the packed order

`zcode-scan` packs **directories before files** (`compare_rows` in its `src/lib.rs`), but the
historical default sort ranks `file = 0` **below** `directory = 1` and therefore lists **files
first**. The two orderings disagree, and the empty-query answer is the second one.

Both are stable, so the facade does not sort: it finds the file/directory block boundary once while
building its row table and emits `[files…, dirs…]` by rotating the index. Getting this wrong is
invisible for every non-empty query, which is why it is its own acceptance scenario (S4).

### 1.5 No JavaScript fallback on the Host path

`workspaceScoreNative.ts` throws when the artifact is missing, exactly like
`workspaceScanNative.ts`. A silent fallback would mean "the picker got 10× slower" with no signal,
which is the failure mode this whole native-boundary effort exists to remove (§1.1 of
`native-boundary-workspace-scan.md`).

### 1.6 The renderer worker is **not** in this slice

`packages/ui/src/workspace-file-search/workspaceFileSearchFilter.worker.ts` keeps its JavaScript
scoring. Wiring the kernel into a Vite-built module worker needs `?url`/`instantiateStreaming`
plumbing plus a feature-detect fallback, and the UI module must not grow a WASM-loading concern in
the same commit that changes the Host's hot path. The `web` artifact is staged and `--check`ed by
`prepare:zcode-score-wasm.mjs` so the slice that lands it has its build step already proven. See §7.

## 2. State ownership

```text
WorkspaceFileIndex (fileService, per workspaceKey, 60s TTL + .zcodeignore fingerprint)
  ├── packed: string                     ← owner: zcode-scan addon (Rust, single writer)
  ├── lineStarts: Uint32Array            ← owner: workspaceScoreNative (derived from packed)
  └── rootPath / signature               ← owner: fileService
             │
             ▼  init_index(packed, rootPath)   [once per index]
        WASM linear memory
          Arena { blob, offsets, name_offsets, is_dir, root_prefix, separator }
             │
             ▼  top_k(query, limit) -> Uint32Array [idx, score_lo, score_hi] × hits
        facade re-slices packed rows through unpackWorkspaceFileEntries
             │
             ▼
        WorkspaceFileEntry[]  (≤ limit)
```

**One owner.** The WASM arena is single-threaded module state (`wasm32-unknown-unknown` has no
threads) held in a `thread_local`. Exactly one `Arena` exists at a time, owned by the Host process.
`init_index` replaces it wholesale; `release_index` drops it. There is no second copy of the index
in JS — `WorkspaceFileIndex.candidates` (370k materialized candidate objects) is **removed** by this
slice, which is where most of the win comes from.

**No stale arena.** The arena is derived state, keyed by nothing: `init_index` is called whenever a
new `packed` is produced, before any `top_k` for that index. A `top_k` against a missing arena
returns an empty array rather than panicking, so a forgotten `init_index` degrades to "no hits"
instead of taking down the Host.

**Event order (Host, per keystroke).**

1. renderer → RPC `searchWorkspaceFiles({rootPath, workspaceIdentity, query, limit})`
2. `ensureWorkspaceFileIndex` → cached `packed`, or a fresh `zcode-scan` scan
3. arena missing **or** `packed` identity changed → `init_index(packed, rootPath)`
4. `top_k(query, limit)` → ≤ `limit` row indices
5. facade maps row indices → `WorkspaceFileEntry[]` through `unpackWorkspaceFileEntries`
6. RPC returns; result is dropped if the renderer already advanced `seq`

Steps 3–5 are synchronous. That is the point: the work that used to be a multi-second decode plus a
per-candidate JS scan becomes one `init_index` per index and a `top_k` per keystroke.

## 3. Interface

```rust
/// Build the scoring arena from the columnar packed index.
///
/// `packed` is exactly the string produced by `zcode-scan`'s `scan_workspace_files_packed`.
/// `root_path` is the workspace root those entries were produced with; it is needed to
/// rebuild the absolute-path scoring surface. The separator is derived from it the same way
/// `unpackWorkspaceFileEntries` derives it (`\` when the root contains one, else `/`).
///
/// Returns the number of candidate rows indexed.
#[wasm_bindgen]
pub fn init_index(packed: &str, root_path: &str) -> usize;

/// Drop the arena, releasing linear memory back to the WASM instance.
#[wasm_bindgen]
pub fn release_index();

/// Score every row against `query` and return the top `limit` rows.
///
/// `query` is normalized (trim + lowercase) once here, not per candidate.
/// The result is packed `[row_index, score_lo, score_hi]` triples, one per hit, ordered
/// best-first by `(score, index)`. Scores are `i64` in Rust and are split rather than
/// rounded so the caller reconstructs the exact integer.
#[wasm_bindgen]
pub fn top_k(query: &str, limit: usize) -> Vec<u32>;
```

TS facade — `packages/services/src/file/workspaceScoreNative.ts`:

```ts
/** Throws if the WASM artifact is missing; there is no JS fallback. */
export function ensureWorkspaceScoreIndex(packed: string, rootPath: string): void;
export function searchWorkspaceFilesByScore(input: {
  packed: string;
  rootPath: string;
  query: string;
  limit: number;
}): WorkspaceFileEntry[];
```

Loader resolution mirrors `workspaceScanNative.ts`:

1. `process.env.ZCODE_SCORE_WASM` (absolute path, packaged host),
2. otherwise `zcode_score.wasm` + `pkg/nodejs/zcode_score.js` staged next to the crate in dev.

## 4. Acceptance scenarios

- **S1 — score parity.** For every candidate and every query in the corpus, the kernel's score equals
  `getWorkspaceFileSearchCandidateScore`. Asserted by `harness/parity.mts` against the real
  JavaScript module, including the Unicode, trim and separator traps of §1.4.
- **S2 — top-K sequence parity.** For every query, the kernel's `(index, score)` sequence equals
  `filterWorkspaceFileSearchCandidates`' output sequence, element for element — not merely the same
  set, and not merely the same head.
- **S3 — entry parity.** The `WorkspaceFileEntry[]` the facade returns is deep-equal to what
  `searchHostFileCandidates` returned for the same `(packed, rootPath, query, limit)`, including
  `name`, `path`, `relativePath` and `type` for every row.
- **S4 — empty query.** An empty/whitespace query returns the first `limit` rows in the historical
  default order — **files first, then directories**, each group in packed order (§1.7).
- **S5 — no fallback.** With the artifact removed, `ensureWorkspaceScoreIndex` throws. With a bogus
  `ZCODE_SCORE_WASM`, it throws. Restoring the artifact recovers.
- **S6 — no dead candidate state.** `WorkspaceFileIndex.candidates` and
  `buildHostFileSearchCandidates` are gone; nothing materializes 370k candidate objects.
- **S7 — speedup is measured.** Before/after wall-clock on the same real workspace by
  `harness/bench.mts`, reported as a table, against BOTH the shipped JavaScript path and the
  unbatched JavaScript scorer. The kernel currently loses to the second one (0.81x); that is
  reported, not hidden.

## 5. Removed in this change

| Removed                                                       | Why it is safe                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `WorkspaceFileIndex.candidates`                               | 370k JS objects rebuilt per index; S3 proves the entries are unchanged        |
| `buildHostFileSearchCandidates`                               | its only caller was the candidate cache; the packed string is still owned     |
| the 2048-row batched re-scoring in `searchHostFileCandidates` | top-K over the whole index is one `top_k`; batching existed to yield the loop |

Retained: `filterWorkspaceFileSearchCandidates` / `getWorkspaceFileSearchCandidateScore` in
`@zcode/shared`. The UI worker and its sync fallback still call them (§1.6), and they are the
harness's oracle. Deleting them would remove the only executable statement of what the kernel must
match.

## 6. Retained fallbacks (explicitly NOT removed)

| Fallback                                     | Location                                 | Why retained                                    |
| -------------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| Renderer worker JS scoring                   | `packages/ui/src/workspace-file-search/` | §1.6                                            |
| `createSyncWorkspaceFileSearchFilterBackend` | `workspaceFileSearchFilterBackend.ts`    | test environments have no module worker runtime |
| `localeCompare` third comparator level       | `@zcode/shared/workspaceFileSearch.ts`   | §1.2 — dead, but not this slice's to delete     |

## 7. Deferred

- **Renderer worker wiring** (§1.6). The `web` artifact is built and `--check`ed so the slice that
  lands it starts from a proven build step.
- **`WorkspaceFileIndex.candidates` reuse.** The worker still needs a materialized candidate list;
  when it moves to WASM, both surfaces share one arena and the Host's row table becomes unnecessary.
- **SIMD `memchr` (`simd128`).** The remaining gap against unbatched JavaScript is constant-factor:
  the kernel scans ~130 bytes per candidate at roughly 240 MB/s, while V8 scans one-byte Latin-1
  strings with tuned SIMD routines. Measured scan cost dominates: a 7-character query that matches
  almost nothing costs 103 ms over 193k rows, while a 1-character query costs 8 ms. Closing it means
  a SIMD inner loop plus runtime feature detection, because the `web` artifact runs in browsers that
  may predate `simd128` — and the nodejs/web artifacts are built from one cargo invocation today, so
  they would have to be split. Explicitly not done here; the scalar loop stays correct and portable.
- **The `is_dir` array is unused.** It is retained because the empty-query ordering (§1.7) is the
  obvious next consumer and recomputing directory flags from the type column per query would be
  wasteful. If neither lands, delete it.

## 8. Governance note

`packages/desktop/zcode-score-wasm` is outside every module root in `architecture-policy.yaml`
(`desktop` covers only `packages/desktop/src`), exactly like `zcode-db`, `zcode-pty` and
`zcode-scan`, so `pnpm architecture:check` cannot guard this boundary. This spec plus the S1–S7
scenarios are the control, and `.github/workflows/zcode-workspace-file-native.yml` (manual
`workflow_dispatch`, and it gates the scan boundary too) runs S1–S5 through `harness/parity.mts` and
an S6 grep guard against the dead candidate symbols; S7 is the benchmark, measured by hand.

## 9. Rollback

One revertable commit per slice (crate → facade → call-site swap). The JS scorer is deleted only in
the final commit, so every intermediate state builds and runs.
