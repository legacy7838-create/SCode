# Native Boundary Specification: `zcode-scan` Workspace File Index

## Overview

`packages/services/src/file/fileService.ts` builds the workspace file index that powers the `@`
mention picker, Command Center search, and the file tree. It walks the whole workspace in
JavaScript, applies `.zcodeignore` through the `ignore` npm package, packs the result into the
columnar format, and sorts it with `String.prototype.localeCompare`.

This spec moves that walk to Rust (`ignore` crate + parallel walker). It authorizes **no JavaScript
fallback**: the addon is the only implementation, mirroring `zcode-db`'s "no JS fallback" rule.

### Measured starting state (verified against the checkout)

| Property                      | Value                                                  | Evidence                                                                                                                                |
| ----------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Serial single-thread DFS      | **21.8 s** on a 370k-file Windows workspace            | `fileService.ts:293-294` (team's own comment)                                                                                           |
| Current concurrency           | 8 JS async workers over a shared `string[]` stack      | `WORKSPACE_FILE_LIST_SCAN_CONCURRENCY = 8`, `fileService.ts:210`                                                                        |
| `await` per directory entry   | **one per entry**, ~370k microtask turns               | `fileService.ts:317` — `resolveReaddirEntryType` returns synchronously for non-symlinks (`fileService.ts:181-186`) yet is still awaited |
| Gitignore matcher             | `ignore` npm (JS)                                      | `workspaceFileIgnore.ts:2`                                                                                                              |
| Sort                          | `localeCompare` over `relativePath`, directories first | `fileService.ts:343-348`                                                                                                                |
| Custom filter injection point | **dead** — zero callers, zero tests                    | `rg 'workspaceFileSearchFilter\s*:'` matches only the `node.ts:547` declaration and the `fileService.ts` pass-through                   |
| Tests for this path           | **zero**                                               | `fd -e ts packages/services/src/file` → no `.test.ts`                                                                                   |

### The collation constraint (measured, not assumed)

`localeCompare` is **ICU collation**, not byte order. Measured on this checkout's 6,338 real paths:

```
byte-order vs localeCompare: 96.54% of positions differ
  byte    → "CONTEXT.md", "DESIGN.md", ...   (uppercase first)
  locale  → "all_files.txt", "apps/..."      (case-insensitive primary)
```

A naive `Vec<String>::sort()` in Rust would therefore **completely reorder the `@` picker**. This is
the single highest-risk item in the port and it was settled by experiment before writing this spec:

`icu_collator` 2.3.1 with `Strength::Tertiary` + default preferences reproduces Node's
`localeCompare` **byte-identically**:

| Locale       | Result    |
| ------------ | --------- |
| `und` (root) | identical |
| `en`         | identical |
| `de`         | identical |
| `ja`         | identical |

Node's bare `localeCompare()` uses the **runtime default locale**, which is machine-dependent
(`Intl.Collator().resolvedOptions().locale` returned `en-US` here). Hard-coding a locale in Rust
would silently diverge on a German-locale machine, so **the resolved locale is plumbed from JS into
the addon** and both sides collate with the same locale by construction.

---

## 1. Product rules

1.1 The addon is the **only** workspace-scan implementation. There is no JS walk, no `ignore` npm
matcher on this path, and no degraded mode. A missing addon is a load error, not a silent slowdown
(same rule as `native-addon.ts`: "There is deliberately NO Node built-in SQLite fallback").

1.2 **Ordering is a contract.** The packed index byte string must be identical to today's. The addon
receives the collator locale from JS; it never guesses the host locale.

1.3 `.zcodeignore` remains the single source of truth for directory exclusion
(`workspaceFileIgnore.ts:1-19`). The addon receives the **already-loaded rule text**; it never reads
or creates `.zcodeignore`. Creation, gitignore sync, and the settings-page transforms stay in TS.

1.4 The file-level policy (`.env*`, binary extension blacklist, hidden-directory semantics) moves to
Rust verbatim, including the `ignoreRulesActive` fail-open behavior described in
`workspaceFileMentionFilter.ts:76-81`.

1.5 The dead `WorkspaceFileSearchFilter` injection point is **removed**, not ported. No caller and no
test uses it; keeping it would mean either a per-entry callback into JS (destroying the win) or two
filter implementations that can drift.

1.6 The 60 s TTL cache, `.zcodeignore` fingerprint signature, in-flight de-duplication, and LRU
eviction **stay in TS** (`fileService.ts:205-232`, `348-367`). They are host-lifetime concerns, not
scan concerns. Rust owns exactly one thing: `rootPath + ruleText + locale → packed string`.

1.7 No `unwrap()` in library paths; every exported symbol documented; errors surfaced as structured
`Error` values, never swallowed (Part 1 Rust rules).

## 2. State ownership

- **`zcode_scan.node` owns the filesystem walk.** Single call, no retained state, no cache. Input:
  `rootPath`, `ignoreRuleText`, `locale`, `hiddenDirDepth` policy. Output: the packed string.
- **TS `ensureWorkspaceFileIndex` remains the cache owner** (`fileService.ts:268`). It decides
  _whether_ to scan; Rust decides _what the scan returns_.
- **No second copy of the index exists.** `WorkspaceFileIndex.packed` is the single representation
  consumed by `listWorkspaceFilesLength` / `listWorkspaceFilesRange` / `buildHostFileSearchCandidates`.

```
ensureWorkspaceFileIndex (TS, cache owner)
  ├─ TTL + .zcodeignore fingerprint + in-flight dedupe  ── TS only
  ├─ loadWorkspaceFileSearchIgnoreRules (TS) ─────────── rule TEXT
  └─ scanWorkspaceFilesNative(rootPath, ruleText, locale) ── RUST: walk+filter+sort+pack
        └─ packed string ────────────────────────────── back across the boundary
```

## 3. Interface

```rust
/// Scan `root_path` and return the columnar packed workspace file index.
///
/// `ignore_rule_text` is the verbatim `.zcodeignore` content (already loaded by the caller);
/// an empty string means "no rules", which is the fail-open state.
/// `locale` must be the caller's resolved `Intl.Collator().resolvedOptions().locale` so that
/// ordering matches JavaScript's `String.prototype.localeCompare` exactly.
#[napi]
pub fn scan_workspace_files_packed(
    root_path: String,
    ignore_rule_text: String,
    locale: String,
) -> Result<String>
```

TS facade — `packages/services/src/file/workspaceScanNative.ts`:

```ts
/** Throws if the addon is missing; there is no JS fallback. */
export function scanWorkspaceFilesPacked(input: {
  rootPath: string;
  ignoreRuleText: string;
  locale: string;
}): string;
```

Loader resolution mirrors `zcodeDb.ts` / `native-addon.ts`:

1. `process.env.ZCODE_SCAN_NATIVE` (absolute path, packaged host),
2. otherwise `zcode_scan.node` staged next to the crate in dev.

## 4. Acceptance scenarios

- **A1 — ordering parity.** For a real workspace, the Rust packed string is **byte-identical** to the
  output of the current JS implementation (same sort, same packer, same columnar format). Asserted by
  a parity harness, not by a unit test.
- **A2 — collation parity across locales.** For locale ∈ {`und`, `en`, `de`, `ja`}, Rust's order
  equals Node's `localeCompare` order on a path corpus containing case, digits, `-`, `_`, `.`, and
  non-ASCII segments. This is the regression guard for the 96.54% divergence in §Overview.
- **A3 — gitignore parity.** A fixture tree exercises: trailing `/` (dir-only), `!` negation,
  anchored `/x`, basename `x`, `**/x`, `**` cross-level, character class, escaped `\ `, and
  "excluded parent cannot re-include child". Rust's include/exclude decision matches the `ignore` npm
  package for every path.
- **A4 — file policy parity.** `.env`, `.env.local`, `coverage.out`, `lcov.info`, and each binary
  extension in `SKIPPED_FILE_EXTENSIONS` are excluded; hidden _directories_ prune the candidate list
  but keep traversing, so files under `.github/` remain searchable.
- **A5 — no fallback exists.** Grep gate: `fileService.ts` contains no `readdir`, no `walkFiles`, and
  no `ignore`-npm match on the scan path. Deleting the `.node` makes the service throw at load, which
  a test asserts.
- **A6 — speedup is measured.** Before/after wall-clock on the same real workspace, reported as a
  table. The win is only claimed with numbers.

## 5. Removed in this change

| Removed                                                     | Why it is safe                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| JS `walkFiles`-equivalent inside `ensureWorkspaceFileIndex` | replaced by the addon; A1/A5 gate it                                              |
| `resolveReaddirEntryType` on the scan path                  | kept for `readdir()` (`:385`), which is not part of this port                     |
| `workspaceFileSearchFilter` injection option                | dead: zero callers, zero tests (§Overview)                                        |
| `ignore` npm matcher **on this path only**                  | still used by `workspaceFileIgnore.ts` for rule _validation_; untouched elsewhere |

## 6. Retained fallbacks (explicitly NOT removed)

| Fallback                                           | Location                              | Why retained                                                                                  |
| -------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `.zcodeignore` creation from `.gitignore`/template | `workspaceFileIgnore.ts`              | user-facing file authoring, not a scan concern                                                |
| `ignoreRulesActive: false` fail-open               | `workspaceFileMentionFilter.ts:76-81` | when the rules file is unreadable the directory blacklist applies; behavior preserved in Rust |
| win32 shell `find`/`grep` prelude                  | `embedded-search-prelude.ts:179`      | unrelated to this path                                                                        |
| TS 60 s TTL cache                                  | `fileService.ts:205-232`              | §1.6                                                                                          |

## 7. Deferred

- ~~**Host-side fuzzy scoring**~~ — **DONE**, in `native-boundary-fuzzy-score.md`. The Host now
  scores in WASM and this crate's packed index is its input; `localeCompare` is gone because the
  third comparator level was measured dead (§1.2 of that spec). This spec's §3 "pack order is a
  contract" note now also carries a second consumer: the scoring kernel relies on the same
  directories-first ordering to serve empty queries without sorting.
- **Renderer-side scoring** (`workspaceFileSearchFilter.worker.ts`) cannot use a napi addon at all —
  it needs WASM. Separate decision, recorded so the two are not confused.

## 8. Governance note

`packages/desktop/zcode-scan` is outside every module root in `architecture-policy.yaml` (`desktop`
covers only `packages/desktop/src`), exactly like `zcode-db` and `zcode-pty`, so
`pnpm architecture:check` cannot guard this boundary. This spec plus the A1–A6 scenarios are the
control.

## 9. Rollback

One revertable commit per slice (crate → facade → call-site swap). The TS scan is deleted only in the
final commit, so every intermediate state builds and runs.
