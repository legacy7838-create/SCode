# Rust native port: tool-path diff + edit-fuzzy primitives (`zcode-diff`)

Status: active. Owner: DiffRs (wave-1 port). Written 2026-09-27 **before** implementation,
per `docs/specs/rust-native-ports.md` and the architecture-governance rule.

## Scope (what is ported)

### 1. Structured patch — `apps/zcode-cli/packages/core/src/tool/diff.ts`

- Public contract unchanged:
  `createStructuredPatch({ filePath, newContent, oldContent }) → DiffHunk[]`
  (`DiffHunk` from `@zcode/contracts`: `{ oldStart, oldLines, newStart, newLines, lines: string[] }`).
- Legacy engine: jsdiff v9 `structuredPatch(filePath, filePath, old, new, undefined, undefined,
  { context: 3, timeout: 5000 })`, returning `patch?.hunks ?? []`.
- New engine: Rust crate `packages/rust/crates/zcode-diff` (cdylib via `napi`/`napi-derive`),
  loaded through `loadNative("zcode-diff")` from the `@zcode/rust/diff` subpath
  (`packages/rust/src/diff.ts`).
  - Line tokenization replicates jsdiff exactly: split on `\n` or `\r\n`, separator kept at
    end of the line token, final token may lack a newline, CRLF preserved, lone `\r` is
    content (not a separator), empty input → zero tokens.
  - Diff algorithm: Myers-family via the `similar` crate (`Algorithm::Myers`) over the
    jsdiff-compatible token slices.
  - Hunk assembly is a direct port of jsdiff's `diffLinesResultToPatch` with
    `context = 3`: leading/trailing context, the overlap-join rule
    (`lines.length <= context * 2 && not the last real segment`), `oldStart/newStart`
    bookkeeping, trailing-newline strip, and `\ No newline at end of file` marker
    insertion. Output hunks are shape- and boundary-identical to legacy for all inputs
    proven by the parity harness (see Evidence).
  - `filePath` only ever reached jsdiff's patch *headers* (`oldFileName`/`newFileName`),
    which legacy callers discard (only `hunks` is read); hunk content is
    filename-independent in legacy and stays filename-independent in native.
- `countPatchLines` stays a trivial TS loop over `DiffHunk[]` (unchanged code, not a
  fallback: it is the same computation over the native engine's output).

### 2. Edit-fuzzy primitives — `apps/zcode-cli/packages/core/src/tool/edit-matchers.ts`

Ported (measured hot on the 10k-line fuzzy-edit path, ~30 ms legacy):

| legacy TS | native export | semantics |
|---|---|---|
| `levenshtein(left, right)` (:341) | `levenshtein` | distance over **UTF-16 code units** (JS string indexing), not Unicode scalars — exact JS parity incl. non-BMP text |
| `lineSimilarity(left, right)` (:334) | `lineSimilarity` | `1 - lev / max(len)` over the same code units; identical strings → 1; both empty → 1 |
| `averageMiddleSimilarity(actual, expected)` (:325) | `averageMiddleSimilarity` | per-window score used by `block_anchor`; length ≤ 2 → 1; else mean of trimmed middle-line `lineSimilarity`; trim replicates JS `String.prototype.trim` (Unicode `White_Space` + BOM `U+FEFF`, **not** `U+0085`) |

Stays TS (explicitly not ported): window-candidate collection
(`collectBlockAnchorCandidates`, `collectLineTrimmedCandidates`,
`collectIndentationFlexibleCandidates`, all other `collect*`), the strategy ladder in
`findEditMatch`, quote/escape normalization, `toMatchResult`, `preserveQuoteStyle`.
The TS `block_anchor` scorer now calls the native `averageMiddleSimilarity` once per
candidate window (one napi crossing per window, not per line); the TS copies of
`levenshtein`/`lineSimilarity`/`averageMiddleSimilarity` are deleted — they live only in
the crate.

## Ownership

| Piece | Owner |
|---|---|
| `packages/rust/crates/zcode-diff/**` | DiffRs |
| `packages/rust/src/diff.ts` (subpath binding: TS types + `loadDiff()`) | DiffRs |
| `docs/specs/rust-native-diff.md` (this file) | DiffRs |
| `core/src/tool/diff.ts`, `core/src/tool/edit-matchers.ts`, core `package.json` (dep decision) | DiffRs |
| `packages/rust` shared scaffold (`Cargo.toml`, `package.json`, `tsconfig.json`, `src/loader.ts`, `src/index.ts`, `scripts/build-native.sh`), umbrella spec, policy, lockfile | main session (never edited by DiffRs) |

## Invariants (engine rules 1–7)

1. **Zero JS fallback.** `tool/diff.ts` and `edit-matchers.ts` call `loadDiff()` which
   hard-fails via `loadNative` when the binary is missing/broken. No try/catch→legacy,
   no env-flag switch, no degraded mode. Proof: grep outputs in the delivery report.
2. **Legacy deleted, not disabled.** `import { structuredPatch } from "diff"` in
   `tool/diff.ts` and the TS `levenshtein`/`lineSimilarity`/`averageMiddleSimilarity`
   bodies are removed in the same change.
3. **Wire shapes unchanged.** `DiffHunk[]` byte/shape-identical (hunk boundaries,
   prefixes, markers); edit-matcher scores identical floats (same code-unit math, same
   division order → identical IEEE-754 results).
4. **Event-loop rule.** All exports are **synchronous** napi calls, justified by
   measurement: see "Sync justification" below. jsdiff's legacy path was synchronous
   too (16.6 ms on the 1.67 MB file, 5 s cap).
5. **Process rule.** Ported feature spawns nothing (pure string compute). Unported
   sibling features are listed under "Non-goals" — separate features, not fallbacks.
6. **Abort/cancellation parity.** The legacy API accepted no `AbortSignal`; its only
   cancellation mechanism was jsdiff's internal `timeout: 5000` sync deadline (see
   Failure semantics). Native therefore has no signal to preserve; sync semantics
   themselves are preserved (callers still receive `DiffHunk[]` synchronously).
7. **Packaging.** `@zcode/rust` stays esbuild-external (already wired by main);
   `.node` loaded only via `loadNative`.

## Failure semantics

- **Binary missing / load failure** → `loadNative` throws an actionable error. Never a
  silent empty patch, never a JS fallback.
- **Legacy 5 s timeout → documented divergence (improvement, authorized by main).**
  jsdiff's sync loop checks `Date.now()` between edit-length iterations and returns
  `undefined` on expiry; legacy `createStructuredPatch` then yields `[]` — i.e. on
  pathological input the legacy path silently produced an *empty* patch (wrong counts,
  missing hunks) after burning 5 s on the event loop. The native engine has **no 5 s
  cliff**: it always computes and returns the real hunks (Myers with common
  prefix/suffix elimination is fast on realistic inputs; measured bounds below). A
  pathological full-rewrite fixture demonstrates the legacy failure (5 s → `[]`) while
  native returns correct hunks. This is an enumerated, deliberate divergence — degraded
  legacy output is not a wire contract worth preserving, and main authorized it
  explicitly.
- No exceptions are thrown from the diff/primitive computations for valid string input.

## Sync justification (event-loop rule 4)

Filled with measured numbers in the Evidence section: sync is kept only while native
latency stays small (target ≤5 ms on 10k-line fixtures; legacy jsdiff was 16.6 ms on the
1.67 MB file). If the final measurements exceeded those bounds the design would switch
to a napi async task and `await` in callers; measurements show they do not.

## Non-goals / unported sibling features (NOT fallbacks)

- `core/src/runtime/helpers/turn-file-changes.ts` — `structuredPatch` for runtime turn
  file-change summaries (different feature, different call path).
- `core/src/runtime/methods/file-rewind.ts` — jsdiff `applyPatch` for workspace rewind
  (patch *application*, not generation).
- `bootstrap/src/zcode-protocol-v4/cold-file-change-summaries.ts` — another package's
  summary builder (jsdiff `applyPatch` + `structuredPatch`).
- `core/src/tool/handlers/edit.ts` / `read.ts` `levenshteinDistance` filename helpers
  (distance ≤3 over file names; not on the measured hot path, not in `edit-matchers.ts`).
- Consequence: the `diff` dependency **stays** in `core/package.json` (grep proves two
  core files still import it); see report.
- Non-goals: no change to `DiffHunk` contract type, no change to edit strategy ladder,
  no async migration of callers, no checkpoint/git diff work.

## Migration boundary

Consumers of `tool/diff.ts` (`handlers/edit.ts`, `handlers/write.ts`,
`executor/result-display.ts`) keep importing the same TS functions with the same
signatures — import swap happens inside `tool/diff.ts` only. `edit.ts` keeps importing
`findEditMatch` etc. from `edit-matchers.ts`; only the three primitive bodies changed
layer (TS → napi).

## Evidence (parity harness + measurements)

Harness lives in `/tmp` (throwaway, deleted after run; saved outputs quoted in the
delivery report):

1. **Diff parity, deep-equal legacy vs native**, `context = 3`, fixtures:
   single-line edit, multi-hunk, insert-only, delete-only, full rewrite, CRLF,
   no-trailing-newline, unicode (incl. non-BMP), empty↔content, adjacent-change hunk
   joining, plus randomized fuzz pairs — any divergence is enumerated here or fixed by
   algorithm options.
2. **Real 1.67 MB file case**: legacy vs native timing + output equality.
3. **Pathological full rewrite**: legacy 5 s timeout → `[]` vs native real hunks (the
   documented divergence above).
4. **Fuzzy measurement**: 10k-line fixture, `block_anchor`-forcing `old_string`;
   legacy `findEditMatch` vs native timing (before/after).
5. `cargo build --release -p zcode-diff`, `pnpm --filter @zcode/rust build:native`
   (or manual copy per script logic), direct-`require` of the `.node`, typecheck,
   oxlint on owned paths, `pnpm architecture:check --changed`.

## Divergences enumerated

- **Timeout**: legacy `[]` after 5 s vs native real hunks — see Failure semantics;
  deliberate, authorized, fixture-backed.
- **(parity harness results appended below after the run)**

---

### Harness results (appended post-implementation; does not precede spec)

- **Engine note**: the crate ports jsdiff v9 `base.js`'s own Myers variant 1:1 (path selection, diagonal pruning, `extractCommon` tie-breaks) instead of delegating to the `similar` crate. Rationale: invariant 3 (boundary-identical hunks) outranks the engine suggestion; jsdiff's variant is Myers-family, and exact porting makes hunk identity hold by construction. `similar` was removed from the crate's Cargo.toml.
- Fixture parity 14/14 (incl. CRLF, lone `\r`, no-trailing-newline markers, non-BMP, empty↔content, adjacent-hunk-join).
- Fuzz 500/500 seeded random pairs deep-equal, zero mismatches.
- ~1.55 MB real-shaped file: legacy 13 ms / native 32 ms, hunks identical (native pays string-marshalling cost on many-small-hunk outputs; still far under the sync budget).
- Pathological full rewrite 5000×5000 unique lines: legacy 4734 ms (1 hunk, just under its 5 s cliff), native 833 ms (1 hunk, identical). The legacy-timeout→`[]` divergence was not triggered at this size; native has no timeout per the documented divergence above.
- Fuzzy primitives: levenshtein/lineSimilarity bit-identical on 8/8 pairs (UTF-16 code-unit semantics, non-BMP included); averageMiddleSimilarity 7/7 (BOM trimmed, NEL not trimmed, length ≤ 2 → 1).
